/**
 * lib/calendar-conflicts.ts — the calendar's clashes, found by CODE (ORB-139, detection half).
 *
 * WHY THIS EXISTS, in incident terms. On 2026-08-20 Saga listed the coming week and, entirely
 * unprompted, caught two overlapping New York hotel bookings and a status meeting whose Oslo
 * clock time landed at 06:00 where he actually was. Both catches were genuinely useful and
 * both were LUCK: a grep for conflict/overlap/double-book across the brief, the calendar
 * fan-out and every instruction file returned nothing. The model happened to notice. A
 * behaviour that exists only because a model happened to notice is a behaviour that will be
 * missing on the morning it matters, with no red test and no log line to say so.
 *
 * So this module is deterministic, pure and total: same events in, same findings out, no I/O,
 * no model call, no eve import. It answers ONE question — "what on this calendar contradicts
 * itself?" — and it never proposes a fix. Resolving a clash from evidence he already has
 * (which hotel the confirmation mail actually kept) is a LATER ticket on purpose; detection is
 * useful on its own and ships on its own.
 *
 * WHAT IT DOES NOT DO, and must not grow into: it never deletes, declines, moves or answers
 * anything. It returns rows. Everything downstream of it is prose.
 *
 * THREE CLASSES, in the priority the ticket names them (a fourth, travel-time impossibility,
 * is explicitly NOT in this ticket — see {@link CONFLICT_PRIORITY}):
 *
 *  1. `double-booked` — two TIMED commitments overlapping.
 *  2. `overlapping-stay` — two beds booked for the same night.
 *  3. `timezone-trap` — an event whose wall-clock time is nonsense where he will actually be.
 *
 * THE FALSE-POSITIVE BUDGET IS THE POINT. A radar that cries wolf gets ignored, and an ignored
 * radar is worse than none because it also costs the attention of every true finding beside
 * it. Every exclusion below is therefore a rule with a reason, written down and tested, not
 * defensive filtering:
 *
 *   - an all-day placeholder overlapping a meeting is NOT a double booking (he is not in two
 *     places; one of them is a label on the day);
 *   - a declined or cancelled event is not a commitment;
 *   - an event he marked FREE (`transparency: "transparent"`) is not a commitment — but see
 *     {@link staysOf}, where that same flag is deliberately ignored, because a booking
 *     confirmation Gmail files is nearly always "free" and excluding it would delete the whole
 *     overlapping-stay class;
 *   - an out-of-office or working-location marker is a statement about availability, never a
 *     meeting (the same reasoning `lib/brief-content.ts`'s `classifyEvent` already records);
 *   - two TENTATIVE events do not clash with each other — nothing has been committed yet;
 *   - the SAME commitment read off two calendars is one commitment, not a clash (see
 *     {@link dedupeEvents} — his briefs read every calendar of both accounts plus the
 *     read-only one he subscribes to, so this is the common case, not an edge case);
 *   - a 06:00 event on an ordinary home-timezone day is an early start, not a trap.
 *
 * WHY IT DOES NOT IMPORT `classifyEvent` FROM `lib/brief-content.ts`, though the lodging
 * vocabulary below is deliberately the same one. The dependency runs ONE WAY: `brief-content`
 * imports this module to render its block, and nothing here imports it back. ORB-209 removed a
 * real ESM cycle between `brief-content` and `obligation-resolution` and this file is not
 * about to add the next one. The duplication is small, named, and cheaper than the cycle.
 *
 * WHAT BREAKS SILENTLY IF GOOGLE ADDS A CASE. Three of the fields the rules read are wire
 * values from the Calendar API — `status`, `transparency` and the owner's own
 * `responseStatus` (see `lib/google.ts`'s `CalendarEvent`, which documents each one against
 * `googleapis`' own typings). Every comparison below is written so an UNKNOWN value falls
 * through to "an ordinary committed event": a seventh status Google invents tomorrow makes
 * this radar noisier, never blinder. That direction is chosen on purpose — a missed clash is
 * the failure this ticket exists to fix.
 */
import type { CalendarEvent } from "./google.js";

/** The clock he keeps when nothing says otherwise. Every "which day is it" question in this
 *  module is answered on THIS zone, never on a trip's own — the same rule
 *  `agent/instructions/travel-context.ts` records at length, so Saga and Marcel can never
 *  disagree about which day a booking belongs to. */
export const DEFAULT_HOME_TIMEZONE = "Europe/Oslo";

/** The waking hours a scheduled event is expected to land in, where he actually is. Outside
 *  this, a meeting is something he has to be told about before he sleeps through it. */
export const WAKING_HOURS_START = 7;
export const WAKING_HOURS_END = 22;

/**
 * How many events one pass will consider, after de-duplication.
 *
 * Detection is pairwise, so the work is quadratic in this number; the brief hands it a
 * two-day window (a few dozen events) and the on-request tool can be asked for a month. The
 * cap is a ceiling on a runaway read, not a tuning knob — 400 events is far past any honest
 * calendar window and still trivial to scan.
 */
export const MAX_CONFLICT_EVENTS = 400;

export type ConflictKind = "double-booked" | "overlapping-stay" | "timezone-trap";

/**
 * The ticket's own priority order, and the ordering key for the results.
 *
 * `travel-time impossibility` — back-to-back commitments in places he cannot get between — is
 * the fourth class the ticket names and is deliberately NOT implemented here. It needs a
 * journey-time lookup (the `transit` capability), which makes it neither pure nor free, and
 * that is a different shape of change from this one. Two flights that overlap in TIME are
 * still caught, by `double-booked`, because they are two timed commitments like any other.
 */
export const CONFLICT_PRIORITY: readonly ConflictKind[] = [
  "double-booked",
  "overlapping-stay",
  "timezone-trap",
];

export type ConflictSeverity = "high" | "medium";

/** One event as a finding names it: enough to recognise it, never the whole event. */
export interface ConflictEventRef {
  readonly id: string;
  readonly title: string;
  /** Verbatim from the calendar — an RFC-3339 instant, or a bare `YYYY-MM-DD` for an all-day
   *  entry. Never reformatted here: a clock time rendered from an all-day row is the ORB-118
   *  lesson, and this module has no business guessing which zone to render in. */
  readonly start: string;
  readonly end: string;
  readonly allDay?: boolean;
  /** LAR-59-s1 groundwork: which account and calendar this event came from (from the
   *  fan-out's stamp on `CalendarEvent`), carried through only when present so a later
   *  resolution step can target the right calendar entry. Never set here, never inferred. */
  readonly account?: string;
  readonly calendarId?: string;
}

export interface CalendarConflict {
  readonly kind: ConflictKind;
  readonly severity: ConflictSeverity;
  /** The events in the clash, in the order they start. Always at least two. */
  readonly events: readonly ConflictEventRef[];
  /** One line, plain language, quotable as-is — states what was found and nothing more. It
   *  never proposes a fix: that is the resolution half, and a later ticket. */
  readonly explanation: string;
}

/** One trip, reduced to what a clash needs to know: which days, and whose clock. Structurally
 *  a `lib/travel-store.ts` `TravelTrip`, declared here so this module depends on no store. */
export interface ConflictTrip {
  /** Inclusive ISO date. */
  readonly start: string;
  /** Inclusive ISO date. */
  readonly end: string;
  /** IANA zone, e.g. `America/New_York`. Ignored when empty or unreadable. */
  readonly timezone: string;
}

export interface ConflictContext {
  /**
   * The calendar dates (home-zone `YYYY-MM-DD`) this pass covers — the BOUND on the window.
   * A finding must touch one of them, so a clash two weeks out never crowds a morning brief
   * that is about today. Empty means "no days", which yields no findings rather than all of
   * them: an unbounded default is how a brief block quietly becomes a month's audit.
   */
  readonly days: readonly string[];
  /** Where he actually is, per day (Marcel's trip store, via `readBriefTravel`). Absent or
   *  empty means "home all week", which is the honest default — not "unknown, so say nothing". */
  readonly trips?: readonly ConflictTrip[];
  /** Defaults to {@link DEFAULT_HOME_TIMEZONE}. */
  readonly homeTimezone?: string;
  /** Defaults to {@link MAX_CONFLICT_EVENTS}. */
  readonly maxEvents?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Small pure helpers — dates, zones, spans.
// ═══════════════════════════════════════════════════════════════════════════════════════════

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/u;

const lower = (s: string | undefined): string => (s ?? "").trim().toLowerCase();

/** Google's `fromGmail` vs other surfaces' `FROM_GMAIL` — folded exactly as
 *  `lib/brief-content.ts`'s `normalizeEventType` folds it, for the same reason. */
const normalizeEventType = (raw: string | undefined): string =>
  lower(raw).replace(/[_\s-]/gu, "");

/** TRUE for a bare `YYYY-MM-DD` — an all-day entry's date, which must never be turned into an
 *  instant and back (west of UTC that lands on the previous day). */
const isDateOnly = (s: string): boolean => DATE_ONLY_RE.test(s.trim());

/** `YYYY-MM-DD` plus n days, by UTC arithmetic — exact, because no wall clock is involved. */
export function addDays(day: string, n: number): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(t)) return day;
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The wall clock in `tz` at instant `d`, as `{ date: "YYYY-MM-DD", time: "HH:MM:SS" }`.
 *
 * `sv-SE` for the ISO-shaped output, the same trick `lib/recurrence.ts` and
 * `lib/brief-content.ts` already use. Returns `undefined` for a zone `Intl` refuses — a trip
 * filed with a garbage timezone must cost this pass one finding, never the brief.
 */
function wallClock(d: Date, tz: string): { date: string; time: string } | undefined {
  try {
    const [date, time] = new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz,
      dateStyle: "short",
      timeStyle: "medium",
    })
      .format(d)
      .split(" ");
    if (!date || !time) return undefined;
    return { date, time };
  } catch {
    return undefined; // RangeError: an unknown IANA zone.
  }
}

/** The instant an event starts, or `undefined` for an all-day row (which has none). */
function startInstant(e: CalendarEvent): Date | undefined {
  if (e.allDay === true || isDateOnly(e.start)) return undefined;
  const t = Date.parse(e.start);
  return Number.isNaN(t) ? undefined : new Date(t);
}

/** `[start, end)` as instants for a timed event; `undefined` when either end is unusable. */
function timedSpan(e: CalendarEvent): { start: number; end: number } | undefined {
  if (e.allDay === true || isDateOnly(e.start)) return undefined;
  const start = Date.parse(e.start);
  const end = Date.parse(e.end);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return undefined;
  return { start, end };
}

/**
 * The home-zone calendar dates an event touches, `[first, last]` inclusive.
 *
 * All-day rows are read off their date STRINGS (Google's `end` is the exclusive next
 * midnight); timed rows are read off the wall clock in `home`.
 */
function coveredDays(e: CalendarEvent, home: string): { first: string; last: string } | undefined {
  if (e.allDay === true || isDateOnly(e.start)) {
    const first = e.start.trim().slice(0, 10);
    if (!isDateOnly(first)) return undefined;
    const rawEnd = e.end.trim().slice(0, 10);
    // Google's all-day `end` is EXCLUSIVE, so the last day it covers is the day before it.
    const last = isDateOnly(rawEnd) && rawEnd > first ? addDays(rawEnd, -1) : first;
    return { first, last };
  }
  const span = timedSpan(e);
  if (!span) {
    const only = wallClock(new Date(Date.parse(e.start)), home);
    return only ? { first: only.date, last: only.date } : undefined;
  }
  const a = wallClock(new Date(span.start), home);
  const b = wallClock(new Date(span.end), home);
  if (!a || !b) return undefined;
  return { first: a.date, last: b.date < a.date ? a.date : b.date };
}

/** The zone he is in on `day` — the first trip whose inclusive span covers it, else home. */
export function timezoneOn(day: string, ctx: ConflictContext): string {
  const home = ctx.homeTimezone ?? DEFAULT_HOME_TIMEZONE;
  for (const trip of ctx.trips ?? []) {
    const tz = (trip.timezone ?? "").trim();
    if (tz === "") continue;
    if (trip.start <= day && day <= trip.end) return tz;
  }
  return home;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// De-duplication — the same commitment, seen more than once.
//
// His briefs read EVERY calendar of BOTH Google accounts plus the read-only one he subscribes
// to (`lib/calendar-fanout.ts`, `includeReadOnly`), and an invitation accepted on one calendar
// and copied to another is the normal case, not an edge case. Without this pass, the single
// most common "conflict" this module would report is a meeting clashing with itself.
//
// THREE KEYS, because no one of them is sufficient:
//   - `iCalUID` + the instance's own start: Google gives a copy its own `id` but keeps the UID,
//     which is exactly the copied-invitation case. The start is in the key because every
//     occurrence of a recurring series shares ONE UID (Google's own documented difference
//     between `id` and `iCalUID`), and two Tuesdays are not one commitment.
//   - `id`: two genuinely different events never share one, so this key can never over-merge.
//   - title + start + end: the fan-out's own second key, kept because a calendar COPY
//     operation mints a fresh UID as well as a fresh id, and what survives that is what a
//     human would call the same commitment.
// ═══════════════════════════════════════════════════════════════════════════════════════════

function dedupeKeys(e: CalendarEvent): string[] {
  const keys: string[] = [];
  const uid = (e.iCalUID ?? "").trim();
  if (uid !== "") keys.push(`uid:${uid}|${e.start}|${e.end}`);
  const id = (e.id ?? "").trim();
  if (id !== "") keys.push(`id:${id}`);
  keys.push(`t:${lower(e.summary)}|${e.start}|${e.end}`);
  return keys;
}

/** The events with every repeat of the same commitment removed, in a deterministic order. */
export function dedupeEvents(events: readonly CalendarEvent[]): CalendarEvent[] {
  const ordered = [...events].sort(compareEvents);
  const seen = new Set<string>();
  const out: CalendarEvent[] = [];
  for (const e of ordered) {
    const keys = dedupeKeys(e);
    if (keys.some((k) => seen.has(k))) continue;
    for (const k of keys) seen.add(k);
    out.push(e);
  }
  return out;
}

/** Total order over events: start, then end, then title, then id. Nothing in this module may
 *  depend on the order the calendars happened to answer in. */
function compareEvents(a: CalendarEvent, b: CalendarEvent): number {
  return (
    a.start.localeCompare(b.start) ||
    a.end.localeCompare(b.end) ||
    (a.summary || "").localeCompare(b.summary || "") ||
    (a.id || "").localeCompare(b.id || "")
  );
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// What counts as a commitment.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * How firmly an event is on his day.
 *
 * `excluded` covers five different reasons that all mean the same thing downstream — he is not
 * held to this — and they are folded on purpose: a rule that had to name each one separately
 * at every call site is a rule that will miss one.
 */
export type Commitment = "committed" | "tentative" | "excluded";

/** Titles Gmail writes for a bed. The same vocabulary as `lib/brief-content.ts`'s
 *  `LODGING_TITLE` (verified against his real calendar on 2026-08-25: "Stay at Scandic Oslo
 *  Airport", "Stay at PUBLIC Hotel New York"), plus the Norwegian and apartment-rental words a
 *  stay can also arrive under. Deliberately NOT the bare word "reservation": his one
 *  "Reservation at …" row is a restaurant, and calling that a bed would assert he sleeps
 *  there. */
const STAY_TITLE =
  /\b(stay at|hotel|hotell|motel|motell|hostel|resort|airbnb|lodging|overnatting|opphold|guest ?house|pensjonat|b ?& ?b|bed and breakfast|apartment|leilighet|check[-\s]?in|innsjekk)\b/iu;

/** An availability marker or a birthday feed row is never a meeting — `classifyEvent` records
 *  the same reasoning for the brief's own rendering. */
function isNotAMeetingType(e: CalendarEvent): boolean {
  const type = normalizeEventType(e.eventType);
  return type === "outofoffice" || type === "workinglocation" || type === "birthday";
}

/**
 * The double-booking reading of one event.
 *
 * UNKNOWN VALUES FALL THROUGH TO `committed`, on purpose (see this file's header): a status or
 * response Google invents after this was written makes the radar noisier, never blinder.
 */
export function commitmentOf(e: CalendarEvent): Commitment {
  if (lower(e.status) === "cancelled") return "excluded";
  if (lower(e.myResponse) === "declined") return "excluded";
  // He marked it FREE. Read only here — `staysOf` ignores this flag deliberately.
  if (lower(e.transparency) === "transparent") return "excluded";
  if (isNotAMeetingType(e)) return "excluded";
  // A bed is not a meeting; two of them are an overlapping STAY, which is its own class.
  if (STAY_TITLE.test(e.summary || "")) return "excluded";
  if (lower(e.status) === "tentative" || lower(e.myResponse) === "tentative") return "tentative";
  return "committed";
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Class 1 — double-booked time.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * Two TIMED events that overlap, where both are on his day.
 *
 * THE ALL-DAY RULE, which is the whole false-positive story for this class: an all-day entry
 * is a LABEL on the day ("Oslo", "holiday", a hotel booking Gmail filed), not a place he is
 * standing in, so it can never double-book a meeting. It is excluded here and handled — where
 * it belongs — by the overlapping-stay class below.
 *
 * THE TENTATIVE RULE, stated once so it can be tested: a tentative event counts as a
 * commitment only when the OTHER side of the pair is committed. Two tentatives are two
 * maybes, and reporting them as a clash is how a radar teaches him to skip its findings.
 *
 * Touching ends do not overlap: 10:00–11:00 beside 11:00–12:00 is a well-packed morning.
 */
function doubleBookings(events: readonly CalendarEvent[]): CalendarConflict[] {
  const timed = events
    .map((e) => ({ e, span: timedSpan(e), level: commitmentOf(e) }))
    .filter((r): r is { e: CalendarEvent; span: { start: number; end: number }; level: Commitment } =>
      r.span !== undefined && r.level !== "excluded");

  const out: CalendarConflict[] = [];
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i]!;
      const b = timed[j]!;
      if (a.span.start >= b.span.end || b.span.start >= a.span.end) continue;
      if (a.level === "tentative" && b.level === "tentative") continue;
      const [first, second] = a.span.start <= b.span.start ? [a, b] : [b, a];
      const maybe = a.level === "tentative" || b.level === "tentative"
        ? " One of the two is only tentative."
        : "";
      out.push({
        kind: "double-booked",
        severity: "high",
        events: [refOf(first.e), refOf(second.e)],
        explanation:
          `"${titleOf(first.e)}" and "${titleOf(second.e)}" overlap in time — ` +
          `they cannot both happen as booked.${maybe}`,
      });
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Class 2 — overlapping stays.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** Every date from `first` to `last` inclusive, capped so a booking filed with a nonsense span
 *  can never spin. */
function daySpan(first: string, last: string): string[] {
  const out: string[] = [];
  for (let d = first; d <= last && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The nights one stay covers: `[check-in, check-out)` as home-zone dates. */
function nightsOf(e: CalendarEvent, home: string): string[] {
  const days = coveredDays(e, home);
  if (!days) return [];
  // `coveredDays` returns the last day the entry TOUCHES. For an all-day booking that is
  // already the last night (Google's `end` is the exclusive next midnight, and `coveredDays`
  // has stepped back off it). For a timed one it is the CHECK-OUT day, which is a morning he
  // leaves, not a night he sleeps — so the nights stop one day short of it.
  const allDay = e.allDay === true || isDateOnly(e.start);
  const lastNight = allDay ? days.last : addDays(days.last, -1);
  return daySpan(days.first, lastNight < days.first ? days.first : lastNight);
}

/**
 * The events that are BEDS.
 *
 * `transparency` is deliberately NOT read here, unlike everywhere else in this file: Gmail
 * files a booking confirmation as a FREE all-day entry, so excluding "free" events would
 * delete this entire class and with it the 2026-08-20 finding the ticket was opened for.
 * Cancelled and declined still exclude — a cancelled reservation is not a bed.
 *
 * The title is what identifies a stay, and that is the false-positive guard: two ordinary
 * all-day placeholders overlapping ("Oslo", "vacation") are NOT a conflict, and only a title
 * that names lodging can produce one.
 */
function staysOf(events: readonly CalendarEvent[], home: string): Array<{ e: CalendarEvent; nights: string[] }> {
  return events
    .filter((e) => lower(e.status) !== "cancelled" && lower(e.myResponse) !== "declined")
    .filter((e) => STAY_TITLE.test(e.summary || ""))
    .map((e) => ({ e, nights: nightsOf(e, home) }))
    .filter((r) => r.nights.length > 0);
}

function overlappingStays(
  events: readonly CalendarEvent[], home: string, days: ReadonlySet<string>,
): CalendarConflict[] {
  const stays = staysOf(events, home);
  const out: CalendarConflict[] = [];
  for (let i = 0; i < stays.length; i++) {
    for (let j = i + 1; j < stays.length; j++) {
      const a = stays[i]!;
      const b = stays[j]!;
      const shared = a.nights.filter((n) => b.nights.includes(n));
      if (shared.length === 0) continue;
      // The SHARED NIGHT has to fall inside the window, not merely the two bookings. Two long
      // stays can both reach into today and still have overlapped only on a night last week,
      // and a brief that opens with a clash he already slept through is the noise this class
      // was supposed to be worth interrupting for.
      if (!shared.some((n) => days.has(n))) continue;
      const nights = shared.length === 1
        ? `the night of ${shared[0]}`
        : `${shared.length} nights (${shared[0]} to ${shared[shared.length - 1]})`;
      out.push({
        kind: "overlapping-stay",
        severity: "high",
        events: [refOf(a.e), refOf(b.e)],
        explanation:
          `Two places to sleep are booked over ${nights}: "${titleOf(a.e)}" and "${titleOf(b.e)}".`,
      });
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Class 3 — timezone traps.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * An event booked in one zone that lands at an impossible hour in the zone he will be in.
 *
 * THE GUARD THAT MATTERS: the event's OWN zone must differ from where he is. A 06:00 event on
 * an ordinary day at home is an early start he chose, not a trap, and reporting it would be
 * the radar's first wolf. "Differ" is measured as the WALL CLOCK, not the zone STRING — two
 * zones that name different cities but read the same clock at that instant (a neighbouring
 * country, a zone alias) are the same zone for this purpose, and comparing strings would have
 * flagged every early morning.
 *
 * An event with no zone of its own is read as HOME. That is an assumption, and it is the
 * right-shaped one: these events come off his own calendars, whose default zone is the one he
 * keeps, and the founding case is exactly that — a recurring status meeting booked at home
 * time that follows him across the Atlantic.
 *
 * Bookings Gmail filed (`fromGmail`) are excluded: a flight that boards at 06:00 local is a
 * flight, not a trap, and a hotel check-in has no clock meaning at all.
 */
function timezoneTraps(events: readonly CalendarEvent[], ctx: ConflictContext): CalendarConflict[] {
  const home = ctx.homeTimezone ?? DEFAULT_HOME_TIMEZONE;
  const out: CalendarConflict[] = [];

  for (const e of events) {
    if (lower(e.status) === "cancelled" || lower(e.myResponse) === "declined") continue;
    if (isNotAMeetingType(e)) continue;
    if (normalizeEventType(e.eventType) === "fromgmail") continue;
    const at = startInstant(e);
    if (!at) continue; // all-day rows have no clock time, so they cannot land at a wrong one

    const homeDay = wallClock(at, home);
    if (!homeDay) continue;
    const there = timezoneOn(homeDay.date, ctx);
    const eventZone = (e.startTimeZone ?? "").trim() === "" ? home : e.startTimeZone!.trim();

    const localThere = wallClock(at, there);
    const localBooked = wallClock(at, eventZone);
    if (!localThere || !localBooked) continue;
    // Same wall clock ⇒ the same zone for this purpose, whatever the two are called.
    if (localThere.date === localBooked.date && localThere.time === localBooked.time) continue;

    const hour = Number(localThere.time.slice(0, 2));
    if (!Number.isFinite(hour)) continue;
    if (hour >= WAKING_HOURS_START && hour < WAKING_HOURS_END) continue;

    out.push({
      kind: "timezone-trap",
      severity: "medium",
      events: [refOf(e)],
      explanation:
        `"${titleOf(e)}" is booked for ${localBooked.time.slice(0, 5)} ${eventZone} time, which is ` +
        `${localThere.time.slice(0, 5)} on ${localThere.date} where he is that day (${there}).`,
    });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The pass.
// ═══════════════════════════════════════════════════════════════════════════════════════════

const titleOf = (e: CalendarEvent): string => (e.summary || "").trim() || "(untitled)";

function refOf(e: CalendarEvent): ConflictEventRef {
  return {
    id: e.id ?? "",
    title: titleOf(e),
    start: e.start,
    end: e.end,
    ...(e.allDay === true ? { allDay: true as const } : {}),
    ...(e.account !== undefined ? { account: e.account } : {}),
    ...(e.calendarId !== undefined ? { calendarId: e.calendarId } : {}),
  };
}

/** A finding's ordering key inside its class: earliest event first, then the ids, so two
 *  findings in the same class can never swap places between runs. */
function conflictSortKey(c: CalendarConflict): string {
  const first = c.events[0];
  return `${first?.start ?? ""}|${c.events.map((e) => e.id).join(",")}`;
}

/**
 * Every clash on `events` that touches one of `ctx.days`.
 *
 * Pure and total: no I/O, no clock read, no model. Deterministic in both directions — the same
 * events in any order produce the same findings in the same order.
 *
 * Returns `[]` for an empty window, an empty `days`, or a calendar with nothing wrong on it.
 * `[]` is a real answer here, unlike in the brief's calendar read: this pass reports BY
 * EXCEPTION, and nothing found means nothing rendered rather than "no conflicts" written out
 * (see `lib/brief-content.ts`'s own by-exception contract for obligations).
 */
export function detectCalendarConflicts(
  events: readonly CalendarEvent[],
  ctx: ConflictContext,
): CalendarConflict[] {
  const home = ctx.homeTimezone ?? DEFAULT_HOME_TIMEZONE;
  const days = new Set(ctx.days);
  if (days.size === 0) return [];

  const inWindow = dedupeEvents(events)
    .filter((e) => {
      const covered = coveredDays(e, home);
      if (!covered) return false;
      return daySpan(covered.first, covered.last).some((d) => days.has(d));
    })
    .slice(0, ctx.maxEvents ?? MAX_CONFLICT_EVENTS);

  const found = [
    ...doubleBookings(inWindow),
    ...overlappingStays(inWindow, home, days),
    ...timezoneTraps(inWindow, ctx),
  ];

  return found.sort(
    (a, b) =>
      CONFLICT_PRIORITY.indexOf(a.kind) - CONFLICT_PRIORITY.indexOf(b.kind) ||
      conflictSortKey(a).localeCompare(conflictSortKey(b)),
  );
}
