/** Unregistered storage for third-party bearer credentials. It has no network or model API. */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { constants } from "node:fs";
import { isIP, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import type { Pool, PoolClient } from "pg";
import { Client, ProxyAgent, request, type Dispatcher } from "undici";
import { requireDefinitionNamespace, withDefinitionNamespace } from "./definition-namespace.js";
import type { AgentLifecycle } from "./lifecycle.js";
import type { SourceBinding, SourcePool } from "@lares/agent-kit/console-source-transaction";
import { checkConsoleSourceDeadlines, consoleSourceTransaction, gateConsoleOrganisation, requireSourceTransactionOwner, retainConsoleSourceDeadline, retainSourceTransactionDeadline, SourceAuthorityUnavailable, type SourceDatabase } from "@lares/agent-kit/console-source-transaction";
import { requireConsoleSessionBinding } from "@lares/agent-kit/console-turn-authority";
import { PgGrantStore, type GrantDatabase } from "@lares/agent-kit/grant-store";
import { consumeOutsideExecutionApproval, outsideExecutionApprovalSchema, outsidePayloadHash, type OutsideExecutionApproval } from "@lares/agent-kit/outside-execution-receipts";
import { currentMember } from "@lares/agent-kit/member-store";
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
export type OutsideOperationKind = "stage" | "apply" | "rollback" | "revoke" | "discover" | "publish" | "accept" | "activation-preview";
export type OutsideOperationResult = {
  operationId: string;
  accountId: string;
  kind: OutsideOperationKind;
  outcome: "staged" | "applied" | "rolled-back" | "revoked" | "claimed" | "completed" | "unknown" | "published" | "accepted" | "previewed";
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
  requestHash: string;
  routePolicyHash: string;
  deadlineAtMs: number;
  assertRuntimeCurrent?:()=>void;
  assertExecutionCurrent?:(db:PoolClient)=>Promise<void>;
};
type OutsideJson = null | boolean | number | string | OutsideJson[] | { [key: string]: OutsideJson };
type OutsideListedTool = { name: string; description?: string; inputSchema: { [key: string]: OutsideJson } };
type OutsideDiscoveryDocument = { protocolVersion: '2025-06-18'; serverInfo: { name: string; version: string }; tools: OutsideListedTool[] };
export type HumanDiscoveryTarget={agentName:string;connectionName:string};
export type HumanDiscoveryPreview={accountId:string;requestId:string;claimOperationId:string;agentName:string;connectionName:string;
  endpoint:string;purpose:'streamable-http-discovery-v1';definitionHash:string;accessRevision:number;destinationHash:string;
  routePolicyHash:string;expectedGeneration:number;expectedCandidateRevision:number|null;consentGeneration:number};
export type HumanDiscoveryInspection={state:'unresolved'}|{state:'complete';document:OutsideDiscoveryDocument};
/** Trusted Keeper-side identity supplied by the authenticated runtime transport. Never accept it
 *  from MCP tool arguments or use receipt selectors as a substitute for this binding. */
export type OutsideExecutionBinding={agent:string;incarnation:string;sessionId:string;memberId:string;approverMemberId:string;admissionNonce:string;policyRevision:number};
export type OutsideToolCallResult={content:OutsideJson[];isError?:boolean;structuredContent?:OutsideJson};
export type OutsideToolCallInput=Pick<OutsideExecutionApproval,'callId'|'requestId'|'sessionId'|'memberId'|'approverMemberId'|'agent'|'incarnation'|
  'definitionHash'|'connectionName'|'accountId'|'credentialRevision'|'toolName'> & {input:OutsideJson};
export type OutsideToolCallRequest=Pick<OutsideToolCallInput,'callId'|'connectionName'|'toolName'|'input'>;
type DescriptorProjection={version:1;connectionName:string;scope:'read'|'write'|'write-with-confirm';allow:string[];read:string[];tools:OutsideListedTool[]};
type StoredEvidence={operation_id:string;account_id:string;owner_member_id:string;actor_member_id:string|null;operation_kind:string;
  request_hash:Buffer;result_nonce:Buffer;result_ciphertext:Buffer;evidence_kind:string|null;evidence_hash:Buffer|null;outcome:string;
  expected_generation:string;result_generation:string;credential_revision:string|null};
type ActivationReviewV1={version:1;accountId:string;ownerMemberId:string;resourceId:string;connectionName:string;
  expectedGeneration:number;expectedCandidateRevision:number|null;sourceRevision:number;sourceRequestId:string;sourceClaimOperationId:string;
  publicationId:string;publicationHash:string;acceptanceId:string;acceptanceHash:string;policyHash:string;capture:unknown;
  route:{policyHash:string;sourceAddress:string;proxyUrl:string};consentGeneration:number};
type ActivationSelectors={accountId:string;agentName:string;connectionName:string;requestId:string;claimOperationId:string;
  publicationId:string;acceptanceId:string;expectedGeneration:number;expectedCandidateRevision:number|null;expectedConsentGeneration:number;
  expectedDefinitionHash:string;expectedAccessRevision:number;expectedPublicationHash:string;expectedAcceptanceHash:string;expectedPolicyHash?:string};
type DiscoveryRead={head:Head;capture:import('@lares/agent-kit/grant-store').OutsideUseCapture;document:OutsideDiscoveryDocument;
  requestId:string;claimOperationId:string;revision:number;consentGeneration:number;policyHash:string;policy:Record<string,unknown>};
const hashSchema=z.string().regex(/^[a-f0-9]{64}$/);
const memberIdSchema=z.string().min(1).max(256).regex(/^[^\s,;\x00-\x1f\x7f]+$/);
const descriptorProjectionSchema=z.strictObject({version:z.literal(1),connectionName:z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
  scope:z.enum(['read','write','write-with-confirm']),allow:z.array(z.string().min(1).max(256)).max(256),read:z.array(z.string().min(1).max(256)).max(256),
  tools:z.array(z.strictObject({name:z.string().min(1).max(256),description:z.string().max(8192).optional(),inputSchema:z.record(z.string(),z.unknown())})).max(256)});
const descriptorEditCaptureSchema=z.strictObject({version:z.literal(1),
  actor:z.strictObject({memberId:memberIdSchema,organisationId:z.string().min(1).max(256),role:z.enum(['owner','member','restricted'])}),
  agent:z.strictObject({name:z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),ownerMemberId:memberIdSchema,
    accessRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),definitionHash:z.string().min(1).max(256),connectionName:z.string().regex(/^[a-z][a-z0-9-]{1,30}$/)}),
  grant:z.union([z.strictObject({kind:z.literal('owner'),validUntil:z.null()}),z.strictObject({kind:z.literal('grant'),id:z.string().min(1).max(256),
    principal:z.strictObject({kind:z.literal('member'),id:memberIdSchema}),permission:z.literal('edit'),validUntil:z.string().datetime({offset:true}).nullable()})])});
const activationReviewSchema=z.strictObject({version:z.literal(1),accountId:uuid,ownerMemberId:memberIdSchema,resourceId:z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
  connectionName:z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),expectedGeneration:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expectedCandidateRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),sourceRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sourceRequestId:uuid,sourceClaimOperationId:uuid,publicationId:uuid,publicationHash:hashSchema,acceptanceId:uuid,acceptanceHash:hashSchema,
  policyHash:hashSchema,capture:descriptorEditCaptureSchema,route:z.strictObject({policyHash:hashSchema,sourceAddress:z.string().max(64),proxyUrl:z.string().max(256)}),
  consentGeneration:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)});
const outsideUseCaptureSchema=z.strictObject({version:z.literal(1),actor:z.strictObject({memberId:memberIdSchema,organisationId:z.string().min(1).max(256),
    role:z.enum(['owner','member','restricted'])}),agent:z.strictObject({name:z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),ownerMemberId:memberIdSchema,
    accessRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),definitionHash:z.string().min(1).max(256)}),
  ownerPolicy:z.union([z.strictObject({kind:z.literal('unrestricted')}),z.strictObject({kind:z.literal('ceiling'),requiredCapabilities:z.array(z.string().min(1).max(256)).max(256)})]),
  outside:z.strictObject({scope:z.enum(['read','write-with-confirm']),autonomy:z.enum(['gated','autonomous']),connection:z.strictObject({
    name:z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),url:z.string().max(2048),auth:z.literal('bearer'),allow:z.array(z.string().min(1).max(256)).max(256),
    read:z.array(z.string().min(1).max(256)).max(256),trusted:z.boolean(),runsAt:z.string().max(256).optional()})}),
  grant:z.union([z.strictObject({kind:z.literal('owner'),validUntil:z.null()}),z.strictObject({kind:z.literal('grant'),id:z.string().min(1).max(256),
    principal:z.strictObject({kind:z.enum(['member','organisation']),id:memberIdSchema}),permission:z.literal('use'),validUntil:z.string().datetime({offset:true}).nullable()})])});
const executablePolicySchema=z.strictObject({version:z.literal(1),purpose:z.literal('outside-executable-v1'),ownerMemberId:memberIdSchema,accountId:uuid,
  resourceId:z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),connectionName:z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),capture:outsideUseCaptureSchema,
  route:z.strictObject({policyHash:hashSchema,sourceAddress:z.string().max(64),proxyUrl:z.string().max(256)}),
  publication:z.strictObject({id:uuid,hash:hashSchema,descriptorDigest:hashSchema,acceptedScope:z.strictObject({scope:z.enum(['read','write','write-with-confirm']),
    allow:z.array(z.string().min(1).max(256)).max(256),read:z.array(z.string().min(1).max(256)).max(256)})}),
  acceptance:z.strictObject({id:uuid,hash:hashSchema,editorMemberId:memberIdSchema})});
const publicationEvidenceSchema=z.strictObject({version:z.literal(1),organisationId:z.string().min(1).max(256),actorMemberId:memberIdSchema,
  publicationHash:hashSchema,source:z.strictObject({requestId:uuid,claimOperationId:uuid,revision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    consentGeneration:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),policyHash:hashSchema}),
  definition:z.strictObject({hash:z.string().min(1).max(256),accessRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}),
  capture:z.record(z.string(),z.unknown()),projection:descriptorProjectionSchema});
const acceptanceEvidenceSchema=z.strictObject({version:z.literal(1),organisationId:z.string().min(1).max(256),editorMemberId:memberIdSchema,
  publicationId:uuid,publicationHash:hashSchema,resourceId:z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
  connectionName:z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),definitionHash:z.string().min(1).max(256),
  accessRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),grant:descriptorEditCaptureSchema.shape.grant});
const stagedEvidenceSchema=z.strictObject({version:z.literal(1),review:activationReviewSchema,reviewHash:hashSchema,
  candidateRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),candidateGeneration:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  consentGeneration:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),policyJson:executablePolicySchema});
function validateEvidenceBody(kind:string,body:unknown):Record<string,unknown>{
  const schema=kind==='descriptor-publication-v1'?publicationEvidenceSchema:
    kind==='descriptor-acceptance-v1'?acceptanceEvidenceSchema:activationReviewSchema;
  const parsed=schema.safeParse(body);if(!parsed.success)return denied();
  if(kind==='descriptor-publication-v1'){
    const value=parsed.data as z.infer<typeof publicationEvidenceSchema>;
    const projection=value.projection;
    const document=validateStoredDiscoveryDocument({protocolVersion:DISCOVERY_PROFILE.protocolVersion,
      serverInfo:{name:'outside-custody',version:'1'},tools:projection.tools});
    if(document.tools.length!==projection.tools.length)return denied();
  }
  return parsed.data as Record<string,unknown>;
}
const DISCOVERY_PROFILE = Object.freeze({
  version: 2,
  protocolVersion: '2025-06-18',
  parser: 'strict-json-sse-v1',
  operationTimeoutMs: 8000,
  transportTimeoutMs: 5000,
  connectTimeoutMs: 1000,
  idleTimeoutMs: 2000,
  cleanupReserveMs: 1000,
  responseBytes: 65536,
  totalResponseBytes: 262144,
  headerBytes: 8192,
  resultBytes: 65536,
  maxPages: 10,
  maxPosts: 12,
  maxCursorBytes: 1024,
  maxJsonDepth: 16,
  maxTools: 256,
  maxToolNameBytes: 128,
  maxRequestBytes: 16384,
  maxSessionIdBytes: 1024,
  maxCredentialBytes: 4096,
});
export type OutsideDiscoveryFailureStage = 'claim-admission' | 'claim-authority' | 'claim-capture' |
  'claim-route-review' | 'claim-storage' | 'authority-check' | 'initialize' | 'initialized-notification' |
  'tools-list' | 'persist-result' | 'cleanup';
export class OutsideCustodyRecoveryRequired extends Error {
  constructor(readonly operationId: string, readonly stage?: OutsideDiscoveryFailureStage) {
    super(REQUEST_REFUSED); this.name = "OutsideCustodyRecoveryRequired";
  }
}
/** Convert an uncertain discovery outcome without losing a known protocol stage. */
export function outsideDiscoveryRecovery(error:unknown,operationId:string,stage:OutsideDiscoveryFailureStage|undefined,
  dispatched=false):OutsideCustodyRecoveryRequired|undefined{
  if(error instanceof OutsideCustodyRecoveryRequired)return error.stage?error:new OutsideCustodyRecoveryRequired(operationId,stage);
  if(dispatched||error instanceof SourceAuthorityUnavailable)return new OutsideCustodyRecoveryRequired(operationId,stage);
  return undefined;
}
const denied = (): never => { throw new Error(REFUSED); };
const requestDenied = (): never => { throw new Error(REQUEST_REFUSED); };
function wipeRejectedCredentialInput(value:unknown):void{
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  const credential=(value as Record<string,unknown>).credential;
  if(Buffer.isBuffer(credential))credential.fill(0);
}

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
function openBound(key:Buffer,nonce:Buffer,ciphertext:Buffer,coordinates:BoundCoordinates):Buffer{
  if(!Buffer.isBuffer(key)||key.length!==32||!Buffer.isBuffer(nonce)||nonce.length!==12||
      !Buffer.isBuffer(ciphertext)||ciphertext.length<17||ciphertext.length>DISCOVERY_PROFILE.maxCredentialBytes+16)return denied();
  const decipher=createDecipheriv('aes-256-gcm',key,nonce);
  decipher.setAAD(boundAad(coordinates));
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length-16));
  const partial=decipher.update(ciphertext.subarray(0,ciphertext.length-16));
  try{return Buffer.concat([partial,decipher.final()]);}finally{partial.fill(0);}
}
function sealDiscoveryResult(key:Buffer,plaintext:Buffer,coordinates:{ownerMemberId:string;accountId:string;agentName:string;
  connectionName:string;requestId:string;claimOperationId:string;resultOperationId:string;generation:number;
  credentialRevision:number;consentGeneration:number;policyHash:string}):{nonce:Buffer;ciphertext:Buffer}{
  if(!Buffer.isBuffer(key)||key.length!==32||!Buffer.isBuffer(plaintext)||plaintext.length<1||plaintext.length>DISCOVERY_PROFILE.resultBytes)return denied();
  if(!uuid.safeParse(coordinates.accountId).success||!uuid.safeParse(coordinates.requestId).success||
      !uuid.safeParse(coordinates.claimOperationId).success||!uuid.safeParse(coordinates.resultOperationId).success||
      !/^[a-f0-9]{64}$/.test(coordinates.policyHash))return denied();
  const aadBytes=Buffer.from(canonicalJson(['lares-outside-discovery-result-v1',coordinates]));
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(aadBytes);
  return {nonce,ciphertext:Buffer.concat([cipher.update(plaintext),cipher.final(),cipher.getAuthTag()])};
}
function openDiscoveryResult(key:Buffer,nonce:Buffer,ciphertext:Buffer,coordinates:{ownerMemberId:string;accountId:string;agentName:string;
  connectionName:string;requestId:string;claimOperationId:string;resultOperationId:string;generation:number;
  credentialRevision:number;consentGeneration:number;policyHash:string}):Buffer{
  if(!Buffer.isBuffer(key)||key.length!==32||!Buffer.isBuffer(nonce)||nonce.length!==12||!Buffer.isBuffer(ciphertext)||
      ciphertext.length<17||ciphertext.length>DISCOVERY_PROFILE.resultBytes+16||!uuid.safeParse(coordinates.accountId).success||
      !uuid.safeParse(coordinates.requestId).success||!uuid.safeParse(coordinates.claimOperationId).success||
      !uuid.safeParse(coordinates.resultOperationId).success||!/^[a-f0-9]{64}$/.test(coordinates.policyHash))return denied();
  const decipher=createDecipheriv('aes-256-gcm',key,nonce);
  decipher.setAAD(Buffer.from(canonicalJson(['lares-outside-discovery-result-v1',coordinates])));
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length-16));
  const update=decipher.update(ciphertext.subarray(0,ciphertext.length-16));
  let final:Buffer|undefined;
  try{
    final=decipher.final();
    const plaintext=Buffer.concat([update,final]);
    if(plaintext.length<1||plaintext.length>DISCOVERY_PROFILE.resultBytes){plaintext.fill(0);return denied();}
    return plaintext;
  }finally{
    update.fill(0);
    final?.fill(0);
  }
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
function discoveryEndpoint(value:string):URL{
  if(typeof value!=='string'||value.length<1||Buffer.byteLength(value)>8192)return denied();
  let url:URL;
  try{url=new URL(value);}catch{return denied();}
  if(url.href!==value||url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||url.hash||
      !url.hostname||url.hostname.endsWith('.invalid'))return denied();
  return url;
}
function assertBoundedJson(value:unknown,depth=0):asserts value is OutsideJson{
  if(depth>DISCOVERY_PROFILE.maxJsonDepth)return denied();
  if(value===null||typeof value==='string'||typeof value==='boolean')return;
  if(typeof value==='number'&&Number.isFinite(value))return;
  if(Array.isArray(value)){for(const item of value)assertBoundedJson(item,depth+1);return;}
  if(value!==null&&typeof value==='object'){
    for(const item of Object.values(value as Record<string,unknown>))assertBoundedJson(item,depth+1);
    return;
  }
  return denied();
}
function validateStoredDiscoveryDocument(value:unknown):OutsideDiscoveryDocument{
  assertBoundedJson(value);
  if(!value||Array.isArray(value)||typeof value!=='object')return denied();
  const document=value as Record<string,OutsideJson>;
  if(Object.keys(document).sort().join(',')!=='protocolVersion,serverInfo,tools'||document.protocolVersion!==DISCOVERY_PROFILE.protocolVersion||
      !document.serverInfo||Array.isArray(document.serverInfo)||typeof document.serverInfo!=='object'||!Array.isArray(document.tools)||
      Object.keys(document.serverInfo).sort().join(',')!=='name,version')return denied();
  const serverInfo=projectOutsideServerInfo(document.serverInfo);
  if(document.tools.length>DISCOVERY_PROFILE.maxTools)return denied();
  const names=new Set<string>();
  const tools:OutsideListedTool[]=[];
  for(const candidate of document.tools){
    if(!candidate||Array.isArray(candidate)||typeof candidate!=='object')return denied();
    const item=candidate as Record<string,OutsideJson>;
    if(Object.keys(item).some(key=>!['name','description','inputSchema'].includes(key))||
        typeof item.name!=='string'||Buffer.byteLength(item.name)<1||Buffer.byteLength(item.name)>DISCOVERY_PROFILE.maxToolNameBytes||
        /[\x00-\x1f\x7f]/.test(item.name)||names.has(item.name)||item.description!==undefined&&
        (typeof item.description!=='string'||Buffer.byteLength(item.description)>2048)||!item.inputSchema||Array.isArray(item.inputSchema)||typeof item.inputSchema!=='object')return denied();
    names.add(item.name);
    tools.push({name:item.name,...(item.description===undefined?{}:{description:item.description as string}),inputSchema:item.inputSchema as {[key:string]:OutsideJson}});
  }
  const result={protocolVersion:DISCOVERY_PROFILE.protocolVersion,serverInfo,tools} satisfies OutsideDiscoveryDocument;
  if(Buffer.byteLength(canonicalJson(result))>DISCOVERY_PROFILE.resultBytes)return denied();
  return result;
}
function outsideIdentityText(value:unknown,maxBytes:number):string{
  if(typeof value!=='string'||value.length<1||Buffer.byteLength(value)>maxBytes||/[\x00-\x1f\x7f]/.test(value))return denied();
  return value;
}
function projectOutsideServerInfo(value:OutsideJson):OutsideDiscoveryDocument['serverInfo']{
  if(!value||Array.isArray(value)||typeof value!=='object')return denied();
  return {name:outsideIdentityText(value.name,128),version:outsideIdentityText(value.version,128)};
}
function outsideHeadersSize(headers:Record<string,string|string[]|undefined>):number{
  let size=0;
  for(const [name,value] of Object.entries(headers)){
    if(value===undefined)continue;
    for(const item of Array.isArray(value)?value:[value])size+=Buffer.byteLength(name)+2+Buffer.byteLength(item)+2;
    if(size>DISCOVERY_PROFILE.headerBytes)return denied();
  }
  return size;
}
function parseOutsideSse(payload:Buffer,expectedId:number):OutsideJson{
  const text=new TextDecoder('utf-8',{fatal:true}).decode(payload);
  const normalized=text.replace(/\r\n/g,'\n').replace(/\r/g,'\n');
  const blocks=normalized.split('\n\n');
  if(blocks.length!==2||blocks[1]!==''||!blocks[0])return denied();
  let event='message';const data:string[]=[];let sawEvent=false;
  for(const line of blocks[0]!.split('\n')){
    if(!line)continue;
    if(line.startsWith(':'))return denied();
    const colon=line.indexOf(':');const field=colon<0?line:line.slice(0,colon);
    const raw=colon<0?'':line.slice(colon+1);const fieldValue=raw.startsWith(' ')?raw.slice(1):raw;
    if(field==='event'&&!sawEvent){event=fieldValue;sawEvent=true;}
    else if(field==='data')data.push(fieldValue);
    else return denied();
  }
  if(event!=='message'||data.length<1)return denied();
  const parsed=JSON.parse(data.join('\n')) as unknown;
  assertBoundedJson(parsed);
  return requireOutsideRpc(parsed,expectedId);
}
function requireOutsideRpc(value:unknown,expectedId:number):OutsideJson{
  assertBoundedJson(value);
  if(!value||Array.isArray(value)||typeof value!=='object')return denied();
  const response=value as Record<string,OutsideJson>;
  if(response.jsonrpc!=='2.0'||response.id!==expectedId||!Object.hasOwn(response,'result')||Object.hasOwn(response,'error')||
      Object.hasOwn(response,'method')||Object.hasOwn(response,'params')||Object.keys(response).some(key=>!['jsonrpc','id','result'].includes(key)))return denied();
  return response.result!;
}
function parseOutsideJson(payload:Buffer,expectedId:number):OutsideJson{
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(payload)) as unknown;
  return requireOutsideRpc(value,expectedId);
}
function outsideSessionId(value:string|undefined):string|undefined{
  if(value===undefined)return undefined;
  if(Buffer.byteLength(value)<1||Buffer.byteLength(value)>DISCOVERY_PROFILE.maxSessionIdBytes||
      !/^[\x20-\x7e]+$/.test(value))return denied();
  return value;
}
function outsideBearer(value:Buffer):string{
  if(!Buffer.isBuffer(value)||value.length<1||value.length>DISCOVERY_PROFILE.maxCredentialBytes)return denied();
  const token=value.toString('ascii');
  if(!/^[A-Za-z0-9._~+/-]+=*$/.test(token)||!Buffer.from(token,'ascii').equals(value))return denied();
  return token;
}
function outsideDiscoveryPolicyHash(capture: import('@lares/agent-kit/grant-store').OutsideUseCapture,
  input:{ownerMemberId:string;accountId:string;agentName:string;connectionName:string;destination:string;
    route:{policyHash:string;sourceAddress:string;proxyUrl:string};purpose:string}): string {
  const {ownerMemberId,accountId,agentName,connectionName,destination,route,purpose}=input;
  const endpoint=discoveryEndpoint(destination);
  if(typeof purpose!=='string'||purpose.trim().length<1||purpose.length>200||purpose.trim()!==purpose||
      !/^[^\s,;\x00-\x1f\x7f]{1,256}$/.test(ownerMemberId)||!uuid.safeParse(accountId).success||
      !/^([a-z][a-z0-9-]{1,30})$/.test(agentName)||!/^([a-z][a-z0-9-]{1,30})$/.test(connectionName)||
      typeof destination!=='string'||destination.length<1||Buffer.byteLength(destination)>8192||
      !/^[a-f0-9]{64}$/.test(route.policyHash)||isIP(route.sourceAddress)!==4||route.proxyUrl!=='http://lares-egress-proxy:8888/') return denied();
  if(endpoint.href!==destination)return denied();
  return createHash('sha256').update(canonicalJson({version:DISCOVERY_PROFILE.version,profile:DISCOVERY_PROFILE,purpose,
    ownerMemberId,accountId,agentName,connectionName,endpoint:destination,capture,route})).digest('hex');
}
function projectDescriptorDocument(document:OutsideDiscoveryDocument,capture:import('@lares/agent-kit/grant-store').OutsideUseCapture):DescriptorProjection{
  const allowed=[...capture.outside.connection.allow].sort(),read=[...capture.outside.connection.read].sort();
  const byName=new Map(document.tools.map(tool=>[tool.name,tool]));
  if(byName.size!==document.tools.length||allowed.some(name=>!byName.has(name)))return denied();
  const tools=allowed.map(name=>{
    const tool=byName.get(name)!;
    return {name:tool.name,...(tool.description===undefined?{}:{description:tool.description}),inputSchema:tool.inputSchema};
  });
  const projection={version:1 as const,connectionName:capture.outside.connection.name,scope:capture.outside.scope,
    allow:allowed,read,tools};
  if(Buffer.byteLength(canonicalJson(projection))>DISCOVERY_PROFILE.resultBytes)return denied();
  return projection;
}
function evidenceAad(input:{accountId:string;ownerMemberId:string;resourceId:string;connectionName:string;operationId:string;kind:string;hash:string}):Buffer{
  if(!uuid.safeParse(input.accountId).success||!uuid.safeParse(input.operationId).success||
      !/^[^\s,;\x00-\x1f\x7f]{1,256}$/.test(input.ownerMemberId)||!/^([a-z][a-z0-9-]{1,30})$/.test(input.resourceId)||
      !/^([a-z][a-z0-9-]{1,30})$/.test(input.connectionName)||!['descriptor-publication-v1','descriptor-acceptance-v1','activation-review-v1'].includes(input.kind)||
      !/^[a-f0-9]{64}$/.test(input.hash))return denied();
  return Buffer.from(canonicalJson(['lares-outside-custody-evidence-v1',input]));
}
function sealEvidence(key:Buffer,body:unknown,input:Parameters<typeof evidenceAad>[0]):{nonce:Buffer;ciphertext:Buffer}{
  const plaintext=Buffer.from(canonicalJson(body));
  try{
    if(plaintext.length<1||plaintext.length>DISCOVERY_PROFILE.resultBytes)return denied();
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(evidenceAad(input));
    return {nonce,ciphertext:Buffer.concat([cipher.update(plaintext),cipher.final(),cipher.getAuthTag()])};
  }finally{plaintext.fill(0);}
}
function openEvidence(key:Buffer,nonce:Buffer,ciphertext:Buffer,input:Parameters<typeof evidenceAad>[0]):Buffer{
  if(!Buffer.isBuffer(nonce)||nonce.length!==12||!Buffer.isBuffer(ciphertext)||ciphertext.length<17||ciphertext.length>DISCOVERY_PROFILE.resultBytes+16)return denied();
  const decipher=createDecipheriv('aes-256-gcm',key,nonce);decipher.setAAD(evidenceAad(input));
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length-16));
  const first=decipher.update(ciphertext.subarray(0,ciphertext.length-16));
  try{return Buffer.concat([first,decipher.final()]);}catch(error){first.fill(0);throw error;}
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

  async #inMainNamespace<T>(options:{deadlineAtMs:number;operationId?:string},work:()=>Promise<T>):Promise<T>{
    this.#assertOpen(requestDenied);
    if(!this.mainPool||!this.routeLifecycle||!Number.isFinite(options.deadlineAtMs)||options.deadlineAtMs<=Date.now())return requestDenied();
    try{return await withDefinitionNamespace(this.mainPool,async namespaceClient=>{
      this.#assertOpen(requestDenied);
      if(options.deadlineAtMs<=Date.now()||requireDefinitionNamespace()!==namespaceClient)return requestDenied();
      const result=await work();
      this.#assertOpen(requestDenied);
      if(options.deadlineAtMs<=Date.now()||requireDefinitionNamespace()!==namespaceClient)return requestDenied();
      return result;
    },{deadlineAtMs:options.deadlineAtMs});}
    catch(error){if(error instanceof SourceAuthorityUnavailable&&options.operationId)throw new OutsideCustodyRecoveryRequired(options.operationId);throw error;}
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
  async #withHumanSession<T>(sessionToken: string, work: (db: PoolClient, memberId: string) => Promise<T>, options: { deadlineAtMs: number; operationId?:string }): Promise<T> {
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
      if(error instanceof SourceAuthorityUnavailable&&options.operationId)throw new OutsideCustodyRecoveryRequired(options.operationId);
      if (error instanceof SourceAuthorityUnavailable || error instanceof OutsideCustodyRecoveryRequired) throw error;
      return requestDenied();
    } finally { release(); }
  }

  async #humanOrganisation(db:PoolClient,memberId:string):Promise<{id:string;role:string}>{
    const result=await db.query<{id:string;role:string}>("SELECT org_id AS id,org_role AS role FROM users WHERE id=$1 AND status='active' AND org_id IS NOT NULL",[memberId]);
    const row=result.rows[0];
    if(result.rows.length!==1||!row||typeof row.id!=='string'||typeof row.role!=='string')return denied();
    return row;
  }

  async #lockSameOrganisationMember(db:PoolClient,memberId:string,organisationId:string,alreadyLocked:string):Promise<void>{
    if(memberId===alreadyLocked)return;
    if(!/^[^\s,;\x00-\x1f\x7f]{1,256}$/.test(memberId)||!organisationId)return denied();
    const result=await db.query<{id:string;org_id:string;org_role:string;status:string}>(
      "SELECT id,org_id,org_role,status FROM users WHERE id=$1 AND org_id=$2 AND status='active' FOR SHARE",[memberId,organisationId]);
    const row=result.rows[0];
    if(result.rows.length!==1||row?.id!==memberId||row.org_id!==organisationId||row.status!=='active'||
        !['owner','member','restricted'].includes(row.org_role))return denied();
  }

  async #captureDescriptorEditor(db:PoolClient,editorMemberId:string,actingMemberId:string,organisationId:string,agentName:string,
    connectionName:string,expected?:{definitionHash:string;accessRevision:number}):Promise<import('@lares/agent-kit/grant-store').OutsideDescriptorEditCapture>{
    await this.#lockSameOrganisationMember(db,editorMemberId,organisationId,actingMemberId);
    const capture=await new PgGrantStore().captureOutsideDescriptorEdit(editorMemberId,agentName,
      {db:db as GrantDatabase,connectionName,...(expected?{expected}:{})});
    if(!capture||capture.actor.memberId!==editorMemberId||capture.actor.organisationId!==organisationId||
        capture.agent.name!==agentName||capture.agent.connectionName!==connectionName)return denied();
    if(capture.grant.kind==='grant'&&capture.grant.validUntil!==null)retainSourceTransactionDeadline(db,capture.grant.validUntil);
    await checkConsoleSourceDeadlines(db);
    return capture;
  }

  async previewDiscovery(sessionToken:string,input:{agentName:string;connectionName:string},options:{deadlineAtMs:number}):Promise<import('@lares/agent-kit/grant-store').OutsideUseCapture> {
    return this.#inMainNamespace(options,()=>this.#withHumanSession(sessionToken,async(db,memberId)=>
      captureOutsideHumanUse(db,memberId,input.agentName,input.connectionName),options));
  }

  async listHumanDiscoveryTargets(sessionToken:string,options:{deadlineAtMs:number}):Promise<HumanDiscoveryTarget[]>{
    return this.#inMainNamespace(options,()=>this.#withHumanSession(sessionToken,async(db,memberId)=>
      new PgGrantStore().listHumanOutsideDiscoveryTargets(memberId,{db:db as GrantDatabase}),options));
  }

  async previewHumanDiscovery(sessionToken:string,input:{agentName:string;connectionName:string},options:{deadlineAtMs:number}):Promise<HumanDiscoveryPreview>{
    return this.#inMainNamespace(options,()=>this.#withHumanSession(sessionToken,async(db,memberId)=>{
      const capture=await captureOutsideHumanUse(db,memberId,input.agentName,input.connectionName);
      if(capture.actor.memberId!==memberId||capture.agent.name!==input.agentName||capture.outside.connection.name!==input.connectionName)return denied();
      const namespaceClient=requireDefinitionNamespace();
      const endpoint=capture.outside.connection.url;
      const route=await this.routeLifecycle!.reviewOutsideRoute(endpoint,options.deadlineAtMs);
      this.#assertMainNamespace(namespaceClient,options.deadlineAtMs);
      const destinationHash=createHash('sha256').update(canonicalJson(['lares-outside-endpoint-v1',endpoint])).digest('hex');
      const identity=await db.query<Head>(`SELECT account_id,owner_member_id,resource_id,connection_name,generation::text,
          active_revision::text,candidate_revision::text,consent_generation::text,state
        FROM outside_custody_accounts WHERE owner_member_id=$1 AND resource_id=$2 AND connection_name=$3 FOR SHARE`,
        [memberId,input.agentName,input.connectionName]);
      if(identity.rows.length>1)return denied();
      const head=identity.rows[0];
      if(head&&(head.account_id.length===0||head.owner_member_id!==memberId||head.resource_id!==input.agentName||
          head.connection_name!==input.connectionName||head.state!=='active'))return denied();
      const accountId=head?.account_id??randomUUID();
      let expectedGeneration=0,expectedCandidateRevision:number|null=null,consentGeneration=1;
      if(head){
        expectedGeneration=number(head.generation);
        expectedCandidateRevision=head.candidate_revision===null?null:number(head.candidate_revision);
        const latest=await db.query<{consent:string}>(`SELECT COALESCE(max(consent_generation),0)::text AS consent
          FROM outside_custody_revisions WHERE account_id=$1`,[accountId]);
        const lastConsent=Math.max(number(head.consent_generation),Number(latest.rows[0]?.consent??'0'));
        if(!Number.isSafeInteger(lastConsent)||lastConsent<1||lastConsent>=Number.MAX_SAFE_INTEGER)return denied();
        consentGeneration=lastConsent+1;
      }
      if(!Number.isSafeInteger(expectedGeneration)||expectedGeneration<0||expectedGeneration>Number.MAX_SAFE_INTEGER||
          expectedCandidateRevision!==null&&(!Number.isSafeInteger(expectedCandidateRevision)||expectedCandidateRevision<1))return denied();
      return {accountId,requestId:randomUUID(),claimOperationId:randomUUID(),agentName:input.agentName,connectionName:input.connectionName,
        endpoint,purpose:'streamable-http-discovery-v1',definitionHash:capture.agent.definitionHash,accessRevision:capture.agent.accessRevision,
        destinationHash,routePolicyHash:route.policyHash,expectedGeneration,expectedCandidateRevision,consentGeneration};
    },options));
  }

  async #readDiscoveryOnClient(db:PoolClient,memberId:string,input:{accountId:string;agentName:string;connectionName:string;requestId:string;claimOperationId:string},
    organisationId:string,lock:'share'|'update'='share'):Promise<DiscoveryRead>{
    const accountId=uuid.parse(input.accountId),requestId=uuid.parse(input.requestId),claimOperationId=uuid.parse(input.claimOperationId);
    const capture=await captureOutsideHumanUse(db,memberId,input.agentName,input.connectionName);
    const identity=await db.query<Head>(`SELECT account_id,owner_member_id,resource_id,connection_name,generation::text,
        active_revision::text,candidate_revision::text,consent_generation::text,state
      FROM outside_custody_accounts WHERE account_id=$1 AND owner_member_id=$2 AND resource_id=$3 AND connection_name=$4 FOR ${lock}`,
      [accountId,memberId,input.agentName,input.connectionName]);
    const head=identity.rows[0];
    if(identity.rows.length!==1||!head||head.account_id!==accountId||head.owner_member_id!==memberId||head.resource_id!==input.agentName||
        head.connection_name!==input.connectionName||head.state!=='active'||capture.actor.organisationId!==organisationId)return denied();
    const claim=await db.query<StoredEvidence & {request_id:string;policy_json:string;policy_hash:Buffer;revision_purpose:string;revision_generation:string;
      revision_consent_generation:string;claim_nonce:Buffer;claim_ciphertext:Buffer}>(`SELECT c.operation_id,c.account_id,c.owner_member_id,NULL::text AS actor_member_id,
        c.operation_kind,c.request_hash,c.result_nonce,c.result_ciphertext,NULL::text AS evidence_kind,NULL::bytea AS evidence_hash,c.outcome,
        c.expected_generation::text,c.result_generation::text,c.credential_revision::text,c.request_id,v.policy_json::text,v.policy_hash,
        v.revision_purpose,v.generation::text AS revision_generation,v.consent_generation::text AS revision_consent_generation,
        v.nonce AS claim_nonce,v.ciphertext AS claim_ciphertext
      FROM outside_custody_operations c LEFT JOIN outside_custody_revisions v
        ON v.account_id=c.account_id AND v.credential_revision=c.credential_revision AND v.operation_id=c.operation_id
      WHERE c.request_id=$1 AND c.operation_id=$2 AND c.account_id=$3 AND c.owner_member_id=$4 AND c.event_phase='claim'`,
      [requestId,claimOperationId,accountId,memberId]);
    const row=claim.rows[0];
    if(claim.rows.length!==1||!row||row.operation_id!==claimOperationId||row.operation_kind!=='discover'||row.request_id!==requestId||
        row.credential_revision===null||row.revision_purpose!=='discovery'||!Buffer.isBuffer(row.policy_hash)||row.policy_hash.length!==32||
        !Buffer.isBuffer(row.request_hash)||row.request_hash.length!==32||row.outcome!=='claimed')return denied();
    let policy:unknown;try{policy=JSON.parse(row.policy_json) as unknown;}catch{return denied();}
    if(!policy||Array.isArray(policy)||typeof policy!=='object')return denied();
    const p=policy as Record<string,unknown>;
    if(Object.keys(p).sort().join(',')!=='accountId,agentName,capture,connectionName,endpoint,ownerMemberId,profile,purpose,route,version'||
        p.version!==DISCOVERY_PROFILE.version||p.purpose!=='streamable-http-discovery-v1'||p.ownerMemberId!==memberId||p.accountId!==accountId||
        p.agentName!==input.agentName||p.connectionName!==input.connectionName||p.endpoint!==capture.outside.connection.url||
        canonicalJson(p.profile)!==canonicalJson(DISCOVERY_PROFILE)||canonicalJson(p.capture)!==canonicalJson(capture))return denied();
    const route=p.route as Record<string,unknown>|null;
    if(!route||Array.isArray(route)||typeof route!=='object'||Object.keys(route).sort().join(',')!=='policyHash,proxyUrl,sourceAddress'||
        typeof route.policyHash!=='string'||typeof route.sourceAddress!=='string'||typeof route.proxyUrl!=='string')return denied();
    const routeReview={policyHash:route.policyHash,sourceAddress:route.sourceAddress,proxyUrl:route.proxyUrl};
    const policyHash=outsideDiscoveryPolicyHash(capture,{ownerMemberId:memberId,accountId,agentName:input.agentName,connectionName:input.connectionName,
      destination:capture.outside.connection.url,route:routeReview,purpose:'streamable-http-discovery-v1'});
    if(policyHash!==row.policy_hash.toString('hex')||number(row.revision_generation)!==number(row.result_generation))return denied();
    const result=await db.query<StoredEvidence & {request_id:string;event_phase:string}>(`SELECT operation_id,account_id,owner_member_id,NULL::text AS actor_member_id,
        operation_kind,request_hash,result_nonce,result_ciphertext,NULL::text AS evidence_kind,NULL::bytea AS evidence_hash,outcome,
        expected_generation::text,result_generation::text,credential_revision::text,request_id,event_phase
      FROM outside_custody_operations WHERE request_id=$1 AND account_id=$2 AND owner_member_id=$3 AND event_phase='result'`,[requestId,accountId,memberId]);
    const stored=result.rows[0];
    if(result.rows.length!==1||!stored||stored.operation_kind!=='discover'||stored.outcome!=='completed'||stored.request_id!==requestId||
        !stored.request_hash.equals(row.request_hash)||stored.credential_revision!==row.credential_revision||
        !Buffer.isBuffer(stored.result_nonce)||!Buffer.isBuffer(stored.result_ciphertext))return denied();
    const revision=number(row.credential_revision),consentGeneration=number(row.revision_consent_generation);
    const plaintext=openDiscoveryResult(this.key,stored.result_nonce,stored.result_ciphertext,{ownerMemberId:memberId,accountId,agentName:input.agentName,
      connectionName:input.connectionName,requestId,claimOperationId,resultOperationId:stored.operation_id,generation:number(row.result_generation),
      credentialRevision:revision,consentGeneration,policyHash});
    try{
      let document:unknown;try{document=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext)) as unknown;}catch{return denied();}
      return {head,capture,document:validateStoredDiscoveryDocument(document),requestId,claimOperationId,revision,consentGeneration,policyHash,policy:p};
    }finally{plaintext.fill(0);}
  }

  async inspectHumanDiscovery(sessionToken:string,input:{accountId:string;agentName:string;connectionName:string;requestId:string;claimOperationId:string},
    options:{deadlineAtMs:number}):Promise<HumanDiscoveryInspection>{
    const accountId=uuid.parse(input.accountId),requestId=uuid.parse(input.requestId),claimOperationId=uuid.parse(input.claimOperationId);
    return this.#inMainNamespace(options,()=>this.#withHumanSession(sessionToken,async(db,memberId)=>{
      const capture=await captureOutsideHumanUse(db,memberId,input.agentName,input.connectionName);
      const identity=await db.query<Head>(`SELECT account_id,owner_member_id,resource_id,connection_name,generation::text,
          active_revision::text,candidate_revision::text,consent_generation::text,state
        FROM outside_custody_accounts WHERE account_id=$1 AND owner_member_id=$2 AND resource_id=$3 AND connection_name=$4 FOR SHARE`,
        [accountId,memberId,input.agentName,input.connectionName]);
      if(identity.rows.length===0)return {state:'unresolved'};
      if(identity.rows.length!==1||identity.rows[0]!.account_id!==accountId||identity.rows[0]!.owner_member_id!==memberId||
          identity.rows[0]!.resource_id!==input.agentName||identity.rows[0]!.connection_name!==input.connectionName)return denied();
      const claim=await db.query<{operation_id:string;account_id:string;owner_member_id:string;operation_kind:string;request_id:string;
        expected_generation:string;result_generation:string;credential_revision:string|null;outcome:string;request_hash:Buffer;
        revision_generation:string;revision_consent_generation:string;revision_purpose:string;policy_hash:Buffer;policy_json:string;
        claim_nonce:Buffer;claim_ciphertext:Buffer}>(`SELECT c.operation_id,c.account_id,c.owner_member_id,c.operation_kind,c.request_id,
          c.expected_generation::text,c.result_generation::text,c.credential_revision::text,c.outcome,c.request_hash,
          v.generation::text AS revision_generation,v.consent_generation::text AS revision_consent_generation,
          v.revision_purpose,v.policy_hash,v.policy_json::text,v.nonce AS claim_nonce,v.ciphertext AS claim_ciphertext
        FROM outside_custody_operations c LEFT JOIN outside_custody_revisions v
          ON v.account_id=c.account_id AND v.credential_revision=c.credential_revision AND v.operation_id=c.operation_id
        WHERE c.request_id=$1 AND c.operation_id=$2 AND c.account_id=$3 AND c.owner_member_id=$4 AND c.event_phase='claim'`,
        [requestId,claimOperationId,accountId,memberId]);
      if(claim.rows.length===0)return {state:'unresolved'};
      const row=claim.rows[0]!;
      if(claim.rows.length!==1||row.operation_id!==claimOperationId||row.account_id!==accountId||row.owner_member_id!==memberId||
          row.operation_kind!=='discover'||row.request_id!==requestId||row.credential_revision===null||row.revision_generation===undefined||
          row.revision_consent_generation===undefined||row.revision_purpose!=='discovery'||!Buffer.isBuffer(row.policy_hash)||
          row.policy_hash.length!==32||!row.request_hash||row.request_hash.length!==32)return denied();
      if(row.outcome!=='claimed')return {state:'unresolved'};
      let policy:unknown;
      try{policy=JSON.parse(row.policy_json) as unknown;}catch{return denied();}
      if(!policy||Array.isArray(policy)||typeof policy!=='object')return denied();
      const p=policy as Record<string,unknown>;
      if(Object.keys(p).sort().join(',')!=='accountId,agentName,capture,connectionName,endpoint,ownerMemberId,profile,purpose,route,version'||
          p.version!==DISCOVERY_PROFILE.version||p.purpose!=='streamable-http-discovery-v1'||p.ownerMemberId!==memberId||p.accountId!==accountId||
          p.agentName!==input.agentName||p.connectionName!==input.connectionName||p.endpoint!==capture.outside.connection.url||
          canonicalJson(p.profile)!==canonicalJson(DISCOVERY_PROFILE)||canonicalJson(p.capture)!==canonicalJson(capture))return denied();
      const route=p.route as Record<string,unknown>|null;
      if(!route||Array.isArray(route)||typeof route!=='object'||Object.keys(route).sort().join(',')!=='policyHash,proxyUrl,sourceAddress'||
          typeof route.policyHash!=='string'||typeof route.sourceAddress!=='string'||typeof route.proxyUrl!=='string')return denied();
      const routeReview={policyHash:route.policyHash,sourceAddress:route.sourceAddress,proxyUrl:route.proxyUrl};
      if(outsideDiscoveryPolicyHash(capture,{ownerMemberId:memberId,accountId,agentName:input.agentName,connectionName:input.connectionName,
          destination:capture.outside.connection.url,route:routeReview,purpose:'streamable-http-discovery-v1'})!==row.policy_hash.toString('hex'))return denied();
      if(Number(row.revision_generation)!==number(row.result_generation)||Number(row.revision_consent_generation)<1||
          !Number.isSafeInteger(Number(row.revision_consent_generation)))return denied();
      const result=await db.query<{operation_id:string;account_id:string;owner_member_id:string;operation_kind:string;request_id:string;
        event_phase:string;request_hash:Buffer;expected_generation:string;result_generation:string;credential_revision:string|null;
        outcome:string;result_nonce:Buffer|null;result_ciphertext:Buffer|null}>(`SELECT operation_id,account_id,owner_member_id,operation_kind,request_id,event_phase,request_hash,
          expected_generation::text,result_generation::text,credential_revision::text,outcome,result_nonce,result_ciphertext
        FROM outside_custody_operations WHERE request_id=$1 AND account_id=$2 AND owner_member_id=$3 AND event_phase='result'`,
        [requestId,accountId,memberId]);
      if(result.rows.length===0)return {state:'unresolved'};
      const stored=result.rows[0]!;
      if(result.rows.length!==1||stored.operation_kind!=='discover'||stored.request_id!==requestId||stored.account_id!==accountId||
          stored.owner_member_id!==memberId||stored.event_phase!=='result'||stored.outcome!=='completed')return {state:'unresolved'};
      if(!stored.operation_id||!uuid.safeParse(stored.operation_id).success||!stored.request_hash.equals(row.request_hash)||
          Number(stored.expected_generation)!==Number(row.expected_generation)||Number(stored.result_generation)!==Number(row.result_generation)||
          stored.credential_revision!==row.credential_revision||!Buffer.isBuffer(stored.result_nonce)||!Buffer.isBuffer(stored.result_ciphertext))return denied();
      const generation=number(row.result_generation),credentialRevision=number(row.credential_revision),consentGeneration=number(row.revision_consent_generation);
      const plaintext=openDiscoveryResult(this.key,stored.result_nonce,stored.result_ciphertext,{ownerMemberId:memberId,accountId,
        agentName:input.agentName,connectionName:input.connectionName,requestId,claimOperationId,resultOperationId:stored.operation_id,
        generation,credentialRevision,consentGeneration,policyHash:row.policy_hash.toString('hex')});
      try{
        let document:unknown;
        try{document=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext)) as unknown;}catch{return denied();}
        return {state:'complete',document:validateStoredDiscoveryDocument(document)};
      }finally{plaintext.fill(0);}
    },options));
  }

  /** Starts only when the configured Keeper runtime has the owned exchange prerequisites. */
  async consentAndDiscover(sessionToken:string,input:{requestId:string;operationId:string;accountId:string;agentName:string;connectionName:string;
    expectedGeneration:number;expectedCandidateRevision:number|null;expectedDefinitionHash:string;expectedAccessRevision:number;
    expectedDestinationHash:string;expectedRoutePolicyHash:string;consentGeneration:number;credential:Buffer},
    options:{deadlineAtMs:number}):Promise<OutsideDiscoveryDocument>{
    const admittedAtMs=Date.now();
    try{
      this.#requireConcreteExchange();
      if(!Number.isFinite(options.deadlineAtMs))return requestDenied();
      const deadlineAtMs=Math.min(options.deadlineAtMs,admittedAtMs+DISCOVERY_PROFILE.operationTimeoutMs);
      if(!Number.isFinite(deadlineAtMs)||deadlineAtMs<=Date.now())return requestDenied();
      const boundedOptions={deadlineAtMs};
      return await this.#inMainNamespace(boundedOptions,async()=>{
        const progress:{dispatched:boolean;stage?:OutsideDiscoveryFailureStage}={dispatched:false,stage:'claim-admission'};
        const identity=await this.#claimDiscovery(sessionToken,input,boundedOptions,progress);
        return this.#phase2Authority(identity,sessionToken);
      });
    }finally{if(Buffer.isBuffer(input.credential))input.credential.fill(0);}
  }

  /** Structural availability only; normal consent, route, claim and result checks still authorize use. */
  #requireConcreteExchange():void{
    this.#assertOpen(requestDenied);
    if(!this.mainPool||typeof this.pool?.connect!=="function"||!this.routeLifecycle)return requestDenied();
  }

  /** Private phase-one writer. It returns only an opaque identity minted after a known new COMMIT. */
  async #claimDiscovery(sessionToken:string,input:{requestId:string;operationId:string;accountId:string;agentName:string;connectionName:string;
    expectedGeneration:number;expectedCandidateRevision:number|null;expectedDefinitionHash:string;expectedAccessRevision:number;
    expectedDestinationHash:string;expectedRoutePolicyHash:string;consentGeneration:number;credential:Buffer},
    options:{deadlineAtMs:number},progress:{dispatched:boolean;stage?:OutsideDiscoveryFailureStage}):Promise<OutsideClaimIdentity>{
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
        progress.stage='claim-authority';
        const result=await this.#withHumanSession(sessionToken,async(db,memberId)=>{
          this.#assertOpen(requestDenied);
          progress.stage='claim-capture';
          const capture=await captureOutsideHumanUse(db,memberId,input.agentName,input.connectionName,
            {definitionHash:input.expectedDefinitionHash,accessRevision:input.expectedAccessRevision});
          if(capture.actor.memberId!==memberId||capture.agent.name!==input.agentName||capture.outside.connection.name!==input.connectionName)return requestDenied();
          const destination=capture.outside.connection.url;
          const destinationHash=createHash('sha256').update(canonicalJson(['lares-outside-endpoint-v1',destination])).digest('hex');
          if(destinationHash!==input.expectedDestinationHash||!this.routeLifecycle)return requestDenied();
          const namespaceClient=requireDefinitionNamespace();
          progress.stage='claim-route-review';
          const route=await this.routeLifecycle.reviewOutsideRoute(destination,options.deadlineAtMs);
          this.#assertMainNamespace(namespaceClient,options.deadlineAtMs);
          if(route.policyHash!==input.expectedRoutePolicyHash)return requestDenied();
          const purpose='streamable-http-discovery-v1';
          const policyHash=outsideDiscoveryPolicyHash(capture,{ownerMemberId:memberId,accountId,agentName:input.agentName,
            connectionName:input.connectionName,destination,route,purpose});
          const policy={version:DISCOVERY_PROFILE.version,profile:DISCOVERY_PROFILE,purpose,ownerMemberId:memberId,accountId,
            agentName:input.agentName,connectionName:input.connectionName,endpoint:destination,capture,route};
          const policyJson=canonicalJson(policy);
          if(Buffer.byteLength(policyJson)>8192)return requestDenied();
          const policyHashBytes=Buffer.from(policyHash,'hex');

          // Lock the immutable unique account identity before checking operation replay.
          progress.stage='claim-storage';
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
            headConsentGeneration,consentGeneration:input.consentGeneration,credentialRevision:revision,requestHash:requestDigest.toString('hex'),
            routePolicyHash:route.policyHash,deadlineAtMs:options.deadlineAtMs} satisfies OutsideClaimIdentityState;
        },options);
        return this.#mintClaimIdentity(result);
      }catch(error){
        const recovery=outsideDiscoveryRecovery(error,input.operationId,progress.stage);
        if(recovery)throw recovery;
        return requestDenied();
      }finally{if(Buffer.isBuffer(input.credential))input.credential.fill(0);release();}
    });
  }

  /** Concrete transport is private to the owned Keeper transaction and has no caller URL or route inputs. */
  async #exchangeDiscovery(db:PoolClient,state:OutsideClaimIdentityState,lease:import('./lifecycle.js').OutsideRouteLease,
    credential:Buffer,progress:{dispatched:boolean;stage?:OutsideDiscoveryFailureStage}):Promise<OutsideDiscoveryDocument>;
  async #exchangeDiscovery(db:PoolClient,state:OutsideClaimIdentityState,lease:import('./lifecycle.js').OutsideRouteLease,
    credential:Buffer,progress:{dispatched:boolean;stage?:OutsideDiscoveryFailureStage},toolCall:{name:string;input:OutsideJson}):Promise<OutsideToolCallResult>;
  async #exchangeDiscovery(db:PoolClient,state:OutsideClaimIdentityState,lease:import('./lifecycle.js').OutsideRouteLease,
    credential:Buffer,progress:{dispatched:boolean;stage?:OutsideDiscoveryFailureStage},toolCall?:{name:string;input:OutsideJson}):Promise<OutsideDiscoveryDocument|OutsideToolCallResult>{
    const endpoint=discoveryEndpoint(state.claim.destination);
    const networkDeadlineAtMs=Math.min(Date.now()+DISCOVERY_PROFILE.transportTimeoutMs,
      state.deadlineAtMs-DISCOVERY_PROFILE.cleanupReserveMs);
    if(networkDeadlineAtMs<=Date.now())return requestDenied();
    const namespaceClient=requireDefinitionNamespace();
    this.#assertMainNamespace(namespaceClient,state.deadlineAtMs);
    const route=await lease.assertCurrent();
    await checkConsoleSourceDeadlines(db);
    if(Date.now()>=networkDeadlineAtMs||Date.now()>=state.deadlineAtMs)return requestDenied();
    this.#assertMainNamespace(namespaceClient,state.deadlineAtMs);
    if(isIP(route.sourceAddress)!==4||route.policyHash!==state.routePolicyHash||route.proxyUrl!=='http://lares-egress-proxy:8888/')return requestDenied();
    const proxyUrl=new URL(route.proxyUrl);
    if(proxyUrl.href!==route.proxyUrl||proxyUrl.protocol!=='http:'||proxyUrl.username||proxyUrl.password||
        proxyUrl.pathname!=='/'||proxyUrl.search||proxyUrl.hash)return requestDenied();

    type ConnectOptions={hostname?:string;host?:string;protocol?:string;port?:number|string;servername?:string|null;
      localAddress?:string|null;httpSocket?:Socket;allowH2?:boolean};
    type ConnectCallback=(error:Error|null,socket?:Socket)=>void;
    type Connector=(options:ConnectOptions,callback:ConnectCallback)=>unknown;
    const controller=new AbortController();
    let active=true;
    let idleTimer:ReturnType<typeof setTimeout>|undefined;
    let deadlineTimer:ReturnType<typeof setTimeout>|undefined;
    let proxy:ProxyAgent|undefined;
    const sockets=new Map<Socket,Promise<void>>();
    const pendingConnects=new Set<Promise<void>>();
    const pendingConnectorPromises=new Set<Promise<unknown>>();
    const pendingValidators=new Set<Promise<void>>();
    const cancelConnectors=new Set<()=>void>();
    const pendingRequests=new Set<Promise<unknown>>();
    const bodies=new Set<{destroy(error?:Error):unknown}>();
    let totalResponseBytes=0;
    let postCount=0;
    let sessionId:string|undefined;
    let sessionIdObserved=false;
    let requestId=0;
    const abort=()=>{if(!controller.signal.aborted)controller.abort();};
    const touch=()=>{
      if(idleTimer)clearTimeout(idleTimer);
      idleTimer=setTimeout(abort,DISCOVERY_PROFILE.idleTimeoutMs);
    };
    const ownSocket=(socket:Socket):void=>{
      if(sockets.has(socket))return;
      let close!:()=>void;
      const closed=new Promise<void>(resolveClosed=>{close=resolveClosed;});
      sockets.set(socket,closed);
      socket.once('close',()=>{sockets.delete(socket);close();});
      if(socket.closed){sockets.delete(socket);close();}
    };
    const assertLocalCurrent=():void=>{
      state.assertRuntimeCurrent?.();
      if(!active||controller.signal.aborted||Date.now()>=networkDeadlineAtMs||Date.now()>=state.deadlineAtMs)return requestDenied();
      this.#assertMainNamespace(namespaceClient,state.deadlineAtMs);
    };
    const assertCurrent=async():Promise<void>=>{
      assertLocalCurrent();
      const current=await lease.assertCurrent();
      await state.assertExecutionCurrent?.(db);
      await checkConsoleSourceDeadlines(db);
      assertLocalCurrent();
      if(current.policyHash!==state.routePolicyHash||current.sourceAddress!==route.sourceAddress||current.proxyUrl!==route.proxyUrl)return requestDenied();
    };
    const registerConnector=(base:Connector,validate:(options:ConnectOptions)=>boolean,forceSource:boolean):Connector=>{
      return (options,callback)=>{
        let finished=false;
        let cancelling=false;
        let callbackDelivered=false;
        let returnedSocket:Socket|undefined;
        let resolveTask!:()=>void;
        const task=new Promise<void>(resolveTaskValue=>{resolveTask=resolveTaskValue;});
        pendingConnects.add(task);
        const onSocketClose=()=>cancel();
        const finish=()=>{
          if(finished)return;
          finished=true;
          if(returnedSocket)returnedSocket.removeListener('close',onSocketClose);
          cancelConnectors.delete(cancel);
          pendingConnects.delete(task);
          resolveTask();
        };
        const deliver=(error:Error|null,socket?:Socket):boolean=>{
          if(callbackDelivered){
            if(socket){ownSocket(socket);socket.destroy(new Error(REQUEST_REFUSED));}
            return false;
          }
          callbackDelivered=true;
          try{callback(error,socket);}catch{if(socket)socket.destroy(new Error(REQUEST_REFUSED));}
          return true;
        };
        const cancel=()=>{
          if(finished||cancelling)return;
          cancelling=true;
          const error=new Error(REQUEST_REFUSED);
          if(returnedSocket&&!returnedSocket.destroyed)returnedSocket.destroy(error);
          deliver(error);
          finish();
        };
        cancelConnectors.add(cancel);
        const complete=(error:Error|null,socket?:Socket)=>{
          if(finished||callbackDelivered){if(socket){ownSocket(socket);socket.destroy(new Error(REQUEST_REFUSED));}return;}
          if(error||!socket){deliver(error??new Error(REQUEST_REFUSED));finish();return;}
          returnedSocket=socket;
          ownSocket(socket);
          socket.once('close',onSocketClose);
          let validator!:Promise<void>;
          validator=(async()=>{
            try{
              await assertCurrent();
              assertLocalCurrent();
              if(socket.closed||socket.destroyed||socket.localAddress!==route.sourceAddress||socket.localFamily!=='IPv4'||!validate(options))
                return requestDenied();
              deliver(null,socket);
            }catch{
              socket.destroy(new Error(REQUEST_REFUSED));
              deliver(new Error(REQUEST_REFUSED));
            }finally{finish();}
          })().finally(()=>pendingValidators.delete(validator));
          pendingValidators.add(validator);
        };
        if(!active||controller.signal.aborted||!validate(options)){
          complete(new Error(REQUEST_REFUSED));
          return;
        }
        try{
          const passed=forceSource?{...options,localAddress:route.sourceAddress}:options;
          const returned=base(passed,complete);
          if(returned&&typeof returned==='object'&&typeof (returned as {once?:unknown}).once==='function'&&
              typeof (returned as {destroy?:unknown}).destroy==='function'){
            returnedSocket=returned as Socket;
            ownSocket(returnedSocket);
            if(!finished){
              if(returnedSocket.closed)cancel();
              else returnedSocket.once('close',onSocketClose);
            }
          }
          if(returned&&typeof returned==='object'&&'then' in returned){
            const underlying=Promise.resolve(returned);
            pendingConnectorPromises.add(underlying);
            void underlying.then(
              ()=>{pendingConnectorPromises.delete(underlying);},
              ()=>{pendingConnectorPromises.delete(underlying);if(!callbackDelivered)cancel();},
            );
          }
          return forceSource?returned as Socket|void:undefined;
        }catch{
          complete(new Error(REQUEST_REFUSED));
          return;
        }
      };
    };
    const proxyClientFactory=(origin:URL,options:object):Dispatcher=>{
      const supplied=(options as {connect?:unknown}).connect;
      if(origin.href!==proxyUrl.href||typeof supplied!=='function')return requestDenied();
      const base=supplied as Connector;
      const connect=registerConnector(base,params=>params.protocol===proxyUrl.protocol&&params.hostname===proxyUrl.hostname&&
        Number(params.port??80)===Number(proxyUrl.port||80)&&!params.httpSocket&&
        (params.servername===undefined||params.servername===null||params.servername===proxyUrl.hostname),true);
      return new Client(origin,{...options,connect:connect as never,allowH2:false,autoSelectFamily:false,connectTimeout:DISCOVERY_PROFILE.connectTimeoutMs,
        headersTimeout:DISCOVERY_PROFILE.idleTimeoutMs,bodyTimeout:DISCOVERY_PROFILE.idleTimeoutMs,maxHeaderSize:DISCOVERY_PROFILE.headerBytes,
        pipelining:1});
    };
    const targetFactory=(origin:string|URL,options:object):Dispatcher=>{
      const supplied=(options as {connect?:unknown}).connect;
      let targetOrigin:URL;
      try{targetOrigin=new URL(origin instanceof URL?origin.href:origin);}catch{return requestDenied();}
      if(targetOrigin.origin!==endpoint.origin||targetOrigin.username||targetOrigin.password||targetOrigin.pathname!=='/'||
          targetOrigin.search||targetOrigin.hash||typeof supplied!=='function')return requestDenied();
      const base=supplied as Connector;
      const connect=registerConnector(base,params=>params.protocol==='https:'&&params.hostname===endpoint.hostname&&
        params.host===endpoint.host&&(params.port===undefined||params.port===null||params.port===''?443:Number(params.port))===443&&
        params.servername===endpoint.hostname&&!params.httpSocket,false);
      return new Client(targetOrigin,{...options,connect:connect as never,allowH2:false,autoSelectFamily:false,connectTimeout:DISCOVERY_PROFILE.connectTimeoutMs,
        headersTimeout:DISCOVERY_PROFILE.idleTimeoutMs,bodyTimeout:DISCOVERY_PROFILE.idleTimeoutMs,maxHeaderSize:DISCOVERY_PROFILE.headerBytes,
        pipelining:1});
    };
    const boundedRead=async(response:Awaited<ReturnType<typeof request>>):Promise<Buffer>=>{
      outsideHeadersSize(response.headers);
      const encoding=response.headers['content-encoding'];
      if(encoding!==undefined&&encoding!=='identity')return requestDenied();
      const body=response.body as unknown as {destroy(error?:Error):unknown;[Symbol.asyncIterator]():AsyncIterator<Buffer|string>};
      bodies.add(body);
      const chunks:Buffer[]=[];let size=0;
      try{
        for await(const chunk of body){
          touch();await assertCurrent();
          const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
          size+=bytes.length;totalResponseBytes+=bytes.length;
          if(size>DISCOVERY_PROFILE.responseBytes||totalResponseBytes>DISCOVERY_PROFILE.totalResponseBytes)return requestDenied();
          chunks.push(bytes);
        }
        return Buffer.concat(chunks,size);
      }finally{bodies.delete(body);}
    };
    const post=async(message:OutsideJson,replyId:number|undefined):Promise<{result?:OutsideJson;headers:Record<string,string|string[]|undefined>;status:number}>=>{
      const body=Buffer.from(canonicalJson(message),'utf8');
      if(body.length>DISCOVERY_PROFILE.maxRequestBytes||++postCount>DISCOVERY_PROFILE.maxPosts)return requestDenied();
      await assertCurrent();
      if(Date.now()+DISCOVERY_PROFILE.cleanupReserveMs>=state.deadlineAtMs)return requestDenied();
      progress.dispatched=true;
      touch();
      const headers:Record<string,string>={'content-type':'application/json','accept':'application/json, text/event-stream',
        'mcp-protocol-version':DISCOVERY_PROFILE.protocolVersion,'authorization':`Bearer ${outsideBearer(credential)}`};
      if(sessionId)headers['mcp-session-id']=sessionId;
      let task!:Promise<{result?:OutsideJson;headers:Record<string,string|string[]|undefined>;status:number}>;
      task=(async()=>{
        const response=await request(endpoint.href,{dispatcher:proxy!,method:'POST',headers,body,signal:controller.signal,
        headersTimeout:DISCOVERY_PROFILE.idleTimeoutMs,bodyTimeout:DISCOVERY_PROFILE.idleTimeoutMs});
        touch();await assertCurrent();
        const responseHeaders=response.headers as Record<string,string|string[]|undefined>;
        const sessionHeader=responseHeaders['mcp-session-id'];
        const sessionValue=Array.isArray(sessionHeader)?(sessionHeader.length===1?sessionHeader[0]:undefined):sessionHeader;
        if(Array.isArray(sessionHeader)&&sessionHeader.length!==1)return requestDenied();
        const parsedSession=outsideSessionId(sessionValue);
        if(!sessionIdObserved){sessionId=parsedSession;sessionIdObserved=true;}
        else if(parsedSession!==undefined&&parsedSession!==sessionId)return requestDenied();
        const payload=await boundedRead(response);
        if(replyId===undefined){if(response.statusCode!==202||payload.length!==0)return requestDenied();return {headers:responseHeaders,status:response.statusCode};}
        if(response.statusCode!==200)return requestDenied();
        const content=responseHeaders['content-type'];
        const contentType=Array.isArray(content)?(content.length===1?content[0]:''):content??'';
        const media=contentType.split(';',1)[0]!.trim().toLowerCase();
        const result=media==='application/json'?parseOutsideJson(payload,replyId):media==='text/event-stream'?parseOutsideSse(payload,replyId):denied();
        await assertCurrent();
        return {result,headers:responseHeaders,status:response.statusCode};
      })();
      pendingRequests.add(task);
      try{return await task;}finally{pendingRequests.delete(task);}
    };
    const closeOwnedWork=async():Promise<void>=>{
      active=false;
      if(idleTimer)clearTimeout(idleTimer);
      if(deadlineTimer)clearTimeout(deadlineTimer);
      abort();
      for(const cancel of [...cancelConnectors])cancel();
      for(const body of bodies)body.destroy(new Error(REQUEST_REFUSED));
      for(const socket of sockets.keys())socket.destroy();
      const destroy=proxy?.destroy().catch(()=>{});
      if(destroy)await destroy;
      while(pendingConnects.size||pendingConnectorPromises.size||pendingValidators.size||pendingRequests.size){
        await Promise.allSettled([...pendingConnects,...pendingConnectorPromises,...pendingValidators,...pendingRequests]);
        for(const socket of sockets.keys())socket.destroy();
      }
      const closures=[...sockets.values()];
      for(const socket of sockets.keys())socket.destroy();
      await Promise.all(closures);
      if(sockets.size!==0)return requestDenied();
    };
    let recoveryFailure:OutsideCustodyRecoveryRequired|undefined;
    let completedDocument:OutsideDiscoveryDocument|undefined;
    try{
      deadlineTimer=setTimeout(abort,Math.max(1,networkDeadlineAtMs-Date.now()));
      touch();
      await assertCurrent();
      proxy=new ProxyAgent({uri:proxyUrl.href,proxyTunnel:true,proxyTls:{family:4,autoSelectFamily:false,allowH2:false,
        timeout:DISCOVERY_PROFILE.connectTimeoutMs,servername:proxyUrl.hostname,rejectUnauthorized:true},
        requestTls:{servername:endpoint.hostname,rejectUnauthorized:true,allowH2:false,timeout:DISCOVERY_PROFILE.connectTimeoutMs},
        clientFactory:proxyClientFactory,factory:targetFactory,connections:1,pipelining:1,allowH2:false,
        connectTimeout:DISCOVERY_PROFILE.connectTimeoutMs,headersTimeout:DISCOVERY_PROFILE.idleTimeoutMs,
        bodyTimeout:DISCOVERY_PROFILE.idleTimeoutMs,maxHeaderSize:DISCOVERY_PROFILE.headerBytes});
      const initId=++requestId;
      progress.stage='initialize';
      const init=await post({jsonrpc:'2.0',id:initId,method:'initialize',params:{protocolVersion:DISCOVERY_PROFILE.protocolVersion,
        capabilities:{},clientInfo:{name:'lares-outside-discovery',version:'1'}}},initId);
      const initResult=init.result;
      if(!initResult||Array.isArray(initResult)||typeof initResult!=='object'||initResult.protocolVersion!==DISCOVERY_PROFILE.protocolVersion||
          !initResult.serverInfo||Array.isArray(initResult.serverInfo)||typeof initResult.serverInfo!=='object')return requestDenied();
      assertBoundedJson(initResult.serverInfo);
      const serverInfo=projectOutsideServerInfo(initResult.serverInfo);
      progress.stage='initialized-notification';
      const notification=await post({jsonrpc:'2.0',method:'notifications/initialized',params:{}},undefined);
      if(notification.status!==202)return requestDenied();
      if(toolCall){
        const id=++requestId;
        const called=await post({jsonrpc:'2.0',id,method:'tools/call',params:{name:toolCall.name,arguments:toolCall.input}},id);
        const result=called.result;
        if(!result||Array.isArray(result)||typeof result!=='object')return requestDenied();
        assertBoundedJson(result);
        const record=result as Record<string,OutsideJson>;
        if(!Array.isArray(record.content)||record.content.length>DISCOVERY_PROFILE.maxTools||
            record.isError!==undefined&&typeof record.isError!=='boolean'||
            Object.keys(record).some(key=>!['content','isError','structuredContent','_meta'].includes(key)))return requestDenied();
        if(record.structuredContent!==undefined&&(!record.structuredContent||Array.isArray(record.structuredContent)||typeof record.structuredContent!=='object'))return requestDenied();
        // A peer may echo its Authorization value. Do not let that move custody into
        // runtime responses or conversation history, including structured results.
        if(canonicalJson(record).includes(outsideBearer(credential)))return requestDenied();
        await assertCurrent();
        return {content:record.content,...(record.isError===undefined?{}:{isError:record.isError}),
          ...(record.structuredContent===undefined?{}:{structuredContent:record.structuredContent})};
      }
      const tools:OutsideListedTool[]=[];const names=new Set<string>();const cursors=new Set<string>();let cursor:string|undefined;
      for(let page=0;page<DISCOVERY_PROFILE.maxPages;page++){
        const id=++requestId;
        const params:OutsideJson=cursor===undefined?{}:{cursor};
        progress.stage='tools-list';
        const listed=await post({jsonrpc:'2.0',id,method:'tools/list',params},id);
        const result=listed.result;
        if(!result||Array.isArray(result)||typeof result!=='object'||!Array.isArray(result.tools))return requestDenied();
        for(const item of result.tools){
          if(!item||Array.isArray(item)||typeof item!=='object'||typeof item.name!=='string'||
              Buffer.byteLength(item.name)<1||Buffer.byteLength(item.name)>DISCOVERY_PROFILE.maxToolNameBytes||
              /[\x00-\x1f\x7f]/.test(item.name)||names.has(item.name)||
              item.description!==undefined&&(typeof item.description!=='string'||Buffer.byteLength(item.description)>2048||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(item.description))||
              !Object.hasOwn(item,'inputSchema')||!item.inputSchema||Array.isArray(item.inputSchema)||typeof item.inputSchema!=='object')return requestDenied();
          names.add(item.name);
          const projected:OutsideListedTool={name:item.name,inputSchema:item.inputSchema as {[key:string]:OutsideJson}};
          if(item.description!==undefined)projected.description=item.description;
          tools.push(projected);
          if(tools.length>DISCOVERY_PROFILE.maxTools)return requestDenied();
        }
        const next=result.nextCursor;
        if(next===undefined){cursor=undefined;break;}
        if(typeof next!=='string'||Buffer.byteLength(next)<1||Buffer.byteLength(next)>DISCOVERY_PROFILE.maxCursorBytes||cursors.has(next))return requestDenied();
        cursor=next;cursors.add(next);
        if(page+1===DISCOVERY_PROFILE.maxPages)return requestDenied();
      }
      if(cursor!==undefined)return requestDenied();
      const document:OutsideDiscoveryDocument={protocolVersion:DISCOVERY_PROFILE.protocolVersion,serverInfo,tools};
      const canonical=Buffer.from(canonicalJson(document),'utf8');
      if(canonical.length>DISCOVERY_PROFILE.resultBytes)return requestDenied();
      await assertCurrent();
      completedDocument=document;
    }catch(error){
      recoveryFailure=outsideDiscoveryRecovery(error,state.claim.operationId,progress.stage,progress.dispatched);
      if(!recoveryFailure)return requestDenied();
    }finally{
      progress.stage='cleanup';
      try{await closeOwnedWork();}catch(cleanupError){if(!recoveryFailure)throw cleanupError;}
    }
    if(recoveryFailure)throw recoveryFailure;
    if(!completedDocument)return requestDenied();
    return completedDocument;
  }

  /** Reauthorize an acknowledged claim on a fresh owned client. The concrete exchange and
   * result COMMIT intentionally do not exist at this checkpoint, so this private scope is
   * not invoked by the refusal path above or any registered action. */
  async #phase2Authority(identity:OutsideClaimIdentity,sessionToken:string):Promise<OutsideDiscoveryDocument>{
    // Spend the opaque receipt synchronously, before namespace admission or any other await.
    const state=this.#consumeClaimIdentity(identity);
    const lifecycle=this.routeLifecycle;
    if(!lifecycle)return requestDenied();
    const progress:{dispatched:boolean;stage?:OutsideDiscoveryFailureStage}={dispatched:false,stage:'authority-check'};
    try{return await this.#inMainNamespace({deadlineAtMs:state.deadlineAtMs},async()=>{
      return lifecycle.withAppliedOutsideRoute(state.claim.destination,state.routePolicyHash,state.deadlineAtMs,async lease=>{
        const namespaceClient=requireDefinitionNamespace();
        await lease.assertCurrent();
        this.#assertMainNamespace(namespaceClient,state.deadlineAtMs);
        const result=await this.#withHumanSession(sessionToken,async(db,memberId)=>{
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
            outcome:string;revision_generation:string;revision_consent_generation:string;revision_purpose:string;policy_hash:Buffer;
            policy_json:string;nonce:Buffer;ciphertext:Buffer}>(`SELECT c.operation_id,c.expected_generation::text,c.result_generation::text,
              c.credential_revision::text,c.outcome,v.generation::text AS revision_generation,v.consent_generation::text AS revision_consent_generation,
              v.revision_purpose,v.policy_hash,v.policy_json::text,v.nonce,v.ciphertext
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
          const expectedPolicy={version:DISCOVERY_PROFILE.version,profile:DISCOVERY_PROFILE,purpose:'streamable-http-discovery-v1',
            ownerMemberId:memberId,accountId:state.claim.accountId,agentName:state.claim.agentName,
            connectionName:state.claim.connectionName,endpoint:state.claim.destination,capture,route};
          let storedPolicy:unknown;
          try{storedPolicy=JSON.parse(row.policy_json) as unknown;}catch{return requestDenied();}
          if(canonicalJson(storedPolicy)!==canonicalJson(expectedPolicy))return requestDenied();
          const result=await db.query<{operation_id:string}>(`SELECT operation_id FROM outside_custody_operations
            WHERE request_id=$1 AND event_phase='result'`,[state.claim.requestId]);
          if(result.rows.length!==0)return requestDenied();
          await lease.assertCurrent();
          this.#assertMainNamespace(namespaceClient,state.deadlineAtMs);
          await checkConsoleSourceDeadlines(db);
          const coordinates:BoundCoordinates={ownerMemberId:memberId,accountId:state.claim.accountId,resourceId:state.claim.agentName,
            connectionName:state.claim.connectionName,generation:state.generation,credentialRevision:state.credentialRevision,
            consentGeneration:state.consentGeneration,operationId:state.claim.operationId,revisionPurpose:'discovery',policyHash:state.claim.policyHash};
          const credential=openBound(this.key,row.nonce,row.ciphertext,coordinates);
          try{
            const endpoint=discoveryEndpoint(state.claim.destination);
            const destinationHash=createHash('sha256').update(canonicalJson(['lares-outside-endpoint-v1',endpoint.href])).digest('hex');
            const requestDigest=createHash('sha256').update(canonicalJson({requestId:state.claim.requestId,operationId:state.claim.operationId,
              accountId:state.claim.accountId,memberId,agentName:state.claim.agentName,connectionName:state.claim.connectionName,
              expectedGeneration:state.expectedGeneration,expectedCandidateRevision:state.candidateRevision,
              expectedAccessRevision:state.claim.accessRevision,expectedDestinationHash:destinationHash,
              expectedRoutePolicyHash:state.routePolicyHash,consentGeneration:state.consentGeneration,policyHash:state.claim.policyHash,
              credentialHash:createHash('sha256').update(credential).digest('hex')})).digest('hex');
            if(requestDigest!==state.requestHash)return requestDenied();
            const document=await this.#exchangeDiscovery(db,state,lease,credential,progress);
            progress.stage='persist-result';
            const plain=Buffer.from(canonicalJson(document),'utf8');
            try{
              if(plain.length>DISCOVERY_PROFILE.resultBytes)return requestDenied();
              const resultOperationId=randomUUID();
              const sealed=sealDiscoveryResult(this.key,plain,{ownerMemberId:memberId,accountId:state.claim.accountId,
                agentName:state.claim.agentName,connectionName:state.claim.connectionName,requestId:state.claim.requestId,
                claimOperationId:state.claim.operationId,resultOperationId,generation:state.generation,
                credentialRevision:state.credentialRevision,consentGeneration:state.consentGeneration,policyHash:state.claim.policyHash});
              await lease.assertCurrent();
              this.#assertMainNamespace(namespaceClient,state.deadlineAtMs);
              await checkConsoleSourceDeadlines(db);
              const inserted=await db.query(`INSERT INTO outside_custody_operations
                (operation_id,account_id,owner_member_id,operation_kind,request_id,event_phase,request_hash,
                  expected_generation,result_generation,credential_revision,outcome,result_nonce,result_ciphertext)
                VALUES($1,$2,$3,'discover',$4,'result',$5,$6,$7,$8,'completed',$9,$10)`,
                [resultOperationId,state.claim.accountId,memberId,state.claim.requestId,Buffer.from(state.requestHash,'hex'),
                  state.expectedGeneration,state.generation,state.credentialRevision,sealed.nonce,sealed.ciphertext]);
              if(inserted.rowCount!==1)return requestDenied();
              await checkConsoleSourceDeadlines(db);
              await lease.assertCurrent();
              this.#assertMainNamespace(namespaceClient,state.deadlineAtMs);
              return document;
            }finally{plain.fill(0);}
          }finally{credential.fill(0);}
        },{deadlineAtMs:state.deadlineAtMs});
        await lease.assertCurrent();
        this.#assertMainNamespace(namespaceClient,state.deadlineAtMs);
        return result;
      });
    });}catch(error){
      const recovery=outsideDiscoveryRecovery(error,state.claim.operationId,progress.stage,progress.dispatched);
      if(recovery)throw recovery;
      return requestDenied();
    }
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

  async publishDiscoveredDescriptorReview(sessionToken:string,input:{accountId:string;agentName:string;connectionName:string;requestId:string;
    claimOperationId:string;operationId:string;expectedGeneration:number;expectedDescriptorHash:string},options:{deadlineAtMs:number}):Promise<{
      publicationId:string;publicationHash:string;descriptor:DescriptorProjection}>{
    const accountId=uuid.parse(input.accountId),operationId=uuid.parse(input.operationId);
    if(!Number.isSafeInteger(input.expectedGeneration)||input.expectedGeneration<1||!/^[a-f0-9]{64}$/.test(input.expectedDescriptorHash))return requestDenied();
    return this.#inMainNamespace(options,()=>this.#withHumanSession(sessionToken,async(db,memberId)=>{
      const organisation=await this.#humanOrganisation(db,memberId);
      const discovered=await this.#readDiscoveryOnClient(db,memberId,input,organisation.id,'update');
      if(number(discovered.head.generation)!==input.expectedGeneration||discovered.head.owner_member_id!==memberId||
          discovered.head.resource_id!==input.agentName||discovered.head.connection_name!==input.connectionName)return requestDenied();
      const projection=projectDescriptorDocument(discovered.document,discovered.capture);
      const publicationHash=createHash('sha256').update(canonicalJson(projection)).digest('hex');
      if(publicationHash!==input.expectedDescriptorHash)return requestDenied();
      const body={version:1,organisationId:organisation.id,actorMemberId:memberId,publicationHash,
        source:{requestId:discovered.requestId,claimOperationId:discovered.claimOperationId,revision:discovered.revision,
          consentGeneration:discovered.consentGeneration,policyHash:discovered.policyHash},
        definition:{hash:discovered.capture.agent.definitionHash,accessRevision:discovered.capture.agent.accessRevision},
        capture:discovered.capture,projection};
      await this.#recordEvidence(db,{operationId,accountId,ownerMemberId:memberId,actorMemberId:memberId,kind:'publish',
        evidenceKind:'descriptor-publication-v1',body,expectedGeneration:input.expectedGeneration,resultGeneration:input.expectedGeneration,
        credentialRevision:discovered.revision,outcome:'published',requestIdentity:{requestId:input.requestId,claimOperationId:input.claimOperationId,
          expectedDescriptorHash:input.expectedDescriptorHash}});
      return {publicationId:operationId,publicationHash,descriptor:projection};
    },options));
  }

  async readPublishedDescriptorReview(sessionToken:string,input:{accountId:string;publicationId:string;expectedPublicationHash:string},
    options:{deadlineAtMs:number}):Promise<{publicationId:string;publicationHash:string;descriptor:DescriptorProjection;resourceId:string;connectionName:string}>{
    const accountId=uuid.parse(input.accountId),publicationId=uuid.parse(input.publicationId);
    if(!/^[a-f0-9]{64}$/.test(input.expectedPublicationHash))return denied();
    return this.#inMainNamespace(options,()=>this.#withHumanSession(sessionToken,async(db,editorMemberId)=>{
      const organisation=await this.#humanOrganisation(db,editorMemberId);
      const locator=await this.head(db,accountId,false);
      if(!locator||locator.state!=='active')return denied();
      await this.#lockSameOrganisationMember(db,locator.owner_member_id,organisation.id,editorMemberId);
      const evidence=await this.#readEvidence(db,accountId,publicationId,'descriptor-publication-v1');
      const {head,body,row}=evidence;
      if(head.state!=='active'||head.owner_member_id!==body.actorMemberId||body.organisationId!==organisation.id||
          body.publicationHash!==input.expectedPublicationHash||row.outcome!=='published'||row.actor_member_id!==head.owner_member_id)return denied();
      const storedDefinition=body.definition as {hash:string;accessRevision:number};
      const definition={definitionHash:storedDefinition.hash,accessRevision:storedDefinition.accessRevision};
      const current=await captureOutsideHumanUse(db,head.owner_member_id,head.resource_id,head.connection_name,definition);
      if(current.actor.organisationId!==organisation.id||canonicalJson(current)!==canonicalJson(body.capture))return denied();
      const projection=body.projection as DescriptorProjection;
      if(!projection||projection.version!==1||projection.connectionName!==head.connection_name||
          createHash('sha256').update(canonicalJson(projection)).digest('hex')!==input.expectedPublicationHash)return denied();
      await this.#captureDescriptorEditor(db,editorMemberId,editorMemberId,organisation.id,head.resource_id,head.connection_name,
        {definitionHash:current.agent.definitionHash,accessRevision:current.agent.accessRevision});
      return {publicationId,publicationHash:input.expectedPublicationHash,descriptor:projection,resourceId:head.resource_id,connectionName:head.connection_name};
    },options));
  }

  async acceptPublishedDescriptorReview(sessionToken:string,input:{accountId:string;publicationId:string;operationId:string;
    expectedPublicationHash:string},options:{deadlineAtMs:number}):Promise<{acceptanceId:string;publicationHash:string;acceptanceHash:string}>{
    const accountId=uuid.parse(input.accountId),publicationId=uuid.parse(input.publicationId),operationId=uuid.parse(input.operationId);
    if(!/^[a-f0-9]{64}$/.test(input.expectedPublicationHash))return requestDenied();
    return this.#inMainNamespace(options,()=>this.#withHumanSession(sessionToken,async(db,editorMemberId)=>{
      const organisation=await this.#humanOrganisation(db,editorMemberId);
      const locator=await this.head(db,accountId,false);
      if(!locator||locator.state!=='active')return requestDenied();
      await this.#lockSameOrganisationMember(db,locator.owner_member_id,organisation.id,editorMemberId);
      const evidence=await this.#readEvidence(db,accountId,publicationId,'descriptor-publication-v1');
      const {head,body,row}=evidence;
      if(head.state!=='active'||body.organisationId!==organisation.id||body.publicationHash!==input.expectedPublicationHash||
          row.outcome!=='published'||row.actor_member_id!==head.owner_member_id)return requestDenied();
      const storedDefinition=body.definition as {hash:string;accessRevision:number};
      const definition={definitionHash:storedDefinition.hash,accessRevision:storedDefinition.accessRevision};
      const currentUse=await captureOutsideHumanUse(db,head.owner_member_id,head.resource_id,head.connection_name,definition);
      if(currentUse.actor.organisationId!==organisation.id||canonicalJson(currentUse)!==canonicalJson(body.capture))return requestDenied();
      const editor=await this.#captureDescriptorEditor(db,editorMemberId,editorMemberId,organisation.id,head.resource_id,head.connection_name,
        {definitionHash:currentUse.agent.definitionHash,accessRevision:currentUse.agent.accessRevision});
      const acceptance={version:1,organisationId:organisation.id,editorMemberId,publicationId,publicationHash:input.expectedPublicationHash,
        resourceId:head.resource_id,connectionName:head.connection_name,definitionHash:editor.agent.definitionHash,
        accessRevision:editor.agent.accessRevision,grant:editor.grant};
      await this.#recordEvidence(db,{operationId,accountId,ownerMemberId:head.owner_member_id,actorMemberId:editorMemberId,kind:'accept',
        evidenceKind:'descriptor-acceptance-v1',body:acceptance,expectedGeneration:number(head.generation),resultGeneration:number(head.generation),
        credentialRevision:row.credential_revision===null?null:number(row.credential_revision),outcome:'accepted',
        requestIdentity:{publicationId,expectedPublicationHash:input.expectedPublicationHash}});
      return {acceptanceId:operationId,publicationHash:input.expectedPublicationHash,
        acceptanceHash:createHash('sha256').update(canonicalJson(acceptance)).digest('hex')};
    },options));
  }

  async previewExecutableActivation(sessionToken:string,input:ActivationSelectors & {operationId:string},options:{deadlineAtMs:number}):Promise<{
    reviewId:string;reviewHash:string;policyHash:string;expectedGeneration:number;expectedCandidateRevision:number|null;sourceRevision:number;consentGeneration:number}>{
    const accountId=uuid.parse(input.accountId),operationId=uuid.parse(input.operationId);
    return this.#inMainNamespace(options,()=>this.#withHumanSession(sessionToken,async(db,memberId)=>{
      const prepared=await this.#prepareActivationReview(db,memberId,input,options);
      const result=await this.#recordEvidence(db,{operationId,accountId,ownerMemberId:memberId,actorMemberId:memberId,kind:'activation-preview',
        evidenceKind:'activation-review-v1',body:prepared.review,expectedGeneration:input.expectedGeneration,
        resultGeneration:input.expectedGeneration,credentialRevision:prepared.discovery.revision,outcome:'previewed',
        requestIdentity:{reviewHash:prepared.reviewHash,policyHash:prepared.review.policyHash}});
      if(result.outcome!=='previewed')return requestDenied();
      return {reviewId:operationId,reviewHash:prepared.reviewHash,policyHash:prepared.review.policyHash,
        expectedGeneration:prepared.review.expectedGeneration,expectedCandidateRevision:prepared.review.expectedCandidateRevision,
        sourceRevision:prepared.review.sourceRevision,consentGeneration:prepared.review.consentGeneration};
    },options));
  }

  private async record(db: PoolClient, input: { operationId:string;accountId:string;ownerMemberId:string;kind:OutsideOperationKind;hash:Buffer;expected:number;result:number;revision:number|null;outcome:OutsideOperationResult["outcome"] }): Promise<OutsideOperationResult> {
    await db.query(`INSERT INTO outside_custody_operations
      (operation_id,account_id,owner_member_id,operation_kind,request_hash,expected_generation,result_generation,credential_revision,outcome)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[input.operationId,input.accountId,input.ownerMemberId,input.kind,input.hash,input.expected,input.result,input.revision,input.outcome]);
    this.#assertOpen(requestDenied);
    return { operationId:input.operationId,accountId:input.accountId,kind:input.kind,outcome:input.outcome,generation:input.result,credentialRevision:input.revision };
  }

  async #recordEvidence(db:PoolClient,input:{operationId:string;accountId:string;ownerMemberId:string;actorMemberId:string;kind:'publish'|'accept'|'activation-preview'|'stage';
    evidenceKind:'descriptor-publication-v1'|'descriptor-acceptance-v1'|'activation-review-v1';body:unknown;expectedGeneration:number;
    resultGeneration:number;credentialRevision:number|null;outcome:'published'|'accepted'|'previewed'|'staged';requestIdentity:unknown}):Promise<OutsideOperationResult>{
    const bodyHash=createHash('sha256').update(canonicalJson(input.body)).digest('hex');
    const requestHash=createHash('sha256').update(canonicalJson({kind:input.kind,operationId:input.operationId,accountId:input.accountId,
      ownerMemberId:input.ownerMemberId,actorMemberId:input.actorMemberId,expectedGeneration:input.expectedGeneration,
      resultGeneration:input.resultGeneration,credentialRevision:input.credentialRevision,requestIdentity:input.requestIdentity,bodyHash})).digest();
    const account=await this.head(db,input.accountId,false);
    if(!account||account.owner_member_id!==input.ownerMemberId)return requestDenied();
    const existing=await db.query<{operation_kind:string;owner_member_id:string;actor_member_id:string|null;request_hash:Buffer;outcome:string;expected_generation:string;
      result_generation:string;credential_revision:string|null;evidence_kind:string|null;evidence_hash:Buffer|null}>(`SELECT operation_kind,owner_member_id,actor_member_id,outcome,
        request_hash,expected_generation::text,result_generation::text,credential_revision::text,evidence_kind,evidence_hash
      FROM outside_custody_operations WHERE operation_id=$1 AND account_id=$2 AND event_phase='operation'`,[input.operationId,input.accountId]);
    if(existing.rows.length){
      const prior=existing.rows[0]!;
      if(existing.rows.length!==1||prior.operation_kind!==input.kind||prior.owner_member_id!==input.ownerMemberId||prior.actor_member_id!==input.actorMemberId||
          !sameBuffer(prior.request_hash,requestHash)||
          prior.outcome!==input.outcome||prior.evidence_kind!==input.evidenceKind||prior.evidence_hash?.toString('hex')!==bodyHash||
          Number(prior.expected_generation)!==input.expectedGeneration||Number(prior.result_generation)!==input.resultGeneration||
          (prior.credential_revision===null?null:Number(prior.credential_revision))!==input.credentialRevision)return requestDenied();
      const recovered=await this.#readEvidence(db,input.accountId,input.operationId,input.evidenceKind);
      if(canonicalJson(recovered.body)!==canonicalJson(input.body))return requestDenied();
      return {operationId:input.operationId,accountId:input.accountId,kind:input.kind,outcome:input.outcome,
        generation:input.resultGeneration,credentialRevision:input.credentialRevision};
    }
    const encrypted=sealEvidence(this.key,input.body,{accountId:input.accountId,ownerMemberId:input.ownerMemberId,resourceId:account.resource_id,
      connectionName:account.connection_name,operationId:input.operationId,kind:input.evidenceKind,hash:bodyHash});
    const inserted=await db.query(`INSERT INTO outside_custody_operations
      (operation_id,account_id,owner_member_id,actor_member_id,operation_kind,request_hash,expected_generation,result_generation,
       credential_revision,outcome,result_nonce,result_ciphertext,evidence_kind,evidence_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [input.operationId,input.accountId,input.ownerMemberId,input.actorMemberId,input.kind,requestHash,input.expectedGeneration,
        input.resultGeneration,input.credentialRevision,input.outcome,encrypted.nonce,encrypted.ciphertext,input.evidenceKind,Buffer.from(bodyHash,'hex')]);
    if(inserted.rowCount!==1)return requestDenied();
    await checkConsoleSourceDeadlines(db);
    return {operationId:input.operationId,accountId:input.accountId,kind:input.kind,outcome:input.outcome,generation:input.resultGeneration,
      credentialRevision:input.credentialRevision};
  }

  async #readEvidence(db:PoolClient,accountId:string,operationId:string,expectedKind:'descriptor-publication-v1'|'descriptor-acceptance-v1'|'activation-review-v1'):
    Promise<{row:StoredEvidence;body:Record<string,unknown>;head:Head;bodyHash:string}>{
    const result=await db.query<StoredEvidence>(`SELECT operation_id,account_id,owner_member_id,actor_member_id,operation_kind,request_hash,
        result_nonce,result_ciphertext,evidence_kind,evidence_hash,outcome,expected_generation::text,result_generation::text,credential_revision::text
      FROM outside_custody_operations WHERE account_id=$1 AND operation_id=$2 AND event_phase='operation'`,[accountId,operationId]);
    const row=result.rows[0],head=await this.head(db,accountId,false);
    if(result.rows.length!==1||!row||!head||row.account_id!==accountId||row.owner_member_id!==head.owner_member_id||
        row.evidence_kind!==expectedKind||!Buffer.isBuffer(row.evidence_hash)||row.evidence_hash.length!==32||
        !Buffer.isBuffer(row.result_nonce)||!Buffer.isBuffer(row.result_ciphertext))return denied();
    const digest=row.evidence_hash.toString('hex');
    const plaintext=openEvidence(this.key,row.result_nonce,row.result_ciphertext,{accountId,ownerMemberId:row.owner_member_id,
      resourceId:head.resource_id,connectionName:head.connection_name,operationId,kind:expectedKind,hash:digest});
    try{
      const decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext)) as unknown;
      if(!decoded||Array.isArray(decoded)||typeof decoded!=='object')return denied();
      const bodyHash=createHash('sha256').update(canonicalJson(decoded)).digest('hex');
      if(bodyHash!==digest)return denied();
      const body=row.operation_kind==='stage'?stagedEvidenceSchema.parse(decoded):validateEvidenceBody(expectedKind,decoded);
      return {row,body:body as Record<string,unknown>,head,bodyHash};
    }catch{return denied();}finally{plaintext.fill(0);}
  }

  async #prepareActivationReview(db:PoolClient,actingMemberId:string,input:ActivationSelectors,options:{deadlineAtMs:number},
    routePolicyHash?:string,consentMode:'next'|'current'='next',candidateMode:'original'|'staged'='original'):
    Promise<{review:ActivationReviewV1;reviewHash:string;publication:Record<string,unknown>;acceptance:Record<string,unknown>;
      discovery:DiscoveryRead}> {
    const accountId=uuid.parse(input.accountId),publicationId=uuid.parse(input.publicationId),acceptanceId=uuid.parse(input.acceptanceId);
    if(!Number.isSafeInteger(input.expectedGeneration)||input.expectedGeneration<1||
        input.expectedCandidateRevision!==null&&(!Number.isSafeInteger(input.expectedCandidateRevision)||input.expectedCandidateRevision<1)||
        !Number.isSafeInteger(input.expectedConsentGeneration)||input.expectedConsentGeneration<1||
        !/^[a-f0-9]{64}$/.test(input.expectedDefinitionHash)||!Number.isSafeInteger(input.expectedAccessRevision)||input.expectedAccessRevision<1||
        !/^[a-f0-9]{64}$/.test(input.expectedPublicationHash)||!/^[a-f0-9]{64}$/.test(input.expectedAcceptanceHash)||
        input.expectedPolicyHash!==undefined&&!/^[a-f0-9]{64}$/.test(input.expectedPolicyHash))return requestDenied();
    const organisation=await this.#humanOrganisation(db,actingMemberId);
    const useCapture=await captureOutsideHumanUse(db,actingMemberId,input.agentName,input.connectionName,
      {definitionHash:input.expectedDefinitionHash,accessRevision:input.expectedAccessRevision});
    if(useCapture.actor.memberId!==actingMemberId||useCapture.actor.organisationId!==organisation.id)return requestDenied();
    const acceptanceLocator=await db.query<{actor_member_id:string|null;evidence_kind:string}>(`SELECT actor_member_id,evidence_kind
      FROM outside_custody_operations WHERE account_id=$1 AND operation_id=$2 AND event_phase='operation'`,[accountId,acceptanceId]);
    const editorId=acceptanceLocator.rows[0]?.actor_member_id;
    if(acceptanceLocator.rows.length!==1||!editorId||acceptanceLocator.rows[0]?.evidence_kind!=='descriptor-acceptance-v1')return requestDenied();
    const editorBeforeHead=await this.#captureDescriptorEditor(db,editorId,actingMemberId,organisation.id,input.agentName,input.connectionName,
      {definitionHash:useCapture.agent.definitionHash,accessRevision:useCapture.agent.accessRevision});
    const locator=await this.head(db,accountId,false);
    if(!locator||locator.owner_member_id!==actingMemberId||locator.resource_id!==input.agentName||locator.connection_name!==input.connectionName||
        locator.state!=='active'||number(locator.generation)!==input.expectedGeneration||
        candidateMode==='original'&&(locator.candidate_revision===null?null:number(locator.candidate_revision))!==input.expectedCandidateRevision)return requestDenied();
    const discovery=await this.#readDiscoveryOnClient(db,actingMemberId,{accountId,agentName:input.agentName,connectionName:input.connectionName,
      requestId:input.requestId,claimOperationId:input.claimOperationId},organisation.id,'update');
    if(number(discovery.head.generation)!==input.expectedGeneration||
        candidateMode==='original'&&(discovery.head.candidate_revision===null?null:number(discovery.head.candidate_revision))!==input.expectedCandidateRevision||
        discovery.capture.agent.definitionHash!==input.expectedDefinitionHash||discovery.capture.agent.accessRevision!==input.expectedAccessRevision)return requestDenied();
    const publication=await this.#readEvidence(db,accountId,publicationId,'descriptor-publication-v1');
    const acceptance=await this.#readEvidence(db,accountId,acceptanceId,'descriptor-acceptance-v1');
    if(publication.row.outcome!=='published'||publication.row.actor_member_id!==actingMemberId||
        publication.body.publicationHash!==input.expectedPublicationHash||acceptance.row.outcome!=='accepted'||
        acceptance.row.actor_member_id!==editorId||acceptance.body.editorMemberId!==editorId||
        acceptance.body.publicationId!==publicationId||acceptance.body.publicationHash!==input.expectedPublicationHash||!acceptance.row.evidence_hash||
        acceptance.body.resourceId!==input.agentName||acceptance.body.connectionName!==input.connectionName||
        publication.head.owner_member_id!==actingMemberId||acceptance.head.owner_member_id!==actingMemberId||
        publication.body.organisationId!==organisation.id||acceptance.body.organisationId!==organisation.id||
        acceptance.row.evidence_hash.toString('hex')!==input.expectedAcceptanceHash)return requestDenied();
    const pubProjection=publication.body.projection as DescriptorProjection;
    if(!pubProjection||pubProjection.version!==1||pubProjection.connectionName!==input.connectionName||
        createHash('sha256').update(canonicalJson(pubProjection)).digest('hex')!==input.expectedPublicationHash||
        !publication.body.source||canonicalJson(publication.body.source)!==canonicalJson({requestId:discovery.requestId,
          claimOperationId:discovery.claimOperationId,revision:discovery.revision,consentGeneration:discovery.consentGeneration,policyHash:discovery.policyHash})||
        canonicalJson(publication.body.capture)!==canonicalJson(discovery.capture))return requestDenied();
    if(!this.routeLifecycle)return requestDenied();
    const namespaceClient=requireDefinitionNamespace();
    const route=await this.routeLifecycle.reviewOutsideRoute(discovery.capture.outside.connection.url,options.deadlineAtMs);
    this.#assertMainNamespace(namespaceClient,options.deadlineAtMs);
    await checkConsoleSourceDeadlines(db);
    if(routePolicyHash&&route.policyHash!==routePolicyHash)return requestDenied();
    const editor=await this.#captureDescriptorEditor(db,editorId,actingMemberId,organisation.id,input.agentName,input.connectionName,
      {definitionHash:discovery.capture.agent.definitionHash,accessRevision:discovery.capture.agent.accessRevision});
    if(canonicalJson(editorBeforeHead)!==canonicalJson(editor))return requestDenied();
    // Keep the long-lived policy compact. The full descriptor remains encrypted in
    // publication evidence; executable policy binds its digest and accepted scope.
    const acceptedScope={scope:pubProjection.scope,allow:[...pubProjection.allow].sort(),read:[...pubProjection.read].sort()};
    const descriptorDigest=createHash('sha256').update(canonicalJson(pubProjection)).digest('hex');
    const semantic={version:1,purpose:'outside-executable-v1',ownerMemberId:actingMemberId,accountId,
      resourceId:input.agentName,connectionName:input.connectionName,capture:discovery.capture,route,
      publication:{id:publicationId,hash:input.expectedPublicationHash,descriptorDigest,acceptedScope},
      acceptance:{id:acceptanceId,hash:input.expectedAcceptanceHash,editorMemberId:editorId}};
    const semanticJson=canonicalJson(semantic);
    if(Buffer.byteLength(semanticJson)>8192)return requestDenied();
    const policyHash=createHash('sha256').update(semanticJson).digest('hex');
    if(input.expectedPolicyHash!==undefined&&policyHash!==input.expectedPolicyHash)return requestDenied();
    const latest=await db.query<{consent:string}>(`SELECT COALESCE(max(consent_generation),0)::text AS consent
      FROM outside_custody_revisions WHERE account_id=$1`,[accountId]);
    const lastConsent=Math.max(number(discovery.head.consent_generation),Number(latest.rows[0]?.consent??'0'));
    if(!Number.isSafeInteger(lastConsent)||lastConsent>=Number.MAX_SAFE_INTEGER||
        consentMode==='next'&&lastConsent+1!==input.expectedConsentGeneration||consentMode==='current'&&lastConsent!==input.expectedConsentGeneration)return requestDenied();
    const review:ActivationReviewV1={version:1,accountId,ownerMemberId:actingMemberId,resourceId:input.agentName,connectionName:input.connectionName,
      expectedGeneration:input.expectedGeneration,expectedCandidateRevision:input.expectedCandidateRevision,sourceRevision:discovery.revision,
      sourceRequestId:discovery.requestId,sourceClaimOperationId:discovery.claimOperationId,publicationId,publicationHash:input.expectedPublicationHash,
      acceptanceId,acceptanceHash:input.expectedAcceptanceHash,policyHash,capture:editor,route,consentGeneration:input.expectedConsentGeneration};
    const reviewHash=createHash('sha256').update(canonicalJson(review)).digest('hex');
    return {review,reviewHash,publication:publication.body,acceptance:acceptance.body,discovery};
  }

  async stage(sessionToken:string,input:ActivationSelectors & {operationId:string;activationReviewId:string;expectedActivationReviewHash:string},
    options:{deadlineAtMs:number}):Promise<OutsideOperationResult>{
    const schema=z.strictObject({accountId:uuid,agentName:z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),connectionName:z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
      requestId:uuid,claimOperationId:uuid,publicationId:uuid,acceptanceId:uuid,expectedGeneration:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      expectedCandidateRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),expectedConsentGeneration:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      expectedDefinitionHash:z.string().regex(/^[a-f0-9]{64}$/),expectedAccessRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      expectedPublicationHash:z.string().regex(/^[a-f0-9]{64}$/),expectedAcceptanceHash:z.string().regex(/^[a-f0-9]{64}$/),expectedPolicyHash:z.string().regex(/^[a-f0-9]{64}$/),
      operationId:uuid,activationReviewId:uuid,expectedActivationReviewHash:z.string().regex(/^[a-f0-9]{64}$/)});
    const parsed=schema.safeParse(input);if(!parsed.success){wipeRejectedCredentialInput(input);return requestDenied();}
    if(!Number.isFinite(options?.deadlineAtMs)||options.deadlineAtMs<=Date.now())return requestDenied();
    const value=parsed.data,operationId=value.operationId,accountId=value.accountId;
    const selectors:ActivationSelectors=value;
    return this.#inMainNamespace({...options,operationId},()=>this.#withHumanSession(sessionToken,async(db,memberId)=>{
      const priorLocator=await db.query<{operation_kind:string;event_phase:string}>(
        "SELECT operation_kind,event_phase FROM outside_custody_operations WHERE operation_id=$1 AND account_id=$2",[operationId,accountId]);
      if(priorLocator.rows.length){
        if(priorLocator.rows.length!==1||priorLocator.rows[0]?.operation_kind!=='stage'||priorLocator.rows[0]?.event_phase!=='operation')return requestDenied();
        const prior=await this.#readEvidence(db,accountId,operationId,'activation-review-v1');
        const body=stagedEvidenceSchema.parse(prior.body),review=body.review;
        const current=await this.#prepareActivationReview(db,memberId,selectors,options,undefined,'current','staged');
        if(prior.row.outcome!=='staged'||prior.row.actor_member_id!==memberId||body.reviewHash!==value.expectedActivationReviewHash||
            canonicalJson(review)!==canonicalJson(current.review)||current.reviewHash!==value.expectedActivationReviewHash||
            current.discovery.head.candidate_revision!==String(body.candidateRevision)||
            body.candidateGeneration!==value.expectedGeneration+1||body.consentGeneration!==value.expectedConsentGeneration)return requestDenied();
        return this.#recordEvidence(db,{operationId,accountId,ownerMemberId:memberId,actorMemberId:memberId,kind:'stage',
          evidenceKind:'activation-review-v1',body,expectedGeneration:value.expectedGeneration,resultGeneration:value.expectedGeneration,
          credentialRevision:body.candidateRevision,outcome:'staged',
          requestIdentity:{activationReviewId:value.activationReviewId,activationReviewHash:value.expectedActivationReviewHash}});
      }
      const prepared=await this.#prepareActivationReview(db,memberId,selectors,options);
      const preview=await this.#readEvidence(db,accountId,value.activationReviewId,'activation-review-v1');
      const storedReviewHash=createHash('sha256').update(canonicalJson(preview.body)).digest('hex');
      if(preview.row.outcome!=='previewed'||preview.row.actor_member_id!==memberId||storedReviewHash!==value.expectedActivationReviewHash||
          canonicalJson(preview.body)!==canonicalJson(prepared.review)||prepared.reviewHash!==value.expectedActivationReviewHash)return requestDenied();
      const leaseLifecycle=this.routeLifecycle;if(!leaseLifecycle)return requestDenied();
      const namespaceClient=requireDefinitionNamespace();
      return leaseLifecycle.withAppliedOutsideRoute(prepared.discovery.capture.outside.connection.url,prepared.review.route.policyHash,
        options.deadlineAtMs,async lease=>{
          const route=await lease.assertCurrent();
          this.#assertMainNamespace(namespaceClient,options.deadlineAtMs);
          await checkConsoleSourceDeadlines(db);
          if(canonicalJson(route)!==canonicalJson(prepared.review.route))return requestDenied();
          const current=await this.#prepareActivationReview(db,memberId,selectors,options,route.policyHash);
          if(current.reviewHash!==value.expectedActivationReviewHash||canonicalJson(current.review)!==canonicalJson(preview.body))return requestDenied();
          await lease.assertCurrent();this.#assertMainNamespace(namespaceClient,options.deadlineAtMs);
          await checkConsoleSourceDeadlines(db);
          const head=current.discovery.head;
          if(head.state!=='active'||number(head.generation)!==value.expectedGeneration||
              (head.candidate_revision===null?null:number(head.candidate_revision))!==value.expectedCandidateRevision)return requestDenied();
          await this.capacity(db,accountId,'stage',true);
          const source=await db.query<{owner_member_id:string;generation:string;credential_revision:string;consent_generation:string;revision_purpose:string;
            policy_json:string;policy_hash:Buffer;operation_id:string;nonce:Buffer;ciphertext:Buffer}>(`SELECT owner_member_id,generation::text,credential_revision::text,
              consent_generation::text,revision_purpose,policy_json::text,policy_hash,operation_id,nonce,ciphertext
            FROM outside_custody_revisions WHERE account_id=$1 AND credential_revision=$2`,[accountId,current.discovery.revision]);
          const sourceRow=source.rows[0];
          if(source.rows.length!==1||!sourceRow||sourceRow.owner_member_id!==memberId||sourceRow.revision_purpose!=='discovery'||
              sourceRow.operation_id!==current.discovery.claimOperationId||!sourceRow.policy_hash.equals(Buffer.from(current.discovery.policyHash,'hex'))||
              number(sourceRow.credential_revision)!==current.discovery.revision||number(sourceRow.consent_generation)!==current.discovery.consentGeneration)return requestDenied();
          let sourcePlain:Buffer|undefined;
          try{
            await lease.assertCurrent();this.#assertMainNamespace(namespaceClient,options.deadlineAtMs);await checkConsoleSourceDeadlines(db);
            const max=await db.query<{revision:string}>(`SELECT COALESCE(max(credential_revision),0)::text AS revision FROM outside_custody_revisions WHERE account_id=$1`,[accountId]);
            const previous=Number(max.rows[0]?.revision??'0');if(!Number.isSafeInteger(previous)||previous<1||previous>=Number.MAX_SAFE_INTEGER)return requestDenied();
            const candidateRevision=previous+1,candidateGeneration=value.expectedGeneration+1;
            if(candidateGeneration>Number.MAX_SAFE_INTEGER)return requestDenied();
            await lease.assertCurrent();this.#assertMainNamespace(namespaceClient,options.deadlineAtMs);await checkConsoleSourceDeadlines(db);
            sourcePlain=openBound(this.key,sourceRow.nonce,sourceRow.ciphertext,{ownerMemberId:memberId,accountId,resourceId:value.agentName,
              connectionName:value.connectionName,generation:number(sourceRow.generation),credentialRevision:current.discovery.revision,
              consentGeneration:current.discovery.consentGeneration,operationId:current.discovery.claimOperationId,revisionPurpose:'discovery',
              policyHash:current.discovery.policyHash});
            outsideBearer(sourcePlain);
            const projection=current.publication.projection as DescriptorProjection;
            const semantic={version:1,purpose:'outside-executable-v1',ownerMemberId:memberId,accountId,resourceId:value.agentName,
              connectionName:value.connectionName,capture:current.discovery.capture,route:current.review.route,
              publication:{id:value.publicationId,hash:value.expectedPublicationHash,
                descriptorDigest:createHash('sha256').update(canonicalJson(projection)).digest('hex'),
                acceptedScope:{scope:projection.scope,allow:[...projection.allow].sort(),read:[...projection.read].sort()}},
              acceptance:{id:value.acceptanceId,hash:value.expectedAcceptanceHash,
                editorMemberId:acceptanceEvidenceSchema.parse(current.acceptance).editorMemberId}};
            const policyJson=canonicalJson(semantic),policyHash=createHash('sha256').update(policyJson).digest('hex');
            if(policyHash!==value.expectedPolicyHash||Buffer.byteLength(policyJson)>8192)return requestDenied();
            const coordinates:BoundCoordinates={ownerMemberId:memberId,accountId,resourceId:value.agentName,connectionName:value.connectionName,
              generation:candidateGeneration,credentialRevision:candidateRevision,consentGeneration:value.expectedConsentGeneration,operationId,
              revisionPurpose:'executable',policyHash};
            const sealed=sealBound(this.key,sourcePlain,coordinates);
            await db.query(`INSERT INTO outside_custody_revisions(account_id,owner_member_id,credential_revision,generation,consent_generation,
              revision_purpose,policy_json,policy_hash,operation_id,nonce,ciphertext)
              VALUES($1,$2,$3,$4,$5,'executable',$6::jsonb,$7,$8,$9,$10)`,
              [accountId,memberId,candidateRevision,candidateGeneration,value.expectedConsentGeneration,policyJson,Buffer.from(policyHash,'hex'),
                operationId,sealed.nonce,sealed.ciphertext]);
            this.#assertMainNamespace(namespaceClient,options.deadlineAtMs);
            const changed=await db.query(`UPDATE outside_custody_accounts SET candidate_revision=$2,consent_generation=$3,updated_at=clock_timestamp()
              WHERE account_id=$1 AND owner_member_id=$4 AND generation=$5 AND candidate_revision IS NOT DISTINCT FROM $6 AND state='active'`,
              [accountId,candidateRevision,value.expectedConsentGeneration,memberId,value.expectedGeneration,value.expectedCandidateRevision]);
            if(changed.rowCount!==1)return requestDenied();
            const stageEvidence={version:1,review:current.review,reviewHash:current.reviewHash,candidateRevision,candidateGeneration,
              consentGeneration:value.expectedConsentGeneration,policyJson:semantic};
            const recorded=await this.#recordEvidence(db,{operationId,accountId,ownerMemberId:memberId,actorMemberId:memberId,kind:'stage',
              evidenceKind:'activation-review-v1',body:stageEvidence,expectedGeneration:value.expectedGeneration,
              resultGeneration:value.expectedGeneration,credentialRevision:candidateRevision,outcome:'staged',
              requestIdentity:{activationReviewId:value.activationReviewId,activationReviewHash:value.expectedActivationReviewHash}});
            await lease.assertCurrent();this.#assertMainNamespace(namespaceClient,options.deadlineAtMs);
            await checkConsoleSourceDeadlines(db);
            return recorded;
          }finally{sourcePlain?.fill(0);}
        });
    },{...options,operationId}));
  }

  async apply(sessionToken:string,input:ActivationSelectors & {operationId:string;activationReviewId:string;expectedActivationReviewHash:string;
    stageOperationId:string;candidateRevision:number},options:{deadlineAtMs:number}):Promise<OutsideOperationResult>{
    const schema=z.strictObject({accountId:uuid,agentName:z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),connectionName:z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
      requestId:uuid,claimOperationId:uuid,publicationId:uuid,acceptanceId:uuid,expectedGeneration:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      expectedCandidateRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),expectedConsentGeneration:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      expectedDefinitionHash:z.string().regex(/^[a-f0-9]{64}$/),expectedAccessRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      expectedPublicationHash:z.string().regex(/^[a-f0-9]{64}$/),expectedAcceptanceHash:z.string().regex(/^[a-f0-9]{64}$/),expectedPolicyHash:z.string().regex(/^[a-f0-9]{64}$/),
      operationId:uuid,activationReviewId:uuid,expectedActivationReviewHash:z.string().regex(/^[a-f0-9]{64}$/),stageOperationId:uuid,
      candidateRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)});
    const parsed=schema.safeParse(input);if(!parsed.success||!Number.isFinite(options?.deadlineAtMs)||options.deadlineAtMs<=Date.now())return requestDenied();
    const value=parsed.data,accountId=value.accountId,operationId=value.operationId;
    const selectors:ActivationSelectors=value;
    return this.#inMainNamespace({...options,operationId},()=>this.#withHumanSession(sessionToken,async(db,memberId)=>{
      const stage=this.#readEvidence(db,accountId,value.stageOperationId,'activation-review-v1');
      const preview=this.#readEvidence(db,accountId,value.activationReviewId,'activation-review-v1');
      const [stageEvidence,previewEvidence]=await Promise.all([stage,preview]);
      const stageBody=stageEvidence.body,review=stageBody.review as ActivationReviewV1;
      if(stageEvidence.row.operation_kind!=='stage'||stageEvidence.row.outcome!=='staged'||stageEvidence.row.actor_member_id!==memberId||
          !review||review.version!==1||stageBody.candidateRevision!==value.candidateRevision||
          previewEvidence.row.operation_kind!=='activation-preview'||previewEvidence.row.outcome!=='previewed'||
          previewEvidence.row.actor_member_id!==memberId||createHash('sha256').update(canonicalJson(previewEvidence.body)).digest('hex')!==value.expectedActivationReviewHash||
          canonicalJson(previewEvidence.body)!==canonicalJson(review)||stageBody.reviewHash!==value.expectedActivationReviewHash)return requestDenied();
      const headLocator=await this.head(db,accountId,false);
      if(!headLocator||headLocator.owner_member_id!==memberId||headLocator.resource_id!==value.agentName||
          headLocator.connection_name!==value.connectionName||headLocator.state!=='active')return requestDenied();
      const pending=headLocator.candidate_revision===String(value.candidateRevision)&&number(headLocator.generation)===value.expectedGeneration&&
        number(headLocator.consent_generation)===value.expectedConsentGeneration;
      const applied=headLocator.active_revision===String(value.candidateRevision)&&headLocator.candidate_revision===null&&
        number(headLocator.generation)===value.expectedGeneration+1&&number(headLocator.consent_generation)===value.expectedConsentGeneration;
      if(!pending&&!applied)return requestDenied();
      const lifecycle=this.routeLifecycle;if(!lifecycle)return requestDenied();
      const namespaceClient=requireDefinitionNamespace();
      const stagedPolicy=stageBody.policyJson as Record<string,unknown>;
      const stagedCapture=stagedPolicy?.capture as import('@lares/agent-kit/grant-store').OutsideUseCapture|undefined;
      const endpoint=stagedCapture?.outside?.connection?.url;
      if(typeof endpoint!=='string')return requestDenied();
      // The operation id is the receipt key, so its digest binds the complete
      // validated request and authenticated actor, not a partial selector set.
      const priorHash=createHash('sha256').update(canonicalJson({kind:'apply',accountId,memberId,request:value})).digest();
      return lifecycle.withAppliedOutsideRoute(endpoint,
        review.route.policyHash,options.deadlineAtMs,async lease=>{
          const route=await lease.assertCurrent();this.#assertMainNamespace(namespaceClient,options.deadlineAtMs);
          const organisation=await this.#humanOrganisation(db,memberId);
          const useCapture=await captureOutsideHumanUse(db,memberId,value.agentName,value.connectionName,
            {definitionHash:value.expectedDefinitionHash,accessRevision:value.expectedAccessRevision});
          const acceptance=await this.#readEvidence(db,accountId,value.acceptanceId,'descriptor-acceptance-v1');
          const editorId=acceptance.row.actor_member_id;
          if(useCapture.actor.memberId!==memberId||useCapture.actor.organisationId!==organisation.id||!editorId||
              acceptance.body.editorMemberId!==editorId||acceptance.body.publicationId!==value.publicationId||
              acceptance.body.publicationHash!==value.expectedPublicationHash)return requestDenied();
          const editorCapture=await this.#captureDescriptorEditor(db,editorId,memberId,organisation.id,value.agentName,value.connectionName,
            {definitionHash:useCapture.agent.definitionHash,accessRevision:useCapture.agent.accessRevision});
          if(canonicalJson(editorCapture)!==canonicalJson(review.capture))return requestDenied();
          const prior=await this.priorOperation(db,operationId,priorHash,accountId,memberId,'apply',value.expectedGeneration);
          if(prior)return prior;
          if(!pending)return requestDenied();
          const current=await this.#prepareActivationReview(db,memberId,{...selectors,expectedCandidateRevision:review.expectedCandidateRevision},options,
            route.policyHash,'current','staged');
          if(current.reviewHash!==value.expectedActivationReviewHash||canonicalJson(current.review)!==canonicalJson(review)||
              current.discovery.head.candidate_revision!==String(value.candidateRevision))return requestDenied();
          await lease.assertCurrent();await checkConsoleSourceDeadlines(db);
          const candidate=await db.query<{owner_member_id:string;generation:string;credential_revision:string;consent_generation:string;revision_purpose:string;
            policy_json:string;policy_hash:Buffer;operation_id:string;nonce:Buffer;ciphertext:Buffer}>(`SELECT owner_member_id,generation::text,credential_revision::text,
              consent_generation::text,revision_purpose,policy_json::text,policy_hash,operation_id,nonce,ciphertext
            FROM outside_custody_revisions WHERE account_id=$1 AND credential_revision=$2`,[accountId,value.candidateRevision]);
          const row=candidate.rows[0];
          if(candidate.rows.length!==1||!row||row.owner_member_id!==memberId||row.revision_purpose!=='executable'||row.operation_id!==value.stageOperationId||
              number(row.generation)!==value.expectedGeneration+1||number(row.consent_generation)!==value.expectedConsentGeneration||
              row.policy_hash.toString('hex')!==value.expectedPolicyHash||canonicalJson(JSON.parse(row.policy_json))!==canonicalJson(stageBody.policyJson))return requestDenied();
          // Verify authenticated encryption and current policy before changing the active pointer.
          await lease.assertCurrent();this.#assertMainNamespace(namespaceClient,options.deadlineAtMs);await checkConsoleSourceDeadlines(db);
          const plaintext=openBound(this.key,row.nonce,row.ciphertext,{ownerMemberId:memberId,accountId,resourceId:value.agentName,
            connectionName:value.connectionName,generation:number(row.generation),credentialRevision:value.candidateRevision,
            consentGeneration:value.expectedConsentGeneration,operationId:value.stageOperationId,revisionPurpose:'executable',policyHash:value.expectedPolicyHash});
          try{outsideBearer(plaintext);}finally{plaintext.fill(0);}
          await this.capacity(db,accountId,'apply',false);
          const next=value.expectedGeneration+1;
          if(next>Number.MAX_SAFE_INTEGER)return requestDenied();
          const changed=await db.query(`UPDATE outside_custody_accounts SET generation=$2,active_revision=$3,candidate_revision=NULL,
            consent_generation=$4,updated_at=clock_timestamp() WHERE account_id=$1 AND owner_member_id=$5 AND generation=$6
            AND candidate_revision=$3 AND consent_generation=$4 AND state='active'`,
            [accountId,next,value.candidateRevision,value.expectedConsentGeneration,memberId,value.expectedGeneration]);
          if(changed.rowCount!==1)return requestDenied();
          await lease.assertCurrent();this.#assertMainNamespace(namespaceClient,options.deadlineAtMs);await checkConsoleSourceDeadlines(db);
          return this.record(db,{operationId,accountId,ownerMemberId:memberId,kind:'apply',hash:priorHash,expected:value.expectedGeneration,
            result:next,revision:value.candidateRevision,outcome:'applied'});
        });
    },{...options,operationId}));
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

  /** Shared current authority and accepted-catalog validation; metadata never opens credentials. */
  async #checkRuntimeExecutable(binding:OutsideExecutionBinding,
    input:Pick<OutsideToolCallInput,'definitionHash'|'connectionName'|'accountId'|'credentialRevision'>,
    options:{assertCurrent?:()=>void},db:PoolClient,consume:boolean,assertRoute?:()=>Promise<unknown>,
    execution?:Pick<OutsideToolCallInput,'callId'|'requestId'|'toolName'|'input'>){
    const session=await requireConsoleSessionBinding({agent:binding.agent,incarnation:binding.incarnation,sessionId:binding.sessionId,
      memberId:binding.memberId,admissionNonce:binding.admissionNonce},db as never);
    if(session.policyRevision!==binding.policyRevision)return denied();
    options.assertCurrent?.();
    const current=await captureOutsideHumanUse(db,binding.memberId,binding.agent,input.connectionName);
    if(current.actor.memberId!==binding.memberId||current.agent.definitionHash!==input.definitionHash||
        current.outside.connection.name!==input.connectionName||(execution&&!current.outside.connection.allow.includes(execution.toolName)))return denied();
    const actor=await currentMember(db as never,binding.memberId,{lock:'share'}),approver=await currentMember(db as never,binding.approverMemberId,{lock:'share'});
    if(!actor||!approver||actor.organisationId!==approver.organisationId)return denied();
    // A staged replacement is not active. Preserve the unchanged active pointer
    // and generation after failed Apply; successful activation invalidates old work.
    const head=await this.head(db,input.accountId,true);
    if(!head||head.owner_member_id!==current.agent.ownerMemberId||head.resource_id!==binding.agent||
        head.connection_name!==input.connectionName||head.state!=='active'||head.active_revision===null||
        number(head.active_revision)!==input.credentialRevision)return denied();
    const revision=await db.query<{owner_member_id:string;generation:string;credential_revision:string;consent_generation:string;
      revision_purpose:string;policy_json:string;policy_hash:Buffer;operation_id:string;nonce:Buffer;ciphertext:Buffer}>(`SELECT owner_member_id,
        generation::text,credential_revision::text,consent_generation::text,revision_purpose,policy_json::text,policy_hash,operation_id,nonce,ciphertext
      FROM outside_custody_revisions WHERE account_id=$1 AND credential_revision=$2`,[input.accountId,input.credentialRevision]);
    const row=revision.rows[0];if(revision.rows.length!==1||!row||row.owner_member_id!==head.owner_member_id||row.revision_purpose!=='executable'||
        !Buffer.isBuffer(row.policy_hash)||row.policy_hash.length!==32||!Buffer.isBuffer(row.nonce)||!Buffer.isBuffer(row.ciphertext))return denied();
    let policy: z.infer<typeof executablePolicySchema>;
    try{policy=executablePolicySchema.parse(JSON.parse(row.policy_json));}catch{return denied();}
    if(createHash('sha256').update(canonicalJson(policy)).digest('hex')!==row.policy_hash.toString('hex')||
        policy.ownerMemberId!==head.owner_member_id||policy.accountId!==input.accountId||policy.resourceId!==binding.agent||
        policy.connectionName!==input.connectionName||canonicalJson(policy.capture)!==canonicalJson(current)||
        number(row.generation)!==number(head.generation)||
        (number(row.consent_generation)!==number(head.consent_generation)&&
          !(head.candidate_revision!==null&&number(head.candidate_revision)>input.credentialRevision&&
            number(row.consent_generation)<number(head.consent_generation)))||
        (execution&&!policy.publication.acceptedScope.allow.includes(execution.toolName)))return denied();
    const publication=await this.#readEvidence(db,input.accountId,policy.publication.id,'descriptor-publication-v1');
    if(publication.row.outcome!=='published'||publication.body.publicationHash!==policy.publication.hash||
        publication.row.evidence_hash?.toString('hex')!==publication.bodyHash)return denied();
    const projection=publication.body.projection as DescriptorProjection;
    // Keep the authenticated full-publication body hash above, and independently bind
    // the descriptor to the validated projection that staging actually hashes.
    if(createHash('sha256').update(canonicalJson(projection)).digest('hex')!==policy.publication.descriptorDigest||
        projection.connectionName!==input.connectionName||(execution&&(!projection.allow.includes(execution.toolName)||
        !projection.tools.some(tool=>tool.name===execution.toolName))))return denied();
    const acceptance=await this.#readEvidence(db,input.accountId,policy.acceptance.id,'descriptor-acceptance-v1');
    if(acceptance.row.outcome!=='accepted'||acceptance.row.evidence_hash?.toString('hex')!==policy.acceptance.hash||
        acceptance.body.editorMemberId!==policy.acceptance.editorMemberId||acceptance.body.publicationId!==policy.publication.id||
        acceptance.body.publicationHash!==policy.publication.hash)return denied();
    let plaintext:Buffer|undefined;
    if(consume){
      if(!execution)return denied();
      const selectors={callId:execution.callId,requestId:execution.requestId,sessionId:binding.sessionId,memberId:binding.memberId,
        approverMemberId:binding.approverMemberId,agent:binding.agent,incarnation:binding.incarnation,definitionHash:input.definitionHash,
        connectionName:input.connectionName,accountId:input.accountId,credentialRevision:input.credentialRevision,
        toolName:execution.toolName,payloadHash:outsidePayloadHash(execution.toolName,execution.input)};

      await assertRoute?.();
      options.assertCurrent?.();
      await consumeOutsideExecutionApproval(db,selectors);
      await assertRoute?.();
      plaintext=openBound(this.key,row.nonce,row.ciphertext,{ownerMemberId:row.owner_member_id,accountId:input.accountId,
        resourceId:binding.agent,connectionName:input.connectionName,generation:number(row.generation),credentialRevision:input.credentialRevision,
        consentGeneration:number(row.consent_generation),operationId:row.operation_id,revisionPurpose:'executable',policyHash:row.policy_hash.toString('hex')});
      try{
        outsideBearer(plaintext);
        await checkConsoleSourceDeadlines(db);
        return {capture:current,head,revision:row,policy,credential:plaintext};
      }catch(error){plaintext.fill(0);throw error;}
    }
    await checkConsoleSourceDeadlines(db);
    return {capture:current,head,revision:row,policy,projection};
  }

  /** Read only the currently executable, accepted descriptors under the existing source boundary. */
  async acceptedRuntimeTools(binding:OutsideExecutionBinding,definitionHash:string,connectionName:string,
    options:{deadlineAtMs:number;assertCurrent?:()=>void}):Promise<OutsideListedTool[]>{
    const release=this.#beginOperation(requestDenied);
    try{
      if(!/^[a-z][a-z0-9-]{1,30}$/.test(connectionName)||!hashSchema.safeParse(definitionHash).success)return requestDenied();
      return await this.#inMainNamespace(options,()=>consoleSourceTransaction(this.pool,async source=>{
        const db=source as PoolClient;
        options.assertCurrent?.();
        const current=await captureOutsideHumanUse(db,binding.memberId,binding.agent,connectionName);
        const heads=await db.query<{account_id:string;active_revision:string}>(`SELECT account_id::text,active_revision::text
          FROM outside_custody_accounts WHERE owner_member_id=$1 AND resource_id=$2 AND connection_name=$3 AND state='active'
          AND active_revision IS NOT NULL`,[current.agent.ownerMemberId,binding.agent,connectionName]);
        if(heads.rows.length!==1)return denied();
        const head=heads.rows[0]!;
        const checked=await this.#checkRuntimeExecutable(binding,{definitionHash,connectionName,accountId:head.account_id,
          credentialRevision:number(head.active_revision)},options,db,false);
        options.assertCurrent?.();
        return checked.projection!.tools.filter(tool=>checked.policy.publication.acceptedScope.allow.includes(tool.name)&&
          checked.projection!.allow.includes(tool.name)&&checked.capture.outside.connection.allow.includes(tool.name));
      },undefined,options));
    }catch{return requestDenied();}finally{release();}
  }

  /** Keeper-only A1 seam. `binding` must come from the authenticated runtime transport; receipt
   *  selectors alone are never identity or session authority. The credential is decrypted only
   *  after current authority, accepted catalog, route, and one-use receipt checks succeed. */
  async dispatchApproved(binding:OutsideExecutionBinding,requested:OutsideToolCallRequest,options:{deadlineAtMs:number;assertCurrent?:()=>void}):Promise<OutsideToolCallResult>{
    const release=this.#beginOperation(requestDenied);
    try{
      if(!binding||!/^([a-z][a-z0-9-]{1,30})$/.test(binding.agent)||!uuid.safeParse(binding.incarnation).success||
          !/^[A-Za-z0-9_-]{1,128}$/.test(binding.sessionId)||!/^[^\s,;\x00-\x1f\x7f]{1,256}$/.test(binding.memberId)||
          !/^[^\s,;\x00-\x1f\x7f]{1,256}$/.test(binding.approverMemberId))return requestDenied();
      if(!Number.isFinite(options?.deadlineAtMs)||options.deadlineAtMs<=Date.now()||!requested||
          Object.keys(requested).some(key=>!['callId','connectionName','toolName','input'].includes(key))||
          !outsideExecutionApprovalSchema.shape.callId.safeParse(requested.callId).success||
          !outsideExecutionApprovalSchema.shape.connectionName.safeParse(requested.connectionName).success||
          !outsideExecutionApprovalSchema.shape.toolName.safeParse(requested.toolName).success)return requestDenied();
      options.assertCurrent?.();
      const payloadHash=outsidePayloadHash(requested.toolName,requested.input);
      const lifecycle=this.routeLifecycle;if(!lifecycle)return requestDenied();
      return await this.#inMainNamespace({deadlineAtMs:options.deadlineAtMs},async()=>{
        const namespaceClient=requireDefinitionNamespace();
        const runtime=await namespaceClient.query(`SELECT r.state,r.pending,r.ownership_token::text,r.runtime_control_token::text,d.hash
          FROM agent_resources r JOIN agent_definitions d ON d.name=r.name
          WHERE r.name=$1 AND d.status='valid'`,[binding.agent]);
        const runtimeRow=runtime.rows[0];
        if(runtime.rows.length!==1||!runtimeRow||runtimeRow.ownership_token!==binding.incarnation||
            runtimeRow.runtime_control_token!==binding.incarnation||runtimeRow.state!=='ready'||runtimeRow.pending!==false||
            !hashSchema.safeParse(runtimeRow.hash).success)return requestDenied();

        // Receipt data belongs to the custody role. The broker's application role never reads it.
        const receipt=await consoleSourceTransaction(this.pool,async source=>{
          const rows=await source.query(`SELECT call_id AS "callId",request_id AS "requestId",session_id AS "sessionId",member_id AS "memberId",
            approver_member_id AS "approverMemberId",agent,incarnation::text,encode(definition_hash,'hex') AS "definitionHash",
            connection_name AS "connectionName",account_id::text AS "accountId",credential_revision::text AS "credentialRevision",
            tool_name AS "toolName",encode(payload_hash,'hex') AS "payloadHash"
            FROM outside_execution_approvals WHERE call_id=$1 AND agent=$2 AND incarnation=$3::uuid AND session_id=$4
            AND member_id=$5 AND approver_member_id=$6 AND definition_hash=decode($7,'hex') AND connection_name=$8
            AND tool_name=$9 AND payload_hash=decode($10,'hex') AND consumed_at IS NULL AND expires_at>clock_timestamp()`,
            [requested.callId,binding.agent,binding.incarnation,binding.sessionId,binding.memberId,binding.approverMemberId,runtimeRow.hash,
             requested.connectionName,requested.toolName,payloadHash]);
          if(rows.rows.length!==1)return denied();
          return outsideExecutionApprovalSchema.omit({expiresAt:true}).parse({...rows.rows[0],credentialRevision:Number(rows.rows[0]!.credentialRevision)});
        },undefined,{deadlineAtMs:options.deadlineAtMs});
        options.assertCurrent?.();
        const {payloadHash:_payloadHash,...selectors}=receipt;
        const input:OutsideToolCallInput={...selectors,input:requested.input};

        // Read only the stored executable revision to learn its already-reviewed route. Every
        // authority and receipt field is checked again under the owned source transaction below.
        const check=(db:PoolClient,consume:boolean,assertRoute?:()=>Promise<unknown>)=>
          this.#checkRuntimeExecutable(binding,input,options,db,consume,assertRoute,input);
        const prepare=(consume:boolean,assertRoute?:()=>Promise<unknown>)=>consoleSourceTransaction(this.pool,
          source=>check(source as PoolClient,consume,assertRoute),undefined,{deadlineAtMs:options.deadlineAtMs});
        const locator=await prepare(false);
        {
          const endpoint=discoveryEndpoint(locator.capture.outside.connection.url),routePolicyHash=locator.policy.route.policyHash;
          const operationId=randomUUID(),state:OutsideClaimIdentityState={claim:{requestId:input.requestId,operationId,accountId:input.accountId,
            agentName:input.agent,connectionName:input.connectionName,destination:endpoint.href,policyHash:routePolicyHash,
            definitionHash:input.definitionHash,accessRevision:locator.capture.agent.accessRevision},ownerMemberId:locator.head.owner_member_id,
            expectedGeneration:number(locator.head.generation),generation:number(locator.head.generation),activeRevision:input.credentialRevision,
            candidateRevision:null,headConsentGeneration:number(locator.head.consent_generation),consentGeneration:number(locator.head.consent_generation),
            credentialRevision:input.credentialRevision,requestHash:payloadHash,routePolicyHash,deadlineAtMs:options.deadlineAtMs,assertRuntimeCurrent:options.assertCurrent,assertExecutionCurrent:async db=>{
              await check(db,false);
              // Consuming the receipt does not extend its approval window. Even an initialize
              // round-trip must not let tools/call cross expiry or a removed approval.
              const approval=await db.query(`SELECT call_id FROM outside_execution_approvals
                WHERE call_id=$1 AND request_id=$2 AND consumed_at IS NOT NULL AND expires_at>clock_timestamp()`,[input.callId,input.requestId]);
              if(approval.rows.length!==1)return denied();
            }};
          return await lifecycle.withAppliedOutsideRoute(endpoint.href,routePolicyHash,options.deadlineAtMs,async lease=>{
            const route=await lease.assertCurrent();
            if(canonicalJson(route)!==canonicalJson(locator.policy.route))return requestDenied();
            const ready=await prepare(true,()=>lease.assertCurrent());
            if(canonicalJson(ready.capture)!==canonicalJson(locator.capture)||canonicalJson(ready.head)!==canonicalJson(locator.head)||
                canonicalJson(ready.policy)!==canonicalJson(locator.policy)||!ready.credential)return requestDenied();
            const progress={dispatched:false};
            try{return await consoleSourceTransaction(this.pool,async source=>{
                return await this.#exchangeDiscovery(source as PoolClient,state,lease,ready.credential!,progress,
                  {name:input.toolName,input:input.input});
              },undefined,{deadlineAtMs:options.deadlineAtMs});}
            finally{ready.credential.fill(0);}
          });
        }
      });
    }catch(error){if(error instanceof OutsideCustodyRecoveryRequired)throw error;return requestDenied();}
    finally{release();}
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
        if(!(error instanceof OutsideCustodyRecoveryRequired)&&!(error instanceof SourceAuthorityUnavailable))throw error;
        this.#assertOpen(requestDenied);
        const found=await inspect();this.#assertOpen(requestDenied);
        if(found&&found.operationId===operationId)return found;
        throw new OutsideCustodyRecoveryRequired(operationId);
      }
    }finally{release();}
  }
}
