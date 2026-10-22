import {gatewayCanonical} from '@lares/agent-kit/gateway-admission-protocol';
import {consoleSourceTransaction,sourceTransactionBoundary,type BudgetFinancialChange,type SourceDatabase,type SourcePool,type SourceTransactionOutcome} from '@lares/agent-kit/console-source-transaction';
import {HostFinancialJournal,type FinancialAtom} from './financial-journal.js';
import {collectFinancialAtoms} from './budget-financial-writer.js';
import {verifyFinancialContinuity} from './financial-continuity.js';

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const same=(left:readonly FinancialAtom[],right:readonly FinancialAtom[])=>Buffer.from(gatewayCanonical([...left])).equals(Buffer.from(gatewayCanonical([...right])));
const refusal=()=>new Error('Financial erasure preflight refused');

export interface PersonErasureClosure {
  /** Opaque capability: only this journaled operation can finish its prepared closure. */
}
export interface PersonErasureFinancialContext {
  prepare(db:SourceDatabase,memberId:string):Promise<PersonErasureClosure>;
  readonly owner:object;
  /** Re-read stable coordinates, verify complete metadata redaction, then stage the exact closure. */
  finalize(db:SourceDatabase,closure:PersonErasureClosure):Promise<void>;
}
const journalOwners=new WeakMap<object,SourceDatabase>();
export function isJournaledPersonErasureOwner(value:object,source?:SourceDatabase):boolean{return source?journalOwners.get(value)===source:journalOwners.has(value);}
const closures=new WeakMap<object,{db:SourceDatabase;owner:object;operationId:string;memberId:string;accountIds:readonly string[];memberAccountIds:readonly string[];projected:readonly FinancialAtom[];tombstones:readonly FinancialAtom[];bindingIds:readonly string[];attemptIds:readonly string[];windowIds:readonly string[];financialBindingIds:readonly string[];financialAttemptIds:readonly string[]}>();

/** Locks the full target metadata set and the financial rows needed by the bounded proposal.
 * Historical liability stays in PostgreSQL; only changed accounts, active bindings, prepared
 * attempts and their dependency closure enter the journal. */
async function prepareClosure(db:SourceDatabase,journal:HostFinancialJournal,operationId:string,owner:object,pending:Set<object>,memberId:string):Promise<PersonErasureClosure>{
  const installations=(await db.query("SELECT id FROM budget_accounts WHERE kind='installation' ORDER BY id LIMIT 129 FOR UPDATE")).rows;
  const accounts=(await db.query("SELECT id,active_window_id FROM budget_accounts WHERE live_member_id=$1 ORDER BY id LIMIT 129 FOR UPDATE",[memberId])).rows;
  const allBindings=(await db.query("SELECT id,installation_account_id,member_account_id,state FROM budget_gateway_bindings WHERE live_member_id=$1 ORDER BY id FOR UPDATE",[memberId])).rows;
  const allAttempts=(await db.query("SELECT id,installation_account_id,member_account_id,binding_id,installation_window_id,member_window_id,state FROM budget_attempts WHERE live_member_id=$1 ORDER BY id FOR UPDATE",[memberId])).rows;
  const allWindows=(await db.query("SELECT id,account_id FROM budget_windows WHERE live_member_id=$1 ORDER BY id FOR UPDATE",[memberId])).rows;
  // Grants are historical settlement evidence. Keep them stable while proving that the
  // tombstone proposal retains the exact suppression state without retaining the identity.
  const targetAttemptIds=allAttempts.map(row=>row.id);
  const grants=targetAttemptIds.length
    ?(await db.query('SELECT attempt_id FROM budget_gateway_grants WHERE attempt_id=ANY($1::uuid[]) ORDER BY attempt_id FOR UPDATE',[[...targetAttemptIds].sort()])).rows
    :[];
  const activeBindings=allBindings.filter(row=>row.state==='active'),preparedAttempts=allAttempts.filter(row=>row.state==='prepared');
  if(installations.length>128||accounts.length>128||activeBindings.length>128||preparedAttempts.length>128)throw refusal();
  if([...installations,...accounts,...allBindings,...allAttempts,...allWindows].some(row=>!uuid(row.id)))throw refusal();

  const dependencyAccountIds=new Set<string>([
    ...installations.map(row=>row.id),...accounts.map(row=>row.id),
    ...allBindings.flatMap(row=>[row.installation_account_id,row.member_account_id]),
    ...allAttempts.flatMap(row=>[row.installation_account_id,row.member_account_id]),
  ]);
  const dependencyAccounts=dependencyAccountIds.size
    ?(await db.query('SELECT id FROM budget_accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[[...dependencyAccountIds].sort()])).rows
    :[];
  const dependencyWindowIds=new Set<string>([
    ...allWindows.map(row=>row.id),...accounts.flatMap(row=>row.active_window_id?[row.active_window_id]:[]),
    ...allAttempts.flatMap(row=>[row.installation_window_id,row.member_window_id]),
  ]);
  const dependencyWindows=dependencyWindowIds.size
    ?(await db.query('SELECT id FROM budget_windows WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[[...dependencyWindowIds].sort()])).rows
    :[];
  if(dependencyAccounts.length!==dependencyAccountIds.size||dependencyWindows.length!==dependencyWindowIds.size)throw refusal();

  const accountIds=new Set<string>([...installations.map(row=>row.id),...accounts.map(row=>row.id)]);
  const bindingIds=new Set<string>(activeBindings.map(row=>row.id));
  const attemptIds=new Set<string>(preparedAttempts.map(row=>row.id));
  const changes:BudgetFinancialChange[]=[...accountIds].map(id=>({table:'budget_accounts',id}));
  for(const id of bindingIds)changes.push({table:'budget_gateway_bindings' as const,id});
  for(const id of attemptIds)changes.push({table:'budget_attempts' as const,id});
  const before=await collectFinancialAtoms(db,changes);
  const targets=new Set(accounts.map(row=>row.id));
  const projected:FinancialAtom[]=[];
  const tombstones:FinancialAtom[]=[];
  for(const atom of before){
    if(atom.kind==='account'&&targets.has(atom.id)){
      const erased={...atom,state:'retired' as const,reason:'member_erased' as const,policyGeneration:(BigInt(atom.policyGeneration)+1n).toString()};
      projected.push(erased);
      if(atom.accountKind==='member'){
        if(!atom.canonicalSuppressionHash||atom.providerSuppressionHashes.length<1||atom.providerSuppressionHashes.length>64)throw refusal();
        tombstones.push({kind:'tombstone',accountId:atom.id,canonicalSuppressionHash:atom.canonicalSuppressionHash,providerSuppressionHashes:atom.providerSuppressionHashes,state:'erased'});
      }
    }else if(atom.kind==='binding'&&bindingIds.has(atom.id))projected.push({...atom,state:'revoked'});
    else if(atom.kind==='attempt'&&attemptIds.has(atom.id))projected.push({...atom,state:'retired'});
    else projected.push(atom);
  }
  projected.push(...tombstones);
  if(projected.length>128)throw refusal();
  try{journal.validateProposal(operationId,projected);}catch(error){
    if(error instanceof Error&&error.message==='Financial proposal exceeds journal record limit')throw new Error('Financial erasure proposal exceeds the journal record limit');
    throw error;
  }

  const closure:PersonErasureClosure={};
  closures.set(closure,{db,owner,operationId,memberId,projected,tombstones,accountIds:[...accountIds].sort(),memberAccountIds:accounts.map(row=>row.id).sort(),bindingIds:[...new Set(allBindings.map(row=>row.id))].sort(),attemptIds:[...new Set(allAttempts.map(row=>row.id))].sort(),windowIds:[...new Set(allWindows.map(row=>row.id))].sort(),financialBindingIds:[...bindingIds].sort(),financialAttemptIds:[...attemptIds].sort()});
  pending.add(closure);
  return closure;
}

async function finalizeClosure(afterDb:SourceDatabase,closure:PersonErasureClosure,journal:HostFinancialJournal,operationId:string,owner:object):Promise<FinancialAtom[]>{
    const saved=closures.get(closure as object);if(!saved||saved.db!==afterDb||saved.owner!==owner||saved.operationId!==operationId)throw refusal();
    const {memberId,projected,tombstones,accountIds,memberAccountIds,bindingIds,attemptIds,windowIds,financialBindingIds,financialAttemptIds}=saved;
    const accountChange:BudgetFinancialChange[]=[...accountIds].map(id=>({table:'budget_accounts',id}));
    for(const id of financialBindingIds)accountChange.push({table:'budget_gateway_bindings' as const,id});
    for(const id of financialAttemptIds)accountChange.push({table:'budget_attempts' as const,id});
    // Only the preflighted active bindings and prepared attempts are serialized. All historical
    // rows remain locked and are checked below by their stable IDs.
    const actual=await collectFinancialAtoms(afterDb,accountChange);
    const rows=(await afterDb.query(`SELECT
      (SELECT count(*) FROM budget_accounts WHERE live_member_id=$1)::int AS accounts,
      (SELECT count(*) FROM budget_gateway_bindings WHERE live_member_id=$1)::int AS bindings,
      (SELECT count(*) FROM budget_attempts WHERE live_member_id=$1)::int AS attempts,
      (SELECT count(*) FROM budget_windows WHERE live_member_id=$1)::int AS windows,
      (SELECT count(*) FROM budget_accounts WHERE id=ANY($2::uuid[]) AND (live_member_id IS NOT NULL OR organisation_id IS NOT NULL))::int AS account_metadata,
      (SELECT count(*) FROM budget_gateway_bindings WHERE id=ANY($3::uuid[]) AND (live_member_id IS NOT NULL OR agent IS NOT NULL OR incarnation IS NOT NULL OR native_team IS NOT NULL OR native_user IS NOT NULL OR purpose_alias IS NOT NULL OR key_fingerprint IS NOT NULL))::int AS binding_metadata,
      (SELECT count(*) FROM budget_attempts WHERE id=ANY($4::uuid[]) AND (live_member_id IS NOT NULL OR authority_reference IS NOT NULL))::int AS attempt_metadata,
      (SELECT count(*) FROM budget_windows WHERE id=ANY($5::uuid[]) AND live_member_id IS NOT NULL)::int AS window_metadata`,[memberId,memberAccountIds,bindingIds,attemptIds,windowIds])).rows[0];
    if(!rows||rows.accounts!==0||rows.bindings!==0||rows.attempts!==0||rows.windows!==0||rows.account_metadata!==0||rows.binding_metadata!==0||rows.attempt_metadata!==0||rows.window_metadata!==0)throw refusal();
    const erasedAccounts=actual.filter((atom):atom is Extract<FinancialAtom,{kind:'account'}>=>atom.kind==='account'&&memberAccountIds.includes(atom.id)&&atom.accountKind==='member');
    if(erasedAccounts.length!==tombstones.length)throw refusal();
    const derivedTombstones:FinancialAtom[]=erasedAccounts.map(atom=>{
      if(!atom.canonicalSuppressionHash||atom.providerSuppressionHashes.length<1||atom.providerSuppressionHashes.length>64)throw refusal();
      return {kind:'tombstone',accountId:atom.id,canonicalSuppressionHash:atom.canonicalSuppressionHash,providerSuppressionHashes:atom.providerSuppressionHashes,state:'erased'};
    });
    const actualWithTombstones:FinancialAtom[]=[...actual,...derivedTombstones];
    if(!same(projected,actualWithTombstones))throw refusal();
    try{journal.validateProposal(operationId,actualWithTombstones);}catch(error){
      if(error instanceof Error&&error.message==='Financial proposal exceeds journal record limit')throw new Error('Financial erasure proposal exceeds the journal record limit');
      throw error;
    }
    closures.delete(closure as object);
    return actualWithTombstones;
}

/** Begins durable journal ownership before the first database checkout and owns one source
 * transaction through identity resolution, file work, redaction, proposal and commit. */
export async function runJournaledPersonErasure<T>(pool:SourcePool,journal:HostFinancialJournal,
  work:(db:SourceDatabase,financial:PersonErasureFinancialContext)=>Promise<T>):Promise<{value:T;outcome:SourceTransactionOutcome}>{
  let outcome:SourceTransactionOutcome='not-started';
  try{
  const value=await journal.operation('erase-person',async operationId=>{
    let proposal:readonly FinancialAtom[]|undefined;
    const owner=Object.freeze({});
    let activeSource:SourceDatabase|undefined;
    const pendingClosures=new Set<object>();
    const financial:PersonErasureFinancialContext={
      prepare:(db,memberId)=>{if(db!==activeSource||!isJournaledPersonErasureOwner(owner,db))throw refusal();return prepareClosure(db,journal,operationId,owner,pendingClosures,memberId);},
      owner,
      finalize:async(db,closure)=>{if(db!==activeSource||!isJournaledPersonErasureOwner(owner,db)||proposal)throw refusal();proposal=await finalizeClosure(db,closure,journal,operationId,owner);pendingClosures.delete(closure as object);},
    };
    let settled=false,proposed=false;
    const boundary=sourceTransactionBoundary({
      started:async db=>verifyFinancialContinuity(journal,db),
      readyToCommit:async db=>verifyFinancialContinuity(journal,db,true),
      beforeCommit:async(db)=>{
        if(!proposal)throw refusal();
        const record=journal.propose(operationId,proposal);proposed=true;
        await db.query('INSERT INTO budget_financial_checkpoints(operation_id,journal_id,proposal_sequence,proposal_digest) VALUES($1,$2,$3,$4)',[record.operationId,record.journalId,record.sequence,record.digest]);
      },
      settled:async result=>{
        outcome=result;
        if(result==='commit-acknowledged'){
          if(!proposed){journal.freeze();throw refusal();}
          journal.committed(operationId);
        }else if(result==='unknown'){
          journal.freeze();throw new Error('Financial erasure outcome is unknown; inspection and recovery are required');
        }else journal.aborted(operationId,result);
        settled=true;
      },
    });
    try{
      const result=await consoleSourceTransaction(pool,async db=>{
        activeSource=db;
        journalOwners.set(owner,db);
        try{return await work(db,financial);}finally{activeSource=undefined;journalOwners.delete(owner);}
      },boundary);
      if(!settled)throw refusal();return result;
    }finally{journalOwners.delete(owner);for(const closure of pendingClosures)closures.delete(closure);pendingClosures.clear();if(!settled){try{journal.freeze();}catch{/* Preserve the original failure; custody remains recovery-only. */}}}
  });
  return {value,outcome};
  }catch(error){if(error&&typeof error==='object')Object.defineProperty(error,'outcome',{value:outcome,configurable:true});throw error;}
}

