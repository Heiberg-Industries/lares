import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import {consoleSourceTransaction,gateConsoleOrganisation,noteBudgetFinancialChange,retainSourceTransactionDeadline,SourceTransactionDeadlineExpired,type BudgetFinancialChange,type SourceDatabase,type SourcePool,type SourceTransactionBoundary} from '@lares/agent-kit/console-source-transaction';
import {gatewayCanonical} from '@lares/agent-kit/gateway-admission-protocol';
import {KeeperRefusedError,registerAction} from './actions.js';
import {JournalBudgetFinancialWriter,collectFinancialAtoms} from './budget-financial-writer.js';
import {HostFinancialJournal,isJournaledAbort,type FinancialAtom} from './financial-journal.js';
import type {BudgetNativeCustodyStore} from './budget-native-custody.js';
import {recordCommittedNativeRetirement,type NativeCleanupStatus} from './budget-native-cleanup.js';

const token=z.string().regex(/^[A-Za-z0-9_-]{43}$/),memberId=z.string().min(1).max(128).refine(value=>!/[\u0000-\u001f\u007f]/.test(value));
export const memberRemovalInput=z.strictObject({sessionToken:token,targetMemberId:memberId});
export type MemberRemovalInput=z.infer<typeof memberRemovalInput>;
const refusal=()=>new KeeperRefusedError('Member removal was refused. Refresh membership and try again.');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const instant=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value);
const utc=(column:string)=>`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

type SessionDiscovery={member_id:string;expires_at:string};
type UserRow={id:string;org_id:string|null;org_role:string;status:string};
function projectRetirement(atoms:readonly FinancialAtom[],accountIds:ReadonlySet<string>,bindingIds:ReadonlySet<string>,attemptIds:ReadonlySet<string>):FinancialAtom[]{
  return atoms.map(atom=>{
    if(atom.kind==='account'&&accountIds.has(atom.id))return {...atom,state:'retired',reason:'member_removed',policyGeneration:(BigInt(atom.policyGeneration)+1n).toString()};
    if(atom.kind==='binding'&&bindingIds.has(atom.id))return {...atom,state:'revoked'};
    if(atom.kind==='attempt'&&attemptIds.has(atom.id))return {...atom,state:'retired'};
    return atom;
  });
}
function sameAtoms(a:readonly FinancialAtom[],b:readonly FinancialAtom[]):boolean{
  return Buffer.from(gatewayCanonical([...a])).equals(Buffer.from(gatewayCanonical([...b])));
}
async function queryRows<T>(db:SourceDatabase,sql:string,values?:any[]):Promise<T[]>{return (await db.query(sql,values)).rows as T[];}

async function removeOwned(db:SourceDatabase,journal:HostFinancialJournal,designatedOwnerId:string|undefined,input:MemberRemovalInput,operationId:string):Promise<{removed:true;accountIds:readonly string[]}>{
  if(!journal.prepared||!designatedOwnerId)throw refusal();
  const tokenHash=hash(input.sessionToken);
  // Read only to discover which organisation gate to acquire. All authority is locked and
  // rechecked after the gate; this snapshot never authorizes the operation.
  const discovered=(await queryRows<SessionDiscovery>(db,`SELECT s.member_id,${utc('s.expires_at')} AS expires_at
    FROM member_sessions s WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()`,[tokenHash]))[0];
  if(!discovered||!instant(discovered.expires_at))throw refusal();
  await gateConsoleOrganisation(db,discovered.member_id,undefined,{lock:'update'});
  const actor=(await queryRows<UserRow>(db,'SELECT id,org_id,org_role,status FROM users WHERE id=$1 FOR UPDATE',[discovered.member_id]))[0];
  if(!actor||actor.id!==designatedOwnerId||actor.status!=='active'||actor.org_role!=='owner'||!actor.org_id)throw refusal();
  const session=(await queryRows<SessionDiscovery>(db,`SELECT s.member_id,${utc('s.expires_at')} AS expires_at
    FROM member_sessions s WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR UPDATE`,[tokenHash]))[0];
  if(!session||session.member_id!==actor.id||!instant(session.expires_at))throw refusal();
  await retainSourceTransactionDeadline(db,session.expires_at);
  const target=(await queryRows<UserRow>(db,'SELECT id,org_id,org_role,status FROM users WHERE id=$1 FOR UPDATE',[input.targetMemberId]))[0];
  if(!target||target.id===actor.id||target.id===designatedOwnerId||target.org_id!==actor.org_id||target.status==='removed'||!['active','invited'].includes(target.status))throw refusal();

  // Match the SQL retirement trigger's lock order exactly: installation accounts, target
  // accounts, active bindings, then prepared attempts. LIMIT + sentinel refuses huge closures.
  const installations=await queryRows<{id:string}>(db,"SELECT id FROM budget_accounts WHERE kind='installation' ORDER BY id LIMIT 129 FOR UPDATE");
  if(installations.length>128||installations.some(row=>!uuid(row.id)))throw refusal();
  const accounts=await queryRows<{id:string}>(db,`SELECT id FROM budget_accounts WHERE live_member_id=$1 ORDER BY id LIMIT 129 FOR UPDATE`,[target.id]);
  if(accounts.length>128||accounts.some(row=>!uuid(row.id)))throw refusal();
  const bindings=await queryRows<{id:string}>(db,`SELECT id FROM budget_gateway_bindings WHERE live_member_id=$1 AND state='active' ORDER BY id LIMIT 129 FOR UPDATE`,[target.id]);
  if(bindings.length>128||bindings.some(row=>!uuid(row.id)))throw refusal();
  const attempts=await queryRows<{id:string}>(db,`SELECT id FROM budget_attempts WHERE live_member_id=$1 AND state='prepared' ORDER BY id LIMIT 129 FOR UPDATE`,[target.id]);
  if(attempts.length>128||attempts.some(row=>!uuid(row.id)))throw refusal();

  const accountIds=new Set(accounts.map(row=>row.id)),bindingIds=new Set(bindings.map(row=>row.id)),attemptIds=new Set(attempts.map(row=>row.id));
  const changes:BudgetFinancialChange[]=[];
  for(const id of accountIds)changes.push({table:'budget_accounts',id});
  for(const id of bindingIds)changes.push({table:'budget_gateway_bindings',id});
  for(const id of attemptIds)changes.push({table:'budget_attempts',id});
  const before=await collectFinancialAtoms(db,changes);
  const projected=projectRetirement(before,accountIds,bindingIds,attemptIds);
  journal.validateProposal(operationId,projected);
  for(const change of changes)noteBudgetFinancialChange(db,change.table,change.id);

  const removed=await db.query("UPDATE users SET status='removed' WHERE id=$1 AND status IN ('active','invited') RETURNING id",[target.id]);
  if(removed.rows.length!==1)throw refusal();
  const actual=await collectFinancialAtoms(db,changes);
  if(!sameAtoms(projected,actual))throw refusal();
  journal.validateProposal(operationId,actual);
  return {removed:true,accountIds:accounts.map(row=>row.id)};
}

export function registerMemberRemovalAction(options:{pool:Pool;journal:HostFinancialJournal|undefined;designatedOwnerId:string|undefined;nativeCustody?:BudgetNativeCustodyStore}):void{
  registerAction({name:'member.remove',input:memberRemovalInput,secretFields:['sessionToken'],run:async(input)=>{
    const journal=options.journal;
    if(!journal?.prepared||!options.designatedOwnerId)throw refusal();
    const writer=new JournalBudgetFinancialWriter(journal);
    // Journal ownership precedes the only transaction pool checkout. A short wall-clock
    // bound protects queueing; exact session expiry is retained from PostgreSQL inside it.
    let sqlCommitAcknowledged=false;
    const work=(boundary:SourceTransactionBoundary,operationId:string)=>consoleSourceTransaction(
        options.pool as unknown as SourcePool,
        db=>removeOwned(db,journal,options.designatedOwnerId,input,operationId),
        boundary,{deadlineAtMs:Date.now()+5_000,afterCommit:()=>{sqlCommitAcknowledged=true;}},
      );
    let committed:{value:{removed:true;accountIds:readonly string[]};receipt:import('./financial-journal.js').CommittedFinancialReceipt}|undefined;
    try{
      if(!options.nativeCustody){const result=await writer.run('member-remove',work);return {removed:result.removed};}
      const gated=await options.nativeCustody.withGate(async gate=>{
        try{
          let nativeCleanup:NativeCleanupStatus|undefined;
          const result=await writer.runWithReceipt('member-remove',work,(receipt,value)=>{
            nativeCleanup=recordCommittedNativeRetirement(gate,value.accountIds,receipt,false);
            return undefined;
          });
          committed=result;
          return {kind:'done' as const,result:{removed:true as const,nativeCleanup:nativeCleanup??{status:'blocked',remaining:null}}};
        }catch(error){
          if(isJournaledAbort(error,{journalId:journal.id,operation:'member-remove'}))return {kind:'aborted' as const,error};
          throw error;
        }
      });
      if(gated.kind==='aborted')throw gated.error;
      return gated.result;
    }catch(error){
      if(committed)return {removed:true,nativeCleanup:{status:'blocked',remaining:null}};
      if(sqlCommitAcknowledged&&options.nativeCustody)return {removed:true,nativeCleanup:{status:'blocked',remaining:null}};
      if(error instanceof SourceTransactionDeadlineExpired)throw refusal();
      throw error;
    }
  },successDetail:(result)=>result.nativeCleanup?.status==='pending'
    ?`member access removed; ${result.nativeCleanup.remaining} native key cleanup item(s) pending`
    :result.nativeCleanup?.status==='blocked'?'member access removed; native cleanup needs inspection':'member access removed'});
}
