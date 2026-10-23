/** Unregistered storage for third-party bearer credentials. It has no network or model API. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { PoolClient } from "pg";
import type { SourceBinding, SourcePool } from "@lares/agent-kit/console-source-transaction";
import { checkConsoleSourceDeadlines, consoleSourceTransaction, retainConsoleSourceDeadline, SourceAuthorityUnavailable } from "@lares/agent-kit/console-source-transaction";
import { requireConsoleSessionBinding } from "@lares/agent-kit/console-turn-authority";
import { PgGrantStore, type GrantDatabase } from "@lares/agent-kit/grant-store";
import { z } from "zod";

const uuid = z.string().uuid();
const MAX_CREDENTIAL_BYTES = 4096;
const REFUSED = "Outside credential is not available";
const REQUEST_REFUSED = "Outside credential change could not be confirmed";
const coordinateSchema = z.strictObject({
  ownerMemberId: z.string().min(1).max(256),
  accountId: uuid,
  resourceId: z.string().min(1).max(64),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  credentialRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  consentGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  operationId: uuid,
});
type Coordinates = z.infer<typeof coordinateSchema>;
type Head = {
  account_id: string;
  owner_member_id: string;
  resource_id: string;
  generation: string;
  active_revision: string | null;
  candidate_revision: string | null;
  consent_generation: string;
  state: "active" | "revoked";
};
type Revision = {
  credential_revision: string;
  generation: string;
  consent_generation: string;
  operation_id: string;
  nonce: Buffer;
  ciphertext: Buffer;
};
export type OutsideOperationKind = "stage" | "apply" | "rollback" | "revoke";
export type OutsideOperationResult = {
  operationId: string;
  accountId: string;
  kind: OutsideOperationKind;
  outcome: "staged" | "applied" | "rolled-back" | "revoked";
  generation: number;
  credentialRevision: number | null;
};
export class OutsideCustodyRecoveryRequired extends Error {
  constructor(readonly operationId: string) { super(REQUEST_REFUSED); this.name = "OutsideCustodyRecoveryRequired"; }
}
const denied = (): never => { throw new Error(REFUSED); };
const requestDenied = (): never => { throw new Error(REQUEST_REFUSED); };
/** Load exactly one protected 256-bit key without following a symlink or echoing its path. */
export function loadOutsideCustodyKey(path:string):Buffer{
  let descriptor:number|undefined;
  try{
    if (!path.startsWith("/")||resolve(path)!==path) throw new Error(REFUSED);
    const protectedParent=dirname(path);
    if(protectedParent==="/")throw new Error(REFUSED);
    let parent = "/";
    for (const part of protectedParent.split("/").filter(Boolean)) {
      parent = join(parent, part);
      const directory = lstatSync(parent);
      const stickyRoot = directory.uid === 0 && (directory.mode & 0o1000) !== 0;
      if (directory.isSymbolicLink() || !directory.isDirectory() ||
          (directory.uid !== 0 && directory.uid !== process.getuid?.()) ||
          ((directory.mode & 0o022) !== 0 && !stickyRoot)) throw new Error(REFUSED);
      if(parent===protectedParent&&(directory.uid!==0||directory.gid!==0||(directory.mode&0o7777)!==0o700))throw new Error(REFUSED);
    }
    descriptor=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const stat=fstatSync(descriptor);
    if(!stat.isFile()||stat.nlink!==1||stat.uid!==0||stat.gid!==0||stat.size!==32||(stat.mode&0o7777)!==0o400)throw new Error(REFUSED);
    const key=readFileSync(descriptor);
    if(key.length!==32){key.fill(0);throw new Error(REFUSED);}
    return key;
  }catch{throw new Error(REFUSED);}finally{if(descriptor!==undefined)try{closeSync(descriptor);}catch{}}
}
const sameBuffer = (left: Buffer, right: Buffer) => left.length === right.length && left.equals(right);
const number = (value: string | number): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return denied();
  return parsed;
};
function aad(input: Coordinates): Buffer {
  const c = coordinateSchema.parse(input);
  return Buffer.from(JSON.stringify([
    "lares-outside-custody-v1", c.ownerMemberId, c.accountId, c.resourceId,
    c.generation, c.credentialRevision, c.consentGeneration, c.operationId,
  ]));
}
function seal(key: Buffer, plaintext: Buffer, coordinates: Coordinates): { nonce: Buffer; ciphertext: Buffer } {
  if (!Buffer.isBuffer(key) || key.length !== 32 || !Buffer.isBuffer(plaintext) || plaintext.length < 1 || plaintext.length > MAX_CREDENTIAL_BYTES) return denied();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad(coordinates));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { nonce, ciphertext };
}
function open(key: Buffer, nonce: Buffer, ciphertext: Buffer, coordinates: Coordinates): Buffer {
  try {
    if (!Buffer.isBuffer(key) || key.length !== 32 || nonce.length !== 12 || ciphertext.length < 17 || ciphertext.length > MAX_CREDENTIAL_BYTES + 16) return denied();
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aad(coordinates));
    decipher.setAuthTag(ciphertext.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
    if (plaintext.length < 1 || plaintext.length > MAX_CREDENTIAL_BYTES) { plaintext.fill(0); return denied(); }
    return plaintext;
  } catch { return denied(); }
}
function requestHash(kind: OutsideOperationKind, accountId: string, memberId:string, resourceId:string, expectedGeneration: number,
  revision: number | null, callerConsentGeneration:number|null, authorityRevision:number, secret?: Buffer): Buffer {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(["lares-outside-operation-v1",kind,accountId,memberId,resourceId,expectedGeneration,revision,callerConsentGeneration,authorityRevision]));
  if (secret) hash.update(secret);
  return hash.digest();
}
function validBinding(binding: SourceBinding): void {
  if (!binding || !uuid.safeParse(binding.incarnation).success || !/^[A-Za-z0-9_-]{43}$/.test(binding.admissionNonce) ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(binding.sessionId) || !/^[a-z][a-z0-9-]{1,30}$/.test(binding.agent) ||
      !/^[^\s,;\x00-\x1f\x7f]{1,256}$/.test(binding.memberId)) denied();
}

/** Keeper-only use seam. The supplied transaction is owned by this store, not by the callback. */
export class OutsideCustodyStore {
  private readonly key:Buffer;
  private lifecycle:"open"|"closing"|"closed"="open";
  private activeOperations=0;
  constructor(private readonly pool: SourcePool, key: Buffer) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error(REFUSED);
    this.key=Buffer.from(key);
  }
  private assertOpen(refuse:()=>never=denied):void{if(this.lifecycle!=="open")refuse();}
  private beginOperation(refuse:()=>never=denied):()=>void{
    this.assertOpen(refuse);this.activeOperations++;let released=false;
    return ()=>{if(released)return;released=true;this.activeOperations--;if(this.lifecycle==="closing"&&this.activeOperations===0)this.dispose();};
  }
  private dispose():void{if(this.lifecycle==="closed")return;this.key.fill(0);this.lifecycle="closed";}
  close():void{if(this.lifecycle!=="open")return;this.lifecycle="closing";if(this.activeOperations===0)this.dispose();}

  private async capacity(db:PoolClient,accountId:string,kind:OutsideOperationKind,createsRevision:boolean):Promise<void>{
    const operations=await db.query<{count:string}>("SELECT count(*)::text AS count FROM outside_custody_operations WHERE account_id=$1",[accountId]);
    this.assertOpen(requestDenied);
    const count=Number(operations.rows[0]?.count??0);
    if(!Number.isSafeInteger(count)||count>32||kind!=="revoke"&&count>=32)return requestDenied();
    if(createsRevision){
      const revisions=await db.query<{count:string}>("SELECT count(*)::text AS count FROM outside_custody_revisions WHERE account_id=$1",[accountId]);
      this.assertOpen(requestDenied);
      const revisionCount=Number(revisions.rows[0]?.count??0);
      if(!Number.isSafeInteger(revisionCount)||revisionCount>=16)return requestDenied();
    }
  }

  private async current(db: PoolClient, binding: SourceBinding): Promise<number> {
    const current = await requireConsoleSessionBinding(binding, db as never);
    this.assertOpen(requestDenied);
    const grant = await new PgGrantStore().captureUseWithExpiry(current.memberId, current.agent, { db: db as GrantDatabase });
    this.assertOpen(requestDenied);
    if (!grant) return denied();
    retainConsoleSourceDeadline(db as never,current,grant.validUntil);
    return grant.accessRevision;
  }

  private async head(db: PoolClient, accountId: string, lock: boolean): Promise<Head | undefined> {
    const result = await db.query<Head>(`SELECT account_id,owner_member_id,resource_id,generation::text,
        active_revision::text,candidate_revision::text,consent_generation::text,state
      FROM outside_custody_accounts WHERE account_id=$1${lock ? " FOR UPDATE" : ""}`,[accountId]);
    this.assertOpen(requestDenied);
    return result.rows[0];
  }

  private async priorOperation(db: PoolClient, operationId: string, inputHash: Buffer, accountId: string, memberId:string,
    kind: OutsideOperationKind, expectedGeneration: number): Promise<OutsideOperationResult | undefined> {
    const prior = await db.query<{ account_id:string;owner_member_id:string;operation_kind:OutsideOperationKind;request_hash:Buffer;expected_generation:string;result_generation:string;credential_revision:string|null;outcome:OutsideOperationResult["outcome"] }>(
      "SELECT account_id,owner_member_id,operation_kind,request_hash,expected_generation::text,result_generation::text,credential_revision::text,outcome FROM outside_custody_operations WHERE operation_id=$1",[operationId]);
    this.assertOpen(requestDenied);
    const row = prior.rows[0];
    if (!row) return undefined;
    if (row.account_id !== accountId || row.owner_member_id!==memberId || row.operation_kind !== kind || !sameBuffer(row.request_hash, inputHash) || Number(row.expected_generation) !== expectedGeneration) return requestDenied();
    return { operationId,accountId,kind,outcome:row.outcome,generation:number(row.result_generation),credentialRevision:row.credential_revision === null ? null : number(row.credential_revision) };
  }

  private async record(db: PoolClient, input: { operationId:string;accountId:string;ownerMemberId:string;kind:OutsideOperationKind;hash:Buffer;expected:number;result:number;revision:number|null;outcome:OutsideOperationResult["outcome"] }): Promise<OutsideOperationResult> {
    await db.query(`INSERT INTO outside_custody_operations
      (operation_id,account_id,owner_member_id,operation_kind,request_hash,expected_generation,result_generation,credential_revision,outcome)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[input.operationId,input.accountId,input.ownerMemberId,input.kind,input.hash,input.expected,input.result,input.revision,input.outcome]);
    this.assertOpen(requestDenied);
    return { operationId:input.operationId,accountId:input.accountId,kind:input.kind,outcome:input.outcome,generation:input.result,credentialRevision:input.revision };
  }

  async stage(binding: SourceBinding, input: { accountId:string;operationId:string;expectedGeneration:number;expectedCandidateRevision:number|null;credential:Buffer }, options:{deadlineAtMs?:number}={}): Promise<OutsideOperationResult> {
    if (!Buffer.isBuffer(input.credential)) return requestDenied();
    let recoveryOperationId = input.operationId,release=()=>{};
    try {
      release=this.beginOperation(requestDenied);
      validBinding(binding); const accountId=uuid.parse(input.accountId), operationId=uuid.parse(input.operationId);
      recoveryOperationId = operationId;
      if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0 || input.expectedGeneration > Number.MAX_SAFE_INTEGER ||
          input.expectedCandidateRevision!==null&&(!Number.isSafeInteger(input.expectedCandidateRevision)||input.expectedCandidateRevision<1) ||
          input.expectedGeneration===0&&input.expectedCandidateRevision!==null || input.credential.length < 1 || input.credential.length > MAX_CREDENTIAL_BYTES) return requestDenied();
      const result=await consoleSourceTransaction(this.pool,async source=>{
        this.assertOpen(requestDenied);
        const db=source as PoolClient;
        const consent=await this.current(db,binding);
        const hash=requestHash("stage",accountId,binding.memberId,binding.agent,input.expectedGeneration,input.expectedCandidateRevision,null,consent,input.credential);
        let head=await this.head(db,accountId,true);
        if(head&&(head.owner_member_id!==binding.memberId||head.resource_id!==binding.agent))return requestDenied();
        const prior=await this.priorOperation(db,operationId,hash,accountId,binding.memberId,"stage",input.expectedGeneration);
        if(prior){if(!head)return requestDenied();return prior;}
        let created=false;
        if(!head){
          if(input.expectedGeneration!==0||input.expectedCandidateRevision!==null)return requestDenied();
          const inserted=await db.query<Head>(`INSERT INTO outside_custody_accounts
            (account_id,owner_member_id,resource_id,generation,consent_generation,state)
            VALUES($1,$2,$3,1,$4,'active') RETURNING account_id,owner_member_id,resource_id,generation::text,active_revision::text,candidate_revision::text,consent_generation::text,state`,
          [accountId,binding.memberId,binding.agent,consent]);
          this.assertOpen(requestDenied);
          head=inserted.rows[0];created=true;
        }
        if(!head || head.owner_member_id!==binding.memberId || head.resource_id!==binding.agent || head.state!=="active" || number(head.generation)!==(created?1:input.expectedGeneration) || number(head.consent_generation)!==consent) return requestDenied();
        if((head.candidate_revision===null?null:number(head.candidate_revision))!==input.expectedCandidateRevision)return requestDenied();
        await this.capacity(db,accountId,"stage",true);
        this.assertOpen(requestDenied);
        const revisionResult=await db.query<{revision:string}>("SELECT COALESCE(max(credential_revision),0)+1 AS revision FROM outside_custody_revisions WHERE account_id=$1",[accountId]);
        this.assertOpen(requestDenied);
        const credentialRevision=number(revisionResult.rows[0]!.revision);
        const generation=number(head.generation)+1;
        const coordinates={ownerMemberId:binding.memberId,accountId,resourceId:binding.agent,generation,credentialRevision,consentGeneration:consent,operationId};
        this.assertOpen(requestDenied);
        const encrypted=seal(this.key,input.credential,coordinates);
        await db.query(`INSERT INTO outside_custody_revisions(account_id,owner_member_id,credential_revision,generation,consent_generation,operation_id,nonce,ciphertext)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[accountId,binding.memberId,credentialRevision,generation,consent,operationId,encrypted.nonce,encrypted.ciphertext]);
        this.assertOpen(requestDenied);
        const updated=await db.query(`UPDATE outside_custody_accounts SET candidate_revision=$2,consent_generation=$3,updated_at=clock_timestamp()
          WHERE account_id=$1 AND owner_member_id=$4 AND generation=$5 AND candidate_revision IS NOT DISTINCT FROM $6 AND state='active'`,[accountId,credentialRevision,consent,binding.memberId,input.expectedGeneration||1,input.expectedCandidateRevision]);
        this.assertOpen(requestDenied);
        if(updated.rowCount!==1)return requestDenied();
        await checkConsoleSourceDeadlines(db);
        this.assertOpen(requestDenied);
        return this.record(db,{operationId,accountId,ownerMemberId:binding.memberId,kind:"stage",hash,expected:input.expectedGeneration,result:input.expectedGeneration||1,revision:credentialRevision,outcome:"staged"});
      },undefined,options);
      this.assertOpen(requestDenied);
      return result;
    } catch(error) { if(error instanceof OutsideCustodyRecoveryRequired)throw error;if(error instanceof SourceAuthorityUnavailable)throw new OutsideCustodyRecoveryRequired(recoveryOperationId);return requestDenied(); }
    finally { input.credential.fill(0);release(); }
  }

  async apply(binding: SourceBinding, input:{accountId:string;operationId:string;expectedGeneration:number;candidateRevision:number;consentGeneration:number}, options:{deadlineAtMs?:number}={}):Promise<OutsideOperationResult>{
    return this.transition(binding,input,"apply",null,options);
  }

  async rollback(binding: SourceBinding, input:{accountId:string;operationId:string;expectedGeneration:number;sourceRevision:number;consentGeneration:number}, options:{deadlineAtMs?:number}={}):Promise<OutsideOperationResult>{
    if(!Number.isSafeInteger(input.sourceRevision)||input.sourceRevision<1)return requestDenied();
    return this.transition(binding,input,"rollback",input.sourceRevision,options);
  }

  async revoke(binding: SourceBinding, input:{accountId:string;operationId:string;expectedGeneration:number}, options:{deadlineAtMs?:number}={}):Promise<OutsideOperationResult>{
    return this.transition(binding,input,"revoke",null,options);
  }

  private async transition(binding:SourceBinding,input:{accountId:string;operationId:string;expectedGeneration:number;candidateRevision?:number;consentGeneration?:number},kind:"apply"|"rollback"|"revoke",sourceRevision:number|null,options:{deadlineAtMs?:number}={}):Promise<OutsideOperationResult>{
    const release=this.beginOperation(requestDenied);
    try{
      validBinding(binding);const accountId=uuid.parse(input.accountId),operationId=uuid.parse(input.operationId);
      if(!Number.isSafeInteger(input.expectedGeneration)||input.expectedGeneration<1||input.expectedGeneration>Number.MAX_SAFE_INTEGER||
          kind==="apply"&&(!Number.isSafeInteger(input.candidateRevision)||input.candidateRevision!<1)||
          kind!=="revoke"&&(!Number.isSafeInteger(input.consentGeneration)||input.consentGeneration!<1))return requestDenied();
      try{
        const result=await consoleSourceTransaction(this.pool,async source=>{
        this.assertOpen(requestDenied);
        const db=source as PoolClient;
        const currentConsent=await this.current(db,binding);
        const hash=requestHash(kind,accountId,binding.memberId,binding.agent,input.expectedGeneration,
          kind==="apply"?input.candidateRevision!:sourceRevision,kind==="revoke"?null:input.consentGeneration!,currentConsent);
        const head=await this.head(db,accountId,true);
        if(head&&(head.owner_member_id!==binding.memberId||head.resource_id!==binding.agent))return requestDenied();
        const prior=await this.priorOperation(db,operationId,hash,accountId,binding.memberId,kind,input.expectedGeneration);if(prior){if(!head)return requestDenied();return prior;}
        if(!head||head.state!=="active"||number(head.generation)!==input.expectedGeneration)return requestDenied();
        await this.capacity(db,accountId,kind,kind==="rollback");
        this.assertOpen(requestDenied);
        if(kind==="revoke"){
          const next=input.expectedGeneration+1;
          const changed=await db.query("UPDATE outside_custody_accounts SET generation=$2,active_revision=NULL,candidate_revision=NULL,state='revoked',updated_at=clock_timestamp() WHERE account_id=$1 AND generation=$3 AND state='active'",[accountId,next,input.expectedGeneration]);
          this.assertOpen(requestDenied);
          if(changed.rowCount!==1)return requestDenied();
          await checkConsoleSourceDeadlines(db);
          this.assertOpen(requestDenied);
          return this.record(db,{operationId,accountId,ownerMemberId:binding.memberId,kind,hash,expected:input.expectedGeneration,result:next,revision:null,outcome:"revoked"});
        }
        if(currentConsent!==input.consentGeneration)return requestDenied();
        if(kind==="apply"){
          if(!head.candidate_revision||number(head.candidate_revision)!==input.candidateRevision)return requestDenied();
          const revision=await this.revision(db,accountId,input.candidateRevision!);
          if(!revision||number(revision.generation)!==input.expectedGeneration+1||number(revision.consent_generation)!==currentConsent)return requestDenied();
          const changed=await db.query(`UPDATE outside_custody_accounts SET generation=$2,active_revision=$3,candidate_revision=NULL,consent_generation=$4,updated_at=clock_timestamp()
            WHERE account_id=$1 AND generation=$5 AND candidate_revision=$3 AND state='active'`,[accountId,input.expectedGeneration+1,input.candidateRevision,currentConsent,input.expectedGeneration]);
          this.assertOpen(requestDenied);
          if(changed.rowCount!==1)return requestDenied();
          await checkConsoleSourceDeadlines(db);
          this.assertOpen(requestDenied);
          return this.record(db,{operationId,accountId,ownerMemberId:binding.memberId,kind,hash,expected:input.expectedGeneration,result:input.expectedGeneration+1,revision:input.candidateRevision!,outcome:"applied"});
        }
        if(sourceRevision===null||head.active_revision===null)return requestDenied();
        const original=await this.revision(db,accountId,sourceRevision);
        if(!original||number(original.consent_generation)!==currentConsent)return requestDenied();
        const oldCoordinates:Coordinates={ownerMemberId:binding.memberId,accountId,resourceId:binding.agent,generation:number(original.generation),credentialRevision:sourceRevision,consentGeneration:number(original.consent_generation),operationId:original.operation_id};
        this.assertOpen(requestDenied);
        const plaintext=open(this.key,original.nonce,original.ciphertext,oldCoordinates);
        try{
          const next=input.expectedGeneration+1;
          const latest=(await db.query<{revision:string}>("SELECT COALESCE(max(credential_revision),0)+1 AS revision FROM outside_custody_revisions WHERE account_id=$1",[accountId])).rows[0]!;
          this.assertOpen(requestDenied);
          const newRevision=number(latest.revision);
          this.assertOpen(requestDenied);
          const encrypted=seal(this.key,plaintext,{ownerMemberId:binding.memberId,accountId,resourceId:binding.agent,generation:next,credentialRevision:newRevision,consentGeneration:currentConsent,operationId});
          await db.query(`INSERT INTO outside_custody_revisions(account_id,owner_member_id,credential_revision,generation,consent_generation,operation_id,nonce,ciphertext)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[accountId,binding.memberId,newRevision,next,currentConsent,operationId,encrypted.nonce,encrypted.ciphertext]);
          this.assertOpen(requestDenied);
          const changed=await db.query(`UPDATE outside_custody_accounts SET generation=$2,active_revision=$3,candidate_revision=NULL,consent_generation=$4,updated_at=clock_timestamp()
            WHERE account_id=$1 AND generation=$5 AND state='active'`,[accountId,next,newRevision,currentConsent,input.expectedGeneration]);
          this.assertOpen(requestDenied);
          if(changed.rowCount!==1)return requestDenied();
          await checkConsoleSourceDeadlines(db);
          this.assertOpen(requestDenied);
          return this.record(db,{operationId,accountId,ownerMemberId:binding.memberId,kind,hash,expected:input.expectedGeneration,result:next,revision:newRevision,outcome:"rolled-back"});
        }finally{plaintext.fill(0);}
        },undefined,options);
        this.assertOpen(requestDenied);
        return result;
      }catch(error){if(error instanceof OutsideCustodyRecoveryRequired)throw error;if(error instanceof SourceAuthorityUnavailable)throw new OutsideCustodyRecoveryRequired(operationId);return requestDenied();}
    }finally{release();}
  }

  private async revision(db:PoolClient,accountId:string,revision:number):Promise<Revision|undefined>{
    const result=await db.query<Revision>(`SELECT credential_revision::text,generation::text,consent_generation::text,operation_id,nonce,ciphertext
      FROM outside_custody_revisions WHERE account_id=$1 AND credential_revision=$2`,[accountId,revision]);
    this.assertOpen(requestDenied);
    return result.rows[0];
  }

  async withCredential<T>(binding:SourceBinding,input:{accountId:string},use:(credential:Buffer,authority:{backendPid:number;accessRevision:number})=>Promise<T>,options:{deadlineAtMs?:number}={}):Promise<T>{
    const release=this.beginOperation();
    try{
      validBinding(binding);const accountId=uuid.parse(input.accountId);
      try{
        const result=await consoleSourceTransaction(this.pool,async source=>{
        this.assertOpen();
        const db=source as PoolClient;
        const currentConsent=await this.current(db,binding);
        const head=await this.head(db,accountId,true);
        if(!head||head.owner_member_id!==binding.memberId||head.resource_id!==binding.agent||head.state!=="active"||!head.active_revision||number(head.consent_generation)!==currentConsent)return denied();
        const revisionId=number(head.active_revision),revision=await this.revision(db,accountId,revisionId);
        if(!revision||number(revision.generation)!==number(head.generation)||number(revision.consent_generation)!==currentConsent)return denied();
        this.assertOpen();
        const credential=open(this.key,revision.nonce,revision.ciphertext,{ownerMemberId:binding.memberId,accountId,resourceId:binding.agent,
          generation:number(revision.generation),credentialRevision:revisionId,consentGeneration:currentConsent,operationId:revision.operation_id});
        try{
          const identity=await db.query<{pid:number;user:string;sessionUser:string}>("SELECT pg_backend_pid() AS pid,current_user AS user,session_user AS \"sessionUser\"");
          this.assertOpen();
          if(identity.rows[0]?.user!=="lares_outside_custody"||identity.rows[0]?.sessionUser!=="lares_outside_custody")return denied();
          await checkConsoleSourceDeadlines(db);
          this.assertOpen();
          const result=await use(credential,{backendPid:identity.rows[0].pid,accessRevision:currentConsent});
          this.assertOpen();
          if(await new PgGrantStore().captureUse(binding.memberId,binding.agent,{db:db as GrantDatabase})!==currentConsent)return denied();
          this.assertOpen();
          await checkConsoleSourceDeadlines(db);
          this.assertOpen();
          return result;
        }finally{credential.fill(0);}
        },undefined,options);
        this.assertOpen();
        return result;
      }catch(error){if(error instanceof OutsideCustodyRecoveryRequired)throw error;if(error instanceof SourceAuthorityUnavailable)throw new OutsideCustodyRecoveryRequired(accountId);return denied();}
    }finally{release();}
  }

  async inspect(binding:SourceBinding,operationId:string):Promise<OutsideOperationResult|undefined>{
    const release=this.beginOperation(requestDenied);
    try{
      validBinding(binding);const id=uuid.parse(operationId);
      try{
        const result=await consoleSourceTransaction(this.pool,async source=>{
        this.assertOpen(requestDenied);
        const db=source as PoolClient;
        await this.current(db,binding);
        const row=await db.query<{account_id:string;owner_member_id:string;operation_kind:OutsideOperationKind;outcome:OutsideOperationResult["outcome"];result_generation:string;credential_revision:string|null}>(
          "SELECT account_id,owner_member_id,operation_kind,outcome,result_generation::text,credential_revision::text FROM outside_custody_operations WHERE operation_id=$1",[id]);
        this.assertOpen(requestDenied);
        const operation=row.rows[0];if(!operation)return undefined;if(operation.owner_member_id!==binding.memberId)return denied();
        const head=await this.head(db,operation.account_id,false);
        if(!head||head.owner_member_id!==binding.memberId||head.resource_id!==binding.agent)return denied();
        return {operationId:id,accountId:operation.account_id,kind:operation.operation_kind,outcome:operation.outcome,generation:number(operation.result_generation),credentialRevision:operation.credential_revision===null?null:number(operation.credential_revision)};
        });
        this.assertOpen(requestDenied);
        return result;
      }catch(error){if(error instanceof SourceAuthorityUnavailable)throw new OutsideCustodyRecoveryRequired(id);return denied();}
    }finally{release();}
  }

  /** Call after an uncertain transaction outcome; this inspects and never replays the operation. */
  async runAndRecover<T extends OutsideOperationResult>(operationId:string,run:()=>Promise<T>,inspect:()=>Promise<OutsideOperationResult|undefined>):Promise<T|OutsideOperationResult>{
    const release=this.beginOperation(requestDenied);
    try{
      try{
        const result=await run();
        this.assertOpen(requestDenied);
        return result;
      }catch(error){
        if(!(error instanceof OutsideCustodyRecoveryRequired))throw error;
        this.assertOpen(requestDenied);
        const found=await inspect();this.assertOpen(requestDenied);
        if(found&&found.operationId===operationId)return found;
        throw new OutsideCustodyRecoveryRequired(operationId);
      }
    }finally{release();}
  }
}
