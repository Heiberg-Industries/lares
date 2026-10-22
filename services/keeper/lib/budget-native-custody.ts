/** Host-only pending native custody. This module performs no RPC/SQL and grants no
 * spending authority. Production wiring must first cover pending operations in removal,
 * erasure and explicit recovery. Never expose ownership/lock test seams in configuration. */
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {closeSync,constants,fchmodSync,fchownSync,fstatSync,fsyncSync,lstatSync,mkdirSync,opendirSync,openSync,readSync,renameSync,unlinkSync,writeSync,type BigIntStats} from 'node:fs';
import {dirname,isAbsolute,join,normalize,parse} from 'node:path';
import {z} from 'zod';
import {canonicalBudgetMoney} from '@lares/agent-kit/budget-admission-store';
import {gatewayCanonical,gatewayHash} from '@lares/agent-kit/gateway-admission-protocol';
import {gatewayMaximumLiability,gatewayPricingSchema} from '@lares/agent-kit/gateway-pricing';
import {linuxInheritedJournalLock,committedFinancialEvidence,requireCurrentFinancialPublicationProof,type CommittedFinancialReceipt,type FinancialAtom} from './financial-journal.js';
import {consumeNativeHashAbsenceReceipt,type NativeHashAbsenceReceipt} from './budget-native-client.js';

export const NATIVE_CUSTODY_DIRECTORY='/var/lib/lares/budget-native';
export const NATIVE_CUSTODY_MAX_RECORDS=128,NATIVE_CUSTODY_MAX_BYTES=1_048_576,NATIVE_CUSTODY_POLICY_BYTES=16_384;
const CONTROL_BYTES=1024,INTENT_BYTES=2048,KEY_BYTES=46;
const uuid=z.string().uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/);
const instant=z.iso.datetime({precision:6});
// PostgreSQL credential_generation is a nonnegative signed bigint. Retain canonical
// decimal strings throughout; Number would lose precision at this boundary.
const generation=z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(value=>BigInt(value)<=9_223_372_036_854_775_807n);
const nativeId=z.string().regex(/^[A-Za-z0-9-]{1,80}$/),alias=z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const money=z.string().max(37).refine(value=>{try{return canonicalBudgetMoney(value)===value&&value!=='0';}catch{return false;}});
const models=z.array(alias).min(1).max(4).refine(values=>new Set(values).size===values.length);
const origin=z.string().max(512).refine(value=>{try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&url.origin===value&&!url.username&&!url.password;}catch{return false;}});
const endpoint=z.object({origin,hash}).strict();
const teamPolicy=z.object({maxBudget:money,models,budgetDuration:z.literal('1d')}).strict();
const userPolicy=z.object({maxBudget:money,userRole:z.literal('internal_user'),autoCreateKey:z.literal(false)}).strict();
const membershipPolicy=z.object({maxBudget:money,allowedModels:models,budgetDuration:z.literal('1d'),role:z.literal('user')}).strict();
const keyPolicy=z.object({maxBudget:money,models,budgetDuration:z.literal('1d'),keyType:z.literal('llm_api'),blocked:z.literal(true)}).strict();
const writeAttempt=z.enum(['not-attempted','attempted','verified']);
// Same bounded capability document and canonical hash as the gateway's Profile. Prices
// and native caps remain explicit reviewed inputs; neither this schema nor the store defaults them.
const capability=z.object({version:z.literal(1),provider:z.enum(['openai','anthropic']),model:z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/),providerBaseUrl:z.string().max(512).refine(value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&!value.endsWith('/');}catch{return false;}}),aliases:models.refine(values=>values.length===4),maxBodyBytes:z.number().int().min(1).max(1_048_576),maxOutputTokens:z.number().int().min(1).max(1_000_000)}).strict();
export const budgetNativeReviewedPolicySchema=z.object({capability,pricing:gatewayPricingSchema,maximumLiability:money,team:teamPolicy,user:userPolicy,membership:membershipPolicy,key:keyPolicy}).strict().superRefine((p,ctx)=>{
  if(gatewayHash(gatewayCanonical(p.capability))!==p.pricing.capabilityHash||p.pricing.format!==p.capability.provider||p.pricing.limits.outputTokens>p.capability.maxOutputTokens||gatewayMaximumLiability(p.pricing)!==p.maximumLiability||[...p.team.models,...p.membership.allowedModels,...p.key.models].some(a=>!p.capability.aliases.includes(a)))ctx.addIssue({code:'custom',message:'Reviewed policy mismatch'});
});
export type BudgetNativeReviewedPolicy=z.infer<typeof budgetNativeReviewedPolicySchema>;
const receipt=z.object({journalId:uuid,operationId:uuid,operation:z.enum(['prepare','provision','native-activation','admit','grant','unknown','settle','member-remove','erase-person','native-cleanup-recovery']),proposalSequence:z.number().int().positive().safe(),proposalDigest:hash}).strict();
const activationIntent=z.object({financialOperationId:uuid,journalId:uuid,originalBindingReceiptHash:hash,installationAccountId:uuid,memberAccountId:uuid,endpointHash:hash,installationCap:money,memberWindowCap:money,
  installationWindowId:uuid,memberWindowId:uuid,endpointGeneration:generation,recoveryEpochHash:hash,monthStartsAt:instant,monthEndsAt:instant,unblockAttempt:writeAttempt}).strict();
const team=z.object({kind:z.literal('team'),ownershipId:uuid,installationAccountId:uuid,endpoint,nativeTeamId:nativeId,capabilityHash:hash,policy:teamPolicy,createAttempt:writeAttempt}).strict();
const user=z.object({kind:z.literal('user'),ownershipId:uuid,installationAccountId:uuid,accountId:uuid,endpoint,teamOwnershipId:uuid,nativeUserId:nativeId,policy:userPolicy,membership:membershipPolicy,userCreateAttempt:writeAttempt,membershipCreateAttempt:writeAttempt}).strict();
const erasedUser=z.object({kind:z.literal('erased-user'),accountCommitment:hash,coordinateCommitment:hash,erasureReceiptHash:hash}).strict();
const operation=z.object({kind:z.literal('operation'),operationId:uuid,bindingId:uuid,credentialGeneration:generation,userOwnershipId:uuid,
  association:z.object({agent:z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),incarnation:uuid,definitionHash:hash,purposeAlias:alias}).strict(),
  reviewedPolicy:budgetNativeReviewedPolicySchema,policyDigest:hash,keyFingerprint:hash,
  phase:z.enum(['prepared','provisioning','native-blocked-verified','bound-closed','activation-pending','active','uncertain','revoke-pending','revoked']),keyCreateAttempt:writeAttempt,
  financialOperationId:uuid.nullable(),financialJournalId:uuid.nullable(),bindingReceipt:receipt.nullable(),revocationReceipt:receipt.nullable(),
  activationIntent:activationIntent.nullable().default(null),activationReceipt:receipt.nullable().default(null),
  plaintext:z.enum(['present','removal-pending','removed']),nativeDeletion:z.enum(['unverified','verified']),
}).strict();
const cleanup=z.object({kind:z.literal('cleanup'),accountCommitment:hash,coordinateCommitment:hash,operationCommitment:hash,endpoint,keyFingerprint:hash,policyDigest:hash,revocationReceiptHash:hash,erasureReceiptHash:hash,phase:z.enum(['revoke-pending','revoked']),plaintext:z.literal('removed'),nativeDeletion:z.enum(['unverified','verified'])}).strict();
const snapshotSchema=z.object({version:z.literal(1),storeId:uuid,revision:z.number().int().nonnegative().safe(),teams:z.array(team),users:z.array(z.discriminatedUnion('kind',[user,erasedUser])),operations:z.array(z.discriminatedUnion('kind',[operation,cleanup]))}).strict();
type Snapshot=z.infer<typeof snapshotSchema>;
export type NativeTeamOwnership=z.infer<typeof team>;
export type NativeUserOwnership=z.infer<typeof user>;
export type NativeOperation=z.infer<typeof operation>;
export type NativeActivationIntent=z.infer<typeof activationIntent>;
export type NativeCleanupReceipt=z.infer<typeof cleanup>;
export interface NativeAbsenceRequest {readonly origin:string;readonly fingerprint:string;readonly challenge:string}
const controlSchema=z.object({version:z.literal(1),storeId:uuid,state:z.enum(['open','closed','uncertain']),revision:z.number().int().nonnegative().safe(),snapshotDigest:hash}).strict();
type Control=z.infer<typeof controlSchema>;
const publicationIntentSchema=z.object({version:z.literal(1),storeId:uuid,kind:z.enum(['snapshot','key-create','key-remove']),
  previous:z.object({controlDigest:hash,controlState:z.enum(['open','closed','uncertain']),revision:z.number().int().nonnegative().safe(),snapshotDigest:hash}).strict(),
  next:z.object({controlDigest:hash,revision:z.number().int().nonnegative().safe(),snapshotDigest:hash}).strict(),
  key:z.object({operationId:uuid,keyFingerprint:hash}).strict().nullable(),
}).strict().superRefine((value,ctx)=>{
  if((value.kind==='key-create'||value.kind==='key-remove')!==Boolean(value.key))ctx.addIssue({code:'custom',message:'Publication key target mismatch'});
});
type PublicationIntent=z.infer<typeof publicationIntentSchema>;
interface Options {ownershipUid?:number;ownershipGid?:number;lock?:(fd:number)=>void;sync?:(fd:number)=>void}
type Handle={fd:number;stat:BigIntStats;bytes:Buffer};
export type NativePublicationRecoveryResult=
  |{status:'no-intent';runtimeReady:false}
  |{status:'recovery-available';action:'complete-publication'|'cancel-unstarted-key-create'|'cancel-local-key-removal';runtimeReady:false}
  |{status:'repaired-locally';action:'complete-publication'|'cancel-unstarted-key-create'|'cancel-local-key-removal';runtimeReady:false}
  |{status:'recovery-required';runtimeReady:false};
const unavailable=()=>new Error('Native custody unavailable; explicit reconciliation is required');
const refused=()=>new Error('Native custody operation refused');
const same=(a:unknown,b:unknown)=>gatewayCanonical(a).equals(gatewayCanonical(b));
const digest=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
const frozenClone=<T>(value:T):T=>{const copy=clone(value);const freeze=(item:unknown):void=>{if(!item||typeof item!=='object'||Object.isFrozen(item))return;for(const child of Object.values(item))freeze(child);Object.freeze(item);};freeze(copy);return copy;};
const commitment=(domain:string,...values:string[])=>gatewayHash(gatewayCanonical([`lares.native-custody.${domain}.v1`,...values]));

export interface NativeCustodyGate {
  reserveTeam(installationAccountId:string,target:z.infer<typeof endpoint>,policy:BudgetNativeReviewedPolicy):NativeTeamOwnership;
  reserveUser(accountId:string,teamOwnershipId:string,policy:BudgetNativeReviewedPolicy):NativeUserOwnership;
  prepareOperation(input:{bindingId:string;credentialGeneration:string;userOwnershipId:string;association:NativeOperation['association'];reviewedPolicy:BudgetNativeReviewedPolicy},plaintext:string):NativeOperation;
  readOperation(operationId:string):NativeOperation;
  readKey(operationId:string):string;
  claimTeamCreate(ownershipId:string):NativeTeamOwnership;
  verifyTeamCreated(ownershipId:string):void;
  claimUserCreate(ownershipId:string):NativeUserOwnership;
  verifyUserCreated(ownershipId:string):void;
  claimMembershipCreate(ownershipId:string):NativeUserOwnership;
  verifyMembershipCreated(ownershipId:string):void;
  claimKeyCreate(operationId:string):NativeOperation;
  verifyKeyCreated(operationId:string):void;
  beginProvisioning(operationId:string):void;
  recordNativeBlockedVerification(operationId:string):void;
  linkFinancialOperation(operationId:string,financialOperationId:string,journalId:string):void;
  recordBoundClosed(operationId:string,evidence:CommittedFinancialReceipt):void;
  beginActivation(operationId:string,activation:{financialOperationId:string;journalId:string;installationWindowId:string;memberWindowId:string;endpointGeneration:string;recoveryEpochHash:string;monthStartsAt:string;monthEndsAt:string;installationCap:string;memberWindowCap:string}):NativeOperation;
  claimActivationUnblock(operationId:string):NativeOperation;
  verifyActivationUnblocked(operationId:string):void;
  recordActive(operationId:string,evidence:CommittedFinancialReceipt):void;
  recordUncertain(operationId:string):void;
  recordRevocation(operationId:string,evidence:CommittedFinancialReceipt):void;
  removePlaintext(operationId:string):void;
  eraseAccountAssociation(accountId:string,evidence:CommittedFinancialReceipt):void;
  accountOperations(accountId:string):readonly NativeOperation[];
  prepareNativeAbsence(operationId:string):NativeAbsenceRequest;
  prepareErasedNativeAbsence(keyFingerprint:string):NativeAbsenceRequest;
  recordNativeAbsence(operationId:string,evidence:NativeHashAbsenceReceipt):void;
  recordErasedNativeAbsence(keyFingerprint:string,evidence:NativeHashAbsenceReceipt):void;
  inventory():Snapshot;
}
export interface NativeCleanupRecoveryCandidate {
  readonly operationId:string;
  readonly accountId:string;
  readonly installationAccountId:string;
  readonly binding:Extract<FinancialAtom,{kind:'binding'}>;
  readonly phase:'bound-closed'|'activation-pending'|'active'|'revoke-pending';
  readonly plaintext:'present'|'removal-pending'|'removed';
}
export interface NativeCleanupRecoverySession {
  candidates():readonly NativeCleanupRecoveryCandidate[];
  publishLocalPlaintextCleanup(operationId:string,evidence:CommittedFinancialReceipt):void;
  close():void;
}

/** One lifecycle owner holds all descriptors and the inherited Linux kernel lock. The
 * nonblocking gate is acquired before any later source/journal ownership. No timers/leases. */
export class BudgetNativeCustodyStore {
  private frozen=false;private stopping=false;private closed=false;private busy=false;private idle=new Set<()=>void>();
  private snapshot!:Snapshot;private control!:Control;private lock!:Handle;private snapshotFile!:Handle;private controlFile!:Handle;
  private publicationIntent?:Handle;private publicationIntentRecord?:PublicationIntent;
  /** Retained only by the cleanup-recovery lifecycle; key paths are never reopened after awaits. */
  private recoveryKeyFiles?:Map<string,Handle>;
  /** Exact owned entries while a cleanup recovery publication is in flight. */
  private recoveryPartials?:Map<string,Handle>;
  private recoveryDetached?:Map<string,Handle>;
  private recoveryProof?:CommittedFinancialReceipt;
  private rootFd!:number;private rootStat!:BigIntStats;
  private readonly uid:number;private readonly gid:number;private readonly sync:(fd:number)=>void;
  private constructor(private directory:string,private options:Options){this.uid=options.ownershipUid??0;this.gid=options.ownershipGid??0;this.sync=options.sync??fsyncSync;}
  /** Explicit fresh creation only. A partial/existing directory is never reused. */
  static createNew(directory:string,options:Options={}):BudgetNativeCustodyStore {
    const owner=new BudgetNativeCustodyStore(directory,options);
    try{
      if(!isAbsolute(directory)||normalize(directory)!==directory)throw unavailable();
      owner.verifyAncestors(dirname(directory));mkdirSync(directory,{mode:0o700});
      const parent=openSync(dirname(directory),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{owner.sync(parent);}finally{closeSync(parent);}
      owner.openRoot();owner.lock=owner.createFile('writer.lock',Buffer.alloc(0));(options.lock??linuxInheritedJournalLock)(owner.lock.fd);
      owner.snapshot={version:1,storeId:randomUUID(),revision:0,teams:[],users:[],operations:[]};
      owner.snapshotFile=owner.createFile('snapshot.json',owner.snapshotBytes(owner.snapshot));
      owner.control={version:1,storeId:owner.snapshot.storeId,state:'open',revision:0,snapshotDigest:digest(owner.snapshotFile.bytes)};
      owner.controlFile=owner.createFile('control.json',gatewayCanonical(owner.control));owner.syncRoot();owner.verify();return owner;
    }catch{owner.release();throw unavailable();}
  }
  /** No mkdir, file creation, key regeneration, adoption or partial-tail repair. */
  static openExisting(directory:string,options:Options={}):BudgetNativeCustodyStore {
    const owner=new BudgetNativeCustodyStore(directory,options);
    try{
      owner.openRoot();owner.lock=owner.openFile('writer.lock',0);if(owner.lock.bytes.length!==0)throw unavailable();(options.lock??linuxInheritedJournalLock)(owner.lock.fd);
      owner.controlFile=owner.openFile('control.json',CONTROL_BYTES);owner.control=owner.decode(controlSchema,owner.controlFile.bytes);
      if(owner.control.state!=='closed')throw unavailable();
      owner.snapshotFile=owner.openFile('snapshot.json',NATIVE_CUSTODY_MAX_BYTES);owner.snapshot=owner.decode(snapshotSchema,owner.snapshotFile.bytes);
      owner.verify();owner.publishControl({...owner.control,state:'open'});return owner;
    }catch{owner.release();throw unavailable();}
  }
  /** Acquires a cleanup-only owner for an exact open store. It exposes no runtime gate,
   * key reader, or ordinary store handle, and never closes the persisted open control. */
  static openCleanupRecovery(directory:string,options:Options={}):NativeCleanupRecoverySession {
    const owner=new BudgetNativeCustodyStore(directory,options);let active=true;
    const assertActive=()=>{if(!active||owner.closed||owner.frozen)throw unavailable();};
    try{
      owner.openRoot();owner.lock=owner.openFile('writer.lock',0);if(owner.lock.bytes.length!==0)throw unavailable();(options.lock??linuxInheritedJournalLock)(owner.lock.fd);
      owner.controlFile=owner.openFile('control.json',CONTROL_BYTES);owner.control=owner.decode(controlSchema,owner.controlFile.bytes);
      if(owner.control.state!=='open')throw unavailable();
      owner.snapshotFile=owner.openFile('snapshot.json',NATIVE_CUSTODY_MAX_BYTES);owner.snapshot=owner.decode(snapshotSchema,owner.snapshotFile.bytes);
      owner.verify();
      owner.recoveryKeyFiles=new Map();
      owner.recoveryPartials=new Map();owner.recoveryDetached=new Map();
      for(const op of owner.snapshot.operations)if(op.kind==='operation'&&op.plaintext!=='removed'){
        const name=owner.keyName(op.operationId);owner.recoveryKeyFiles.set(name,owner.openFile(name,KEY_BYTES));
      }
      owner.verify();
      const candidates=owner.snapshot.operations.flatMap(row=>{
        if(row.kind!=='operation'||!(row.phase==='bound-closed'||row.phase==='activation-pending'||row.phase==='active'||row.phase==='revoke-pending')||(row.plaintext!=='present'&&row.plaintext!=='removal-pending'&&row.plaintext!=='removed')||row.nativeDeletion!=='unverified')return [];
        const user=owner.snapshot.users.find((candidate):candidate is NativeUserOwnership=>candidate.kind==='user'&&candidate.ownershipId===row.userOwnershipId);
        if(!user)return [];
        return [{operationId:row.operationId,accountId:user.accountId,installationAccountId:user.installationAccountId,binding:{...owner.bindingAtom(row,'revoked'),state:'revoked' as const},phase:row.phase,plaintext:row.plaintext}];
      });
      const safeCandidates=frozenClone(candidates);
      const session:NativeCleanupRecoverySession={
        candidates:()=>{assertActive();owner.verify();return safeCandidates;},
        publishLocalPlaintextCleanup:(operationId,evidence)=>{
          assertActive();owner.verify();
          try{owner.publishNativeCleanupRecovery(operationId,evidence);owner.verify();}
          catch(error){if(error instanceof Error&&error.message==='Native custody operation refused')throw error;owner.frozen=true;throw unavailable();}
        },
        close:()=>{if(!active)return;active=false;owner.release();},
      };
      return Object.freeze(session);
    }catch{active=false;owner.release();throw unavailable();}
  }
  /** Read-only inspection under the native writer lock. This never returns custody data
   * or a runtime gate and cannot make an interrupted store usable. */
  static inspectPublicationRecovery(directory:string,options:Options={}):NativePublicationRecoveryResult {
    return this.runPublicationRecovery(directory,options,false);
  }
  /** Performs only a fully evidenced local file completion/cancellation. The runtime
   * store must still be opened separately through the unchanged strict openExisting(). */
  static repairPublicationRecovery(directory:string,options:Options={}):NativePublicationRecoveryResult {
    return this.runPublicationRecovery(directory,options,true);
  }
  private static runPublicationRecovery(directory:string,options:Options,repair:boolean):NativePublicationRecoveryResult {
    const owner=new BudgetNativeCustodyStore(directory,options),partials=new Map<string,Handle>(),owned=new Set<Handle>(),tracked=new Map<string,Handle>(),keyFiles=new Map<string,Handle>();
    const own=(name:string,file:Handle):Handle=>{if(tracked.has(name))throw unavailable();owned.add(file);tracked.set(name,file);return file;};
    const closeOwned=(file:Handle):void=>{if(!owned.delete(file))return;file.bytes.fill(0);try{closeSync(file.fd);}catch{}};
    const forget=(name:string,file:Handle):void=>{if(tracked.get(name)===file)tracked.delete(name);closeOwned(file);};
    const guard=():void=>{
      owner.assertOwner();for(const [name,file] of tracked)owner.assertHandle(name,file,name==='control.json'||name==='.control.json.partial'?CONTROL_BYTES:name==='writer.lock'?0:name==='publication-intent.json'?INTENT_BYTES:name.endsWith('.key')?KEY_BYTES:NATIVE_CUSTODY_MAX_BYTES);
      const expected=[...tracked.keys()].sort(),actual=owner.inventoryNames().sort();if(expected.length!==actual.length||expected.some((name,index)=>name!==actual[index]))throw unavailable();
    };
    const syncTracked=(fd:number):void=>{owner.sync(fd);guard();};
    const syncRootTracked=(skipIntentCheck=false):void=>{owner.syncRoot(skipIntentCheck);guard();};
    let result:NativePublicationRecoveryResult={status:'recovery-required',runtimeReady:false};
    try{
      owner.openRoot();owner.lock=own('writer.lock',owner.openFile('writer.lock',0));if(owner.lock.bytes.length!==0)throw unavailable();
      (options.lock??linuxInheritedJournalLock)(owner.lock.fd);
      const names=owner.inventoryNames();
      owner.snapshotFile=own('snapshot.json',owner.openFile('snapshot.json',NATIVE_CUSTODY_MAX_BYTES));
      owner.controlFile=own('control.json',owner.openFile('control.json',CONTROL_BYTES));
      owner.snapshot=owner.decode(snapshotSchema,owner.snapshotFile.bytes);owner.control=owner.decode(controlSchema,owner.controlFile.bytes);
      const intentPresent=names.includes('publication-intent.json');
      if(!intentPresent){
        if(names.some(name=>name==='.snapshot.json.partial'||name==='.control.json.partial'))throw unavailable();
        const expected=new Map<string,string>();for(const op of owner.snapshot.operations)if(op.kind==='operation'&&op.plaintext!=='removed')expected.set(owner.keyName(op.operationId),op.keyFingerprint);
        for(const [name,fingerprint] of expected)if(names.includes(name)){const file=own(name,owner.openFile(name,KEY_BYTES));keyFiles.set(name,file);if(digest(file.bytes)!==fingerprint)throw unavailable();}
        guard();owner.verify(new Set(),{keyFiles});guard();result={status:'no-intent',runtimeReady:false};return result;
      }
      owner.publicationIntent=own('publication-intent.json',owner.openFile('publication-intent.json',INTENT_BYTES));
      owner.publicationIntentRecord=owner.decode(publicationIntentSchema,owner.publicationIntent.bytes);
      for(const name of ['.snapshot.json.partial','.control.json.partial'])if(names.includes(name))partials.set(name,own(name,owner.openFile(name,name==='.control.json.partial'?CONTROL_BYTES:NATIVE_CUSTODY_MAX_BYTES)));
      const intent=owner.publicationIntentRecord,actualSnapshot=owner.snapshotFile.bytes,actualControl=owner.controlFile.bytes;
      if(intent.next.revision!==intent.previous.revision+1||!Number.isSafeInteger(intent.next.revision)||intent.previous.controlState!=='open'||intent.storeId!==owner.snapshot.storeId||owner.control.storeId!==intent.storeId||owner.snapshot.storeId!==intent.storeId)throw unavailable();

      const snapshots=new Map<string,{handle:Handle;value:Snapshot}>(),controls=new Map<string,{handle:Handle;value:Control}>();
      snapshots.set('snapshot.json',{handle:owner.snapshotFile,value:owner.snapshot});
      controls.set('control.json',{handle:owner.controlFile,value:owner.control});
      const snapshotPartial=partials.get('.snapshot.json.partial'),controlPartial=partials.get('.control.json.partial');
      if(snapshotPartial)snapshots.set('.snapshot.json.partial',{handle:snapshotPartial,value:owner.decode(snapshotSchema,snapshotPartial.bytes)});
      if(controlPartial)controls.set('.control.json.partial',{handle:controlPartial,value:owner.decode(controlSchema,controlPartial.bytes)});
      const expectedKeys=new Map<string,string>();for(const {value} of snapshots.values())for(const op of value.operations)if(op.kind==='operation'&&op.plaintext!=='removed'){
        const name=owner.keyName(op.operationId),found=expectedKeys.get(name);if(found&&found!==op.keyFingerprint)throw unavailable();expectedKeys.set(name,op.keyFingerprint);
      }
      if(expectedKeys.size>NATIVE_CUSTODY_MAX_RECORDS)throw unavailable();
      for(const [name,fingerprint] of expectedKeys)if(names.includes(name)){const file=own(name,owner.openFile(name,KEY_BYTES));keyFiles.set(name,file);if(digest(file.bytes)!==fingerprint)throw unavailable();}
      guard();
      for(const {value} of snapshots.values())if(value.storeId!==intent.storeId)throw unavailable();
      for(const {value} of controls.values())if(value.storeId!==intent.storeId)throw unavailable();
      const currentSnapshotIsPrevious=owner.snapshot.revision===intent.previous.revision&&digest(actualSnapshot)===intent.previous.snapshotDigest;
      const currentSnapshotIsNext=owner.snapshot.revision===intent.next.revision&&digest(actualSnapshot)===intent.next.snapshotDigest;
      const currentControlIsPrevious=owner.control.revision===intent.previous.revision&&digest(actualControl)===intent.previous.controlDigest&&
        owner.control.state===intent.previous.controlState&&owner.control.snapshotDigest===intent.previous.snapshotDigest;
      const currentControlIsNext=owner.control.revision===intent.next.revision&&digest(actualControl)===intent.next.controlDigest&&
        owner.control.state===intent.previous.controlState&&owner.control.snapshotDigest===intent.next.snapshotDigest;
      if((!currentSnapshotIsPrevious&&!currentSnapshotIsNext)||(!currentControlIsPrevious&&!currentControlIsNext))throw unavailable();
      for(const [name,candidate] of snapshots)if(name!== 'snapshot.json'&&
        (candidate.value.revision!==intent.next.revision||digest(candidate.handle.bytes)!==intent.next.snapshotDigest))throw unavailable();
      for(const [name,candidate] of controls)if(name!=='control.json'&&
        (candidate.value.revision!==intent.next.revision||digest(candidate.handle.bytes)!==intent.next.controlDigest))throw unavailable();

      const oldSnapshot=snapshots.get('snapshot.json')!,oldControl=controls.get('control.json')!;
      const isOld=oldSnapshot.value.revision===intent.previous.revision&&oldControl.value.revision===intent.previous.revision&&
        digest(actualSnapshot)===intent.previous.snapshotDigest&&digest(actualControl)===intent.previous.controlDigest&&
        oldControl.value.state===intent.previous.controlState&&oldControl.value.snapshotDigest===intent.previous.snapshotDigest;
      const nextSnapshot=[...snapshots.entries()].find(([,candidate])=>candidate.value.revision===intent.next.revision&&digest(candidate.handle.bytes)===intent.next.snapshotDigest);
      const nextControl=[...controls.entries()].find(([,candidate])=>candidate.value.revision===intent.next.revision&&digest(candidate.handle.bytes)===intent.next.controlDigest);
      if(nextSnapshot&&nextControl){
        const snapshotValue=nextSnapshot[1].value,controlValue=nextControl[1].value;
        if(snapshotValue.revision!==intent.next.revision||controlValue.revision!==intent.next.revision||controlValue.state!==intent.previous.controlState||
          controlValue.snapshotDigest!==intent.next.snapshotDigest||controlValue.storeId!==intent.storeId)throw unavailable();
        if(intent.kind==='snapshot'){
          if(intent.key!==null)throw unavailable();
        }else{
          const target=intent.key;if(!target)throw unavailable();
          const targetOperation=snapshotValue.operations.find((row):row is NativeOperation=>row.kind==='operation'&&row.operationId===target.operationId);
          if(!targetOperation||targetOperation.keyFingerprint!==target.keyFingerprint)throw unavailable();
          const previousSnapshot=[...snapshots.values()].find(candidate=>candidate.value.revision===intent.previous.revision&&digest(candidate.handle.bytes)===intent.previous.snapshotDigest)?.value;
          // When previous bytes remain, prove the transition against them. If they have
          // already been replaced, only the exact protected intent carries that history;
          // its summary digest cannot reconstruct or authenticate missing snapshot bytes.
          if(previousSnapshot){
            const previousOperation=previousSnapshot.operations.find((row):row is NativeOperation=>row.kind==='operation'&&row.operationId===target.operationId);
            if(intent.kind==='key-create'&&previousOperation)throw unavailable();
            if(intent.kind==='key-remove'&&(!previousOperation||previousOperation.keyFingerprint!==target.keyFingerprint||
              !same({...previousOperation,plaintext:'removed'},targetOperation)))throw unavailable();
          }
          if(intent.kind==='key-create'){
            if(targetOperation.phase!=='prepared'||targetOperation.plaintext!=='present'||targetOperation.keyCreateAttempt!=='not-attempted'||
              targetOperation.financialOperationId!==null||targetOperation.financialJournalId!==null||targetOperation.bindingReceipt!==null||targetOperation.revocationReceipt!==null||
              targetOperation.nativeDeletion!=='unverified')throw unavailable();
          }else if(targetOperation.phase!=='revoke-pending'||targetOperation.plaintext!=='removed'||targetOperation.nativeDeletion!=='unverified'||!targetOperation.revocationReceipt)throw unavailable();
        }
        owner.snapshot=snapshotValue;owner.snapshotFile=nextSnapshot[1].handle;owner.control=controlValue;owner.controlFile=nextControl[1].handle;
        const extra=new Set<string>(['publication-intent.json',...names.filter(name=>name==='.snapshot.json.partial'||name==='.control.json.partial'||
          (name==='snapshot.json'&&nextSnapshot[0]!==name)||(name==='control.json'&&nextControl[0]!==name))]);
        owner.verify(new Set(),{snapshotName:nextSnapshot[0],controlName:nextControl[0],extraNames:extra,keyFiles});guard();
        result={status:'recovery-available',action:'complete-publication',runtimeReady:false};
        if(!repair)return result;
        if(intent.kind==='key-create'&&intent.key){
          const keyName=owner.keyName(intent.key.operationId),keyFile=keyFiles.get(keyName);if(!keyFile||digest(keyFile.bytes)!==intent.key.keyFingerprint)throw unavailable();
          syncTracked(keyFile.fd);
        }
        for(const [partialName,finalName] of [['.snapshot.json.partial','snapshot.json'],['.control.json.partial','control.json']] as const){
          const chosen=partialName==='.snapshot.json.partial'?nextSnapshot[0]:nextControl[0];
          if(chosen!==partialName)continue;
          const next=partials.get(partialName);if(!next)throw unavailable();
          const current=partialName==='.snapshot.json.partial'?owner.snapshotFile:owner.controlFile;
          const old=partialName==='.snapshot.json.partial'?oldSnapshot.handle:oldControl.handle;
          if(current!==next)throw unavailable();owner.assertHandle(partialName,next,partialName==='.control.json.partial'?CONTROL_BYTES:NATIVE_CUSTODY_MAX_BYTES);
          if(old!==next)owner.assertHandle(finalName,old,finalName==='control.json'?CONTROL_BYTES:NATIVE_CUSTODY_MAX_BYTES);
          syncTracked(next.fd);owner.assertOwner();owner.assertHandle(partialName,next,partialName==='.control.json.partial'?CONTROL_BYTES:NATIVE_CUSTODY_MAX_BYTES);
          if(old!==next)owner.assertHandle(finalName,old,finalName==='control.json'?CONTROL_BYTES:NATIVE_CUSTODY_MAX_BYTES);
          guard();renameSync(join(directory,partialName),join(directory,finalName));tracked.delete(partialName);tracked.delete(finalName);next.stat=fstatSync(next.fd,{bigint:true});tracked.set(finalName,next);owner.assertHandle(finalName,next,finalName==='control.json'?CONTROL_BYTES:NATIVE_CUSTODY_MAX_BYTES);
          if(finalName==='snapshot.json')owner.snapshotFile=next;else owner.controlFile=next;
          if(old!==next){closeOwned(old);if(finalName==='snapshot.json')owner.snapshotFile=next;else owner.controlFile=next;}
          syncRootTracked();partials.delete(partialName);
        }
        for(const [name,file] of [...partials]){guard();unlinkSync(join(directory,name));tracked.delete(name);partials.delete(name);closeOwned(file);syncRootTracked();}
        owner.verify(new Set(),{keyFiles});guard();
        const intentFile=owner.publicationIntent;if(!intentFile||!owner.publicationIntentRecord)throw unavailable();
        guard();unlinkSync(join(directory,'publication-intent.json'));tracked.delete('publication-intent.json');owner.publicationIntent=undefined;owner.publicationIntentRecord=undefined;closeOwned(intentFile);syncRootTracked(true);
        owner.verify(new Set(),{keyFiles});guard();
        result={status:'repaired-locally',action:'complete-publication',runtimeReady:false};return result;
      }

      if(!isOld)throw unavailable();
      // Every recognized partial must independently be exact canonical next bytes. They
      // may be discarded only for the two transitions whose external ordering proves no
      // later side effect could have started while the old pair remained current.
      if(owner.control.state==='uncertain')throw unavailable();
      const extra=new Set<string>(partials.keys());
      owner.verify(new Set(),{intentMode:'old',extraNames:extra,keyFiles});guard();
      let action:'cancel-unstarted-key-create'|'cancel-local-key-removal';
      const key=intent.key;
      if(intent.kind==='key-create'&&key&&owner.snapshot.operations.every(op=>op.kind!=='operation'||op.operationId!==key.operationId)&&!names.includes(`${key.operationId}.key`)){
        const partialSnapshot=snapshots.get('.snapshot.json.partial')?.value;
        if(partialSnapshot){
          const intended=partialSnapshot.operations.find((row):row is NativeOperation=>row.kind==='operation'&&row.operationId===key.operationId);
          if(!intended||intended.keyFingerprint!==key.keyFingerprint||intended.phase!=='prepared'||intended.plaintext!=='present'||intended.keyCreateAttempt!=='not-attempted'||
            intended.financialOperationId!==null||intended.financialJournalId!==null||intended.bindingReceipt!==null||intended.revocationReceipt!==null||intended.nativeDeletion!=='unverified')throw unavailable();
        }
        action='cancel-unstarted-key-create';
      }else if(intent.kind==='key-remove'&&key){
        const op=owner.snapshot.operations.find((row):row is NativeOperation=>row.kind==='operation'&&row.operationId===key.operationId);
        if(!op||op.keyFingerprint!==key.keyFingerprint||op.phase!=='revoke-pending'||op.plaintext!=='removal-pending'||op.nativeDeletion!=='unverified')throw unavailable();
        const partialSnapshot=snapshots.get('.snapshot.json.partial')?.value;
        if(partialSnapshot){
          const intended=partialSnapshot.operations.find((row):row is NativeOperation=>row.kind==='operation'&&row.operationId===key.operationId);
          if(!intended||intended.keyFingerprint!==key.keyFingerprint||intended.phase!=='revoke-pending'||intended.plaintext!=='removed'||intended.nativeDeletion!=='unverified'||!intended.revocationReceipt)throw unavailable();
        }
        const keyFile=keyFiles.get(owner.keyName(key.operationId));if(!keyFile||digest(keyFile.bytes)!==key.keyFingerprint)throw unavailable();
        action='cancel-local-key-removal';
      }else throw unavailable();
      result={status:'recovery-available',action,runtimeReady:false};if(!repair)return result;
      for(const [name,file] of [...partials]){guard();unlinkSync(join(directory,name));tracked.delete(name);partials.delete(name);closeOwned(file);syncRootTracked();}
      const intentFile=owner.publicationIntent;if(!intentFile)throw unavailable();guard();unlinkSync(join(directory,'publication-intent.json'));tracked.delete('publication-intent.json');closeOwned(intentFile);owner.publicationIntent=undefined;owner.publicationIntentRecord=undefined;
      syncRootTracked(true);owner.verify(new Set(),{keyFiles});guard();result={status:'repaired-locally',action,runtimeReady:false};return result;
    }catch{
      return {status:'recovery-required',runtimeReady:false};
    }finally{
      for(const file of owned)closeOwned(file);
      owner.closed=true;if(owner.rootFd!==undefined)try{closeSync(owner.rootFd);}catch{}
    }
  }
  async withGate<T>(work:(gate:NativeCustodyGate)=>Promise<T>):Promise<T>{
    if(this.closed||this.frozen||this.stopping||this.busy)throw unavailable();this.busy=true;let active=true;const absenceChallenges=new Map<string,string>();
    const prepareAbsence=(id:string,erased:boolean):NativeAbsenceRequest=>{const target=this.absenceTarget(id,erased),challenge=randomBytes(32).toString('hex');absenceChallenges.set(target.fingerprint,challenge);return Object.freeze({...target,challenge});};
    const recordAbsence=(id:string,r:NativeHashAbsenceReceipt,erased:boolean)=>{const target=this.absenceTarget(id,erased),challenge=absenceChallenges.get(target.fingerprint);if(!challenge)throw refused();this.recordNativeAbsence(id,r,erased,challenge);absenceChallenges.delete(target.fingerprint);};
    const call=<T>(fn:()=>T):T=>{if(!active||this.closed||this.frozen)throw unavailable();try{this.verify();return fn();}catch(error){if(error instanceof Error&&error.message==='Native custody operation refused')throw error;this.freeze();throw unavailable();}};
    const gate:NativeCustodyGate={
      reserveTeam:(a,e,p)=>call(()=>this.reserveTeam(a,e,p)),reserveUser:(a,t,p)=>call(()=>this.reserveUser(a,t,p)),
      prepareOperation:(i,k)=>call(()=>this.prepareOperation(i,k)),readOperation:id=>call(()=>clone(this.operation(id))),readKey:id=>call(()=>this.readKey(id)),
      claimTeamCreate:id=>call(()=>this.claimTeamCreate(id)),verifyTeamCreated:id=>call(()=>this.verifyTeamCreated(id)),
      claimUserCreate:id=>call(()=>this.claimUserCreate(id)),verifyUserCreated:id=>call(()=>this.verifyUserCreated(id)),
      claimMembershipCreate:id=>call(()=>this.claimMembershipCreate(id)),verifyMembershipCreated:id=>call(()=>this.verifyMembershipCreated(id)),
      claimKeyCreate:id=>call(()=>this.claimKeyCreate(id)),verifyKeyCreated:id=>call(()=>this.verifyKeyCreated(id)),
      beginProvisioning:id=>call(()=>this.beginProvisioning(id)),
      recordNativeBlockedVerification:id=>call(()=>this.recordNativeBlockedVerification(id)),
      linkFinancialOperation:(id,financialId,journalId)=>call(()=>this.linkFinancialOperation(id,financialId,journalId)),recordBoundClosed:(id,r)=>call(()=>this.recordBoundClosed(id,r)),
      beginActivation:(id,value)=>call(()=>this.beginActivation(id,value)),claimActivationUnblock:id=>call(()=>this.claimActivationUnblock(id)),
      verifyActivationUnblocked:id=>call(()=>this.verifyActivationUnblocked(id)),recordActive:(id,r)=>call(()=>this.recordActive(id,r)),
      recordUncertain:id=>call(()=>{const op=this.operation(id);if(['revoked','revoke-pending'].includes(op.phase))throw refused();this.updateOperation({...op,phase:'uncertain'});this.freeze();throw unavailable();}),
      recordRevocation:(id,r)=>call(()=>this.recordRevocation(id,r)),removePlaintext:id=>call(()=>this.removePlaintext(id)),
      eraseAccountAssociation:(id,r)=>call(()=>this.eraseAccountAssociation(id,r)),inventory:()=>call(()=>clone(this.snapshot)),
      accountOperations:id=>call(()=>this.accountOperations(id)),prepareNativeAbsence:id=>call(()=>prepareAbsence(id,false)),prepareErasedNativeAbsence:fingerprint=>call(()=>prepareAbsence(fingerprint,true)),recordNativeAbsence:(id,r)=>call(()=>recordAbsence(id,r,false)),recordErasedNativeAbsence:(fingerprint,r)=>call(()=>recordAbsence(fingerprint,r,true)),
    };
    try{const value=await work(Object.freeze(gate));if(this.frozen)throw unavailable();this.verify();return value;}
    catch(error){if(!(error instanceof Error&&error.message==='Native custody operation refused'))this.freeze();throw error;}
    finally{active=false;absenceChallenges.clear();this.busy=false;for(const resolve of this.idle)resolve();this.idle.clear();}
  }
  async drainForShutdown():Promise<void>{this.stopping=true;if(this.busy)await new Promise<void>(resolve=>this.idle.add(resolve));}
  close():void {
    if(this.closed)return;if(this.busy)throw new Error('Native custody operation still owns the gate');
    try{if(!this.frozen){this.verify();this.publishControl({...this.control,state:'closed'});}}catch{this.freeze();throw unavailable();}finally{this.release();}
  }
  private checkedPolicy(value:unknown):BudgetNativeReviewedPolicy {
    try{const parsed=budgetNativeReviewedPolicySchema.parse(value);if(gatewayCanonical(parsed).length>NATIVE_CUSTODY_POLICY_BYTES)throw refused();return parsed;}catch{throw refused();}
  }
  private reserveTeam(installationAccountId:string,target:z.infer<typeof endpoint>,raw:BudgetNativeReviewedPolicy):NativeTeamOwnership {
    try{uuid.parse(installationAccountId);target=endpoint.parse(target);}catch{throw refused();}const p=this.checkedPolicy(raw);
    const found=this.snapshot.teams.find(t=>t.installationAccountId===installationAccountId&&t.endpoint.hash===target.hash);
    if(found){if(!same(found.endpoint,target)||!same(found.policy,p.team)||found.capabilityHash!==p.pricing.capabilityHash)throw refused();return clone(found);}
    const row:NativeTeamOwnership={kind:'team',ownershipId:randomUUID(),installationAccountId,endpoint:target,nativeTeamId:randomUUID(),capabilityHash:p.pricing.capabilityHash,policy:p.team,createAttempt:'not-attempted'};
    this.publish({...this.snapshot,teams:[...this.snapshot.teams,row]});return clone(row);
  }
  private reserveUser(accountId:string,teamOwnershipId:string,raw:BudgetNativeReviewedPolicy):NativeUserOwnership {
    try{uuid.parse(accountId);uuid.parse(teamOwnershipId);}catch{throw refused();}const p=this.checkedPolicy(raw),t=this.snapshot.teams.find(t=>t.ownershipId===teamOwnershipId);if(!t||!same(t.policy,p.team)||t.capabilityHash!==p.pricing.capabilityHash)throw refused();
    const coordinate=this.userCoordinate(accountId,t.endpoint.hash);
    const accountCommitment=commitment('erased-account',this.snapshot.storeId,accountId);
    if(this.snapshot.users.some(u=>u.kind==='erased-user'&&(u.coordinateCommitment===coordinate||u.accountCommitment===accountCommitment)))throw refused();
    const found=this.snapshot.users.find((u):u is NativeUserOwnership=>u.kind==='user'&&u.accountId===accountId&&u.endpoint.hash===t.endpoint.hash);
    if(found){if(found.teamOwnershipId!==t.ownershipId||!same(found.policy,p.user)||!same(found.membership,p.membership))throw refused();return clone(found);}
    const row:NativeUserOwnership={kind:'user',ownershipId:randomUUID(),installationAccountId:t.installationAccountId,accountId,endpoint:t.endpoint,teamOwnershipId:t.ownershipId,nativeUserId:randomUUID(),policy:p.user,membership:p.membership,userCreateAttempt:'not-attempted',membershipCreateAttempt:'not-attempted'};
    this.publish({...this.snapshot,users:[...this.snapshot.users,row]});return clone(row);
  }
  private prepareOperation(input:Parameters<NativeCustodyGate['prepareOperation']>[0],plaintext:string):NativeOperation {
    const p=this.checkedPolicy(input.reviewedPolicy);let association:NativeOperation['association'];
    try{uuid.parse(input.bindingId);generation.parse(input.credentialGeneration);uuid.parse(input.userOwnershipId);association=operation.shape.association.parse(input.association);}catch{throw refused();}
    if(!/^sk-[A-Za-z0-9_-]{43}$/.test(plaintext)||p.key.models.length!==1||p.key.models[0]!==association.purposeAlias)throw refused();
    const u=this.snapshot.users.find((u):u is NativeUserOwnership=>u.kind==='user'&&u.ownershipId===input.userOwnershipId);if(!u)throw refused();
    const t=this.snapshot.teams.find(t=>t.ownershipId===u.teamOwnershipId);if(!t||!same(t.policy,p.team)||t.capabilityHash!==p.pricing.capabilityHash||!same(u.policy,p.user)||!same(u.membership,p.membership))throw refused();
    const coordinate=this.operationCoordinate(input.bindingId,input.credentialGeneration);
    if(this.snapshot.operations.some(o=>o.kind==='cleanup'&&o.coordinateCommitment===coordinate))throw refused();
    const found=this.snapshot.operations.find((o):o is NativeOperation=>o.kind==='operation'&&o.bindingId===input.bindingId&&o.credentialGeneration===input.credentialGeneration);
    const immutable={bindingId:input.bindingId,credentialGeneration:input.credentialGeneration,userOwnershipId:u.ownershipId,association,reviewedPolicy:p,policyDigest:gatewayHash(gatewayCanonical(p)),keyFingerprint:digest(Buffer.from(plaintext))};
    if(found){if(found.phase!=='prepared'||Object.entries(immutable).some(([key,value])=>!same(found[key as keyof NativeOperation],value))||this.readKey(found.operationId)!==plaintext)throw refused();return clone(found);}
    if(this.snapshot.operations.some(o=>o.keyFingerprint===immutable.keyFingerprint))throw refused();
    const row:NativeOperation={kind:'operation',operationId:randomUUID(),...immutable,phase:'prepared',keyCreateAttempt:'not-attempted',financialOperationId:null,financialJournalId:null,bindingReceipt:null,revocationReceipt:null,
      activationIntent:null,activationReceipt:null,plaintext:'present',nativeDeletion:'unverified'};
    // The tuple and its key are one locally recorded publication. The intent is durable
    // before either becomes visible and remains until both are verified together.
    const next={...this.snapshot,operations:[...this.snapshot.operations,row]};
    this.beginPublicationIntent(next,'key-create',{operationId:row.operationId,keyFingerprint:row.keyFingerprint});
    this.publishSnapshotUnderIntent(next,new Set([row.operationId]));
    const key=this.createFile(this.keyName(row.operationId),Buffer.from(plaintext));key.bytes.fill(0);closeSync(key.fd);
    this.syncRoot();this.verify();this.clearPublicationIntent();return clone(row);
  }
  private operation(id:string):NativeOperation {try{uuid.parse(id);}catch{throw refused();}const op=this.snapshot.operations.find((o):o is NativeOperation=>o.kind==='operation'&&o.operationId===id);if(!op)throw refused();return op;}
  private readKey(id:string):string {const op=this.operation(id);if(op.plaintext!=='present')throw refused();const file=this.openFile(this.keyName(id),KEY_BYTES);try{if(file.bytes.length!==KEY_BYTES||digest(file.bytes)!==op.keyFingerprint)throw unavailable();return file.bytes.toString('ascii');}finally{file.bytes.fill(0);closeSync(file.fd);}}
  private claimTeamCreate(id:string):NativeTeamOwnership {const t=this.teamOwnership(id);if(t.createAttempt!=='not-attempted')throw refused();const next={...t,createAttempt:'attempted' as const};this.publish({...this.snapshot,teams:this.snapshot.teams.map(v=>v.ownershipId===id?next:v)});return frozenClone(next);}
  private verifyTeamCreated(id:string):void {const t=this.teamOwnership(id);if(t.createAttempt!=='attempted')throw refused();this.publish({...this.snapshot,teams:this.snapshot.teams.map(v=>v.ownershipId===id?{...v,createAttempt:'verified' as const}:v)});}
  private claimUserCreate(id:string):NativeUserOwnership {const u=this.userOwnership(id),t=this.teamOwnership(u.teamOwnershipId);if(t.createAttempt!=='verified'||u.userCreateAttempt!=='not-attempted')throw refused();const next={...u,userCreateAttempt:'attempted' as const};this.publish({...this.snapshot,users:this.snapshot.users.map(v=>v.kind==='user'&&v.ownershipId===id?next:v)});return frozenClone(next);}
  private verifyUserCreated(id:string):void {const u=this.userOwnership(id);if(u.userCreateAttempt!=='attempted'||this.teamOwnership(u.teamOwnershipId).createAttempt!=='verified')throw refused();this.publish({...this.snapshot,users:this.snapshot.users.map(v=>v.kind==='user'&&v.ownershipId===id?{...v,userCreateAttempt:'verified' as const}:v)});}
  private claimMembershipCreate(id:string):NativeUserOwnership {const u=this.userOwnership(id);if(this.teamOwnership(u.teamOwnershipId).createAttempt!=='verified'||u.userCreateAttempt!=='verified'||u.membershipCreateAttempt!=='not-attempted')throw refused();const next={...u,membershipCreateAttempt:'attempted' as const};this.publish({...this.snapshot,users:this.snapshot.users.map(v=>v.kind==='user'&&v.ownershipId===id?next:v)});return frozenClone(next);}
  private verifyMembershipCreated(id:string):void {const u=this.userOwnership(id);if(u.userCreateAttempt!=='verified'||u.membershipCreateAttempt!=='attempted')throw refused();this.publish({...this.snapshot,users:this.snapshot.users.map(v=>v.kind==='user'&&v.ownershipId===id?{...v,membershipCreateAttempt:'verified' as const}:v)});}
  private claimKeyCreate(id:string):NativeOperation {const op=this.operation(id),u=this.userOwnership(op.userOwnershipId);if(op.phase!=='provisioning'||u.membershipCreateAttempt!=='verified'||op.keyCreateAttempt!=='not-attempted')throw refused();this.updateOperation({...op,keyCreateAttempt:'attempted'});return frozenClone(this.operation(id));}
  private verifyKeyCreated(id:string):void {const op=this.operation(id);if(op.phase!=='provisioning'||op.keyCreateAttempt!=='attempted')throw refused();this.updateOperation({...op,keyCreateAttempt:'verified'});}
  private beginProvisioning(id:string):void {const op=this.operation(id);if(op.phase==='provisioning')return;if(op.phase!=='prepared')throw refused();this.updateOperation({...op,phase:'provisioning'});}
  private recordNativeBlockedVerification(id:string):void {const op=this.operation(id);if(op.phase==='native-blocked-verified')return;if(op.phase!=='provisioning'||op.keyCreateAttempt!=='verified')throw refused();this.updateOperation({...op,phase:'native-blocked-verified'});}
  private teamOwnership(id:string):NativeTeamOwnership {try{uuid.parse(id);}catch{throw refused();}const row=this.snapshot.teams.find(t=>t.ownershipId===id);if(!row)throw refused();return row;}
  private userOwnership(id:string):NativeUserOwnership {try{uuid.parse(id);}catch{throw refused();}const row=this.snapshot.users.find((u):u is NativeUserOwnership=>u.kind==='user'&&u.ownershipId===id);if(!row)throw refused();return row;}
  private linkFinancialOperation(id:string,financialId:string,journalId:string):void {try{uuid.parse(financialId);uuid.parse(journalId);}catch{throw refused();}const op=this.operation(id);if(op.phase!=='native-blocked-verified'||op.financialOperationId!==null&&(op.financialOperationId!==financialId||op.financialJournalId!==journalId))throw refused();if(op.financialOperationId===financialId)return;this.updateOperation({...op,financialOperationId:financialId,financialJournalId:journalId});}
  private bindingAtom(op:NativeOperation,state:'active'|'revoked'):Extract<FinancialAtom,{kind:'binding'}> {
    const u=this.snapshot.users.find((u):u is NativeUserOwnership=>u.kind==='user'&&u.ownershipId===op.userOwnershipId);if(!u)throw unavailable();
    return {kind:'binding',id:op.bindingId,installationAccountId:u.installationAccountId,memberAccountId:u.accountId,endpointHash:u.endpoint.hash,credentialGeneration:op.credentialGeneration,profileHash:op.reviewedPolicy.pricing.capabilityHash,maximumLiability:op.reviewedPolicy.maximumLiability,pricingProfile:op.reviewedPolicy.pricing,state};
  }
  private recordBoundClosed(id:string,raw:CommittedFinancialReceipt):void {
    try{requireCurrentFinancialPublicationProof(raw);}catch{throw refused();}
    const op=this.operation(id),r=committedFinancialEvidence(raw,{kind:'bound-closed',binding:this.bindingAtom(op,'active')});if(!r)throw refused();
    if(op.phase==='bound-closed'&&same(op.bindingReceipt,r))return;
    if(op.phase!=='native-blocked-verified'||op.financialOperationId!==r.operationId||op.financialJournalId!==r.journalId)throw refused();this.updateOperation({...op,phase:'bound-closed',bindingReceipt:r});
  }
  private beginActivation(id:string,value:Parameters<NativeCustodyGate['beginActivation']>[1]):NativeOperation {
    const op=this.operation(id),user=this.userOwnership(op.userOwnershipId),team=this.teamOwnership(user.teamOwnershipId);
    if(op.phase!=='bound-closed'||!op.bindingReceipt||!op.financialOperationId||!op.financialJournalId||op.activationIntent||op.activationReceipt||
      value.financialOperationId===op.financialOperationId||value.journalId!==op.financialJournalId||op.bindingReceipt.journalId!==op.financialJournalId||
      op.bindingReceipt.operationId!==op.financialOperationId||op.bindingReceipt.operation!=='provision'||user.installationAccountId!==team.installationAccountId||
      !same(user.endpoint,team.endpoint)||user.endpoint.hash!==team.endpoint.hash||op.policyDigest!==gatewayHash(gatewayCanonical(op.reviewedPolicy))||
      op.keyCreateAttempt!=='verified'||user.userCreateAttempt!=='verified'||user.membershipCreateAttempt!=='verified'||team.createAttempt!=='verified'||
      op.plaintext!=='present'||op.nativeDeletion!=='unverified')throw refused();
    const intent=activationIntent.parse({...value,originalBindingReceiptHash:gatewayHash(gatewayCanonical(op.bindingReceipt)),installationAccountId:team.installationAccountId,
      memberAccountId:user.accountId,endpointHash:user.endpoint.hash,unblockAttempt:'not-attempted'});
    if(Date.parse(intent.monthStartsAt)>=Date.parse(intent.monthEndsAt))throw refused();
    this.updateOperation({...op,phase:'activation-pending',activationIntent:intent});return frozenClone(this.operation(id));
  }
  private claimActivationUnblock(id:string):NativeOperation {
    const op=this.operation(id),intent=op.activationIntent;
    if(op.phase!=='activation-pending'||!intent||intent.unblockAttempt!=='not-attempted'||op.activationReceipt)throw refused();
    this.updateOperation({...op,activationIntent:{...intent,unblockAttempt:'attempted'}});return frozenClone(this.operation(id));
  }
  private verifyActivationUnblocked(id:string):void {
    const op=this.operation(id),intent=op.activationIntent;
    if(op.phase!=='activation-pending'||!intent||intent.unblockAttempt!=='attempted'||op.activationReceipt)throw refused();
    this.updateOperation({...op,activationIntent:{...intent,unblockAttempt:'verified'}});
  }
  private recordActive(id:string,raw:CommittedFinancialReceipt):void {
    try{requireCurrentFinancialPublicationProof(raw);}catch{throw refused();}
    const op=this.operation(id),intent=op.activationIntent;
    if(op.phase!=='activation-pending'||!intent||intent.unblockAttempt!=='verified'||op.activationReceipt||!op.bindingReceipt||
      intent.originalBindingReceiptHash!==gatewayHash(gatewayCanonical(op.bindingReceipt))||intent.journalId!==op.financialJournalId||
      intent.financialOperationId!==raw.operationId||intent.journalId!==raw.journalId||raw.operation!=='native-activation'||
      op.bindingReceipt.journalId!==raw.journalId)throw refused();
    const evidence=committedFinancialEvidence(raw,{kind:'native-activation',binding:this.bindingAtom(op,'active'),installationWindowId:intent.installationWindowId,
      memberWindowId:intent.memberWindowId,endpointGeneration:intent.endpointGeneration,recoveryEpochHash:intent.recoveryEpochHash,
      monthStartsAt:intent.monthStartsAt,monthEndsAt:intent.monthEndsAt,installationCap:intent.installationCap,memberWindowCap:intent.memberWindowCap});
    if(!evidence)throw refused();this.updateOperation({...op,phase:'active',activationReceipt:evidence});
  }
  private recordRevocation(id:string,raw:CommittedFinancialReceipt):void {
    try{requireCurrentFinancialPublicationProof(raw);}catch{throw refused();}
    const op=this.operation(id),r=committedFinancialEvidence(raw,{kind:op.bindingReceipt?'bound-revocation':'pending-revocation',binding:this.bindingAtom(op,'revoked')});if(!r)throw refused();
    if(['revoke-pending','revoked'].includes(op.phase)&&same(op.revocationReceipt,r))return;
    if(!['provisioning','bound-closed','activation-pending','active','uncertain','native-blocked-verified','prepared'].includes(op.phase)||['revoke-pending','revoked'].includes(op.phase)||op.financialOperationId===r.operationId||op.financialJournalId!==null&&op.financialJournalId!==r.journalId)throw refused();this.updateOperation({...op,phase:'revoke-pending',revocationReceipt:r});
  }
  private publishNativeCleanupRecovery(id:string,raw:CommittedFinancialReceipt):void {
    try{requireCurrentFinancialPublicationProof(raw);}catch{throw refused();}
    const op=this.operation(id);
    if(!['bound-closed','activation-pending','active','revoke-pending'].includes(op.phase)||op.nativeDeletion!=='unverified'||!['present','removal-pending','removed'].includes(op.plaintext))throw refused();
    if(op.financialJournalId!==null&&raw.journalId!==op.financialJournalId)throw refused();
    const evidence=committedFinancialEvidence(raw,{kind:'native-cleanup-recovery',binding:this.bindingAtom(op,'revoked')});if(!evidence)throw refused();
    this.recoveryProof=raw;
    try{if(op.phase==='bound-closed'||op.phase==='activation-pending'||op.phase==='active')this.updateOperation({...op,phase:'revoke-pending',revocationReceipt:evidence});this.removePlaintext(id,true);}
    finally{this.recoveryProof=undefined;}
  }
  private accountOperations(accountId:string):readonly NativeOperation[] {
    try{uuid.parse(accountId);}catch{throw refused();}const ids=new Set(this.snapshot.users.filter((u):u is NativeUserOwnership=>u.kind==='user'&&u.accountId===accountId).map(u=>u.ownershipId));
    return clone(this.snapshot.operations.filter((o):o is NativeOperation=>o.kind==='operation'&&ids.has(o.userOwnershipId)));
  }
  private absenceTarget(id:string,erased:boolean):Omit<NativeAbsenceRequest,'challenge'> {
    if(erased){const op=this.snapshot.operations.find((o):o is NativeCleanupReceipt=>o.kind==='cleanup'&&o.keyFingerprint===id);if(!op||op.phase!=='revoke-pending'||op.nativeDeletion!=='unverified')throw refused();return {origin:op.endpoint.origin,fingerprint:op.keyFingerprint};}
    const op=this.operation(id),u=this.snapshot.users.find((u):u is NativeUserOwnership=>u.kind==='user'&&u.ownershipId===op.userOwnershipId);if(!u||op.phase!=='revoke-pending'||op.plaintext!=='removed'||!op.revocationReceipt||op.nativeDeletion!=='unverified')throw refused();return {origin:u.endpoint.origin,fingerprint:op.keyFingerprint};
  }
  private recordNativeAbsence(id:string,proof:NativeHashAbsenceReceipt,erased:boolean,challenge:string):void {
    const target=this.absenceTarget(id,erased);if(!consumeNativeHashAbsenceReceipt(proof,target.origin,target.fingerprint,challenge))throw refused();
    if(!erased){this.updateOperation({...this.operation(id),phase:'revoked',nativeDeletion:'verified'});return;}
    this.publish({...this.snapshot,operations:this.snapshot.operations.map(o=>o.kind==='cleanup'&&o.keyFingerprint===id?{...o,phase:'revoked',nativeDeletion:'verified'}:o)});
  }
  private removePlaintext(id:string,recoveryPendingRemoval=false):void {
    const op=this.operation(id);if(op.phase!=='revoke-pending'||!op.revocationReceipt)throw refused();if(op.plaintext==='removed')return;if(op.plaintext!=='present'&&!(recoveryPendingRemoval&&op.plaintext==='removal-pending'))throw unavailable();
    // First make the revocation and pending removal durable. The second intent then binds
    // unlink to the exact snapshot that records plaintext as removed.
    if(op.plaintext==='present')this.updateOperation({...op,plaintext:'removal-pending'});
    const name=this.keyName(id),retained=this.recoveryKeyFiles?.get(name),file=retained??this.openFile(name,KEY_BYTES);
    const next={...this.snapshot,operations:this.snapshot.operations.map(value=>value.kind==='operation'&&value.operationId===id?{...value,plaintext:'removed' as const}:value)};
    try{this.beginPublicationIntent(next,'key-remove',{operationId:id,keyFingerprint:op.keyFingerprint});
      this.assertOwner();this.assertHandle(name,file,KEY_BYTES);if(digest(file.bytes)!==op.keyFingerprint)throw unavailable();unlinkSync(join(this.directory,name));
      if(retained){retained.stat=fstatSync(retained.fd,{bigint:true});this.recoveryKeyFiles!.delete(name);this.recoveryDetached!.set(name,retained);}this.assertOwner();this.syncRoot();
      if(retained){this.recoveryDetached!.delete(name);retained.bytes.fill(0);closeSync(retained.fd);}
      this.publishSnapshotUnderIntent(next,new Set([id]));this.clearPublicationIntent();}
    finally{if(!retained){file.bytes.fill(0);closeSync(file.fd);}}
  }
  private eraseAccountAssociation(accountId:string,raw:CommittedFinancialReceipt):void {
    try{uuid.parse(accountId);}catch{throw refused();}
    try{requireCurrentFinancialPublicationProof(raw);}catch{throw refused();}
    const r=committedFinancialEvidence(raw,{kind:'account-erasure',accountId});if(!r)throw refused();
    const erasureReceiptHash=gatewayHash(gatewayCanonical(r)),accountCommitment=commitment('erased-account',this.snapshot.storeId,accountId);
    if(this.snapshot.users.some(u=>u.kind==='erased-user'&&u.accountCommitment===accountCommitment&&u.erasureReceiptHash!==erasureReceiptHash))throw refused();
    const users=this.snapshot.users.filter((u):u is NativeUserOwnership=>u.kind==='user'&&u.accountId===accountId),ids=new Set(users.map(u=>u.ownershipId));
    const owned=this.snapshot.operations.filter((o):o is NativeOperation=>o.kind==='operation'&&ids.has(o.userOwnershipId));
    if(users.some(u=>!committedFinancialEvidence(raw,{kind:'account-erasure',accountId,installationAccountId:u.installationAccountId}))||owned.some(o=>!['revoke-pending','revoked'].includes(o.phase)||o.plaintext!=='removed'||!o.revocationReceipt||o.revocationReceipt.journalId!==r.journalId))throw refused();
    if(!users.length)return;
    this.publish({...this.snapshot,users:this.snapshot.users.map(u=>u.kind==='user'&&ids.has(u.ownershipId)?{kind:'erased-user',accountCommitment,coordinateCommitment:this.userCoordinate(accountId,u.endpoint.hash),erasureReceiptHash}:u),
      operations:this.snapshot.operations.map(o=>{if(o.kind!=='operation'||!ids.has(o.userOwnershipId))return o;const u=users.find(u=>u.ownershipId===o.userOwnershipId)!;return {kind:'cleanup',accountCommitment,coordinateCommitment:this.operationCoordinate(o.bindingId,o.credentialGeneration),operationCommitment:commitment('erased-operation',this.snapshot.storeId,o.operationId),endpoint:u.endpoint,keyFingerprint:o.keyFingerprint,policyDigest:o.policyDigest,revocationReceiptHash:gatewayHash(gatewayCanonical(o.revocationReceipt)),erasureReceiptHash,phase:o.phase==='revoked'?'revoked':'revoke-pending',plaintext:'removed',nativeDeletion:o.nativeDeletion};})});
  }
  private userCoordinate(accountId:string,endpointHash:string):string{return commitment('erased-user-coordinate',this.snapshot.storeId,accountId,endpointHash);}
  private operationCoordinate(bindingId:string,credentialGeneration:string):string{return commitment('erased-binding-coordinate',this.snapshot.storeId,bindingId,credentialGeneration);}
  private updateOperation(op:NativeOperation):void {this.publish({...this.snapshot,operations:this.snapshot.operations.map(o=>o.kind==='operation'&&o.operationId===op.operationId?op:o)});}
  private snapshotBytes(value:Snapshot):Buffer {
    const s=snapshotSchema.parse(value);if(s.teams.length+s.users.length+s.operations.length>NATIVE_CUSTODY_MAX_RECORDS)throw refused();const bytes=gatewayCanonical(s);if(bytes.length>NATIVE_CUSTODY_MAX_BYTES)throw refused();return bytes;
  }
  private publish(next:Snapshot,missingKeys=new Set<string>()):void {
    this.beginPublicationIntent(next,'snapshot',null);this.publishSnapshotUnderIntent(next,missingKeys);this.clearPublicationIntent();
  }
  private publishControl(next:Control):void {
    const bytes=gatewayCanonical(controlSchema.parse(next));if(bytes.length>CONTROL_BYTES)throw unavailable();
    this.controlFile=this.replaceFile('control.json',this.controlFile,bytes);this.control=next;
  }
  private beginPublicationIntent(nextSnapshot:Snapshot,kind:PublicationIntent['kind'],key:PublicationIntent['key']):void {
    if(this.publicationIntent||this.publicationIntentRecord)throw unavailable();
    const revision=this.snapshot.revision+1;
    const next={...nextSnapshot,revision},snapshotBytes=this.snapshotBytes(next);
    const nextControl=controlSchema.parse({...this.control,revision,snapshotDigest:digest(snapshotBytes)});
    const record:PublicationIntent=publicationIntentSchema.parse({version:1,storeId:this.snapshot.storeId,kind,
      previous:{controlDigest:digest(this.controlFile.bytes),controlState:this.control.state,revision:this.snapshot.revision,snapshotDigest:digest(this.snapshotFile.bytes)},
      next:{controlDigest:digest(gatewayCanonical(nextControl)),revision,snapshotDigest:digest(snapshotBytes)},key});
    const bytes=gatewayCanonical(record);if(bytes.length>INTENT_BYTES)throw unavailable();
    // O_EXCL on the final path refuses a foreign intent instead of replacing it. A failed
    // file or directory sync leaves a refusal artifact; no snapshot/key write follows it.
    const file=this.createFile('publication-intent.json',bytes);
    this.publicationIntent=file;this.recoveryPartials?.delete('publication-intent.json');this.publicationIntentRecord=record;this.syncRoot();
  }
  private publishSnapshotUnderIntent(nextSnapshot:Snapshot,missingKeys=new Set<string>()):void {
    const record=this.publicationIntentRecord;if(!record||!this.publicationIntent)throw unavailable();
    const next={...nextSnapshot,revision:this.snapshot.revision+1},bytes=this.snapshotBytes(next);
    if(record.next.revision!==next.revision||record.next.snapshotDigest!==digest(bytes))throw unavailable();
    this.snapshotFile=this.replaceFile('snapshot.json',this.snapshotFile,bytes);this.snapshot=next;
    const nextControl=controlSchema.parse({...this.control,revision:next.revision,snapshotDigest:digest(bytes)});
    this.writeControlUnderIntent(nextControl);this.verify(missingKeys);
  }
  private writeControlUnderIntent(next:Control):void {
    const record=this.publicationIntentRecord;if(!record||!this.publicationIntent)throw unavailable();
    const parsed=controlSchema.parse(next),bytes=gatewayCanonical(parsed);
    if(bytes.length>CONTROL_BYTES||digest(bytes)!==record.next.controlDigest||parsed.revision!==record.next.revision||parsed.snapshotDigest!==record.next.snapshotDigest)throw unavailable();
    this.controlFile=this.replaceFile('control.json',this.controlFile,bytes);this.control=parsed;
  }
  private clearPublicationIntent():void {
    const file=this.publicationIntent;if(!file||!this.publicationIntentRecord)throw unavailable();
    this.assertOwner();this.assertHandle('publication-intent.json',file,INTENT_BYTES);unlinkSync(join(this.directory,'publication-intent.json'));
    // Keep the in-memory intent until the directory sync acknowledges its removal. If
    // that sync is unknown, the caller freezes and cannot claim publication succeeded.
    if(this.recoveryPartials){file.stat=fstatSync(file.fd,{bigint:true});this.recoveryDetached!.set('publication-intent.json',file);this.publicationIntent=undefined;this.publicationIntentRecord=undefined;}
    this.assertOwner(true);this.syncRoot(true);
    if(this.recoveryPartials){this.recoveryDetached!.delete('publication-intent.json');file.bytes.fill(0);closeSync(file.fd);}
    else{file.bytes.fill(0);closeSync(file.fd);this.publicationIntent=undefined;this.publicationIntentRecord=undefined;}
    // Recheck the complete store after the unlink sync and before returning permission.
    // This catches a concurrent insertion or path replacement at that exact boundary.
    this.verify();
  }
  private decode<T>(schema:z.ZodType<T>,bytes:Buffer):T {const value=schema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));if(!gatewayCanonical(value).equals(bytes))throw unavailable();return value;}
  private verify(missingKeys=new Set<string>(),recovery:{snapshotName?:string;controlName?:string;extraNames?:ReadonlySet<string>;intentMode?:'next'|'old';keyFiles?:ReadonlyMap<string,Handle>}={}):void {
    const snapshotName=recovery.snapshotName??'snapshot.json',controlName=recovery.controlName??'control.json';
    this.assertRoot();this.assertHandle('writer.lock',this.lock,0);this.assertHandle(snapshotName,this.snapshotFile,NATIVE_CUSTODY_MAX_BYTES);this.assertHandle(controlName,this.controlFile,CONTROL_BYTES);
    if(this.control.storeId!==this.snapshot.storeId||this.control.revision!==this.snapshot.revision||this.control.snapshotDigest!==digest(this.snapshotFile.bytes)||this.control.state==='uncertain'||!this.snapshotBytes(this.snapshot).equals(this.snapshotFile.bytes))throw unavailable();
    if(this.publicationIntent){
      if(!this.publicationIntentRecord)throw unavailable();this.assertHandle('publication-intent.json',this.publicationIntent,INTENT_BYTES);
      const stored=this.decode(publicationIntentSchema,this.publicationIntent.bytes);
      if(!same(stored,this.publicationIntentRecord)||stored.storeId!==this.snapshot.storeId||recovery.intentMode!=='old'&&(stored.next.revision!==this.snapshot.revision||stored.next.snapshotDigest!==digest(this.snapshotFile.bytes)||stored.next.controlDigest!==digest(this.controlFile.bytes)))throw unavailable();
    }
    const expected=new Set(['writer.lock',snapshotName,controlName]),unique=new Set<string>();
    if(this.publicationIntent){expected.add('publication-intent.json');}
    for(const name of recovery.extraNames??[])expected.add(name);
    const uniqueId=(value:string)=>{if(unique.has(value))throw unavailable();unique.add(value);};
    for(const t of this.snapshot.teams){uniqueId('team:'+t.ownershipId);uniqueId('team-coordinate:'+t.installationAccountId+':'+t.endpoint.hash);uniqueId('native-team:'+t.endpoint.hash+':'+t.nativeTeamId);}
    for(const u of this.snapshot.users){if(u.kind==='erased-user'){uniqueId('erased-user:'+u.coordinateCommitment);continue;}uniqueId('user:'+u.ownershipId);uniqueId('user-coordinate:'+u.accountId+':'+u.endpoint.hash);uniqueId('native-user:'+u.endpoint.hash+':'+u.nativeUserId);const t=this.snapshot.teams.find(t=>t.ownershipId===u.teamOwnershipId);if(!t||t.installationAccountId!==u.installationAccountId||!same(t.endpoint,u.endpoint)||u.userCreateAttempt!=='not-attempted'&&t.createAttempt!=='verified'||u.membershipCreateAttempt!=='not-attempted'&&u.userCreateAttempt!=='verified'||this.snapshot.users.some(v=>v.kind==='erased-user'&&(v.coordinateCommitment===this.userCoordinate(u.accountId,u.endpoint.hash)||v.accountCommitment===commitment('erased-account',this.snapshot.storeId,u.accountId))))throw unavailable();}
    for(const op of this.snapshot.operations){
      if(op.kind==='cleanup'){uniqueId('operation-coordinate:'+op.coordinateCommitment);uniqueId('cleanup-operation:'+op.operationCommitment);uniqueId('key:'+op.keyFingerprint);if((op.phase==='revoked')!==(op.nativeDeletion==='verified')||!this.snapshot.users.some(u=>u.kind==='erased-user'&&u.accountCommitment===op.accountCommitment&&u.erasureReceiptHash===op.erasureReceiptHash))throw unavailable();continue;}
      uniqueId('operation:'+op.operationId);uniqueId('operation-coordinate:'+this.operationCoordinate(op.bindingId,op.credentialGeneration));uniqueId('key:'+op.keyFingerprint);
      const u=this.snapshot.users.find((u):u is NativeUserOwnership=>u.kind==='user'&&u.ownershipId===op.userOwnershipId),t=u&&this.snapshot.teams.find(t=>t.ownershipId===u.teamOwnershipId),p=this.checkedPolicy(op.reviewedPolicy);
      if((op.financialOperationId===null)!==(op.financialJournalId===null)||op.bindingReceipt&&(op.bindingReceipt.operation!=='provision'||op.bindingReceipt.journalId!==op.financialJournalId)||op.revocationReceipt&&(!['member-remove','erase-person','native-cleanup-recovery'].includes(op.revocationReceipt.operation)||op.financialJournalId!==null&&op.revocationReceipt.journalId!==op.financialJournalId))throw unavailable();
      const activation=op.activationIntent,activationPhases=['activation-pending','active'].includes(op.phase);
      if(!u||!t||op.keyCreateAttempt!=='not-attempted'&&u.membershipCreateAttempt!=='verified'||op.keyCreateAttempt!=='not-attempted'&&!['provisioning','native-blocked-verified','bound-closed','activation-pending','active','uncertain','revoke-pending','revoked'].includes(op.phase)||['native-blocked-verified','bound-closed','activation-pending','active'].includes(op.phase)&&(op.keyCreateAttempt!=='verified'||u.membershipCreateAttempt!=='verified'||u.userCreateAttempt!=='verified'||t.createAttempt!=='verified')||op.policyDigest!==gatewayHash(gatewayCanonical(p))||!same(t.policy,p.team)||!same(u.policy,p.user)||!same(u.membership,p.membership)||t.capabilityHash!==p.pricing.capabilityHash||p.key.models.length!==1||p.key.models[0]!==op.association.purposeAlias||(op.phase==='revoked')!==(op.nativeDeletion==='verified')||op.phase==='revoked'&&op.plaintext!=='removed'||op.phase==='bound-closed'&&(!op.bindingReceipt||op.bindingReceipt.operationId!==op.financialOperationId)||op.bindingReceipt&&op.bindingReceipt.operationId!==op.financialOperationId||['revoke-pending','revoked'].includes(op.phase)&&!op.revocationReceipt||op.plaintext!=='present'&&(!['revoke-pending','revoked'].includes(op.phase)||!op.revocationReceipt)||
        activationPhases&&!activation||!activation&&op.activationReceipt!==null||activation&&!['activation-pending','active','uncertain','revoke-pending','revoked'].includes(op.phase)||
        op.phase==='active'&&op.activationReceipt===null||op.activationReceipt!==null&&!['active','revoke-pending','revoked'].includes(op.phase)||
        activation&&(!op.bindingReceipt||activation.financialOperationId===op.financialOperationId||activation.journalId!==op.financialJournalId||activation.journalId!==op.bindingReceipt.journalId||
          activation.originalBindingReceiptHash!==gatewayHash(gatewayCanonical(op.bindingReceipt))||activation.installationAccountId!==u.installationAccountId||activation.memberAccountId!==u.accountId||
          activation.endpointHash!==u.endpoint.hash||
          op.phase==='active'&&(activation.unblockAttempt!=='verified'||!op.activationReceipt||op.activationReceipt.operation!=='native-activation'||
            op.activationReceipt.operationId!==activation.financialOperationId||op.activationReceipt.journalId!==activation.journalId))||
        op.activationReceipt&&(!activation||op.activationReceipt.operation!=='native-activation'||op.activationReceipt.operationId!==activation.financialOperationId||op.activationReceipt.journalId!==activation.journalId))throw unavailable();
      if(op.plaintext!=='removed'){
        const name=this.keyName(op.operationId);if(missingKeys.has(op.operationId))continue;expected.add(name);
        const keyFiles=recovery.keyFiles??this.recoveryKeyFiles;
        if(keyFiles){const file=keyFiles.get(name);if(!file)throw unavailable();this.assertHandle(name,file,KEY_BYTES);if(file.bytes.length!==KEY_BYTES||digest(file.bytes)!==op.keyFingerprint)throw unavailable();}
        else{const file=this.openFile(name,KEY_BYTES);try{if(file.bytes.length!==KEY_BYTES||digest(file.bytes)!==op.keyFingerprint)throw unavailable();}finally{file.bytes.fill(0);closeSync(file.fd);}}
      }
    }
    const names=this.inventoryNames();if(names.length!==expected.size||names.some(name=>!expected.has(name)))throw unavailable();
  }
  private inventoryNames():string[] {const names:string[]=[];const directory=opendirBounded(this.directory,NATIVE_CUSTODY_MAX_RECORDS+5);for(const name of directory)names.push(name);return names;}
  private keyName(id:string):string{return `${id}.key`;}
  private verifyAncestors(directory:string):void {
    if(!isAbsolute(directory)||normalize(directory)!==directory)throw unavailable();let part=parse(directory).root;
    for(const name of directory.slice(part.length).split('/')){if(!name)continue;part=join(part,name);const s=lstatSync(part);if(!s.isDirectory()||s.isSymbolicLink()||![0,this.uid].includes(s.uid)||(s.mode&0o022)!==0&&(s.mode&0o1000)===0)throw unavailable();}
  }
  private openRoot():void {this.verifyAncestors(this.directory);this.rootFd=openSync(this.directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);this.rootStat=fstatSync(this.rootFd,{bigint:true});this.assertRoot();}
  private assertRoot():void {this.verifyAncestors(this.directory);const a=fstatSync(this.rootFd,{bigint:true}),b=lstatSync(this.directory,{bigint:true});if(!b.isDirectory()||b.isSymbolicLink()||a.dev!==this.rootStat.dev||a.ino!==this.rootStat.ino||a.dev!==b.dev||a.ino!==b.ino||b.uid!==BigInt(this.uid)||b.gid!==BigInt(this.gid)||(b.mode&0o7777n)!==0o700n)throw unavailable();}
  private openFile(name:string,maximum:number):Handle {
    this.assertRoot();const fd=openSync(join(this.directory,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{const stat=fstatSync(fd,{bigint:true});if(!stat.isFile()||stat.nlink!==1n||stat.uid!==BigInt(this.uid)||stat.gid!==BigInt(this.gid)||(stat.mode&0o7777n)!==0o600n||stat.size>BigInt(maximum))throw unavailable();const bytes=Buffer.alloc(Number(stat.size));if(bytes.length&&readSync(fd,bytes,0,bytes.length,0)!==bytes.length)throw unavailable();const handle={fd,stat,bytes};this.assertHandle(name,handle,maximum);return handle;}catch{closeSync(fd);throw unavailable();}
  }
  private assertHandle(name:string,file:Handle,maximum:number):void {
    this.assertRoot();const a=fstatSync(file.fd,{bigint:true}),b=lstatSync(join(this.directory,name),{bigint:true});if(!b.isFile()||b.isSymbolicLink()||b.nlink!==1n||b.uid!==BigInt(this.uid)||b.gid!==BigInt(this.gid)||(b.mode&0o7777n)!==0o600n||b.size>BigInt(maximum)||a.dev!==file.stat.dev||a.ino!==file.stat.ino||a.dev!==b.dev||a.ino!==b.ino||a.size!==BigInt(file.bytes.length)||a.mtimeNs!==file.stat.mtimeNs||a.ctimeNs!==file.stat.ctimeNs)throw unavailable();
    const bytes=Buffer.alloc(file.bytes.length);if(bytes.length&&readSync(file.fd,bytes,0,bytes.length,0)!==bytes.length||!bytes.equals(file.bytes))throw unavailable();bytes.fill(0);
  }
  private createFile(name:string,bytes:Buffer):Handle {
    this.assertOwner();const fd=openSync(join(this.directory,name),constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    const file:Handle={fd,stat:fstatSync(fd,{bigint:true}),bytes:Buffer.alloc(0)};this.recoveryPartials?.set(name,file);
    try{fchownSync(fd,this.uid,this.gid);fchmodSync(fd,0o600);file.stat=fstatSync(fd,{bigint:true});let offset=0;while(offset<bytes.length){this.assertOwner();const written=writeSync(fd,bytes,offset,bytes.length-offset);if(written<1)throw unavailable();offset+=written;file.bytes=Buffer.from(bytes.subarray(0,offset));file.stat=fstatSync(fd,{bigint:true});}this.assertOwner();this.syncOwned(fd);file.stat=fstatSync(fd,{bigint:true});file.bytes=Buffer.from(bytes);this.assertHandle(name,file,Math.max(bytes.length,1));return file;}catch{if(!this.recoveryPartials)closeSync(fd);throw unavailable();}
  }
  private replaceFile(name:string,current:Handle,bytes:Buffer):Handle {
    this.assertOwner();this.assertHandle(name,current,name==='control.json'?CONTROL_BYTES:NATIVE_CUSTODY_MAX_BYTES);const temporary=`.${name}.partial`,next=this.createFile(temporary,bytes);let published=false;
    try{
      this.assertOwner();this.assertHandle(name,current,name==='control.json'?CONTROL_BYTES:NATIVE_CUSTODY_MAX_BYTES);this.assertHandle(temporary,next,bytes.length);
      renameSync(join(this.directory,temporary),join(this.directory,name));
      // Rename changes visible custody before directory fsync can acknowledge it. Track
      // OUR already-verified inode immediately, so failed-close freezing cannot target the
      // unlinked former control file. This never opens/adopts a replacement from the path.
      if(name==='control.json')this.controlFile=next;else this.snapshotFile=next;
      this.recoveryPartials?.delete(temporary);published=true;next.stat=fstatSync(next.fd,{bigint:true});this.assertOwner();this.assertHandle(name,next,bytes.length);this.syncRoot();return next;
    }finally{if(published)closeSync(current.fd);else if(!this.recoveryPartials)closeSync(next.fd);}
  }
  private assertOwner(skipIntentCheck=false):void {
    if(this.recoveryProof)try{requireCurrentFinancialPublicationProof(this.recoveryProof);}catch{throw unavailable();}
    this.assertRoot();if(this.lock)this.assertHandle('writer.lock',this.lock,0);
    if(this.publicationIntent&&!skipIntentCheck){this.assertHandle('publication-intent.json',this.publicationIntent,INTENT_BYTES);if(!this.publicationIntentRecord||!this.publicationIntent.bytes.equals(gatewayCanonical(this.publicationIntentRecord)))throw unavailable();}
    if(this.recoveryKeyFiles)this.assertRecoveryOwnership();
  }
  private assertRecoveryOwnership():void {
    if(this.recoveryProof)try{requireCurrentFinancialPublicationProof(this.recoveryProof);}catch{throw unavailable();}
    this.assertRoot();const expected=new Set(['writer.lock','snapshot.json','control.json']);
    this.assertHandle('writer.lock',this.lock,0);this.assertHandle('snapshot.json',this.snapshotFile,NATIVE_CUSTODY_MAX_BYTES);this.assertHandle('control.json',this.controlFile,CONTROL_BYTES);
    for(const [name,file] of this.recoveryKeyFiles??[]){expected.add(name);this.assertHandle(name,file,KEY_BYTES);}
    if(this.publicationIntent){expected.add('publication-intent.json');this.assertHandle('publication-intent.json',this.publicationIntent,INTENT_BYTES);}
    for(const [name,file] of this.recoveryPartials??[]){expected.add(name);this.assertHandle(name,file,name==='.control.json.partial'?CONTROL_BYTES:name.endsWith('.key')?KEY_BYTES:name==='publication-intent.json'?INTENT_BYTES:NATIVE_CUSTODY_MAX_BYTES);}
    for(const [name,file] of this.recoveryDetached??[]){this.assertDetachedHandle(file);if(expected.has(name))throw unavailable();}
    const actual=this.inventoryNames().sort(),wanted=[...expected].sort();if(actual.length!==wanted.length||actual.some((name,index)=>name!==wanted[index]))throw unavailable();
  }
  private assertDetachedHandle(file:Handle):void {
    this.assertRoot();const current=fstatSync(file.fd,{bigint:true});if(current.dev!==file.stat.dev||current.ino!==file.stat.ino||current.nlink!==0n||current.size!==BigInt(file.bytes.length)||current.mtimeNs!==file.stat.mtimeNs||current.ctimeNs!==file.stat.ctimeNs)throw unavailable();
    const bytes=Buffer.alloc(file.bytes.length);if(bytes.length&&readSync(file.fd,bytes,0,bytes.length,0)!==bytes.length||!bytes.equals(file.bytes))throw unavailable();bytes.fill(0);
  }
  private syncOwned(fd:number):void {this.sync(fd);this.assertOwner();}
  private syncRoot(skipIntentCheck=false):void {this.assertOwner(skipIntentCheck);this.sync(this.rootFd);this.assertOwner(skipIntentCheck);}
  private freeze():void {if(this.closed||this.frozen)return;this.frozen=true;if(this.publicationIntent)return;try{this.publishControl({...this.control,state:'uncertain'});}catch{/* Writer-open/partial/mismatched files still refuse later adoption. */}}
  private release():void {if(this.closed)return;this.closed=true;const files=new Set<Handle>([this.snapshotFile,this.controlFile,this.lock,this.publicationIntent,...(this.recoveryKeyFiles?.values()??[]),...(this.recoveryPartials?.values()??[]),...(this.recoveryDetached?.values()??[])].filter((file):file is Handle=>Boolean(file)));for(const file of files){file.bytes.fill(0);try{closeSync(file.fd);}catch{}}this.recoveryKeyFiles?.clear();this.recoveryPartials?.clear();this.recoveryDetached?.clear();if(this.rootFd!==undefined)try{closeSync(this.rootFd);}catch{}}
}

// Bound enumeration before materializing the inventory, including unexpected entries.
function opendirBounded(path:string,maximum:number):string[]{const directory=opendirSync(path),names:string[]=[];try{for(let entry=directory.readSync();entry!==null;entry=directory.readSync()){if(names.length>=maximum)throw unavailable();names.push(entry.name);}return names;}finally{directory.closeSync();}}
