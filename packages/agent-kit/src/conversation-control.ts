// Public eve hook/route seam; no workflow table access and no address-based reset.
import { getPool } from './db.js';
type Database = { query(sql:string, values?:unknown[]):Promise<{rows:Record<string,unknown>[]}> };
interface Context { session:{id:string;parent?:unknown;auth?:{initiator?:{principalId?:string;principalType?:string}|null}};channel:{kind?:string} }
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function identity(env:NodeJS.ProcessEnv) {
  const name=env.LARES_AGENT_NAME,incarnation=env.LARES_AGENT_INCARNATION;
  if(!name||!/^[a-z][a-z0-9-]{1,30}$/.test(name)||!incarnation||!UUID.test(incarnation)) return null;
  return {name,incarnation};
}
const LIFECYCLE=['session.started','session.waiting','session.completed','session.failed','session.reset'];
const TERMINAL=['session.completed','session.failed','session.reset'];
export async function observeConversation(event:{type:string},ctx:Context,db?:Database,env:NodeJS.ProcessEnv=process.env):Promise<void> {
  const door = ctx.channel.kind?.replace(/^channel:/, '');
  const own=identity(env);if(!own||ctx.session.parent||!['slack','telegram','http'].includes(door??''))return;
  const terminal=TERMINAL.includes(event.type);
  // A session a schedule opened (the app, not a person) is not a conversation until it asks the
  // owner something. From its first `input.requested` it is one: the console's "Waiting on you"
  // page finds pending approvals through this projection, and a schedule's approval card (a
  // meeting follow-up mail, a brief's proposal) is exactly the kind it must not miss. Before that
  // it is never written; after it, only its end is recorded, on the row it already has (an UPDATE
  // that matches nothing for the many schedule sessions that never asked, and only on the rare
  // terminal event, so a schedule ticking every few minutes costs no extra writes).
  const initiator=ctx.session.auth?.initiator;
  if(initiator?.principalType==='runtime'||initiator?.principalId==='eve:app'){
    if(event.type==='input.requested') return upsert(own,ctx.session.id,door!,false,db);
    if(!terminal)return;
    try {
      await (db??getPool()).query(`UPDATE agent_conversations SET observed_at=now(),terminal=terminal OR $4
        WHERE agent=$1 AND incarnation=$2::uuid AND session_id=$3`,[own.name,own.incarnation,ctx.session.id,terminal]);
    } catch { console.warn('[conversations] projection unavailable'); }
    return;
  }
  if(!LIFECYCLE.includes(event.type))return;
  return upsert(own,ctx.session.id,door!,terminal,db);
}
async function upsert(own:{name:string;incarnation:string},sessionId:string,door:string,terminal:boolean,db?:Database):Promise<void> {
  try {
    await (db??getPool()).query(`INSERT INTO agent_conversations(agent,incarnation,session_id,door,terminal)
      SELECT $1,$2::uuid,$3,$4,$5 WHERE EXISTS(SELECT 1 FROM agent_resources WHERE name=$1 AND ownership_token=$2::uuid AND runtime_control_token=ownership_token AND state='ready')
      ON CONFLICT(agent,incarnation,session_id) DO UPDATE SET observed_at=now(),terminal=agent_conversations.terminal OR EXCLUDED.terminal`,[own.name,own.incarnation,sessionId,door,terminal]);
    await (db??getPool()).query(`DELETE FROM agent_conversations WHERE agent=$1 AND incarnation=$2::uuid AND session_id IN (SELECT session_id FROM agent_conversations WHERE agent=$1 AND incarnation=$2::uuid ORDER BY observed_at DESC OFFSET 500)`,[own.name,own.incarnation]);
  } catch { console.warn('[conversations] projection unavailable'); }
}
export interface ResetInput {sessionId:string;incarnation:string;confirm:boolean}
export interface ResetHandle {reset(input:{reason:string}):Promise<{status:string;previousSessionId?:string}>}
export async function resetConversation(input:ResetInput,attach:(id:string)=>ResetHandle,db:Database=getPool(),env:NodeJS.ProcessEnv=process.env) {
  const own=identity(env);
  if(!own||input.incarnation!==own.incarnation) throw new Error('Runtime incarnation mismatch');
  if(input.confirm!==true||!/^wrun_[A-Za-z0-9_-]{1,200}$/.test(input.sessionId))throw new Error('Confirmed exact session required');
  const {rows}=await db.query(`SELECT c.session_id FROM agent_conversations c JOIN agent_resources r ON r.name=c.agent AND r.ownership_token=c.incarnation
    WHERE c.agent=$1 AND c.incarnation=$2::uuid AND c.session_id=$3 AND r.runtime_control_token=r.ownership_token AND NOT r.pending AND r.state='ready'`,[own.name,own.incarnation,input.sessionId]);
  if(!rows.length)throw new Error('Session is not owned by this runtime');
  // reset retires exactly this handle. It may cancel work/approvals; the owner explicitly confirms.
  const result=await attach(input.sessionId).reset({reason:'Owner requested a fresh conversation from the console'});
  if(!['reset','no_active_session'].includes(result.status))throw new Error('Unexpected session reset outcome');
  await db.query('UPDATE agent_conversations SET terminal=true,observed_at=now() WHERE agent=$1 AND incarnation=$2::uuid AND session_id=$3',[own.name,own.incarnation,input.sessionId]);
  return {status:result.status};
}
