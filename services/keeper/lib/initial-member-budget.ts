import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import {canonicalBudgetMoney} from '@lares/agent-kit/budget-admission-store';
import {consoleSourceTransaction,gateConsoleOrganisation,retainSourceTransactionDeadline,type SourceDatabase,type SourcePool} from '@lares/agent-kit/console-source-transaction';
import {KeeperRefusedError,registerAction} from './actions.js';

export type InitialMemberBudgetStatus={memberId:string;eligible:boolean;setupComplete:boolean};
export type InitialMemberBudgetStatusResult=InitialMemberBudgetStatus[];
export const initialMemberBudgetStatusInput=z.strictObject({sessionToken:z.string().regex(/^[A-Za-z0-9_-]{43}$/)});
export const setInitialMemberBudgetInput=z.strictObject({
  sessionToken:z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  targetMemberId:z.string().min(1).max(128).refine(value=>!/[\u0000-\u001f\u007f]/.test(value)),
  monthlyLimit:z.string().max(37),
});
export type SetInitialMemberBudgetInput=z.infer<typeof setInitialMemberBudgetInput>;

const idSchema=z.string().min(1).max(128).refine(value=>!/[\u0000-\u001f\u007f]/.test(value));
const tokenHash=(token:string)=>createHash('sha256').update(token).digest('hex');
const utc=(column:string)=>`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const instant=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value);
type SessionRow={member_id:string;expires_at:string};
type OwnerRow={id:string;org_id:string|null;org_role:string;status:string};
const queryRows=async<T>(db:SourceDatabase,sql:string,values?:unknown[]):Promise<T[]>=>(await db.query(sql,values)).rows as T[];

type Refusal='invalid'|'denied'|'setup-complete'|'unavailable';
function refuse(reason:Refusal):never{
  const message=reason==='unavailable'?'Initial member budget setup is unavailable.':
    'Initial member budget setup was refused.';
  throw new KeeperRefusedError(message,[{check:'member.initial-budget',message:reason}]);
}
function validateOwnerConfiguration(ownerId:unknown,pool:Pool|undefined):asserts ownerId is string{
  if(!pool||!idSchema.safeParse(ownerId).success)refuse('unavailable');
}

/** Lock the configured owner's organisation, user and exact current session expiry. */
async function lockCurrentOwner(db:SourceDatabase,sessionToken:string,designatedOwnerId:string):Promise<{id:string;organisationId:string}>{
  const hash=tokenHash(sessionToken);
  // Discovery only selects which organisation gate to take; authority is re-read below.
  const discovered=(await queryRows<SessionRow>(db,`SELECT s.member_id,${utc('s.expires_at')} AS expires_at
    FROM member_sessions s WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()`,[hash]))[0];
  if(!discovered||!instant(discovered.expires_at)||!idSchema.safeParse(discovered.member_id).success)refuse('denied');
  try{await gateConsoleOrganisation(db,discovered.member_id,undefined,{lock:'update'});}catch(error){
    if(error instanceof Error&&error.message==='Conversation authority is not available')refuse('denied');
    throw error;
  }
  const owner=(await queryRows<OwnerRow>(db,'SELECT id,org_id,org_role,status FROM users WHERE id=$1 FOR UPDATE',[discovered.member_id]))[0];
  if(!owner||owner.id!==designatedOwnerId||owner.status!=='active'||owner.org_role!=='owner'||!owner.org_id)refuse('denied');
  const session=(await queryRows<SessionRow>(db,`SELECT s.member_id,${utc('s.expires_at')} AS expires_at
    FROM member_sessions s WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR UPDATE`,[hash]))[0];
  if(!session||session.member_id!==owner.id||!instant(session.expires_at))refuse('denied');
  // Retained by consoleSourceTransaction through every commit check, at SQL microsecond precision.
  await retainSourceTransactionDeadline(db,session.expires_at);
  return{id:owner.id,organisationId:owner.org_id};
}

/** Owner-only setup state. It returns bounded same-organisation eligibility only. */
export async function listInitialMemberBudgetStatus(pool:Pool,sessionToken:string,designatedOwnerId:string):Promise<InitialMemberBudgetStatusResult>{
  validateOwnerConfiguration(designatedOwnerId,pool);
  return consoleSourceTransaction(pool as unknown as SourcePool,async db=>{
    const owner=await lockCurrentOwner(db,sessionToken,designatedOwnerId);
    const rows=await queryRows<{id:string;status:string;verified:boolean;has_account:boolean}>(db,`SELECT u.id,u.status,
      EXISTS(SELECT 1 FROM member_provider_identities i WHERE i.member_id=u.id) AS verified,
      EXISTS(SELECT 1 FROM budget_accounts b WHERE b.live_member_id=u.id) AS has_account
      FROM users u WHERE u.org_id=$1 ORDER BY u.id LIMIT 1025`,[owner.organisationId]);
    if(rows.length>1024)refuse('unavailable');
    if(rows.some(row=>!idSchema.safeParse(row.id).success||typeof row.status!=='string'||typeof row.verified!=='boolean'||typeof row.has_account!=='boolean'))refuse('unavailable');
    return rows.map(row=>({memberId:row.id,eligible:row.status==='active'&&row.verified&&!row.has_account,setupComplete:row.has_account}));
  },undefined,{deadlineAtMs:Date.now()+5_000});
}

/** Set an explicit initial cap only while no account of any kind belongs to the target. */
export async function setInitialMemberBudgetLimit(pool:Pool,input:SetInitialMemberBudgetInput,designatedOwnerId:string):Promise<{saved:true}>{
  validateOwnerConfiguration(designatedOwnerId,pool);
  try{if(canonicalBudgetMoney(input.monthlyLimit)!==input.monthlyLimit||input.monthlyLimit==='0')refuse('invalid');}catch{refuse('invalid');}
  return consoleSourceTransaction(pool as unknown as SourcePool,async db=>{
    const owner=await lockCurrentOwner(db,input.sessionToken,designatedOwnerId);
    try{await gateConsoleOrganisation(db,input.targetMemberId,undefined,{lock:'update'});}catch(error){
      if(error instanceof Error&&error.message==='Conversation authority is not available')refuse('denied');
      throw error;
    }
    const target=(await queryRows<{id:string;status:string;org_id:string}>(db,'SELECT id,status,org_id FROM users WHERE id=$1 FOR UPDATE',[input.targetMemberId]))[0];
    if(!target||target.status!=='active'||target.org_id!==owner.organisationId)refuse('denied');
    const identities=await queryRows<{issuer:string;subject:string;tenant_id:string}>(db,`SELECT issuer,subject,tenant_id FROM member_provider_identities
      WHERE member_id=$1 ORDER BY issuer,subject,tenant_id LIMIT 65 FOR SHARE`,[target.id]);
    if(identities.length<1||identities.length>64||identities.some(row=>typeof row.issuer!=='string'||typeof row.subject!=='string'||typeof row.tenant_id!=='string'))refuse('denied');
    const policy=await queryRows<{user_id:string}>(db,'SELECT user_id FROM org_member_policy WHERE user_id=$1 FOR UPDATE',[target.id]);
    if(policy.length>1)refuse('denied');
    // Match the trigger predicate across every account kind. Org and target row locks
    // serialize this absence proof with account provisioning and FK-backed inserts.
    const accounts=await queryRows<{id:string}>(db,'SELECT id FROM budget_accounts WHERE live_member_id=$1 ORDER BY id LIMIT 2 FOR UPDATE',[target.id]);
    if(accounts.length)refuse('setup-complete');
    if(policy.length)await db.query('UPDATE org_member_policy SET spend_cap_usd_month=$2 WHERE user_id=$1',[target.id,input.monthlyLimit]);
    else await db.query('INSERT INTO org_member_policy(user_id,spend_cap_usd_month) VALUES($1,$2)',[target.id,input.monthlyLimit]);
    const after=await queryRows<{id:string}>(db,'SELECT id FROM budget_accounts WHERE live_member_id=$1 ORDER BY id LIMIT 2 FOR UPDATE',[target.id]);
    if(after.length)refuse('unavailable');
    return{saved:true as const};
  },undefined,{deadlineAtMs:Date.now()+5_000});
}

export function registerInitialMemberBudgetActions(options:{pool:Pool|undefined;designatedOwnerId:string|undefined}):void{
  registerAction({name:'member.initial-budget-status',input:initialMemberBudgetStatusInput,secretFields:['sessionToken'],run:async input=>{
    if(!options.pool||!options.designatedOwnerId)refuse('unavailable');
    return listInitialMemberBudgetStatus(options.pool,input.sessionToken,options.designatedOwnerId);
  },successDetail:result=>`initial member budget status read for ${result.length} member(s)`});
  registerAction({name:'member.set-initial-budget',input:setInitialMemberBudgetInput,secretFields:['sessionToken'],run:async input=>{
    if(!options.pool||!options.designatedOwnerId)refuse('unavailable');
    return setInitialMemberBudgetLimit(options.pool,input,options.designatedOwnerId);
  },successDetail:()=> 'initial member budget limit saved'});
}
