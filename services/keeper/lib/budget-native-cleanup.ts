import {closeSync,constants,fstatSync,lstatSync,openSync,readSync} from 'node:fs';
import type {CommittedFinancialReceipt} from './financial-journal.js';
import {BudgetNativeCredentialClient,type NativeHashRead,type NativeWrite} from './budget-native-client.js';
import {BudgetNativeCustodyStore,NATIVE_CUSTODY_DIRECTORY,type NativeAbsenceRequest,type NativeCleanupReceipt,type NativeCustodyGate,type NativeOperation} from './budget-native-custody.js';

export interface NativeCleanupStatus {status:'complete'|'pending'|'blocked';remaining:number|null}
type PendingRow=NativeOperation|NativeCleanupReceipt;
const pendingRows=(gate:NativeCustodyGate):PendingRow[]=>gate.inventory().operations.filter((row):row is PendingRow=>
  row.kind==='operation'&&row.phase==='revoke-pending'&&row.nativeDeletion==='unverified'||
  row.kind==='cleanup'&&row.phase==='revoke-pending'&&row.nativeDeletion==='unverified');

/** Opens configured native custody or proves the legacy path has no unbound store. */
export function openConfiguredNativeCustody(directory:string|undefined):BudgetNativeCustodyStore|undefined {
  if(directory)return BudgetNativeCustodyStore.openExisting(directory);
  try{lstatSync(NATIVE_CUSTODY_DIRECTORY);throw new Error('Unbound native custody requires recovery');}
  catch(error){if(error instanceof Error&&error.message==='Unbound native custody requires recovery')throw error;if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('Native custody unavailable; explicit recovery is required');}
  return undefined;
}

/** After PostgreSQL has committed, make every affected native credential locally unusable.
 * This is local custody work only; it never calls the gateway or deletes a shared team/user. */
export function recordCommittedNativeRetirement(gate:NativeCustodyGate,accountIds:readonly string[],receipt:CommittedFinancialReceipt,erased:boolean):NativeCleanupStatus {
  const operations=new Map<string,NativeOperation>();
  for(const accountId of accountIds)for(const operation of gate.accountOperations(accountId))operations.set(operation.operationId,operation);
  const fingerprints=new Set([...operations.values()].map(operation=>operation.keyFingerprint));
  for(const operation of operations.values()){
    if(operation.phase==='revoked'&&operation.nativeDeletion==='verified')continue;
    const priorErasureRevocation=erased&&operation.phase==='revoke-pending'&&operation.revocationReceipt!==null&&operation.revocationReceipt!==undefined&&operation.revocationReceipt.journalId===receipt.journalId;
    if(!priorErasureRevocation)gate.recordRevocation(operation.operationId,receipt);
    gate.removePlaintext(operation.operationId);
  }
  if(erased)for(const accountId of accountIds)gate.eraseAccountAssociation(accountId,receipt);
  const left=pendingRows(gate).filter(row=>fingerprints.has(row.keyFingerprint)).length;
  return {status:left===0?'complete':'pending',remaining:left};
}

function trustedOrigin(gatewayUrl:string|undefined):string|undefined {
  if(!gatewayUrl)return undefined;
  try{const url=new URL(gatewayUrl);return ['http:','https:'].includes(url.protocol)&&url.origin!=='null'&&url.pathname==='/'&&!url.search&&!url.hash&&!url.username&&!url.password?url.origin:undefined;}catch{return undefined;}
}
function outcome(read:NativeHashRead):'absent'|'present'|'pending'|'blocked' {
  if(read.kind==='absent')return 'absent';
  if(read.kind==='present')return 'present';
  if(read.kind==='refused'||read.kind==='malformed')return 'blocked';
  return 'pending';
}
function writeOutcome(write:NativeWrite):'acknowledged'|'pending'|'blocked' {
  if(write.kind==='acknowledged')return 'acknowledged';
  if(write.kind==='refused'||write.kind==='malformed')return 'blocked';
  return 'pending';
}

/** Read only a small protected host secret without following links or trusting a stale path stat. */
function readProtectedMasterKey(path:string):string {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let bytes:Buffer|undefined;
  try{
    const protectedFile=(stat:ReturnType<typeof fstatSync>)=>{
      const mode=Number(stat.mode)&0o777;
      return stat.isFile()&&stat.nlink===1&&stat.uid===0&&stat.size>=1&&stat.size<=8192&&
        (mode===0o600&&stat.gid===0||mode===0o440&&stat.gid===10001);
    };
    const before=fstatSync(fd);
    if(!protectedFile(before))throw new Error('unavailable');
    bytes=Buffer.alloc(8193);let length=0;
    while(length<bytes.length){const count=readSync(fd,bytes,length,bytes.length-length,null);if(count===0)break;length+=count;}
    const after=fstatSync(fd),visible=lstatSync(path);
    if(length>8192||!protectedFile(after)||!protectedFile(visible)||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||
      before.dev!==visible.dev||before.ino!==visible.ino)throw new Error('unavailable');
    return bytes.subarray(0,length).toString('utf8').trimEnd();
  }finally{bytes?.fill(0);closeSync(fd);}
}

/** One bounded, explicit cleanup attempt. The persisted origin must match current trusted
 * configuration before the master-key file is read. At most one credential is touched. */
export async function cleanupOneNativeCredential(gate:NativeCustodyGate,options:{gatewayUrl:string|undefined;masterKeyFile:string|undefined}):Promise<NativeCleanupStatus> {
  const rows=pendingRows(gate),remaining=rows.length;
  if(!remaining)return {status:'complete',remaining:0};
  const row=rows[0]!,erased=row.kind==='cleanup';
  let request:NativeAbsenceRequest;
  try{request=erased?gate.prepareErasedNativeAbsence(row.keyFingerprint):gate.prepareNativeAbsence(row.operationId);}catch{return {status:'blocked',remaining};}
  const origin=trustedOrigin(options.gatewayUrl);
  if(!origin||origin!==request.origin||!options.masterKeyFile)return {status:'blocked',remaining};

  // Do not read the credential until the exact persisted native origin has passed the check.
  let key:string;
  try{key=readProtectedMasterKey(options.masterKeyFile);}catch{return {status:'blocked',remaining};}
  let client:BudgetNativeCredentialClient;
  try{client=new BudgetNativeCredentialClient(origin,key);}catch{return {status:'blocked',remaining};}
  const proveAbsent=async():Promise<NativeCleanupStatus>=>{
    let check:NativeHashRead;
    try{check=await client.lookupKeyHashOnly(request.fingerprint,request.challenge);}catch{return {status:'pending',remaining};}
    if(check.kind==='absent'){
      try{erased?gate.recordErasedNativeAbsence(row.keyFingerprint,check.receipt):gate.recordNativeAbsence(row.operationId,check.receipt);}catch{return {status:'blocked',remaining};}
      const after=pendingRows(gate).length;
      return {status:after===0?'complete':'pending',remaining:after};
    }
    const checked=outcome(check);
    return {status:checked==='blocked'?'blocked':'pending',remaining};
  };

  let first:NativeHashRead;
  try{first=await client.lookupKeyHashOnly(request.fingerprint,request.challenge);}catch{return {status:'pending',remaining};}
  const firstOutcome=outcome(first);
  if(first.kind==='absent'){
    try{erased?gate.recordErasedNativeAbsence(row.keyFingerprint,first.receipt):gate.recordNativeAbsence(row.operationId,first.receipt);}catch{return {status:'blocked',remaining};}
    const after=pendingRows(gate).length;
    return {status:after===0?'complete':'pending',remaining:after};
  }
  if(firstOutcome==='blocked')return {status:'blocked',remaining};
  if(firstOutcome!=='present')return {status:'pending',remaining};

  let deleted:NativeWrite;
  try{deleted=await client.deleteKey(request.fingerprint);}catch{return {status:'pending',remaining};}
  const deletion=writeOutcome(deleted);
  if(deletion!=='acknowledged')return {status:deletion==='blocked'?'blocked':'pending',remaining};

  // A delete ACK is not proof of absence; a new challenge and exact hash-only read are required.
  try{request=erased?gate.prepareErasedNativeAbsence(row.keyFingerprint):gate.prepareNativeAbsence(row.operationId);}catch{return {status:'blocked',remaining};}
  return proveAbsent();
}
