/** Unregistered storage for third-party bearer credentials. It has no network or model API. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { constants } from "node:fs";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import type { PoolClient } from "pg";
import type { SourceBinding, SourcePool } from "@lares/agent-kit/console-source-transaction";
import { checkConsoleSourceDeadlines, consoleSourceTransaction, gateConsoleOrganisation, requireSourceTransactionOwner, retainConsoleSourceDeadline, retainSourceTransactionDeadline, SourceAuthorityUnavailable, type SourceDatabase } from "@lares/agent-kit/console-source-transaction";
import { requireConsoleSessionBinding } from "@lares/agent-kit/console-turn-authority";
import { PgGrantStore, type GrantDatabase } from "@lares/agent-kit/grant-store";
import { z } from "zod";

const uuid = z.string().uuid();
const MAX_CREDENTIAL_BYTES = 4096;
const MAX_PRIVATE_RESULT_BYTES = 64 * 1024;
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
const boundCoordinateSchema = coordinateSchema.extend({
  connectionName: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
  revisionPurpose: z.enum(['discovery','executable']),
  policyHash: z.string().regex(/^[a-f0-9]{64}$/),
});
type BoundCoordinates = z.infer<typeof boundCoordinateSchema>;
type Head = {
  account_id: string;
  owner_member_id: string;
  resource_id: string;
  connection_name: string;
  generation: string;
  active_revision: string | null;
  candidate_revision: string | null;
  consent_generation: string;
  state: "active" | "revoked";
};
export type OutsideOperationKind = "stage" | "apply" | "rollback" | "revoke" | "discover";
export type OutsideOperationResult = {
  operationId: string;
  accountId: string;
  kind: OutsideOperationKind;
  outcome: "staged" | "applied" | "rolled-back" | "revoked" | "claimed" | "completed" | "unknown";
  generation: number;
  credentialRevision: number | null;
};
type OutsideDiscoveryClaim = {
  requestId: string; operationId: string; accountId: string; agentName: string; connectionName: string;
  destination: string; policyHash: string; definitionHash: string; accessRevision: number;
};
export class OutsideCustodyRecoveryRequired extends Error {
  constructor(readonly operationId: string) { super(REQUEST_REFUSED); this.name = "OutsideCustodyRecoveryRequired"; }
}
const denied = (): never => { throw new Error(REFUSED); };
const requestDenied = (): never => { throw new Error(REQUEST_REFUSED); };

/** Authenticate a human cookie only inside the outside role's owned transaction. The first
 * lookup discovers the organization gate; the locked lookup below is the authority check. */
export async function lockOutsideHumanSession(db: SourceDatabase, sessionToken: string): Promise<{ memberId: string }> {
  requireSourceTransactionOwner(db);
  if (typeof sessionToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) return denied();
  const tokenHash = createHash('sha256').update(sessionToken).digest('hex');
  const discovered = await db.query(`SELECT member_id FROM member_sessions
    WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()`, [tokenHash]);
  const memberId = discovered.rows[0]?.member_id as unknown;
  if (discovered.rows.length !== 1 || typeof memberId !== 'string' || !memberId) return denied();
  await gateConsoleOrganisation(db, memberId, undefined, { lock: 'update' });
  const current = await db.query(`SELECT s.member_id,
      isfinite(s.expires_at) AS finite,
      CASE WHEN isfinite(s.expires_at) THEN to_char(s.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS deadline
    FROM member_sessions s JOIN users u ON u.id=s.member_id
    WHERE s.token_hash=$1 AND s.member_id=$2 AND s.revoked_at IS NULL
      AND s.expires_at>clock_timestamp() AND u.status='active' AND u.org_id IS NOT NULL
    FOR UPDATE OF s`, [tokenHash, memberId]);
  const row = current.rows[0] as {member_id?:unknown;finite?:unknown;deadline?:unknown}|undefined;
  if (current.rows.length !== 1 || row?.member_id !== memberId || row.finite !== true ||
      typeof row.deadline !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(row.deadline)) return denied();
  retainSourceTransactionDeadline(db, row.deadline);
  await checkConsoleSourceDeadlines(db);
  return { memberId };
}

/** Capture current evaluator output only after the caller has locked the human session,
 * and retain the winning grant's exact SQL expiry on that same owned transaction. */
export async function captureOutsideHumanUse(db: SourceDatabase, memberId: string, agent: string, connectionName: string,
  expected?: { definitionHash: string; accessRevision: number }): Promise<import('@lares/agent-kit/grant-store').OutsideUseCapture> {
  requireSourceTransactionOwner(db);
  const capture = await new PgGrantStore().captureOutsideUse(memberId, agent, {
    db: db as GrantDatabase, connectionName, ...(expected ? { expected } : {}),
  });
  if (!capture) return denied();
  if (capture.grant.validUntil !== null) retainSourceTransactionDeadline(db, capture.grant.validUntil);
  await checkConsoleSourceDeadlines(db);
  return capture;
}
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
/** Validate the prepared identity commitment before any custody database connection is opened. */
export function loadBoundOutsideCustodyKey(path: string, expectedFingerprint: string): Buffer {
  if (typeof expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(expectedFingerprint)) return denied();
  const key = loadOutsideCustodyKey(path);
  const actual = createHash('sha256').update(key).digest('hex');
  if (actual !== expectedFingerprint) { key.fill(0); return denied(); }
  return key;
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
function boundAad(input: BoundCoordinates): Buffer {
  const c = boundCoordinateSchema.parse(input);
  return Buffer.from(JSON.stringify(["lares-outside-custody-bound-v1", aad({
    ownerMemberId:c.ownerMemberId,accountId:c.accountId,resourceId:c.resourceId,generation:c.generation,
    credentialRevision:c.credentialRevision,consentGeneration:c.consentGeneration,operationId:c.operationId,
  }).toString('utf8'),c.connectionName,c.revisionPurpose,c.policyHash]));
}
function sealWithAad(key: Buffer, plaintext: Buffer, associated: Buffer): { nonce: Buffer; ciphertext: Buffer } {
  if (!Buffer.isBuffer(key) || key.length !== 32 || !Buffer.isBuffer(plaintext) || plaintext.length < 1 || plaintext.length > MAX_CREDENTIAL_BYTES) return denied();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(associated);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { nonce, ciphertext };
}
function sealBound(key:Buffer,plaintext:Buffer,coordinates:BoundCoordinates){return sealWithAad(key,plaintext,boundAad(coordinates));}
function sealPrivateResult(key:Buffer,plain:Buffer,requestId:string,accountId:string,ownerMemberId:string,policyHash:string):{nonce:Buffer;ciphertext:Buffer}{
  if(plain.length<1||plain.length>MAX_PRIVATE_RESULT_BYTES)return denied();
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(Buffer.from(canonicalJson(['lares-outside-discovery-result-v1',requestId,accountId,ownerMemberId,policyHash])));
  return {nonce,ciphertext:Buffer.concat([cipher.update(plain),cipher.final(),cipher.getAuthTag()])};
}
function openPrivateResult(key:Buffer,nonce:Buffer,ciphertext:Buffer,requestId:string,accountId:string,ownerMemberId:string,policyHash:string):Buffer{
  try{if(nonce.length!==12||ciphertext.length<17||ciphertext.length>MAX_PRIVATE_RESULT_BYTES+16)return denied();
    const decipher=createDecipheriv('aes-256-gcm',key,nonce);
    decipher.setAAD(Buffer.from(canonicalJson(['lares-outside-discovery-result-v1',requestId,accountId,ownerMemberId,policyHash])));
    decipher.setAuthTag(ciphertext.subarray(-16));return Buffer.concat([decipher.update(ciphertext.subarray(0,-16)),decipher.final()]);
  }catch{return denied();}
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries=Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b));
    return `{${entries.map(([key,child])=>`${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  }
  return denied();
}
export function outsideDiscoveryPolicyHash(capture: import('@lares/agent-kit/grant-store').OutsideUseCapture,
  route: {policyHash:string;sourceAddress:string;proxyUrl:string}, purpose: string): string {
  if(typeof purpose!=='string'||purpose.trim().length<1||purpose.length>200||purpose.trim()!==purpose||
      !/^[a-f0-9]{64}$/.test(route.policyHash)||isIP(route.sourceAddress)!==4||route.proxyUrl!=='http://lares-egress-proxy:8888/') return denied();
  return createHash('sha256').update(canonicalJson({version:1,purpose,capture,route})).digest('hex');
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
  /** Object identity is minted only after the claim transaction returns with acknowledged COMMIT. */
  private readonly acknowledgedDiscoveryClaims = new WeakSet<object>();
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

  /** Keep the member cookie, current organization and retained SQL-clock expiry on the
   * same outside-role client used by the caller's later authority checks and writes. */
  async withHumanSession<T>(sessionToken: string, work: (db: PoolClient, memberId: string) => Promise<T>, options: { deadlineAtMs: number }): Promise<T> {
    const release = this.beginOperation(requestDenied);
    try {
      return await consoleSourceTransaction(this.pool, async source => {
        this.assertOpen(requestDenied);
        const db = source as PoolClient;
        const { memberId } = await lockOutsideHumanSession(db, sessionToken);
        this.assertOpen(requestDenied);
        const result = await work(db, memberId);
        this.assertOpen(requestDenied);
        await checkConsoleSourceDeadlines(db);
        return result;
      }, undefined, options);
    } catch (error) {
      if (error instanceof SourceAuthorityUnavailable || error instanceof OutsideCustodyRecoveryRequired) throw error;
      return requestDenied();
    } finally { release(); }
  }

  async previewDiscovery(sessionToken:string,input:{agentName:string;connectionName:string},options:{deadlineAtMs:number}):Promise<import('@lares/agent-kit/grant-store').OutsideUseCapture> {
    return this.withHumanSession(sessionToken,async(db,memberId)=>{
      return captureOutsideHumanUse(db,memberId,input.agentName,input.connectionName);
    },options);
  }

  /** Persist a spent discovery-only claim. It returns metadata, never a reusable bearer capability. */
  private async claimDiscovery(sessionToken:string,input:{requestId:string;operationId:string;accountId:string;agentName:string;connectionName:string;
    expectedDefinitionHash:string;expectedAccessRevision:number;expectedPolicyHash:string;purpose:string;route:{policyHash:string;sourceAddress:string;proxyUrl:string};credential:Buffer},
    options:{deadlineAtMs:number}):Promise<OutsideDiscoveryClaim>{
    const release=this.beginOperation(requestDenied);
    try{
      const requestId=uuid.parse(input.requestId),operationId=uuid.parse(input.operationId),accountId=uuid.parse(input.accountId);
      if(!Buffer.isBuffer(input.credential)||input.credential.length<1||input.credential.length>MAX_CREDENTIAL_BYTES||
          !/^[a-f0-9]{64}$/.test(input.expectedDefinitionHash)||!Number.isSafeInteger(input.expectedAccessRevision)||input.expectedAccessRevision<1||
          !/^[a-f0-9]{64}$/.test(input.expectedPolicyHash))return requestDenied();
      const result=await this.withHumanSession(sessionToken,async(db,memberId)=>{
        this.assertOpen(requestDenied);
        const capture=await captureOutsideHumanUse(db,memberId,input.agentName,input.connectionName,{definitionHash:input.expectedDefinitionHash,accessRevision:input.expectedAccessRevision});
        if(capture.actor.memberId!==memberId||capture.agent.name!==input.agentName||capture.outside.connection.name!==input.connectionName)return requestDenied();
        const destination=capture.outside.connection.url;
        const policyHash=outsideDiscoveryPolicyHash(capture,input.route,input.purpose);
        if(policyHash!==input.expectedPolicyHash)return requestDenied();
        const policy={version:1,purpose:input.purpose,capture,endpoint:destination,route:input.route};
        const policyJson=canonicalJson(policy);
        if(Buffer.byteLength(policyJson)>8192)return requestDenied();
        const policyHashBytes=Buffer.from(policyHash,'hex');
        const existing=await db.query<{account_id:string}>(`SELECT account_id FROM outside_custody_accounts
          WHERE owner_member_id=$1 AND resource_id=$2 AND connection_name=$3 FOR UPDATE`,[memberId,input.agentName,input.connectionName]);
        if(existing.rows.length!==0)return requestDenied();
        const prior=await db.query<{operation_id:string}>(`SELECT operation_id FROM outside_custody_operations WHERE request_id=$1`,[requestId]);
        if(prior.rows.length!==0)return requestDenied();
        await this.capacity(db,accountId,'discover',true);
        const created=await db.query(`INSERT INTO outside_custody_accounts
          (account_id,owner_member_id,resource_id,connection_name,generation,consent_generation,state)
          VALUES($1,$2,$3,$4,1,$5,'active')`,[accountId,memberId,input.agentName,input.connectionName,capture.agent.accessRevision]);
        if(created.rowCount!==1)return requestDenied();
        const coordinates:BoundCoordinates={ownerMemberId:memberId,accountId,resourceId:input.agentName,connectionName:input.connectionName,
          generation:1,credentialRevision:1,consentGeneration:capture.agent.accessRevision,operationId,revisionPurpose:'discovery',policyHash};
        const encrypted=sealBound(this.key,input.credential,coordinates);
        await db.query(`INSERT INTO outside_custody_revisions
          (account_id,owner_member_id,credential_revision,generation,consent_generation,revision_purpose,policy_json,policy_hash,operation_id,nonce,ciphertext)
          VALUES($1,$2,1,1,$3,'discovery',$4::jsonb,$5,$6,$7,$8)`,[accountId,memberId,capture.agent.accessRevision,policyJson,policyHashBytes,operationId,encrypted.nonce,encrypted.ciphertext]);
        await db.query(`INSERT INTO outside_custody_operations
          (operation_id,account_id,owner_member_id,operation_kind,request_id,event_phase,request_hash,expected_generation,result_generation,credential_revision,outcome)
          VALUES($1,$2,$3,'discover',$4,'claim',$5,0,1,1,'claimed')`,[operationId,accountId,memberId,requestId,
          createHash('sha256').update(canonicalJson({requestId,operationId,accountId,memberId,agentName:input.agentName,connectionName:input.connectionName,policyHash,credentialHash:createHash('sha256').update(input.credential).digest('hex')})).digest()]);
        await checkConsoleSourceDeadlines(db);
        return {requestId,operationId,accountId,agentName:input.agentName,connectionName:input.connectionName,destination,policyHash,
          definitionHash:capture.agent.definitionHash,accessRevision:capture.agent.accessRevision};
      },options);
      const receipt=Object.freeze(result);
      this.acknowledgedDiscoveryClaims.add(receipt);
      return receipt;
    }catch(error){
      if(error instanceof OutsideCustodyRecoveryRequired)throw error;
      if(error instanceof SourceAuthorityUnavailable)throw new OutsideCustodyRecoveryRequired(input.operationId);
      return requestDenied();
    }finally{input.credential.fill(0);release();}
  }

  /** Re-read one private discovery result only for the same live member, grant, and connection. */
  async inspectDiscovery(sessionToken:string,input:{requestId:string;agentName:string;connectionName:string;
    expectedDefinitionHash:string;expectedAccessRevision:number;expectedPolicyHash:string;purpose:string;
    route:{policyHash:string;sourceAddress:string;proxyUrl:string}},options:{deadlineAtMs:number}):Promise<{status:'pending'|'completed'|'unknown';result?:unknown}>{
    const requestId=uuid.parse(input.requestId);
    if(!/^[a-f0-9]{64}$/.test(input.expectedDefinitionHash)||!Number.isSafeInteger(input.expectedAccessRevision)||input.expectedAccessRevision<1||
      !/^[a-f0-9]{64}$/.test(input.expectedPolicyHash))return requestDenied();
    return this.withHumanSession(sessionToken,async(db,memberId)=>{
      const capture=await captureOutsideHumanUse(db,memberId,input.agentName,input.connectionName,
        {definitionHash:input.expectedDefinitionHash,accessRevision:input.expectedAccessRevision});
      if(capture.actor.memberId!==memberId||capture.agent.name!==input.agentName||capture.outside.connection.name!==input.connectionName||
        outsideDiscoveryPolicyHash(capture,input.route,input.purpose)!==input.expectedPolicyHash)return requestDenied();
      const rows=await db.query<{account_id:string;owner_member_id:string;resource_id:string;connection_name:string;
        claim_operation_id:string;claim_outcome:string;credential_revision:string;revision_purpose:string;policy_hash:Buffer;
        result_operation_id:string|null;result_outcome:string|null;result_nonce:Buffer|null;result_ciphertext:Buffer|null}>(`SELECT a.account_id,a.owner_member_id,a.resource_id,a.connection_name,
          c.operation_id AS claim_operation_id,c.outcome AS claim_outcome,c.credential_revision::text,
          v.revision_purpose,v.policy_hash,r.operation_id AS result_operation_id,r.outcome AS result_outcome,
          r.result_nonce,r.result_ciphertext
        FROM outside_custody_operations c
        JOIN outside_custody_accounts a ON a.account_id=c.account_id AND a.owner_member_id=c.owner_member_id
        JOIN outside_custody_revisions v ON v.account_id=c.account_id AND v.credential_revision=c.credential_revision
        LEFT JOIN outside_custody_operations r ON r.request_id=c.request_id AND r.event_phase='result'
        WHERE c.request_id=$1 AND c.event_phase='claim' AND c.operation_kind='discover' AND c.owner_member_id=$2
          AND c.credential_revision IS NOT NULL AND v.revision_purpose='discovery'`,[requestId,memberId]);
      if(rows.rows.length!==1)return requestDenied();
      const row=rows.rows[0]!;
      if(row.resource_id!==input.agentName||row.connection_name!==input.connectionName||row.revision_purpose!=='discovery'||
        !row.policy_hash.equals(Buffer.from(input.expectedPolicyHash,'hex'))||row.claim_outcome!=='claimed')return requestDenied();
      await checkConsoleSourceDeadlines(db);
      if(row.result_operation_id===null)return {status:'pending'};
      if(row.result_outcome==='unknown')return {status:'unknown'};
      if(row.result_outcome!=='completed'||!row.result_nonce||!row.result_ciphertext)return requestDenied();
      const plaintext=openPrivateResult(this.key,row.result_nonce,row.result_ciphertext,requestId,row.account_id,memberId,input.expectedPolicyHash);
      try{
        let result:unknown;
        try{result=JSON.parse(plaintext.toString('utf8'));}catch{return requestDenied();}
        await checkConsoleSourceDeadlines(db);
        return {status:'completed',result};
      }finally{plaintext.fill(0);}
    },options);
  }

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
    const result = await db.query<Head>(`SELECT account_id,owner_member_id,resource_id,connection_name,generation::text,
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
    if (Buffer.isBuffer(input.credential)) input.credential.fill(0);
    // Discovery claims are encrypted for inspection only. Numeric access consent does not
    // authorize executable credentials, and this slice has no executable writer.
    return requestDenied();
  }

  async apply(binding: SourceBinding, input:{accountId:string;operationId:string;expectedGeneration:number;candidateRevision:number;consentGeneration:number}, options:{deadlineAtMs?:number}={}):Promise<OutsideOperationResult>{
    void binding;void input;void options;
    // Persisted executable revisions have no current versioned-policy verifier in this slice.
    return requestDenied();
  }

  async rollback(binding: SourceBinding, input:{accountId:string;operationId:string;expectedGeneration:number;sourceRevision:number;consentGeneration:number}, options:{deadlineAtMs?:number}={}):Promise<OutsideOperationResult>{
    void binding;void input;void options;
    return requestDenied();
  }

  async revoke(binding: SourceBinding, input:{accountId:string;operationId:string;expectedGeneration:number}, options:{deadlineAtMs?:number}={}):Promise<OutsideOperationResult>{
    return this.transition(binding,input,options);
  }

  private async transition(binding:SourceBinding,input:{accountId:string;operationId:string;expectedGeneration:number},options:{deadlineAtMs?:number}={}):Promise<OutsideOperationResult>{
    const release=this.beginOperation(requestDenied);
    try{
      validBinding(binding);const accountId=uuid.parse(input.accountId),operationId=uuid.parse(input.operationId);
      if(!Number.isSafeInteger(input.expectedGeneration)||input.expectedGeneration<1||input.expectedGeneration>Number.MAX_SAFE_INTEGER)return requestDenied();
      try{
        const result=await consoleSourceTransaction(this.pool,async source=>{
        this.assertOpen(requestDenied);
        const db=source as PoolClient;
        const currentConsent=await this.current(db,binding);
        const hash=requestHash("revoke",accountId,binding.memberId,binding.agent,input.expectedGeneration,null,null,currentConsent);
        const head=await this.head(db,accountId,true);
        if(head&&(head.owner_member_id!==binding.memberId||head.resource_id!==binding.agent))return requestDenied();
        const prior=await this.priorOperation(db,operationId,hash,accountId,binding.memberId,"revoke",input.expectedGeneration);if(prior){if(!head)return requestDenied();return prior;}
        if(!head||head.state!=="active"||number(head.generation)!==input.expectedGeneration)return requestDenied();
        await this.capacity(db,accountId,"revoke",false);
        this.assertOpen(requestDenied);
        const next=input.expectedGeneration+1;
        const changed=await db.query("UPDATE outside_custody_accounts SET generation=$2,active_revision=NULL,candidate_revision=NULL,state='revoked',updated_at=clock_timestamp() WHERE account_id=$1 AND generation=$3 AND state='active'",[accountId,next,input.expectedGeneration]);
        this.assertOpen(requestDenied);
        if(changed.rowCount!==1)return requestDenied();
        await checkConsoleSourceDeadlines(db);
        this.assertOpen(requestDenied);
        return this.record(db,{operationId,accountId,ownerMemberId:binding.memberId,kind:"revoke",hash,expected:input.expectedGeneration,result:next,revision:null,outcome:"revoked"});
        },undefined,options);
        this.assertOpen(requestDenied);
        return result;
      }catch(error){if(error instanceof OutsideCustodyRecoveryRequired)throw error;if(error instanceof SourceAuthorityUnavailable)throw new OutsideCustodyRecoveryRequired(operationId);return requestDenied();}
    }finally{release();}
  }

  async withCredential<T>(binding:SourceBinding,input:{accountId:string},use:(credential:Buffer,authority:{backendPid:number;accessRevision:number})=>Promise<T>,options:{deadlineAtMs?:number}={}):Promise<T>{
    void binding;void input;void use;void options;
    // Credential delivery waits for current, versioned policy verification and a private
    // transaction/route authority boundary that this intermediate slice does not provide.
    return denied();
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
