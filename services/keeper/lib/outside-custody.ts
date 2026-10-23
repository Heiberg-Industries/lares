/** Unregistered storage for third-party bearer credentials. It has no network or model API. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { constants } from "node:fs";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import type { Pool, PoolClient } from "pg";
import { requireDefinitionNamespace, withDefinitionNamespace } from "./definition-namespace.js";
import type { AgentLifecycle } from "./lifecycle.js";
import type { SourceBinding, SourcePool } from "@lares/agent-kit/console-source-transaction";
import { checkConsoleSourceDeadlines, consoleSourceTransaction, gateConsoleOrganisation, requireSourceTransactionOwner, retainConsoleSourceDeadline, retainSourceTransactionDeadline, SourceAuthorityUnavailable, type SourceDatabase } from "@lares/agent-kit/console-source-transaction";
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
type OutsideClaimIdentity = object;
type OutsideClaimIdentityState = {
  claim: OutsideDiscoveryClaim;
  ownerMemberId: string;
  expectedGeneration: number;
  generation: number;
  activeRevision: number | null;
  candidateRevision: number | null;
  headConsentGeneration: number;
  consentGeneration: number;
  credentialRevision: number;
  routePolicyHash: string;
  deadlineAtMs: number;
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
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries=Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b));
    return `{${entries.map(([key,child])=>`${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  }
  return denied();
}
function outsideDiscoveryPolicyHash(capture: import('@lares/agent-kit/grant-store').OutsideUseCapture,
  input:{ownerMemberId:string;accountId:string;agentName:string;connectionName:string;destination:string;
    route:{policyHash:string;sourceAddress:string;proxyUrl:string};purpose:string}): string {
  const {ownerMemberId,accountId,agentName,connectionName,destination,route,purpose}=input;
  if(typeof purpose!=='string'||purpose.trim().length<1||purpose.length>200||purpose.trim()!==purpose||
      !/^[^\s,;\x00-\x1f\x7f]{1,256}$/.test(ownerMemberId)||!uuid.safeParse(accountId).success||
      !/^([a-z][a-z0-9-]{1,30})$/.test(agentName)||!/^([a-z][a-z0-9-]{1,30})$/.test(connectionName)||
      typeof destination!=='string'||destination.length<1||Buffer.byteLength(destination)>8192||
      !/^[a-f0-9]{64}$/.test(route.policyHash)||isIP(route.sourceAddress)!==4||route.proxyUrl!=='http://lares-egress-proxy:8888/') return denied();
  return createHash('sha256').update(canonicalJson({version:1,purpose,ownerMemberId,accountId,agentName,connectionName,endpoint:destination,capture,route})).digest('hex');
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
  /** Runtime-private receipts cannot be forged from copied fields or re-used after consumption. */
  #claimIdentities = new WeakMap<object, OutsideClaimIdentityState>();
  private lifecycle:"open"|"closing"|"closed"="open";
  private activeOperations=0;
  private readonly mainPool?: Pool;
  private readonly routeLifecycle?: AgentLifecycle;
  private readonly drainWaiters = new Set<() => void>();
  constructor(private readonly pool: SourcePool, key: Buffer, runtime?: { mainPool: Pool; lifecycle: AgentLifecycle }) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error(REFUSED);
    this.key=Buffer.from(key);
    this.mainPool = runtime?.mainPool;
    this.routeLifecycle = runtime?.lifecycle;
  }
  #assertOpen(refuse:()=>never=denied):void{if(this.lifecycle!=="open")refuse();}
  #assertMainNamespace(client:PoolClient,deadlineAtMs:number):void{
    this.#assertOpen(requestDenied);
    if(deadlineAtMs<=Date.now()||requireDefinitionNamespace()!==client)return requestDenied();
  }
  #beginOperation(refuse:()=>never=denied):()=>void{
    this.#assertOpen(refuse);this.activeOperations++;let released=false;
    return ()=>{if(released)return;released=true;this.activeOperations--;if(this.lifecycle==="closing"&&this.activeOperations===0){this.#dispose();for(const resolve of this.drainWaiters)resolve();this.drainWaiters.clear();}};
  }
  #dispose():void{if(this.lifecycle==="closed")return;this.key.fill(0);this.#claimIdentities=new WeakMap();this.lifecycle="closed";}
  close():void{if(this.lifecycle!=="open")return;this.lifecycle="closing";if(this.activeOperations===0)this.#dispose();}
  async drainForShutdown():Promise<void>{
    if(this.lifecycle==="closed")return;
    if(this.lifecycle==="open")this.lifecycle="closing";
    if(this.activeOperations===0){this.#dispose();return;}
    await new Promise<void>(resolve=>this.drainWaiters.add(resolve));
  }

  async #inMainNamespace<T>(options:{deadlineAtMs:number},work:()=>Promise<T>):Promise<T>{
    this.#assertOpen(requestDenied);
    if(!this.mainPool||!this.routeLifecycle||!Number.isFinite(options.deadlineAtMs)||options.deadlineAtMs<=Date.now())return requestDenied();
    return withDefinitionNamespace(this.mainPool,async namespaceClient=>{
      this.#assertOpen(requestDenied);
      if(options.deadlineAtMs<=Date.now()||requireDefinitionNamespace()!==namespaceClient)return requestDenied();
      const result=await work();
      this.#assertOpen(requestDenied);
      if(options.deadlineAtMs<=Date.now()||requireDefinitionNamespace()!==namespaceClient)return requestDenied();
      return result;
    },{deadlineAtMs:options.deadlineAtMs});
  }

  #mintClaimIdentity(state:OutsideClaimIdentityState):OutsideClaimIdentity{
    this.#assertOpen(requestDenied);
    if(state.deadlineAtMs<=Date.now())return requestDenied();
    const identity=Object.freeze(Object.create(null)) as OutsideClaimIdentity;
    this.#claimIdentities.set(identity,state);
    return identity;
  }

  #consumeClaimIdentity(identity:OutsideClaimIdentity):OutsideClaimIdentityState{
    const state=this.#claimIdentities.get(identity);
    if(!state)return requestDenied();
    this.#claimIdentities.delete(identity);
    if(this.lifecycle!=="open"||state.deadlineAtMs<=Date.now())return requestDenied();
    return state;
  }

  /** Start admission only after the shared main-pool namespace is held. The callback is
   * private to this class; callers cannot supply a success callback or transaction client. */
  async #withHumanSession<T>(sessionToken: string, work: (db: PoolClient, memberId: string) => Promise<T>, options: { deadlineAtMs: number }): Promise<T> {
    const release = this.#beginOperation(requestDenied);
    try {
      const namespaceClient=requireDefinitionNamespace();
      const assertNamespace=()=>this.#assertMainNamespace(namespaceClient,options.deadlineAtMs);
      const result=await consoleSourceTransaction(this.pool, async source => {
        this.#assertOpen(requestDenied);
        const db = source as PoolClient;
        const { memberId } = await lockOutsideHumanSession(db, sessionToken);
        assertNamespace();
        const result = await work(db, memberId);
        assertNamespace();
        await checkConsoleSourceDeadlines(db);
        assertNamespace();
        return result;
      }, undefined, options);
      assertNamespace();
      return result;
    } catch (error) {
      if (error instanceof SourceAuthorityUnavailable || error instanceof OutsideCustodyRecoveryRequired) throw error;
      return requestDenied();
    } finally { release(); }
  }

  async previewDiscovery(sessionToken:string,input:{agentName:string;connectionName:string},options:{deadlineAtMs:number}):Promise<import('@lares/agent-kit/grant-store').OutsideUseCapture> {
    return this.#inMainNamespace(options,()=>this.#withHumanSession(sessionToken,async(db,memberId)=>
      captureOutsideHumanUse(db,memberId,input.agentName,input.connectionName),options));
  }

  /** No claim or bearer storage is permitted until the concrete private exchange exists. */
  async consentAndDiscover(sessionToken:string,input:{requestId:string;operationId:string;accountId:string;agentName:string;connectionName:string;
    expectedGeneration:number;expectedCandidateRevision:number|null;expectedDefinitionHash:string;expectedAccessRevision:number;
    expectedDestinationHash:string;expectedRoutePolicyHash:string;consentGeneration:number;credential:Buffer},
    options:{deadlineAtMs:number}):Promise<never>{
    try{
      await this.#requireConcreteExchange();
      const identity=await this.#claimDiscovery(sessionToken,input,options);
      await this.#phase2Authority(identity,sessionToken);
      return requestDenied();
    }finally{if(Buffer.isBuffer(input.credential))input.credential.fill(0);}
  }

  /** Terminal until the source-bound first-hop exchange is implemented and independently proven. */
  async #requireConcreteExchange():Promise<never>{return requestDenied();}

  /** Private phase-one writer. No action reaches this method while the concrete exchange is
   * absent; the only return is an opaque identity minted after a known new COMMIT. */
  async #claimDiscovery(sessionToken:string,input:{requestId:string;operationId:string;accountId:string;agentName:string;connectionName:string;
    expectedGeneration:number;expectedCandidateRevision:number|null;expectedDefinitionHash:string;expectedAccessRevision:number;
    expectedDestinationHash:string;expectedRoutePolicyHash:string;consentGeneration:number;credential:Buffer},
    options:{deadlineAtMs:number}):Promise<OutsideClaimIdentity>{
    return this.#inMainNamespace(options,async()=>{
      const release=this.#beginOperation(requestDenied);
      try{
        const requestId=uuid.parse(input.requestId),operationId=uuid.parse(input.operationId),accountId=uuid.parse(input.accountId);
        if(!Buffer.isBuffer(input.credential)||input.credential.length<1||input.credential.length>MAX_CREDENTIAL_BYTES||
            !Number.isSafeInteger(input.expectedGeneration)||input.expectedGeneration<0||input.expectedGeneration>Number.MAX_SAFE_INTEGER||
            input.expectedCandidateRevision!==null&&(!Number.isSafeInteger(input.expectedCandidateRevision)||input.expectedCandidateRevision<1)||
            !/^[a-f0-9]{64}$/.test(input.expectedDefinitionHash)||!Number.isSafeInteger(input.expectedAccessRevision)||input.expectedAccessRevision<1||
            !/^[a-f0-9]{64}$/.test(input.expectedDestinationHash)||!/^[a-f0-9]{64}$/.test(input.expectedRoutePolicyHash)||
            !Number.isSafeInteger(input.consentGeneration)||input.consentGeneration<1||input.consentGeneration>Number.MAX_SAFE_INTEGER)return requestDenied();
        const result=await this.#withHumanSession(sessionToken,async(db,memberId)=>{
          this.#assertOpen(requestDenied);
          const capture=await captureOutsideHumanUse(db,memberId,input.agentName,input.connectionName,
            {definitionHash:input.expectedDefinitionHash,accessRevision:input.expectedAccessRevision});
          if(capture.actor.memberId!==memberId||capture.agent.name!==input.agentName||capture.outside.connection.name!==input.connectionName)return requestDenied();
          const destination=capture.outside.connection.url;
          const destinationHash=createHash('sha256').update(canonicalJson(['lares-outside-endpoint-v1',destination])).digest('hex');
          if(destinationHash!==input.expectedDestinationHash||!this.routeLifecycle)return requestDenied();
          const namespaceClient=requireDefinitionNamespace();
          const route=await this.routeLifecycle.reviewOutsideRoute(destination,options.deadlineAtMs);
          this.#assertMainNamespace(namespaceClient,options.deadlineAtMs);
          if(route.policyHash!==input.expectedRoutePolicyHash)return requestDenied();
          const purpose='streamable-http-discovery-v1';
          const policyHash=outsideDiscoveryPolicyHash(capture,{ownerMemberId:memberId,accountId,agentName:input.agentName,
            connectionName:input.connectionName,destination,route,purpose});
          const policy={version:1,purpose,ownerMemberId:memberId,accountId,agentName:input.agentName,connectionName:input.connectionName,
            endpoint:destination,capture,route};
          const policyJson=canonicalJson(policy);
          if(Buffer.byteLength(policyJson)>8192)return requestDenied();
          const policyHashBytes=Buffer.from(policyHash,'hex');

          // Lock the immutable unique account identity before checking operation replay.
          const identity=await db.query<Head>(`SELECT account_id,owner_member_id,resource_id,connection_name,generation::text,
              active_revision::text,candidate_revision::text,consent_generation::text,state
            FROM outside_custody_accounts WHERE owner_member_id=$1 AND resource_id=$2 AND connection_name=$3 FOR UPDATE`,
            [memberId,input.agentName,input.connectionName]);
          if(identity.rows.length>1)return requestDenied();
          const byIdentity=identity.rows[0];
          let head:Head|undefined;
          let headConsentGeneration:number;
          if(byIdentity){
            if(byIdentity.account_id!==accountId||byIdentity.owner_member_id!==memberId||byIdentity.resource_id!==input.agentName||
                byIdentity.connection_name!==input.connectionName||byIdentity.state!=='active'||
                number(byIdentity.generation)!==input.expectedGeneration||
                (byIdentity.candidate_revision===null?null:number(byIdentity.candidate_revision))!==input.expectedCandidateRevision)return requestDenied();
            const latest=await db.query<{consent:string}>(`SELECT COALESCE(max(consent_generation),0)::text AS consent
              FROM outside_custody_revisions WHERE account_id=$1`,[accountId]);
            const lastConsent=Math.max(number(byIdentity.consent_generation),Number(latest.rows[0]?.consent??'0'));
            if(!Number.isSafeInteger(lastConsent)||lastConsent>=Number.MAX_SAFE_INTEGER||lastConsent+1!==input.consentGeneration)return requestDenied();
            headConsentGeneration=number(byIdentity.consent_generation);
            head=byIdentity;
          }else{
            const byAccount=await this.head(db,accountId,true);
            if(byAccount||input.expectedGeneration!==0||input.expectedCandidateRevision!==null||input.consentGeneration!==1)return requestDenied();
            headConsentGeneration=1;
          }

          const prior=await db.query<{operation_id:string}>(`SELECT operation_id FROM outside_custody_operations
            WHERE operation_id=$1 OR request_id=$2`,[operationId,requestId]);
          if(prior.rows.length!==0)return requestDenied();
          // Discovery reserves both its immutable claim and the eventual result row.
          await this.capacity(db,accountId,'discover',true,true);
          let generation:number,revision:number;
          if(head){
            generation=number(head.generation);
            const last=await db.query<{revision:string}>(`SELECT COALESCE(max(credential_revision),0)::text AS revision
              FROM outside_custody_revisions WHERE account_id=$1`,[accountId]);
            const previous=Number(last.rows[0]?.revision??'0');
            if(!Number.isSafeInteger(previous)||previous<0||previous>=Number.MAX_SAFE_INTEGER)return requestDenied();
            revision=previous+1;
          }else{
            generation=1;revision=1;
            const created=await db.query(`INSERT INTO outside_custody_accounts
              (account_id,owner_member_id,resource_id,connection_name,generation,consent_generation,state)
              VALUES($1,$2,$3,$4,1,$5,'active')`,[accountId,memberId,input.agentName,input.connectionName,input.consentGeneration]);
            if(created.rowCount!==1)return requestDenied();
          }
          const coordinates:BoundCoordinates={ownerMemberId:memberId,accountId,resourceId:input.agentName,connectionName:input.connectionName,
            generation,credentialRevision:revision,consentGeneration:input.consentGeneration,operationId,revisionPurpose:'discovery',policyHash};
          const encrypted=sealBound(this.key,input.credential,coordinates);
          await db.query(`INSERT INTO outside_custody_revisions
            (account_id,owner_member_id,credential_revision,generation,consent_generation,revision_purpose,policy_json,policy_hash,operation_id,nonce,ciphertext)
            VALUES($1,$2,$3,$4,$5,'discovery',$6::jsonb,$7,$8,$9,$10)`,
            [accountId,memberId,revision,generation,input.consentGeneration,policyJson,policyHashBytes,operationId,encrypted.nonce,encrypted.ciphertext]);
          const requestDigest=createHash('sha256').update(canonicalJson({requestId,operationId,accountId,memberId,agentName:input.agentName,
            connectionName:input.connectionName,expectedGeneration:input.expectedGeneration,expectedCandidateRevision:input.expectedCandidateRevision,
            expectedAccessRevision:input.expectedAccessRevision,expectedDestinationHash:input.expectedDestinationHash,
            expectedRoutePolicyHash:input.expectedRoutePolicyHash,consentGeneration:input.consentGeneration,policyHash,
            credentialHash:createHash('sha256').update(input.credential).digest('hex')})).digest();
          await db.query(`INSERT INTO outside_custody_operations
            (operation_id,account_id,owner_member_id,operation_kind,request_id,event_phase,request_hash,expected_generation,result_generation,credential_revision,outcome)
            VALUES($1,$2,$3,'discover',$4,'claim',$5,$6,$7,$8,'claimed')`,
            [operationId,accountId,memberId,requestId,requestDigest,input.expectedGeneration,generation,revision]);
          await checkConsoleSourceDeadlines(db);
          return {claim:{requestId,operationId,accountId,agentName:input.agentName,connectionName:input.connectionName,destination,policyHash,
            definitionHash:capture.agent.definitionHash,accessRevision:capture.agent.accessRevision},ownerMemberId:memberId,generation,
            expectedGeneration:input.expectedGeneration,
            activeRevision:head?.active_revision===null||head?.active_revision===undefined?null:number(head.active_revision),
            candidateRevision:head?.candidate_revision===null||head?.candidate_revision===undefined?null:number(head.candidate_revision),
            headConsentGeneration,consentGeneration:input.consentGeneration,credentialRevision:revision,
            routePolicyHash:route.policyHash,deadlineAtMs:options.deadlineAtMs} satisfies OutsideClaimIdentityState;
        },options);
        return this.#mintClaimIdentity(result);
      }catch(error){
        if(error instanceof OutsideCustodyRecoveryRequired)throw error;
        if(error instanceof SourceAuthorityUnavailable)throw new OutsideCustodyRecoveryRequired(input.operationId);
        return requestDenied();
      }finally{if(Buffer.isBuffer(input.credential))input.credential.fill(0);release();}
    });
  }

  /** Reauthorize an acknowledged claim on a fresh owned client. The concrete exchange and
   * result COMMIT intentionally do not exist at this checkpoint, so this private scope is
   * not invoked by the refusal path above or any registered action. */
  async #phase2Authority(identity:OutsideClaimIdentity,sessionToken:string):Promise<void>{
    // Spend the opaque receipt synchronously, before namespace admission or any other await.
    const state=this.#consumeClaimIdentity(identity);
    const lifecycle=this.routeLifecycle;
    if(!lifecycle)return requestDenied();
    await this.#inMainNamespace({deadlineAtMs:state.deadlineAtMs},async()=>{
      return lifecycle.withAppliedOutsideRoute(state.claim.destination,state.routePolicyHash,state.deadlineAtMs,async lease=>{
        const namespaceClient=requireDefinitionNamespace();
        await lease.assertCurrent();
        this.#assertMainNamespace(namespaceClient,state.deadlineAtMs);
        await this.#withHumanSession(sessionToken,async(db,memberId)=>{
          if(memberId!==state.ownerMemberId)return requestDenied();
          const capture=await captureOutsideHumanUse(db,memberId,state.claim.agentName,state.claim.connectionName,
            {definitionHash:state.claim.definitionHash,accessRevision:state.claim.accessRevision});
          const route=await lease.assertCurrent();
          this.#assertMainNamespace(namespaceClient,state.deadlineAtMs);
          if(outsideDiscoveryPolicyHash(capture,{ownerMemberId:memberId,accountId:state.claim.accountId,agentName:state.claim.agentName,
            connectionName:state.claim.connectionName,destination:state.claim.destination,route,purpose:'streamable-http-discovery-v1'})!==state.claim.policyHash)
            return requestDenied();
          const head=await this.head(db,state.claim.accountId,true);
          if(!head||head.owner_member_id!==state.ownerMemberId||head.resource_id!==state.claim.agentName||
              head.connection_name!==state.claim.connectionName||head.state!=='active'||number(head.generation)!==state.generation||
              (head.active_revision===null?null:number(head.active_revision))!==state.activeRevision||
              (head.candidate_revision===null?null:number(head.candidate_revision))!==state.candidateRevision||
              number(head.consent_generation)!==state.headConsentGeneration)return requestDenied();
          const claim=await db.query<{operation_id:string;expected_generation:string;result_generation:string;credential_revision:string;
            outcome:string;revision_generation:string;revision_consent_generation:string;revision_purpose:string;policy_hash:Buffer}>(`SELECT c.operation_id,c.expected_generation::text,c.result_generation::text,
              c.credential_revision::text,c.outcome,v.generation::text AS revision_generation,v.consent_generation::text AS revision_consent_generation,
              v.revision_purpose,v.policy_hash
            FROM outside_custody_operations c JOIN outside_custody_revisions v
              ON v.account_id=c.account_id AND v.credential_revision=c.credential_revision
            WHERE c.request_id=$1 AND c.operation_id=$2 AND c.account_id=$3 AND c.owner_member_id=$4
              AND c.event_phase='claim' AND c.operation_kind='discover'`,
            [state.claim.requestId,state.claim.operationId,state.claim.accountId,state.ownerMemberId]);
          const row=claim.rows[0];
          if(claim.rows.length!==1||!row||row.outcome!=='claimed'||Number(row.expected_generation)!==state.expectedGeneration||
              Number(row.result_generation)!==state.generation||Number(row.credential_revision)!==state.credentialRevision||
              Number(row.revision_generation)!==state.generation||Number(row.revision_consent_generation)!==state.consentGeneration||
              row.revision_purpose!=='discovery'||!row.policy_hash.equals(Buffer.from(state.claim.policyHash,'hex')))return requestDenied();
          const result=await db.query<{operation_id:string}>(`SELECT operation_id FROM outside_custody_operations
            WHERE request_id=$1 AND event_phase='result'`,[state.claim.requestId]);
          if(result.rows.length!==0)return requestDenied();
          await lease.assertCurrent();
          this.#assertMainNamespace(namespaceClient,state.deadlineAtMs);
          await checkConsoleSourceDeadlines(db);
        },{deadlineAtMs:state.deadlineAtMs});
        await lease.assertCurrent();
        this.#assertMainNamespace(namespaceClient,state.deadlineAtMs);
      });
    });
  }

  private async capacity(db:PoolClient,accountId:string,kind:OutsideOperationKind,createsRevision:boolean,reserveResult=false):Promise<void>{
    const operations=await db.query<{count:string}>("SELECT count(*)::text AS count FROM outside_custody_operations WHERE account_id=$1",[accountId]);
    this.#assertOpen(requestDenied);
    const count=Number(operations.rows[0]?.count??0);
    let outstandingResults=0;
    if(kind==="discover"&&reserveResult){
      const obligations=await db.query<{count:string}>(`SELECT count(*)::text AS count
        FROM outside_custody_operations c
        WHERE c.account_id=$1 AND c.operation_kind='discover' AND c.event_phase='claim'
          AND NOT EXISTS (
            SELECT 1 FROM outside_custody_operations r
            WHERE r.account_id=c.account_id AND r.owner_member_id=c.owner_member_id
              AND r.request_id=c.request_id AND r.operation_kind='discover' AND r.event_phase='result'
              AND r.outcome IN ('completed','unknown')
          )`,[accountId]);
      this.#assertOpen(requestDenied);
      outstandingResults=Number(obligations.rows[0]?.count??0);
    }
    const operationSlots=kind==="discover"&&reserveResult?2:1;
    const reservedTotal=count+outstandingResults+operationSlots;
    if(!Number.isSafeInteger(count)||count<0||!Number.isSafeInteger(outstandingResults)||outstandingResults<0||
        count>32||kind!=="revoke"&&reservedTotal>32)return requestDenied();
    if(createsRevision){
      const revisions=await db.query<{count:string}>("SELECT count(*)::text AS count FROM outside_custody_revisions WHERE account_id=$1",[accountId]);
      this.#assertOpen(requestDenied);
      const revisionCount=Number(revisions.rows[0]?.count??0);
      if(!Number.isSafeInteger(revisionCount)||revisionCount>=16)return requestDenied();
    }
  }

  private async current(db: PoolClient, binding: SourceBinding): Promise<number> {
    const current = await requireConsoleSessionBinding(binding, db as never);
    this.#assertOpen(requestDenied);
    const grant = await new PgGrantStore().captureUseWithExpiry(current.memberId, current.agent, { db: db as GrantDatabase });
    this.#assertOpen(requestDenied);
    if (!grant) return denied();
    retainConsoleSourceDeadline(db as never,current,grant.validUntil);
    return grant.accessRevision;
  }

  private async head(db: PoolClient, accountId: string, lock: boolean): Promise<Head | undefined> {
    const result = await db.query<Head>(`SELECT account_id,owner_member_id,resource_id,connection_name,generation::text,
        active_revision::text,candidate_revision::text,consent_generation::text,state
      FROM outside_custody_accounts WHERE account_id=$1${lock ? " FOR UPDATE" : ""}`,[accountId]);
    this.#assertOpen(requestDenied);
    return result.rows[0];
  }

  private async priorOperation(db: PoolClient, operationId: string, inputHash: Buffer, accountId: string, memberId:string,
    kind: OutsideOperationKind, expectedGeneration: number): Promise<OutsideOperationResult | undefined> {
    const prior = await db.query<{ account_id:string;owner_member_id:string;operation_kind:OutsideOperationKind;request_hash:Buffer;expected_generation:string;result_generation:string;credential_revision:string|null;outcome:OutsideOperationResult["outcome"] }>(
      "SELECT account_id,owner_member_id,operation_kind,request_hash,expected_generation::text,result_generation::text,credential_revision::text,outcome FROM outside_custody_operations WHERE operation_id=$1",[operationId]);
    this.#assertOpen(requestDenied);
    const row = prior.rows[0];
    if (!row) return undefined;
    if (row.account_id !== accountId || row.owner_member_id!==memberId || row.operation_kind !== kind || !sameBuffer(row.request_hash, inputHash) || Number(row.expected_generation) !== expectedGeneration) return requestDenied();
    return { operationId,accountId,kind,outcome:row.outcome,generation:number(row.result_generation),credentialRevision:row.credential_revision === null ? null : number(row.credential_revision) };
  }

  private async record(db: PoolClient, input: { operationId:string;accountId:string;ownerMemberId:string;kind:OutsideOperationKind;hash:Buffer;expected:number;result:number;revision:number|null;outcome:OutsideOperationResult["outcome"] }): Promise<OutsideOperationResult> {
    await db.query(`INSERT INTO outside_custody_operations
      (operation_id,account_id,owner_member_id,operation_kind,request_hash,expected_generation,result_generation,credential_revision,outcome)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[input.operationId,input.accountId,input.ownerMemberId,input.kind,input.hash,input.expected,input.result,input.revision,input.outcome]);
    this.#assertOpen(requestDenied);
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
    const release=this.#beginOperation(requestDenied);
    try{
      validBinding(binding);const accountId=uuid.parse(input.accountId),operationId=uuid.parse(input.operationId);
      if(!Number.isSafeInteger(input.expectedGeneration)||input.expectedGeneration<1||input.expectedGeneration>Number.MAX_SAFE_INTEGER)return requestDenied();
      try{
        const result=await consoleSourceTransaction(this.pool,async source=>{
        this.#assertOpen(requestDenied);
        const db=source as PoolClient;
        const currentConsent=await this.current(db,binding);
        const hash=requestHash("revoke",accountId,binding.memberId,binding.agent,input.expectedGeneration,null,null,currentConsent);
        const head=await this.head(db,accountId,true);
        if(head&&(head.owner_member_id!==binding.memberId||head.resource_id!==binding.agent))return requestDenied();
        const prior=await this.priorOperation(db,operationId,hash,accountId,binding.memberId,"revoke",input.expectedGeneration);if(prior){if(!head)return requestDenied();return prior;}
        if(!head||head.state!=="active"||number(head.generation)!==input.expectedGeneration)return requestDenied();
        await this.capacity(db,accountId,"revoke",false);
        this.#assertOpen(requestDenied);
        const next=input.expectedGeneration+1;
        const changed=await db.query("UPDATE outside_custody_accounts SET generation=$2,active_revision=NULL,candidate_revision=NULL,state='revoked',updated_at=clock_timestamp() WHERE account_id=$1 AND generation=$3 AND state='active'",[accountId,next,input.expectedGeneration]);
        this.#assertOpen(requestDenied);
        if(changed.rowCount!==1)return requestDenied();
        await checkConsoleSourceDeadlines(db);
        this.#assertOpen(requestDenied);
        return this.record(db,{operationId,accountId,ownerMemberId:binding.memberId,kind:"revoke",hash,expected:input.expectedGeneration,result:next,revision:null,outcome:"revoked"});
        },undefined,options);
        this.#assertOpen(requestDenied);
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
    const release=this.#beginOperation(requestDenied);
    try{
      validBinding(binding);const id=uuid.parse(operationId);
      try{
        const result=await consoleSourceTransaction(this.pool,async source=>{
        this.#assertOpen(requestDenied);
        const db=source as PoolClient;
        await this.current(db,binding);
        const row=await db.query<{account_id:string;owner_member_id:string;operation_kind:OutsideOperationKind;outcome:OutsideOperationResult["outcome"];result_generation:string;credential_revision:string|null}>(
          "SELECT account_id,owner_member_id,operation_kind,outcome,result_generation::text,credential_revision::text FROM outside_custody_operations WHERE operation_id=$1",[id]);
        this.#assertOpen(requestDenied);
        const operation=row.rows[0];if(!operation)return undefined;if(operation.owner_member_id!==binding.memberId)return denied();
        const head=await this.head(db,operation.account_id,false);
        if(!head||head.owner_member_id!==binding.memberId||head.resource_id!==binding.agent)return denied();
        return {operationId:id,accountId:operation.account_id,kind:operation.operation_kind,outcome:operation.outcome,generation:number(operation.result_generation),credentialRevision:operation.credential_revision===null?null:number(operation.credential_revision)};
        });
        this.#assertOpen(requestDenied);
        return result;
      }catch(error){if(error instanceof SourceAuthorityUnavailable)throw new OutsideCustodyRecoveryRequired(id);return denied();}
    }finally{release();}
  }

  /** Call after an uncertain transaction outcome; this inspects and never replays the operation. */
  async runAndRecover<T extends OutsideOperationResult>(operationId:string,run:()=>Promise<T>,inspect:()=>Promise<OutsideOperationResult|undefined>):Promise<T|OutsideOperationResult>{
    const release=this.#beginOperation(requestDenied);
    try{
      try{
        const result=await run();
        this.#assertOpen(requestDenied);
        return result;
      }catch(error){
        if(!(error instanceof OutsideCustodyRecoveryRequired))throw error;
        this.#assertOpen(requestDenied);
        const found=await inspect();this.#assertOpen(requestDenied);
        if(found&&found.operationId===operationId)return found;
        throw new OutsideCustodyRecoveryRequired(operationId);
      }
    }finally{release();}
  }
}
