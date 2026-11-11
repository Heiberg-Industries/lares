import { modelPurposeRequest } from '@lares/agent-kit/model-purpose-client';
import { requestAndAttachModelPurposeClaim, type ModelInvocation } from '@lares/agent-kit/model-invocation';
import { consoleAdmission, type ConsoleAuthorityContext } from '@lares/agent-kit/console-turn-authority';
import { managedIdentity } from '@lares/agent-kit/door-authority';
import { exactResolverAdmission, privateResumeAdmission } from '@lares/agent-kit/private-console-resume';

type Point = Readonly<{ sessionId: string; turnId: string; sequence: number; incarnation: string }>;
type ResumeBinding = Readonly<{
  resolverMemberId: string;
  requestId: string;
  optionId: 'approve' | 'deny';
  initiatorMemberId: string;
  admissionNonce: string;
  receipt: string;
}>;
type Entry = { active: boolean; expiresAt: number; capability?: string; openRequest?: Promise<void>; resume?: ResumeBinding };
type Session = NonNullable<ConsoleAuthorityContext['session']>;
const entries = new Map<string, Entry>();
const MAX_ENTRIES = 512;
const MAX_CLOSED_POINTS = 65_536;
const closedPoints = new Set<string>();
const ACTIVE_MS = 5 * 60_000;
const deny = () => new Error('Model purpose authority is not available');
const key = (point: Point) => `${point.sessionId}\0${point.turnId}\0${point.sequence}\0${point.incarnation}`;

function prune(now = Date.now()): void {
  for (const [id, entry] of entries) if (entry.expiresAt <= now || !entry.active) {
    entries.delete(id);
    if (closedPoints.size < MAX_CLOSED_POINTS) closedPoints.add(id);
  }
}

function begin(point: Point): Entry {
  prune();
  const id = key(point);
  if (closedPoints.has(id) || entries.has(id) || closedPoints.size >= MAX_CLOSED_POINTS) throw deny();
  const displaced = [...entries].filter(([existing]) => existing.startsWith(`${point.sessionId}\0`) && existing.endsWith(`\0${point.incarnation}`));
  if (closedPoints.size + displaced.length >= MAX_CLOSED_POINTS) throw deny();
  for (const [existing, entry] of displaced) {
    if (existing.startsWith(`${point.sessionId}\0`) && existing.endsWith(`\0${point.incarnation}`)) {
      entry.active = false;
      entries.delete(existing);
      closedPoints.add(existing);
    }
  }
  if (entries.size >= MAX_ENTRIES) throw deny();
  const entry = { active: true, expiresAt: Date.now() + ACTIVE_MS };
  entries.set(id, entry);
  return entry;
}

function active(point: Point): boolean {
  prune();
  const entry = entries.get(key(point));
  return !!entry?.active && entry.expiresAt > Date.now();
}

function rememberCapability(point: Point, expected: Entry, capability: string, expiresAt: number): boolean {
  const entry = entries.get(key(point));
  if (entry !== expected || !entry.active || entry.expiresAt <= Date.now() || expiresAt <= Date.now()) return false;
  entry.capability = capability;
  entry.expiresAt = Math.min(entry.expiresAt, expiresAt);
  return true;
}

function closePoint(point: Point): string | undefined {
  const id = key(point), entry = entries.get(id);
  // Hooks run for every ordinary CoS turn too. Retain tombstones only for turns this adapter
  // actually opened, so optional custody does not consume the bounded replay guard.
  if (!entry) return undefined;
  if (closedPoints.size < MAX_CLOSED_POINTS) closedPoints.add(id);
  entries.delete(id);
  return entry?.capability;
}

function attrs(auth: unknown): Record<string, unknown> | undefined {
  return (auth as { attributes?: Record<string, unknown> } | undefined)?.attributes;
}

function pendingFrom(auth: unknown): { required: boolean; receipt?: string } {
  const attributes = attrs(auth);
  const required = attributes?.lares_model_purpose_required === '1';
  const value = attributes?.lares_model_pending_receipt;
  if (value === undefined) return { required };
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw deny();
  return { required, receipt: value };
}

/** A turn's zero-based position in its session.
 *
 * eve 1.0's `turn.started` and `turn.settled` events carry `turnId` and no `sequence` (0.60.1
 * carried both). eve mints turn ids as `turn_<sequence>` and reports that same number to hooks
 * and tools as `ctx.session.turn.sequence` (`dist/src/protocol/session-projection.js`,
 * `turnCoordinates`), so the id itself is the framework's own record of the position. An event
 * that does carry a `sequence` (the model resolver's coordinates, an older event) is used as
 * given. Anything else is refused, never guessed at. */
function sequenceFrom(data: { turnId?: unknown; sequence?: unknown } | undefined): number | undefined {
  if (data?.sequence !== undefined) return Number.isSafeInteger(data.sequence) && Number(data.sequence) >= 0 ? Number(data.sequence) : undefined;
  const parsed = typeof data?.turnId === 'string' ? /^turn_(0|[1-9]\d{0,14})$/.exec(data.turnId) : null;
  return parsed ? Number(parsed[1]) : undefined;
}

function pointFrom(event: unknown, session: Session | undefined, incarnation: string, allowEmpty: boolean): Point {
  const data = (event as { data?: { turnId?: unknown; sequence?: unknown } } | undefined)?.data;
  const sessionId = session?.id, turnId = data?.turnId, sequence = sequenceFrom(data);
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(sessionId) ||
      typeof turnId !== 'string' || (!allowEmpty && turnId.length === 0) ||
      (turnId !== '' && !/^[A-Za-z0-9._:-]{1,128}$/.test(turnId)) ||
      sequence === undefined) throw deny();
  // The session context a hook passes carries the framework's own turn (`ctx.session.turn`);
  // the model resolver's session snapshot carries none (a dynamic `model` is given only the
  // session id and both authentications). Where the turn is present it has to agree.
  const sessionTurn = session?.turn;
  // For a marked approval resume the model resolver's coordinates are the source of the turn
  // tuple; if a richer context is present, its sequence still has to agree.
  if (allowEmpty) {
    if (sessionTurn && sessionTurn.sequence !== sequence) throw deny();
  } else if (!sessionTurn || sessionTurn.sequence !== sequence || sessionTurn.id !== turnId) throw deny();
  return { sessionId, turnId, sequence, incarnation };
}

function resumeBinding(session: Session | undefined, receipt: string): ResumeBinding {
  const resolver = privateResumeAdmission(session?.auth?.current);
  const initial = consoleAdmission(session?.auth?.initiator);
  if (!resolver || !initial || initial.purpose !== 'human' || resolver.memberId !== initial.memberId) throw deny();
  const exact = exactResolverAdmission(session?.auth?.current);
  if (exact && exact.admissionNonce !== initial.admissionNonce) throw deny();
  return Object.freeze({ resolverMemberId: resolver.memberId, requestId: resolver.requestId, optionId: resolver.optionId,
    initiatorMemberId: initial.memberId, admissionNonce: initial.admissionNonce, receipt });
}

function sameResumeBinding(left: ResumeBinding | undefined, right: ResumeBinding): boolean {
  return !!left && left.resolverMemberId === right.resolverMemberId && left.requestId === right.requestId &&
    left.optionId === right.optionId && left.initiatorMemberId === right.initiatorMemberId &&
    left.admissionNonce === right.admissionNonce && left.receipt === right.receipt;
}

/** Reserve an exact model call before authority verification awaits. `event` is the coordinate
 * record the model resolver builds from eve's session view (`modelStepCoordinates` in
 * @lares/agent-kit/definition-model); it keeps the `step.started` name Keeper authenticates,
 * though eve 1.0 has no event by that name. This creates no
 * Keeper authority; it only lets a terminal hook tombstone the real resume coordinates while
 * the verifier is in flight. Ordinary and human turns do not create these reservations. */
export function prepareModelPurposeInvocation(event: unknown, session: Session | undefined): void {
  if ((event as { type?: unknown } | undefined)?.type !== 'step.started') throw deny();
  const current = session?.auth?.current;
  const pending = pendingFrom(current);
  if (!pending.required && !pending.receipt) return;
  if (!pending.receipt) throw deny();
  if (!privateResumeAdmission(current)) return; // Human turns are opened by the turn.started hook.
  const binding = resumeBinding(session, pending.receipt);
  const own = managedIdentity(process.env);
  if (!own) throw deny();
  const point = pointFrom(event, session, own.incarnation, true);
  prune();
  const id = key(point), existing = entries.get(id);
  if (closedPoints.has(id) || closedPoints.size >= MAX_CLOSED_POINTS) throw deny();
  if (existing) {
    if (!existing.active || existing.expiresAt <= Date.now() || !sameResumeBinding(existing.resume, binding)) throw deny();
    return;
  }
  const entry = begin(point);
  entry.resume = binding;
}

async function openEntry(point: Point, entry: Entry, pendingReceipt: string, session: Session): Promise<void> {
  if (entry.openRequest) return entry.openRequest;
  const request = (async () => {
    try {
      const result = await modelPurposeRequest<{ capability?: unknown; expiresAt?: unknown }>('turn.open', {
        pendingReceipt,
        context: { session: {
          id: session.id,
          turn: { id: point.turnId, sequence: point.sequence },
          auth: { current: session.auth?.current, initiator: session.auth?.initiator },
        } },
      });
      if (typeof result.capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.capability) ||
          typeof result.expiresAt !== 'number' || !Number.isSafeInteger(result.expiresAt)) throw deny();
      if (!rememberCapability(point, entry, result.capability, result.expiresAt)) {
        await modelPurposeRequest('turn.close', { turnCapability: result.capability, turnId: point.turnId, sequence: point.sequence }).catch(() => {});
        throw deny();
      }
    } catch (error) {
      closePoint(point);
      throw error;
    }
  })();
  entry.openRequest = request;
  return request;
}

/** Opens only a Console-tagged human or authenticated approval-resume turn. The event hook
 * marks it active before awaiting Keeper, so a terminal event can win and burn a late ACK. */
export async function openModelPurposeTurn(event: unknown, session: Session | undefined): Promise<void> {
  const current = session?.auth?.current;
  const human = consoleAdmission(current)?.purpose === 'human';
  const purpose = human ? 'human' : undefined;
  const pending = pendingFrom(current);
  if (!pending.required && !pending.receipt) return;
  // Approval continuations are opened lazily by the model resolver: an answered approval
  // continues its turn, so no turn.started is emitted for it.
  if (!purpose) return;
  if (!pending.receipt) throw deny();
  const own = managedIdentity(process.env);
  if (!own) throw deny();
  const point = pointFrom(event, session, own.incarnation, false);
  const entry = begin(point);
  await openEntry(point, entry, pending.receipt, session!);
}

/** Burns local turn state synchronously, then best-effort closes the remote capability. */
export async function closeModelPurposeTurn(event: unknown, session: Session | undefined): Promise<void> {
  const own = managedIdentity(process.env), data = (event as { data?: { turnId?: unknown; sequence?: unknown } } | undefined)?.data;
  // The position comes from the event alone: when a turn has just settled, the hook's own
  // `ctx.session.turn` may already describe the next turn.
  const sequence = sequenceFrom(data);
  if (!own || typeof session?.id !== 'string' || typeof data?.turnId !== 'string' || sequence === undefined) return;
  const point: Point = { sessionId: session.id, turnId: data.turnId, sequence, incarnation: own.incarnation };
  const capability = closePoint(point);
  if (capability) await modelPurposeRequest('turn.close', { turnCapability: capability, turnId: point.turnId, sequence: point.sequence }).catch(() => {});
}

/** The chief-of-staff-only resolver seam. Other roles do not call this adapter. */
export async function claimModelPurposeForInvocation(invocation: ModelInvocation): Promise<void> {
  const current = invocation.session.auth?.current;
  const pending = pendingFrom(current);
  if (!pending.required && !pending.receipt) return;
  if (!pending.receipt) throw deny();
  const own = managedIdentity(process.env);
  if (!own) throw deny();
  const point: Point = {
    sessionId: invocation.session.id!,
    turnId: invocation.event.data.turnId,
    sequence: invocation.event.data.sequence,
    incarnation: own.incarnation,
  };
  const id = key(point), entry = entries.get(id);
  if (!entry?.active || entry.expiresAt <= Date.now()) throw deny();
  const resolver = privateResumeAdmission(current);
  if (resolver) {
    const binding = resumeBinding(invocation.session, pending.receipt);
    if (!sameResumeBinding(entry.resume, binding)) throw deny();
    await openEntry(point, entry, pending.receipt, invocation.session);
  }
  if (!entry.active || !entry.capability || entry.expiresAt <= Date.now()) throw deny();
  await requestAndAttachModelPurposeClaim(invocation, entry.capability, () => active(point));
}
