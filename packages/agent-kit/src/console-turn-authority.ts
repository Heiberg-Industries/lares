import {currentMember} from './member-store.js';
import {verifiedPrivateConsoleResponse} from './private-console-envelope.js';
import {personalActionForRequest} from './personal-action-store.js';
/** Trusted server admission only. No model-facing input can supply these coordinates.
 * This bounded runtime supports explicitly authorised members in singleton private console audiences.
 * Native channels and approval resumes do not inherit this authority.
 */
import { getPool } from './db.js';
import { PgGrantStore, type GrantDatabase } from './grant-store.js';
import { managedIdentity, CONSOLE_SESSION_AUTHENTICATOR } from './door-authority.js';
import { turnAuthoritySchema, type TurnAuthority } from './authority-contract.js';

export const CONSOLE_MEMBER_ID_HEADER = 'x-lares-member-id';
export const CONSOLE_ADMISSION_HEADER = 'x-lares-admission';
export const CONSOLE_PURPOSE_HEADER = 'x-lares-purpose';
/** Version of this private console admission contract, not the permission board policy. */
export const CONSOLE_AUTHORITY_REVISION = 1;
/** Only fresh sessions created by the bounded runtime can carry this capture. */
export const PRIVATE_CONSOLE_SURFACE_REVISION = 2;
export const CONSOLE_AUTHORITY_REFUSED = 'Conversation authority is not available';
/** A pool supplies connect; a query-only client belongs to an already-open caller transaction. */
export interface AuthorityDatabase { query(sql: string, values?: unknown[]): Promise<{ rows: any[] }> }
export interface AuthorityPool extends AuthorityDatabase { connect(): Promise<AuthorityDatabase & {release():void}> }
export async function authorityTransaction<T>(database:AuthorityDatabase|undefined,fn:(db:AuthorityDatabase)=>Promise<T>):Promise<T> {
  const source=database ?? getPool();
  // A checked-out pg client may also expose connect at runtime; never acquire or BEGIN again.
  if(!('connect' in source) || 'release' in source)return fn(source);
  const db=await (source as AuthorityPool).connect();
  try {await db.query('BEGIN');const result=await fn(db);await db.query('COMMIT');return result;}
  catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
export interface ConsoleBindingInput { agent: string; incarnation: string; sessionId: string; memberId: string; admissionNonce: string }
export interface ConsoleBinding extends ConsoleBindingInput { placeId: string; audienceRevision: number; policyRevision: number; agentAccessRevision: number }
export interface ConsoleAuthorityContext { session?: { id?: string; turn?: { id?: string; sequence?: number }; auth?: { current?: unknown; initiator?: unknown } | null } }
type Purpose = 'human' | 'resolver' | 'read' | 'control' | 'legacy-resolver' | 'legacy-read';
interface Admission { memberId: string; admissionNonce: string; purpose: Purpose }
const denied = (): never => { throw new Error(CONSOLE_AUTHORITY_REFUSED); };
async function authorityQuery(db: AuthorityDatabase | undefined, sql: string, values: unknown[]): Promise<{rows:any[]}> {
  try { return await (db ?? getPool()).query(sql,values); } catch { return denied(); }
}
const validMember = (id: unknown): id is string => typeof id === 'string' && /^[^\s,;\x00-\x1f\x7f]{1,256}$/.test(id);
const validNonce = (nonce: unknown): nonce is string => typeof nonce === 'string' && /^[A-Za-z0-9_-]{43}$/.test(nonce);
const purposes: readonly string[] = ['human','resolver','read','control','legacy-resolver','legacy-read'];
export function consoleAdmission(auth: unknown): Admission | undefined {
  const a = auth as { authenticator?: string; attributes?: Record<string, unknown> } | undefined;
  const attrs = a?.attributes;
  if (a?.authenticator !== CONSOLE_SESSION_AUTHENTICATOR || !attrs || !validMember(attrs.lares_member_id) ||
      !validNonce(attrs.lares_admission_nonce) || !purposes.includes(String(attrs.lares_purpose))) return undefined;
  return { memberId: attrs.lares_member_id, admissionNonce: attrs.lares_admission_nonce, purpose: attrs.lares_purpose as Purpose };
}
/** Tagged callers must never fall through to legacy owner or alias resolution. */
export function hasConsoleTurnAuthorityTag(ctx: unknown): boolean {
  const auth = (ctx as ConsoleAuthorityContext | undefined)?.session?.auth;
  return [auth?.current,auth?.initiator].some(a => {
    const attrs = (a as {attributes?:Record<string,unknown>} | undefined)?.attributes;
    return !!attrs && ('lares_member_id' in attrs || 'lares_admission_nonce' in attrs);
  });
}
export function consoleResolverOnly(auth: unknown): boolean {
  return (auth as {attributes?:Record<string,unknown>} | undefined)?.attributes?.lares_purpose !== undefined &&
    (auth as {attributes:Record<string,unknown>}).attributes.lares_purpose !== 'human';
}
function coordinates(input: ConsoleBindingInput): void {
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(input.agent) || !/^[a-f0-9-]{36}$/.test(input.incarnation) ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(input.sessionId) || !validMember(input.memberId) || !validNonce(input.admissionNonce)) denied();
}
function binding(row: any): ConsoleBinding {
  return { agent: row.agent, incarnation: row.incarnation, sessionId: row.session_id, memberId: row.member_id,
    admissionNonce: row.admission_nonce, placeId: row.place_id, audienceRevision: row.audience_revision, policyRevision: row.policy_revision, agentAccessRevision: Number(row.agent_access_revision) };
}
/** The common grant store verifies current membership, owner policy, definition and use. */
async function currentAgentUse(db:AuthorityDatabase,agent:string,memberId:string,_env:NodeJS.ProcessEnv):Promise<number> {
  const revision=await new PgGrantStore().captureUse(memberId,agent,{db:db as GrantDatabase});
  if(revision===undefined)denied();
  return revision!;
}
/** Runs before registry, route-password or upstream access; returns no resource metadata. */
export async function requireConsoleAgentUse(agent:string,memberId:string,db?:AuthorityDatabase,env:NodeJS.ProcessEnv=process.env):Promise<void> {
  try {await authorityTransaction(db,async client=>{await currentAgentUse(client,agent,memberId,env);});}catch{denied();}
}
async function runtimeGate(db:AuthorityDatabase,input:Pick<ConsoleBindingInput,'agent'|'incarnation'>):Promise<void> {
  const {rows}=await authorityQuery(db,`SELECT 1 FROM agent_resources r WHERE r.name=$1 AND r.ownership_token=$2::uuid
    AND r.runtime_control_token=r.ownership_token AND r.state='ready' AND NOT r.pending FOR SHARE`,[input.agent,input.incarnation]);
  if(rows.length!==1)denied();
}
export async function bindConsoleSession(input: ConsoleBindingInput, db: AuthorityDatabase | undefined = undefined, env: NodeJS.ProcessEnv = process.env): Promise<ConsoleBinding> {
  coordinates(input);
  try{return await authorityTransaction(db,async client=>{
    const revision=await currentAgentUse(client,input.agent,input.memberId,env);
    await runtimeGate(client,input);
    const placeId=`console:${input.agent}:${input.incarnation}:${input.sessionId}`;
    const {rows}=await authorityQuery(client,`INSERT INTO console_session_bindings(agent,incarnation,session_id,member_id,admission_nonce,place_id,agent_access_revision,private_surface_revision)
      VALUES($1,$2::uuid,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(agent,incarnation,session_id) DO UPDATE SET revoked_at=console_session_bindings.revoked_at
      WHERE console_session_bindings.member_id=EXCLUDED.member_id AND console_session_bindings.admission_nonce=EXCLUDED.admission_nonce
        AND console_session_bindings.place_id=EXCLUDED.place_id AND console_session_bindings.agent_access_revision=EXCLUDED.agent_access_revision
        AND console_session_bindings.private_surface_revision=EXCLUDED.private_surface_revision
        AND console_session_bindings.revoked_at IS NULL RETURNING *`,[input.agent,input.incarnation,input.sessionId,input.memberId,input.admissionNonce,placeId,revision,PRIVATE_CONSOLE_SURFACE_REVISION]);
    if(rows.length!==1)denied();await currentAgentUse(client,input.agent,input.memberId,env);return binding(rows[0]);
  });}catch{ return denied(); }
}
export async function requireConsoleSessionBinding(input: Omit<ConsoleBindingInput,'admissionNonce'> & { admissionNonce?: string }, db: AuthorityDatabase | undefined = undefined, env: NodeJS.ProcessEnv = process.env): Promise<ConsoleBinding> {
  try{return await authorityTransaction(db,async client=>{
    const revision=await currentAgentUse(client,input.agent,input.memberId,env);
    await runtimeGate(client,input);
    const {rows}=await authorityQuery(client,`SELECT b.* FROM console_session_bindings b WHERE b.agent=$1 AND b.incarnation=$2::uuid AND b.session_id=$3
      AND b.member_id=$4 AND ($5::text IS NULL OR b.admission_nonce=$5) AND b.revoked_at IS NULL AND b.audience_revision=1 AND b.policy_revision=1
      AND b.agent_access_revision=$6 AND b.private_surface_revision=$7 FOR SHARE`,[input.agent,input.incarnation,input.sessionId,input.memberId,input.admissionNonce??null,revision,PRIVATE_CONSOLE_SURFACE_REVISION]);
    if(rows.length!==1)denied();await currentAgentUse(client,input.agent,input.memberId,env);const result=binding(rows[0]);coordinates(result);return result;
  });}catch{return denied();}
}
export async function retireConsoleSession(input: ConsoleBindingInput, db: AuthorityDatabase | undefined = undefined, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await authorityTransaction(db,async client=>{
    await requireConsoleSessionBinding(input,client,env);
    await authorityQuery(client,'UPDATE console_session_bindings SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE agent=$1 AND incarnation=$2::uuid AND session_id=$3 AND member_id=$4 AND admission_nonce=$5', [input.agent,input.incarnation,input.sessionId,input.memberId,input.admissionNonce]);
  });
}
export async function bindConsoleSessionStarted(ctx: ConsoleAuthorityContext, db?: AuthorityDatabase, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!hasConsoleTurnAuthorityTag(ctx)) return;
  const admission = consoleAdmission(ctx.session?.auth?.current);
  const own = managedIdentity(env);
  if (!admission || admission.purpose !== 'human' || !own || !ctx.session?.id) denied();
  await bindConsoleSession({agent:own!.name,incarnation:own!.incarnation,sessionId:ctx.session!.id!,...admission!},db,env);
}
export async function requireConsoleTurnAuthority(ctx: ConsoleAuthorityContext, db: AuthorityDatabase | undefined = undefined, env: NodeJS.ProcessEnv = process.env): Promise<Extract<TurnAuthority,{origin:'human'}>> {
  const admission = consoleAdmission(ctx.session?.auth?.current), initial = consoleAdmission(ctx.session?.auth?.initiator);
  const own = managedIdentity(env), session = ctx.session;
  if (!admission || admission.purpose !== 'human' || !initial || initial.purpose !== 'human' ||
      initial.memberId !== admission.memberId || initial.admissionNonce !== admission.admissionNonce ||
      !own || !session?.id || !session.turn?.id || !Number.isSafeInteger(session.turn.sequence) || session.turn.sequence! < 0) denied();
  const b = await requireConsoleSessionBinding({agent:own!.name,incarnation:own!.incarnation,sessionId:session!.id!,...admission!},db,env);
  return turnAuthoritySchema.parse({origin:'human',agentId:b.agent,sessionId:b.sessionId,turnId:session!.turn!.id,
    actingMemberId:b.memberId,spokenByMemberId:b.memberId,placeId:b.placeId,
    audience:{placeId:b.placeId,revision:b.audienceRevision,participants:[{kind:'member',memberId:b.memberId}]},policyRevision:b.policyRevision}) as Extract<TurnAuthority,{origin:'human'}>;
}
/** All callbacks, including approval policy callbacks, check before they may read anything. */
export async function guardConsoleToolContext(ctx: unknown): Promise<void> {
  if (hasConsoleTurnAuthorityTag(ctx)) await requireConsoleTurnAuthority(ctx as ConsoleAuthorityContext);
}
/** Called only after the route password is verified. Control/stream and approval-only routes
 * skip onMessage, so the binding check belongs here, not only in the message hook. */
export async function consoleRouteAdmission(request: Request, db?: AuthorityDatabase, env: NodeJS.ProcessEnv = process.env): Promise<Record<string,string> | undefined> {
  const own = managedIdentity(env);
  const sessionId = /\/eve\/v1\/session\/([A-Za-z0-9_-]{1,64})(?:\/|$)/.exec(new URL(request.url).pathname)?.[1];
  const memberId = request.headers.get(CONSOLE_MEMBER_ID_HEADER), nonce = request.headers.get(CONSOLE_ADMISSION_HEADER), purpose = request.headers.get(CONSOLE_PURPOSE_HEADER);
  if (!memberId && !nonce && !purpose) {
    if (own && sessionId) {
      const {rows} = await authorityQuery(db,'SELECT 1 FROM console_session_bindings WHERE agent=$1 AND incarnation=$2::uuid AND session_id=$3',[own.name,own.incarnation,sessionId]);
      if (rows.length) denied();
    }
    return undefined;
  }
  if (!own || !validMember(memberId) || !validNonce(nonce) || !purpose || !purposes.includes(purpose)) denied();
  const tuple = {agent:own!.name,incarnation:own!.incarnation,sessionId:sessionId ?? '',memberId:memberId!,admissionNonce:nonce!};
  if (purpose!.startsWith('legacy-')) {
    if (!sessionId) denied();
    const { rows } = await authorityQuery(db,`SELECT u.id FROM users u WHERE u.id=$1 AND u.id=$2 AND u.status='active' AND u.org_role='owner'
      AND NOT EXISTS(SELECT 1 FROM console_session_bindings WHERE agent=$3 AND incarnation=$4::uuid AND session_id=$5)`,[memberId,env.AGENT_OWNER_USER_ID?.trim() ?? '',own!.name,own!.incarnation,sessionId]);
    if (rows.length !== 1) denied();
  } else if (sessionId) {
    await requireConsoleSessionBinding(tuple,db,env);
    // A reset irrevocably retires authority even if the framework then fails to reset.
    if (new URL(request.url).pathname.endsWith('/reset')) await retireConsoleSession(tuple,db,env);
  } else if (new URL(request.url).pathname.endsWith('/eve/v1/session') && request.method === 'POST' && purpose === 'human') {
    // Message-free creation cannot bind yet: the proxy will bind its returned session id.
    await authorityTransaction(db,async client=>{
      await currentAgentUse(client,own!.name,memberId!,env);
      await runtimeGate(client,{agent:own!.name,incarnation:own!.incarnation});
    });
  } else denied();
  if (request.method === 'POST' && /\/session(?:\/[^/]+)?$/.test(new URL(request.url).pathname)) {
    const rawBody = await request.clone().text();
    const body = (rawBody ? JSON.parse(rawBody) : {}) as {message?:unknown;inputResponses?:unknown};
    if (body.message !== undefined && body.inputResponses !== undefined) denied();
    const expected = body.inputResponses !== undefined ? (purpose!.startsWith('legacy-') ? 'legacy-resolver' : 'resolver') : 'human';
    if (purpose !== expected) denied();
  }
  if(purpose==='resolver'){
    const answer=verifiedPrivateConsoleResponse(request);
    await authorityTransaction(db,async client=>{
      const member=await currentMember(client as never,memberId!);if(!member)denied();
      await client.query('SELECT id FROM orgs WHERE id=$1 FOR SHARE',[member!.organisationId]);
      const locked=await currentMember(client as never,memberId!,{lock:'share'});if(!locked||locked.organisationId!==member!.organisationId)denied();
      const current=await personalActionForRequest(client,{requestId:answer.requestId,memberId:memberId!,agentId:own!.name,sessionId:sessionId!});
      if(current.reference.selection.incarnation!==own!.incarnation||(answer.optionId==='approve'&&!current.alive))denied();
      await requireConsoleSessionBinding(tuple,client,env);
    });
    return {lares_resolver_member_id:memberId!,lares_purpose:'resolver',lares_resume_request_id:answer.requestId,lares_resume_option:answer.optionId};
  }
  return purpose!.startsWith('legacy-')
    ? {lares_resolver_member_id:memberId!,lares_purpose:purpose!}
    : {lares_member_id:memberId!,lares_admission_nonce:nonce!,lares_purpose:purpose!};
}
