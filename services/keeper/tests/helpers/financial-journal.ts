import {chmodSync,closeSync,fsyncSync,mkdtempSync,openSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HostFinancialJournal,financialJournalFrame,linuxInheritedJournalLock} from '../../lib/financial-journal.js';
export const testJournalUid=process.getuid!();
export function platformTestJournalLock(fd:number):void {
  if(process.platform==='linux')return linuxInheritedJournalLock(fd);
  // Local Mac proof uses the actual platform kernel, not a process-local mutex. The
  // production util-linux implementation is proved separately in the Linux image.
  execFileSync('python3',['-c','import fcntl; fcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB)'],{stdio:['ignore','ignore','ignore',fd]});
}
export function journalFixture(options:{sync?:(fd:number)=>void}={}) {
  const directory=mkdtempSync(join(realpathSync(tmpdir()),'lares-financial-'));chmodSync(directory,0o700);
  const key=Buffer.alloc(32,13),journalId=randomUUID();
  const frame=financialJournalFrame({version:1,sequence:0,operationId:randomUUID(),previousDigest:'0'.repeat(64),kind:'genesis',journalId,suppressionKeyFingerprint:createHash('sha256').update(key).digest('hex')});
  for(const [name,body] of [['writer.lock',Buffer.alloc(0)],['suppression.key',key],['journal.jsonl',frame.bytes]] as const){
    const path=join(directory,name);writeFileSync(path,body,{flag:'wx',mode:0o600});const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
  }
  const fd=openSync(directory,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
  const open=()=>HostFinancialJournal.openExisting(directory,{ownershipUid:testJournalUid,lock:platformTestJournalLock,...options});
  const records=()=>readFileSync(join(directory,'journal.jsonl'),'utf8').trimEnd().split('\n').map(line=>JSON.parse(line));
  return {directory,key,journalId,open,records};
}
