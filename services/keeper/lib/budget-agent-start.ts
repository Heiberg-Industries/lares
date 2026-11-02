/** Host-only reads and one bounded write behind `lares agent start`. The command runs as root on
 * the server, so it decides its next step from these rows instead of remembering its last one:
 * running it again after an interruption continues from what is actually recorded. */
import type {Pool} from 'pg';
import {z} from 'zod';
import {canonicalBudgetMoney} from '@lares/agent-kit/budget-admission-store';
import {consoleSourceTransaction,gateConsoleOrganisation,type SourceDatabase,type SourcePool} from '@lares/agent-kit/console-source-transaction';
import {PgGrantStore} from '@lares/agent-kit/grant-store';
import {KeeperRefusedError,registerAction} from './actions.js';

const memberText=z.string().min(1).max(254).refine(value=>!/[\u0000-\u001f\u007f]/.test(value));
const memberId=z.string().min(1).max(128).refine(value=>!/[\u0000-\u001f\u007f]/.test(value));
export const agentStartStatusInput=z.strictObject({agent:z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),member:memberText.optional()});
export const defaultMemberLimitInput=z.strictObject({memberId,monthlyLimit:z.string().max(37)});
export type AgentStartStatus={
  agent:{status:string;model:string|null;incarnation:string|null;state:string|null;pending:boolean;pendingReason:string|null;owned:boolean}|null;
  member:{id:string;active:boolean;verified:boolean;limit:string|null;canUse:boolean}|null;
  installation:{state:string}|null;
  account:{state:string}|null;
  binding:{id:string;credentialGeneration:string}|null;
};
type Row=Record<string,any>;
const rows=async(db:SourceDatabase,sql:string,values:unknown[]):Promise<Row[]>=>(await db.query(sql,values)).rows;
const positive=(value:unknown):string|null=>{
  if(value===null||value===undefined)return null;
  try{const money=canonicalBudgetMoney(String(value));return money==='0'?null:money;}catch{return null;}
};
const unavailable=()=>new KeeperRefusedError('The agent start status is unavailable.');

/** The person is the configured owner unless named, by member id or by exact sign-in email. */
async function findMember(db:SourceDatabase,member:string|undefined,ownerId:string):Promise<Row|undefined>{
  const found=member===undefined?await rows(db,'SELECT id,status FROM users WHERE id=$1',[ownerId])
    :member.includes('@')?await rows(db,'SELECT id,status FROM users WHERE lower(primary_email)=lower($1) ORDER BY id LIMIT 2',[member])
    :await rows(db,'SELECT id,status FROM users WHERE id=$1',[member]);
  return found.length===1?found[0]:undefined;
}

export async function readAgentStartStatus(pool:Pool,input:z.infer<typeof agentStartStatusInput>,designatedOwnerId:string):Promise<AgentStartStatus>{
  return consoleSourceTransaction(pool as unknown as SourcePool,async db=>{
    const agentRow=(await rows(db,`SELECT d.status,d.definition->>'model' AS model,r.ownership,r.ownership_token,r.runtime_control_token,r.state,r.pending,r.pending_reason
      FROM agent_definitions d LEFT JOIN agent_resources r ON r.name=d.name WHERE d.name=$1`,[input.agent]))[0];
    const agent=agentRow?{status:String(agentRow.status),model:agentRow.model??null,
      incarnation:agentRow.ownership_token&&agentRow.ownership_token===agentRow.runtime_control_token?String(agentRow.ownership_token):null,
      state:agentRow.state??null,pending:agentRow.pending===true,pendingReason:agentRow.pending_reason??null,owned:agentRow.ownership==='owned'}:null;
    const user=await findMember(db,input.member,designatedOwnerId);
    const installationRow=(await rows(db,`SELECT state FROM budget_accounts WHERE kind='installation' ORDER BY id LIMIT 2`,[]));
    if(installationRow.length>1)throw unavailable();
    const installation=installationRow[0]?{state:String(installationRow[0].state)}:null;
    if(!user)return {agent,member:null,installation,account:null,binding:null};
    const verified=(await rows(db,'SELECT 1 FROM member_provider_identities WHERE member_id=$1 LIMIT 1',[user.id])).length===1;
    const policy=(await rows(db,'SELECT spend_cap_usd_month FROM org_member_policy WHERE user_id=$1',[user.id]))[0];
    const canUse=agent?!!await new PgGrantStore().captureUseWithExpiry(user.id,input.agent,{db:db as unknown as import('pg').PoolClient}):false;
    const accountRows=await rows(db,`SELECT id,state FROM budget_accounts WHERE kind='member' AND live_member_id=$1 ORDER BY id LIMIT 2`,[user.id]);
    if(accountRows.length>1)throw unavailable();
    const account=accountRows[0];
    const binding=account&&agent?.incarnation?(await rows(db,`SELECT id,credential_generation::text AS credential_generation FROM budget_gateway_bindings
      WHERE member_account_id=$1 AND agent=$2 AND incarnation=$3 AND state='active' ORDER BY id LIMIT 1`,[account.id,input.agent,agent.incarnation]))[0]:undefined;
    return {agent,
      member:{id:String(user.id),active:user.status==='active',verified,limit:positive(policy?.spend_cap_usd_month),canUse},
      installation,
      account:account?{state:String(account.state)}:null,
      binding:binding?{id:String(binding.id),credentialGeneration:String(binding.credential_generation)}:null};
  },undefined,{deadlineAtMs:Date.now()+5_000});
}

/** Give a person the installation's default limit only when they have none yet. It never replaces
 * a limit the owner chose, and once an account exists the limit is already part of it. */
export async function applyDefaultMemberLimit(pool:Pool,input:z.infer<typeof defaultMemberLimitInput>):Promise<{saved:boolean}>{
  let limit:string;
  try{limit=canonicalBudgetMoney(input.monthlyLimit);}catch{throw new KeeperRefusedError('The default monthly limit is invalid.');}
  if(limit==='0'||limit!==input.monthlyLimit)throw new KeeperRefusedError('The default monthly limit is invalid.');
  return consoleSourceTransaction(pool as unknown as SourcePool,async db=>{
    await gateConsoleOrganisation(db,input.memberId,undefined,{lock:'update'});
    const target=(await rows(db,'SELECT id,status FROM users WHERE id=$1 FOR UPDATE',[input.memberId]))[0];
    if(!target||target.status!=='active')throw new KeeperRefusedError('This person is not an active member.');
    const policy=(await rows(db,'SELECT spend_cap_usd_month FROM org_member_policy WHERE user_id=$1 FOR UPDATE',[input.memberId]))[0];
    if(positive(policy?.spend_cap_usd_month))return {saved:false};
    if((await rows(db,'SELECT id FROM budget_accounts WHERE live_member_id=$1 LIMIT 1 FOR UPDATE',[input.memberId])).length)return {saved:false};
    if(policy)await db.query('UPDATE org_member_policy SET spend_cap_usd_month=$2 WHERE user_id=$1',[input.memberId,limit]);
    else await db.query('INSERT INTO org_member_policy(user_id,spend_cap_usd_month) VALUES($1,$2)',[input.memberId,limit]);
    return {saved:true};
  },undefined,{deadlineAtMs:Date.now()+5_000});
}

export function registerBudgetAgentStartActions(options:{pool:Pool;designatedOwnerId:string|undefined}):void{
  registerAction({name:'budget.agent-start-status',hostOnly:true,input:agentStartStatusInput,secretFields:['member'],run:async input=>{
    if(!options.designatedOwnerId)throw unavailable();
    return readAgentStartStatus(options.pool,input,options.designatedOwnerId);
  },successDetail:()=> 'agent start status read'});
  registerAction({name:'budget.apply-default-member-limit',hostOnly:true,input:defaultMemberLimitInput,secretFields:['memberId'],run:input=>applyDefaultMemberLimit(options.pool,input),
    successDetail:result=>result.saved?'default member limit applied':'existing member limit kept'});
}
