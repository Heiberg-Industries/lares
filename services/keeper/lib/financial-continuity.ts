/** Server-only observation on the caller's actual owned PostgreSQL connection. */
import {querySourceBounded,sourceObservationCommit,type SourceDatabase,type SourceObservationCommit} from '@lares/agent-kit/console-source-transaction';
import {canonicalBudgetMoney} from '@lares/agent-kit/budget-admission-store';
import {gatewayCanonical,gatewayHash} from '@lares/agent-kit/gateway-admission-protocol';
import {FINANCIAL_DATABASE_SCHEMA,FINANCIAL_CHECKPOINT_SCHEMA,FinancialJournalBusy,HostFinancialJournal,financialAtomKey,financialCheckpointRolling,type FinancialAtom,type FinancialCheckpoint,type FinancialCounts,type FinancialProjection,type FinancialObservation} from './financial-journal.js';
import {financialAtomFromRow,FINANCIAL_UTC_TIMESTAMP} from './financial-projection.js';
declare const financialObservationHandleBrand:unique symbol;
export interface FinancialObservationHandle {readonly [financialObservationHandleBrand]:true}
const verifiedObservations=new WeakMap<object,{journal:HostFinancialJournal;operationId:string;commit:SourceObservationCommit;observation:FinancialObservation}>();
/** Only the completed observer can mint this handle. The journal consumes it once, for
 * this exact operation, after its terminal and control records are durable. */
export function consumeFinancialObservationHandle(journal:HostFinancialJournal,operationId:string,handle:FinancialObservationHandle):{commit:SourceObservationCommit;observation:FinancialObservation} {
  const proof=handle&&typeof handle==='object'?verifiedObservations.get(handle):undefined;
  if(!proof||proof.journal!==journal||proof.operationId!==operationId)throw new Error('Financial observation unavailable');
  verifiedObservations.delete(handle as object);return {commit:proof.commit,observation:proof.observation};
}
const FINANCIAL_TABLES=[
  {kind:'account' as const,count:'accounts' as const,key:'id',select:'SELECT * FROM budget_accounts',sql:'SELECT * FROM budget_accounts WHERE id=ANY($1::uuid[]) ORDER BY id'},
  {kind:'window' as const,count:'windows' as const,key:'id',select:`SELECT *,${FINANCIAL_UTC_TIMESTAMP('starts_at')} AS starts_utc,${FINANCIAL_UTC_TIMESTAMP('ends_at')} AS ends_utc FROM budget_windows`,sql:`SELECT *,${FINANCIAL_UTC_TIMESTAMP('starts_at')} AS starts_utc,${FINANCIAL_UTC_TIMESTAMP('ends_at')} AS ends_utc FROM budget_windows WHERE id=ANY($1::uuid[]) ORDER BY id`},
  {kind:'binding' as const,count:'bindings' as const,key:'id',select:'SELECT * FROM budget_gateway_bindings',sql:'SELECT * FROM budget_gateway_bindings WHERE id=ANY($1::uuid[]) ORDER BY id'},
  {kind:'attempt' as const,count:'attempts' as const,key:'id',select:`SELECT *,${FINANCIAL_UTC_TIMESTAMP('created_at')} AS created_utc,${FINANCIAL_UTC_TIMESTAMP('expires_at')} AS expires_utc,${FINANCIAL_UTC_TIMESTAMP('admitted_at')} AS admitted_utc FROM budget_attempts`,sql:`SELECT *,${FINANCIAL_UTC_TIMESTAMP('created_at')} AS created_utc,${FINANCIAL_UTC_TIMESTAMP('expires_at')} AS expires_utc,${FINANCIAL_UTC_TIMESTAMP('admitted_at')} AS admitted_utc FROM budget_attempts WHERE id=ANY($1::uuid[]) ORDER BY id`},
  {kind:'grant' as const,count:'grants' as const,key:'attempt_id',select:'SELECT * FROM budget_gateway_grants',sql:'SELECT * FROM budget_gateway_grants WHERE attempt_id=ANY($1::uuid[]) ORDER BY attempt_id'},
];
const WHOLE_LEDGER_BATCH=500,SCHEDULED_SUSPECT_LIMIT=2000,SCHEDULED_RECHECK_CHUNK=100;
const ATTEMPT_STATES=['prepared','admitted','unknown','settled','conflict','retired'];
export async function observeFinancialDatabase(db:SourceDatabase){
  const rows=(await db.query(`SELECT (pg_control_system()).system_identifier::text AS "systemIdentifier",
    to_char(pg_postmaster_start_time() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "postmasterStartedAt",
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS "databaseOid"`)).rows;
  if(rows.length!==1)throw new Error('Financial database observation unavailable');
  return FINANCIAL_DATABASE_SCHEMA.parse(rows[0]);
}
export async function observeFinancialCheckpoint(db:SourceDatabase){
  const rows=(await db.query(`SELECT operation_id AS "operationId",journal_id AS "journalId",proposal_sequence::text AS sequence,proposal_digest AS digest
    FROM budget_financial_checkpoints ORDER BY proposal_sequence DESC LIMIT 1`)).rows;
  if(!rows.length)return null;
  const row=rows[0],sequence=Number(row.sequence);
  return FINANCIAL_CHECKPOINT_SCHEMA.parse({...row,sequence});
}
async function financialCountsMatch(db:SourceDatabase,expectedCounts:FinancialCounts):Promise<boolean> {
  const countRows=(await db.query(`SELECT
    (SELECT count(*)::text FROM budget_accounts) AS accounts,
    (SELECT count(*)::text FROM budget_windows) AS windows,
    (SELECT count(*)::text FROM budget_gateway_bindings) AS bindings,
    (SELECT count(*)::text FROM budget_attempts) AS attempts,
    (SELECT count(*)::text FROM budget_gateway_grants) AS grants,
    (SELECT count(*)::text FROM budget_financial_checkpoints) AS checkpoints`)).rows;
  if(countRows.length!==1)throw new Error('Financial projection unavailable');
  return Object.entries(expectedCounts).every(([name,expected])=>{const count=Number(countRows[0][name]);return Number.isSafeInteger(count)&&count===expected;});
}
async function observeFinancialProjection(db:SourceDatabase,projection:FinancialProjection):Promise<{checkpoints:FinancialCheckpoint[];atoms:FinancialAtom[]}> {
  const expectedAtoms=projection.atoms.filter(atom=>atom.kind!=='tombstone');
  if(!await financialCountsMatch(db,projection.counts))throw new Error('Financial projection mismatch');

  let checkpoints:FinancialCheckpoint[]=[];
  if(projection.checkpoints.length){
    const rows=(await db.query(`SELECT operation_id AS "operationId",journal_id AS "journalId",proposal_sequence::text AS sequence,proposal_digest AS digest
      FROM budget_financial_checkpoints WHERE proposal_sequence=ANY($1::bigint[]) ORDER BY proposal_sequence`,[projection.checkpoints.map(checkpoint=>String(checkpoint.sequence))])).rows;
    if(rows.length!==projection.checkpoints.length)throw new Error('Financial checkpoint projection mismatch');
    checkpoints=rows.map(row=>FINANCIAL_CHECKPOINT_SCHEMA.parse({...row,sequence:Number(row.sequence)}));
  }

  const atoms:FinancialAtom[]=[];
  for(const table of FINANCIAL_TABLES){
    const expected=expectedAtoms.filter((atom)=>atom.kind===table.kind);
    if(!expected.length)continue;
    const ids=expected.map(atom=>atom.kind==='grant'?atom.attemptId:atom.id);
    const rows=(await db.query(table.sql,[ids])).rows;if(rows.length!==expected.length)throw new Error('Financial row projection mismatch');
    for(const row of rows)atoms.push(financialAtomFromRow(table.kind,row));
  }
  atoms.sort((left,right)=>financialAtomKey(left).localeCompare(financialAtomKey(right)));
  return {checkpoints,atoms};
}
/** The money that decides admission, for the current months only, including finished rows that
 * each step no longer compares one by one. Runs once per operation, before its changes. Naming
 * every state lets the index go straight to this month's rows instead of all of history. */
async function currentMonthTotalsMatch(db:SourceDatabase,totals:NonNullable<FinancialProjection['windowTotals']>):Promise<boolean> {
  const rows=(await db.query(`SELECT window_id::text AS "windowId",state,count(*)::text AS count,COALESCE(sum(reserved_amount),0)::text AS reserved,COALESCE(sum(actual_amount),0)::text AS actual,COALESCE(sum(highest_observed_liability),0)::text AS high FROM (
      SELECT installation_window_id AS window_id,state,reserved_amount,actual_amount,highest_observed_liability FROM budget_attempts WHERE installation_account_id=ANY($2::uuid[]) AND state=ANY($3::text[]) AND installation_window_id=ANY($1::uuid[])
      UNION ALL SELECT member_window_id,state,reserved_amount,actual_amount,highest_observed_liability FROM budget_attempts WHERE member_account_id=ANY($2::uuid[]) AND state=ANY($3::text[]) AND member_window_id=ANY($1::uuid[])
    ) current_month GROUP BY window_id,state ORDER BY window_id,state COLLATE "C"`,[totals.windowIds,totals.accountIds,ATTEMPT_STATES])).rows;
  const actual=rows.map(row=>({windowId:row.windowId,state:row.state,count:Number(row.count),reserved:canonicalBudgetMoney(row.reserved),actual:canonicalBudgetMoney(row.actual),high:canonicalBudgetMoney(row.high)}));
  const order=(left:{windowId:string;state:string},right:{windowId:string;state:string})=>left.windowId<right.windowId?-1:left.windowId>right.windowId?1:left.state<right.state?-1:left.state>right.state?1:0;
  return JSON.stringify(actual.sort(order))===JSON.stringify([...totals.totals].sort(order));
}
type LedgerRows=(sql:string,values:unknown[])=>Promise<Record<string,any>[]>;
type WholeLedgerExpectation=ReturnType<HostFinancialJournal['fullLedgerExpectation']>;
type FinancialTable=typeof FINANCIAL_TABLES[number];
async function eachLedgerRow(rows:LedgerRows,visit:(table:FinancialTable,row:Record<string,any>)=>boolean,pause?:()=>Promise<void>):Promise<boolean>{
  for(const table of FINANCIAL_TABLES){
    let after='00000000-0000-0000-0000-000000000000';
    for(;;){
      const batch=await rows(`${table.select} WHERE ${table.key}>$1::uuid ORDER BY ${table.key} LIMIT ${WHOLE_LEDGER_BATCH}`,[after]);
      if(!batch.length)break;
      for(const row of batch)if(!visit(table,row))return false;
      after=batch.at(-1)![table.key];await pause?.();
    }
  }
  return true;
}
/** Checkpoints are append-only and a recorded one is always already in the database, so the
 * first `count` rows cannot change underneath this read, whatever is being written after them. */
async function recordedCheckpointsMatch(rows:LedgerRows,expected:WholeLedgerExpectation,pause?:()=>Promise<void>):Promise<boolean>{
  let sequence='0',rolling='0'.repeat(64),left=expected.counts.checkpoints;
  while(left>0){
    const batch=await rows(`SELECT operation_id AS "operationId",journal_id AS "journalId",proposal_sequence::text AS sequence,proposal_digest AS digest FROM budget_financial_checkpoints WHERE proposal_sequence>$1::bigint ORDER BY proposal_sequence LIMIT ${Math.min(WHOLE_LEDGER_BATCH,left)}`,[sequence]);
    if(!batch.length)return false;
    for(const row of batch)rolling=financialCheckpointRolling(rolling,FINANCIAL_CHECKPOINT_SCHEMA.parse({...row,sequence:Number(row.sequence)}));
    left-=batch.length;sequence=batch.at(-1)!.sequence;await pause?.();
  }
  return rolling===expected.checkpointDigest;
}
const rowMatches=(expected:WholeLedgerExpectation,table:FinancialTable,row:Record<string,any>)=>{
  try{return expected.matches(financialAtomFromRow(table.kind,row));}catch{return false;}
};
/** Keeper startup: the whole ledger must match before this writer can take its lease. No other
 * writer exists yet, and the stable read covers the counts and every row together. */
export async function verifyFullFinancialContinuity(journal:HostFinancialJournal,db:SourceDatabase):Promise<void>{
  let matched=false,open=false;
  try{
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');open=true;
    const database=await observeFinancialDatabase(db),expected=journal.fullLedgerExpectation(),rows:LedgerRows=async(sql,values)=>(await db.query(sql,values)).rows;
    matched=journal.databaseMatches(database)&&await financialCountsMatch(db,expected.counts)&&await eachLedgerRow(rows,(table,row)=>rowMatches(expected,table,row))&&await recordedCheckpointsMatch(rows,expected);
    await db.query('COMMIT');open=false;
  }catch{
    if(open)await db.query('ROLLBACK').catch(()=>{});
    if(!journal.isFrozen)journal.freeze();
    throw new Error('Financial continuity requires recovery');
  }
  if(!matched){if(!journal.isFrozen)journal.freezeForContinuity();throw new Error('Financial continuity requires recovery');}
  journal.acceptFullContinuity();
}
export type ScheduledLedgerCheck='matched'|'busy'|'unavailable'|'mismatch';
type ScheduledPool={connect():Promise<SourceDatabase&{release():void}>};
/** The nightly whole-ledger check. Rows are read and compared with no barrier held and a fresh
 * pooled connection per batch, so model calls carry on throughout. A row can look different
 * while an operation is committing it, so that is only a suspicion: each is read again with the
 * barrier held, when database and journal must agree. Only a difference found there freezes. A
 * database that cannot be read tonight is reported and tried again, since each step checks it too. */
export async function runScheduledLedgerCheck(journal:HostFinancialJournal,pool:ScheduledPool,barrierWaitMs=5000):Promise<ScheduledLedgerCheck>{
  const rows:LedgerRows=async(sql,values)=>{const client=await pool.connect();try{return (await client.query(sql,values)).rows;}finally{client.release();}};
  const pause=()=>new Promise<void>(resolve=>setImmediate(resolve));
  const underBarrier=async<T>(work:()=>Promise<T>):Promise<T>=>{
    const deadline=Date.now()+barrierWaitMs;
    for(;;){
      try{return await journal.withFullCheckBarrier(work);}
      catch(error){if(!(error instanceof FinancialJournalBusy)||Date.now()>=deadline)throw error;await new Promise(resolve=>setTimeout(resolve,50));}
    }
  };
  const mismatch=():'mismatch'=>{journal.freezeForContinuity();return 'mismatch';};
  try{
    const expected=journal.fullLedgerExpectation(),suspects:{table:FinancialTable;id:string}[]=[];
    const walked=await eachLedgerRow(rows,(table,row)=>{if(!rowMatches(expected,table,row))suspects.push({table,id:row[table.key]});return suspects.length<SCHEDULED_SUSPECT_LIMIT;},pause);
    const checkpoints=await recordedCheckpointsMatch(rows,expected,pause);
    for(let start=0;start<suspects.length;start+=SCHEDULED_RECHECK_CHUNK){
      const chunk=suspects.slice(start,start+SCHEDULED_RECHECK_CHUNK);
      const same=await underBarrier(async()=>{
        const current=journal.fullLedgerExpectation();
        for(const table of FINANCIAL_TABLES){
          const ids=chunk.filter(suspect=>suspect.table===table).map(suspect=>suspect.id);if(!ids.length)continue;
          const found=await rows(table.sql,[ids]);
          if(found.length!==ids.length||!found.every(row=>rowMatches(current,table,row)))return false;
        }
        return true;
      });
      if(!same)return await underBarrier(async()=>mismatch());
    }
    if(!walked)return 'unavailable';
    return await underBarrier(async()=>{
      const client=await pool.connect();let same=false;
      try{same=checkpoints&&journal.databaseMatches(await observeFinancialDatabase(client))&&await financialCountsMatch(client,journal.fullLedgerExpectation().counts);}
      finally{client.release();}
      return same?'matched':mismatch();
    });
  }catch(error){return error instanceof FinancialJournalBusy?'busy':'unavailable';}
}
export function msUntilNightlyLedgerCheck(now:number):number {
  const next=new Date(now);next.setUTCHours(3,0,0,0);
  if(next.getTime()<=now)next.setUTCDate(next.getUTCDate()+1);
  return next.getTime()-now;
}
/** Once a night at 03:00 UTC. A held barrier is tried again a minute later, up to 30 times. */
export function scheduleNightlyLedgerCheck(journal:HostFinancialJournal,pool:Parameters<typeof runScheduledLedgerCheck>[1],log:(message:string)=>void=console.warn):()=>Promise<void>{
  let timer:ReturnType<typeof setTimeout>|undefined,stopped=false,running:Promise<void>|undefined;
  const arm=(delay:number,work:()=>Promise<void>)=>{timer=setTimeout(()=>{running=work().finally(()=>{running=undefined;});},delay);timer.unref?.();};
  const nightly=()=>arm(msUntilNightlyLedgerCheck(Date.now()),()=>attempt(1));
  const attempt=async(tries:number):Promise<void>=>{
    const result=await runScheduledLedgerCheck(journal,pool);
    if(stopped)return;
    if(result==='busy'&&tries<30){arm(60_000,()=>attempt(tries+1));return;}
    if(result==='mismatch')log('keeper: the financial ledger no longer matches the database; spending is frozen and recovery is required');
    else if(result!=='matched')log('keeper: the nightly financial ledger check could not run; it will try again tomorrow');
    nightly();
  };
  nightly();
  return async()=>{stopped=true;if(timer)clearTimeout(timer);await running;};
}
export async function verifyFinancialContinuity(journal:HostFinancialJournal,db:SourceDatabase,proposed=false):Promise<void>{
  try{
    const projection=journal.expectedProjection(proposed),database=await observeFinancialDatabase(db),observed=await observeFinancialProjection(db,projection);
    if(projection.windowTotals&&!await currentMonthTotalsMatch(db,projection.windowTotals))throw new Error('Financial projection mismatch');
    journal.verifyContinuity(database,observed.checkpoints,observed.atoms,proposed);
  }
  catch{if(!journal.isFrozen)journal.freeze();throw new Error('Financial continuity requires recovery');}
}
/** Fresh, same-client read-only observation after the source mutation COMMIT. The caller
 * keeps this exact checked-out client owned until the observer COMMIT is acknowledged. */
export async function observeCommittedFinancialProjection(journal:HostFinancialJournal,db:SourceDatabase,operationId:string):Promise<FinancialObservationHandle>{
  let open=false,commitAttempted=false;
  const bounded:SourceDatabase={query:(sql,values)=>querySourceBounded(db,sql,values,1000)};
  try{
    if((await querySourceBounded(db,'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',undefined,1000)).command!=='BEGIN')throw new Error('Financial observation unavailable');open=true;
    await querySourceBounded(db,"SET LOCAL statement_timeout='1000ms'",undefined,1000);
    await querySourceBounded(db,"SET LOCAL lock_timeout='500ms'",undefined,1000);
    const projection=journal.expectedProjection(true),database=await observeFinancialDatabase(bounded),observed=await observeFinancialProjection(bounded,projection);
    journal.verifyContinuity(database,observed.checkpoints,observed.atoms,true);
    const checkpoint=projection.checkpoints.at(-1);if(!checkpoint||checkpoint.operationId!==operationId)throw new Error('Financial observation checkpoint unavailable');
    const observation:FinancialObservation={operationId,checkpoint,database,
      projectionDigest:gatewayHash(gatewayCanonical({checkpoints:observed.checkpoints,atoms:projection.atoms})),
      checkpointDigest:gatewayHash(gatewayCanonical(observed.checkpoints)),counts:projection.counts};
    commitAttempted=true;
    if((await querySourceBounded(db,'COMMIT',undefined,1000)).command!=='COMMIT')throw new Error('Financial observation commit unavailable');open=false;
    const handle=Object.freeze({});verifiedObservations.set(handle,{journal,operationId,observation,commit:sourceObservationCommit(db)});return handle as FinancialObservationHandle;
  }catch(error){
    if(open&&!commitAttempted){try{await querySourceBounded(db,'ROLLBACK',undefined,1000);}catch{}}
    throw error;
  }
}
/** The explicit fresh-install ceremony owns all SIX tables while recording the host receipt.
 * A restored empty DB is refused when any earlier ceremony exists on this host. A new host
 * still requires the administrator's explicit fresh-install assertion; no empty-row heuristic
 * can discover whether another host or an old backup existed. */
export async function prepareFinancialCustody(directory:string,db:SourceDatabase,options:Parameters<typeof HostFinancialJournal.prepareFresh>[2]={}):Promise<void>{
  let started=false,preparation:ReturnType<typeof HostFinancialJournal.prepareFresh>|undefined;
  try{
    if((await db.query('BEGIN')).command!=='BEGIN')throw new Error('Fresh custody transaction unavailable');started=true;
    await db.query('LOCK TABLE budget_accounts,budget_windows,budget_gateway_bindings,budget_attempts,budget_gateway_grants,budget_financial_checkpoints IN ACCESS EXCLUSIVE MODE');
    const rows=(await db.query(`SELECT EXISTS(SELECT 1 FROM budget_accounts UNION ALL SELECT 1 FROM budget_windows UNION ALL SELECT 1 FROM budget_gateway_bindings UNION ALL SELECT 1 FROM budget_attempts UNION ALL SELECT 1 FROM budget_gateway_grants UNION ALL SELECT 1 FROM budget_financial_checkpoints) AS populated`)).rows;
    if(rows.length!==1||rows[0].populated!==false)throw new Error('Existing financial state requires recovery');
    preparation=HostFinancialJournal.prepareFresh(directory,await observeFinancialDatabase(db),options);
    if((await db.query('COMMIT')).command!=='COMMIT')throw new Error('Fresh custody transaction unavailable');started=false;
    preparation.complete();
  }finally{try{if(started)await db.query('ROLLBACK').catch(()=>{});}finally{preparation?.close();}}
}
