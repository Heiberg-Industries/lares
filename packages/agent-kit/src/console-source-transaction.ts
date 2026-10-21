/** Server-only private conversation transaction ownership; never a model-facing API. */
import {currentMember} from './member-store.js';
export interface SourceDatabase {query(sql:string,values?:any[]):Promise<{rows:any[];command?:string}>}
export interface SourcePool extends SourceDatabase {connect():Promise<SourceDatabase & {release(error?:boolean):void}>}
export interface SourceBinding {agent:string;incarnation:string;sessionId:string;memberId:string;admissionNonce:string}
const REFUSED='Conversation authority is not available';
export class SourceAuthorityDenied extends Error {constructor(){super(REFUSED);}}
export class SourceAuthorityUnavailable extends Error {constructor(){super('Conversation authority could not be confirmed');}}
interface Owner {organisationId?:string;lockedBindings:Set<string>;retire:Map<string,SourceBinding>;deadlines:Map<string,{binding:SourceBinding;deadline:string}>}
export type SourceTransactionOutcome='not-started'|'rollback-acknowledged'|'source-retirement-acknowledged'|'source-retirement-rolled-back'|'commit-acknowledged'|'unknown';
export type BudgetFinancialTable='budget_accounts'|'budget_windows'|'budget_gateway_bindings'|'budget_attempts'|'budget_gateway_grants';
export interface BudgetFinancialChange {table:BudgetFinancialTable;id:string}
export interface SourceTransactionBoundary {readonly kind:'source-transaction-boundary'}
interface BoundaryHooks {
  started?(db:SourceDatabase):Promise<void>;
  readyToCommit?(db:SourceDatabase):Promise<void>;
  beforeCommit(db:SourceDatabase,changes:readonly BudgetFinancialChange[]):Promise<void>;
  settled(outcome:SourceTransactionOutcome):Promise<void>;
}
const boundaries=new WeakMap<object,{hooks:BoundaryHooks;used:boolean}>();
const financialChanges=new WeakMap<object,Map<string,BudgetFinancialChange>>();
/** Trusted server-only one-use owner context. JSON or a borrowed client cannot create it. */
export function sourceTransactionBoundary(hooks:BoundaryHooks):SourceTransactionBoundary {
  const boundary=Object.freeze({kind:'source-transaction-boundary' as const});boundaries.set(boundary,{hooks,used:false});return boundary;
}
/** Only adapted financial writes are recorded here. This is not an active database guard;
 * the production gateway remains closed until every writer and privilege is integrated. */
export function noteBudgetFinancialChange(db:SourceDatabase,table:BudgetFinancialTable,id:string):void {
  if(!owners.has(db))throw new Error(REFUSED);
  const changes=financialChanges.get(db);if(changes)changes.set(`${table}:${id}`,{table,id});
}
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
export async function consoleSourceTransaction<T>(source:SourceDatabase,work:(db:SourceDatabase)=>Promise<T>,boundary?:SourceTransactionBoundary):Promise<T>{
  if(owners.has(source)){if(boundary)throw new Error(REFUSED);return work(source);}
  if(!('connect' in source)||'release' in source)throw new Error(REFUSED);
  const selected=boundary?boundaries.get(boundary):undefined;
  if(boundary&&(!selected||selected.used))throw new Error(REFUSED);
  if(selected)selected.used=true;
  let db:(SourceDatabase&{release(error?:boolean):void})|undefined;
  const state:Owner={lockedBindings:new Set(),retire:new Map(),deadlines:new Map()};
  let result:T|undefined,error:unknown,failed=false,broken=false,outcome:SourceTransactionOutcome='not-started',originalOpen=false,compensationOpen=false;
  const rollback=async()=>{
    try{if((await db!.query('ROLLBACK')).command!=='ROLLBACK')throw new Error(REFUSED);originalOpen=false;outcome='rollback-acknowledged';}
    catch{broken=true;outcome='unknown';throw new SourceAuthorityUnavailable();}
  };
  try{
    db=await (source as SourcePool).connect();owners.set(db,state);if(selected)financialChanges.set(db,new Map());
    outcome='unknown';
    if((await db.query('BEGIN')).command!=='BEGIN')throw new SourceAuthorityUnavailable();originalOpen=true;
    try{
      if(selected?.hooks.started)await selected.hooks.started(db);
      result=await work(db);await checkConsoleSourceDeadlines(db);
      if(!state.retire.size&&selected){
        await selected.hooks.beforeCommit(db,[...financialChanges.get(db)!.values()]);await checkConsoleSourceDeadlines(db);
        if(selected.hooks.readyToCommit)await selected.hooks.readyToCommit(db);
        // Continuity observations can wait too: expiry still selects the revoke-only
        // branch below, never a late financial COMMIT after those observations.
        await checkConsoleSourceDeadlines(db);
      }
    }catch(e){error=e;failed=true;}
    if(state.retire.size){
      await rollback();
      // Only exact revoke-only updates survive, on this same checked-out client.
      try{
        outcome='unknown';
        if((await db.query('BEGIN')).command!=='BEGIN')throw new SourceAuthorityUnavailable();compensationOpen=true;
        for(const b of state.retire.values())await db.query(`UPDATE console_session_bindings SET revoked_at=COALESCE(revoked_at,clock_timestamp())
          WHERE agent=$1 AND incarnation=$2::uuid AND session_id=$3 AND member_id=$4 AND admission_nonce=$5`,[b.agent,b.incarnation,b.sessionId,b.memberId,b.admissionNonce]);
      }catch{
        if(compensationOpen){try{if((await db.query('ROLLBACK')).command!=='ROLLBACK')throw new Error(REFUSED);compensationOpen=false;outcome='source-retirement-rolled-back';}catch{broken=true;outcome='unknown';}}
        else{broken=true;outcome='unknown';}
        throw new SourceAuthorityUnavailable();
      }
      // A lost compensation COMMIT acknowledgement is permanently unknown, even if
      // a later cleanup ROLLBACK succeeds. It cannot complete a financial proposal.
      try{if((await db.query('COMMIT')).command!=='COMMIT')throw new SourceAuthorityUnavailable();compensationOpen=false;outcome='source-retirement-acknowledged';}
      catch{broken=true;outcome='unknown';throw new SourceAuthorityUnavailable();}
      throw new SourceAuthorityDenied();
    }
    if(failed){await rollback();throw error;}
    try{if((await db.query('COMMIT')).command!=='COMMIT')throw new SourceAuthorityUnavailable();originalOpen=false;outcome='commit-acknowledged';}
    catch{broken=true;outcome='unknown';throw new SourceAuthorityUnavailable();}
    return result as T;
  }catch(e){
    if(db&&(originalOpen||compensationOpen||outcome==='unknown')){
      // Cleanup never converts an earlier unknown COMMIT/BEGIN/ROLLBACK into known abort.
      await db.query('ROLLBACK').catch(()=>{broken=true;});
      if(outcome==='unknown')broken=true;
    }
    throw e;
  }finally{
    if(db){owners.delete(db);financialChanges.delete(db);db.release(broken);}
    if(selected){try{await selected.hooks.settled(outcome);}catch{throw new SourceAuthorityUnavailable();}}
  }
}
