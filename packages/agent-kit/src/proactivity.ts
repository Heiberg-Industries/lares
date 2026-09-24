/**
 * ORB-193 — the one gate every proactive message passes, and the per-door ledger behind it.
 *
 * Three facts already paid for, and each was decided per-feature until now:
 *
 *   - **Tyche was paused for spam.** The diagnosis is precise: not proactive messaging, but
 *     proactive messaging *on model-judged importance*. A model may rank; it may never ring the
 *     phone.
 *   - **Marcel posted roughly fourteen times before one trip** — from a seven-day window, until
 *     ORB-125 cut it to two slots ("lets not do evening and morning posts before the trip, to
 *     chatty"). A window has no ceiling; a named slot list is one.
 *   - **The briefs earn their keep**, because they are named slots that stay silent when there is
 *     nothing to say. Silence is correct output.
 *
 * So: quiet hours per door on the OWNER's clock, do-not-disturb, already-seen, and two daily
 * ceilings (per door, per owner) with roll-over — enforced here, once, whatever a persona, skill
 * or prompt says. Settings (`proactivity_settings`) hold what an owner may turn; the engine
 * defaults below are the ceiling of the ceiling and can only be LOWERED, never raised.
 *
 * Two rules that look like details and are not:
 *
 * 1. **The `sent` row is written only after a confirmed send** — hence `gateInitiation` returning a
 *    `confirm()` rather than recording up front. Recording before a send that then fails drops the
 *    item permanently, which is worse than a rare duplicate. Suppressions and deferrals ARE
 *    recorded at decision time: they are the audit trail the console shows.
 *
 *    **The ledger grows per HELD ITEM, not per tick.** Most gating surfaces are pollers — Marcel
 *    ticks every minute, Saga keeps a reminder eligible right through a do-not-disturb spell — so a
 *    row per call would be up to ~1,440 rows a day for ONE item, drowning the console's held-back
 *    view and the table alike. Two reuses prevent it, and both re-decide first, then reuse: an open
 *    deferral (`openDeferral`, one row per hold) and a same-day `dnd`/`quiet-hours` suppression
 *    (`sameDaySuppression`, one row per owner day). Re-deciding is the whole safety property — the
 *    reuse is never a cached verdict, so DND switched off releases the item on the very next tick.
 *    An `already-seen` suppression is deliberately NOT reused: it is the terminal state, reached at
 *    most once per item per surface, and its row is the plainest audit line the console has.
 * 2. **A dead ledger fails OPEN for sending**, with a warning that names the consequence. A missed
 *    suppression is an annoyance; a silent stop is the ten-dead-days shape (ORB-179: the digest ran
 *    nowhere for ten days and everything looked healthy). The gate never throws into a schedule.
 *    The one thing it will not do is invent a DND: DND is off only because a read SUCCEEDED and
 *    found no row — an unreachable database means "send, and say so".
 *
 * The gate is not a lock. Two turns gating the same item at the same moment may both be told to
 * send, and both `confirm()` calls may write a `sent` row — the same trade the already-seen rule
 * makes explicit: a rare duplicate beats an item lost for good. Already-seen still holds for every
 * later tick, which is where the duplicates would otherwise compound.
 *
 * All time math is done in the request's `tz` (the owner clock, ORB-193 Task 2's resolver) with
 * `Intl.DateTimeFormat` and no library — date and time come off the SAME clock, which is exactly
 * what ORB-124/128 and ORB-204 got wrong (a job fired at 09:00 New York, mid-air).
 *
 * LAR-35-s2: `wouldSend` answers "would you let this through right now?" — the same reads and the
 * same recorded hold as `gateInitiation`, but never a `sent` row — so a caller can check the
 * verdict before paying for a model call instead of after.
 */
import type { Pool } from "pg";

/** Same shape as `HeartbeatDb`: anything with a `query`, so a caller can pass a pool or a client. */
export type ProactivityDb = Pick<Pool, "query">;

export type InitiationClass = "scheduled" | "event" | "escalation";

export interface InitiationRequest {
  owner: string;
  agent: string;
  /** `telegram:<chatId>` | `slack:<channelOrUserId>` */
  door: string;
  cls: InitiationClass;
  /** scheduled: the slot key; event: the durable id; escalation: `<id>#<rung>` */
  itemKey: string;
  now: Date;
  /** The owner clock's timezone. */
  tz: string;
  /** Reminders: the owner chose the time, so quiet hours do not apply (DND still does). */
  ownerSetTime?: boolean;
  /** A ladder's final "I stopped": deferred under DND, never suppressed. */
  finalStop?: boolean;
}

export interface ProactivitySettings {
  /** "HH:MM" in the owner tz. */
  quietStart: string;
  quietEnd: string;
  eventPerDoorPerDay: number;
  escalationPerDoorPerDay: number;
  perOwnerPerDay: number;
  /** Resolved for (owner, agent, door) as an OR across scopes. */
  dnd: boolean;
}

/**
 * The engine floor and ceiling. Settings may lower a ceiling and move quiet hours; neither may
 * raise a ceiling, and the quiet window may not shrink below `quietMinHours`.
 *
 * THIS OBJECT HAS A TWIN: `services/console/lib/proactivity.ts`'s own `ENGINE`, which MIRRORS these
 * numbers rather than importing them — the console deliberately does not depend on this package
 * (ADR-0014 rule 12 names the two-place truth as a known cost). Change a number here and change it
 * there in the SAME commit. `services/console/tests/engine-drift.test.ts` reads this file as text and
 * fails if the two disagree, including if a FIELD is added, so the alarm is what catches a
 * half-finished change — but the alarm lives in the console's suite, not this package's.
 */
export const ENGINE = {
  quietStart: "21:00",
  quietEnd: "07:00",
  quietMinHours: 8,
  eventPerDoorPerDay: 20,
  escalationPerDoorPerDay: 3,
  perOwnerPerDay: 30,
} as const;

export interface LedgerState {
  /** `sent` rows of class `event` for this owner+door on the owner day. */
  sentTodayDoorEvent: number;
  /** `sent` rows of class `escalation` for this owner+door on the owner day. Counted separately,
   *  because the two ceilings are separate budgets: a chatty day of events must not spend the
   *  escalation budget, which exists precisely for the item nothing has answered. */
  sentTodayDoorEscalation: number;
  /** event + escalation together, for the owner across every door and agent. */
  sentTodayOwner: number;
  /** any `sent` row with this owner+agent+itemKey, ever. */
  alreadySeen: boolean;
}

export type Decision =
  | { verdict: "send" }
  | { verdict: "suppress"; reason: "dnd" | "quiet-hours" | "already-seen" }
  | { verdict: "defer"; reason: "dnd-final-stop" | "quiet-hours" | "door-ceiling" | "owner-ceiling"; until: string };

// ---------------------------------------------------------------------------------------------
// Owner-clock arithmetic. No library: `Intl.DateTimeFormat` with `sv-SE`, which formats as
// `YYYY-MM-DD HH:MM` — ISO-shaped without hand-assembling it (the same trick `src/clock.ts` and
// `services/chief-of-staff/lib/recurrence.ts` use).
// ---------------------------------------------------------------------------------------------

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    FORMATTERS.set(tz, f);
  }
  return f;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Wall-clock parts of `d` read in `tz`. */
function partsIn(d: Date, tz: string): { date: string; hour: number; minute: number } {
  const p = Object.fromEntries(formatter(tz).formatToParts(d).map((x) => [x.type, x.value]));
  let hour = Number(p.hour);
  if (hour === 24) hour = 0; // some runtimes render midnight as "24"
  return { date: `${p.year}-${p.month}-${p.day}`, hour, minute: Number(p.minute) };
}

/** The owner-clock calendar day (`YYYY-MM-DD`) an instant belongs to. */
export function ownerDay(now: Date, tz: string): string {
  return partsIn(now, tz).date;
}

/** The `HH:MM` wall clock in `tz`. */
export function wallClock(now: Date, tz: string): string {
  const { hour, minute } = partsIn(now, tz);
  return `${pad(hour)}:${pad(minute)}`;
}

/** A wall clock the engine will accept: 00:00–23:59, zero-padded. Mirrored by the CHECK constraint
 *  on `proactivity_settings.quiet_start`/`quiet_end` in `sql/035_proactivity.sql`. */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** `YYYY-MM-DD` plus n calendar days. */
function addDays(date: string, n: number): string {
  const [y, mo, d] = date.split("-").map(Number);
  const at = new Date(Date.UTC(y ?? 1970, (mo ?? 1) - 1, (d ?? 1) + n));
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

const dayMinutes = (date: string): number => {
  const [y, mo, d] = date.split("-").map(Number);
  return Date.UTC(y ?? 1970, (mo ?? 1) - 1, d ?? 1) / 60_000;
};

/**
 * The instant at which the wall clock in `tz` reads `hhmm` on `date`.
 *
 * Inverted by search, because there is no stdlib way to go the other direction: take the naive UTC
 * guess, ask `tz` what that instant reads as, and shift by the difference. Two corrections settle
 * every real zone (the second one catches a DST boundary falling between the guess and the target).
 *
 * The loop does NOT assert convergence, because one case cannot converge: a wall-clock time inside
 * the spring-forward gap never happens, so the correction oscillates. It is capped at three
 * corrections and returns the last guess, which for that case is the instant just BEFORE the gap —
 * 01:30 local for a requested 02:30 on 2026-03-29 in Europe/Oslo. Early rather than never, which
 * is the right direction for a quiet-end boundary; asserted in the tests so a change is visible.
 */
export function instantAt(date: string, hhmm: string, tz: string): Date {
  const target = dayMinutes(date) + toMinutes(hhmm);
  let guess = target * 60_000;
  for (let i = 0; i < 3; i++) {
    const p = partsIn(new Date(guess), tz);
    const reads = dayMinutes(p.date) + p.hour * 60 + p.minute;
    const drift = reads - target;
    if (drift === 0) break;
    guess -= drift * 60_000;
  }
  return new Date(guess);
}

/** Midnight starting the next owner day — where a ceiling's roll-over lands. */
export function nextOwnerDayStart(now: Date, tz: string): Date {
  return instantAt(addDays(ownerDay(now, tz), 1), "00:00", tz);
}

/** The next instant the wall clock reads `quietEnd`: today's if still ahead, else tomorrow's. */
export function nextQuietEnd(now: Date, tz: string, quietEnd: string): Date {
  const today = instantAt(ownerDay(now, tz), quietEnd, tz);
  return today.getTime() > now.getTime() ? today : instantAt(addDays(ownerDay(now, tz), 1), quietEnd, tz);
}

/** Is `hhmm` inside the quiet window? Handles the midnight wrap (21:00 → 07:00). Start is
 *  inclusive, end exclusive: 21:00 and 06:59 are quiet, 07:00 and 20:59 are not. */
export function isWithinQuietHours(hhmm: string, start: string, end: string): boolean {
  let from = start, to = end;
  if (!HHMM.test(from) || !HHMM.test(to)) {
    // `toMinutes` would return NaN and EVERY comparison against NaN is false, so a typo in one
    // settings cell would quietly abolish quiet hours at every hour of the day. Fall back to the
    // engine window instead: an unparseable window must never read as "no quiet hours at all".
    console.warn(
      `proactivity: quiet hours ${JSON.stringify(start)}–${JSON.stringify(end)} are not "HH:MM" — ` +
      `using the engine window ${ENGINE.quietStart}–${ENGINE.quietEnd} instead`,
    );
    from = ENGINE.quietStart; to = ENGINE.quietEnd;
  }
  if (!HHMM.test(hhmm)) {
    // Only ever reached if a caller hand-builds the wall clock; `wallClock()` cannot produce this.
    console.warn(`proactivity: ${JSON.stringify(hhmm)} is not a "HH:MM" wall clock — reading it as outside quiet hours`);
    return false;
  }
  const t = toMinutes(hhmm), s = toMinutes(from), e = toMinutes(to);
  if (s === e) return false; // an empty window; loadSettings replaces it with the engine one first
  return s < e ? t >= s && t < e : t >= s || t < e;
}

// ---------------------------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------------------------

/**
 * Pure. In order: DND, already-seen, quiet hours, ceilings, send.
 *
 * The order is the contract, not an implementation detail. DND is first because it is the owner's
 * own switch and outranks everything. Already-seen is second because a duplicate is the one thing
 * no later rule can undo. Quiet hours come before the ceilings so that a night-time item is
 * deferred to the morning rather than to the abstract "next day". Scheduled slots skip the
 * ceilings (they are bounded by the slot list) and are DROPPED, not deferred, inside quiet hours —
 * Marcel's rule: a very late catch-up post is worse than no post.
 */
export function decideInitiation(req: InitiationRequest, s: ProactivitySettings, state: LedgerState): Decision {
  if (s.dnd) {
    return req.finalStop
      ? { verdict: "defer", reason: "dnd-final-stop", until: nextOwnerDayStart(req.now, req.tz).toISOString() }
      : { verdict: "suppress", reason: "dnd" };
  }

  if (state.alreadySeen) return { verdict: "suppress", reason: "already-seen" };

  if (!req.ownerSetTime && isWithinQuietHours(wallClock(req.now, req.tz), s.quietStart, s.quietEnd)) {
    return req.cls === "scheduled"
      ? { verdict: "suppress", reason: "quiet-hours" }
      : { verdict: "defer", reason: "quiet-hours", until: nextQuietEnd(req.now, req.tz, s.quietEnd).toISOString() };
  }

  if (req.cls !== "scheduled") {
    const [spent, doorCeiling] = req.cls === "event"
      ? [state.sentTodayDoorEvent, s.eventPerDoorPerDay]
      : [state.sentTodayDoorEscalation, s.escalationPerDoorPerDay];
    if (spent >= doorCeiling) {
      return { verdict: "defer", reason: "door-ceiling", until: nextOwnerDayStart(req.now, req.tz).toISOString() };
    }
    if (state.sentTodayOwner >= s.perOwnerPerDay) {
      return { verdict: "defer", reason: "owner-ceiling", until: nextOwnerDayStart(req.now, req.tz).toISOString() };
    }
  }

  return { verdict: "send" };
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

interface SettingsRow {
  agent: string;
  door: string;
  quiet_start: string | null;
  quiet_end: string | null;
  event_per_door_per_day: number | null;
  escalation_per_door_per_day: number | null;
  per_owner_per_day: number | null;
  dnd: boolean;
}

/** A ceiling may only be lowered. A value above the engine default is a configuration mistake or
 *  an attempt to raise it; either way it is clamped, silently, on every read. */
const clamp = (value: number | null, engine: number): number =>
  value === null || value === undefined ? engine : Math.max(0, Math.min(Number(value), engine));

/**
 * Global (`agent='*'`, `door='*'`) → agent row → door row → the (agent, door) row: the most
 * specific non-NULL value wins, per field. DND is the exception — it is an OR across every
 * matching scope, so a global "do not disturb" cannot be undone by a narrower row saying false.
 */
export async function loadSettings(
  db: ProactivityDb, owner: string, agent: string, door: string,
): Promise<ProactivitySettings> {
  const { rows } = await db.query<SettingsRow>(
    `SELECT agent, door, quiet_start, quiet_end,
            event_per_door_per_day, escalation_per_door_per_day, per_owner_per_day, dnd
       FROM proactivity_settings
      WHERE owner = $1 AND agent IN ('*', $2) AND door IN ('*', $3)`,
    [owner, agent, door],
  );

  const rank = (r: SettingsRow) => (r.agent === "*" ? 0 : 1) + (r.door === "*" ? 0 : 2);
  const ordered = [...rows].sort((a, b) => rank(a) - rank(b));

  const pick = <K extends keyof SettingsRow>(key: K): SettingsRow[K] | null => {
    let found: SettingsRow[K] | null = null;
    for (const r of ordered) if (r[key] !== null && r[key] !== undefined) found = r[key];
    return found;
  };

  // A stored value that is not "HH:MM" is a configuration mistake, and the unsafe reading of it is
  // "no quiet hours" (see `isWithinQuietHours`). Each cell falls back to its engine value alone, so
  // one bad half does not discard the good one.
  const validated = (column: string, raw: string, engine: string): string => {
    if (HHMM.test(raw)) return raw;
    console.warn(
      `proactivity: ${column} ${JSON.stringify(raw)} in proactivity_settings for ${owner}/${agent}/${door} ` +
      `is not "HH:MM" — using the engine default ${engine}`,
    );
    return engine;
  };

  let quietStart = validated("quiet_start", (pick("quiet_start") as string | null) ?? ENGINE.quietStart, ENGINE.quietStart);
  let quietEnd = validated("quiet_end", (pick("quiet_end") as string | null) ?? ENGINE.quietEnd, ENGINE.quietEnd);

  // "Movable but not removable": the window may be moved anywhere, but never shrunk below the engine
  // floor. A window under the floor falls back to the ENGINE window whole — NOT to the owner's start
  // with the end pushed out, which would turn a 05:00–06:00 window into 05:00–13:00 and silence the
  // entire morning. That is the opposite of what someone typing 05:00–06:00 was asking for.
  const span = ((toMinutes(quietEnd) - toMinutes(quietStart)) + 1440) % 1440;
  if (span < ENGINE.quietMinHours * 60) {
    console.warn(
      `proactivity: quiet hours ${quietStart}–${quietEnd} for ${owner}/${agent}/${door} are shorter than the ` +
      `engine floor of ${ENGINE.quietMinHours} h — using the engine window ${ENGINE.quietStart}–${ENGINE.quietEnd} ` +
      "instead (quiet hours are movable, not removable)",
    );
    quietStart = ENGINE.quietStart;
    quietEnd = ENGINE.quietEnd;
  }

  return {
    quietStart,
    quietEnd,
    eventPerDoorPerDay: clamp(pick("event_per_door_per_day") as number | null, ENGINE.eventPerDoorPerDay),
    escalationPerDoorPerDay: clamp(pick("escalation_per_door_per_day") as number | null, ENGINE.escalationPerDoorPerDay),
    perOwnerPerDay: clamp(pick("per_owner_per_day") as number | null, ENGINE.perOwnerPerDay),
    dnd: ordered.some((r) => r.dnd === true),
  };
}

// ---------------------------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------------------------

const COUNTED = "('event','escalation')"; // scheduled slots never count against an attention ceiling

/** The ledger facts `decideInitiation` needs, all read fresh: the dedupe flag, the two per-door
 *  budgets and the owner's, for the owner day the request's instant falls on IN ITS OWN TIMEZONE. */
export async function loadLedgerState(db: ProactivityDb, req: InitiationRequest): Promise<LedgerState> {
  const day = ownerDay(req.now, req.tz);
  const { rows } = await db.query<{ seen: number; door_event: number; door_escalation: number; owner_count: number }>(
    `SELECT
       (SELECT count(*) FROM initiations
          WHERE owner = $1 AND agent = $2 AND item_key = $3 AND status = 'sent')::int AS seen,
       (SELECT count(*) FROM initiations
          WHERE owner = $1 AND door = $4 AND owner_day = $5 AND status = 'sent' AND cls = 'event')::int AS door_event,
       (SELECT count(*) FROM initiations
          WHERE owner = $1 AND door = $4 AND owner_day = $5 AND status = 'sent' AND cls = 'escalation')::int AS door_escalation,
       (SELECT count(*) FROM initiations
          WHERE owner = $1 AND owner_day = $5 AND status = 'sent' AND cls IN ${COUNTED})::int AS owner_count`,
    [req.owner, req.agent, req.itemKey, req.door, day],
  );
  const r = rows[0];
  return {
    alreadySeen: (r?.seen ?? 0) > 0,
    sentTodayDoorEvent: r?.door_event ?? 0,
    sentTodayDoorEscalation: r?.door_escalation ?? 0,
    sentTodayOwner: r?.owner_count ?? 0,
  };
}

const DEFER_REASONS = new Set(["dnd-final-stop", "quiet-hours", "door-ceiling", "owner-ceiling"]);
type DeferReason = Extract<Decision, { verdict: "defer" }>["reason"];

/**
 * A deferral this item is still serving, if any: the farthest-future open hold for
 * (owner, agent, item_key) — the `deferred` row with the largest `until_at` still ahead of the
 * request's instant (`ORDER BY until_at DESC`), so a longer hold is never cut short by a shorter
 * one written earlier. `initiations_hold_idx` in migration 035 serves exactly this lookup.
 *
 * This is what keeps the ledger small. Most deferring surfaces are pollers — email-triage ticks
 * every minute — and without this a single item held through eight quiet hours would write ~480
 * identical rows, inflating the console's held-back view and the table alike. One row per HOLD,
 * not per tick: the hold is reused until it expires, and then the item is decided afresh.
 */
export async function openDeferral(
  db: ProactivityDb, req: InitiationRequest,
): Promise<{ reason: DeferReason; until: string } | null> {
  const { rows } = await db.query<{ reason: string | null; until_at: Date }>(
    `SELECT reason, until_at FROM initiations
      WHERE owner = $1 AND agent = $2 AND item_key = $3 AND status = 'deferred' AND until_at > $4
      ORDER BY until_at DESC
      LIMIT 1`,
    [req.owner, req.agent, req.itemKey, req.now],
  );
  const r = rows[0];
  if (!r || !r.reason || !DEFER_REASONS.has(r.reason)) return null; // an unrecognised row: decide afresh
  return { reason: r.reason as DeferReason, until: new Date(r.until_at).toISOString() };
}

/** The two suppressions a long spell can re-decide identically on every tick, and so the two worth
 *  reusing. `already-seen` is excluded on purpose: it is terminal, not a spell. */
const REUSABLE_SUPPRESSIONS = new Set(["dnd", "quiet-hours"]);
type SuppressReason = Extract<Decision, { verdict: "suppress" }>["reason"];

/**
 * The reason this item was already suppressed for TODAY on the owner clock, if it was — a `dnd` or
 * `quiet-hours` row for (owner, agent, item_key) on `ownerDay(req.now, req.tz)`.
 *
 * The companion to `openDeferral`, for the other shape a long hold takes. A deferral carries an
 * `until_at` and so bounds itself; a suppression does not, and the bound that fits it is the owner
 * DAY — DND could be turned off at any moment, so the row may only stand for as long as the day the
 * ceilings and the console already count on. Served by `initiations_suppressed_idx` in migration 035.
 *
 * The caller re-decides first and reuses this ONLY when the fresh decision is the same suppression;
 * this is a "have I already said so today?" lookup, never a verdict.
 */
export async function sameDaySuppression(
  db: ProactivityDb, req: InitiationRequest,
): Promise<SuppressReason | null> {
  const { rows } = await db.query<{ reason: string | null }>(
    `SELECT reason FROM initiations
      WHERE owner = $1 AND agent = $2 AND item_key = $3 AND status = 'suppressed'
        AND owner_day = $4 AND reason = ANY($5)
      LIMIT 1`,
    [req.owner, req.agent, req.itemKey, ownerDay(req.now, req.tz), [...REUSABLE_SUPPRESSIONS]],
  );
  const reason = rows[0]?.reason;
  return reason && REUSABLE_SUPPRESSIONS.has(reason) ? (reason as SuppressReason) : null;
}

/** One ledger row. Two clocks on purpose: `decided_at` is the DATABASE's `now()` (the column
 *  default), so the audit trail is ordered by one clock across every agent and container, while
 *  `sent_at` is this process's clock at the moment the send was confirmed. `owner_day` is neither —
 *  it is the owner's calendar day for `req.now`, which is what the ceilings count on. */
async function record(
  db: ProactivityDb, req: InitiationRequest,
  status: "sent" | "suppressed" | "deferred",
  reason: string | null, until: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO initiations (owner, agent, door, cls, item_key, status, reason, until_at, owner_day, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      req.owner, req.agent, req.door, req.cls, req.itemKey, status, reason, until,
      ownerDay(req.now, req.tz), status === "sent" ? new Date() : null,
    ],
  );
}

/**
 * The gate. Reads the settings and the ledger, decides, records a NEW suppression or a NEW deferral
 * immediately, and hands back a `confirm()` the caller invokes ONLY after the send actually
 * succeeded — that is what writes the `sent` row, which is at once the dedupe key and the daily
 * counter. `confirm()` on a non-send decision is a no-op, and calling it twice writes one row.
 *
 * "NEW" is the load-bearing word, and it is what keeps the ledger the size of the held-back list
 * rather than the size of the tick count (see the module header). Two rows are reused rather than
 * duplicated:
 *
 *   - an item already serving an unexpired deferral is handed that same hold back — one row per HOLD;
 *   - an item already suppressed today for `dnd` or `quiet-hours` is re-decided, and if the fresh
 *     decision is that SAME suppression, that row stands — one row per OWNER DAY.
 *
 * The re-decide is not a formality: a settings change between two ticks must land, and DND switched
 * off is exactly the change that must release a held item at once. Any other fresh outcome — send,
 * defer, or a suppression for a different reason — is recorded as usual.
 *
 * Never throws. An unreachable or broken ledger warns and returns `send`: a missed suppression is
 * an annoyance, a silent stop is the failure this whole ticket exists to prevent.
 */
export async function gateInitiation(
  db: ProactivityDb, req: InitiationRequest,
): Promise<Decision & { confirm(): Promise<void> }> {
  let decision: Decision;
  let reused = false; // an existing row already carries this decision: nothing new to record
  try {
    const [open, suppressedToday, settings, state] = await Promise.all([
      openDeferral(db, req),
      sameDaySuppression(db, req),
      loadSettings(db, req.owner, req.agent, req.door),
      loadLedgerState(db, req),
    ]);
    if (open) {
      reused = true;
      decision = { verdict: "defer", reason: open.reason, until: open.until };
    } else {
      decision = decideInitiation(req, settings, state);
      if (decision.verdict === "suppress" && decision.reason === suppressedToday) reused = true;
    }
  } catch (e) {
    console.warn(
      `proactivity: the ledger could not be read for ${req.agent}/${req.door} (${req.itemKey}) — ` +
      `failing OPEN, so this initiation will SEND unchecked (no quiet hours, no DND, no ceiling, no dedupe)`,
      e,
    );
    decision = { verdict: "send" };
  }

  if (decision.verdict !== "send" && !reused) {
    try {
      await record(db, req, decision.verdict === "suppress" ? "suppressed" : "deferred",
        decision.reason, decision.verdict === "defer" ? decision.until : null);
    } catch (e) {
      console.warn(
        `proactivity: could not record the ${decision.verdict} of ${req.itemKey} (${decision.reason}) — ` +
        "the decision stands, but the console's held-back view will not show it", e,
      );
    }
  }

  let confirmed = false;
  const confirm = async (): Promise<void> => {
    if (decision.verdict !== "send" || confirmed) return;
    confirmed = true;
    try {
      await record(db, req, "sent", null, null);
    } catch (e) {
      confirmed = false;
      console.warn(
        `proactivity: the sent row for ${req.itemKey} (${req.agent}/${req.door}) could not be written — ` +
        "the message went out, so this item may be sent again and will not count against today's ceiling", e,
      );
    }
  };

  return { ...decision, confirm };
}

/** The shape almost every caller wants: gate, send, confirm — in that order, never the other. */
export async function gatedSend(
  db: ProactivityDb, req: InitiationRequest, send: () => Promise<void>,
): Promise<Decision> {
  const gate = await gateInitiation(db, req);
  const { confirm, ...decision } = gate;
  if (decision.verdict !== "send") return decision as Decision;
  await send(); // a throw here leaves NO sent row: the item is retried, never silently lost
  await confirm();
  return decision as Decision;
}

/**
 * "Would you let this through right now?" (LAR-35) — `gateInitiation` with the send half thrown
 * away rather than run. It makes the exact same reads and records the exact same NEW hold a real
 * send would (an open deferral or a same-day suppression is reused, not duplicated), so a caller
 * gets a truthful answer and the console's held-back view sees it exactly as if a real lane had
 * asked. The one thing it never does is write a `sent` row: there is no `confirm()` here to call,
 * because nothing was sent, so a `send` verdict costs the ledger nothing at all. Never throws;
 * fails open to `send`, exactly like `gateInitiation`.
 *
 * Built for a caller that wants to know the verdict BEFORE paying for a model call — the fix for
 * ADR 0014's "two lanes bill a model on every retry of a held item" — without inventing a second
 * decision path: implemented by calling `gateInitiation` itself and dropping `confirm`, never by
 * restating its rules.
 */
export async function wouldSend(db: ProactivityDb, req: InitiationRequest): Promise<Decision> {
  const { confirm, ...decision } = await gateInitiation(db, req);
  return decision as Decision;
}

/**
 * What is being held back, per door — the morning brief's "held back" line and the console's ledger
 * view. Two kinds of row qualify: one DECIDED inside the window (`decided_at >= since`), and one
 * still OPEN whatever its age (`until_at > now()`). The second clause is the one that matters for
 * the 08:00 brief: the items deferred at 22:30 last night until 07:00 this morning were decided
 * before any sane "since" the brief would pass, and without it the brief would report nothing held
 * back on exactly the morning it has something to report.
 *
 * Each item counts ONCE however many ticks reconsidered it — "12 things are waiting" is the truth,
 * "480 deferrals" is only how often a poller looked (holds are reused now, so this mostly collapses
 * one item held across several owner days).
 */
export async function deferredSince(
  db: ProactivityDb, owner: string, since: Date,
): Promise<Array<{ door: string; count: number }>> {
  try {
    const { rows } = await db.query<{ door: string; count: number }>(
      `SELECT door, count(DISTINCT item_key)::int AS count
         FROM initiations
        WHERE owner = $1 AND status = 'deferred' AND (decided_at >= $2 OR until_at > now())
        GROUP BY door
        ORDER BY door`,
      [owner, since],
    );
    return rows.map((r) => ({ door: r.door, count: Number(r.count) }));
  } catch (e) {
    console.warn(
      `proactivity: could not read the held-back items for ${owner} — reporting none, so a brief still sends`, e,
    );
    return [];
  }
}
