import type { SourceDatabase } from './console-source-transaction.js';
import { checkConsoleSourceDeadlines, gateConsoleOrganisation, requireSourceTransactionOwner } from './console-source-transaction.js';
import { consoleAdmission, requireConsoleSessionBinding, requireConsoleTurnAuthority,
  type ConsoleAuthorityContext, type ConsoleBinding } from './console-turn-authority.js';
import { privateResumeAdmission, requireConsoleResume, requirePersistedConsoleModelResume } from './private-console-resume.js';
import { PgGrantStore } from './grant-store.js';
import { managedIdentity } from './door-authority.js';
import { payloadFingerprint } from './approval-ledger.js';

/**
 * Persisted evidence describing the console authority that created a budget intent.
 * This is not registered capability: parsing JSON never authenticates the evidence.
 */
export type ConversationBudgetAuthorityReference={kind:'human'|'resume';binding:ConsoleBinding;turnId:string;turnSequence:number;resume?:{requestId:string;optionId:'approve'|'deny'}};
/** A call outside any conversation. The installation owner pays for it, and only on an agent the
 * owner owns and nobody else can use; on any other agent it is refused until member jobs exist.
 * The owner id comes from the Keeper's own configuration, never from the agent. There is no
 * session, turn or admission. */
export type OwnerJobBudgetAuthorityReference={kind:'owner-job';binding:{agent:string;incarnation:string;memberId:string;agentAccessRevision:number}};
export type BudgetAuthorityReference=ConversationBudgetAuthorityReference|OwnerJobBudgetAuthorityReference;

/** Capture authority through the already-owned console source transaction. */
export async function captureBudgetAuthorityReference(db:SourceDatabase,ctx:ConsoleAuthorityContext,env:NodeJS.ProcessEnv):Promise<ConversationBudgetAuthorityReference> {
  requireSourceTransactionOwner(db);
  const own=managedIdentity(env),session=ctx.session;
  if(!own||!session?.id||typeof session.turn?.id!=='string'||(session.turn.id!==''&&!session.turn.id.trim())||!Number.isSafeInteger(session.turn.sequence)||session.turn.sequence!<0)throw new Error('Unsupported budget authority');
  const resolver=privateResumeAdmission(session.auth?.current);
  if(resolver){
    const current=await requireConsoleResume(ctx,'model',{db,env});
    return {kind:'resume',binding:current.binding,turnId:session.turn.id,turnSequence:session.turn.sequence!,resume:{requestId:resolver.requestId,optionId:resolver.optionId==='approve'?'approve':'deny'}};
  }
  await requireConsoleTurnAuthority(ctx,db,env);
  const admission=consoleAdmission(session.auth?.current)!;
  const binding=await requireConsoleSessionBinding({agent:own.name,incarnation:own.incarnation,sessionId:session.id,...admission},db,env);
  return {kind:'human',binding,turnId:session.turn.id,turnSequence:session.turn.sequence!};
}

/** Capture the owner-job authority for the installation owner the Keeper has on record. The owner
 * must be an active organisation owner who owns this agent, and no other member may be able to use
 * it: the owner pays for these calls, so a call another person could have caused is refused until
 * member jobs exist. Nothing else grants it. */
export async function captureOwnerJobAuthorityReference(db:SourceDatabase,ownerId:string,env:NodeJS.ProcessEnv):Promise<OwnerJobBudgetAuthorityReference> {
  requireSourceTransactionOwner(db);
  const own=managedIdentity(env);
  if(!own||typeof ownerId!=='string'||!/^[^\s,;\x00-\x1f\x7f]{1,256}$/.test(ownerId))throw new Error('Unsupported budget authority');
  await requireActiveOwner(db,ownerId);
  const grant=await new PgGrantStore().captureUseWithExpiry(ownerId,own.name,{db:db as unknown as import('pg').PoolClient});
  if(!grant)throw new Error('Stale grant');
  await requireOwnerOnlyAgent(db,ownerId,own.name);
  return {kind:'owner-job',binding:{agent:own.name,incarnation:own.incarnation,memberId:ownerId,agentAccessRevision:grant.accessRevision}};
}

async function requireActiveOwner(db:SourceDatabase,ownerId:string):Promise<void> {
  // The organisation gate comes first, as it does for every other authority; it also locks the member row.
  await gateConsoleOrganisation(db,ownerId,undefined,{lock:'share'});
  const owner=await db.query("SELECT 1 FROM users WHERE id=$1 AND status='active' AND org_role='owner' AND org_id IS NOT NULL",[ownerId]);
  if(owner.rows.length!==1)throw new Error('Stale authority');
}

/** The owner pays for an owner job, so the agent must be the owner's own and reach nobody else.
 * Any current grant on it, to use or to edit, held by another member, or by an organisation with
 * another active member who is not restricted, refuses the job. A missing agent row refuses too.
 * The shared lock on the agent row holds the grants and the members' roles still until the
 * transaction ends: changing either has to advance that row's revision first. A member who joins
 * afterwards does not touch that row, and is seen when this runs again as the ticket is admitted. */
async function requireOwnerOnlyAgent(db:SourceDatabase,ownerId:string,agentName:string):Promise<void> {
  const own=await db.query(`SELECT 1 FROM agent_access a WHERE a.agent_name=$2 AND a.owner_member_id=$1
    AND NOT EXISTS(SELECT 1 FROM resource_grants g WHERE g.resource_kind='agent' AND g.resource_id=a.agent_name
      AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())
      AND ((g.principal_member_id IS NOT NULL AND g.principal_member_id<>$1)
        OR (g.principal_organisation_id IS NOT NULL AND EXISTS(SELECT 1 FROM users u
          WHERE u.org_id=g.principal_organisation_id AND u.id<>$1 AND u.status='active' AND u.org_role<>'restricted'))))
    FOR SHARE OF a`,[ownerId,agentName]);
  if(own.rows.length!==1)throw new Error('Stale authority');
}

/** Revalidate persisted authority using the same owned database transaction and locks. */
export async function validateBudgetAuthorityReference(db:SourceDatabase,ref:BudgetAuthorityReference,env:NodeJS.ProcessEnv):Promise<string|null> {
  requireSourceTransactionOwner(db);
  let resumeValidUntil:string|null=null;
  const own=managedIdentity(env);
  if(!own||own.name!==ref.binding.agent||own.incarnation!==ref.binding.incarnation)throw new Error('Stale runtime');
  if(ref.kind==='resume') {
    if(!ref.resume)throw new Error('Missing resume');
    const current=await requirePersistedConsoleModelResume({binding:ref.binding,...ref.resume},{db,env});
    if(ref.resume.optionId==='approve')resumeValidUntil=current.validUntil;
  }else if(ref.kind==='human'){
    const current=await requireConsoleSessionBinding(ref.binding,db,env);
    if(payloadFingerprint('budget-binding',current)!==payloadFingerprint('budget-binding',ref.binding))throw new Error('Stale authority');
  }else if(ref.kind==='owner-job'){
    await requireActiveOwner(db,ref.binding.memberId);
  }else throw new Error('Unsupported authority');
  // This value is the PostgreSQL client already owned by the source transaction. The
  // grant store's legacy type names PoolClient's overloaded query API more narrowly.
  const grant=await new PgGrantStore().captureUseWithExpiry(ref.binding.memberId,ref.binding.agent,{expectedRevision:ref.binding.agentAccessRevision,db:db as unknown as import('pg').PoolClient});
  if(!grant)throw new Error('Stale grant');
  if(ref.kind==='owner-job')await requireOwnerOnlyAgent(db,ref.binding.memberId,ref.binding.agent);
  // All authority evidence is locked before budget locks. Only immutable time deadlines
  // cross the lock wait; the final transition compares them using the database clock.
  return (await db.query('SELECT LEAST($1::timestamptz,$2::timestamptz,$3::timestamptz)::text AS valid_until',[grant.validUntil,resumeValidUntil,await checkConsoleSourceDeadlines(db)])).rows[0].valid_until;
}
