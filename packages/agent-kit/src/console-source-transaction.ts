/** Server-only private conversation transaction ownership; never a model-facing API. */
import {currentMember} from './member-store.js';
export interface SourceDatabase {query(sql:string,values?:any[]):Promise<{rows:any[];command?:string}>}
export interface SourcePool extends SourceDatabase {connect():Promise<SourceDatabase & {release(error?:boolean):void}>}
export interface SourceBinding {agent:string;incarnation:string;sessionId:string;memberId:string;admissionNonce:string}
export interface SourceTransactionOptions {
  deadlineAtMs?:number;
  /** Synchronous denial-only guard immediately before an acknowledged COMMIT. */
  beforeCommit?:()=>void;
  /** Synchronous denial-only guard after COMMIT acknowledgement and before exposing buffered output. */
  afterCommit?:()=>void;
}
const REFUSED='Conversation authority is not available';
export class SourceAuthorityDenied extends Error {constructor(){super(REFUSED);}}
export class SourceAuthorityUnavailable extends Error {constructor(){super('Conversation authority could not be confirmed');}}
interface Owner {organisationId?:string;lockedBindings:Set<string>;retire:Map<string,SourceBinding>;deadlines:Map<string,{binding:SourceBinding;deadline:string}>;deadlineAtMs?:number}
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
/** Require this exact client to be registered to a live source transaction. */
export function requireSourceTransactionOwner(db:SourceDatabase):void {owner(db);}
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
const MAX_OWNED_QUERY_TIMEOUT_MS=1000;
async function connectUntil(source:SourcePool,deadlineAtMs:number):Promise<SourceDatabase&{release(error?:boolean):void}>{
  const connection=source.connect();let timer:ReturnType<typeof setTimeout>|undefined;
  let acquired=false;
  try{const client=await Promise.race([connection,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(REFUSED)),Math.max(0,deadlineAtMs-Date.now()));})]);acquired=true;if(deadlineAtMs<=Date.now()){client.release(true);throw new Error(REFUSED);}return client;}
  catch(error){if(!acquired)void connection.then(client=>client.release(true),()=>{});throw error;}
  finally{if(timer)clearTimeout(timer);}
}
export async function consoleSourceTransaction<T>(source:SourceDatabase,work:(db:SourceDatabase)=>Promise<T>,boundary?:SourceTransactionBoundary,options:SourceTransactionOptions={}):Promise<T>{
  if(options.deadlineAtMs!==undefined&&(!Number.isFinite(options.deadlineAtMs)||options.deadlineAtMs<=Date.now()))throw new Error(REFUSED);
  if(owners.has(source)){
    if(boundary||options.beforeCommit||options.afterCommit)throw new Error(REFUSED);
    const parent=owner(source);
    if(options.deadlineAtMs!==undefined){if(parent.deadlineAtMs===undefined||options.deadlineAtMs>parent.deadlineAtMs)throw new Error(REFUSED);parent.deadlineAtMs=Math.min(parent.deadlineAtMs,options.deadlineAtMs);}
    return work(source);
  }
  if(!('connect' in source)||'release' in source)throw new Error(REFUSED);
  const selected=boundary?boundaries.get(boundary):undefined;
  if(boundary&&(!selected||selected.used))throw new Error(REFUSED);
  if(selected)selected.used=true;
  let db:(SourceDatabase&{release(error?:boolean):void})|undefined;
  const state:Owner={lockedBindings:new Set(),retire:new Map(),deadlines:new Map(),...(options.deadlineAtMs===undefined?{}:{deadlineAtMs:options.deadlineAtMs})};
  let result:T|undefined,error:unknown,failed=false,broken=false,outcome:SourceTransactionOutcome='not-started',originalOpen=false,compensationOpen=false,txOpen=false;
  let originalQuery:((sql:any,values?:any[])=>Promise<{rows:any[];command?:string}>)|undefined,queryDescriptor:PropertyDescriptor|undefined;
  const remaining=()=>state.deadlineAtMs===undefined?undefined:Math.max(0,state.deadlineAtMs-Date.now());
  const boundedQueryTimeout=()=>{const left=remaining();if(left===undefined)return undefined;if(left<=0)throw new Error(REFUSED);return Math.max(1,Math.min(MAX_OWNED_QUERY_TIMEOUT_MS,Math.ceil(left)));};
  const rawQuery=async(sql:string,values?:any[],timeout=MAX_OWNED_QUERY_TIMEOUT_MS)=>originalQuery!({text:sql,...(values===undefined?{}:{values}),query_timeout:timeout});
  const installQueryBound=()=>{
    if(options.deadlineAtMs===undefined)return;
    originalQuery=db!.query.bind(db!) as typeof originalQuery;queryDescriptor=Object.getOwnPropertyDescriptor(db!,'query');
    Object.defineProperty(db!,'query',{configurable:true,writable:true,value:async(sql:string,values?:any[])=>{
      const timeout=boundedQueryTimeout()!;
      const command=/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.exec(sql)?.[1]?.toUpperCase();
      try{
        if(txOpen&&command!=='COMMIT'&&command!=='ROLLBACK'){
          const before=boundedQueryTimeout()!;
          await rawQuery("SELECT set_config('statement_timeout',$1,true)",[`${before}ms`],before);
        }
        const queryTimeout=boundedQueryTimeout()!;
        const result=await rawQuery(sql,values,queryTimeout);
        if(command==='BEGIN'){
          txOpen=true;const afterBegin=boundedQueryTimeout()!;
          await rawQuery("SELECT set_config('statement_timeout',$1,true)",[`${afterBegin}ms`],afterBegin);
          await rawQuery("SELECT set_config('lock_timeout','500ms',true)",undefined,boundedQueryTimeout()!);
        }
        if(command==='COMMIT'||command==='ROLLBACK')txOpen=false;
        // Once PostgreSQL has acknowledged COMMIT, a crossed wall-clock deadline can
        // withhold the buffered result but must not rewrite the durable outcome as unknown.
        if(command!=='COMMIT'&&remaining()===0)throw new Error(REFUSED);
        return result;
      }catch(e){if(e&&typeof e==='object'&&(('code'in e&&String((e as {code?:unknown}).code)==='QUERY_TIMEOUT')||('message'in e&&String((e as {message?:unknown}).message)==='Query read timeout')))broken=true;throw e;}
    }});
  };
  const restoreQueryBound=()=>{if(!db||!originalQuery)return;if(queryDescriptor)Object.defineProperty(db,'query',queryDescriptor);else delete (db as {query?:unknown}).query;originalQuery=undefined;};
  const rollback=async()=>{
    try{const result=options.deadlineAtMs===undefined?await db!.query('ROLLBACK'):await rawQuery('ROLLBACK',undefined,MAX_OWNED_QUERY_TIMEOUT_MS);if(result.command!=='ROLLBACK')throw new Error(REFUSED);txOpen=false;originalOpen=false;outcome='rollback-acknowledged';}
    catch{broken=true;outcome='unknown';throw new SourceAuthorityUnavailable();}
  };
  try{
    db=options.deadlineAtMs===undefined?await (source as SourcePool).connect():await connectUntil(source as SourcePool,options.deadlineAtMs);installQueryBound();owners.set(db,state);if(selected)financialChanges.set(db,new Map());
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
      if(!state.retire.size)options.beforeCommit?.();
    }catch(e){error=e;failed=true;}
    if(state.retire.size){
      await rollback();
      // Only exact revoke-only updates survive, on this same checked-out client.
      try{
        outcome='unknown';
        const compensationQuery=(sql:string,values?:any[])=>options.deadlineAtMs===undefined?db!.query(sql,values):rawQuery(sql,values,MAX_OWNED_QUERY_TIMEOUT_MS);
        if((await compensationQuery('BEGIN')).command!=='BEGIN')throw new SourceAuthorityUnavailable();compensationOpen=true;
        if(options.deadlineAtMs!==undefined){await compensationQuery("SELECT set_config('statement_timeout','900ms',true)");await compensationQuery("SELECT set_config('lock_timeout','500ms',true)");}
        for(const b of state.retire.values())await compensationQuery(`UPDATE console_session_bindings SET revoked_at=COALESCE(revoked_at,clock_timestamp())
          WHERE agent=$1 AND incarnation=$2::uuid AND session_id=$3 AND member_id=$4 AND admission_nonce=$5`,[b.agent,b.incarnation,b.sessionId,b.memberId,b.admissionNonce]);
      }catch{
        if(compensationOpen){try{const result=options.deadlineAtMs===undefined?await db.query('ROLLBACK'):await rawQuery('ROLLBACK',undefined,MAX_OWNED_QUERY_TIMEOUT_MS);if(result.command!=='ROLLBACK')throw new Error(REFUSED);compensationOpen=false;outcome='source-retirement-rolled-back';}catch{broken=true;outcome='unknown';}}
        else{broken=true;outcome='unknown';}
        throw new SourceAuthorityUnavailable();
      }
      // A lost compensation COMMIT acknowledgement is permanently unknown, even if
      // a later cleanup ROLLBACK succeeds. It cannot complete a financial proposal.
      try{const result=options.deadlineAtMs===undefined?await db.query('COMMIT'):await rawQuery('COMMIT',undefined,MAX_OWNED_QUERY_TIMEOUT_MS);if(result.command!=='COMMIT')throw new SourceAuthorityUnavailable();compensationOpen=false;outcome='source-retirement-acknowledged';}
      catch{broken=true;outcome='unknown';throw new SourceAuthorityUnavailable();}
      throw new SourceAuthorityDenied();
    }
    if(failed){await rollback();throw error;}
    try{if((await db.query('COMMIT')).command!=='COMMIT')throw new SourceAuthorityUnavailable();originalOpen=false;outcome='commit-acknowledged';}
    catch{broken=true;outcome='unknown';throw new SourceAuthorityUnavailable();}
    options.afterCommit?.();
    if(state.deadlineAtMs!==undefined&&Date.now()>=state.deadlineAtMs)throw new Error(REFUSED);
    return result as T;
  }catch(e){
    if(db&&(originalOpen||compensationOpen||outcome==='unknown')){
      // Cleanup never converts an earlier unknown COMMIT/BEGIN/ROLLBACK into known abort.
      try{const result=options.deadlineAtMs===undefined?await db.query('ROLLBACK'):await rawQuery('ROLLBACK',undefined,MAX_OWNED_QUERY_TIMEOUT_MS);if(result.command!=='ROLLBACK')broken=true;}catch{broken=true;}
      if(outcome==='unknown')broken=true;
    }
    throw e;
  }finally{
    if(db){try{restoreQueryBound();}catch{broken=true;}finally{owners.delete(db);financialChanges.delete(db);try{db.release(broken);}catch{broken=true;}}}
    if(selected){try{await selected.hooks.settled(outcome);}catch{throw new SourceAuthorityUnavailable();}}
  }
}
