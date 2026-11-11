import { modelPurposeRequest } from '@lares/agent-kit/model-purpose-client';
import { requestAndAttachModelPurposeClaim, type ModelInvocation } from '@lares/agent-kit/model-invocation';
import { consoleAdmission, type ConsoleAuthorityContext } from '@lares/agent-kit/console-turn-authority';
import { managedIdentity } from '@lares/agent-kit/door-authority';
import { privateResumeAdmission, takeAcceptedAnswers } from '@lares/agent-kit/private-console-resume';

type Point = Readonly<{ sessionId: string; turnId: string; sequence: number; incarnation: string }>;
/** The answer a continuation opens from: taken from the response policy's record, never from the
 * turn's identity (`@lares/agent-kit/private-console-resume`, `takeAcceptedAnswers`). */
type ResumeBinding = Readonly<{
  requestId: string;
  optionId: 'approve' | 'deny';
  memberId: string;
  admissionNonce: string;
  receipt: string;
}>;
type Entry = { id: string; active: boolean; expiresAt: number; capability?: string; openRequest?: Promise<void>; resume?: ResumeBinding };
type Session = NonNullable<ConsoleAuthorityContext['session']>;
const entries = new Map<string, Entry>();
const MAX_ENTRIES = 512;
const MAX_CLOSED_POINTS = 65_536;
const closedPoints = new Set<string>();
const ACTIVE_MS = 5 * 60_000;
const deny = () => new Error('Model purpose authority is not available');
const key = (point: Point) => `${point.sessionId}\0${point.turnId}\0${point.sequence}\0${point.incarnation}`;
/** A continuation's own slot. It names the card it answers, so it never shares the paused point's
 * tombstone (the original message's receipt cannot reopen the point) and a card can resume once.
 * It ends in the incarnation like every key, so a new turn displaces it. */
const resumeKey = (point: Point, requestId: string) =>
  `${point.sessionId}\0${point.turnId}\0${point.sequence}\0resume:${requestId}\0${point.incarnation}`;
const pointPrefix = (point: Point) => `${point.sessionId}\0${point.turnId}\0${point.sequence}\0`;

function prune(now = Date.now()): void {
  for (const [id, entry] of entries) if (entry.expiresAt <= now || !entry.active) {
    entries.delete(id);
    if (closedPoints.size < MAX_CLOSED_POINTS) closedPoints.add(id);
  }
}

function begin(point: Point, id = key(point)): Entry {
  prune();
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
  const entry: Entry = { id, active: true, expiresAt: Date.now() + ACTIVE_MS };
  entries.set(id, entry);
  return entry;
}

function active(entry: Entry): boolean {
  prune();
  return entries.get(entry.id) === entry && entry.active && entry.expiresAt > Date.now();
}

function rememberCapability(expected: Entry, capability: string, expiresAt: number): boolean {
  const entry = entries.get(expected.id);
  if (entry !== expected || !entry.active || entry.expiresAt <= Date.now() || expiresAt <= Date.now()) return false;
  entry.capability = capability;
  entry.expiresAt = Math.min(entry.expiresAt, expiresAt);
  return true;
}

function closeEntry(id: string): string | undefined {
  const entry = entries.get(id);
  if (!entry) return undefined;
  entry.active = false;
  if (closedPoints.size < MAX_CLOSED_POINTS) closedPoints.add(id);
  entries.delete(id);
  return entry.capability;
}

/** Closes the point and every continuation slot opened under it. */
function closePoint(point: Point): string[] {
  // Hooks run for every ordinary CoS turn too. Retain tombstones only for turns this adapter
  // actually opened, so optional custody does not consume the bounded replay guard.
  const prefix = pointPrefix(point), suffix = `\0${point.incarnation}`;
  const ids = [...entries.keys()].filter(id => id === key(point) || (id.startsWith(prefix) && id.endsWith(suffix)));
  return ids.map(closeEntry).filter((c): c is string => typeof c === 'string');
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

function pointFrom(event: unknown, session: Session | undefined, incarnation: string, sessionTurnRequired: boolean): Point {
  const data = (event as { data?: { turnId?: unknown; sequence?: unknown } } | undefined)?.data;
  const sessionId = session?.id, turnId = data?.turnId, sequence = sequenceFrom(data);
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(sessionId) ||
      typeof turnId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(turnId) || sequence === undefined) throw deny();
  // The session context a hook passes carries the framework's own turn (`ctx.session.turn`);
  // the model resolver's session snapshot carries none (a dynamic `model` is given only the
  // session id and both authentications). Where the turn is present it has to agree.
  const sessionTurn = session?.turn;
  if (sessionTurnRequired ? (!sessionTurn || sessionTurn.sequence !== sequence || sessionTurn.id !== turnId)
    : (sessionTurn && (sessionTurn.sequence !== sequence || (sessionTurn.id !== undefined && sessionTurn.id !== turnId)))) throw deny();
  return { sessionId, turnId, sequence, incarnation };
}

/** The member who asked: a human admission on `current` that is also the pinned initiator. */
function requester(session: Session | undefined): { memberId: string; admissionNonce: string } {
  const current = consoleAdmission(session?.auth?.current), initial = consoleAdmission(session?.auth?.initiator);
  if (privateResumeAdmission(session?.auth?.current) || !current || current.purpose !== 'human' || !initial ||
      initial.purpose !== 'human' || initial.memberId !== current.memberId || initial.admissionNonce !== current.admissionNonce) throw deny();
  return { memberId: current.memberId, admissionNonce: current.admissionNonce };
}

/** The continuation slot already opened for this point, if any. */
function resumeEntryAt(point: Point): Entry | undefined {
  const prefix = `${pointPrefix(point)}resume:`, suffix = `\0${point.incarnation}`;
  for (const [id, entry] of entries) if (id.startsWith(prefix) && id.endsWith(suffix)) return entry;
  return undefined;
}

/** Opens the continuation slot for a paused point from the answers the response policy accepted
 * for it. Every answer settled in that step must be for the member who asked, under the same
 * admission, and carry a Keeper resume receipt (D5); otherwise nothing opens. All of them are used
 * up either way. The first card (by request id) opens the Keeper turn. */
function beginResume(point: Point, session: Session | undefined): Entry | undefined {
  const asker = requester(session);
  const answers = takeAcceptedAnswers(point);
  if (answers.length === 0) return undefined;
  if (answers.some(a => a.memberId !== asker.memberId || a.admissionNonce !== asker.admissionNonce || !a.receipt)) throw deny();
  const first = answers[0]!;
  const id = resumeKey(point, first.requestId);
  if (closedPoints.has(id)) throw deny();
  const entry = begin(point, id);
  entry.resume = Object.freeze({ requestId: first.requestId, optionId: first.optionId, memberId: first.memberId,
    admissionNonce: first.admissionNonce, receipt: first.receipt! });
  return entry;
}

/** Reserve an exact model call before authority verification awaits. `event` is the coordinate
 * record the model resolver builds from eve's session view (`modelStepCoordinates` in
 * @lares/agent-kit/definition-model); it keeps the `step.started` name Keeper authenticates,
 * though eve 1.0 has no event by that name. This creates no Keeper authority. A human turn's
 * first call is opened by the turn.started hook; this reserves only the continuation of a paused
 * turn after an answered card, so a terminal hook can tombstone it while the verifier is in flight. */
export function prepareModelPurposeInvocation(event: unknown, session: Session | undefined): void {
  if ((event as { type?: unknown } | undefined)?.type !== 'step.started') throw deny();
  const pending = pendingFrom(session?.auth?.current);
  if (!pending.required && !pending.receipt) return;
  if (!pending.receipt) throw deny();
  requester(session);
  const own = managedIdentity(process.env);
  if (!own) throw deny();
  const point = pointFrom(event, session, own.incarnation, false);
  prune();
  if (entries.get(key(point))?.active) return; // The human turn is still open.
  if (resumeEntryAt(point)) return;
  beginResume(point, session);
}

async function openEntry(point: Point, entry: Entry, pendingReceipt: string, session: Session): Promise<void> {
  // The context Keeper sees is the requester's own turn: `current` stays the person who asked.
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
      if (!rememberCapability(entry, result.capability, result.expiresAt)) {
        await modelPurposeRequest('turn.close', { turnCapability: result.capability, turnId: point.turnId, sequence: point.sequence }).catch(() => {});
        throw deny();
      }
    } catch (error) {
      closeEntry(entry.id);
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
  const point = pointFrom(event, session, own.incarnation, true);
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
  for (const capability of closePoint(point))
    await modelPurposeRequest('turn.close', { turnCapability: capability, turnId: point.turnId, sequence: point.sequence }).catch(() => {});
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
  const human = entries.get(key(point));
  const entry = human?.active ? human : resumeEntryAt(point);
  if (!entry?.active || entry.expiresAt <= Date.now()) throw deny();
  if (entry.resume) {
    const asker = requester(invocation.session);
    if (asker.memberId !== entry.resume.memberId || asker.admissionNonce !== entry.resume.admissionNonce) throw deny();
    await openEntry(point, entry, entry.resume.receipt, invocation.session);
  }
  if (!entry.active || !entry.capability || entry.expiresAt <= Date.now()) throw deny();
  await requestAndAttachModelPurposeClaim(invocation, entry.capability, () => active(entry));
}
