/** Existing-only protected host custody. Nothing here opens spending or initializes a key. */
import {constants,openSync,closeSync,fstatSync,lstatSync,readFileSync,readSync,writeSync,fsyncSync} from 'node:fs';
import {isAbsolute,join,normalize,parse} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {canonicalBudgetMoney,budgetIdentitySuppression,type BudgetFinancialOperation} from '@lares/agent-kit/budget-admission-store';
import {gatewayCanonical} from '@lares/agent-kit/gateway-admission-protocol';
import {gatewayPricingSchema} from '@lares/agent-kit/gateway-pricing';
const hash=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().uuid(),uint=z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
const money=z.string().refine(v=>{try{return canonicalBudgetMoney(v)===v;}catch{return false;}});
const instant=z.iso.datetime({precision:6}),zero='0'.repeat(64);
export const FINANCIAL_ATOM_SCHEMA=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('account'),id,installationAccountId:id,accountKind:z.enum(['installation','member']),state:z.enum(['closed','open','frozen','retired']),reason:z.enum(['unreconciled','approved','policy_changed','member_removed','member_erased','receipt_conflict','over_reservation','recovery_mismatch']),activeWindowId:id.nullable(),installationCap:money.nullable(),selectedEndpointHash:hash.nullable(),endpointGeneration:uint,recoveryEpochHash:hash.nullable(),canonicalSuppressionHash:hash.nullable(),providerSuppressionHashes:z.array(hash).max(64)}).strict(),
  z.object({kind:z.literal('window'),id,accountId:id,startsAt:instant,endsAt:instant,openingLiability:money,openingCap:money,policyRevision:uint}).strict(),
  z.object({kind:z.literal('binding'),id,installationAccountId:id,memberAccountId:id,endpointHash:hash,credentialGeneration:uint,profileHash:hash,maximumLiability:money,pricingProfile:gatewayPricingSchema.nullable(),state:z.enum(['active','revoked'])}).strict(),
  z.object({kind:z.literal('attempt'),id,installationAccountId:id,memberAccountId:id,bindingId:id,installationWindowId:id,memberWindowId:id,endpointHash:hash,credentialGeneration:uint,installationPolicyGeneration:uint,memberPolicyGeneration:uint,endpointGeneration:uint,recoveryEpochHash:hash,requestHash:hash,profileHash:hash,invocationHash:hash.nullable(),reservedAmount:money,installationCapSnapshot:money,memberCapSnapshot:money,createdAt:instant,expiresAt:instant,admittedAt:instant.nullable(),state:z.enum(['prepared','admitted','unknown','settled','conflict','retired']),actualAmount:money.nullable(),settlementHash:hash.nullable(),conflictReason:z.enum(['receipt_conflict','over_reservation']).nullable(),conflictHash:hash.nullable(),highestObservedLiability:money}).strict(),
  z.object({kind:z.literal('grant'),attemptId:id,grantHash:hash}).strict(),
  z.object({kind:z.literal('tombstone'),accountId:id,canonicalSuppressionHash:hash,providerSuppressionHashes:z.array(hash).min(1).max(64),state:z.enum(['retired','erased'])}).strict(),
]);
export type FinancialAtom=z.infer<typeof FINANCIAL_ATOM_SCHEMA>;
const operation=z.enum(['prepare','admit','grant','unknown','settle']);
const base={version:z.literal(1),sequence:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),operationId:id,previousDigest:hash};
export const FINANCIAL_JOURNAL_RECORD_SCHEMA=z.discriminatedUnion('kind',[
  z.object({...base,kind:z.literal('genesis'),journalId:id,suppressionKeyFingerprint:hash}).strict(),
  z.object({...base,kind:z.literal('writer-open')}).strict(),
  z.object({...base,kind:z.literal('writer-close')}).strict(),
  z.object({...base,kind:z.literal('begin'),operation}).strict(),
  z.object({...base,kind:z.literal('proposal'),atoms:z.array(FINANCIAL_ATOM_SCHEMA).max(128)}).strict(),
  z.object({...base,kind:z.literal('commit'),proposalDigest:hash}).strict(),
  z.object({...base,kind:z.literal('abort'),proposalDigest:hash.nullable(),reason:z.enum(['not-started','rollback-acknowledged','source-retirement-acknowledged','source-retirement-rolled-back'])}).strict(),
]);
type JournalRecord=z.infer<typeof FINANCIAL_JOURNAL_RECORD_SCHEMA>;
const frameSchema=z.object({record:FINANCIAL_JOURNAL_RECORD_SCHEMA,digest:hash}).strict();
export const JOURNAL_MAX_RECORD_BYTES=65_536,JOURNAL_MAX_BYTES=8*1024*1024,JOURNAL_MAX_RECORDS=8192;
const CONTROL_RECORD_BYTES=1024;
const digest=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function financialJournalFrame(record:JournalRecord):{bytes:Buffer;digest:string} {
  const checked=FINANCIAL_JOURNAL_RECORD_SCHEMA.parse(record),sum=digest(gatewayCanonical(checked));
  const bytes=Buffer.concat([gatewayCanonical({record:checked,digest:sum}),Buffer.from('\n')]);
  if(bytes.length>JOURNAL_MAX_RECORD_BYTES)throw new Error('Financial journal record unavailable');
  return {bytes,digest:sum};
}
export function linuxInheritedJournalLock(fd:number):void {
  if(process.platform!=='linux')throw new Error('Financial journal kernel lock unavailable');
  // The child locks the inherited OPEN FILE DESCRIPTION. Its exit does not release
  // that lock while this writer retains the same descriptor. Actual Linux image proof
  // checks a second process, child exit and parent death; no PID file or timed lease.
  const result=spawnSync('flock',['--exclusive','--nonblock','--conflict-exit-code','75','3'],{stdio:['ignore','ignore','ignore',fd],timeout:2000});
  if(result.status!==0||result.error)throw new Error('Financial journal writer unavailable');
}
export interface FinancialJournalProposal {journalId:string;operationId:string;sequence:number;digest:string}
export class HostFinancialJournal {
  #key:Buffer;
  private sequence=0;private head=zero;private size=0;private journalId='';private writerId=randomUUID();private pending?:{id:string;proposal?:string};private busy=false;private frozen=false;private closed=false;
  private constructor(private directory:string,private journalFd:number,private lockFd:number,private directoryFd:number,private keyFd:number,key:Buffer,private uid:number,private sync:(fd:number)=>void){this.#key=key;}
  /** No mkdir, key creation, restore adoption, tail repair or automatic initialization. */
  static openExisting(directory:string,options:{ownershipUid?:number;lock?:(fd:number)=>void;sync?:(fd:number)=>void}={}):HostFinancialJournal {
    const uid=options.ownershipUid??0;let lockFd:number|undefined,journalFd:number|undefined,directoryFd:number|undefined,keyFd:number|undefined,key:Buffer|undefined;
    try{
      verifyDirectory(directory,uid);directoryFd=openSync(directory,constants.O_RDONLY|constants.O_NOFOLLOW);
      lockFd=protectedFile(join(directory,'writer.lock'),uid,constants.O_RDWR);(options.lock??linuxInheritedJournalLock)(lockFd);
      keyFd=protectedFile(join(directory,'suppression.key'),uid,constants.O_RDONLY);
      if(fstatSync(keyFd).size!==32)throw new Error('Financial custody unavailable');key=readFileSync(keyFd);if(key.length!==32)throw new Error('Financial custody unavailable');
      journalFd=protectedFile(join(directory,'journal.jsonl'),uid,constants.O_RDWR|constants.O_APPEND);
      const journal=new HostFinancialJournal(directory,journalFd,lockFd,directoryFd,keyFd,key,uid,options.sync??fsyncSync);journal.load();journal.requireCapacity(2,2*CONTROL_RECORD_BYTES);journal.busy=true;try{journal.append({kind:'writer-open'},journal.writerId);}finally{journal.busy=false;}return journal;
    }catch{
      key?.fill(0);for(const fd of [journalFd,lockFd,directoryFd,keyFd])if(fd!==undefined)closeSync(fd);
      throw new Error('Financial journal unavailable; explicit recovery is required');
    }
  }
  private load():void {
    const stat=fstatSync(this.journalFd);if(stat.size<1||stat.size>JOURNAL_MAX_BYTES)throw new Error('Invalid journal size');
    const raw=readFileSync(this.journalFd);if(raw.length!==stat.size||raw[raw.length-1]!==10)throw new Error('Partial journal');
    const lines=raw.subarray(0,-1).toString('utf8').split('\n');if(lines.length>JOURNAL_MAX_RECORDS)throw new Error('Journal limit');
    const operations=new Set<string>();let genesis=false,writer:string|undefined;
    for(const line of lines){
      if(Buffer.byteLength(line)+1>JOURNAL_MAX_RECORD_BYTES)throw new Error('Journal record limit');
      const frame=frameSchema.parse(JSON.parse(line)),expected=financialJournalFrame(frame.record);
      if(!expected.bytes.equals(Buffer.from(line+'\n'))||frame.digest!==expected.digest)throw new Error('Journal integrity');
      const r=frame.record;
      if(r.sequence!==this.sequence||r.previousDigest!==this.head)throw new Error('Journal sequence');
      if(!genesis){if(r.kind!=='genesis'||r.sequence!==0||r.suppressionKeyFingerprint!==digest(this.#key))throw new Error('Journal custody mismatch');this.journalId=r.journalId;genesis=true;}
      else if(r.kind==='writer-open'){if(writer||this.pending)throw new Error('Journal writer overlap');writer=r.operationId;}
      else if(r.kind==='writer-close'){if(writer!==r.operationId||this.pending)throw new Error('Journal writer mismatch');writer=undefined;}
      else if(r.kind==='begin'){if(!writer||this.pending||operations.has(r.operationId))throw new Error('Journal operation replay');operations.add(r.operationId);this.pending={id:r.operationId};}
      else if(r.kind==='proposal'){if(!this.pending||this.pending.id!==r.operationId||this.pending.proposal)throw new Error('Journal proposal mismatch');this.pending.proposal=frame.digest;}
      else if(r.kind==='commit'){if(!this.pending?.proposal||this.pending.id!==r.operationId||this.pending.proposal!==r.proposalDigest)throw new Error('Journal commit mismatch');this.pending=undefined;}
      else if(r.kind==='abort'){if(!this.pending||this.pending.id!==r.operationId||(this.pending.proposal??null)!==r.proposalDigest)throw new Error('Journal abort mismatch');this.pending=undefined;}
      else throw new Error('Repeated journal genesis');
      this.sequence++;this.head=frame.digest;
    }
    if(!genesis||this.pending||writer)throw new Error('Uncompleted financial operation or writer');this.size=raw.length;
  }
  /** The in-process barrier precedes pool checkout. Kernel ownership spans this object's
   * entire life; contention refuses rather than queueing another spending operation. */
  async operation<T>(kind:BudgetFinancialOperation,work:(operationId:string)=>Promise<T>):Promise<T> {
    if(this.closed||this.frozen||this.busy)throw new Error('Financial journal is closed or busy');
    // Reserve begin, maximum proposal, terminal and writer-close BEFORE any database
    // work. Capacity exhaustion leaves this writer able to close cleanly.
    this.requireCapacity(4,JOURNAL_MAX_RECORD_BYTES+3*CONTROL_RECORD_BYTES);
    this.busy=true;const operationId=randomUUID();
    try{
      this.append({kind:'begin',operation:operation.parse(kind)},operationId);this.pending={id:operationId};
      const result=await work(operationId);
      if(this.pending||this.frozen)throw new Error('Financial operation did not durably finish');
      return result;
    }
    catch(error){if(this.pending)this.frozen=true;throw error;}
    finally{this.busy=false;if(this.pending)this.frozen=true;}
  }
  propose(operationId:string,atoms:readonly FinancialAtom[]):FinancialJournalProposal {
    if(this.pending?.id!==operationId||this.pending.proposal)throw new Error('Financial proposal unavailable');
    const frame=this.append({kind:'proposal',atoms:[...atoms]},operationId);this.pending.proposal=frame.digest;
    return {journalId:this.journalId,operationId,sequence:frame.sequence,digest:frame.digest};
  }
  committed(operationId:string):void {
    if(this.pending?.id!==operationId||!this.pending.proposal)throw new Error('Financial proposal unavailable');
    this.append({kind:'commit',proposalDigest:this.pending.proposal},operationId);this.pending=undefined;
  }
  aborted(operationId:string,reason:'not-started'|'rollback-acknowledged'|'source-retirement-acknowledged'|'source-retirement-rolled-back'):void {
    if(this.pending?.id!==operationId)throw new Error('Financial operation unavailable');
    this.append({kind:'abort',proposalDigest:this.pending.proposal??null,reason},operationId);this.pending=undefined;
  }
  freeze():void {this.frozen=true;}
  suppression(identity:Parameters<typeof budgetIdentitySuppression>[1]):ReturnType<typeof budgetIdentitySuppression> {
    if(this.closed||this.frozen)throw new Error('Financial custody unavailable');return budgetIdentitySuppression(this.#key,identity);
  }
  close():void {
    if(this.closed)return;if(this.busy)throw new Error('Financial operation still owns the barrier');
    try{if(!this.frozen){this.busy=true;this.append({kind:'writer-close'},this.writerId);}}
    finally{this.busy=false;this.closed=true;this.#key.fill(0);closeSync(this.journalFd);closeSync(this.lockFd);closeSync(this.directoryFd);closeSync(this.keyFd);}
  }
  private requireCapacity(records:number,bytes:number):void {
    if(this.sequence+records>JOURNAL_MAX_RECORDS||this.size+bytes>JOURNAL_MAX_BYTES)throw new Error('Financial journal capacity unavailable');
  }
  private append(body:Record<string,unknown>,operationId:string):{sequence:number;digest:string} {
    try{
      if(this.closed||this.frozen||!this.busy)throw new Error('Financial journal unavailable');
      verifyDirectory(this.directory,this.uid);
      for(const [name,fd] of [['journal.jsonl',this.journalFd],['writer.lock',this.lockFd],['suppression.key',this.keyFd]] as const){const a=fstatSync(fd),b=lstatSync(join(this.directory,name));if(a.ino!==b.ino||a.dev!==b.dev||!b.isFile()||b.nlink!==1||b.uid!==this.uid||(b.mode&0o777)!==0o600)throw new Error('Financial custody changed');}
      const currentKey=Buffer.alloc(32);if(fstatSync(this.keyFd).size!==32||readSync(this.keyFd,currentKey,0,32,0)!==32||digest(currentKey)!==digest(this.#key))throw new Error('Financial key custody changed');currentKey.fill(0);
      if(fstatSync(this.journalFd).size!==this.size)throw new Error('Financial journal changed');
      const sequence=this.sequence,record=FINANCIAL_JOURNAL_RECORD_SCHEMA.parse({version:1,sequence,operationId,previousDigest:this.head,...body}),frame=financialJournalFrame(record);
      if(record.kind!=='proposal'&&frame.bytes.length>CONTROL_RECORD_BYTES)throw new Error('Financial control record limit');
      this.requireCapacity(1,frame.bytes.length);
      let offset=0;while(offset<frame.bytes.length){const written=writeSync(this.journalFd,frame.bytes,offset,frame.bytes.length-offset);if(written<1)throw new Error('Incomplete financial append');offset+=written;}
      this.sync(this.journalFd);this.size+=frame.bytes.length;this.sequence++;this.head=frame.digest;return {sequence,digest:frame.digest};
    }catch{this.frozen=true;throw new Error('Financial journal write unavailable; recovery is required');}
  }
}
function protectedFile(path:string,uid:number,flags:number):number {
  const fd=openSync(path,flags|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.uid!==uid||(stat.mode&0o777)!==0o600)throw new Error('Unsafe custody');return fd;}catch(error){closeSync(fd);throw error;}
}
function verifyDirectory(directory:string,uid:number):void {
  if(!isAbsolute(directory)||normalize(directory)!==directory)throw new Error('Invalid custody');
  let part=parse(directory).root;
  for(const name of directory.slice(part.length).split('/')){if(!name)continue;part=join(part,name);const st=lstatSync(part);if(!st.isDirectory()||st.isSymbolicLink()||![0,uid].includes(st.uid)||(st.mode&0o022)!==0&&(st.mode&0o1000)===0)throw new Error('Unsafe custody');}
  const stat=lstatSync(directory);if(stat.uid!==uid||(stat.mode&0o777)!==0o700)throw new Error('Unsafe custody');
}
