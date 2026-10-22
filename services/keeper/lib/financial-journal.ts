/** Protected host custody. Continuity and preparation never open spending authority. */
import {constants,openSync,closeSync,fstatSync,lstatSync,readFileSync,readSync,writeSync,fsyncSync,mkdirSync,readdirSync,renameSync} from 'node:fs';
import {isAbsolute,join,normalize,parse,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {canonicalBudgetMoney,budgetIdentitySuppression,type BudgetFinancialOperation} from '@lares/agent-kit/budget-admission-store';
import {gatewayCanonical} from '@lares/agent-kit/gateway-admission-protocol';
import {gatewayPricingSchema} from '@lares/agent-kit/gateway-pricing';
const hash=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().uuid(),uint=z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
const money=z.string().refine(v=>{try{return canonicalBudgetMoney(v)===v;}catch{return false;}});
const instant=z.iso.datetime({precision:6}),zero='0'.repeat(64);
export const FINANCIAL_ATOM_SCHEMA=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('account'),id,installationAccountId:id,accountKind:z.enum(['installation','member']),state:z.enum(['closed','open','frozen','retired']),reason:z.enum(['unreconciled','approved','policy_changed','member_removed','member_erased','receipt_conflict','over_reservation','recovery_mismatch']),activeWindowId:id.nullable(),installationCap:money.nullable(),policyGeneration:uint,selectedEndpointHash:hash.nullable(),endpointGeneration:uint,recoveryEpochHash:hash.nullable(),canonicalSuppressionHash:hash.nullable(),providerSuppressionHashes:z.array(hash).max(64)}).strict(),
  z.object({kind:z.literal('window'),id,accountId:id,startsAt:instant,endsAt:instant,openingLiability:money,openingCap:money,policyRevision:uint}).strict(),
  z.object({kind:z.literal('binding'),id,installationAccountId:id,memberAccountId:id,endpointHash:hash,credentialGeneration:uint,profileHash:hash,maximumLiability:money,pricingProfile:gatewayPricingSchema.nullable(),state:z.enum(['active','revoked'])}).strict(),
  z.object({kind:z.literal('attempt'),id,installationAccountId:id,memberAccountId:id,bindingId:id,installationWindowId:id,memberWindowId:id,endpointHash:hash,credentialGeneration:uint,installationPolicyGeneration:uint,memberPolicyGeneration:uint,endpointGeneration:uint,recoveryEpochHash:hash,requestHash:hash,profileHash:hash,invocationHash:hash.nullable(),reservedAmount:money,installationCapSnapshot:money,memberCapSnapshot:money,createdAt:instant,expiresAt:instant,admittedAt:instant.nullable(),state:z.enum(['prepared','admitted','unknown','settled','conflict','retired']),actualAmount:money.nullable(),settlementHash:hash.nullable(),conflictReason:z.enum(['receipt_conflict','over_reservation']).nullable(),conflictHash:hash.nullable(),highestObservedLiability:money}).strict(),
  z.object({kind:z.literal('grant'),attemptId:id,grantHash:hash}).strict(),
  z.object({kind:z.literal('tombstone'),accountId:id,canonicalSuppressionHash:hash,providerSuppressionHashes:z.array(hash).min(1).max(64),state:z.enum(['retired','erased'])}).strict(),
]);
export type FinancialAtom=z.infer<typeof FINANCIAL_ATOM_SCHEMA>;
export const FINANCIAL_CHECKPOINT_SCHEMA=z.object({operationId:id,journalId:id,sequence:z.number().int().positive().safe(),digest:hash}).strict();
export const FINANCIAL_DATABASE_SCHEMA=z.object({systemIdentifier:z.string().regex(/^[0-9]{1,20}$/),postmasterStartedAt:z.iso.datetime({precision:6}),databaseOid:z.string().regex(/^[0-9]{1,10}$/)}).strict();
const controlSchema=z.object({journalId:id,database:FINANCIAL_DATABASE_SCHEMA,checkpoint:FINANCIAL_CHECKPOINT_SCHEMA.nullable()}).strict();
export type FinancialControl=z.infer<typeof controlSchema>;
export type FinancialDatabase=z.infer<typeof FINANCIAL_DATABASE_SCHEMA>;
export type FinancialCheckpoint=z.infer<typeof FINANCIAL_CHECKPOINT_SCHEMA>;
const receiptSchema=z.object({version:z.literal(1),journalId:id,suppressionKeyFingerprint:hash}).strict();
export interface JournalOptions {ownershipUid?:number;lock?:(fd:number)=>void;sync?:(fd:number)=>void;requirePrepared?:boolean}
const operation=z.enum(['prepare','provision','admit','grant','unknown','settle','member-remove']);
const base={version:z.literal(1),sequence:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),operationId:id,previousDigest:hash};
export const FINANCIAL_JOURNAL_RECORD_SCHEMA=z.discriminatedUnion('kind',[
  z.object({...base,kind:z.literal('genesis'),journalId:id,suppressionKeyFingerprint:hash}).strict(),
  z.object({...base,kind:z.literal('writer-open')}).strict(),
  z.object({...base,kind:z.literal('preparation-complete')}).strict(),
  z.object({...base,kind:z.literal('control'),control:controlSchema}).strict(),
  z.object({...base,kind:z.literal('freeze'),reason:z.enum(['restore','continuity','uncertain'])}).strict(),
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
/** The exact schema and byte bound used by the durable proposal append, available before
 * a database mutation while the journal operation lock is held. */
export function financialProposalFrame(operationId:string,sequence:number,previousDigest:string,atoms:readonly FinancialAtom[]):{record:JournalRecord;bytes:Buffer;digest:string} {
  const record=FINANCIAL_JOURNAL_RECORD_SCHEMA.parse({version:1,sequence,operationId,previousDigest,kind:'proposal',atoms:[...atoms]});
  const sum=digest(gatewayCanonical(record)),bytes=Buffer.concat([gatewayCanonical({record,digest:sum}),Buffer.from('\n')]);
  if(bytes.length>JOURNAL_MAX_RECORD_BYTES)throw new Error('Financial proposal exceeds journal record limit');
  return {record,bytes,digest:sum};
}
export function linuxInheritedJournalLock(fd:number):void {
  if(process.platform!=='linux')throw new Error('Financial journal kernel lock unavailable');
  // The child locks the inherited OPEN FILE DESCRIPTION. Its exit does not release
  // that lock while this writer retains the same descriptor. Actual Linux image proof
  // checks a second process, child exit and parent death; no PID file or timed lease.
  const result=spawnSync('flock',['--exclusive','--nonblock','--conflict-exit-code','75','3'],{stdio:['ignore','ignore','ignore',fd],timeout:2000});
  if(result.status!==0||result.error)throw new Error('Financial journal writer unavailable');
}
export interface FinancialPreparation {complete():void;close():void}
export interface FinancialJournalProposal {journalId:string;operationId:string;sequence:number;digest:string}
export class HostFinancialJournal {
  #key:Buffer;
  private sequence=0;private head=zero;private size=0;private journalId='';private writerId=randomUUID();private pending?:{id:string;proposal?:string};private busy=false;private frozen=false;private closed=false;private stopping=false;private control?:FinancialControl;private lastCheckpoint:FinancialCheckpoint|null=null;private idle=new Set<()=>void>();private preparationComplete=false;
  private constructor(private directory:string,private journalFd:number,private lockFd:number,private directoryFd:number,private keyFd:number,key:Buffer,private uid:number,private sync:(fd:number)=>void){this.#key=key;}
  /** No mkdir, key creation, restore adoption, tail repair or automatic initialization. */
  static openExisting(directory:string,options:JournalOptions={}):HostFinancialJournal {
    const uid=options.ownershipUid??0;let lockFd:number|undefined,journalFd:number|undefined,directoryFd:number|undefined,keyFd:number|undefined,key:Buffer|undefined;
    try{
      verifyDirectory(directory,uid);directoryFd=openSync(directory,constants.O_RDONLY|constants.O_NOFOLLOW);
      lockFd=protectedFile(join(directory,'writer.lock'),uid,constants.O_RDWR);(options.lock??linuxInheritedJournalLock)(lockFd);
      keyFd=protectedFile(join(directory,'suppression.key'),uid,constants.O_RDONLY);
      if(fstatSync(keyFd).size!==32)throw new Error('Financial custody unavailable');key=readFileSync(keyFd);if(key.length!==32)throw new Error('Financial custody unavailable');
      journalFd=protectedFile(join(directory,'journal.jsonl'),uid,constants.O_RDWR|constants.O_APPEND);
      const journal=new HostFinancialJournal(directory,journalFd,lockFd,directoryFd,keyFd,key,uid,options.sync??fsyncSync);
      journal.load(options.requirePrepared===true);
      journal.requireCapacity(journal.control?3:2,(journal.control?3:2)*CONTROL_RECORD_BYTES);journal.busy=true;try{if(!journal.frozen)journal.append({kind:'writer-open'},journal.writerId);}finally{journal.busy=false;}return journal;
    }catch{
      key?.fill(0);for(const fd of [journalFd,lockFd,directoryFd,keyFd])if(fd!==undefined)closeSync(fd);
      throw new Error('Financial journal unavailable; explicit recovery is required');
    }
  }
  /** Explicit one-shot host ceremony. Caller MUST hold every budget table lock and prove
   * this is a fresh installation; empty database contents alone are never permission. */
  static prepareFresh(directory:string,database:FinancialDatabase,options:JournalOptions={}):FinancialPreparation {
    const uid=options.ownershipUid??0,sync=options.sync??fsyncSync;
    FINANCIAL_DATABASE_SCHEMA.parse(database);
    // A failed mkdir or any leftover entry is recovery, never a rerunnable init path.
    // The parent is provisioned explicitly by the host command and is not in DB backups.
    mkdirSync(directory,{mode:0o700});verifyDirectory(directory,uid);
    const parentFd=openSync(dirname(directory),constants.O_RDONLY|constants.O_NOFOLLOW);try{sync(parentFd);}finally{closeSync(parentFd);}
    const directoryFd=openSync(directory,constants.O_RDONLY|constants.O_NOFOLLOW);let lockFd:number|undefined;
    const create=(name:string,bytes:Buffer)=>{const fd=openSync(join(directory,name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{let offset=0;while(offset<bytes.length){const n=writeSync(fd,bytes,offset,bytes.length-offset);if(n<1)throw new Error('Custody write failed');offset+=n;}sync(fd);}finally{closeSync(fd);}};
    const key=randomBytes(32);let retained=false;
    try{
      if(readdirSync(directory).length)throw new Error('Existing custody requires recovery');
      lockFd=openSync(join(directory,'writer.lock'),constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);(options.lock??linuxInheritedJournalLock)(lockFd);sync(lockFd);sync(directoryFd);
      const journalId=randomUUID(),receipt={version:1 as const,journalId,suppressionKeyFingerprint:digest(key)};
      create('first-use.partial',Buffer.from(JSON.stringify(receipt)+'\n'));
      renameSync(join(directory,'first-use.partial'),join(directory,'first-use.json'));sync(directoryFd);
      // Receipt is durable BEFORE the first key/genesis byte is created.
      create('suppression.key',key);
      const genesis=financialJournalFrame({version:1,sequence:0,operationId:randomUUID(),previousDigest:zero,kind:'genesis',journalId,suppressionKeyFingerprint:receipt.suppressionKeyFingerprint});
      const control=financialJournalFrame({version:1,sequence:1,operationId:randomUUID(),previousDigest:genesis.digest,kind:'control',control:{journalId,database,checkpoint:null}});
      const initial=Buffer.concat([genesis.bytes,control.bytes]);create('journal.jsonl',initial);sync(directoryFd);
      let closed=false,completed=false,tail=control.digest,sequence=2,expected=initial;
      const append=(kind:'preparation-complete'|'freeze')=>{
        if(closed)throw new Error('Preparation custody is closed');
        verifyDirectory(directory,uid);
        const lockStat=fstatSync(lockFd!),lockPath=lstatSync(join(directory,'writer.lock'));
        if(lockStat.ino!==lockPath.ino||lockStat.dev!==lockPath.dev)throw new Error('Preparation lock changed');
        const fd=protectedFile(join(directory,'journal.jsonl'),uid,constants.O_RDWR|constants.O_APPEND);
        try{
          const raw=readFileSync(fd);if(!raw.equals(expected))throw new Error('Preparation journal changed');
          const frame=financialJournalFrame({version:1,sequence,operationId:receipt.journalId,previousDigest:tail,...(kind==='freeze'?{kind:'freeze' as const,reason:'uncertain' as const}:{kind:'preparation-complete' as const})});
          let offset=0;while(offset<frame.bytes.length){const n=writeSync(fd,frame.bytes,offset,frame.bytes.length-offset);if(n<1)throw new Error('Preparation journal write failed');offset+=n;}
          // Track the visible complete frame before fsync, so an error can append a
          // permanent freeze without mistaking it for acknowledged preparation.
          sequence++;tail=frame.digest;expected=Buffer.concat([expected,frame.bytes]);sync(fd);
        }finally{closeSync(fd);}
      };
      retained=true;
      return {
        complete:()=>{if(completed||closed)throw new Error('Preparation already completed');try{append('preparation-complete');completed=true;}catch(error){try{append('freeze');}catch{/* Malformed/uncertain custody remains recovery-only. */}throw error;}},
        close:()=>{if(closed)return;try{if(!completed)append('freeze');}finally{closed=true;closeSync(lockFd!);closeSync(directoryFd);}},
      };
    }finally{key.fill(0);if(!retained){if(lockFd!==undefined)closeSync(lockFd);closeSync(directoryFd);}}
  }
  private load(requirePrepared=false):void {
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
      else if(r.kind==='freeze'){this.frozen=true;}
      else if(r.kind==='preparation-complete'){if(r.sequence!==2||!this.control||this.preparationComplete||writer||this.pending)throw new Error('Preparation completion mismatch');this.preparationComplete=true;}
      else if(r.kind==='control'){if(this.pending||r.control.journalId!==this.journalId||JSON.stringify(r.control.checkpoint)!==JSON.stringify(this.lastCheckpoint))throw new Error('Journal control mismatch');if(this.control&&JSON.stringify(this.control.database)!==JSON.stringify(r.control.database))throw new Error('Journal database changed');this.control=r.control;}
      else if(r.kind==='writer-open'){if(writer||this.pending)throw new Error('Journal writer overlap');writer=r.operationId;}
      else if(r.kind==='writer-close'){if(writer!==r.operationId||this.pending)throw new Error('Journal writer mismatch');writer=undefined;}
      else if(r.kind==='begin'){if(!writer||this.pending||operations.has(r.operationId))throw new Error('Journal operation replay');operations.add(r.operationId);this.pending={id:r.operationId};}
      else if(r.kind==='proposal'){if(!this.pending||this.pending.id!==r.operationId||this.pending.proposal)throw new Error('Journal proposal mismatch');this.pending.proposal=frame.digest;}
      else if(r.kind==='commit'){if(!this.pending?.proposal||this.pending.id!==r.operationId||this.pending.proposal!==r.proposalDigest)throw new Error('Journal commit mismatch');this.lastCheckpoint={operationId:r.operationId,journalId:this.journalId,sequence:r.sequence-1,digest:r.proposalDigest};this.pending=undefined;}
      else if(r.kind==='abort'){if(!this.pending||this.pending.id!==r.operationId||(this.pending.proposal??null)!==r.proposalDigest)throw new Error('Journal abort mismatch');this.pending=undefined;}
      else throw new Error('Repeated journal genesis');
      this.sequence++;this.head=frame.digest;
    }
    if(!genesis)throw new Error('Missing genesis');this.size=raw.length;
    // A control record intrinsically declares prepared custody. No caller option may
    // downgrade its receipt/completion requirements to the genesis-only foundation.
    const prepared=requirePrepared||this.control!==undefined;
    if(prepared){
      if(!this.control)throw new Error('Prepared control missing');
      const receiptFd=protectedFile(join(this.directory,'first-use.json'),this.uid,constants.O_RDONLY);
      try{
        const receipt=receiptSchema.parse(JSON.parse(readFileSync(receiptFd,'utf8')));
        if(receipt.suppressionKeyFingerprint!==digest(this.#key)||receipt.journalId!==this.journalId)throw new Error('Receipt mismatch');
      }finally{closeSync(receiptFd);}
    }
    // Validate custody before writing a freeze or opening/adopting any writer history.
    if(prepared&&!this.preparationComplete||this.pending||writer||this.control&&JSON.stringify(this.control.checkpoint)!==JSON.stringify(this.lastCheckpoint)){
      if(!prepared)throw new Error('Uncompleted financial operation or writer');
      this.persistFreeze('uncertain');
    }
  }
  /** The in-process barrier precedes pool checkout. Kernel ownership spans this object's
   * entire life; contention refuses rather than queueing another spending operation. */
  async operation<T>(kind:BudgetFinancialOperation,work:(operationId:string)=>Promise<T>):Promise<T> {
    if(this.closed||this.frozen||this.stopping||this.busy)throw new Error('Financial journal is closed or busy');
    // Reserve begin, maximum proposal, terminal and writer-close BEFORE any database
    // work. Capacity exhaustion leaves this writer able to close cleanly.
    this.requireCapacity(this.control?6:4,JOURNAL_MAX_RECORD_BYTES+5*CONTROL_RECORD_BYTES);
    this.busy=true;const operationId=randomUUID();
    try{
      this.append({kind:'begin',operation:operation.parse(kind)},operationId);this.pending={id:operationId};
      const result=await work(operationId);
      if(this.pending||this.frozen)throw new Error('Financial operation did not durably finish');
      return result;
    }
    catch(error){if(this.pending)this.frozen=true;throw error;}
    finally{this.busy=false;if(this.pending)this.frozen=true;for(const resolve of this.idle)resolve();this.idle.clear();}
  }
  propose(operationId:string,atoms:readonly FinancialAtom[]):FinancialJournalProposal {
    if(this.pending?.id!==operationId||this.pending.proposal)throw new Error('Financial proposal unavailable');
    financialProposalFrame(operationId,this.sequence,this.head,atoms);
    const frame=this.append({kind:'proposal',atoms:[...atoms]},operationId);this.pending.proposal=frame.digest;
    return {journalId:this.journalId,operationId,sequence:frame.sequence,digest:frame.digest};
  }
  validateProposal(operationId:string,atoms:readonly FinancialAtom[]):void {
    if(this.pending?.id!==operationId||this.pending.proposal)throw new Error('Financial proposal unavailable');
    financialProposalFrame(operationId,this.sequence,this.head,atoms);
  }
  committed(operationId:string):void {
    if(this.pending?.id!==operationId||!this.pending.proposal)throw new Error('Financial proposal unavailable');
    const proposal=this.pending.proposal,sequence=this.sequence-1;
    this.append({kind:'commit',proposalDigest:proposal},operationId);this.pending=undefined;
    this.lastCheckpoint={operationId,journalId:this.journalId,sequence,digest:proposal};
    if(this.control){this.control={...this.control,checkpoint:this.lastCheckpoint};this.append({kind:'control',control:this.control},this.writerId);}
  }
  aborted(operationId:string,reason:'not-started'|'rollback-acknowledged'|'source-retirement-acknowledged'|'source-retirement-rolled-back'):void {
    if(this.pending?.id!==operationId)throw new Error('Financial operation unavailable');
    this.append({kind:'abort',proposalDigest:this.pending.proposal??null,reason},operationId);this.pending=undefined;
  }
  freeze():void {this.persistFreeze('uncertain');}
  /** Each observation is made on startup, before owned mutation, and immediately before
   * COMMIT on that SAME client. A match cannot clear a previously durable freeze. */
  verifyContinuity(database:FinancialDatabase,checkpoint:FinancialCheckpoint|null,proposed=false):void {
    const expected=proposed&&this.pending?.proposal?{operationId:this.pending.id,journalId:this.journalId,sequence:this.sequence-1,digest:this.pending.proposal}:this.control?.checkpoint;
    if(this.closed||this.frozen||!this.control||JSON.stringify(FINANCIAL_DATABASE_SCHEMA.parse(database))!==JSON.stringify(this.control.database)||JSON.stringify(checkpoint)!==JSON.stringify(expected)){
      this.persistFreeze('continuity');throw new Error('Financial continuity requires recovery');
    }
  }
  get prepared():boolean{return this.control!==undefined;}
  async drainForShutdown():Promise<void>{
    this.stopping=true;
    if(this.busy)await new Promise<void>(resolve=>{this.idle.add(resolve);});
  }
  async freezeForRestore(timeoutMs=2000):Promise<void>{
    if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000)throw new Error('Invalid freeze deadline');
    this.stopping=true; // synchronous: no new operation can cross the barrier
    if(this.busy){let timer:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([new Promise<void>(resolve=>{this.idle.add(resolve);}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Financial operation did not drain')),timeoutMs);})]);}
      finally{if(timer)clearTimeout(timer);}
    }
    this.persistFreeze('restore');
  }
  private persistFreeze(reason:'restore'|'continuity'|'uncertain'):void {
    if(this.closed)throw new Error('Financial custody unavailable');
    const busy=this.busy;this.busy=true;
    try{this.append({kind:'freeze',reason},this.writerId,true);this.frozen=true;}
    finally{this.busy=busy;this.frozen=true;}
  }
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
  private append(body:Record<string,unknown>,operationId:string,allowFrozen=false):{sequence:number;digest:string} {
    try{
      if(this.closed||this.frozen&&!allowFrozen||!this.busy)throw new Error('Financial journal unavailable');
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
