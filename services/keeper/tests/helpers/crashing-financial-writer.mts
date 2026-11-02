/** A real process doing one real financial write, killed at a chosen point. Argument `kill` is the
 * number of the fsync to die after, or `commit-sent` to die with COMMIT on its way and unanswered. */
import {fsyncSync} from 'node:fs';
import pg from 'pg';
import {consoleSourceTransaction,noteBudgetFinancialChange,type SourcePool} from '@lares/agent-kit/console-source-transaction';
import {HostFinancialJournal} from '../../lib/financial-journal.js';
import {JournalBudgetFinancialWriter} from '../../lib/budget-financial-writer.js';
import {platformTestJournalLock} from './financial-journal.js';
const [directory,connectionString,attempt,kill,publishes]=process.argv.slice(2) as [string,string,string,string,string|undefined];
const die=()=>{process.kill(process.pid,'SIGKILL');};
let synced=0;
const journal=HostFinancialJournal.openExisting(directory,{ownershipUid:process.getuid!(),lock:platformTestJournalLock,requirePrepared:true,sync:fd=>{fsyncSync(fd);if(String(++synced)===kill)die();}});
const pool=new pg.Pool({connectionString,max:1});pool.on('error',()=>{});
const source={query:pool.query.bind(pool),connect:async()=>{
  const client=await pool.connect();
  return {release:(broken?:boolean)=>client.release(broken),query:(text:string,values?:unknown[])=>{
    if(text==='COMMIT'&&kill==='commit-sent'){void client.query(text);setImmediate(die);return new Promise(()=>{});}
    return client.query(text,values as never[]);
  }};
}} as unknown as SourcePool;
const work=(boundary:Parameters<Parameters<JournalBudgetFinancialWriter['run']>[1]>[0])=>consoleSourceTransaction(source,async client=>{
  await client.query("UPDATE budget_attempts SET state='admitted',admitted_at=clock_timestamp() WHERE id=$1",[attempt]);
  noteBudgetFinancialChange(client,'budget_attempts',attempt);
},boundary);
const writer=new JournalBudgetFinancialWriter(journal);
if(publishes)await writer.runWithReceipt('admit',work,()=>{die();return undefined;});
else await writer.run('admit',work);
process.stdout.write('survived\n');process.exit(0);
