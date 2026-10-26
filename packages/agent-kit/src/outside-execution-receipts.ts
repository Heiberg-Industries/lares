import { createHash } from 'node:crypto';
import { z } from 'zod';

const name = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().min(1).max(256).refine(value => !/[\s,;\x00-\x1f\x7f]/.test(value));
const uuid = z.string().uuid();

/** Exact, secret-free approval facts for one outside MCP call. */
export const outsideExecutionApprovalSchema = z.strictObject({
  callId: z.string().min(1).max(128).refine(value => !/[\x00-\x1f\x7f]/.test(value)),
  requestId: z.string().min(1).max(128).refine(value => !/[\x00-\x1f\x7f]/.test(value)),
  sessionId: z.string().min(1).max(128).refine(value => !/[\x00-\x1f\x7f]/.test(value)),
  memberId: identity,
  approverMemberId: identity,
  agent: name,
  incarnation: uuid,
  definitionHash: hash,
  connectionName: name,
  accountId: uuid,
  credentialRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  toolName: z.string().min(1).max(128).refine(value => !/[\x00-\x1f\x7f]/.test(value)),
  payloadHash: hash,
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type OutsideExecutionApproval = z.infer<typeof outsideExecutionApprovalSchema>;

export interface OutsideExecutionReceiptStore {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

const MAX_INPUT_DEPTH = 64;
const MAX_INPUT_NODES = 65_536;

function assertWireJson(value: unknown): void {
  const active = new WeakSet<object>();
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    if (++nodes > MAX_INPUT_NODES || depth > MAX_INPUT_DEPTH) deny();
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return;
    if (typeof current === 'number') { if (!Number.isFinite(current)) deny(); return; }
    if (typeof current !== 'object') deny();

    const object = current as object;
    if (active.has(object)) deny();
    active.add(object);
    try {
      if (Array.isArray(object)) {
        if (Object.getPrototypeOf(object) !== Array.prototype || object.length > MAX_INPUT_NODES) deny();
        if (Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')) deny();
        const keys = Reflect.ownKeys(object);
        if (keys.length !== object.length + 1 || keys.some(key => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))) deny();
        for (let index = 0; index < object.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(object, String(index));
          if (!descriptor) deny();
          if (!descriptor.enumerable || !('value' in descriptor)) deny();
          visit(descriptor.value, depth + 1);
        }
        return;
      }

      const prototype = Object.getPrototypeOf(object);
      if (prototype !== Object.prototype && prototype !== null) deny();
      if (prototype === Object.prototype && Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')) deny();
      for (const key of Reflect.ownKeys(object)) {
        if (typeof key !== 'string') deny();
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor) deny();
        if (!descriptor.enumerable || !('value' in descriptor)) deny();
        visit(descriptor.value, depth + 1);
      }
    } finally {
      active.delete(object);
    }
  };
  try { visit(value, 0); } catch { deny(); }
}

export function outsidePayloadHash(toolName: string, input: unknown): string {
  if (typeof toolName !== 'string' || toolName.length === 0 || /[\x00-\x1f\x7f]/.test(toolName)) deny();
  assertWireJson(input);
  return createHash('sha256').update(JSON.stringify({ toolName, input })).digest('hex');
}

function deny(): never { throw new Error('Outside execution approval is unavailable'); }

/** First approved response wins. A repeated approval can never extend its deadline or change its payload. */
export async function recordOutsideExecutionApproval(store: OutsideExecutionReceiptStore, input: OutsideExecutionApproval,
  now = Date.now()): Promise<void> {
  const value = outsideExecutionApprovalSchema.safeParse(input);
  if (!value.success) deny();
  const v = value.data!;
  if (!Number.isSafeInteger(now) || v.expiresAt <= now || v.expiresAt > now + 5 * 60_000) deny();
  await store.query(`INSERT INTO outside_execution_approvals
    (call_id,request_id,session_id,member_id,approver_member_id,agent,incarnation,definition_hash,connection_name,
     account_id,credential_revision,tool_name,payload_hash,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7::uuid,decode($8,'hex'),$9,$10::uuid,$11,$12,decode($13,'hex'),to_timestamp($14::double precision/1000))
    ON CONFLICT(call_id) DO NOTHING`, [v.callId,v.requestId,v.sessionId,v.memberId,v.approverMemberId,v.agent,v.incarnation,
      v.definitionHash,v.connectionName,v.accountId,v.credentialRevision,v.toolName,v.payloadHash,v.expiresAt]);
  const existing = await store.query(`SELECT request_id,session_id,member_id,approver_member_id,agent,incarnation::text,
      encode(definition_hash,'hex') AS definition_hash,connection_name,account_id::text,credential_revision::text AS credential_revision,tool_name,encode(payload_hash,'hex') AS payload_hash,
      floor(extract(epoch from expires_at)*1000)::bigint::text AS expires_at_ms,consumed_at
    FROM outside_execution_approvals WHERE call_id=$1`, [v.callId]);
  const row = existing.rows[0];
  if (!row) deny();
  if (row.consumed_at != null || Number(row.expires_at_ms) <= now) deny();
  const expected = {request_id:v.requestId,session_id:v.sessionId,member_id:v.memberId,approver_member_id:v.approverMemberId,
    agent:v.agent,incarnation:v.incarnation,definition_hash:v.definitionHash,connection_name:v.connectionName,
    account_id:v.accountId,credential_revision:String(v.credentialRevision),tool_name:v.toolName,payload_hash:v.payloadHash,
    expires_at_ms:String(v.expiresAt)};
  if (canonical(row) !== canonical({...expected,consumed_at:null})) deny();
}

/** Lock and consume atomically before any provider dispatch. Replays and changed calls refuse. */
export async function consumeOutsideExecutionApproval(store: OutsideExecutionReceiptStore,
  input: Pick<OutsideExecutionApproval,'callId'|'requestId'|'sessionId'|'memberId'|'approverMemberId'|'agent'|'incarnation'|'definitionHash'|
    'connectionName'|'accountId'|'credentialRevision'|'toolName'|'payloadHash'>, now = Date.now()): Promise<void> {
  const selectors = outsideExecutionApprovalSchema.omit({expiresAt:true}).safeParse(input);
  if (!selectors.success) deny();
  if (!Number.isSafeInteger(now)) deny();
  const v = selectors.data!;
  const result = await store.query(`UPDATE outside_execution_approvals SET consumed_at=clock_timestamp()
    WHERE call_id=$1 AND request_id=$2 AND session_id=$3 AND member_id=$4 AND approver_member_id=$5 AND agent=$6
      AND incarnation=$7::uuid AND definition_hash=decode($8,'hex') AND connection_name=$9 AND account_id=$10::uuid
      AND credential_revision=$11 AND tool_name=$12 AND payload_hash=decode($13,'hex')
      AND consumed_at IS NULL AND expires_at>clock_timestamp()
      AND expires_at>to_timestamp($14::double precision/1000)
    RETURNING call_id`, [v.callId,v.requestId,v.sessionId,v.memberId,v.approverMemberId,v.agent,v.incarnation,v.definitionHash,
      v.connectionName,v.accountId,v.credentialRevision,v.toolName,v.payloadHash,now]);
  if (result.rowCount !== 1) deny();
}
