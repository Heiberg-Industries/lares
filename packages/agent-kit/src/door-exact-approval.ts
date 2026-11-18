/**
 * EXACT APPROVAL OF ONE CALL, ON A CHAT DOOR (Slack, Telegram, any later door in the door table).
 * The door half of `approval-execution.ts`: the same four steps, with a door claim in place of a console
 * admission, because on a door Keeper vouches for the person (ADR-0026, applied to the Vault) and the agent
 * vouches only for the platform event.
 *
 *   1. RESERVE before the card is shown. The agent reads the target through Keeper's door pass, then writes the
 *      reservation (`approval_asks.original_authority`, version 2, kind 'door'): the member Keeper named, the
 *      door claim it was raised under, the target and the policy. No pass, no card: the request is denied in
 *      one sentence from `door-vault-sentences.ts`, and the person is never asked to approve something that cannot run.
 *   2. ATTACH the card. When eve opens the card, the record hook gives the reservation its request id.
 *   3. ANSWER. Only the person who claimed the door, and the installation's owner, on that door, may answer; the
 *      answer is written by this file after eve has verified who tapped.
 *   4. EXECUTE. The approved call must be the exact one reserved, unexpired, unused, answered by that person and
 *      shown to them in full. Keeper repeats every check when it writes (`vault.write`).
 *
 * DOOR-NEUTRAL. No door is named here: which door a platform identity belongs to is the door table
 * (`door-kinds.ts`), who owns a door is the role's `isOwner`, and what a chat's claim is is `door-vault-turn.ts`.
 * A door the table does not know, or a runtime Keeper does not manage, is refused.
 *
 * Every sentence a person can read is thrown from `door-vault-sentences.ts` and nothing else: an error from
 * Keeper, the database or the file system is never copied into one. After an approved card every sentence
 * starts with "You approved" and says nothing was saved (the person can tell a card existed).
 */
import { getPool } from './db.js';
import { callIdFrom, payloadFingerprint, APPROVAL_TTL_MS } from './approval-ledger.js';
import { turnAuthoritySchema } from './authority-contract.js';
import type { AuthorityDatabase } from './console-turn-authority.js';
import { ApprovalRefusal, approvalResponderOf, type ApprovedExecution, type ExactApprovalAdapter } from './approval-execution.js';
import { doorReservationSchema, exactTargetSchema, type DoorReservation } from './exact-approval-request.js';
import { managedIdentity } from './door-authority.js';
import { DOORS, claimEnvNames } from './door-kinds.js';
import { doorSeen, doorVaultRoute, type DoorVaultPoint, type DoorVaultRoute } from './door-vault-turn.js';
import { principalFromAuth } from './principals.js';
import { vaultBrokerUnreachable } from './vault-broker-client.js';
import {
  DOOR_NOTE_APPROVAL_EXPIRED, DOOR_NOTE_CARD_SHORTENED, DOOR_NOTE_CARD_UNCONFIRMED, DOOR_NOTE_SAVE_FAILED,
  DOOR_NOTE_SAVE_NOT_POSSIBLE, DOOR_NOTE_TOOL_UNAVAILABLE, DOOR_NOTE_UNREACHABLE,
} from './door-vault-sentences.js';

/** What the role hands in: how its tool reads a target and its policy, how the turn's Keeper pass is had,
 *  and who owns a door. */
export interface DoorExactDeps {
  adapter: ExactApprovalAdapter;
  /** This turn's Keeper pass and the member Keeper named; throws (with the keeper error as `cause`) when there is none.
   *  The adapter reads the target with it: it is handed to `readTarget` as `ctx.doorPass`. */
  pass(ctx: unknown): Promise<DoorPass>;
  isOwner(authenticator: string | undefined, userId: string | undefined): boolean;
  db?: AuthorityDatabase;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export interface DoorPass { memberId: string; route: DoorVaultRoute; point: DoorVaultPoint; capability: string }

/** A failure AFTER the person approved. Its message is one sentence from the closed list. */
export class DoorApprovalFailure extends Error {
  constructor(sentence: string) { super(sentence); this.name = 'DoorApprovalFailure'; }
}

export interface DoorApprovedExecution extends ApprovedExecution {
  door: { door: string; principal: string; claimRevision: string };
  sessionId: string;
}

type Ctx = {
  callId?: unknown; toolInput?: unknown; toolName?: unknown;
  session?: { id?: unknown; turn?: { id?: unknown; sequence?: unknown }; auth?: { current?: unknown; initiator?: unknown } | null; initiator?: unknown };
  approval?: { responder?: unknown };
};
interface Row {
  request_id: string | null; call_id: string; agent: string; tool: string; payload_hash: string; used_at: unknown; session_id: string;
  original_authority: unknown; acting_member_id: string | null; resolved_by_member_id: string | null; outcome: string | null;
  answered_via: string | null; shown_whole: boolean | null;
}

const database = (d: DoorExactDeps): AuthorityDatabase => d.db ?? getPool();
const nowOf = (d: DoorExactDeps): Date => d.now ?? new Date();
const same = (a: unknown, b: unknown) => payloadFingerprint('authority', a) === payloadFingerprint('authority', b);
const placeOf = (door: string, agent: string, incarnation: string, sessionId: string) => `door:${door}:${agent}:${incarnation}:${sessionId}`;
const neutral = (): never => { throw new Error(DOOR_NOTE_TOOL_UNAVAILABLE); };

async function rowForCall(db: AuthorityDatabase, callId: string): Promise<Row | undefined> {
  if (!callId) return undefined;
  const { rows } = await db.query('SELECT * FROM approval_asks WHERE call_id=$1 FOR UPDATE', [callId]);
  return rows.length === 1 ? rows[0] as Row : undefined;
}

/** The door reservation a row holds, or nothing when it holds another kind of record. */
function reservationOf(row: Row | undefined): DoorReservation | undefined {
  if (!row?.original_authority) return undefined;
  const parsed = doorReservationSchema.safeParse(row.original_authority);
  return parsed.success ? parsed.data : undefined;
}

/** Whether this call id has a door reservation (so its answer is a door answer, not a legacy one). */
export async function isDoorReservationCall(callId: unknown, d: Pick<DoorExactDeps, 'db'> = {}): Promise<boolean> {
  if (typeof callId !== 'string' || callId === '') return false;
  try { return reservationOf(await rowForCall(d.db ?? getPool(), callId)) !== undefined; } catch { return false; }
}

/* ------------------------------------------------------------------------------------------- *
 * 1. Reserve.
 * ------------------------------------------------------------------------------------------- */

/** The refusal sentence for a reservation that failed: keeper not reachable (try again) or not possible here. */
function refusalFor(error: unknown): ApprovalRefusal {
  if (error instanceof ApprovalRefusal) return error;
  const cause = (error as { cause?: unknown } | null | undefined)?.cause ?? error;
  return new ApprovalRefusal(vaultBrokerUnreachable(cause) ? DOOR_NOTE_UNREACHABLE : DOOR_NOTE_SAVE_NOT_POSSIBLE);
}

/** Called before the card is shown. Throws an {@link ApprovalRefusal} (one closed sentence) when the card cannot be
 *  reserved; it never throws anything else. A retry of the same call finds the same reservation. */
export async function reserveDoorExactApproval(ctx: Ctx, tool: string, d: DoorExactDeps): Promise<void> {
  try {
    const seen = doorSeen(ctx) as Ctx, route = doorVaultRoute(seen), own = managedIdentity(d.env ?? process.env);
    const callId = callIdFrom(ctx), session = seen.session;
    const sessionId = session?.id, turnId = session?.turn?.id, sequence = session?.turn?.sequence;
    if (!route || !own || !callId || typeof sessionId !== 'string' || typeof turnId !== 'string' || !Number.isSafeInteger(sequence))
      throw new ApprovalRefusal(DOOR_NOTE_SAVE_NOT_POSSIBLE);
    if (!d.adapter.toolNames.includes(tool)) throw new ApprovalRefusal(DOOR_NOTE_SAVE_NOT_POSSIBLE);
    const db = database(d), pass = await d.pass(seen), { memberId } = pass;
    const target = exactTargetSchema.parse(await d.adapter.readTarget(db, ctx.toolInput, memberId, tool, { ...seen, doorPass: pass } as never));
    if (target.ownerMemberId !== memberId) throw new ApprovalRefusal(DOOR_NOTE_SAVE_NOT_POSSIBLE);
    const policyHash = await d.adapter.readPolicyHash(db, own.name, own.incarnation).catch(() => { throw new ApprovalRefusal(DOOR_NOTE_SAVE_NOT_POSSIBLE); });
    const placeId = placeOf(route.door, own.name, own.incarnation, sessionId);
    const original = turnAuthoritySchema.parse({ origin: 'human', agentId: own.name, turnId, sessionId, actingMemberId: memberId, spokenByMemberId: memberId,
      placeId, audience: { placeId, revision: 0, participants: [{ kind: 'member', memberId }] }, policyRevision: 0 });
    const reservation: DoorReservation = { version: 2, kind: 'door', original, incarnation: own.incarnation,
      door: { door: route.door, principal: route.principal, claimRevision: route.claimRevision }, target, policyHash,
      expiresAt: new Date(nowOf(d).getTime() + APPROVAL_TTL_MS).toISOString() };
    await db.query(`INSERT INTO approval_asks(call_id,agent,tool,payload_hash,original_authority,acting_member_id,session_id,turn_sequence)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [callId, own.name, tool, payloadFingerprint(tool, ctx.toolInput), JSON.stringify(reservation), memberId, sessionId, sequence]);
    const row = await rowForCall(db, callId), existing = reservationOf(row);
    // Expiry belongs to the FIRST reservation and is never extended by a retry.
    if (!row || !existing || row.outcome !== null || row.tool !== tool || row.payload_hash !== payloadFingerprint(tool, ctx.toolInput) ||
        !same({ ...existing, expiresAt: reservation.expiresAt }, reservation)) throw new ApprovalRefusal(DOOR_NOTE_SAVE_NOT_POSSIBLE);
  } catch (error) { throw refusalFor(error); }
}

/** {@link reserveDoorExactApproval} for an approval policy: a refusal becomes a denial with its sentence, which the
 *  model reads. Null: reserved. */
export async function reserveDoorExactApprovalOrDeny(ctx: Ctx, tool: string, d: DoorExactDeps): Promise<{ type: 'denied'; reason: string } | null> {
  try { await reserveDoorExactApproval(ctx, tool, d); return null; }
  catch (error) { return { type: 'denied', reason: error instanceof ApprovalRefusal ? error.message : DOOR_NOTE_SAVE_NOT_POSSIBLE }; }
}

/* ------------------------------------------------------------------------------------------- *
 * 2. Attach.
 * ------------------------------------------------------------------------------------------- */

/** Thrown when a card that has a door reservation cannot be attached to it (the card could never be approved). */
export class DoorAttachError extends Error {}

/** The first framework event that names a card gives its request id to the reservation made for the same call.
 *  Returns false when the call has no door reservation (a legacy card: the caller records it as before). */
export async function attachDoorExactApproval(a: { requestId: string; callId: string; tool: string; input: unknown }, db: AuthorityDatabase = getPool()): Promise<boolean> {
  const row = await rowForCall(db, a.callId);
  if (!reservationOf(row)) return false;
  if (row!.tool !== a.tool || row!.payload_hash !== payloadFingerprint(a.tool, a.input)) throw new DoorAttachError('door card changed');
  const { rows } = await db.query(`UPDATE approval_asks SET request_id=$2 WHERE call_id=$1 AND original_authority IS NOT NULL
    AND (request_id IS NULL OR request_id=$2) RETURNING request_id`, [a.callId, a.requestId]);
  if (rows.length !== 1) throw new DoorAttachError('door card taken');
  return true;
}

/* ------------------------------------------------------------------------------------------- *
 * 3. Answer.
 * ------------------------------------------------------------------------------------------- */

/** Whether this platform identity is the person who claimed the reservation's door, on the current claim, and the owner. */
function mayAnswer(principal: unknown, r: DoorReservation, d: DoorExactDeps): boolean {
  const who = principalFromAuth(principal), entry = who.authenticator !== undefined && Object.hasOwn(DOORS, who.authenticator) ? DOORS[who.authenticator] : undefined;
  if (!entry || entry.door !== r.door.door || who.userId === undefined || who.userId !== r.door.principal || !d.isOwner(who.authenticator, who.userId)) return false;
  const names = claimEnvNames(entry.door), env = d.env ?? process.env;
  return env[names.principal] === r.door.principal && env[names.revision] === r.door.claimRevision;
}

/** Row and reservation agree with each other and with the call; the reservation has not run out. */
function checkRow(row: Row | undefined, tool: string, input: unknown, d: DoorExactDeps): { row: Row; r: DoorReservation } | undefined {
  const r = reservationOf(row);
  if (!row || !r) return undefined;
  const o = r.original, own = managedIdentity(d.env ?? process.env);
  if (!own || o.origin !== 'human' || !o.actingMemberId || o.spokenByMemberId !== o.actingMemberId || row.acting_member_id !== o.actingMemberId ||
      row.agent !== o.agentId || o.agentId !== own.name || r.incarnation !== own.incarnation || row.tool !== tool || row.session_id !== o.sessionId ||
      o.placeId !== placeOf(r.door.door, o.agentId, r.incarnation, o.sessionId) || row.payload_hash !== payloadFingerprint(tool, input)) return undefined;
  return { row, r };
}

/** What eve's response policy hands over (`ApprovalResponseContext`), as far as this file reads it. */
export interface DoorResponseContext {
  request: { interactionId: string; callId: string; toolName: string; toolInput?: unknown };
  response: { decision: 'approve' | 'deny'; principal: unknown };
  session: { id: string; initiator: unknown; turn?: unknown };
}

/**
 * The answer to a door card. Only the claimed person, who must also be the owner, on the door the card was raised on,
 * on the claim it was raised under, may answer: for Deny as well as Approve, with the card staying pending for
 * anyone else. An Approve writes the answer (`approved`, the door, the member Keeper named); a Deny writes nothing
 * (the settle hook records it). Fails closed; nothing in a refusal reaches a person.
 */
export async function approveDoorExactResponse(ctx: DoorResponseContext, d: DoorExactDeps): Promise<{ status: 'allowed' } | { status: 'rejected'; reason: string }> {
  const refused = (reason: string) => ({ status: 'rejected' as const, reason });
  try {
    const decision = ctx.response?.decision;
    if (decision !== 'approve' && decision !== 'deny') return refused('this answer is neither Approve nor Deny');
    const db = database(d), checked = checkRow(await rowForCall(db, ctx.request.callId), ctx.request.toolName, ctx.request.toolInput, d);
    if (!checked) return refused('this card is not one this agent can take an answer on');
    const { row, r } = checked;
    if (!row.request_id || row.request_id !== ctx.request.interactionId) return refused('this answer does not name the card');
    if (Date.parse(r.expiresAt) <= nowOf(d).getTime()) return refused('this card has run out');
    if (!mayAnswer(ctx.response.principal, r, d)) return refused("only the person who claimed this chat, and the agent's owner, can answer this card");
    if (decision === 'deny') return row.outcome === null ? { status: 'allowed' } : refused('this card is already settled');
    if (row.outcome !== null && row.outcome !== 'approved') return refused('this card is already settled');
    const memberId = r.original.actingMemberId!;
    const result = await db.query(`UPDATE approval_asks SET outcome='approved',answered_at=COALESCE(answered_at,now()),
      answered_via=$4,resolved_by_member_id=$3 WHERE call_id=$1 AND request_id=$2 AND original_authority IS NOT NULL
      AND (outcome IS NULL OR (outcome='approved' AND resolved_by_member_id=$3)) RETURNING call_id`, [row.call_id, row.request_id, memberId, r.door.door]);
    return result.rows.length === 1 ? { status: 'allowed' } : refused('this card is already settled');
  } catch { return refused('this answer could not be verified'); }
}

/* ------------------------------------------------------------------------------------------- *
 * 4. Recheck and execute.
 * ------------------------------------------------------------------------------------------- */

/**
 * The checks a call must pass after its card was answered, at the re-check before it runs (`stage: 'recheck'`, no responder
 * is visible) and at execution (`stage: 'execute'`, the responder eve gives the running call must be the claimed owner).
 * Failures before the answer is proven are neutral (`DOOR_NOTE_TOOL_UNAVAILABLE`: nothing claims a card existed);
 * from then on each one is a sentence that starts "You approved".
 */
async function requireApproved(ctx: Ctx, tool: string, input: unknown, d: DoorExactDeps, stage: 'recheck' | 'execute'): Promise<DoorApprovedExecution> {
  const seen = doorSeen(ctx) as Ctx, route: DoorVaultRoute | undefined = doorVaultRoute(seen), db = database(d);
  const callId = callIdFrom(ctx), sessionId = seen.session?.id;
  if (!route || typeof sessionId !== 'string' || !callId || !d.adapter.toolNames.includes(tool)) return neutral();
  const checked = checkRow(await rowForCall(db, callId), tool, input, d);
  if (!checked) return neutral();
  const { row, r } = checked, memberId = r.original.actingMemberId!;
  if (row.session_id !== sessionId || r.door.door !== route.door || r.door.principal !== route.principal || r.door.claimRevision !== route.claimRevision ||
      !row.request_id || row.outcome !== 'approved' || row.resolved_by_member_id !== memberId || row.answered_via !== r.door.door) return neutral();
  if (stage === 'execute') {
    const responder = approvalResponderOf(ctx);
    if (responder !== undefined && !mayAnswer(responder, r, d)) return neutral();
  }
  // From here the person did approve this exact card: every refusal says so, and that nothing was saved.
  if (row.used_at != null || Date.parse(r.expiresAt) <= nowOf(d).getTime()) throw new DoorApprovalFailure(DOOR_NOTE_APPROVAL_EXPIRED);
  // The owner's rule D-6: a card that was cut, or whose record cannot say it was whole, is not an approval to act on.
  if (row.shown_whole === false) throw new DoorApprovalFailure(DOOR_NOTE_CARD_SHORTENED);
  if (row.shown_whole !== true) throw new DoorApprovalFailure(DOOR_NOTE_CARD_UNCONFIRMED);
  const own = managedIdentity(d.env ?? process.env)!;
  let policyNow: string;
  try { policyNow = await d.adapter.readPolicyHash(db, own.name, own.incarnation); } catch { throw new DoorApprovalFailure(DOOR_NOTE_SAVE_FAILED); }
  if (policyNow !== r.policyHash) throw new DoorApprovalFailure(DOOR_NOTE_SAVE_FAILED);
  return { authority: { ...r.original, origin: 'approval-resume', actingMemberId: memberId, resolvedByMemberId: memberId, requestId: row.request_id } as DoorApprovedExecution['authority'],
    target: r.target, callId: row.call_id, toolName: row.tool, payloadHash: row.payload_hash, door: r.door, sessionId };
}

/** The re-check eve makes of a call that was approved, before it runs. */
export async function requireDoorApprovedRecheck(ctx: Ctx, tool: string, input: unknown, d: DoorExactDeps): Promise<void> {
  await requireApproved(ctx, tool, input, d, 'recheck');
}

/** The approved call, at execution. Throws one closed sentence; returns what Keeper needs to write. */
export async function requireDoorApprovedExecution(ctx: Ctx, tool: string, input: unknown, d: DoorExactDeps): Promise<DoorApprovedExecution> {
  return requireApproved(ctx, tool, input, d, 'execute');
}
