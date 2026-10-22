import type { SourceDatabase } from './console-source-transaction.js';
import { checkConsoleSourceDeadlines, requireSourceTransactionOwner } from './console-source-transaction.js';
import { consoleAdmission, requireConsoleSessionBinding, requireConsoleTurnAuthority,
  type ConsoleAuthorityContext, type ConsoleBinding } from './console-turn-authority.js';
import { privateResolverAdmission, requirePrivateConsoleResume, requirePersistedPrivateConsoleModelResume } from './private-console-resume.js';
import { PgGrantStore } from './grant-store.js';
import { managedIdentity } from './door-authority.js';
import { payloadFingerprint } from './approval-ledger.js';

/**
 * Persisted evidence describing the console authority that created a budget intent.
 * This is not registered capability: parsing JSON never authenticates the evidence.
 */
export type BudgetAuthorityReference={kind:'human'|'resume';binding:ConsoleBinding;turnId:string;turnSequence:number;resume?:{requestId:string;optionId:'approve'|'cancel'}};

/** Capture authority through the already-owned console source transaction. */
export async function captureBudgetAuthorityReference(db:SourceDatabase,ctx:ConsoleAuthorityContext,env:NodeJS.ProcessEnv):Promise<BudgetAuthorityReference> {
  requireSourceTransactionOwner(db);
  const own=managedIdentity(env),session=ctx.session;
  if(!own||!session?.id||typeof session.turn?.id!=='string'||(session.turn.id!==''&&!session.turn.id.trim())||!Number.isSafeInteger(session.turn.sequence)||session.turn.sequence!<0)throw new Error('Unsupported budget authority');
  const resolver=privateResolverAdmission(session.auth?.current);
  if(resolver){
    const current=await requirePrivateConsoleResume(ctx,'model',{db,env});
    return {kind:'resume',binding:current.binding,turnId:session.turn.id,turnSequence:session.turn.sequence!,resume:{requestId:resolver.requestId,optionId:resolver.optionId}};
  }
  await requireConsoleTurnAuthority(ctx,db,env);
  const admission=consoleAdmission(session.auth?.current)!;
  const binding=await requireConsoleSessionBinding({agent:own.name,incarnation:own.incarnation,sessionId:session.id,...admission},db,env);
  return {kind:'human',binding,turnId:session.turn.id,turnSequence:session.turn.sequence!};
}

/** Revalidate persisted authority using the same owned database transaction and locks. */
export async function validateBudgetAuthorityReference(db:SourceDatabase,ref:BudgetAuthorityReference,env:NodeJS.ProcessEnv):Promise<string|null> {
  requireSourceTransactionOwner(db);
  let resumeValidUntil:string|null=null;
  const own=managedIdentity(env);
  if(!own||own.name!==ref.binding.agent||own.incarnation!==ref.binding.incarnation)throw new Error('Stale runtime');
  if(ref.kind==='resume') {
    if(!ref.resume)throw new Error('Missing resume');
    const current=await requirePersistedPrivateConsoleModelResume({binding:ref.binding,...ref.resume},{db,env});
    if(ref.resume.optionId==='approve')resumeValidUntil=current.validUntil;
  }else if(ref.kind==='human'){
    const current=await requireConsoleSessionBinding(ref.binding,db,env);
    if(payloadFingerprint('budget-binding',current)!==payloadFingerprint('budget-binding',ref.binding))throw new Error('Stale authority');
  }else throw new Error('Unsupported authority');
  // This value is the PostgreSQL client already owned by the source transaction. The
  // grant store's legacy type names PoolClient's overloaded query API more narrowly.
  const grant=await new PgGrantStore().captureUseWithExpiry(ref.binding.memberId,ref.binding.agent,{expectedRevision:ref.binding.agentAccessRevision,db:db as unknown as import('pg').PoolClient});
  if(!grant)throw new Error('Stale grant');
  // All authority evidence is locked before budget locks. Only immutable time deadlines
  // cross the lock wait; the final transition compares them using the database clock.
  return (await db.query('SELECT LEAST($1::timestamptz,$2::timestamptz,$3::timestamptz)::text AS valid_until',[grant.validUntil,resumeValidUntil,await checkConsoleSourceDeadlines(db)])).rows[0].valid_until;
}
