/** Server-only observation on the caller's actual owned PostgreSQL connection. */
import type {SourceDatabase} from '@lares/agent-kit/console-source-transaction';
import {FINANCIAL_DATABASE_SCHEMA,FINANCIAL_CHECKPOINT_SCHEMA,HostFinancialJournal} from './financial-journal.js';
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
export async function verifyFinancialContinuity(journal:HostFinancialJournal,db:SourceDatabase,proposed=false):Promise<void>{
  try{journal.verifyContinuity(await observeFinancialDatabase(db),await observeFinancialCheckpoint(db),proposed);}
  catch{journal.freeze();throw new Error('Financial continuity requires recovery');}
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
