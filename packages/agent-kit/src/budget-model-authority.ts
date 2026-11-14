import type { SourceDatabase } from './console-source-transaction.js';
import { checkConsoleSourceDeadlines, gateConsoleOrganisation, requireSourceTransactionOwner } from './console-source-transaction.js';
import { consoleAdmission, requireConsoleSessionBinding, requireConsoleTurnAuthority,
  type ConsoleAuthorityContext, type ConsoleBinding } from './console-turn-authority.js';
import { privateResumeAdmission, requirePersistedConsoleModelResume } from './private-console-resume.js';
import { PgGrantStore } from './grant-store.js';
import { currentDoor, managedIdentity, type ChatDoor } from './door-authority.js';
import { payloadFingerprint } from './approval-ledger.js';
import { ownerOnlyAgentStatement } from './owner-only-agent.js';

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
/** A turn that came through a chat door (Slack or Telegram). The member who pays is the one behind
 * the applied door claim; Keeper finds it from its own configuration and the claim row, never from
 * the agent. `principal` and `claimRevision` are the claim as it stood when the turn opened, and
 * every later check requires the claim to still be exactly that. */
export type DoorBudgetAuthorityReference={kind:'door';
  binding:{agent:string;incarnation:string;sessionId:string;memberId:string;agentAccessRevision:number;door:ChatDoor;principal:string;claimRevision:string};
  turnId:string;turnSequence:number};
export type BudgetAuthorityReference=ConversationBudgetAuthorityReference|OwnerJobBudgetAuthorityReference|DoorBudgetAuthorityReference;
/** What the agent may say when it opens a door turn. It names the door and the claim it speaks
 * under, never a member, an address or a payer. */
export type DoorTurnRequest={door:ChatDoor;principal:string;claimRevision:string;sessionId:string;turnId:string;sequence:number};

/** What Keeper itself admitted for the receipt that opens this turn: a person's message (`human`),
 * or the answer to one card (`resume`, naming the card and the option). */
export type AdmittedPurpose={purpose:'human'|'resume';resume?:{requestId:string;optionId:'approve'|'deny'}};

/** Capture authority through the already-owned console source transaction.
 *
 * eve 1.0 continues a paused turn as the person who ASKED, so `session.auth.current` is always that
 * person's human admission, also in the turn after an answered card. Whether this turn answers a
 * card is never read from the session: only the receipt Keeper admitted says so (`admitted`), and
 * then the card must be settled for that same member (an Approve approved by them; a Deny cancelled,
 * ignored or invalid). A resolver identity on `current` is refused outright. Without `admitted`
 * (the budget store's own captures) the turn is a human turn. */
export async function captureBudgetAuthorityReference(db:SourceDatabase,ctx:ConsoleAuthorityContext,env:NodeJS.ProcessEnv,admitted?:AdmittedPurpose):Promise<ConversationBudgetAuthorityReference> {
  requireSourceTransactionOwner(db);
  const own=managedIdentity(env),session=ctx.session;
  if(!own||!session?.id||typeof session.turn?.id!=='string'||!session.turn.id.trim()||!Number.isSafeInteger(session.turn.sequence)||session.turn.sequence!<0)throw new Error('Unsupported budget authority');
  if(privateResumeAdmission(session.auth?.current))throw new Error('Unsupported budget authority');
  const admission=consoleAdmission(session.auth?.current),initial=consoleAdmission(session.auth?.initiator);
  if(admitted?.purpose==='resume'){
    const resume=admitted.resume;
    if(!resume||!resume.requestId||(resume.optionId!=='approve'&&resume.optionId!=='deny')||!admission||admission.purpose!=='human'||
      !initial||initial.purpose!=='human'||initial.memberId!==admission.memberId||initial.admissionNonce!==admission.admissionNonce)throw new Error('Unsupported budget authority');
    const current=await requirePersistedConsoleModelResume({binding:{agent:own.name,incarnation:own.incarnation,sessionId:session.id,memberId:admission.memberId,admissionNonce:admission.admissionNonce},
      requestId:resume.requestId,optionId:resume.optionId},{db,env});
    return {kind:'resume',binding:current.binding,turnId:session.turn.id,turnSequence:session.turn.sequence!,resume:{requestId:resume.requestId,optionId:resume.optionId}};
  }
  if(admitted!==undefined&&admitted.purpose!=='human')throw new Error('Unsupported budget authority');
  await requireConsoleTurnAuthority(ctx,db,env);
  const binding=await requireConsoleSessionBinding({agent:own.name,incarnation:own.incarnation,sessionId:session.id,...admission!},db,env);
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

const MEMBER_ID=/^[^\s,;\x00-\x1f\x7f]{1,256}$/;
function validDoorTurnRequest(input:DoorTurnRequest):boolean {
  return !!input&&(input.door==='slack'||input.door==='telegram')&&
    typeof input.principal==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(input.principal)&&
    typeof input.claimRevision==='string'&&/^[a-f0-9-]{36}$/.test(input.claimRevision)&&
    typeof input.sessionId==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(input.sessionId)&&
    typeof input.turnId==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(input.turnId)&&
    Number.isSafeInteger(input.sequence)&&input.sequence>=0;
}

/** Capture the authority for one turn that came through a chat door. The payer is `ownerId`, the
 * owner in Keeper's own configuration (never a value from the agent). The door must be enabled and
 * applied on this very runtime, which must be ready and current; the claim on it must be exactly
 * the principal and revision the agent names, applied; the payer must be an active owner of an
 * organisation, hold a current use grant on the agent, and be the member who issued the claim.
 *
 * The claim row records who issued it only as an address (`owner_email`, the console owner's
 * `primary_email`). That address is a consistency check, never a lookup: the payer is not found by
 * it, so an address that changed hands is refused rather than charged to its new holder. Today only
 * the designated owner can issue a claim. Once other members claim doors, the claim row needs the
 * claimer's member id (a migration), and this check switches to it. The budget binding is not
 * checked here: this runs on the application login, which cannot read budget tables; the binding
 * is checked when a step is consumed. */
export async function captureDoorBudgetAuthorityReference(db:SourceDatabase,input:DoorTurnRequest,ownerId:string|undefined,env:NodeJS.ProcessEnv):Promise<DoorBudgetAuthorityReference> {
  requireSourceTransactionOwner(db);
  const own=managedIdentity(env);
  if(!own||!validDoorTurnRequest(input)||typeof ownerId!=='string'||!MEMBER_ID.test(ownerId))throw new Error('Unsupported budget authority');
  await requireDoorClaim(db,{door:input.door,principal:input.principal,claimRevision:input.claimRevision,memberId:ownerId},env);
  const grant=await new PgGrantStore().captureUseWithExpiry(ownerId,own.name,{db:db as unknown as import('pg').PoolClient});
  if(!grant)throw new Error('Stale grant');
  return {kind:'door',binding:{agent:own.name,incarnation:own.incarnation,sessionId:input.sessionId,memberId:ownerId,agentAccessRevision:grant.accessRevision,
    door:input.door,principal:input.principal,claimRevision:input.claimRevision},turnId:input.turnId,turnSequence:input.sequence};
}

/** The applied door claim is still exactly this one, and its payer is still an active owner of an
 * organisation whose current address is the one the claim was issued by (compared trimmed and
 * case-insensitively). The organisation gate comes first, as for every other authority. */
async function requireDoorClaim(db:SourceDatabase,claim:{door:ChatDoor;principal:string;claimRevision:string;memberId:string},env:NodeJS.ProcessEnv):Promise<void> {
  if(claim.door!=='slack'&&claim.door!=='telegram')throw new Error('Unsupported authority');
  await gateConsoleOrganisation(db,claim.memberId,undefined,{lock:'share'});
  const row=await currentDoor(claim.door,db,env);
  if(!row||typeof row.principal!=='string'||row.principal!==claim.principal||row.revision!==claim.claimRevision||row.applied_revision!==claim.claimRevision||
    typeof row.owner_email!=='string')throw new Error('Stale authority');
  // The same owner rule as owner jobs (`requireActiveOwner`): a demoted owner no longer pays.
  const payer=await db.query(`SELECT 1 FROM users WHERE id=$1 AND status='active' AND org_role='owner' AND org_id IS NOT NULL AND primary_email IS NOT NULL
    AND lower(btrim(primary_email))=lower(btrim($2))`,[claim.memberId,row.owner_email]);
  if(payer.rows.length!==1)throw new Error('Stale authority');
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
  const own=await db.query(ownerOnlyAgentStatement('share'),[ownerId,agentName]);
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
  }else if(ref.kind==='door'){
    await requireDoorClaim(db,{door:ref.binding.door,principal:ref.binding.principal,claimRevision:ref.binding.claimRevision,memberId:ref.binding.memberId},env);
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
