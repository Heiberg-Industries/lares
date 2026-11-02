import {afterEach,expect,it} from 'vitest';
import {chmodSync,existsSync,mkdtempSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {HostFinancialJournal,JOURNAL_MAX_BYTES,JOURNAL_MAX_RECORDS,financialJournalFrame,type FinancialAtom,type FinancialDatabase} from '../lib/financial-journal.js';
import {msUntilNightlyLedgerCheck} from '../lib/financial-continuity.js';
import {platformTestJournalLock,testJournalUid} from './helpers/financial-journal.js';
const database:FinancialDatabase={systemIdentifier:'74683378529478211',postmasterStartedAt:'2026-10-22T00:00:00.123456Z',databaseOid:'16384'};
const options={ownershipUid:testJournalUid,lock:platformTestJournalLock};
// Reserves one maximum proposal plus the closing records, so this holds a few small operations.
const smallBook=80*1024;
const roots:string[]=[],journals:HostFinancialJournal[]=[];
function prepared(){
  const root=mkdtempSync(join(realpathSync(tmpdir()),'lares-books-'));chmodSync(root,0o700);roots.push(root);
  const directory=join(root,'financial'),preparation=HostFinancialJournal.prepareFresh(directory,database,options);
  try{preparation.complete();}finally{preparation.close();}
  return directory;
}
function open(directory:string,extra:Parameters<typeof HostFinancialJournal.openExisting>[1]={}){
  const j=HostFinancialJournal.openExisting(directory,{...options,requirePrepared:true,bookBytes:smallBook,...extra});journals.push(j);return j;
}
const books=(directory:string)=>readdirSync(directory).filter(name=>/^journal.*\.jsonl$/.test(name)).sort((a,b)=>a.length-b.length||a.localeCompare(b));
const records=(directory:string,name:string)=>readFileSync(join(directory,name),'utf8').trimEnd().split('\n').map(line=>JSON.parse(line));
const allRecords=(directory:string)=>books(directory).flatMap(name=>records(directory,name));
const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,hash=(n:number)=>String(n%10).repeat(64);
const installation=uuid(1),member=uuid(2),installationWindow=uuid(3),memberWindow=uuid(4),binding=uuid(5);
const account=(id:string,accountKind:'installation'|'member',windowId:string):FinancialAtom=>({kind:'account',id,installationAccountId:installation,accountKind,state:'open',reason:'approved',activeWindowId:windowId,installationCap:accountKind==='installation'?'100':null,policyGeneration:'1',selectedEndpointHash:null,endpointGeneration:'0',recoveryEpochHash:null,canonicalSuppressionHash:null,providerSuppressionHashes:[]});
const window=(id:string,accountId:string):FinancialAtom=>({kind:'window',id,accountId,startsAt:'2026-11-01T00:00:00.000000Z',endsAt:'2026-12-01T00:00:00.000000Z',openingLiability:'0',openingCap:'100',policyRevision:'1'});
const attempt=(id:string,state:'prepared'|'admitted'|'settled'|'conflict'|'retired',actual:string|null=null,expiresAt='2099-01-01T00:00:00.000000Z'):FinancialAtom=>({kind:'attempt',id,installationAccountId:installation,memberAccountId:member,bindingId:binding,installationWindowId:installationWindow,memberWindowId:memberWindow,endpointHash:hash(1),credentialGeneration:'0',installationPolicyGeneration:'1',memberPolicyGeneration:'1',endpointGeneration:'0',recoveryEpochHash:hash(2),requestHash:hash(3),profileHash:hash(4),invocationHash:null,reservedAmount:'0.1',installationCapSnapshot:'100',memberCapSnapshot:'100',createdAt:'2026-11-02T00:00:00.000000Z',expiresAt,admittedAt:null,state,actualAmount:actual,settlementHash:null,conflictReason:null,conflictHash:null,highestObservedLiability:actual??'0'});
const accounts=[account(installation,'installation',installationWindow),account(member,'member',memberWindow),window(installationWindow,installation),window(memberWindow,member)];
async function operation(j:HostFinancialJournal,kind:Parameters<HostFinancialJournal['operation']>[0],atoms:FinancialAtom[]){
  await j.operation(kind,async id=>{j.propose(id,atoms);j.committed(id);});
}
/** Writes until the journal has at least this many books. */
async function fillTo(directory:string,j:HostFinancialJournal,wanted:number,prefix=1000){
  for(let n=0;books(directory).length<wanted;n++)await operation(j,'settle',[attempt(uuid(prefix+n),'settled','0.05')]);
}
afterEach(()=>{
  for(const j of journals.splice(0)){try{j.close();}catch{/* A test may leave it closed. */}}
  for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});
});

it('carries on into a next book that continues the same chain, and keeps the sealed book untouched',async()=>{
  const directory=prepared(),j=open(directory);
  await operation(j,'provision',accounts);
  await fillTo(directory,j,3);
  expect(books(directory)).toEqual(['journal.jsonl','journal-000002.jsonl','journal-000003.jsonl']);
  const first=records(directory,'journal.jsonl'),second=records(directory,'journal-000002.jsonl');
  expect(first.at(-1).record).toMatchObject({kind:'book-seal',book:1});
  expect(second[0].record).toMatchObject({kind:'book-open',book:2,sequence:first.at(-1).record.sequence+1,previousDigest:first.at(-1).digest,
    sealedBookDigest:createHash('sha256').update(readFileSync(join(directory,'journal.jsonl'))).digest('hex'),sealedBookBytes:readFileSync(join(directory,'journal.jsonl')).length});
  const every=allRecords(directory);
  every.forEach((frame,index)=>{expect(frame.record.sequence).toBe(index);if(index)expect(frame.record.previousDigest).toBe(every[index-1].digest);});
  const before=j.expectedProjection(),checkpointDigest=j.fullLedgerExpectation().checkpointDigest;
  j.close();
  const reopened=open(directory);
  expect(reopened.isFrozen).toBe(false);
  expect(reopened.expectedProjection().counts).toEqual(before.counts);
  expect(reopened.fullLedgerExpectation().checkpointDigest).toBe(checkpointDigest);
  await operation(reopened,'settle',[attempt(uuid(5000),'settled','0.05')]);
  expect(reopened.expectedProjection().counts.attempts).toBe(before.counts.attempts+1);
});

it('moves a full book forward instead of refusing, at real limits, including a log filled by the older limit',async()=>{
  const directory=prepared(),path=join(directory,'journal.jsonl');
  const existing=readFileSync(path),frames:Buffer[]=[existing],last=existing.toString('utf8').trimEnd().split('\n').map(line=>JSON.parse(line)).at(-1);
  let head=last.digest,sequence=last.record.sequence+1;
  const append=(body:Record<string,unknown>,operationId:string)=>{
    const frame=financialJournalFrame({version:1,sequence:sequence++,operationId,previousDigest:head,...body} as Parameters<typeof financialJournalFrame>[0]);
    frames.push(frame.bytes);head=frame.digest;
  };
  while(sequence<JOURNAL_MAX_RECORDS-1){const writer=randomUUID();append({kind:'writer-open'},writer);append({kind:'writer-close'},writer);}
  writeFileSync(path,Buffer.concat(frames));
  const j=HostFinancialJournal.openExisting(directory,{...options,requirePrepared:true});journals.push(j);
  expect(books(directory)).toEqual(['journal.jsonl','journal-000002.jsonl']);
  await operation(j,'provision',accounts);
  expect(j.isFrozen).toBe(false);
  expect(JOURNAL_MAX_BYTES).toBe(8*1024*1024);
},60_000);

it('keeps starting however many times the keeper restarts',async()=>{
  const directory=prepared();
  for(let n=0;n<400;n++)open(directory).close();
  expect(books(directory).length).toBeGreaterThan(1);
  const j=open(directory);
  await operation(j,'provision',accounts);
  expect(j.isFrozen).toBe(false);
},60_000);

it.each([
  ['a changed byte',(directory:string)=>{const path=join(directory,'journal.jsonl'),raw=readFileSync(path);raw[raw.length-40]=raw[raw.length-40]===48?49:48;writeFileSync(path,raw);}],
  ['a cut-off book',(directory:string)=>{const path=join(directory,'journal.jsonl'),raw=readFileSync(path);writeFileSync(path,raw.subarray(0,raw.lastIndexOf(10,raw.length-2)+1));}],
  ['a removed book',(directory:string)=>{unlinkSync(join(directory,'journal-000002.jsonl'));}],
  ['the newest book removed',(directory:string)=>{unlinkSync(join(directory,'journal-000003.jsonl'));}],
  ['a renamed book',(directory:string)=>{renameSync(join(directory,'journal-000003.jsonl'),join(directory,'journal-000004.jsonl'));}],
  ['books swapped',(directory:string)=>{renameSync(join(directory,'journal-000002.jsonl'),join(directory,'x'));renameSync(join(directory,'journal-000003.jsonl'),join(directory,'journal-000002.jsonl'));renameSync(join(directory,'x'),join(directory,'journal-000003.jsonl'));}],
  ['an unknown file',(directory:string)=>{writeFileSync(join(directory,'journal-extra.jsonl'),'{}\n',{mode:0o600});}],
  ['a loose file for the next book',(directory:string)=>{writeFileSync(join(directory,'journal-000004.partial'),'',{mode:0o600});}],
])('refuses to start with %s',async(name,damage)=>{
  const directory=prepared(),j=open(directory);
  await operation(j,'provision',accounts);await fillTo(directory,j,3);j.close();
  damage(directory);
  // Removing the newest book looks like a crash while changing book: no work runs, and only the
  // complete comparison at the next keeper start can carry on, or freeze if money is missing.
  if(name==='the newest book removed'){const left=open(directory);expect(left.isFrozen).toBe(false);expect(left.awaitingSettlement).toBe(true);await expect(operation(left,'settle',[])).rejects.toThrow();left.close();return;}
  expect(()=>open(directory)).toThrow('explicit recovery');
});

it('refuses new work without freezing when the disk is too full for a new book, and carries on once it is not',async()=>{
  const directory=prepared();let free=0;
  const j=open(directory,{freeBytes:()=>free});
  await operation(j,'provision',accounts);
  let failure:unknown;
  for(let n=0;n<200&&!failure;n++)await operation(j,'settle',[attempt(uuid(2000+n),'settled','0.05')]).catch(error=>{failure=error;});
  expect(String(failure)).toContain('capacity');
  expect(j.isFrozen).toBe(false);expect(books(directory)).toEqual(['journal.jsonl']);
  expect(records(directory,'journal.jsonl').some(frame=>frame.record.kind==='book-seal')).toBe(false);
  free=1024**3;
  await operation(j,'settle',[attempt(uuid(3000),'settled','0.05')]);
  expect(books(directory)).toEqual(['journal.jsonl','journal-000002.jsonl']);
});

it.each(['partial','next'])('refuses work rather than guesses after a crash while changing book (%s)',async stage=>{
  const directory=prepared();let armed=false;
  const j=open(directory,{sync:fd=>{if(armed&&stage==='partial'&&existsSync(join(directory,'journal-000002.partial')))throw new Error('synthetic crash');void fd;}});
  await operation(j,'provision',accounts);
  armed=true;
  if(stage==='next'){
    await fillTo(directory,j,2);
    // The state a crash leaves right after the seal: the seal is durable, the next book is not.
    j.close();
    const name='journal-000002.jsonl',kept=readFileSync(join(directory,name));void kept;
    unlinkSync(join(directory,name));
    const reopened=open(directory);expect(reopened.isFrozen).toBe(false);expect(reopened.awaitingSettlement).toBe(true);
    expect(records(directory,'journal.jsonl').at(-1).record.kind).toBe('book-seal');
    reopened.close();
    const again=open(directory);expect(again.isFrozen).toBe(false);expect(again.awaitingSettlement).toBe(true);
    expect(records(directory,'journal.jsonl').filter(frame=>frame.record.kind==='freeze')).toHaveLength(0);
    return;
  }
  await expect(fillTo(directory,j,2)).rejects.toThrow('recovery');
  expect(j.isFrozen).toBe(true);
  j.close();
  const reopened=open(directory);expect(reopened.isFrozen).toBe(true);
});

it('never adds to a sealed book when the next book exists but could not be finished',async()=>{
  const directory=prepared();let armed=false,fired=false;
  const j=open(directory,{sync:()=>{if(armed&&!fired&&existsSync(join(directory,'journal-000002.jsonl'))){fired=true;throw new Error('synthetic directory sync failure');}}});
  await operation(j,'provision',accounts);
  armed=true;
  await expect(fillTo(directory,j,3)).rejects.toThrow('recovery');
  expect(j.isFrozen).toBe(true);
  const sealed=readFileSync(join(directory,'journal.jsonl'));
  await j.freezeForRestore();
  expect(() => j.freeze()).not.toThrow();
  j.close();
  expect(readFileSync(join(directory,'journal.jsonl'))).toEqual(sealed);
  const reopened=open(directory);
  expect(reopened.isFrozen).toBe(false);expect(reopened.awaitingSettlement).toBe(true);
  expect(records(directory,'journal-000002.jsonl').map(frame=>frame.record.kind)).toEqual(['book-open']);
});

it('summarises finished attempts out of each step, and brings one back if it changes again',async()=>{
  const directory=prepared(),j=HostFinancialJournal.openExisting(directory,{...options,requirePrepared:true});journals.push(j);
  await operation(j,'provision',accounts);
  for(let n=0;n<70;n++)await operation(j,'settle',[attempt(uuid(1000+n),'settled','0.05')]);
  let projection=j.expectedProjection();
  expect(projection.atoms.filter(atom=>atom.kind==='attempt').length).toBeLessThan(10);
  expect(projection.counts.attempts).toBe(70);
  expect(projection.windowTotals?.totals).toContainEqual({windowId:memberWindow,state:'settled',count:70,reserved:'7',actual:'3.5',high:'3.5'});
  expect(projection.windowTotals?.windowIds).toEqual([installationWindow,memberWindow]);
  await operation(j,'settle',[attempt(uuid(1000),'conflict','0.5')]);
  projection=j.expectedProjection();
  expect(projection.counts.attempts).toBe(70);
  expect(projection.atoms.some(atom=>atom.kind==='attempt'&&atom.id===uuid(1000)&&atom.state==='conflict')).toBe(true);
  expect(projection.windowTotals?.totals).toContainEqual({windowId:memberWindow,state:'settled',count:69,reserved:'6.9',actual:'3.45',high:'3.45'});
  expect(projection.windowTotals?.totals).toContainEqual({windowId:memberWindow,state:'conflict',count:1,reserved:'0.1',actual:'0.5',high:'0.5'});
  const expected=j.fullLedgerExpectation();
  expect(expected.matches(attempt(uuid(1001),'settled','0.05'))).toBe(true);
  expect(expected.matches(attempt(uuid(1001),'settled','0.04'))).toBe(false);
  expect(expected.matches(attempt(uuid(9999),'settled','0.05'))).toBe(false);
  j.close();
  const reopened=HostFinancialJournal.openExisting(directory,{...options,requirePrepared:true});journals.push(reopened);
  expect(reopened.expectedProjection().windowTotals).toEqual(projection.windowTotals);
  expect(reopened.expectedProjection().counts).toEqual(projection.counts);
});

it('summarises prepared attempts only after they expire',async()=>{
  const directory=prepared(),j=open(directory);
  await operation(j,'provision',accounts);
  await operation(j,'prepare',[attempt(uuid(10),'prepared',null,'2000-01-01T00:00:00.000000Z'),attempt(uuid(11),'prepared')]);
  j.close();
  const reopened=open(directory),projection=reopened.expectedProjection();
  expect(projection.atoms.filter(atom=>atom.kind==='attempt').map(atom=>atom.kind==='attempt'&&atom.id)).toEqual([uuid(11)]);
  expect(projection.counts.attempts).toBe(2);
});

it('keeps the newest checkpoints and every non-gateway checkpoint in each step',async()=>{
  const directory=prepared(),j=HostFinancialJournal.openExisting(directory,{...options,requirePrepared:true});journals.push(j);
  await operation(j,'provision',accounts);
  const provision=j.expectedProjection().checkpoints[0]!;
  for(let n=0;n<300;n++)await operation(j,'settle',[attempt(uuid(1000+n),'settled','0.05')]);
  const projection=j.expectedProjection();
  expect(projection.counts.checkpoints).toBe(301);
  expect(projection.checkpoints.length).toBeLessThan(140);
  expect(projection.checkpoints[0]).toEqual(provision);
  expect(projection.checkpoints.at(-1)!.sequence).toBeGreaterThan(provision.sequence);
},60_000);

it('holds operations out during the whole-ledger check and releases them afterwards',async()=>{
  const directory=prepared(),j=open(directory);
  await operation(j,'provision',accounts);
  let release!:()=>void;const held=j.withFullCheckBarrier(()=>new Promise<void>(resolve=>{release=resolve;}));
  await expect(operation(j,'settle',[])).rejects.toThrow('busy');
  await expect(j.withFullCheckBarrier(async()=>undefined)).rejects.toThrow('busy');
  // An operation waiting in line runs as soon as the check lets go, and nothing overtakes it.
  let waiterRan=false;
  const waiting=j.operation('settle',async id=>{j.propose(id,[attempt(uuid(1001),'settled','0.05')]);j.committed(id);waiterRan=true;},{ms:5000});
  await expect(j.withFullCheckBarrier(async()=>undefined)).rejects.toThrow('busy');
  release();await held;await waiting;
  expect(waiterRan).toBe(true);
  await operation(j,'settle',[attempt(uuid(1000),'settled','0.05')]);
});

it('schedules the nightly check for the next 03:00 UTC',()=>{
  expect(msUntilNightlyLedgerCheck(Date.UTC(2026,10,2,2,59))).toBe(60_000);
  expect(msUntilNightlyLedgerCheck(Date.UTC(2026,10,2,3,0))).toBe(24*3600_000);
  expect(msUntilNightlyLedgerCheck(Date.UTC(2026,11,31,4,0))).toBe(23*3600_000);
});
