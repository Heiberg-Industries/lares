import {canonicalBudgetMoney} from "@lares/agent-kit/budget-admission-store";
import {currentSession} from "@lares/agent-kit/member-store";
import {consoleSourceTransaction,gateConsoleOrganisation,type SourcePool,type SourceDatabase} from "@lares/agent-kit/console-source-transaction";

export type InitialMemberBudgetStatus={memberId:string;eligible:boolean;setupComplete:boolean};
export class InitialMemberBudgetRefused extends Error {
  constructor(readonly reason:"invalid"|"denied"|"setup-complete") { super("Initial monthly limit setup was refused"); }
}
const refuse=(reason:InitialMemberBudgetRefused["reason"]="denied"):never=>{throw new InitialMemberBudgetRefused(reason);};
const validId=(value:unknown):value is string=>typeof value==="string"&&value.length>0&&value.length<=128&&!/[\u0000-\u001f\u007f]/.test(value);

async function lockCurrentOwner(db:SourceDatabase,sessionToken:string,designatedOwnerId:string):Promise<{id:string;organisationId:string}> {
  if(!validId(designatedOwnerId)||typeof sessionToken!=="string"||!sessionToken)refuse();
  // This acquires the organisation lock before current authority, membership and policy.
  await gateConsoleOrganisation(db,designatedOwnerId,undefined,{lock:"update"});
  const owner=await currentSession(db as never,sessionToken,designatedOwnerId,{lock:"share"});
  if(!owner)throw new InitialMemberBudgetRefused("denied");
  if(owner.id!==designatedOwnerId||owner.role!=="owner"||owner.status!=="active"||!owner.organisationId)refuse();
  return {id:owner.id,organisationId:owner.organisationId};
}

/** Owner-only setup state. It returns only eligibility and whether an account already exists. */
export async function listInitialMemberBudgetStatus(pool:SourcePool,sessionToken:string,designatedOwnerId:string):Promise<InitialMemberBudgetStatus[]> {
  return consoleSourceTransaction(pool,async db=>{
    const owner=await lockCurrentOwner(db,sessionToken,designatedOwnerId);
    const rows=(await db.query(`SELECT u.id,u.status,
      EXISTS(SELECT 1 FROM member_provider_identities i WHERE i.member_id=u.id) AS verified,
      EXISTS(SELECT 1 FROM budget_accounts b WHERE b.kind='member' AND b.live_member_id=u.id) AS has_account
      FROM users u WHERE u.org_id=$1 ORDER BY u.id`,[owner.organisationId])).rows;
    return rows.filter(row=>validId(row.id)).map(row=>({
      memberId:row.id,
      eligible:row.status==='active'&&row.verified===true&&row.has_account===false,
      setupComplete:row.has_account===true,
    }));
  });
}

/** Set a caller-chosen first cap only while no member account exists for that person. */
export async function setInitialMemberBudgetLimit(pool:SourcePool,input:{sessionToken:string;designatedOwnerId:string;targetMemberId:string;monthlyLimit:string}):Promise<void> {
  let canonical:string;
  try {
    canonical=canonicalBudgetMoney(input.monthlyLimit);
    if(canonical!==input.monthlyLimit||canonical==="0")refuse("invalid");
  } catch { refuse("invalid"); }
  if(!validId(input.targetMemberId))refuse("invalid");

  await consoleSourceTransaction(pool,async db=>{
    const owner=await lockCurrentOwner(db,input.sessionToken,input.designatedOwnerId);
    // The same organisation lock serializes this check with provisionBudgetAccounts,
    // which holds FOR SHARE before creating a member account.
    try { await gateConsoleOrganisation(db,input.targetMemberId,undefined,{lock:"update"}); }
    catch (error) {
      // This exact shared-gate refusal covers an inactive or moved target. PostgreSQL and
      // transaction errors retain their original error and are never reported as denial.
      if(error instanceof Error&&error.message==="Conversation authority is not available")refuse();
      throw error;
    }
    const target=(await db.query(`SELECT id,status,org_id FROM users WHERE id=$1 FOR UPDATE`,[input.targetMemberId])).rows;
    if(target.length!==1||target[0]!.status!=="active"||target[0]!.org_id!==owner.organisationId)refuse();
    const identities=(await db.query(`SELECT issuer,subject,tenant_id FROM member_provider_identities
      WHERE member_id=$1 ORDER BY issuer,subject,tenant_id LIMIT 65 FOR SHARE`,[input.targetMemberId])).rows;
    if(identities.length<1||identities.length>64||identities.some(row=>typeof row.issuer!=="string"||typeof row.subject!=="string"||typeof row.tenant_id!=="string"))refuse();
    const policy=(await db.query(`SELECT user_id,spend_cap_usd_month FROM org_member_policy WHERE user_id=$1 FOR UPDATE`,[input.targetMemberId])).rows;
    if(policy.length>1)refuse();
    const accounts=(await db.query(`SELECT id FROM budget_accounts WHERE kind='member' AND live_member_id=$1 ORDER BY id LIMIT 2 FOR UPDATE`,[input.targetMemberId])).rows;
    if(accounts.length)refuse("setup-complete");

    if(policy.length) await db.query(`UPDATE org_member_policy SET spend_cap_usd_month=$2 WHERE user_id=$1`,[input.targetMemberId,canonical]);
    else await db.query(`INSERT INTO org_member_policy(user_id,spend_cap_usd_month) VALUES($1,$2)`,[input.targetMemberId,canonical]);
  });
}
