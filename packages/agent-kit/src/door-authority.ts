/** Managed-only authority. Call consumeClaim ONLY in an authored channel handler after eve
 * has verified the platform. No model/session receives a claim command, valid or otherwise. */
import {createHash} from 'node:crypto';
import {getPool} from './db.js';
export type ChatDoor='slack'|'telegram';
export interface DoorDatabase {query(sql:string,values?:unknown[]):Promise<{rows:any[]}>}
export function managedIdentity(env:NodeJS.ProcessEnv=process.env) {
  if(!env.LARES_AGENT_NAME&&!env.LARES_AGENT_INCARNATION)return null;
  if(!/^[a-z][a-z0-9-]{1,30}$/.test(env.LARES_AGENT_NAME??'')||!/^[a-f0-9-]{36}$/.test(env.LARES_AGENT_INCARNATION??''))throw new Error('Managed identity is incomplete');
  return {name:env.LARES_AGENT_NAME!,incarnation:env.LARES_AGENT_INCARNATION!};
}
export const claimHash=(code:string)=>createHash('sha256').update(code).digest('hex');
export async function currentDoor(kind:ChatDoor,db?:DoorDatabase,env:NodeJS.ProcessEnv=process.env) {
  const own=managedIdentity(env);if(!own)return null;
  const {rows}=await (db??getPool()).query(`SELECT c.*,d.enabled,r.pending,
    EXISTS(SELECT 1 FROM jsonb_array_elements(r.applied_definition->'doors') x WHERE x->>'kind'=$3 AND x->>'enabled'='true') AS applied_enabled
    FROM agent_resources r JOIN agent_definitions a ON a.name=r.name
    JOIN agent_doors d ON d.agent=r.name AND d.kind=$3
    LEFT JOIN agent_door_connections c ON c.agent=r.name AND c.kind=$3 AND c.incarnation=r.ownership_token
    WHERE r.name=$1 AND r.ownership_token=$2::uuid AND r.state='ready' AND r.runtime_control_token=r.ownership_token AND a.status='valid'`,[own.name,own.incarnation,kind]);
  const row=rows[0];if(!row||!row.enabled||!row.applied_enabled||row.pending)throw new Error('Door connection changes are pending or disabled');
  return row;
}
/** Bootstrap permits signed requests to reach the claim handler only. Token resolution and
 * model dispatch require applied authority. DB failures always throw; no stale cache. */
export async function assertDoorAuthority(kind:ChatDoor,bootstrap=false,db?:DoorDatabase,env:NodeJS.ProcessEnv=process.env):Promise<void> {
  const own=managedIdentity(env);if(!own)return;
  const row=await currentDoor(kind,db,env);
  if(bootstrap&&!row.principal&&!row.claimed_at)return;
  const revision=env[`LARES_${kind.toUpperCase()}_CLAIM_REVISION`];
  const principal=env[`LARES_${kind.toUpperCase()}_PRINCIPAL`];
  if(!row.principal||row.principal!==principal||!revision||row.revision!==revision||row.applied_revision!==revision)throw new Error('Door owner claim requires explicit reconciliation');
}
/** What a message turned out to be: `none` is not a claim at all (let it through to the normal
 * path), `ignored` is a claim-looking message that did nothing (not a private human chat, a
 * wrong or expired code, an already claimed door), `claimed` is the one that connected the owner.
 * Callers answer `ignored` and `claimed` with a fixed line; nothing distinguishes the reasons
 * an `ignored` claim failed, so a stranger learns nothing about the installation. */
export type ClaimOutcome='none'|'ignored'|'claimed';
export async function consumeClaim(kind:ChatDoor,text:string,sender:string,privateHuman:boolean,db?:DoorDatabase,env:NodeJS.ProcessEnv=process.env):Promise<boolean> {
  return (await tryClaim(kind,text,sender,privateHuman,db,env))!=='none';
}
export async function tryClaim(kind:ChatDoor,text:string,sender:string,privateHuman:boolean,db?:DoorDatabase,env:NodeJS.ProcessEnv=process.env):Promise<ClaimOutcome> {
  const own=managedIdentity(env);if(!own)return 'none';
  // Treat every claim-looking message as control input. Never leak invalid codes to history.
  // Slack reserves slash commands before a message reaches the bot. Plain `claim`
  // works in ordinary private messages; retain /claim for existing clients.
  // Telegram's "Tap to connect" link opens the chat with `/start <code>`; that is the same claim.
  const startLink=kind==='telegram'?/^\/start(?:@\w+)? ([A-Z0-9]{24})$/.exec(text.trim()):null;
  if(!startLink&&!/^\/?claim(?:\s|$)/i.test(text.trimStart()))return 'none';
  if(!privateHuman||!sender||sender.length>128)return 'ignored';
  const match=startLink??/^\/?claim ([A-Z0-9]{24})$/.exec(text.trim());
  const hash=claimHash(match?.[1]??'invalid');
  // Single SQL statement acquires the row lock; counter and consumption are atomic. Recheck
  // current incarnation/enabled state in this same statement, including concurrent slug reuse.
  const result=await (db??getPool()).query(`WITH gate AS (SELECT pg_advisory_xact_lock(1279349317,12)), attempted AS (
    UPDATE agent_door_connections c SET attempts=c.attempts+1,
      principal=CASE WHEN c.code_hash=$4 AND c.expires_at>now() THEN $5 ELSE NULL END,
      claimed_at=CASE WHEN c.code_hash=$4 AND c.expires_at>now() THEN now() ELSE NULL END,
      code_hash=CASE WHEN c.code_hash=$4 AND c.expires_at>now() THEN NULL ELSE c.code_hash END
    FROM agent_resources r,agent_doors d,gate
    WHERE c.agent=$1 AND c.kind=$3 AND c.incarnation=$2::uuid AND c.principal IS NULL AND c.attempts<10
      AND r.name=c.agent AND r.ownership_token=c.incarnation AND r.state='ready' AND r.runtime_control_token=r.ownership_token AND NOT r.pending
      AND d.agent=c.agent AND d.kind=c.kind AND d.enabled=true
    RETURNING c.principal
  ), recorded AS (
    INSERT INTO agent_door_claim_audit(agent,kind,incarnation,principal)
    SELECT $1,$3,$2::uuid,principal FROM attempted WHERE principal IS NOT NULL
  ) UPDATE agent_resources SET pending=true,pending_reason='Owner claimed door; apply connection changes (restarts agent)',updated_at=now()
    WHERE name=$1 AND ownership_token=$2::uuid AND EXISTS(SELECT 1 FROM attempted WHERE principal IS NOT NULL) RETURNING name`,[own.name,own.incarnation,kind,hash,sender]);
  return result.rows?.length?'claimed':'ignored';
}
/** Every managed gated-tool approval consult rechecks the resource, even a continuation
 * resumed through eve's authenticated HTTP API rather than a native chat callback. */
/** The authenticator the agent's own HTTP door stamps on a session the console vouched for
 * (`CONSOLE_AUTHENTICATOR` in each role's `lib/principals.ts`; a test keeps them equal). */
export const CONSOLE_SESSION_AUTHENTICATOR='lares-console';
export const NO_OWNER_CONNECTION='An applied owner connection is required';
interface SessionAuthShape {current?:{authenticator?:string}|null;initiator?:{authenticator?:string}|null}
/** True only for a session the signed-in console opened, and not currently resumed by another door. */
export function isConsoleSession(auth?:SessionAuthShape|null):boolean {
 if(auth?.initiator?.authenticator!==CONSOLE_SESSION_AUTHENTICATOR)return false;
 return !auth.current||auth.current.authenticator===CONSOLE_SESSION_AUTHENTICATOR;
}
export async function assertManagedRuntimeCurrent(db?:DoorDatabase,env:NodeJS.ProcessEnv=process.env,sessionAuth?:SessionAuthShape|null):Promise<void> {
 const own=managedIdentity(env);if(!own)return;
 const database=db??getPool();
 const {rows}=await database.query(`SELECT 1 FROM agent_resources r JOIN agent_definitions a ON a.name=r.name
   WHERE r.name=$1 AND r.ownership_token=$2::uuid AND r.runtime_control_token=r.ownership_token AND r.state='ready' AND NOT r.pending AND a.status='valid'`,[own.name,own.incarnation]);
 if(!rows.length)throw new Error('Managed runtime authority changed');
 const claims=(await database.query(`SELECT kind,principal,revision,applied_revision FROM agent_door_connections WHERE agent=$1 AND incarnation=$2::uuid AND principal IS NOT NULL`,[own.name,own.incarnation])).rows;
 for(const kind of ['slack','telegram','email']) {
  const revision=env[`LARES_${kind.toUpperCase()}_CLAIM_REVISION`];
  if(!revision)continue;
  const c=claims.find(c=>c.kind===kind);
  if(!c||c.revision!==revision||c.applied_revision!==revision||c.principal!==env[`LARES_${kind.toUpperCase()}_PRINCIPAL`])throw new Error('Managed claim authority changed');
 }
 if(claims.some(c=>env[`LARES_${c.kind.toUpperCase()}_CLAIM_REVISION`]===c.revision))return;
 // A fresh installation has no chat door claimed. Only then may the console's own signed-in
 // web chat stand in; the tool still checks the named member against its approver list. Any
 // claimed door (even one not yet applied) keeps the strict rule above.
 if(!claims.length&&isConsoleSession(sessionAuth))return;
 throw new Error(NO_OWNER_CONNECTION);
}
