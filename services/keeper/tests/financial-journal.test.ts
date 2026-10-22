import {afterEach,expect,it,vi} from 'vitest';
import {chmodSync,fsyncSync,readFileSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {HostFinancialJournal,FINANCIAL_ATOM_SCHEMA,financialJournalFrame,JOURNAL_MAX_RECORDS,committedFinancialEvidence,markJournaledAbort,isJournaledAbort,type CommittedFinancialReceipt,type DurableFinancialAbortReceipt,type FinancialAbortOutcome} from '../lib/financial-journal.js';
import {journalFixture,platformTestJournalLock,testJournalUid} from './helpers/financial-journal.js';
import * as sourceTransactions from '@lares/agent-kit/console-source-transaction';
import {JournalBudgetFinancialWriter} from '../lib/budget-financial-writer.js';
const fixtures:ReturnType<typeof journalFixture>[]=[],journals:HostFinancialJournal[]=[];
const fixture=(options:Parameters<typeof journalFixture>[0]={})=>{const f=journalFixture(options);fixtures.push(f);return f;};
const open=(f:ReturnType<typeof fixture>)=>{const j=f.open();journals.push(j);return j;};
function preparedJournal(sync?:(fd:number)=>void){
  const f=fixture(),directory=join(f.directory,'prepared'),options={ownershipUid:testJournalUid,lock:platformTestJournalLock},database={systemIdentifier:'74683378529478211',postmasterStartedAt:'2026-10-22T00:00:00.123456Z',databaseOid:'16384'};
  const preparation=HostFinancialJournal.prepareFresh(directory,database,options);try{preparation.complete();}finally{preparation.close();}
  const j=HostFinancialJournal.openExisting(directory,{...options,requirePrepared:true,...(sync?{sync}:{})});journals.push(j);return j;
}
afterEach(()=>{vi.restoreAllMocks();for(const j of journals.splice(0))j.close();for(const f of fixtures.splice(0))rmSync(f.directory,{recursive:true,force:true});});
it.each<FinancialAbortOutcome>(['not-started','rollback-acknowledged','source-retirement-acknowledged','source-retirement-rolled-back'])('marks only the original finished durable abort for %s',async outcome=>{
  const j=preparedJournal(),error=new Error('synthetic refusal'),expected={journalId:j.id,operation:'erase-person' as const};let receipt:DurableFinancialAbortReceipt|undefined;
  await expect(j.operation('erase-person',async id=>{
    receipt=j.aborted(id,outcome);expect(receipt).toMatchObject({journalId:j.id,operationId:id,operation:'erase-person',outcome});
    markJournaledAbort(error,receipt);expect(isJournaledAbort(error,expected)).toBe(false);throw error;
  })).rejects.toBe(error);
  const unrelated=new Error('unrelated failure');markJournaledAbort(unrelated,receipt);expect(isJournaledAbort(unrelated,expected)).toBe(false);
  markJournaledAbort(error,receipt);expect(isJournaledAbort(error,expected)).toBe(true);expect(Object.isFrozen(receipt)).toBe(true);
  expect(isJournaledAbort(error,{...expected,journalId:randomUUID()})).toBe(false);expect(isJournaledAbort(error,{...expected,operation:'member-remove'})).toBe(false);
  const copiedError=Object.assign(new Error(error.message),error),other=new Error('different failure');expect(isJournaledAbort(copiedError,expected)).toBe(false);
  for(const forged of [{...receipt},JSON.parse(JSON.stringify(receipt))] as DurableFinancialAbortReceipt[]){markJournaledAbort(other,forged);expect(isJournaledAbort(other,expected)).toBe(false);}
  markJournaledAbort(other,receipt);expect(isJournaledAbort(other,expected)).toBe(false);
});
it('cannot mark a failure using proof from an operation that returned after its abort',async()=>{
  const j=preparedJournal(),error=new Error('later unrelated failure');let receipt:DurableFinancialAbortReceipt|undefined;
  await j.operation('erase-person',async id=>{receipt=j.aborted(id,'rollback-acknowledged');});markJournaledAbort(error,receipt);
  expect(isJournaledAbort(error,{journalId:j.id,operation:'erase-person'})).toBe(false);
});
it.each([false,true])('invalidates an earlier abort when the same error is reused by an uncertain operation (marked %s)',async marked=>{
  const j=preparedJournal(),error=new Error('reused refusal'),expected={journalId:j.id,operation:'erase-person' as const};let old:DurableFinancialAbortReceipt|undefined;
  await expect(j.operation('erase-person',async id=>{old=j.aborted(id,'rollback-acknowledged');throw error;})).rejects.toBe(error);
  if(marked)markJournaledAbort(error,old);expect(isJournaledAbort(error,expected)).toBe(marked);
  await expect(j.operation('erase-person',async()=>{j.freeze();throw error;})).rejects.toBe(error);
  expect(isJournaledAbort(error,expected)).toBe(false);markJournaledAbort(error,old);expect(isJournaledAbort(error,expected)).toBe(false);
});
it('mints no abort authority for an unprepared journal',async()=>{
  const j=open(fixture()),error=new Error('synthetic refusal');let receipt:DurableFinancialAbortReceipt|undefined;
  await j.operation('member-remove',async id=>{receipt=j.aborted(id,'rollback-acknowledged');});expect(receipt).toBeUndefined();
  markJournaledAbort(error,receipt);expect(isJournaledAbort(error,{journalId:j.id,operation:'member-remove'})).toBe(false);
});
it.each(['rollback','abort-fsync','unknown','commit-callback-error'])('marks writer errors only after a durable abort (%s)',async mode=>{
  let fail=false;const j=preparedJournal(fd=>{fsyncSync(fd);if(fail)throw new Error('synthetic terminal failure');}),writer=new JournalBudgetFinancialWriter(j),refusal=new Error('synthetic refusal');
  type Hooks=Parameters<typeof sourceTransactions.sourceTransactionBoundary>[0];let hooks!:Hooks;const original=sourceTransactions.sourceTransactionBoundary;
  vi.spyOn(sourceTransactions,'sourceTransactionBoundary').mockImplementation(value=>{hooks=value;return original(value);});
  const result=writer.runWithReceipt('member-remove',async()=>{
    if(mode==='commit-callback-error'){await hooks.beforeCommit({query:async()=>({rows:[]})},[]);await hooks.settled('commit-acknowledged');}
    else{fail=mode==='abort-fsync';await hooks.settled(mode==='unknown'?'unknown':'rollback-acknowledged');}
    throw refusal;
  });
  const error=await result.then(()=>{throw new Error('Failure fixture unexpectedly succeeded');},error=>error);fail=false;
  expect(isJournaledAbort(error,{journalId:j.id,operation:'member-remove'})).toBe(mode==='rollback');if(mode==='rollback'||mode==='commit-callback-error')expect(error).toBe(refusal);
});
it.each([1,2])('mints no committed receipt when terminal/control fsync %s fails',async fault=>{
  const f=fixture(),directory=join(f.directory,'prepared'),database={systemIdentifier:'74683378529478211',postmasterStartedAt:'2026-10-22T00:00:00.123456Z',databaseOid:'16384'},options={ownershipUid:testJournalUid,lock:platformTestJournalLock};
  const preparation=HostFinancialJournal.prepareFresh(directory,database,options);preparation.complete();preparation.close();
  let enabled=false,count=0,result:CommittedFinancialReceipt|undefined;
  const j=HostFinancialJournal.openExisting(directory,{...options,requirePrepared:true,sync:fd=>{fsyncSync(fd);if(enabled&&++count===fault)throw new Error('synthetic fsync failure');}});journals.push(j);
  await expect(j.operation('member-remove',async id=>{j.propose(id,[]);enabled=true;result=j.committed(id);})).rejects.toThrow('unavailable');
  enabled=false;expect(result).toBeUndefined();await expect(j.operation('member-remove',async()=>undefined)).rejects.toThrow('closed');
});
it('runWithReceipt returns actual committed coordinates and refuses a positively aborted transaction',async()=>{
  const f=fixture(),directory=join(f.directory,'prepared'),options={ownershipUid:testJournalUid,lock:platformTestJournalLock},database={systemIdentifier:'74683378529478211',postmasterStartedAt:'2026-10-22T00:00:00.123456Z',databaseOid:'16384'};
  const preparation=HostFinancialJournal.prepareFresh(directory,database,options);try{preparation.complete();}finally{preparation.close();}
  const j=HostFinancialJournal.openExisting(directory,{...options,requirePrepared:true});journals.push(j);const writer=new JournalBudgetFinancialWriter(j);
  type Hooks=Parameters<typeof sourceTransactions.sourceTransactionBoundary>[0];let hooks!:Hooks;const original=sourceTransactions.sourceTransactionBoundary;
  vi.spyOn(sourceTransactions,'sourceTransactionBoundary').mockImplementation(value=>{hooks=value;return original(value);});
  const result=await writer.runWithReceipt('member-remove',async()=>{await hooks.beforeCommit({query:async()=>({rows:[]})},[]);await hooks.settled('commit-acknowledged');return 'done';});
  expect(result.value).toBe('done');const proposal=readFileSync(join(directory,'journal.jsonl'),'utf8').trimEnd().split('\n').map(line=>JSON.parse(line)).find(f=>f.record.kind==='proposal');
  expect(result.receipt).toMatchObject({journalId:j.id,operation:'member-remove',operationId:proposal.record.operationId,proposalSequence:proposal.record.sequence,proposalDigest:proposal.digest});expect(Object.isFrozen(result.receipt)).toBe(true);
  expect(committedFinancialEvidence({...result.receipt},{kind:'account-erasure',accountId:randomUUID()})).toBeUndefined();
  let abortPublished=false;
  const aborted=writer.runWithReceipt('member-remove',async()=>{await hooks.settled('rollback-acknowledged');return 'aborted';},()=>{abortPublished=true;return undefined;});
  await expect(aborted).rejects.toThrow('receipt unavailable');const missingReceipt=await aborted.catch(error=>error);
  expect(abortPublished).toBe(false);
  expect(isJournaledAbort(missingReceipt,{journalId:j.id,operation:'member-remove'})).toBe(false);
  await expect(writer.run('member-remove',async()=>{await hooks.settled('rollback-acknowledged');return 'existing behavior';})).resolves.toBe('existing behavior');
});
it('keeps the real journal barrier through current-receipt publication',async()=>{
  const j=preparedJournal(),writer=new JournalBudgetFinancialWriter(j);
  type Hooks=Parameters<typeof sourceTransactions.sourceTransactionBoundary>[0];let hooks!:Hooks;const original=sourceTransactions.sourceTransactionBoundary;
  vi.spyOn(sourceTransactions,'sourceTransactionBoundary').mockImplementation(value=>{hooks=value;return original(value);});
  let competing:Promise<void>|undefined,published:CommittedFinancialReceipt|undefined;
  const result=await writer.runWithReceipt('provision',async()=>{await hooks.beforeCommit({query:async()=>({rows:[]})},[]);await hooks.settled('commit-acknowledged');return 'bound';},receipt=>{
    published=receipt;expect(receipt.operation).toBe('provision');expect(receipt.journalId).toBe(j.id);
    // This is the same journal gate used by gateway-budget writes and member removal.
    competing=j.operation('member-remove',async()=>undefined);
    return undefined;
  });
  expect(result.value).toBe('bound');expect(published).toBe(result.receipt);expect(competing).toBeDefined();
  await expect(competing).rejects.toThrow('busy');
  await expect(j.operation('member-remove',async operationId=>{j.propose(operationId,[]);j.committed(operationId);})).resolves.toBeUndefined();
});
it('durably freezes when current-receipt publication fails inside the barrier',async()=>{
  const j=preparedJournal(),writer=new JournalBudgetFinancialWriter(j),publicationFailure=new Error('native receipt publication failed');
  type Hooks=Parameters<typeof sourceTransactions.sourceTransactionBoundary>[0];let hooks!:Hooks;const original=sourceTransactions.sourceTransactionBoundary;
  vi.spyOn(sourceTransactions,'sourceTransactionBoundary').mockImplementation(value=>{hooks=value;return original(value);});
  await expect(writer.runWithReceipt('provision',async()=>{await hooks.beforeCommit({query:async()=>({rows:[]})},[]);await hooks.settled('commit-acknowledged');return 'bound';},()=>{throw publicationFailure;})).rejects.toBe(publicationFailure);
  const records=readFileSync(join(fixtures.at(-1)!.directory,'prepared','journal.jsonl'),'utf8').trimEnd().split('\n').map(line=>JSON.parse(line).record.kind);
  expect(records.slice(-2)).toEqual(['control','freeze']);
  await expect(j.operation('member-remove',async()=>undefined)).rejects.toThrow('closed');
});
it('freezes when acknowledged COMMIT is followed by a withheld transaction result',async()=>{
  const j=preparedJournal(),writer=new JournalBudgetFinancialWriter(j),postCommitFailure=new Error('post-commit result failure');
  type Hooks=Parameters<typeof sourceTransactions.sourceTransactionBoundary>[0];let hooks!:Hooks;const original=sourceTransactions.sourceTransactionBoundary;
  vi.spyOn(sourceTransactions,'sourceTransactionBoundary').mockImplementation(value=>{hooks=value;return original(value);});
  let published=false;
  await expect(writer.runWithReceipt('member-remove',async()=>{
    await hooks.beforeCommit({query:async()=>({rows:[]})},[]);await hooks.settled('commit-acknowledged');throw postCommitFailure;
  },()=>{published=true;return undefined;})).rejects.toBe(postCommitFailure);
  expect(published).toBe(false);
  const records=readFileSync(join(fixtures.at(-1)!.directory,'prepared','journal.jsonl'),'utf8').trimEnd().split('\n').map(line=>JSON.parse(line).record.kind);
  expect(records.slice(-2)).toEqual(['control','freeze']);
  await expect(j.operation('member-remove',async()=>undefined)).rejects.toThrow('closed');
});
it.each(['resolved','rejected'] as const)('freezes and consumes an invalid async receipt publication (%s)',async mode=>{
  const j=preparedJournal(),writer=new JournalBudgetFinancialWriter(j),unhandled:string[]=[];
  type Hooks=Parameters<typeof sourceTransactions.sourceTransactionBoundary>[0];let hooks!:Hooks;const original=sourceTransactions.sourceTransactionBoundary;
  vi.spyOn(sourceTransactions,'sourceTransactionBoundary').mockImplementation(value=>{hooks=value;return original(value);});
  const onUnhandled=(reason:unknown)=>unhandled.push(reason instanceof Error?reason.message:String(reason));process.on('unhandledRejection',onUnhandled);
  try{
    await expect(writer.runWithReceipt('provision',async()=>{
      await hooks.beforeCommit({query:async()=>({rows:[]})},[]);await hooks.settled('commit-acknowledged');return 'bound';
    },()=> (mode==='resolved'?Promise.resolve('late'):Promise.reject(new Error('async publication failed'))) as never))
      .rejects.toThrow('Receipt publication must be synchronous');
    await new Promise<void>(resolve=>setImmediate(resolve));
    expect(unhandled).toEqual([]);
    await expect(j.operation('member-remove',async()=>undefined)).rejects.toThrow('closed');
  }finally{process.off('unhandledRejection',onUnhandled);}
});
it('withholds receipt authority from an unprepared journal and refuses receipt work before mutation',async()=>{
  const f=fixture(),j=open(f),writer=new JournalBudgetFinancialWriter(j);let result:CommittedFinancialReceipt|undefined,called=false;
  await j.operation('member-remove',async id=>{j.propose(id,[]);result=j.committed(id);});expect(result).toBeUndefined();
  const before=readFileSync(join(f.directory,'journal.jsonl'));
  await expect(writer.runWithReceipt('member-remove',async()=>{called=true;return 'must not run';})).rejects.toThrow('Prepared financial journal receipt unavailable');expect(called).toBe(false);expect(readFileSync(join(f.directory,'journal.jsonl'))).toEqual(before);
  await expect(j.operation('member-remove',async id=>{j.propose(id,[]);j.committed(id);return 'generic commit';})).resolves.toBe('generic commit');
});
it('retains a stable protected suppression key and checks framed operations across a clean close',async()=>{
  const f=fixture(),j=open(f),identity={canonicalMemberId:'synthetic-member',providers:[{issuer:'https://issuer.invalid',subject:'synthetic-subject',tenantId:'synthetic-tenant'}]},suppression=j.suppression(identity);
  await j.operation('admit',async id=>{j.propose(id,[]);j.committed(id);});j.close();
  const next=open(f);expect(next.suppression(identity)).toEqual(suppression);
  expect(f.records().map(f=>f.record.kind)).toEqual(['genesis','writer-open','begin','proposal','commit','writer-close','writer-open']);
  expect(readFileSync(join(f.directory,'journal.jsonl'),'utf8')).not.toMatch(/synthetic-member|synthetic-subject|synthetic-tenant/);
});
it('holds a real kernel lock after the acquisition child exits, until the whole writer closes',()=>{
  const f=fixture(),j=open(f);expect(()=>f.open()).toThrow('unavailable');j.close();expect(()=>open(f)).not.toThrow();
});
it.each([false,true])('reserves record capacity before work and keeps its final history readable (final operation: %s)',async finalOperation=>{
  const f=fixture(),path=join(f.directory,'journal.jsonl'),frames:Buffer[]=[readFileSync(path)];
  let head=f.records()[0].digest,sequence=1;
  const append=(body:Record<string,unknown>,operationId:string)=>{
    const frame=financialJournalFrame({version:1,sequence:sequence++,operationId,previousDigest:head,...body} as Parameters<typeof financialJournalFrame>[0]);
    frames.push(frame.bytes);head=frame.digest;
  };
  // Assemble bounded valid history once; avoid thousands of kernel locks/fsyncs.
  const target=JOURNAL_MAX_RECORDS-(finalOperation?5:2);
  if(target%2===0){const writer=randomUUID(),operation=randomUUID();append({kind:'writer-open'},writer);append({kind:'begin',operation:'admit'},operation);append({kind:'proposal',atoms:[]},operation);append({kind:'commit',proposalDigest:head},operation);append({kind:'writer-close'},writer);}
  while(sequence<target){const writer=randomUUID();append({kind:'writer-open'},writer);append({kind:'writer-close'},writer);}
  writeFileSync(path,Buffer.concat(frames));
  const j=open(f);
  if(finalOperation)await j.operation('admit',async id=>{j.propose(id,[]);j.committed(id);});
  let called=false;await expect(j.operation('admit',async()=>{called=true;})).rejects.toThrow('capacity');expect(called).toBe(false);
  j.close();expect(f.records()).toHaveLength(JOURNAL_MAX_RECORDS);
  const full=readFileSync(path);expect(()=>f.open()).toThrow('unavailable');expect(readFileSync(path)).toEqual(full);
// Each case validates the full 8192-record history repeatedly; allow bounded CI headroom.
},30_000);
it('does not release an active barrier or rearm it after a callback failure',async()=>{
  const f=fixture(),j=open(f);let resume!:()=>void;const paused=new Promise<void>(resolve=>{resume=resolve;});
  const running=j.operation('admit',async()=>{await paused;throw new Error('synthetic crash');});
  expect(()=>j.close()).toThrow('still owns');await expect(j.operation('admit',async()=>undefined)).rejects.toThrow('busy');expect(()=>f.open()).toThrow();
  resume();await expect(running).rejects.toThrow('synthetic crash');j.close();expect(()=>f.open()).toThrow('unavailable');
});
it('can continue only after a positively recorded abort, including source-only retirement',async()=>{
  const f=fixture(),j=open(f);
  await expect(j.operation('prepare',async id=>{j.propose(id,[]);j.aborted(id,'source-retirement-acknowledged');throw new Error('denied');})).rejects.toThrow('denied');
  await j.operation('prepare',async id=>{j.propose(id,[]);j.committed(id);});
  expect(f.records().filter(f=>f.record.kind==='abort')[0].record.reason).toBe('source-retirement-acknowledged');
});
it.each(['no-proposal','no-terminal','caught-fsync','frozen-after-terminal'])('withholds a direct callback result for %s',async failure=>{
  let fail=false;const f=fixture({sync:fd=>{fsyncSync(fd);if(fail)throw new Error('synthetic fsync failure');}}),j=open(f);
  await expect(j.operation('admit',async id=>{
    if(failure!=='no-proposal'){
      if(failure==='caught-fsync')fail=true;
      try{j.propose(id,[]);}catch{ /* The outer operation must still withhold success. */ }
    }
    if(failure==='frozen-after-terminal'){j.committed(id);j.freeze();}
    return 'must not escape';
  })).rejects.toThrow('did not durably finish');
  fail=false;await expect(j.operation('admit',async()=>undefined)).rejects.toThrow('closed');
});
it.each(['no-boundary','no-proposal','no-terminal','caught-unknown','caught-fsync','complete'])('requires the writer boundary to durably settle (%s)',async mode=>{
  let fail=false;const f=fixture({sync:fd=>{fsyncSync(fd);if(fail)throw new Error('synthetic fsync failure');}}),j=open(f),writer=new JournalBudgetFinancialWriter(j);
  type Hooks=Parameters<typeof sourceTransactions.sourceTransactionBoundary>[0];let hooks!:Hooks;
  const original=sourceTransactions.sourceTransactionBoundary;
  // Unit owner fixture only. Real ownership/ACK/pool-one proofs live in box tests.
  vi.spyOn(sourceTransactions,'sourceTransactionBoundary').mockImplementation(value=>{hooks=value;return original(value);});
  const result=writer.run('admit',async()=>{
    if(mode==='no-boundary')return 'must not escape';
    if(mode!=='no-proposal')await hooks.beforeCommit({query:async()=>({rows:[]})},[]);
    try{
      if(mode==='caught-fsync')fail=true;
      if(mode!=='no-terminal')await hooks.settled(mode==='caught-unknown'?'unknown':'commit-acknowledged');
    }catch{ /* A swallowed owner error must not turn into success. */ }
    return 'result';
  });
  if(mode==='complete')await expect(result).resolves.toBe('result');
  else{await expect(result).rejects.toThrow('did not durably settle');fail=false;await expect(writer.run('admit',async()=>undefined)).rejects.toThrow('closed');}
});
it.each(['partial','corrupt','unknown','sequence'])('refuses %s history without repairing or truncating it',kind=>{
  const f=fixture(),path=join(f.directory,'journal.jsonl'),original=readFileSync(path);
  let altered:Buffer;
  if(kind==='partial')altered=Buffer.concat([original,Buffer.from('{')]);
  else {const frame=JSON.parse(original.toString());if(kind==='unknown')frame.record.memberId='private';else if(kind==='sequence')frame.record.sequence=2;else frame.digest='a'.repeat(64);altered=Buffer.from(JSON.stringify(frame)+'\n');}
  writeFileSync(path,altered);expect(()=>f.open()).toThrow('unavailable');expect(readFileSync(path)).toEqual(altered);
});
it('does not create missing custody or adopt a replacement key',()=>{
  const f=fixture();unlinkSync(join(f.directory,'suppression.key'));expect(()=>f.open()).toThrow('unavailable');
  expect(()=>readFileSync(join(f.directory,'suppression.key'))).toThrow();writeFileSync(join(f.directory,'suppression.key'),Buffer.alloc(32,14),{mode:0o600});expect(()=>f.open()).toThrow('unavailable');
});
it('refuses unsafe file modes and an in-life key loss',async()=>{
  const f=fixture();chmodSync(join(f.directory,'journal.jsonl'),0o644);expect(()=>f.open()).toThrow();chmodSync(join(f.directory,'journal.jsonl'),0o600);
  const j=open(f);unlinkSync(join(f.directory,'suppression.key'));await expect(j.operation('prepare',async()=>undefined)).rejects.toThrow('unavailable');
});
it.each(['proposal','commit'])('freezes on a %s fsync failure even when a full line is visible',async kind=>{
  let fail=false;const f=fixture({sync:fd=>{fsyncSync(fd);if(fail)throw new Error('synthetic disk full');}}),j=open(f);
  await expect(j.operation('admit',async id=>{if(kind==='proposal')fail=true;j.propose(id,[]);fail=true;j.committed(id);})).rejects.toThrow('unavailable');
  fail=false;await expect(j.operation('admit',async()=>undefined)).rejects.toThrow('closed');j.close();
  // A failed writer never appends writer-close, even if its last commit line is readable.
  expect(()=>f.open()).toThrow('unavailable');
});
it('rejects raw identities and authentication fields in financial atom schemas',()=>{
  const grant={kind:'grant',attemptId:'11111111-1111-4111-8111-111111111111',grantHash:'a'.repeat(64)};
  for(const field of ['memberId','email','authorityReference','ticket','prompt','rawProviderBody'])expect(()=>FINANCIAL_ATOM_SCHEMA.parse({...grant,[field]:'private'})).toThrow();
  expect(()=>financialJournalFrame({version:1,sequence:1,operationId:grant.attemptId,previousDigest:'0'.repeat(64),kind:'proposal',atoms:Array(129).fill(grant)})).toThrow();
});
it('requires policy generation in account projections and records provisioning as a journal operation',async()=>{
  const f=fixture(),j=open(f),account={kind:'account' as const,id:'11111111-1111-4111-8111-111111111111',installationAccountId:'11111111-1111-4111-8111-111111111111',accountKind:'installation' as const,state:'closed' as const,reason:'unreconciled' as const,activeWindowId:null,installationCap:'10',policyGeneration:'0',selectedEndpointHash:null,endpointGeneration:'0',recoveryEpochHash:null,canonicalSuppressionHash:null,providerSuppressionHashes:[]};
  expect(()=>FINANCIAL_ATOM_SCHEMA.parse({...account})).not.toThrow();
  const {policyGeneration:_,...missing}=account;expect(()=>FINANCIAL_ATOM_SCHEMA.parse(missing)).toThrow();
  await expect(j.operation('provision',async operationId=>{j.propose(operationId,[account]);j.committed(operationId);return 'closed';})).resolves.toBe('closed');
});
