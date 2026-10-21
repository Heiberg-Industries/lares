/** Server-only private conversation transaction ownership; never a model-facing API. */
import {currentMember} from './member-store.js';
export interface SourceDatabase {query(sql:string,values?:any[]):Promise<{rows:any[];command?:string}>}
export interface SourcePool extends SourceDatabase {connect():Promise<SourceDatabase & {release(error?:boolean):void}>}
export interface SourceBinding {agent:string;incarnation:string;sessionId:string;memberId:string;admissionNonce:string}
const REFUSED='Conversation authority is not available';
export class SourceAuthorityDenied extends Error {constructor(){super(REFUSED);}}
export class SourceAuthorityUnavailable extends Error {constructor(){super('Conversation authority could not be confirmed');}}
interface Owner {organisationId?:string;lockedBindings:Set<string>;retire:Map<string,SourceBinding>;deadlines:Map<string,{binding:SourceBinding;deadline:string}>}
const owners=new WeakMap<object,Owner>();
const key=(b:SourceBinding)=>JSON.stringify([b.agent,b.incarnation,b.sessionId,b.memberId,b.admissionNonce]);
function owner(db:SourceDatabase):Owner {const value=owners.get(db);if(!value)throw new Error(REFUSED);return value;}
export function invalidateConsoleSource(db:SourceDatabase,binding:SourceBinding):never {
  const state=owner(db);if(!state.organisationId)throw new Error(REFUSED);
  state.retire.set(key(binding),{...binding});throw new SourceAuthorityDenied();
}
/** Discover unlocked, serialize readers before authority/resource locks, then lock/recheck.
 * A moved member or another organisation never causes a second gate acquisition. */
export async function gateConsoleOrganisation(db:SourceDatabase,memberId:string,binding?:SourceBinding):Promise<void>{
  const state=owner(db),before=(await db.query('SELECT org_id AS organisation_id FROM users WHERE id=$1',[memberId])).rows[0];
  if(!before?.organisation_id)throw new Error(REFUSED);
  const organisationId=before.organisation_id;
  if(state.organisationId&&state.organisationId!==organisationId)throw new Error(REFUSED);
  if(!state.organisationId){
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('lares-console-source:' || $1,0))",[organisationId]);
    state.organisationId=organisationId;
  }
  const org=await db.query('SELECT id FROM orgs WHERE id=$1 FOR SHARE',[state.organisationId]);
  const member=await currentMember(db as never,memberId,{lock:'share'});
  if(org.rows.length!==1||!member||member.organisationId!==state.organisationId){
    if(binding)invalidateConsoleSource(db,binding);throw new Error(REFUSED);
  }
}
export function requireConsoleSourceOwner(db:SourceDatabase):void {if(!owner(db).organisationId)throw new Error(REFUSED);}
/** A caller must declare its new-source union before the first binding lock. */
export function requireNewConsoleSourcesBeforeBinding(db:SourceDatabase,binding:SourceBinding,hasNewSources:boolean):void{
  if(hasNewSources&&owner(db).lockedBindings.has(key(binding)))throw new Error(REFUSED);
}
export function noteConsoleSourceBindingLocked(db:SourceDatabase,binding:SourceBinding):void{
  requireConsoleSourceOwner(db);owner(db).lockedBindings.add(key(binding));
}
export function retainConsoleSourceDeadline(db:SourceDatabase,binding:SourceBinding,deadline:string|null):void {
  const state=owner(db);requireConsoleSourceOwner(db);
  if(deadline!==null)state.deadlines.set(JSON.stringify([key(binding),deadline]),{binding:{...binding},deadline});
}
/** After later resource waits, before admitting output/dispatch and again before commit. */
export async function checkConsoleSourceDeadlines(db:SourceDatabase):Promise<string|null>{
  const state=owner(db);
  for(const {binding,deadline} of state.deadlines.values()){
    const fresh=await db.query('SELECT 1 WHERE $1::timestamptz>clock_timestamp()',[deadline]);
    if(!fresh.rows.length)invalidateConsoleSource(db,binding);
  }
  if(!state.deadlines.size)return null;
  // PostgreSQL retains sub-millisecond precision when choosing the earliest deadline.
  return (await db.query('SELECT min(deadline)::text AS deadline FROM unnest($1::timestamptz[]) deadline',[[...state.deadlines.values()].map(v=>v.deadline)])).rows[0].deadline;
}
export async function consoleSourceTransaction<T>(source:SourceDatabase,work:(db:SourceDatabase)=>Promise<T>):Promise<T>{
  if(owners.has(source))return work(source);
  if(!('connect' in source)||'release' in source)throw new Error(REFUSED);
  const db=await (source as SourcePool).connect(),state:Owner={lockedBindings:new Set(),retire:new Map(),deadlines:new Map()};
  owners.set(db,state);
  let result:T|undefined,error:unknown,failed=false,broken=false;
  try{
    await db.query('BEGIN');
    try{result=await work(db);await checkConsoleSourceDeadlines(db);}catch(e){error=e;failed=true;}
    if(state.retire.size){
      await db.query('ROLLBACK');
      // Only exact revoke-only updates survive, on this same checked-out client.
      try{
        await db.query('BEGIN');
        for(const b of state.retire.values())await db.query(`UPDATE console_session_bindings SET revoked_at=COALESCE(revoked_at,clock_timestamp())
          WHERE agent=$1 AND incarnation=$2::uuid AND session_id=$3 AND member_id=$4 AND admission_nonce=$5`,[b.agent,b.incarnation,b.sessionId,b.memberId,b.admissionNonce]);
        if((await db.query('COMMIT')).command!=='COMMIT')throw new SourceAuthorityUnavailable();
      }catch{broken=true;await db.query('ROLLBACK').catch(()=>undefined);throw new SourceAuthorityUnavailable();}
      throw new SourceAuthorityDenied();
    }
    if(failed){await db.query('ROLLBACK');throw error;}
    try{if((await db.query('COMMIT')).command!=='COMMIT')throw new SourceAuthorityUnavailable();}catch{broken=true;throw new SourceAuthorityUnavailable();}
    return result as T;
  }catch(e){await db.query('ROLLBACK').catch(()=>undefined);throw e;}
  finally{owners.delete(db);db.release(broken);}
}
