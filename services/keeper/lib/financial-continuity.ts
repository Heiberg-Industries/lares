/** Server-only observation on the caller's actual owned PostgreSQL connection. */
import {querySourceBounded,sourceObservationCommit,type SourceDatabase,type SourceObservationCommit} from '@lares/agent-kit/console-source-transaction';
import {gatewayCanonical,gatewayHash} from '@lares/agent-kit/gateway-admission-protocol';
import {FINANCIAL_DATABASE_SCHEMA,FINANCIAL_CHECKPOINT_SCHEMA,HostFinancialJournal,financialAtomKey,type FinancialAtom,type FinancialCheckpoint,type FinancialProjection,type FinancialObservation} from './financial-journal.js';
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
async function observeFinancialProjection(db:SourceDatabase,projection:FinancialProjection):Promise<{checkpoints:FinancialCheckpoint[];atoms:FinancialAtom[]}> {
  const expectedAtoms=projection.atoms.filter(atom=>atom.kind!=='tombstone');
  const expectedCounts={accounts:expectedAtoms.filter(atom=>atom.kind==='account').length,windows:expectedAtoms.filter(atom=>atom.kind==='window').length,bindings:expectedAtoms.filter(atom=>atom.kind==='binding').length,attempts:expectedAtoms.filter(atom=>atom.kind==='attempt').length,grants:expectedAtoms.filter(atom=>atom.kind==='grant').length,checkpoints:projection.checkpoints.length};
  const countRows=(await db.query(`SELECT
    (SELECT count(*)::text FROM budget_accounts) AS accounts,
    (SELECT count(*)::text FROM budget_windows) AS windows,
    (SELECT count(*)::text FROM budget_gateway_bindings) AS bindings,
    (SELECT count(*)::text FROM budget_attempts) AS attempts,
    (SELECT count(*)::text FROM budget_gateway_grants) AS grants,
    (SELECT count(*)::text FROM budget_financial_checkpoints) AS checkpoints`)).rows;
  if(countRows.length!==1)throw new Error('Financial projection unavailable');
  for(const [name,expected] of Object.entries(expectedCounts)){
    const count=Number(countRows[0][name]);if(!Number.isSafeInteger(count)||count!==expected)throw new Error('Financial projection mismatch');
  }

  let checkpoints:FinancialCheckpoint[]=[];
  if(projection.checkpoints.length){
    const rows=(await db.query(`SELECT operation_id AS "operationId",journal_id AS "journalId",proposal_sequence::text AS sequence,proposal_digest AS digest
      FROM budget_financial_checkpoints WHERE proposal_sequence=ANY($1::bigint[]) ORDER BY proposal_sequence`,[projection.checkpoints.map(checkpoint=>String(checkpoint.sequence))])).rows;
    if(rows.length!==projection.checkpoints.length)throw new Error('Financial checkpoint projection mismatch');
    checkpoints=rows.map(row=>FINANCIAL_CHECKPOINT_SCHEMA.parse({...row,sequence:Number(row.sequence)}));
  }

  const atoms:FinancialAtom[]=[];
  const tables=[
    {kind:'account' as const,sql:'SELECT * FROM budget_accounts WHERE id=ANY($1::uuid[]) ORDER BY id'},
    {kind:'window' as const,sql:`SELECT *,${FINANCIAL_UTC_TIMESTAMP('starts_at')} AS starts_utc,${FINANCIAL_UTC_TIMESTAMP('ends_at')} AS ends_utc FROM budget_windows WHERE id=ANY($1::uuid[]) ORDER BY id`},
    {kind:'binding' as const,sql:'SELECT * FROM budget_gateway_bindings WHERE id=ANY($1::uuid[]) ORDER BY id'},
    {kind:'attempt' as const,sql:`SELECT *,${FINANCIAL_UTC_TIMESTAMP('created_at')} AS created_utc,${FINANCIAL_UTC_TIMESTAMP('expires_at')} AS expires_utc,${FINANCIAL_UTC_TIMESTAMP('admitted_at')} AS admitted_utc FROM budget_attempts WHERE id=ANY($1::uuid[]) ORDER BY id`},
    {kind:'grant' as const,sql:'SELECT * FROM budget_gateway_grants WHERE attempt_id=ANY($1::uuid[]) ORDER BY attempt_id'},
  ];
  for(const table of tables){
    const expected=expectedAtoms.filter((atom)=>atom.kind===table.kind);
    if(!expected.length)continue;
    const ids=expected.map(atom=>atom.kind==='grant'?atom.attemptId:atom.id);
    const rows=(await db.query(table.sql,[ids])).rows;if(rows.length!==expected.length)throw new Error('Financial row projection mismatch');
    for(const row of rows)atoms.push(financialAtomFromRow(table.kind,row));
  }
  atoms.sort((left,right)=>financialAtomKey(left).localeCompare(financialAtomKey(right)));
  return {checkpoints,atoms};
}
export async function verifyFinancialContinuity(journal:HostFinancialJournal,db:SourceDatabase,proposed=false):Promise<void>{
  try{
    const projection=journal.expectedProjection(proposed),database=await observeFinancialDatabase(db),observed=await observeFinancialProjection(db,projection);
    journal.verifyContinuity(database,observed.checkpoints,observed.atoms,proposed);
  }
  catch{journal.freeze();throw new Error('Financial continuity requires recovery');}
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
    const counts={accounts:observed.atoms.filter(atom=>atom.kind==='account').length,windows:observed.atoms.filter(atom=>atom.kind==='window').length,
      bindings:observed.atoms.filter(atom=>atom.kind==='binding').length,attempts:observed.atoms.filter(atom=>atom.kind==='attempt').length,
      grants:observed.atoms.filter(atom=>atom.kind==='grant').length,checkpoints:observed.checkpoints.length};
    const observation:FinancialObservation={operationId,checkpoint,database,
      projectionDigest:gatewayHash(gatewayCanonical({checkpoints:observed.checkpoints,atoms:projection.atoms})),
      checkpointDigest:gatewayHash(gatewayCanonical(observed.checkpoints)),counts};
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
