/** Protected host custody. Continuity and preparation never open spending authority. */
import {constants,openSync,closeSync,fstatSync,lstatSync,readFileSync,readSync,writeSync,fsyncSync,mkdirSync,readdirSync,renameSync,existsSync,statfsSync} from 'node:fs';
import {isAbsolute,join,normalize,parse,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {canonicalBudgetMoney,budgetIdentitySuppression,type BudgetFinancialOperation,type BudgetRecoveryReference} from '@lares/agent-kit/budget-admission-store';
import {gatewayCanonical} from '@lares/agent-kit/gateway-admission-protocol';
import {gatewayPricingSchema} from '@lares/agent-kit/gateway-pricing';
import {consumeSourceObservationCommit,type SourceObservationCommit} from '@lares/agent-kit/console-source-transaction';
import {consumeFinancialObservationHandle,type FinancialObservationHandle} from './financial-continuity.js';
const digest=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
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
export interface FinancialCounts {accounts:number;windows:number;bindings:number;attempts:number;grants:number;checkpoints:number}
export interface FinancialWindowTotal {windowId:string;state:string;count:number;reserved:string;actual:string;high:string}
/** What each step compares: every row that can still change money, the newest checkpoints and
 * every table's count. Finished attempts leave `atoms` after they are summarised; `windowTotals`
 * then covers the current months' money, and the whole-ledger check covers each summarised row. */
export interface FinancialProjection {checkpoints:FinancialCheckpoint[];atoms:FinancialAtom[];counts:FinancialCounts;windowTotals?:{accountIds:string[];windowIds:string[];totals:FinancialWindowTotal[]}}
const observationCounts=z.object({accounts:z.number().int().nonnegative().safe(),windows:z.number().int().nonnegative().safe(),bindings:z.number().int().nonnegative().safe(),attempts:z.number().int().nonnegative().safe(),grants:z.number().int().nonnegative().safe(),checkpoints:z.number().int().positive().safe()}).strict();
export const FINANCIAL_OBSERVATION_SCHEMA=z.object({operationId:id,checkpoint:FINANCIAL_CHECKPOINT_SCHEMA,database:FINANCIAL_DATABASE_SCHEMA,projectionDigest:hash,checkpointDigest:hash,counts:observationCounts}).strict();
export type FinancialObservation=z.infer<typeof FINANCIAL_OBSERVATION_SCHEMA>;
/** Which database this is. Its start time is recorded evidence, not identity: an ordinary
 * restart changes it, and the full ledger comparison decides whether the data still matches. */
function sameFinancialDatabase(left:FinancialDatabase,right:FinancialDatabase):boolean {
  return left.systemIdentifier===right.systemIdentifier&&left.databaseOid===right.databaseOid;
}
export function financialAtomKey(atom:FinancialAtom):string {
  return atom.kind==='grant'?`${atom.kind}:${atom.attemptId}`:atom.kind==='tombstone'?`${atom.kind}:${atom.accountId}`:`${atom.kind}:${atom.id}`;
}
function assertUniqueFinancialAtoms(atoms:readonly FinancialAtom[]):void {
  const keys=new Set<string>();for(const atom of atoms){const key=financialAtomKey(atom);if(keys.has(key))throw new Error('Duplicate financial atom');keys.add(key);}
}
const receiptSchema=z.object({version:z.literal(1),journalId:id,suppressionKeyFingerprint:hash}).strict();
const gatewayRecoveryReferenceSchema=z.object({installationAccountId:id,epoch:z.string().min(1).max(200),endpointGeneration:uint}).strict();
export interface JournalOptions {ownershipUid?:number;lock?:(fd:number)=>void;sync?:(fd:number)=>void;requirePrepared?:boolean;bookBytes?:number;freeBytes?:(directory:string)=>number}
const operation=z.enum(['prepare','provision','native-activation','admit','grant','unknown','settle','member-remove','erase-person','native-cleanup-recovery']);
const base={version:z.literal(1),sequence:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),operationId:id,previousDigest:hash};
export const FINANCIAL_JOURNAL_RECORD_SCHEMA=z.discriminatedUnion('kind',[
  z.object({...base,kind:z.literal('genesis'),journalId:id,suppressionKeyFingerprint:hash}).strict(),
  z.object({...base,kind:z.literal('book-open'),journalId:id,book:z.number().int().min(2).safe(),sealedBookDigest:hash,sealedBookBytes:z.number().int().positive().safe()}).strict(),
  z.object({...base,kind:z.literal('book-seal'),book:z.number().int().positive().safe()}).strict(),
  z.object({...base,kind:z.literal('writer-open')}).strict(),
  z.object({...base,kind:z.literal('preparation-complete')}).strict(),
  z.object({...base,kind:z.literal('control'),control:controlSchema}).strict(),
  z.object({...base,kind:z.literal('freeze'),reason:z.enum(['restore','continuity','uncertain'])}).strict(),
  z.object({...base,kind:z.literal('writer-close')}).strict(),
  z.object({...base,kind:z.literal('begin'),operation}).strict(),
  z.object({...base,kind:z.literal('proposal'),atoms:z.array(FINANCIAL_ATOM_SCHEMA).max(128)}).strict(),
  z.object({...base,kind:z.literal('commit'),proposalDigest:hash}).strict(),
  z.object({...base,kind:z.literal('observation'),observation:FINANCIAL_OBSERVATION_SCHEMA}).strict(),
  z.object({...base,kind:z.literal('abort'),proposalDigest:hash.nullable(),reason:z.enum(['not-started','rollback-acknowledged','source-retirement-acknowledged','source-retirement-rolled-back'])}).strict(),
]);
type JournalRecord=z.infer<typeof FINANCIAL_JOURNAL_RECORD_SCHEMA>;
const frameSchema=z.object({record:FINANCIAL_JOURNAL_RECORD_SCHEMA,digest:hash}).strict();
/** Thrown before any record or database work, so the same operation can safely be tried again. */
export class FinancialJournalBusy extends Error {constructor(){super('Financial journal is closed or busy');}}
/** How long a step may wait for its turn. `first` goes ahead of steps that can still be refused
 * safely: a step that follows a committed admission is never resent, so it cannot lose its place. */
export interface FinancialTurnWait {ms:number;first?:boolean}
interface WaitingTurn {first:boolean;start:()=>void;refuse:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}
export const JOURNAL_MAX_RECORD_BYTES=65_536,JOURNAL_MAX_BYTES=8*1024*1024,JOURNAL_MAX_RECORDS=8192;
const CONTROL_RECORD_BYTES=1024;
// A seal or freeze may pass a book's limits by this much, so a full book can always be closed.
const BOOK_CLOSING_RECORDS=2;
// Finished attempts are summarised once this many are waiting. Only these newest checkpoints
// stay in each step's comparison, along with every checkpoint of a non-gateway operation.
const FOLD_SUMMARISE_AT=64,FOLD_CHECKPOINT_TAIL=64;
const GATEWAY_OPERATIONS:ReadonlySet<string>=new Set(['prepare','admit','grant','settle','unknown']);
const BOOK_NAME=/^journal-[0-9]{6}\.jsonl$/,BOOK_PARTIAL=/^journal-[0-9]{6}\.partial$/;
const bookName=(book:number)=>book===1?'journal.jsonl':`journal-${String(book).padStart(6,'0')}.jsonl`;
const MONEY_SCALE=10n**18n;
const moneyUnits=(value:string)=>{const [whole,fraction='']=value.split('.');return BigInt(whole!)*MONEY_SCALE+BigInt(fraction.padEnd(18,'0'));};
const moneyText=(value:bigint)=>{const fraction=(value%MONEY_SCALE).toString().padStart(18,'0').replace(/0+$/,'');return (value/MONEY_SCALE).toString()+(fraction?'.'+fraction:'');};
type AttemptAtom=Extract<FinancialAtom,{kind:'attempt'}>;
type AttemptMoney=Pick<AttemptAtom,'installationWindowId'|'memberWindowId'|'state'|'reservedAmount'|'actualAmount'|'highestObservedLiability'>;
/** Keeps only what later checks need from a finished row: its fingerprint and its money. */
type SummarisedAtom={digest:string;money?:AttemptMoney};
/** Adds one checkpoint to the running fingerprint of the whole list, oldest first. */
export function financialCheckpointRolling(previous:string,checkpoint:FinancialCheckpoint):string {
  return digest(Buffer.concat([Buffer.from(previous),gatewayCanonical(checkpoint)]));
}
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
export interface CommittedFinancialEvidence {readonly journalId:string;readonly operationId:string;readonly operation:BudgetFinancialOperation;readonly proposalSequence:number;readonly proposalDigest:string}
declare const committedReceiptBrand:unique symbol;
export interface CommittedFinancialReceipt extends CommittedFinancialEvidence {readonly [committedReceiptBrand]:true}
interface CommittedReceiptProof {evidence:CommittedFinancialEvidence;atoms:readonly FinancialAtom[];observedProjection?:readonly FinancialAtom[];priorProjection?:readonly FinancialAtom[]}
const committedReceipts=new WeakMap<object,CommittedReceiptProof>();
interface PublicationProof {journal:HostFinancialJournal;operationId:string;receipt:CommittedFinancialReceipt;used:boolean;active:boolean}
const publicationProofs=new WeakMap<object,PublicationProof>();
let activePublicationProof:PublicationProof|undefined;
/** Native receipt mutations are accepted only inside the current journal-owned batch. */
export function requireCurrentFinancialPublicationProof(receipt:CommittedFinancialReceipt):void {
  const proof=receipt&&typeof receipt==='object'?publicationProofs.get(receipt):undefined;
  if(!proof||proof!==activePublicationProof||!proof.active||proof.receipt!==receipt||!proof.journal.publicationProofIsCurrent(proof.operationId))throw new Error('Current financial publication proof unavailable');
}
export type FinancialAbortOutcome='not-started'|'rollback-acknowledged'|'source-retirement-acknowledged'|'source-retirement-rolled-back';
declare const durableAbortReceiptBrand:unique symbol;
export interface DurableFinancialAbortReceipt {readonly [durableAbortReceiptBrand]:true;readonly journalId:string;readonly operationId:string;readonly operation:BudgetFinancialOperation;readonly outcome:FinancialAbortOutcome;readonly terminalSequence:number;readonly terminalDigest:string}
const durableAbortReceipts=new WeakMap<object,{finished:boolean;failure?:unknown;markedError?:object}>();
const currentAbortFailures=new WeakMap<object,DurableFinancialAbortReceipt>();
const journaledAborts=new WeakMap<object,DurableFinancialAbortReceipt>();
/** Preserve the original failure. Only a prepared, fsynced abort from an operation
 * whose barrier has finished may mark it; copied fields never carry authority. */
export function markJournaledAbort(error:unknown,receipt:DurableFinancialAbortReceipt|undefined):void {
  if(!error||typeof error!=='object'||!receipt||typeof receipt!=='object')return;
  const proof=durableAbortReceipts.get(receipt);if(!proof?.finished||proof.failure!==error||currentAbortFailures.get(error)!==receipt||proof.markedError&&proof.markedError!==error)return;
  proof.markedError=error;journaledAborts.set(error,receipt);
}
export function isJournaledAbort(error:unknown,expected:{journalId:string;operation:BudgetFinancialOperation}):boolean {
  if(!error||typeof error!=='object')return false;const receipt=journaledAborts.get(error);
  return !!receipt&&durableAbortReceipts.get(receipt)?.finished===true&&receipt.journalId===expected.journalId&&receipt.operation===expected.operation;
}
type BindingAtom=Extract<FinancialAtom,{kind:'binding'}>;
function nativeCleanupProjectionCovers(atoms:readonly FinancialAtom[],binding:BindingAtom):boolean {
  if(binding.state!=='revoked')return false;
  const exactBinding=atoms.some(atom=>atom.kind==='binding'&&gatewayCanonical(atom).equals(gatewayCanonical(binding)));
  const account=atoms.find((atom):atom is Extract<FinancialAtom,{kind:'account'}>=>atom.kind==='account'&&atom.id===binding.memberAccountId&&atom.accountKind==='member'&&atom.installationAccountId===binding.installationAccountId&&atom.state==='retired');
  if(!exactBinding||!account)return false;
  if(account.reason==='member_removed')return true;
  if(account.reason!=='member_erased')return false;
  const tombstone=atoms.find((atom):atom is Extract<FinancialAtom,{kind:'tombstone'}>=>atom.kind==='tombstone'&&atom.accountId===binding.memberAccountId&&atom.state==='erased');
  return !!tombstone&&account.canonicalSuppressionHash===tombstone.canonicalSuppressionHash&&gatewayCanonical(account.providerSuppressionHashes).equals(gatewayCanonical(tombstone.providerSuppressionHashes));
}
function nativeActivationProjectionCovers(atoms:readonly FinancialAtom[],requirement:Extract<FinancialReceiptRequirement,{kind:'native-activation'}>):boolean {
  const binding=requirement.binding;
  if(binding.state!=='active'||!atoms.some(atom=>atom.kind==='binding'&&gatewayCanonical(atom).equals(gatewayCanonical(binding))))return false;
  const installation=atoms.find((atom):atom is Extract<FinancialAtom,{kind:'account'}>=>atom.kind==='account'&&atom.id===binding.installationAccountId);
  const member=atoms.find((atom):atom is Extract<FinancialAtom,{kind:'account'}>=>atom.kind==='account'&&atom.id===binding.memberAccountId);
  const installationWindow=atoms.find((atom):atom is Extract<FinancialAtom,{kind:'window'}>=>atom.kind==='window'&&atom.id===requirement.installationWindowId);
  const memberWindow=atoms.find((atom):atom is Extract<FinancialAtom,{kind:'window'}>=>atom.kind==='window'&&atom.id===requirement.memberWindowId);
  return !!installation&&installation.accountKind==='installation'&&installation.installationAccountId===installation.id&&installation.state==='open'&&installation.reason==='approved'&&
    installation.selectedEndpointHash===binding.endpointHash&&installation.endpointGeneration===requirement.endpointGeneration&&installation.recoveryEpochHash===requirement.recoveryEpochHash&&
    installation.activeWindowId===requirement.installationWindowId&&installation.installationCap===requirement.installationCap&&
    !!member&&member.accountKind==='member'&&member.installationAccountId===installation.id&&member.state==='open'&&member.reason==='approved'&&
    member.selectedEndpointHash===null&&member.recoveryEpochHash===null&&member.activeWindowId===requirement.memberWindowId&&
    !!installationWindow&&installationWindow.accountId===installation.id&&installationWindow.openingCap===requirement.installationCap&&
    installationWindow.startsAt===requirement.monthStartsAt&&installationWindow.endsAt===requirement.monthEndsAt&&
    !!memberWindow&&memberWindow.accountId===member.id&&memberWindow.openingCap===requirement.memberWindowCap&&memberWindow.startsAt===requirement.monthStartsAt&&memberWindow.endsAt===requirement.monthEndsAt;
}
function freezeFinancialAtoms(atoms:readonly FinancialAtom[]):readonly FinancialAtom[]{
  const freeze=(value:unknown):unknown=>{
    if(!value||typeof value!=='object')return value;
    for(const child of Object.values(value))freeze(child);
    return Object.freeze(value);
  };
  return Object.freeze(atoms.map(atom=>freeze(FINANCIAL_ATOM_SCHEMA.parse(structuredClone(atom))) as FinancialAtom));
}
function canonicalMonthStart(value:string):string|undefined{
  const match=/^(\d{4})-(0[1-9]|1[0-2])-01T00:00:00\.000000Z$/.exec(value);if(!match)return undefined;
  return value;
}
function isCurrentMonthWindow(window:Extract<FinancialAtom,{kind:'window'}>):boolean{
  const starts=canonicalMonthStart(window.startsAt);if(!starts)return false;
  const match=/^(\d{4})-(\d{2})-/.exec(starts);if(!match)return false;
  let year=Number(match[1]),month=Number(match[2])+1;if(month===13){month=1;year++;}
  const expectedEnd=`${String(year).padStart(4,'0')}-${String(month).padStart(2,'0')}-01T00:00:00.000000Z`;
  return window.endsAt===expectedEnd;
}
function positiveMoney(value:string|null):boolean{
  if(value===null)return false;try{return canonicalBudgetMoney(value)===value&&value!=='0';}catch{return false;}
}
function atomMap(atoms:readonly FinancialAtom[]):Map<string,FinancialAtom>|undefined{
  const result=new Map<string,FinancialAtom>();
  try{for(const value of atoms){const atom=FINANCIAL_ATOM_SCHEMA.parse(value),key=financialAtomKey(atom);if(result.has(key))return undefined;result.set(key,atom);}}
  catch{return undefined;}
  return result;
}
function activeProvisionProjectionCovers(beforeAtoms:readonly FinancialAtom[],afterAtoms:readonly FinancialAtom[],proposal:readonly FinancialAtom[],binding:BindingAtom):boolean{
  if(binding.state!=='active')return false;
  const before=atomMap(beforeAtoms),after=atomMap(afterAtoms),proposed=atomMap(proposal);if(!before||!after||!proposed||after.size!==before.size+1)return false;
  const bindingKey=financialAtomKey(binding),proposedBinding=proposed.get(bindingKey),afterBinding=after.get(bindingKey);
  if(before.has(bindingKey)||!proposedBinding||!afterBinding||!gatewayCanonical(proposedBinding).equals(gatewayCanonical(binding))||!gatewayCanonical(afterBinding).equals(gatewayCanonical(binding)))return false;
  for(const [key,value] of before){const next=after.get(key);if(!next||!gatewayCanonical(value).equals(gatewayCanonical(next)))return false;}
  const additions=[...after].filter(([key])=>!before.has(key));if(additions.length!==1||additions[0]?.[0]!==bindingKey)return false;
  const installation=before.get(`account:${binding.installationAccountId}`),member=before.get(`account:${binding.memberAccountId}`);
  if(!installation||installation.kind!=='account'||installation.accountKind!=='installation'||installation.id!==binding.installationAccountId||
    installation.installationAccountId!==installation.id||installation.state!=='open'||installation.reason!=='approved'||installation.selectedEndpointHash!==binding.endpointHash||
    !positiveMoney(installation.installationCap)||!installation.activeWindowId||installation.endpointGeneration==='0'||installation.recoveryEpochHash===null)return false;
  if(!member||member.kind!=='account'||member.id===installation.id||member.accountKind!=='member'||member.installationAccountId!==installation.id||
    member.state!=='closed'||member.reason!=='unreconciled'||member.selectedEndpointHash!==null||member.recoveryEpochHash!==null||!member.activeWindowId)return false;
  const installationWindow=before.get(`window:${installation.activeWindowId}`),memberWindow=before.get(`window:${member.activeWindowId}`);
  if(!installationWindow||installationWindow.kind!=='window'||installationWindow.id!==installation.activeWindowId||installationWindow.accountId!==installation.id||
    !isCurrentMonthWindow(installationWindow)||installationWindow.openingCap!==installation.installationCap)return false;
  if(!memberWindow||memberWindow.kind!=='window'||memberWindow.id!==member.activeWindowId||memberWindow.accountId!==member.id||
    memberWindow.startsAt!==installationWindow.startsAt||memberWindow.endsAt!==installationWindow.endsAt||!isCurrentMonthWindow(memberWindow)||!positiveMoney(memberWindow.openingCap))return false;
  // Every previous atom was compared byte-for-byte above, so these linked rows are also
  // present and unchanged in the observed after-fold. Do not relate policy revisions to
  // account generations: a newly provisioned window intentionally uses generation + 1.
  return true;
}
export type FinancialReceiptRequirement=
  |{kind:'bound-closed';binding:BindingAtom}
  |{kind:'native-activation';binding:BindingAtom;installationWindowId:string;memberWindowId:string;endpointGeneration:string;recoveryEpochHash:string;monthStartsAt:string;monthEndsAt:string;installationCap:string;memberWindowCap:string}
  |{kind:'pending-revocation'|'bound-revocation';binding:BindingAtom}
  |{kind:'account-erasure';accountId:string;installationAccountId?:string}
  |{kind:'native-cleanup-recovery';binding:BindingAtom};
/** Only a live receipt minted by this module can authorize these fixed financial facts.
 * Reading a historical line or copying its coordinates never creates process authority.
 * Private agent/native coordinates are deliberately absent from financial atoms; this
 * receipt proves only the projected financial tuple, never those private fields. */
export function committedFinancialEvidence(receipt:CommittedFinancialReceipt,requirement:FinancialReceiptRequirement):CommittedFinancialEvidence|undefined {
  if(!receipt||typeof receipt!=='object')return undefined;
  const proof=committedReceipts.get(receipt);if(!proof)return undefined;
  const {evidence,atoms,observedProjection}=proof;
  const retired=(accountId:string,installationAccountId:string|undefined,erased:boolean)=>atoms.some(a=>a.kind==='account'&&a.id===accountId&&a.accountKind==='member'&&(!installationAccountId||a.installationAccountId===installationAccountId)&&a.state==='retired'&&a.reason===(erased?'member_erased':evidence.operation==='erase-person'?'member_erased':'member_removed'));
  let covered=false;
  const erasedTombstone=(accountId:string)=>atoms.some(t=>t.kind==='tombstone'&&t.accountId===accountId&&t.state==='erased'&&atoms.some(a=>a.kind==='account'&&a.id===accountId&&a.canonicalSuppressionHash===t.canonicalSuppressionHash&&gatewayCanonical(a.providerSuppressionHashes).equals(gatewayCanonical(t.providerSuppressionHashes))));
  if(requirement.kind==='account-erasure')covered=evidence.operation==='erase-person'&&retired(requirement.accountId,requirement.installationAccountId,true)&&erasedTombstone(requirement.accountId);
  else if(requirement.kind==='native-cleanup-recovery'){
    covered=evidence.operation==='native-cleanup-recovery'&&!!observedProjection&&nativeCleanupProjectionCovers(observedProjection,requirement.binding);
  }
  else if(requirement.kind==='native-activation')covered=evidence.operation==='native-activation'&&!!observedProjection&&nativeActivationProjectionCovers(observedProjection,requirement);
  else {
    const binding=requirement.binding,exact=atoms.some(a=>a.kind==='binding'&&gatewayCanonical(a).equals(gatewayCanonical(binding)));
    if(requirement.kind==='bound-closed'){
      const initial=evidence.operation==='provision'&&binding.state==='active'&&exact&&[binding.installationAccountId,binding.memberAccountId].every(accountId=>atoms.some(a=>a.kind==='account'&&a.id===accountId&&a.installationAccountId===binding.installationAccountId&&a.accountKind===(accountId===binding.installationAccountId?'installation':'member')&&a.state==='closed'&&a.reason==='unreconciled'&&a.selectedEndpointHash===null&&a.recoveryEpochHash===null));
      if(initial)covered=true;
      else if(evidence.operation==='provision'&&binding.state==='active'&&exact&&proof.priorProjection&&observedProjection){
        try{requireCurrentFinancialPublicationProof(receipt);covered=activeProvisionProjectionCovers(proof.priorProjection,observedProjection,atoms,binding);}catch{covered=false;}
      }
    }
    // Pending custody may never have reached INSERT. Erasure may omit already-revoked
    // historical rows; its irreversible member retirement plus matching erased tombstone
    // covers them. A present but mismatching binding never receives this fallback.
    else covered=['member-remove','erase-person'].includes(evidence.operation)&&binding.state==='revoked'&&(exact||!atoms.some(a=>a.kind==='binding'&&a.id===binding.id)&&retired(binding.memberAccountId,binding.installationAccountId,false)&&(requirement.kind==='pending-revocation'||evidence.operation==='erase-person'&&erasedTombstone(binding.memberAccountId)));
  }
  return covered?{...evidence}:undefined;
}
/** The ordered book files. Book 1 keeps its original name; a gap or unknown name is refused. */
function journalBooks(directory:string):string[] {
  const names=readdirSync(directory).filter(name=>name.startsWith('journal'));
  for(const name of names)if(name!=='journal.jsonl'&&!BOOK_NAME.test(name)&&!BOOK_PARTIAL.test(name))throw new Error('Unexpected journal file');
  const numbered=names.filter(name=>BOOK_NAME.test(name)).sort();
  numbered.forEach((name,index)=>{if(name!==bookName(index+2))throw new Error('Missing journal book');});
  return ['journal.jsonl',...numbered];
}
export class HostFinancialJournal {
  #key:Buffer;
  private book=1;private bookRecords=0;private sealedAway=false;private maxBookBytes=JOURNAL_MAX_BYTES;private freeBytes:(directory:string)=>number=directory=>{const stat=statfsSync(directory);return Number(stat.bavail)*Number(stat.bsize);};
  private summarised=new Map<string,SummarisedAtom>();private summarisedAttempts=0;private summarisedGrants=0;private finishedWaiting=0;private windowTotals=new Map<string,Map<string,{count:number;reserved:bigint;actual:bigint;high:bigint}>>();
  private checkpointCount=0;private checkpointDigest=zero;private retainedCheckpoints=new Set<number>();
  private sequence=0;private head=zero;private size=0;private journalId='';private writerId=randomUUID();private writerLease=false;private startupLeasePending=false;private startupContinuityVerified=false;private pending?:{id:string;proposal?:string;operation?:BudgetFinancialOperation;atoms?:FinancialAtom[]};private activeOperationId?:string;private busy=false;private frozen=false;private closed=false;private stopping=false;private control?:FinancialControl;private lastCheckpoint:FinancialCheckpoint|null=null;private checkpoints:FinancialCheckpoint[]=[];private projection=new Map<string,FinancialAtom>();private idle=new Set<()=>void>();private preparationComplete=false;private line:WaitingTurn[]=[];
  private pendingAbortReceipt?:DurableFinancialAbortReceipt;
  private constructor(private directory:string,private journalFd:number,private lockFd:number,private directoryFd:number,private keyFd:number,key:Buffer,private uid:number,private sync:(fd:number)=>void){this.#key=key;}
  /** No mkdir, key creation, restore adoption, tail repair or automatic initialization. */
  static openExisting(directory:string,options:JournalOptions={}):HostFinancialJournal {
    return this.openExistingWithLease(directory,options,true);
  }
  /** Keeper startup holds/replays custody while checking the database, but records writer
   * ownership only after that check succeeds. Other callers keep the ordinary eager lease. */
  static openExistingForStartupVerification(directory:string,options:JournalOptions={}):HostFinancialJournal {
    return this.openExistingWithLease(directory,options,false);
  }
  private static openExistingWithLease(directory:string,options:JournalOptions={},acquireLease:boolean):HostFinancialJournal {
    const uid=options.ownershipUid??0;let lockFd:number|undefined,journalFd:number|undefined,directoryFd:number|undefined,keyFd:number|undefined,key:Buffer|undefined;
    try{
      verifyDirectory(directory,uid);directoryFd=openSync(directory,constants.O_RDONLY|constants.O_NOFOLLOW);
      lockFd=protectedFile(join(directory,'writer.lock'),uid,constants.O_RDWR);(options.lock??linuxInheritedJournalLock)(lockFd);
      keyFd=protectedFile(join(directory,'suppression.key'),uid,constants.O_RDONLY);
      if(fstatSync(keyFd).size!==32)throw new Error('Financial custody unavailable');key=readFileSync(keyFd);if(key.length!==32)throw new Error('Financial custody unavailable');
      const books=journalBooks(directory);
      journalFd=protectedFile(join(directory,books.at(-1)!),uid,constants.O_RDWR|constants.O_APPEND);
      const journal=new HostFinancialJournal(directory,journalFd,lockFd,directoryFd,keyFd,key,uid,options.sync??fsyncSync);
      journal.startupLeasePending=!acquireLease;journal.book=books.length;
      if(options.bookBytes)journal.maxBookBytes=options.bookBytes;if(options.freeBytes)journal.freeBytes=options.freeBytes;
      journal.load(options.requirePrepared===true,books);
      if(acquireLease&&!journal.frozen)journal.acquireWriterLease();
      return journal;
    }catch{
      key?.fill(0);for(const fd of [journalFd,lockFd,directoryFd,keyFd])if(fd!==undefined)closeSync(fd);
      throw new Error('Financial journal unavailable; explicit recovery is required');
    }
  }
  /** A startup-open journal must have completed a successful full continuity check
   * while this same object still owns the protected lock before it can become a writer. */
  acquireWriterLease():void {
    if(this.closed||this.frozen||this.stopping||this.busy||this.writerLease||this.startupLeasePending&&!this.startupContinuityVerified)throw new Error('Financial writer lease unavailable');
    this.ensureRoom(this.control?3:2,(this.control?3:2)*CONTROL_RECORD_BYTES);this.busy=true;
    try{this.append({kind:'writer-open'},this.writerId);this.writerLease=true;this.startupLeasePending=false;}
    finally{this.busy=false;}
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
  private load(requirePrepared:boolean,books:readonly string[]):void {
    const limit=this.maxBookBytes+BOOK_CLOSING_RECORDS*CONTROL_RECORD_BYTES,hasPartial=readdirSync(this.directory).some(name=>BOOK_PARTIAL.test(name));
    const readBook=(index:number)=>{
      const last=index===books.length-1,fd=last?this.journalFd:protectedFile(join(this.directory,books[index]!),this.uid,constants.O_RDONLY);
      try{
        const stat=fstatSync(fd);if(stat.size<1||stat.size>limit)throw new Error('Invalid journal size');
        const raw=readFileSync(fd);if(raw.length!==stat.size||raw[raw.length-1]!==10)throw new Error('Partial journal');return raw;
      }finally{if(!last)closeSync(fd);}
    };
    const operations=new Set<string>();let genesis=false,writer:string|undefined,sealedTail=false,raw:Buffer|undefined=readBook(0);
    for(let index=0;index<books.length&&raw;index++){
      const last=index===books.length-1,next=last?undefined:readBook(index+1);
      // The next book's first record holds this book's whole-file fingerprint. Once it matches,
      // every byte here is what was sealed, so the slower record-by-record checks are skipped.
      if(next){
        const first=frameSchema.parse(JSON.parse(next.subarray(0,next.indexOf(10)).toString('utf8'))).record;
        if(first.kind!=='book-open'||first.book!==index+2||first.sealedBookDigest!==digest(raw)||first.sealedBookBytes!==raw.length)throw new Error('Journal book mismatch');
      }
      const trusted=next!==undefined,lines=raw.subarray(0,-1).toString('utf8').split('\n');
      if(lines.length>JOURNAL_MAX_RECORDS+BOOK_CLOSING_RECORDS)throw new Error('Journal limit');
      let sealed=false;
      for(const [position,line] of lines.entries()){
        let frame:z.infer<typeof frameSchema>;
        // A proposal is most of a book's bytes and its atoms are only ever compared in canonical form.
        if(trusted){frame=JSON.parse(line);if(frame.record.kind!=='proposal')frame=frameSchema.parse(frame);}
        else{
          if(Buffer.byteLength(line)+1>JOURNAL_MAX_RECORD_BYTES)throw new Error('Journal record limit');
          frame=frameSchema.parse(JSON.parse(line));const expected=financialJournalFrame(frame.record);
          if(!expected.bytes.equals(Buffer.from(line+'\n'))||frame.digest!==expected.digest)throw new Error('Journal integrity');
        }
        const r=frame.record;
        if(r.sequence!==this.sequence||r.previousDigest!==this.head)throw new Error('Journal sequence');
        if(sealed&&!(last&&r.kind==='freeze'))throw new Error('Journal record after seal');
        if(index>0&&position===0&&(r.kind!=='book-open'||r.book!==index+1||r.journalId!==this.journalId))throw new Error('Journal book mismatch');
        if(!genesis){if(r.kind!=='genesis'||r.sequence!==0||r.suppressionKeyFingerprint!==digest(this.#key))throw new Error('Journal custody mismatch');this.journalId=r.journalId;genesis=true;}
        else if(r.kind==='book-open'){if(position!==0)throw new Error('Journal book mismatch');}
        else if(r.kind==='book-seal'){if(this.pending||r.book!==index+1)throw new Error('Journal seal mismatch');sealed=true;}
        else if(r.kind==='freeze'){this.frozen=true;}
        else if(r.kind==='preparation-complete'){if(r.sequence!==2||!this.control||this.preparationComplete||writer||this.pending)throw new Error('Preparation completion mismatch');this.preparationComplete=true;}
        else if(r.kind==='control'){if(this.pending||r.control.journalId!==this.journalId||JSON.stringify(r.control.checkpoint)!==JSON.stringify(this.lastCheckpoint))throw new Error('Journal control mismatch');if(this.control&&JSON.stringify(this.control.database)!==JSON.stringify(r.control.database))throw new Error('Journal database changed');this.control=r.control;}
        else if(r.kind==='writer-open'){if(writer||this.pending)throw new Error('Journal writer overlap');writer=r.operationId;}
        else if(r.kind==='writer-close'){if(writer!==r.operationId||this.pending)throw new Error('Journal writer mismatch');writer=undefined;}
        else if(r.kind==='begin'){if(!writer||this.pending||!trusted&&operations.has(r.operationId))throw new Error('Journal operation replay');if(!trusted)operations.add(r.operationId);this.pending={id:r.operationId,operation:r.operation};}
        else if(r.kind==='proposal'){if(!this.pending||this.pending.id!==r.operationId||this.pending.proposal)throw new Error('Journal proposal mismatch');if(!trusted)assertUniqueFinancialAtoms(r.atoms);this.pending.proposal=frame.digest;this.pending.atoms=r.atoms;}
        else if(r.kind==='commit'){
          if(!this.pending?.proposal||this.pending.id!==r.operationId||this.pending.proposal!==r.proposalDigest||!this.pending.atoms)throw new Error('Journal commit mismatch');
          this.lastCheckpoint={operationId:r.operationId,journalId:this.journalId,sequence:r.sequence-1,digest:r.proposalDigest};this.addCheckpoint(this.lastCheckpoint,this.pending.operation);this.applyAtoms(this.pending.atoms);this.pending=undefined;
        }
        else if(r.kind==='observation'){
          if(this.pending||!this.control||!this.lastCheckpoint||r.operationId!==r.observation.operationId||JSON.stringify(r.observation.checkpoint)!==JSON.stringify(this.lastCheckpoint)||!sameFinancialDatabase(r.observation.database,this.control.database))throw new Error('Financial observation mismatch');
        }
        else if(r.kind==='abort'){if(!this.pending||this.pending.id!==r.operationId||(this.pending.proposal??null)!==r.proposalDigest)throw new Error('Journal abort mismatch');this.pending=undefined;}
        else throw new Error('Repeated journal genesis');
        this.sequence++;this.head=frame.digest;
      }
      if(next&&!sealed)throw new Error('Journal book not sealed');
      if(last){sealedTail=sealed;this.size=raw.length;this.bookRecords=lines.length;}
      raw=next;
    }
    if(!genesis)throw new Error('Missing genesis');
    // A partial next book is only ever left by a crash between sealing and opening it.
    if(hasPartial&&!sealedTail)throw new Error('Unexpected journal file');
    this.summariseFinished(Date.now());
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
    if(prepared&&!this.preparationComplete||this.pending||writer||sealedTail||this.control&&JSON.stringify(this.control.checkpoint)!==JSON.stringify(this.lastCheckpoint)){
      if(!prepared)throw new Error('Uncompleted financial operation or writer');
      // A keeper keeps starting with a frozen journal, so each start must not add a record.
      if(!this.frozen)this.persistFreeze('uncertain');
    }
  }
  /** The in-process barrier precedes pool checkout. Kernel ownership spans this object's
   * entire life. One operation runs at a time: contention refuses, unless the caller asks to wait
   * in line for a bounded time. The turn passes on when an operation ends, nothing overtakes the
   * line and no holder is ever displaced. A wait that runs out has done no work and written nothing. */
  async operation<T>(kind:BudgetFinancialOperation,work:(operationId:string)=>Promise<T>,wait?:FinancialTurnWait):Promise<T> {
    if(this.unavailable)throw new Error('Financial journal is closed or busy');
    if(!this.busy&&!this.line.length)return this.startOperation(kind,work);
    if(!wait)throw new FinancialJournalBusy();
    return new Promise<T>((resolve,reject)=>this.joinLine(wait,()=>{this.startOperation(kind,work).then(resolve,reject);},reject));
  }
  private get unavailable():boolean{return this.closed||this.frozen||this.stopping||!this.writerLease;}
  private joinLine(wait:FinancialTurnWait,start:()=>void,refuse:(error:Error)=>void):void {
    const first=wait.first===true;
    const turn:WaitingTurn={first,start,refuse,timer:setTimeout(()=>{this.line.splice(this.line.indexOf(turn),1);refuse(new FinancialJournalBusy());},wait.ms)};
    const ahead=first?this.line.findIndex(other=>!other.first):-1;
    if(ahead<0)this.line.push(turn);else this.line.splice(ahead,0,turn);
  }
  /** Starts synchronously, so the barrier is taken again before anything else can run. */
  private nextInLine():void {
    while(this.line.length&&!this.busy){
      const turn=this.line.shift()!;clearTimeout(turn.timer);
      if(this.unavailable)turn.refuse(new Error('Financial journal is closed or busy'));else turn.start();
    }
  }
  private refuseLine():void {
    for(const turn of this.line.splice(0)){clearTimeout(turn.timer);turn.refuse(new Error('Financial journal is closed or busy'));}
  }
  private async startOperation<T>(kind:BudgetFinancialOperation,work:(operationId:string)=>Promise<T>):Promise<T> {
    // Reserve begin, maximum proposal, terminal and writer-close BEFORE any database
    // work. Capacity exhaustion leaves this writer able to close cleanly.
    this.ensureRoom(this.control?6:4,JOURNAL_MAX_RECORD_BYTES+5*CONTROL_RECORD_BYTES);
    this.busy=true;this.pendingAbortReceipt=undefined;const operationId=randomUUID();this.activeOperationId=operationId;
    try{
      this.append({kind:'begin',operation:operation.parse(kind)},operationId);this.pending={id:operationId,operation:kind};
      const result=await work(operationId);
      if(this.pending||this.frozen)throw new Error('Financial operation did not durably finish');
      return result;
    }
    catch(error){
      if(error&&typeof error==='object'){
        const previous=currentAbortFailures.get(error);if(previous){const proof=durableAbortReceipts.get(previous);if(proof)proof.finished=false;}
        currentAbortFailures.delete(error);journaledAborts.delete(error);
      }
      if(this.pending)this.frozen=true;if(this.pendingAbortReceipt){const proof=durableAbortReceipts.get(this.pendingAbortReceipt);if(proof){proof.failure=error;if(error&&typeof error==='object')currentAbortFailures.set(error,this.pendingAbortReceipt);}}throw error;
    }
    finally{this.busy=false;this.activeOperationId=undefined;if(this.pending)this.frozen=true;if(this.pendingAbortReceipt){const proof=durableAbortReceipts.get(this.pendingAbortReceipt);if(proof)proof.finished=!this.pending&&!this.frozen;this.pendingAbortReceipt=undefined;}for(const resolve of this.idle)resolve();this.idle.clear();this.nextInLine();}
  }
  propose(operationId:string,atoms:readonly FinancialAtom[]):FinancialJournalProposal {
    if(this.pending?.id!==operationId||this.pending.proposal)throw new Error('Financial proposal unavailable');
    financialProposalFrame(operationId,this.sequence,this.head,atoms);
    const checked=atoms.map(atom=>FINANCIAL_ATOM_SCHEMA.parse(atom));
    assertUniqueFinancialAtoms(checked);
    const frame=this.append({kind:'proposal',atoms:checked},operationId);this.pending.proposal=frame.digest;this.pending.atoms=structuredClone(checked);
    return {journalId:this.journalId,operationId,sequence:frame.sequence,digest:frame.digest};
  }
  validateProposal(operationId:string,atoms:readonly FinancialAtom[]):void {
    if(this.pending?.id!==operationId||this.pending.proposal)throw new Error('Financial proposal unavailable');
    financialProposalFrame(operationId,this.sequence,this.head,atoms);
  }
  /** Fixed preflight for the cleanup-only operation. Call inside its owned SQL
   * transaction after started() has verified the complete source projection. */
  validateNativeCleanupRecoveryProjection(operationId:string,binding:BindingAtom):void {
    if(this.pending?.id!==operationId||this.pending.operation!=='native-cleanup-recovery'||this.pending.proposal||!this.control||!this.preparationComplete||!nativeCleanupProjectionCovers([...this.projection.values()],binding))throw new Error('Native cleanup recovery unavailable');
  }
  committed(operationId:string):CommittedFinancialReceipt|undefined {
    if(this.pending?.id!==operationId||!this.pending.proposal||!this.pending.operation||!this.pending.atoms)throw new Error('Financial proposal unavailable');
    const proposal=this.pending.proposal,sequence=this.sequence-1,kind=this.pending.operation,atoms=this.pending.atoms;
    this.append({kind:'commit',proposalDigest:proposal},operationId);this.pending=undefined;
    this.lastCheckpoint={operationId,journalId:this.journalId,sequence,digest:proposal};this.addCheckpoint(this.lastCheckpoint,kind);this.applyAtoms(atoms);
    if(this.control){this.control={...this.control,checkpoint:this.lastCheckpoint};this.append({kind:'control',control:this.control},this.writerId);}
    // Generic unprepared histories retain their existing commit behavior, but have no
    // database-bound control and cannot mint authority for native custody cleanup.
    if(!this.control)return undefined;
    const evidence=Object.freeze({journalId:this.journalId,operationId,operation:kind,proposalSequence:sequence,proposalDigest:proposal});
    const receipt=evidence as CommittedFinancialReceipt;committedReceipts.set(receipt,{evidence,atoms});return receipt;
  }
  /** Commit source-observed evidence only after terminal and control records are fsynced. */
  committedObserved(operationId:string,handle:FinancialObservationHandle):CommittedFinancialReceipt|undefined {
    const verified=consumeFinancialObservationHandle(this,operationId,handle),commit=verified.commit,raw=verified.observation;
    consumeSourceObservationCommit(commit,operationId);
    const observation=FINANCIAL_OBSERVATION_SCHEMA.parse(raw),pending=this.pending;
    if(!pending?.proposal||pending.id!==operationId||!this.control||observation.operationId!==operationId||observation.checkpoint.operationId!==operationId||
      observation.checkpoint.journalId!==this.journalId||observation.checkpoint.sequence!==this.sequence-1||observation.checkpoint.digest!==pending.proposal||
      !sameFinancialDatabase(observation.database,this.control.database))throw new Error('Financial observation unavailable');
    const priorProjection=pending.operation==='provision'?freezeFinancialAtoms(this.expectedProjection(false).atoms):undefined;
    const projection=this.expectedProjection(true);
    if(JSON.stringify(projection.counts)!==JSON.stringify(observation.counts)||observation.checkpointDigest!==digest(gatewayCanonical(projection.checkpoints))||
      observation.projectionDigest!==digest(gatewayCanonical({checkpoints:projection.checkpoints,atoms:projection.atoms})))throw new Error('Financial observation unavailable');
    const receipt=this.committed(operationId);if(!receipt)return undefined;
    this.append({kind:'observation',observation},operationId);
    const saved=committedReceipts.get(receipt);
    if(saved?.evidence.operation==='native-cleanup-recovery'||saved?.evidence.operation==='native-activation')saved.observedProjection=freezeFinancialAtoms(projection.atoms);
    if(saved?.evidence.operation==='provision'){saved.priorProjection=priorProjection;saved.observedProjection=freezeFinancialAtoms(projection.atoms);}
    const proof:PublicationProof={journal:this,operationId,receipt,used:false,active:false};publicationProofs.set(receipt,proof);
    return receipt;
  }
  /** Opens one synchronous native publication batch for this exact current operation. */
  withPublicationProof<T>(receipt:CommittedFinancialReceipt,publish:(receipt:CommittedFinancialReceipt)=>T):T {
    const proof=receipt&&typeof receipt==='object'?publicationProofs.get(receipt):undefined;
    if(!proof||proof.journal!==this||proof.receipt!==receipt||proof.used||!this.publicationProofIsCurrent(proof.operationId)||activePublicationProof)throw new Error('Current financial publication proof unavailable');
    proof.used=true;
    if(publish.constructor?.name==='AsyncFunction'){proof.active=false;try{this.persistFreeze('uncertain');}catch{}throw new Error('Financial publication must be synchronous');}
    proof.active=true;activePublicationProof=proof;
    try{
      const result=publish(receipt);
      if(result&&typeof (result as {then?:unknown}).then==='function'){
        void Promise.resolve(result).catch(()=>undefined);throw new Error('Financial publication must be synchronous');
      }
      if(result!==undefined)throw new Error('Financial publication must not return a value');
      return result;
    }catch(error){try{this.persistFreeze('uncertain');}catch{}throw error;}
    finally{proof.active=false;if(activePublicationProof===proof)activePublicationProof=undefined;}
  }
  /** Rechecked by each native mutation so a callback cannot freeze or close custody
   * and then continue publishing under a stale batch capability. */
  publicationProofIsCurrent(operationId:string):boolean {
    return !this.closed&&!this.frozen&&!this.stopping&&this.busy&&this.activeOperationId===operationId;
  }
  aborted(operationId:string,reason:FinancialAbortOutcome):DurableFinancialAbortReceipt|undefined {
    if(this.pending?.id!==operationId||!this.pending.operation)throw new Error('Financial operation unavailable');
    const kind=this.pending.operation,frame=this.append({kind:'abort',proposalDigest:this.pending.proposal??null,reason},operationId);this.pending=undefined;
    if(!this.control)return undefined;
    const receipt=Object.freeze({journalId:this.journalId,operationId,operation:kind,outcome:reason,terminalSequence:frame.sequence,terminalDigest:frame.digest}) as DurableFinancialAbortReceipt;
    durableAbortReceipts.set(receipt,{finished:false});this.pendingAbortReceipt=receipt;return receipt;
  }
  freeze():void {this.persistFreeze('uncertain');}
  private applyAtoms(atoms:readonly FinancialAtom[]):void {
    for(const atom of atoms){
      const key=financialAtomKey(atom),summary=this.summarised.get(key);
      if(summary){this.summarised.delete(key);if(atom.kind==='attempt')this.summarisedAttempts--;else if(atom.kind==='grant')this.summarisedGrants--;}
      if(atom.kind==='attempt'){
        const before=summary?.money??this.projection.get(key) as AttemptAtom|undefined;
        if(before)this.adjustWindowTotals(before,-1);
        this.adjustWindowTotals(atom,1);
        if(atom.state==='settled'||atom.state==='retired')this.finishedWaiting++;
      }
      this.projection.set(key,atom);
    }
    if(this.finishedWaiting>=FOLD_SUMMARISE_AT)this.summariseFinished();
  }
  private adjustWindowTotals(attempt:AttemptMoney,sign:1|-1):void {
    for(const window of [attempt.installationWindowId,attempt.memberWindowId]){
      const states=this.windowTotals.get(window)??new Map(),total=states.get(attempt.state)??{count:0,reserved:0n,actual:0n,high:0n},units=BigInt(sign);
      total.count+=sign;total.reserved+=units*moneyUnits(attempt.reservedAmount);total.actual+=units*moneyUnits(attempt.actualAmount??'0');total.high+=units*moneyUnits(attempt.highestObservedLiability);
      if(total.count===0)states.delete(attempt.state);else states.set(attempt.state,total);
      if(states.size)this.windowTotals.set(window,states);else this.windowTotals.delete(window);
    }
  }
  /** Settled and retired attempts cannot usually change again, so each step stops re-reading them.
   * With `now`, prepared attempts past their expiry follow. If one is proposed again it simply
   * returns to the compared rows; the whole-ledger check still covers every summarised row. */
  private summariseFinished(now?:number):void {
    for(const [key,atom] of this.projection){
      if(atom.kind!=='attempt')continue;
      if(!(atom.state==='settled'||atom.state==='retired'||now!==undefined&&atom.state==='prepared'&&Date.parse(atom.expiresAt)<now))continue;
      this.summarised.set(key,{digest:digest(gatewayCanonical(atom)),money:{installationWindowId:atom.installationWindowId,memberWindowId:atom.memberWindowId,state:atom.state,reservedAmount:atom.reservedAmount,actualAmount:atom.actualAmount,highestObservedLiability:atom.highestObservedLiability}});
      this.projection.delete(key);this.summarisedAttempts++;
      const grantKey=`grant:${atom.id}`,grant=this.projection.get(grantKey);
      if(grant){this.summarised.set(grantKey,{digest:digest(gatewayCanonical(grant))});this.projection.delete(grantKey);this.summarisedGrants++;}
    }
    this.finishedWaiting=0;
  }
  private addCheckpoint(checkpoint:FinancialCheckpoint,operation:BudgetFinancialOperation|undefined):void {
    this.checkpoints.push(checkpoint);this.checkpointCount++;this.checkpointDigest=financialCheckpointRolling(this.checkpointDigest,checkpoint);
    if(!operation||!GATEWAY_OPERATIONS.has(operation))this.retainedCheckpoints.add(checkpoint.sequence);
    if(this.checkpoints.length>this.retainedCheckpoints.size+2*FOLD_CHECKPOINT_TAIL){
      const oldestTail=this.checkpoints[this.checkpoints.length-FOLD_CHECKPOINT_TAIL]!.sequence;
      this.checkpoints=this.checkpoints.filter(row=>row.sequence>=oldestTail||this.retainedCheckpoints.has(row.sequence));
    }
  }
  /** Snapshot only the committed fold, with the exact active proposal optionally overlaid
   * for the writer's pre-COMMIT observation. Callers cannot select a pending operation. */
  expectedProjection(proposed=false):FinancialProjection {
    if(this.closed||this.frozen||!this.control)throw new Error('Financial continuity requires recovery');
    const checkpoints=this.checkpoints.map(checkpoint=>({...checkpoint})),live=[...this.projection.values()].map(atom=>structuredClone(atom));
    let atoms=live,resurfaced={attempts:0,grants:0},checkpointCount=this.checkpointCount;
    if(proposed){
      if(!this.busy||!this.pending?.proposal||!this.pending.atoms)throw new Error('Financial proposal unavailable');
      checkpoints.push({operationId:this.pending.id,journalId:this.journalId,sequence:this.sequence-1,digest:this.pending.proposal});checkpointCount++;
      const overlay=new Map(live.map(atom=>[financialAtomKey(atom),atom]));
      for(const atom of this.pending.atoms){
        const key=financialAtomKey(atom);overlay.set(key,structuredClone(atom));
        if(this.summarised.has(key)){if(atom.kind==='attempt')resurfaced.attempts++;else if(atom.kind==='grant')resurfaced.grants++;}
      }
      atoms=[...overlay.values()];
    }
    const sorted=atoms.sort((left,right)=>financialAtomKey(left).localeCompare(financialAtomKey(right))),count=(kind:FinancialAtom['kind'])=>sorted.filter(atom=>atom.kind===kind).length;
    const counts:FinancialCounts={accounts:count('account'),windows:count('window'),bindings:count('binding'),attempts:count('attempt')+this.summarisedAttempts-resurfaced.attempts,grants:count('grant')+this.summarisedGrants-resurfaced.grants,checkpoints:checkpointCount};
    return {checkpoints,atoms:sorted,counts,...(!proposed&&this.summarisedAttempts?{windowTotals:this.currentWindowTotals(sorted)}:{})};
  }
  private currentWindowTotals(atoms:readonly FinancialAtom[]):NonNullable<FinancialProjection['windowTotals']> {
    const accounts=atoms.filter((atom):atom is Extract<FinancialAtom,{kind:'account'}>=>atom.kind==='account'&&atom.activeWindowId!==null);
    const windowIds=[...new Set(accounts.map(account=>account.activeWindowId!))].sort(),totals:FinancialWindowTotal[]=[];
    for(const windowId of windowIds)for(const [state,total] of [...(this.windowTotals.get(windowId)??new Map<string,{count:number;reserved:bigint;actual:bigint;high:bigint}>())].sort(([left],[right])=>left.localeCompare(right)))
      totals.push({windowId,state,count:total.count,reserved:moneyText(total.reserved),actual:moneyText(total.actual),high:moneyText(total.high)});
    return {accountIds:accounts.map(account=>account.id),windowIds,totals};
  }
  /** The whole-ledger check, at keeper start and overnight. Each row is compared to what was
   * recorded for it, without keeping finished rows in memory. */
  fullLedgerExpectation():{counts:FinancialCounts;checkpointDigest:string;matches:(atom:FinancialAtom)=>boolean} {
    const {counts}=this.expectedProjection(false);
    return {counts,checkpointDigest:this.checkpointDigest,matches:atom=>{
      const key=financialAtomKey(atom),live=this.projection.get(key),bytes=gatewayCanonical(atom);
      return live?gatewayCanonical(live).equals(bytes):this.summarised.get(key)?.digest===digest(bytes);
    }};
  }
  databaseMatches(database:FinancialDatabase):boolean {
    return !!this.control&&sameFinancialDatabase(FINANCIAL_DATABASE_SCHEMA.parse(database),this.control.database);
  }
  /** A passed whole-ledger check at startup is what allows this writer to take its lease. */
  acceptFullContinuity():void {if(this.startupLeasePending)this.startupContinuityVerified=true;}
  freezeForContinuity():void {this.persistFreeze('continuity');}
  /** Holds the same barrier as a financial operation, so no row can change during the check. It
   * never overtakes operations waiting in line, and passes the turn on when it ends. */
  async withFullCheckBarrier<T>(work:()=>Promise<T>):Promise<T> {
    if(this.unavailable)throw new Error('Financial journal is closed or busy');
    if(this.busy||this.line.length)throw new FinancialJournalBusy();
    this.busy=true;
    try{return await work();}
    finally{this.busy=false;for(const resolve of this.idle)resolve();this.idle.clear();this.nextInLine();}
  }
  /** Observe a persisted ticket against this prepared journal's committed installation
   * fold. This is discovery only: the owned admission transaction still rechecks the
   * complete database projection, account policy and current window before mutation. */
  observeGatewayRecoveryReference(raw:Pick<BudgetRecoveryReference,'installationAccountId'|'epoch'|'endpointGeneration'>):BudgetRecoveryReference|undefined {
    if(this.busy||this.pending)return undefined;
    return this.committedRecoveryReference(raw);
  }
  /** The same observation for the gateway's admission path, while another operation may be
   * running. It reads only the committed fold, never a pending proposal, so a change committed a
   * moment later is simply missed here. Admit then takes its own turn, verifies the database against
   * the fold, and compares this reference with the current row under lock, which refuses. */
  observeCommittedGatewayRecoveryReference(raw:Pick<BudgetRecoveryReference,'installationAccountId'|'epoch'|'endpointGeneration'>):BudgetRecoveryReference|undefined {
    return this.committedRecoveryReference(raw);
  }
  private committedRecoveryReference(raw:Pick<BudgetRecoveryReference,'installationAccountId'|'epoch'|'endpointGeneration'>):BudgetRecoveryReference|undefined {
    if(this.closed||this.frozen||this.stopping||!this.preparationComplete||!this.control)return undefined;
    let reference:ReturnType<typeof gatewayRecoveryReferenceSchema.parse>;
    try{reference=gatewayRecoveryReferenceSchema.parse(raw);}catch{return undefined;}
    const account=this.projection.get(`account:${reference.installationAccountId}`);
    if(!account||account.kind!=='account'||account.accountKind!=='installation'||account.id!==reference.installationAccountId||
      account.installationAccountId!==account.id||account.state!=='open'||account.reason!=='approved'||account.installationCap===null||
      account.selectedEndpointHash===null||account.endpointGeneration!==reference.endpointGeneration||
      account.recoveryEpochHash!==digest(Buffer.from(reference.epoch,'utf8'))||account.activeWindowId===null)return undefined;
    const window=this.projection.get(`window:${account.activeWindowId}`);
    if(!window||window.kind!=='window'||window.id!==account.activeWindowId||window.accountId!==account.id||
      window.openingCap!==account.installationCap||Date.parse(window.startsAt)>=Date.parse(window.endsAt))return undefined;
    return Object.freeze({installationAccountId:account.id,epoch:reference.epoch,endpointGeneration:account.endpointGeneration,state:'reconciled'});
  }
  /** Startup, transaction-start and pre-COMMIT all compare the complete redacted fold.
   * A match never clears a previously durable freeze. */
  verifyContinuity(database:FinancialDatabase,checkpoints:readonly FinancialCheckpoint[],atoms:readonly FinancialAtom[],proposed=false):void {
    let expected:FinancialProjection|undefined,actualCheckpoints:FinancialCheckpoint[]|undefined,actualAtoms:FinancialAtom[]|undefined;
    try{
      expected=this.expectedProjection(proposed);
      actualCheckpoints=checkpoints.map(checkpoint=>FINANCIAL_CHECKPOINT_SCHEMA.parse(checkpoint));
      actualAtoms=atoms.map(atom=>FINANCIAL_ATOM_SCHEMA.parse(atom));
    }catch{this.persistFreeze('continuity');throw new Error('Financial continuity requires recovery');}
    const expectedSqlAtoms=expected.atoms.filter(atom=>atom.kind!=='tombstone');
    if(this.closed||this.frozen||!this.control||!sameFinancialDatabase(FINANCIAL_DATABASE_SCHEMA.parse(database),this.control.database)||!gatewayCanonical(actualCheckpoints).equals(gatewayCanonical(expected.checkpoints))||!gatewayCanonical(actualAtoms).equals(gatewayCanonical(expectedSqlAtoms))){
      this.persistFreeze('continuity');throw new Error('Financial continuity requires recovery');
    }
    if(this.startupLeasePending)this.startupContinuityVerified=true;
  }
  get prepared():boolean{return this.control!==undefined;}
  get isFrozen():boolean{return this.frozen;}
  /** True from a startup open until the writer lease is published. Nothing has run yet. */
  get awaitingStartupVerification():boolean{return this.startupLeasePending;}
  get id():string{return this.journalId;}
  async drainForShutdown():Promise<void>{
    this.stopping=true;this.refuseLine();
    if(this.busy)await new Promise<void>(resolve=>{this.idle.add(resolve);});
  }
  async freezeForRestore(timeoutMs=2000):Promise<void>{
    // A keeper running with a journal frozen at startup never takes a lease; restore still needs this.
    if(this.startupLeasePending&&!this.frozen)throw new Error('Financial writer lease unavailable');
    if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000)throw new Error('Invalid freeze deadline');
    this.stopping=true;this.refuseLine(); // synchronous: no new operation can cross the barrier
    if(this.busy){let timer:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([new Promise<void>(resolve=>{this.idle.add(resolve);}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Financial operation did not drain')),timeoutMs);})]);}
      finally{if(timer)clearTimeout(timer);}
    }
    this.persistFreeze('restore');
  }
  private persistFreeze(reason:'restore'|'continuity'|'uncertain'):void {
    if(this.closed)throw new Error('Financial custody unavailable');
    // The open book is sealed and its successor is unusable. Nothing more may be written, and
    // the writer lease left open makes the next start freeze durably.
    if(this.sealedAway){this.frozen=true;return;}
    const busy=this.busy;this.busy=true;
    try{this.append({kind:'freeze',reason},this.writerId,true);this.frozen=true;}
    finally{this.busy=busy;this.frozen=true;}
  }
  suppression(identity:Parameters<typeof budgetIdentitySuppression>[1]):ReturnType<typeof budgetIdentitySuppression> {
    if(this.closed||this.frozen)throw new Error('Financial custody unavailable');return budgetIdentitySuppression(this.#key,identity);
  }
  close():void {
    if(this.closed)return;if(this.busy)throw new Error('Financial operation still owns the barrier');
    try{if(this.writerLease&&!this.frozen){this.busy=true;this.append({kind:'writer-close'},this.writerId);}}
    finally{this.busy=false;this.closed=true;this.#key.fill(0);closeSync(this.journalFd);closeSync(this.lockFd);closeSync(this.directoryFd);closeSync(this.keyFd);}
  }
  private hasCapacity(records:number,bytes:number):boolean {
    return this.bookRecords+records<=JOURNAL_MAX_RECORDS&&this.size+bytes<=this.maxBookBytes;
  }
  private requireCapacity(records:number,bytes:number):void {
    if(!this.hasCapacity(records,bytes))throw new Error('Financial journal capacity unavailable');
  }
  /** Runs only with no operation in progress. Prepared custody moves to its next book; an
   * unprepared foundation has no database binding to carry and keeps its fixed capacity. */
  private ensureRoom(records:number,bytes:number):void {
    if(!this.hasCapacity(records,bytes)&&this.control&&this.preparationComplete&&!this.pending){
      const busy=this.busy;this.busy=true;
      try{this.openNextBook();}finally{this.busy=busy;}
    }
    this.requireCapacity(records,bytes);
  }
  /** Seals this book and opens the next one with its whole-file fingerprint in the first record,
   * continuing the same chain and sequence. Nothing is rewritten or removed. */
  private openNextBook():void {
    // Refused before the first byte, without a freeze: freeing disk space is enough to carry on.
    if(this.freeBytes(this.directory)<2*this.maxBookBytes)throw new Error('Financial journal capacity unavailable');
    const next=this.book+1,name=bookName(next),partial=name.replace(/\.jsonl$/,'.partial');let renamed=false;
    try{
      if(existsSync(join(this.directory,name))||existsSync(join(this.directory,partial)))throw new Error('Financial custody changed');
      this.append({kind:'book-seal',book:this.book},this.writerId);
      const sealed=Buffer.alloc(this.size);let read=0;while(read<sealed.length){const n=readSync(this.journalFd,sealed,read,sealed.length-read,read);if(n<1)throw new Error('Financial journal changed');read+=n;}
      const frame=financialJournalFrame({version:1,sequence:this.sequence,operationId:this.writerId,previousDigest:this.head,kind:'book-open',journalId:this.journalId,book:next,sealedBookDigest:digest(sealed),sealedBookBytes:sealed.length});
      const created=openSync(join(this.directory,partial),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try{let offset=0;while(offset<frame.bytes.length){const n=writeSync(created,frame.bytes,offset,frame.bytes.length-offset);if(n<1)throw new Error('Incomplete financial append');offset+=n;}this.sync(created);}finally{closeSync(created);}
      renameSync(join(this.directory,partial),join(this.directory,name));renamed=true;this.sync(this.directoryFd);
      const fd=protectedFile(join(this.directory,name),this.uid,constants.O_RDWR|constants.O_APPEND);
      closeSync(this.journalFd);this.journalFd=fd;this.book=next;this.size=frame.bytes.length;this.bookRecords=1;this.sequence++;this.head=frame.digest;
    }catch{
      // Once the next book exists the sealed one can take no more bytes, or its fingerprint would
      // stop matching. This writer's lease is still open there, so the next start freezes durably.
      if(renamed){this.frozen=true;this.sealedAway=true;}
      else try{this.persistFreeze('uncertain');}catch{/* Already marked frozen in memory. */}
      throw new Error('Financial journal write unavailable; recovery is required');
    }
    this.summariseFinished(Date.now());
  }
  private append(body:Record<string,unknown>,operationId:string,allowFrozen=false):{sequence:number;digest:string} {
    try{
      if(this.closed||this.frozen&&!allowFrozen||!this.busy)throw new Error('Financial journal unavailable');
      verifyDirectory(this.directory,this.uid);
      for(const [name,fd] of [[bookName(this.book),this.journalFd],['writer.lock',this.lockFd],['suppression.key',this.keyFd]] as const){const a=fstatSync(fd),b=lstatSync(join(this.directory,name));if(a.ino!==b.ino||a.dev!==b.dev||!b.isFile()||b.nlink!==1||b.uid!==this.uid||(b.mode&0o777)!==0o600)throw new Error('Financial custody changed');}
      const currentKey=Buffer.alloc(32);if(fstatSync(this.keyFd).size!==32||readSync(this.keyFd,currentKey,0,32,0)!==32||digest(currentKey)!==digest(this.#key))throw new Error('Financial key custody changed');currentKey.fill(0);
      if(fstatSync(this.journalFd).size!==this.size)throw new Error('Financial journal changed');
      const sequence=this.sequence,record=FINANCIAL_JOURNAL_RECORD_SCHEMA.parse({version:1,sequence,operationId,previousDigest:this.head,...body}),frame=financialJournalFrame(record);
      if(record.kind!=='proposal'&&frame.bytes.length>CONTROL_RECORD_BYTES)throw new Error('Financial control record limit');
      if(record.kind==='book-seal'||record.kind==='freeze'){
        if(this.size+frame.bytes.length>this.maxBookBytes+BOOK_CLOSING_RECORDS*CONTROL_RECORD_BYTES||this.bookRecords+1>JOURNAL_MAX_RECORDS+BOOK_CLOSING_RECORDS)throw new Error('Financial journal capacity unavailable');
      }else this.requireCapacity(1,frame.bytes.length);
      let offset=0;while(offset<frame.bytes.length){const written=writeSync(this.journalFd,frame.bytes,offset,frame.bytes.length-offset);if(written<1)throw new Error('Incomplete financial append');offset+=written;}
      this.sync(this.journalFd);this.size+=frame.bytes.length;this.bookRecords++;this.sequence++;this.head=frame.digest;return {sequence,digest:frame.digest};
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
