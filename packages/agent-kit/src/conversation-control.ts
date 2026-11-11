// Public eve hook/route seam; no workflow table access and no address-based end.
import { hasConsoleTurnAuthorityTag } from './console-turn-authority.js';
import { getPool } from './db.js';
type Database = { query(sql:string, values?:unknown[]):Promise<{rows:Record<string,unknown>[]}> };
interface Context { session:{id:string;parent?:unknown;auth?:{initiator?:{principalId?:string;principalType?:string}|null}};channel:{kind?:string} }
/** The slice of an eve 1.0 session event this projection reads. Event types are an open set: an
 * unknown one is ignored. `interaction.opened` carries the request's kind in `data.request.kind`. */
interface ConversationEvent { type:string; data?:unknown }
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function identity(env:NodeJS.ProcessEnv) {
  const name=env.LARES_AGENT_NAME,incarnation=env.LARES_AGENT_INCARNATION;
  if(!name||!/^[a-z][a-z0-9-]{1,30}$/.test(name)||!incarnation||!UUID.test(incarnation)) return null;
  return {name,incarnation};
}
// eve 1.0 events: a session starts at `session.started`; each finished request is a
// `delivery.settled`; a person is asked at `interaction.opened`; a conversation is over at
// `session.ended` (it also stands for what 0.60 called completed, failed and reset). Everything
// else, including event types a later eve adds, changes nothing here.
const LIFECYCLE=['session.started','delivery.settled','interaction.opened','session.ended'];
const TERMINAL=['session.ended'];
/** A sign-in is not something the owner approves; every other request kind is a person being asked. */
function asksAPerson(event:ConversationEvent):boolean {
  if(event.type!=='interaction.opened')return false;
  const kind=((event.data as {request?:{kind?:unknown}}|undefined)?.request)?.kind;
  return typeof kind==='string'&&kind!=='sign-in';
}
/** The default eve channel is `channel:eve` in 1.0 (it was `http`); the stored label stays `http`. */
const DOOR_LABEL:Record<string,string>={slack:'slack',telegram:'telegram',eve:'http',http:'http'};
export async function observeConversation(event:ConversationEvent,ctx:Context,db?:Database,env:NodeJS.ProcessEnv=process.env):Promise<void> {
  if (hasConsoleTurnAuthorityTag(ctx)) return;
  const kind = ctx.channel?.kind?.replace(/^channel:/, '');
  const door = kind!==undefined&&Object.hasOwn(DOOR_LABEL,kind)?DOOR_LABEL[kind]:undefined;
  const own=identity(env);if(!own||ctx.session.parent||door===undefined)return;
  const terminal=TERMINAL.includes(event.type);
  // A session a schedule opened (the app, not a person) is not a conversation until it asks the
  // owner something. From its first `interaction.opened` it is one: the console's "Waiting on you"
  // page finds pending approvals through this projection, and a schedule's approval card (a
  // meeting follow-up mail, a brief's proposal) is exactly the kind it must not miss. Before that
  // it is never written; after it, only its end is recorded, on the row it already has (an UPDATE
  // that matches nothing for the many schedule sessions that never asked, and only on the rare
  // terminal event, so a schedule ticking every few minutes costs no extra writes).
  const initiator=ctx.session.auth?.initiator;
  if(initiator?.principalType==='runtime'||initiator?.principalId==='eve:app'){
    if(asksAPerson(event)) return upsert(own,ctx.session.id,door,false,db);
    if(!terminal)return;
    try {
      await (db??getPool()).query(`UPDATE agent_conversations SET observed_at=now(),terminal=terminal OR $4
        WHERE agent=$1 AND incarnation=$2::uuid AND session_id=$3
        AND NOT EXISTS(SELECT 1 FROM console_session_bindings b WHERE b.agent=$1 AND b.incarnation=$2::uuid AND b.session_id=$3)`,[own.name,own.incarnation,ctx.session.id,terminal]);
    } catch { console.warn('[conversations] projection unavailable'); }
    return;
  }
  if(!LIFECYCLE.includes(event.type))return;
  if(event.type==='interaction.opened'&&!asksAPerson(event))return;
  return upsert(own,ctx.session.id,door,terminal,db);
}
async function upsert(own:{name:string;incarnation:string},sessionId:string,door:string,terminal:boolean,db?:Database):Promise<void> {
  try {
    await (db??getPool()).query(`INSERT INTO agent_conversations(agent,incarnation,session_id,door,terminal)
      SELECT $1,$2::uuid,$3,$4,$5 WHERE EXISTS(SELECT 1 FROM agent_resources WHERE name=$1 AND ownership_token=$2::uuid AND runtime_control_token=ownership_token AND state='ready')
      AND NOT EXISTS(SELECT 1 FROM console_session_bindings b WHERE b.agent=$1 AND b.incarnation=$2::uuid AND b.session_id=$3)
      ON CONFLICT(agent,incarnation,session_id) DO UPDATE SET observed_at=now(),terminal=agent_conversations.terminal OR EXCLUDED.terminal`,[own.name,own.incarnation,sessionId,door,terminal]);
    await (db??getPool()).query(`DELETE FROM agent_conversations WHERE agent=$1 AND incarnation=$2::uuid AND session_id IN (SELECT session_id FROM agent_conversations WHERE agent=$1 AND incarnation=$2::uuid ORDER BY observed_at DESC OFFSET 500)`,[own.name,own.incarnation]);
  } catch { console.warn('[conversations] projection unavailable'); }
}
export interface ResetInput {sessionId:string;incarnation:string;confirm:boolean}
/** The part of eve 1.0's session handle used here. `end()` resolves with a delivery receipt as soon as
 * the server accepts the request; the receipt's `result()` says whether the session did end. */
export interface ResetHandle {end(input:{reason:string}):Promise<{result():Promise<{sessionEnded:boolean}>}>}
/** How long to wait for the end to be confirmed before reporting it as unconfirmed. */
const END_CONFIRM_MS=15_000;
/** `session_not_active` (eve answers 409 for an ended or unknown session): nothing is left to end. */
function notActive(error:unknown):boolean {
  return typeof error==='object'&&error!==null&&(error as {code?:unknown}).code==='session_not_active';
}
export async function resetConversation(input:ResetInput,attach:(id:string)=>ResetHandle,db:Database=getPool(),env:NodeJS.ProcessEnv=process.env) {
  const own=identity(env);
  if(!own||input.incarnation!==own.incarnation) throw new Error('Runtime incarnation mismatch');
  if(input.confirm!==true||!/^wrun_[A-Za-z0-9_-]{1,200}$/.test(input.sessionId))throw new Error('Confirmed exact session required');
  const {rows}=await db.query(`SELECT c.session_id FROM agent_conversations c JOIN agent_resources r ON r.name=c.agent AND r.ownership_token=c.incarnation
    WHERE c.agent=$1 AND c.incarnation=$2::uuid AND c.session_id=$3 AND r.runtime_control_token=r.ownership_token AND NOT r.pending AND r.state='ready'
    AND NOT EXISTS(SELECT 1 FROM console_session_bindings b WHERE b.agent=c.agent AND b.incarnation=c.incarnation AND b.session_id=c.session_id)`,[own.name,own.incarnation,input.sessionId]);
  if(!rows.length)throw new Error('Session is not owned by this runtime');
  // end retires exactly this handle. It may cancel work/approvals; the owner explicitly confirms.
  // The conversation is marked finished only once eve confirms the session ended, or says it was
  // already not active. Anything else (no confirmation in time, a refusal) throws: never claim it ended.
  let status:'reset'|'no_active_session';
  try {
    const delivery=await attach(input.sessionId).end({reason:'Owner requested a fresh conversation from the console'});
    let timer:ReturnType<typeof setTimeout>|undefined;
    const outcome=await Promise.race([delivery.result(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Session end not confirmed')),END_CONFIRM_MS);})])
      .finally(()=>clearTimeout(timer));
    if(outcome.sessionEnded!==true)throw new Error('Unexpected session end outcome');
    status='reset';
  } catch(error) {
    if(!notActive(error))throw error;
    status='no_active_session';
  }
  await db.query('UPDATE agent_conversations SET terminal=true,observed_at=now() WHERE agent=$1 AND incarnation=$2::uuid AND session_id=$3',[own.name,own.incarnation,input.sessionId]);
  return {status};
}
