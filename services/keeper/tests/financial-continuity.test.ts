import {afterEach,expect,it,vi} from 'vitest';
import {chmodSync,fsyncSync,mkdtempSync,readFileSync,realpathSync,rmSync,unlinkSync,writeFileSync,readdirSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {HostFinancialJournal,type FinancialDatabase} from '../lib/financial-journal.js';
import {prepareFinancialCustody,verifyFinancialContinuity} from '../lib/financial-continuity.js';
import {platformTestJournalLock,testJournalUid} from './helpers/financial-journal.js';
const database:FinancialDatabase={systemIdentifier:'74683378529478211',postmasterStartedAt:'2026-10-22T00:00:00.123456Z',databaseOid:'16384'};
const options={ownershipUid:testJournalUid,lock:platformTestJournalLock};
const roots:string[]=[],journals:HostFinancialJournal[]=[];
function location(){const root=mkdtempSync(join(realpathSync(tmpdir()),'lares-custody-'));chmodSync(root,0o700);roots.push(root);return join(root,'financial');}
function establish(directory:string,selected:Parameters<typeof HostFinancialJournal.prepareFresh>[2]=options){const preparation=HostFinancialJournal.prepareFresh(directory,database,selected);try{preparation.complete();}finally{preparation.close();}}
function prepared(){const directory=location();establish(directory);return directory;}
function open(directory:string,extra:Parameters<typeof HostFinancialJournal.openExisting>[1]={}){const j=HostFinancialJournal.openExisting(directory,{...options,requirePrepared:true,...extra});journals.push(j);return j;}
function records(directory:string){return readFileSync(join(directory,'journal.jsonl'),'utf8').trimEnd().split('\n').map(line=>JSON.parse(line).record);}
afterEach(()=>{vi.restoreAllMocks();for(const j of journals.splice(0)){try{j.close();}catch{}}for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
it('prepares receipt before creating key/genesis, with strict private file modes',()=>{
  const directory=location(),seen:string[][]=[];
  establish(directory,{...options,sync:fd=>{fsyncSync(fd);seen.push(readdirSync(directory));}});
  const firstKey=seen.findIndex(files=>files.includes('suppression.key'));
  expect(firstKey).toBeGreaterThan(0);expect(seen[firstKey-1]).toContain('first-use.json');expect(seen[firstKey-1]).not.toContain('suppression.key');
  for(const name of readdirSync(directory))expect(lstatSync(join(directory,name)).mode&0o777).toBe(0o600);
  expect(()=>open(directory)).not.toThrow();
});
it.each([1,2,3,4,5,6,7,8,9])('an interrupted fresh ceremony cannot be retried or adopted (fsync %s)',failure=>{
  const directory=location();let step=0;
  expect(()=>establish(directory,{...options,sync:fd=>{fsyncSync(fd);if(++step===failure)throw new Error('interrupted');}})).toThrow('interrupted');
  expect(()=>HostFinancialJournal.prepareFresh(directory,database,options)).toThrow();
  // Last fsync uncertainty also cannot become a successful same-host retry.
  expect(readdirSync(directory).length).toBeGreaterThanOrEqual(failure>1?1:0);
});
it.each(['missing-key','replacement-key','unsafe-key','missing-receipt','partial-ceremony'])('requires recovery for %s',kind=>{
  const directory=prepared();
  if(kind==='missing-key')unlinkSync(join(directory,'suppression.key'));
  if(kind==='replacement-key')writeFileSync(join(directory,'suppression.key'),Buffer.alloc(32,12));
  if(kind==='unsafe-key')chmodSync(join(directory,'suppression.key'),0o644);
  if(kind==='missing-receipt')unlinkSync(join(directory,'first-use.json'));
  if(kind==='partial-ceremony')unlinkSync(join(directory,'journal.jsonl'));
  expect(()=>open(directory)).toThrow();expect(()=>HostFinancialJournal.prepareFresh(directory,database,options)).toThrow();
});
it('allows a clean keeper-only restart with the identical running PostgreSQL identity',async()=>{
  const directory=prepared(),j=open(directory);j.verifyContinuity(database,null);
  await j.drainForShutdown();j.close();const next=open(directory);expect(()=>next.verifyContinuity(database,null)).not.toThrow();
});
it.each(['postmasterStartedAt','systemIdentifier','databaseOid'])('durably freezes changed database identity %s, even with matching retained state',field=>{
  const directory=prepared(),j=open(directory),changed={...database,[field]:field==='postmasterStartedAt'?'2026-10-22T00:00:00.123457Z':'16385'};
  expect(()=>j.verifyContinuity(changed,null)).toThrow('recovery');j.close();
  const next=open(directory);expect(()=>next.verifyContinuity(database,null)).toThrow('recovery');expect(records(directory).some(r=>r.kind==='freeze')).toBe(true);
});
function child(code:string):{process:ChildProcessWithoutNullStreams;ready:Promise<void>;done:Promise<number|null>}{
  const process=spawn(globalThis.process.execPath,['--import','tsx','--input-type=module','-e',code],{stdio:'pipe'});
  let stderr='';process.stderr.on('data',bytes=>{stderr+=bytes;});
  const done=new Promise<number|null>((resolve,reject)=>{process.once('error',reject);process.once('close',(code,signal)=>{if(signal==='SIGKILL')resolve(null);else if(code===0||code===75)resolve(code);else reject(new Error(`Custody child failed: ${stderr}`));});});
  const ready=new Promise<void>((resolve,reject)=>{let text='';process.stdout.on('data',bytes=>{text+=bytes;if(text.includes('ready\n'))resolve();});process.once('error',reject);process.once('exit',()=>reject(new Error('Custody child exited before readiness')));});
  return {process,ready,done};
}
const childImports=`import {HostFinancialJournal} from ${JSON.stringify(new URL('../lib/financial-journal.ts',import.meta.url).href)};
import {platformTestJournalLock} from ${JSON.stringify(new URL('./helpers/financial-journal.ts',import.meta.url).href)};`;
it('only one competing process can establish first-use custody',async()=>{
  const directory=location(),code=childImports+`
process.stdout.write('ready\\n');process.stdin.once('data',()=>{try{const p=HostFinancialJournal.prepareFresh(${JSON.stringify(directory)},${JSON.stringify(database)},{ownershipUid:process.getuid(),lock:platformTestJournalLock});try{p.complete();}finally{p.close();}process.exitCode=0;}catch{process.exitCode=75;}process.stdin.destroy();});`;
  const a=child(code),b=child(code);
  try{await Promise.all([a.ready,b.ready]);a.process.stdin.end('go');b.process.stdin.end('go');expect((await Promise.all([a.done,b.done])).sort()).toEqual([0,75]);}
  finally{a.process.kill();b.process.kill();}
  const history=records(directory),receipt=JSON.parse(readFileSync(join(directory,'first-use.json'),'utf8'));
  expect(history.map(r=>r.kind)).toEqual(['genesis','control','preparation-complete']);expect(history[0].journalId).toBe(receipt.journalId);expect(()=>open(directory).verifyContinuity(database,null)).not.toThrow();
},10_000);
it('permanently freezes an abandoned prepared writer after actual process termination',async()=>{
  const directory=prepared(),holder=child(childImports+`const j=HostFinancialJournal.openExisting(${JSON.stringify(directory)},{ownershipUid:process.getuid(),lock:platformTestJournalLock,requirePrepared:true});process.stdout.write('ready\\n');setInterval(()=>{},1000);`);
  try{
    await holder.ready;expect(()=>open(directory)).toThrow('unavailable');
    expect(records(directory).at(-1)?.kind).toBe('writer-open');expect(records(directory).some(r=>r.kind==='freeze')).toBe(false);
    holder.process.kill('SIGKILL');await holder.done;
    const next=open(directory); // persists freeze while acquiring ownership, before any observation/work
    expect(records(directory).at(-1)).toMatchObject({kind:'freeze',reason:'uncertain'});
    expect(()=>next.verifyContinuity(database,null)).toThrow('recovery');
    let called=false;await expect(next.operation('admit',async()=>{called=true;})).rejects.toThrow('closed');expect(called).toBe(false);next.close();
    expect(()=>open(directory).verifyContinuity(database,null)).toThrow('recovery');
  }finally{holder.process.kill('SIGKILL');}
},10_000);
it('orders checkpoint control fsync after commit before exposing success and verifies it on restart',async()=>{
  const directory=prepared(),j=open(directory);let checkpoint:any;
  await j.operation('admit',async id=>{const p=j.propose(id,[]);checkpoint={operationId:p.operationId,journalId:p.journalId,sequence:p.sequence,digest:p.digest};j.verifyContinuity(database,checkpoint,true);j.committed(id);expect(records(directory).at(-1)?.kind).toBe('control');});
  j.close();const next=open(directory);expect(()=>next.verifyContinuity(database,checkpoint)).not.toThrow();expect(()=>next.verifyContinuity(database,null)).toThrow('recovery');
});
it('unknown observation durably freezes; a later matching database never clears it',async()=>{
  const directory=prepared(),j=open(directory);
  await expect(verifyFinancialContinuity(j,{query:async()=>{throw new Error('unknown');}})).rejects.toThrow('recovery');
  expect(()=>j.verifyContinuity(database,null)).toThrow('recovery');expect(records(directory).at(-1)?.kind).toBe('freeze');
});
it('stops new operations synchronously while draining an active operation before freeze acknowledgement',async()=>{
  const directory=prepared(),j=open(directory);let resume!:()=>void;
  const active=j.operation('admit',async id=>{await new Promise<void>(resolve=>{resume=resolve;});j.propose(id,[]);j.committed(id);});
  const freeze=j.freezeForRestore();await expect(j.operation('admit',async()=>undefined)).rejects.toThrow('closed');
  expect(records(directory).at(-1)?.kind).toBe('begin');resume();await active;await freeze;
  expect(records(directory).at(-1)?.kind).toBe('freeze');j.close();expect(()=>open(directory).verifyContinuity(database,null)).toThrow();
});
it('withholds freeze acknowledgement if an active operation cannot drain',async()=>{
  const directory=prepared(),j=open(directory);let resume!:()=>void;
  const active=j.operation('admit',async id=>{await new Promise<void>(resolve=>{resume=resolve;});j.aborted(id,'not-started');});
  await expect(j.freezeForRestore(5)).rejects.toThrow('did not drain');resume();await active;await expect(j.operation('admit',async()=>undefined)).rejects.toThrow('closed');
});
it('withholds freeze acknowledgement on fsync failure and refuses a competing dead-keeper fallback owner',async()=>{
  const directory=prepared();let fail=false;const j=open(directory,{sync:fd=>{fsyncSync(fd);if(fail)throw new Error('disk unavailable');}});
  expect(()=>open(directory)).toThrow('unavailable');fail=true;await expect(j.freezeForRestore()).rejects.toThrow('unavailable');fail=false;
  await expect(j.operation('admit',async()=>undefined)).rejects.toThrow('closed');
});
it('locks every budget table before receipt and refuses an old empty DB reinitialization',async()=>{
  const directory=location(),queries:string[]=[];
  const db={query:async(sql:string)=>{queries.push(sql);if(sql.startsWith('SELECT EXISTS'))return {rows:[{populated:false}]};if(sql.includes('pg_control_system'))return {rows:[database]};return {rows:[],command:sql};}};
  await prepareFinancialCustody(directory,db,options);
  expect(queries[1]).toContain('budget_accounts,budget_windows,budget_gateway_bindings,budget_attempts,budget_gateway_grants,budget_financial_checkpoints');
  await expect(prepareFinancialCustody(directory,db,options)).rejects.toThrow();expect(queries.at(-1)).toBe('ROLLBACK');
});
it('refuses nonempty financial tables before creating any custody',async()=>{
  const directory=location();const db={query:async(sql:string)=>sql.startsWith('SELECT EXISTS')?{rows:[{populated:true}]}:{rows:[],command:sql}};
  await expect(prepareFinancialCustody(directory,db,options)).rejects.toThrow('Existing financial');expect(()=>readdirSync(directory)).toThrow();
});

it('observes continuity on the owned single client before mutation and after checkpoint before COMMIT',async()=>{
  const {JournalBudgetFinancialWriter}=await import('../lib/budget-financial-writer.js');
  const {consoleSourceTransaction}=await import('@lares/agent-kit/console-source-transaction');
  const directory=prepared(),journal=open(directory),writer=new JournalBudgetFinancialWriter(journal),queries:string[]=[];
  let checkpoint:any=null,connections=0,releases=0;
  const db={release:()=>{releases++;},query:async(sql:string,values?:any[])=>{
    queries.push(sql);
    if(sql.includes('pg_control_system'))return {rows:[database]};
    if(sql.startsWith('SELECT operation_id'))return {rows:checkpoint?[checkpoint]:[]};
    if(sql.startsWith('INSERT INTO budget_financial_checkpoints'))checkpoint={operationId:values![0],journalId:values![1],sequence:String(values![2]),digest:values![3]};
    return {rows:[],command:sql};
  }};
  const pool={query:db.query,connect:async()=>{connections++;return db;}};
  await expect(writer.run('prepare',boundary=>consoleSourceTransaction(pool,async owned=>{await owned.query('MUTATION');return 'complete';},boundary))).resolves.toBe('complete');
  expect(connections).toBe(1);expect(releases).toBe(1);
  const observations=queries.map((q,i)=>q.includes('pg_control_system')?i:-1).filter(i=>i>=0);
  expect(observations).toHaveLength(2);expect(observations[0]).toBeLessThan(queries.indexOf('MUTATION'));
  expect(observations[1]).toBeGreaterThan(queries.findIndex(q=>q.startsWith('INSERT INTO budget_financial_checkpoints')));expect(observations[1]).toBeLessThan(queries.indexOf('COMMIT'));
  expect(records(directory).at(-1)?.kind).toBe('control');
});

it('expires authority during ready-to-commit observation and selects only source-retirement compensation',async()=>{
  const {consoleSourceTransaction,sourceTransactionBoundary,gateConsoleOrganisation,retainConsoleSourceDeadline}=await import('@lares/agent-kit/console-source-transaction');
  const queries:string[]=[],outcomes:string[]=[],binding={agent:'probe-agent',incarnation:'11111111-1111-4111-8111-111111111111',sessionId:'probe-session',memberId:'probe-member',admissionNonce:'probe-nonce'};
  let expired=false,financialPending=false,financialCommitted=false,retired=false,deadlineChecksAfterReady=0;
  const db={release:()=>{},query:async(sql:string)=>{
    queries.push(sql);
    if(sql.startsWith('SELECT org_id AS organisation_id'))return {rows:[{organisation_id:'probe-org'}]};
    if(sql.startsWith('SELECT id FROM orgs'))return {rows:[{id:'probe-org'}]};
    if(sql.includes('FROM users WHERE id=$1 AND status'))return {rows:[{id:'probe-member',org_id:'probe-org',org_role:'owner',status:'active',automation_mode:'draft-and-ask'}]};
    if(sql.startsWith('SELECT 1 WHERE')){if(expired)deadlineChecksAfterReady++;return {rows:expired?[]:[{one:1}]};}
    if(sql.startsWith('SELECT min(deadline)'))return {rows:[{deadline:'2026-10-22 00:00:00.123456+00'}]};
    if(sql==='FINANCIAL_MUTATION')financialPending=true;
    if(sql==='ROLLBACK')financialPending=false;
    if(sql.startsWith('UPDATE console_session_bindings'))retired=true;
    if(sql==='COMMIT'&&financialPending)financialCommitted=true;
    return {rows:[],command:sql};
  }};
  const pool={query:db.query,connect:async()=>db};
  const boundary=sourceTransactionBoundary({beforeCommit:async()=>{},readyToCommit:async()=>{queries.push('READY_OBSERVATION');expired=true;},settled:async outcome=>{outcomes.push(outcome);}});
  await expect(consoleSourceTransaction(pool,async owned=>{await gateConsoleOrganisation(owned,binding.memberId,binding);retainConsoleSourceDeadline(owned,binding,'2026-10-22 00:00:00.123456+00');await owned.query('FINANCIAL_MUTATION');return 'must not escape';},boundary)).rejects.toThrow('not available');
  expect(deadlineChecksAfterReady).toBe(1);expect(financialCommitted).toBe(false);expect(retired).toBe(true);
  expect(outcomes).toEqual(['source-retirement-acknowledged']);expect(queries.indexOf('ROLLBACK')).toBeGreaterThan(queries.indexOf('READY_OBSERVATION'));expect(queries.filter(q=>q==='COMMIT')).toHaveLength(1);
});

it.each(['commit-throw','commit-unknown','completion-fsync'])('a preparation fault after durable initial files cannot look completed: %s',async failure=>{
  const directory=location();let completion=false;
  const db={query:async(sql:string)=>{
    if(sql.startsWith('SELECT EXISTS'))return {rows:[{populated:false}]};
    if(sql.includes('pg_control_system'))return {rows:[database]};
    if(sql==='COMMIT'){
      expect(records(directory).map(r=>r.kind)).toEqual(['genesis','control']);
      // The same kernel owner is retained through the actual COMMIT acknowledgement.
      expect(()=>HostFinancialJournal.openExisting(directory,{...options,requirePrepared:true})).toThrow('unavailable');
      if(failure==='commit-throw')throw new Error('lost COMMIT acknowledgement');
      if(failure==='commit-unknown')return {rows:[],command:'UNKNOWN'};
      completion=true;
    }
    return {rows:[],command:sql};
  }};
  await expect(prepareFinancialCustody(directory,db,{...options,sync:fd=>{fsyncSync(fd);if(failure==='completion-fsync'&&completion){completion=false;throw new Error('completion fsync unavailable');}}})).rejects.toThrow();
  const history=records(directory);expect(history.some(r=>r.kind==='freeze')).toBe(true);
  expect(()=>open(directory).verifyContinuity(database,null)).toThrow('recovery');expect(()=>establish(directory)).toThrow();
});
it('initial files without preparation completion require recovery before any result',()=>{
  const directory=location(),preparation=HostFinancialJournal.prepareFresh(directory,database,options);
  preparation.close();expect(records(directory).some(r=>r.kind==='preparation-complete')).toBe(false);
  expect(()=>open(directory).verifyContinuity(database,null)).toThrow('recovery');
});

it('a refused preparation-completion write leaves missing completion recovery-only',async()=>{
  const directory=location();
  const db={query:async(sql:string)=>{
    if(sql.startsWith('SELECT EXISTS'))return {rows:[{populated:false}]};
    if(sql.includes('pg_control_system'))return {rows:[database]};
    if(sql==='COMMIT')chmodSync(join(directory,'journal.jsonl'),0o400);
    return {rows:[],command:sql};
  }};
  await expect(prepareFinancialCustody(directory,db,options)).rejects.toThrow();
  expect(records(directory).some(r=>r.kind==='preparation-complete')).toBe(false);
  chmodSync(join(directory,'journal.jsonl'),0o600);
  expect(()=>open(directory).verifyContinuity(database,null)).toThrow('recovery');expect(records(directory).some(r=>r.kind==='freeze')).toBe(true);
});

it.each(['missing-completion','missing-receipt','mismatched-receipt-journal','mismatched-receipt-key','missing-completion-and-receipt'])('default open cannot expose a writer result from invalid prepared custody: %s',async failure=>{
  const {JournalBudgetFinancialWriter}=await import('../lib/budget-financial-writer.js');
  const {consoleSourceTransaction}=await import('@lares/agent-kit/console-source-transaction');
  const directory=prepared(),path=join(directory,'journal.jsonl'),receiptPath=join(directory,'first-use.json');
  if(failure.includes('completion'))writeFileSync(path,readFileSync(path,'utf8').split('\n').slice(0,2).join('\n')+'\n');
  if(failure==='missing-receipt'||failure==='missing-completion-and-receipt')unlinkSync(receiptPath);
  if(failure.startsWith('mismatched')){
    const receipt=JSON.parse(readFileSync(receiptPath,'utf8'));
    if(failure.endsWith('journal'))receipt.journalId='11111111-1111-4111-8111-111111111111';
    else receipt.suppressionKeyFingerprint='f'.repeat(64);
    writeFileSync(receiptPath,JSON.stringify(receipt)+'\n');
  }
  const before=readFileSync(path);let connected=false,mutated=false,checkpoint:any=null;
  const db={release:()=>{},query:async(sql:string,values?:any[])=>{
    if(sql.includes('pg_control_system'))return {rows:[database]};
    if(sql.startsWith('SELECT operation_id'))return {rows:checkpoint?[checkpoint]:[]};
    if(sql.startsWith('INSERT INTO budget_financial_checkpoints'))checkpoint={operationId:values![0],journalId:values![1],sequence:String(values![2]),digest:values![3]};
    if(sql==='MUTATION')mutated=true;
    return {rows:[],command:sql};
  }};
  const pool={query:db.query,connect:async()=>{connected=true;return db;}};
  const result=(async()=>{
    // Deliberately omit requirePrepared: control-bearing histories must protect themselves.
    const journal=HostFinancialJournal.openExisting(directory,options);journals.push(journal);
    return new JournalBudgetFinancialWriter(journal).run('prepare',boundary=>consoleSourceTransaction(pool,async owned=>{await owned.query('MUTATION');return 'escaped-result';},boundary));
  })();
  await expect(result).rejects.toThrow(/unavailable|closed/);expect(connected).toBe(false);expect(mutated).toBe(false);expect(checkpoint).toBeNull();
  expect(records(directory).some(r=>r.kind==='writer-open'||r.kind==='begin'||r.kind==='commit')).toBe(false);
  if(failure!=='missing-completion')expect(readFileSync(path)).toEqual(before); // invalid receipt is rejected before any adoption/freeze write
});
it('default open permits completed prepared custody with its original receipt',async()=>{
  const directory=prepared(),journal=HostFinancialJournal.openExisting(directory,options);journals.push(journal);
  expect(journal.prepared).toBe(true);expect(()=>journal.verifyContinuity(database,null)).not.toThrow();
  await expect(journal.operation('prepare',async id=>{journal.propose(id,[]);journal.committed(id);return 'completed';})).resolves.toBe('completed');
});
