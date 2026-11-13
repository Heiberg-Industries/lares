/**
 * WHO MAY SPEND ON A MODEL CALL THAT CAME THROUGH A DOOR. Door-neutral: one table below is the
 * only part that knows a door by name, and a door file adds nothing here.
 *
 * On a managed runtime (one Keeper serves, `LARES_MODEL_PURPOSE_RUNTIME_SOCKET` set) a model call
 * needs Keeper's permission; there is no key file to fall back to (`gateway-provider.ts`). Web
 * chat asks through its own adapter. This module covers the two other ways a conversation starts:
 *
 *  - a DOOR turn: the person speaking is the one who claimed this agent's Slack or Telegram door,
 *    as eve itself verified the platform event. The agent asks Keeper `door.open` once per turn
 *    and then uses the ordinary per-step path (`step.claim`, `step.consume`). Keeper finds the
 *    payer from the claim; nothing here names a member, an email or a payer;
 *  - a SCHEDULE-started conversation (eve's app identity): it runs as an owner job
 *    (`owner-job.ts`), which Keeper refuses once the agent is shared with another member.
 *
 * Anything that looks like a door but fails a check is refused with {@link DOOR_MODEL_REFUSED}
 * (the sentence a person sees is in `approval-reply-sentence.ts`), never passed on. Anything else
 * (web chat, an unknown sign-in) is left alone here; on a managed runtime the provider refuses it
 * unless web chat's own adapter attached a permission.
 *
 * It never reads a key file and never logs a principal, a session id or a capability.
 */
import { isScheduleAuth } from 'eve/schedules';
import { DOOR_MODEL_REFUSED } from './approval-reply-sentence.js';
import { managedIdentity } from './door-authority.js';
import { requestAndAttachModelPurposeClaim, type ModelInvocation } from './model-invocation.js';
import { modelPurposeRequest } from './model-purpose-client.js';

export { DOOR_MODEL_REFUSED };
export type ModelAuthorityRoute = 'door' | 'owner-job' | 'none';

type Auth = { authenticator?: unknown; principalType?: unknown; attributes?: Record<string, unknown> | null };
type Session = { id?: unknown; auth?: { current?: unknown; initiator?: unknown } | null } | null | undefined;

/**
 * The verified sender (ADR-0025 rule 5, item 1) for the doors eve ships, read from eve's own
 * identity: eve sets it only after it checked the platform's signature or secret. Keyed by eve's
 * authenticator. When the layer's adapter exists this becomes its function 1. A new door adds
 * one row here and nothing in its door file. The value compared is the platform's own user id,
 * exactly as the door claim stored it (`door-channels.ts`), never eve's `principalId`.
 */
const DOORS: Readonly<Record<string, { readonly door: 'slack' | 'telegram'; readonly sender: (a: Auth) => unknown }>> = Object.freeze({
  'slack-webhook': { door: 'slack', sender: a => a.principalType === 'user' && a.attributes?.author_type === 'user' ? a.attributes.user_id : undefined },
  'telegram-webhook': { door: 'telegram', sender: a => a.principalType === 'user' && a.attributes?.chat_type === 'private' ? a.attributes.user_id : undefined },
});

const PRINCIPAL = /^[A-Za-z0-9_-]{1,128}$/;
const REVISION = /^[a-f0-9-]{36}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TURN_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
/** Keeper's `TURN_MS`: an answer may never reach further ahead than this. */
const TURN_MS = 5 * 60_000;
const MAX_ENTRIES = 512;
const MAX_CLOSED_POINTS = 65_536;

const refused = () => new Error(DOOR_MODEL_REFUSED);
const managed = () => Boolean(process.env.LARES_MODEL_PURPOSE_RUNTIME_SOCKET);

function doorOf(auth: unknown): (typeof DOORS)[string] | undefined {
  const authenticator = (auth as Auth | null | undefined)?.authenticator;
  return typeof authenticator === 'string' && Object.hasOwn(DOORS, authenticator) ? DOORS[authenticator] : undefined;
}

/** This runtime's applied claim for a door, or nothing when it is incomplete. */
function claimFor(door: 'slack' | 'telegram'): { principal: string; revision: string } | undefined {
  const kind = door.toUpperCase();
  const principal = process.env[`LARES_${kind}_PRINCIPAL`], revision = process.env[`LARES_${kind}_CLAIM_REVISION`];
  return principal && PRINCIPAL.test(principal) && revision && REVISION.test(revision) ? { principal, revision } : undefined;
}

/** The claimed person speaking through a door, or a refusal. */
function claimedSender(auth: unknown): { door: 'slack' | 'telegram'; principal: string; revision: string } {
  const entry = doorOf(auth);
  if (!entry) throw refused();
  const sender = entry.sender(auth as Auth);
  const claim = claimFor(entry.door);
  let identity: ReturnType<typeof managedIdentity>;
  try { identity = managedIdentity(process.env); } catch { throw refused(); }
  if (typeof sender !== 'string' || sender === '' || !claim || sender !== claim.principal || !identity) throw refused();
  return { door: entry.door, ...claim };
}

/**
 * Which authority this session's model calls need. Synchronous; asks nobody.
 *
 * - not a managed runtime: `none` (overlay installs and test harnesses keep today's path);
 * - the claimed person through a door, in a conversation that person or a schedule started: `door`;
 * - a schedule speaking, in a conversation a schedule or the claimed person started: `owner-job`;
 * - a door or schedule identity that fails any of that: throws {@link DOOR_MODEL_REFUSED};
 * - anything else (web chat, unknown): `none`.
 */
export function modelAuthorityRoute(session: unknown): ModelAuthorityRoute {
  if (!managed()) return 'none';
  const auth = (session as Session)?.auth;
  const current = auth?.current, initiator = auth?.initiator;
  if (doorOf(current)) {
    const speaker = claimedSender(current);
    if (isScheduleAuth(initiator as never)) return 'door';
    const first = claimedSender(initiator);
    if (first.door !== speaker.door || first.principal !== speaker.principal) throw refused();
    return 'door';
  }
  if (isScheduleAuth(current as never)) {
    if (isScheduleAuth(initiator as never)) return 'owner-job';
    claimedSender(initiator);
    return 'owner-job';
  }
  return 'none';
}

// ── One Keeper turn per door turn, held only in this process ─────────────────────────────

type Point = Readonly<{ sessionId: string; turnId: string; sequence: number; incarnation: string }>;
type Entry = { id: string; point: Point; active: boolean; expiresAt: number; capability?: string; openRequest?: Promise<string> };
const entries = new Map<string, Entry>();
const closedPoints = new Set<string>();
const key = (p: Point) => `${p.sessionId}\0${p.turnId}\0${p.sequence}\0${p.incarnation}`;

function sequenceFrom(data: { turnId?: unknown; sequence?: unknown } | undefined): number | undefined {
  const parsed = typeof data?.turnId === 'string' ? /^turn_(0|[1-9]\d{0,14})$/.exec(data.turnId) : null;
  if (data?.sequence === undefined) return parsed ? Number(parsed[1]) : undefined;
  return Number.isSafeInteger(data.sequence) && Number(data.sequence) >= 0 ? Number(data.sequence) : undefined;
}

/** The exact point a door turn sits at. The sequence must be the number in the turn id. */
function pointFrom(event: unknown, session: unknown): Point {
  const data = (event as { data?: { turnId?: unknown; sequence?: unknown } } | undefined)?.data;
  const sessionId = (session as Session)?.id, turnId = data?.turnId, sequence = sequenceFrom(data);
  let identity: ReturnType<typeof managedIdentity>;
  try { identity = managedIdentity(process.env); } catch { throw refused(); }
  if (!identity || typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || typeof turnId !== 'string' ||
      !TURN_ID.test(turnId) || sequence === undefined || turnId !== `turn_${sequence}`) throw refused();
  return Object.freeze({ sessionId, turnId, sequence, incarnation: identity.incarnation });
}

function tombstone(id: string): void {
  if (closedPoints.size < MAX_CLOSED_POINTS) closedPoints.add(id);
}

function closeRemote(point: Point, capability: string | undefined): Promise<void> {
  if (!capability) return Promise.resolve();
  return modelPurposeRequest('turn.close', { turnCapability: capability, turnId: point.turnId, sequence: point.sequence })
    .then(() => undefined, () => undefined);
}

/** Drops an entry. A settled turn leaves a tombstone; a paused one does not, so its continuation
 * after an answered card opens again. Returns the capability to close. */
function drop(entry: Entry, leaveTombstone: boolean): string | undefined {
  entry.active = false;
  if (entries.get(entry.id) === entry) entries.delete(entry.id);
  if (leaveTombstone) tombstone(entry.id);
  return entry.capability;
}

function prune(now = Date.now()): void {
  for (const entry of [...entries.values()]) if (entry.expiresAt <= now) void closeRemote(entry.point, drop(entry, true));
}

function active(entry: Entry): boolean {
  return entries.get(entry.id) === entry && entry.active && entry.expiresAt > Date.now();
}

/**
 * Reserve a door turn's point before the resolver awaits anything, so a `turn.settled` that
 * arrives while `door.open` is still in flight finds it and burns it. No Keeper call. A refused
 * route throws here; web chat, owner jobs and unmanaged runtimes reserve nothing.
 */
export function prepareDoorModelInvocation(event: unknown, session: unknown): void {
  if (modelAuthorityRoute(session) !== 'door') return;
  const point = pointFrom(event, session);
  const id = key(point);
  prune();
  if (closedPoints.has(id) || closedPoints.size >= MAX_CLOSED_POINTS) throw refused();
  if (entries.get(id)?.active) return;
  // A new turn in a session displaces whatever an earlier turn of it left open in this process.
  for (const entry of [...entries.values()]) {
    if (entry.point.sessionId === point.sessionId && entry.point.incarnation === point.incarnation)
      void closeRemote(entry.point, drop(entry, true));
  }
  if (entries.size >= MAX_ENTRIES) throw refused();
  entries.set(id, { id, point, active: true, expiresAt: Date.now() + TURN_MS });
}

function validAnswer(result: Record<string, unknown>): { capability: string; expiresAt: number } {
  const keys = Object.keys(result).sort();
  const { capability, expiresAt } = result;
  const now = Date.now();
  if (keys.length !== 2 || keys[0] !== 'capability' || keys[1] !== 'expiresAt' ||
      typeof capability !== 'string' || !CAPABILITY.test(capability) ||
      typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + TURN_MS) throw refused();
  return { capability, expiresAt };
}

/** One `door.open` per open point; concurrent and later calls of the turn share it. */
function openDoor(entry: Entry, door: { door: string; principal: string; revision: string }): Promise<string> {
  if (entry.capability) return Promise.resolve(entry.capability);
  entry.openRequest ??= (async () => {
    const { point } = entry;
    try {
      const answer = validAnswer(await modelPurposeRequest<Record<string, unknown>>('door.open', {
        door: door.door, principal: door.principal, claimRevision: door.revision,
        sessionId: point.sessionId, turnId: point.turnId, sequence: point.sequence,
      }));
      if (!active(entry)) {
        // The turn ended while Keeper answered: the late capability is closed, never used.
        await closeRemote(point, answer.capability);
        throw refused();
      }
      entry.capability = answer.capability;
      entry.expiresAt = Math.min(entry.expiresAt, answer.expiresAt);
      return answer.capability;
    } catch (error) {
      if (entries.get(entry.id) === entry) drop(entry, true);
      throw error;
    }
  })();
  return entry.openRequest;
}

/**
 * The resolver's authority step, after the session is verified and the invocation captured.
 * `door`: opens (or reuses) this turn's Keeper capability and claims this exact step with it.
 * `owner-job` and `none`: returns the route; nothing is asked here. Every refusal on the door
 * path, whatever Keeper or the transport said, becomes {@link DOOR_MODEL_REFUSED}.
 */
export async function claimDoorModelAuthority(invocation: ModelInvocation): Promise<ModelAuthorityRoute> {
  const route = modelAuthorityRoute(invocation.session);
  if (route !== 'door') return route;
  try {
    const door = claimedSender(invocation.session.auth?.current);
    const point = pointFrom(invocation.event, invocation.session);
    const entry = entries.get(key(point));
    if (!entry || !active(entry)) throw refused();
    const capability = await openDoor(entry, door);
    if (!active(entry)) throw refused();
    await requestAndAttachModelPurposeClaim(invocation, capability, () => active(entry));
    return 'door';
  } catch {
    throw refused();
  }
}

/**
 * The turn hook's half: on `turn.paused` the capability is closed and the point forgotten, so the
 * continuation after an answered card opens afresh; on `turn.settled` it is closed and the point
 * tombstoned. The sequence comes from the event. Never throws.
 */
export async function closeDoorModelTurn(event: unknown, session: unknown): Promise<void> {
  try {
    const type = (event as { type?: unknown } | undefined)?.type;
    const point = pointFrom(event, session);
    const entry = entries.get(key(point));
    if (!entry) return;
    await closeRemote(point, drop(entry, type !== 'turn.paused'));
  } catch {
    /* nothing open for this turn, or nothing readable: there is nothing to close */
  }
}

/** What `definitionModel({ managedAuthority })` takes. */
export const doorModelAuthority = Object.freeze({
  prepare: prepareDoorModelInvocation,
  claim: claimDoorModelAuthority,
});
