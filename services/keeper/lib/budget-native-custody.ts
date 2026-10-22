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
import {linuxInheritedJournalLock,committedFinancialEvidence,type CommittedFinancialReceipt,type FinancialAtom} from './financial-journal.js';
import {consumeNativeHashAbsenceReceipt,type NativeHashAbsenceReceipt} from './budget-native-client.js';

export const NATIVE_CUSTODY_DIRECTORY='/var/lib/lares/budget-native';
export const NATIVE_CUSTODY_MAX_RECORDS=128,NATIVE_CUSTODY_MAX_BYTES=1_048_576,NATIVE_CUSTODY_POLICY_BYTES=16_384;
const CONTROL_BYTES=1024,INTENT_BYTES=2048,KEY_BYTES=46;
const uuid=z.string().uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/);
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
const receipt=z.object({journalId:uuid,operationId:uuid,operation:z.enum(['prepare','provision','admit','grant','unknown','settle','member-remove','erase-person']),proposalSequence:z.number().int().positive().safe(),proposalDigest:hash}).strict();
const team=z.object({kind:z.literal('team'),ownershipId:uuid,installationAccountId:uuid,endpoint,nativeTeamId:nativeId,capabilityHash:hash,policy:teamPolicy,createAttempt:writeAttempt}).strict();
const user=z.object({kind:z.literal('user'),ownershipId:uuid,installationAccountId:uuid,accountId:uuid,endpoint,teamOwnershipId:uuid,nativeUserId:nativeId,policy:userPolicy,membership:membershipPolicy,userCreateAttempt:writeAttempt,membershipCreateAttempt:writeAttempt}).strict();
const erasedUser=z.object({kind:z.literal('erased-user'),accountCommitment:hash,coordinateCommitment:hash,erasureReceiptHash:hash}).strict();
const operation=z.object({kind:z.literal('operation'),operationId:uuid,bindingId:uuid,credentialGeneration:generation,userOwnershipId:uuid,
  association:z.object({agent:z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),incarnation:uuid,definitionHash:hash,purposeAlias:alias}).strict(),
  reviewedPolicy:budgetNativeReviewedPolicySchema,policyDigest:hash,keyFingerprint:hash,
  phase:z.enum(['prepared','provisioning','native-blocked-verified','bound-closed','uncertain','revoke-pending','revoked']),keyCreateAttempt:writeAttempt,
  financialOperationId:uuid.nullable(),financialJournalId:uuid.nullable(),bindingReceipt:receipt.nullable(),revocationReceipt:receipt.nullable(),
  plaintext:z.enum(['present','removal-pending','removed']),nativeDeletion:z.enum(['unverified','verified']),
}).strict();
const cleanup=z.object({kind:z.literal('cleanup'),accountCommitment:hash,coordinateCommitment:hash,operationCommitment:hash,endpoint,keyFingerprint:hash,policyDigest:hash,revocationReceiptHash:hash,erasureReceiptHash:hash,phase:z.enum(['revoke-pending','revoked']),plaintext:z.literal('removed'),nativeDeletion:z.enum(['unverified','verified'])}).strict();
const snapshotSchema=z.object({version:z.literal(1),storeId:uuid,revision:z.number().int().nonnegative().safe(),teams:z.array(team),users:z.array(z.discriminatedUnion('kind',[user,erasedUser])),operations:z.array(z.discriminatedUnion('kind',[operation,cleanup]))}).strict();
type Snapshot=z.infer<typeof snapshotSchema>;
export type NativeTeamOwnership=z.infer<typeof team>;
export type NativeUserOwnership=z.infer<typeof user>;
export type NativeOperation=z.infer<typeof operation>;
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

/** One lifecycle owner holds all descriptors and the inherited Linux kernel lock. The
 * nonblocking gate is acquired before any later source/journal ownership. No timers/leases. */
export class BudgetNativeCustodyStore {
  private frozen=false;private stopping=false;private closed=false;private busy=false;private idle=new Set<()=>void>();
  private snapshot!:Snapshot;private control!:Control;private lock!:Handle;private snapshotFile!:Handle;private controlFile!:Handle;
  private publicationIntent?:Handle;private publicationIntentRecord?:PublicationIntent;
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
    const row:NativeOperation={kind:'operation',operationId:randomUUID(),...immutable,phase:'prepared',keyCreateAttempt:'not-attempted',financialOperationId:null,financialJournalId:null,bindingReceipt:null,revocationReceipt:null,plaintext:'present',nativeDeletion:'unverified'};
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
    const op=this.operation(id),r=committedFinancialEvidence(raw,{kind:'bound-closed',binding:this.bindingAtom(op,'active')});if(!r)throw refused();
    if(op.phase==='bound-closed'&&same(op.bindingReceipt,r))return;
    if(op.phase!=='native-blocked-verified'||op.financialOperationId!==r.operationId||op.financialJournalId!==r.journalId)throw refused();this.updateOperation({...op,phase:'bound-closed',bindingReceipt:r});
  }
  private recordRevocation(id:string,raw:CommittedFinancialReceipt):void {
    const op=this.operation(id),r=committedFinancialEvidence(raw,{kind:op.bindingReceipt?'bound-revocation':'pending-revocation',binding:this.bindingAtom(op,'revoked')});if(!r)throw refused();
    if(['revoke-pending','revoked'].includes(op.phase)&&same(op.revocationReceipt,r))return;
    if(['revoke-pending','revoked'].includes(op.phase)||op.financialOperationId===r.operationId||op.financialJournalId!==null&&op.financialJournalId!==r.journalId)throw refused();this.updateOperation({...op,phase:'revoke-pending',revocationReceipt:r});
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
  private removePlaintext(id:string):void {
    const op=this.operation(id);if(op.phase!=='revoke-pending'||!op.revocationReceipt)throw refused();if(op.plaintext==='removed')return;if(op.plaintext!=='present')throw unavailable();
    // First make the revocation and pending removal durable. The second intent then binds
    // unlink to the exact snapshot that records plaintext as removed.
    this.updateOperation({...op,plaintext:'removal-pending'});const file=this.openFile(this.keyName(id),KEY_BYTES);
    const next={...this.snapshot,operations:this.snapshot.operations.map(value=>value.kind==='operation'&&value.operationId===id?{...value,plaintext:'removed' as const}:value)};
    try{this.beginPublicationIntent(next,'key-remove',{operationId:id,keyFingerprint:op.keyFingerprint});
      this.assertHandle(this.keyName(id),file,KEY_BYTES);if(digest(file.bytes)!==op.keyFingerprint)throw unavailable();unlinkSync(join(this.directory,this.keyName(id)));this.syncRoot();
      this.publishSnapshotUnderIntent(next,new Set([id]));this.clearPublicationIntent();}
    finally{file.bytes.fill(0);closeSync(file.fd);}
  }
  private eraseAccountAssociation(accountId:string,raw:CommittedFinancialReceipt):void {
    try{uuid.parse(accountId);}catch{throw refused();}
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
    this.publicationIntent=file;this.publicationIntentRecord=record;this.syncRoot();
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
    this.assertHandle('publication-intent.json',file,INTENT_BYTES);unlinkSync(join(this.directory,'publication-intent.json'));
    // Keep the in-memory intent until the directory sync acknowledges its removal. If
    // that sync is unknown, the caller freezes and cannot claim publication succeeded.
    this.syncRoot(true);file.bytes.fill(0);closeSync(file.fd);this.publicationIntent=undefined;this.publicationIntentRecord=undefined;
    // Recheck the complete store after the unlink sync and before returning permission.
    // This catches a concurrent insertion or path replacement at that exact boundary.
    this.verify();
  }
  private decode<T>(schema:z.ZodType<T>,bytes:Buffer):T {const value=schema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));if(!gatewayCanonical(value).equals(bytes))throw unavailable();return value;}
  private verify(missingKeys=new Set<string>()):void {
    this.assertRoot();this.assertHandle('writer.lock',this.lock,0);this.assertHandle('snapshot.json',this.snapshotFile,NATIVE_CUSTODY_MAX_BYTES);this.assertHandle('control.json',this.controlFile,CONTROL_BYTES);
    if(this.control.storeId!==this.snapshot.storeId||this.control.revision!==this.snapshot.revision||this.control.snapshotDigest!==digest(this.snapshotFile.bytes)||this.control.state==='uncertain'||!this.snapshotBytes(this.snapshot).equals(this.snapshotFile.bytes))throw unavailable();
    if(this.publicationIntent){
      if(!this.publicationIntentRecord)throw unavailable();this.assertHandle('publication-intent.json',this.publicationIntent,INTENT_BYTES);
      const stored=this.decode(publicationIntentSchema,this.publicationIntent.bytes);
      if(!same(stored,this.publicationIntentRecord)||stored.storeId!==this.snapshot.storeId||stored.next.revision!==this.snapshot.revision||stored.next.snapshotDigest!==digest(this.snapshotFile.bytes)||stored.next.controlDigest!==digest(this.controlFile.bytes))throw unavailable();
    }
    const expected=new Set(['writer.lock','snapshot.json','control.json']),unique=new Set<string>();
    if(this.publicationIntent){expected.add('publication-intent.json');}
    const uniqueId=(value:string)=>{if(unique.has(value))throw unavailable();unique.add(value);};
    for(const t of this.snapshot.teams){uniqueId('team:'+t.ownershipId);uniqueId('team-coordinate:'+t.installationAccountId+':'+t.endpoint.hash);uniqueId('native-team:'+t.endpoint.hash+':'+t.nativeTeamId);}
    for(const u of this.snapshot.users){if(u.kind==='erased-user'){uniqueId('erased-user:'+u.coordinateCommitment);continue;}uniqueId('user:'+u.ownershipId);uniqueId('user-coordinate:'+u.accountId+':'+u.endpoint.hash);uniqueId('native-user:'+u.endpoint.hash+':'+u.nativeUserId);const t=this.snapshot.teams.find(t=>t.ownershipId===u.teamOwnershipId);if(!t||t.installationAccountId!==u.installationAccountId||!same(t.endpoint,u.endpoint)||u.userCreateAttempt!=='not-attempted'&&t.createAttempt!=='verified'||u.membershipCreateAttempt!=='not-attempted'&&u.userCreateAttempt!=='verified'||this.snapshot.users.some(v=>v.kind==='erased-user'&&(v.coordinateCommitment===this.userCoordinate(u.accountId,u.endpoint.hash)||v.accountCommitment===commitment('erased-account',this.snapshot.storeId,u.accountId))))throw unavailable();}
    for(const op of this.snapshot.operations){
      if(op.kind==='cleanup'){uniqueId('operation-coordinate:'+op.coordinateCommitment);uniqueId('cleanup-operation:'+op.operationCommitment);uniqueId('key:'+op.keyFingerprint);if((op.phase==='revoked')!==(op.nativeDeletion==='verified')||!this.snapshot.users.some(u=>u.kind==='erased-user'&&u.accountCommitment===op.accountCommitment&&u.erasureReceiptHash===op.erasureReceiptHash))throw unavailable();continue;}
      uniqueId('operation:'+op.operationId);uniqueId('operation-coordinate:'+this.operationCoordinate(op.bindingId,op.credentialGeneration));uniqueId('key:'+op.keyFingerprint);
      const u=this.snapshot.users.find((u):u is NativeUserOwnership=>u.kind==='user'&&u.ownershipId===op.userOwnershipId),t=u&&this.snapshot.teams.find(t=>t.ownershipId===u.teamOwnershipId),p=this.checkedPolicy(op.reviewedPolicy);
      if((op.financialOperationId===null)!==(op.financialJournalId===null)||op.bindingReceipt&&(op.bindingReceipt.operation!=='provision'||op.bindingReceipt.journalId!==op.financialJournalId)||op.revocationReceipt&&(!['member-remove','erase-person'].includes(op.revocationReceipt.operation)||op.financialJournalId!==null&&op.revocationReceipt.journalId!==op.financialJournalId))throw unavailable();
      if(!u||!t||op.keyCreateAttempt!=='not-attempted'&&u.membershipCreateAttempt!=='verified'||op.keyCreateAttempt!=='not-attempted'&&!['provisioning','native-blocked-verified','bound-closed','uncertain','revoke-pending','revoked'].includes(op.phase)||['native-blocked-verified','bound-closed'].includes(op.phase)&&(op.keyCreateAttempt!=='verified'||u.membershipCreateAttempt!=='verified'||u.userCreateAttempt!=='verified'||t.createAttempt!=='verified')||op.policyDigest!==gatewayHash(gatewayCanonical(p))||!same(t.policy,p.team)||!same(u.policy,p.user)||!same(u.membership,p.membership)||t.capabilityHash!==p.pricing.capabilityHash||p.key.models.length!==1||p.key.models[0]!==op.association.purposeAlias||(op.phase==='revoked')!==(op.nativeDeletion==='verified')||op.phase==='revoked'&&op.plaintext!=='removed'||op.phase==='bound-closed'&&(!op.bindingReceipt||op.bindingReceipt.operationId!==op.financialOperationId)||op.bindingReceipt&&op.bindingReceipt.operationId!==op.financialOperationId||['revoke-pending','revoked'].includes(op.phase)&&!op.revocationReceipt||op.plaintext!=='present'&&(!['revoke-pending','revoked'].includes(op.phase)||!op.revocationReceipt))throw unavailable();
      if(op.plaintext!=='removed'){
        const name=this.keyName(op.operationId);if(missingKeys.has(op.operationId))continue;expected.add(name);
        const file=this.openFile(name,KEY_BYTES);try{if(file.bytes.length!==KEY_BYTES||digest(file.bytes)!==op.keyFingerprint)throw unavailable();}finally{file.bytes.fill(0);closeSync(file.fd);}
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
    try{fchownSync(fd,this.uid,this.gid);fchmodSync(fd,0o600);let offset=0;while(offset<bytes.length){this.assertOwner();const written=writeSync(fd,bytes,offset,bytes.length-offset);if(written<1)throw unavailable();offset+=written;}this.assertOwner();this.sync(fd);const file={fd,stat:fstatSync(fd,{bigint:true}),bytes:Buffer.from(bytes)};this.assertHandle(name,file,Math.max(bytes.length,1));return file;}catch{closeSync(fd);throw unavailable();}
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
      published=true;next.stat=fstatSync(next.fd,{bigint:true});this.assertHandle(name,next,bytes.length);this.syncRoot();return next;
    }finally{if(published)closeSync(current.fd);else closeSync(next.fd);}
  }
  private assertOwner(skipIntentCheck=false):void {
    this.assertRoot();if(this.lock)this.assertHandle('writer.lock',this.lock,0);
    if(this.publicationIntent&&!skipIntentCheck){this.assertHandle('publication-intent.json',this.publicationIntent,INTENT_BYTES);if(!this.publicationIntentRecord||!this.publicationIntent.bytes.equals(gatewayCanonical(this.publicationIntentRecord)))throw unavailable();}
  }
  private syncRoot(skipIntentCheck=false):void {this.assertOwner(skipIntentCheck);this.sync(this.rootFd);this.assertOwner(skipIntentCheck);}
  private freeze():void {if(this.closed||this.frozen)return;this.frozen=true;if(this.publicationIntent)return;try{this.publishControl({...this.control,state:'uncertain'});}catch{/* Writer-open/partial/mismatched files still refuse later adoption. */}}
  private release():void {if(this.closed)return;this.closed=true;for(const file of [this.snapshotFile,this.controlFile,this.lock,this.publicationIntent])if(file){file.bytes.fill(0);try{closeSync(file.fd);}catch{}}if(this.rootFd!==undefined)try{closeSync(this.rootFd);}catch{}}
}

// Bound enumeration before materializing the inventory, including unexpected entries.
function opendirBounded(path:string,maximum:number):string[]{const directory=opendirSync(path),names:string[]=[];try{for(let entry=directory.readSync();entry!==null;entry=directory.readSync()){if(names.length>=maximum)throw unavailable();names.push(entry.name);}return names;}finally{directory.closeSync();}}
