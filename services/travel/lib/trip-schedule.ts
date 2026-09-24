// lib/trip-schedule.ts — Marcel's trip-arc scheduler: pure date/time math + a per-trip
// at-most-once ledger (sent.json) deciding which lifecycle posts are due, plus the travel-day
// flight watcher (flight-state.json). Ported from services/marcel/lib/schedule.ts (Task 7,
// Ruling 2 of the pre-flight scan: the brief's own Interfaces section required tickTrip/
// reminderFireTime/isQuietForPost as independently unit-testable pure functions but never
// named the file that should hold them — this is that file).
//
// Three deliberate departures from the ported original, all scope-driven:
//
//   - "dream" (nightly learning) and "promote" (end-of-trip taste promotion) are NOT ported
//     here. @lares/agent-kit's schedule-gate.ts doc comment scopes those to a separate schedule ("Tasks
//     7-8: trip-lifecycle, dream, taste-promote, flight-watch") — this file owns trip-lifecycle
//     + flight-watch only. PostKind below is the lifecycle-post subset the brief names.
//   - "intro" was never a scheduler PostKind in old Marcel either — it fires from the group-
//     link callback (services/marcel/bin/marcel.ts:709, on `/link`), never from tick(). Out of
//     scope here for the same reason dream/promote are.
//   - compose()+post() collapse into one injected `post(kind, trip, chatId, ctx)`: in
//     eve-marcel, composing IS sending. agent/schedules/trip-lifecycle.ts wires this to
//     `to(telegram, {chatId}).send(prompt)`, which starts an agent turn that both writes and
//     delivers the post in a single step (see that file's own design-note header for why this
//     is the one place this schedule starts an agent turn rather than using a raw primitive).
//
// The pure logic below (tickTrip, reminderFireTime, isQuietForPost) is fully testable without
// eve, Telegram, or a live flights API — only fs (sent.json/flight-state.json, exactly as the
// original) and injected deps. TripScheduler is the tick owner: kill-switch check, per-trip
// window filtering, and the in-flight/overlap guard, mirroring old Marcel's own split between
// schedule.ts's pure logic and bin/marcel.ts's tick owner.
import fs from "node:fs";
import path from "node:path";
import type { Trip, TripStore } from "./trip-store.js";
import { bookingHeaders } from "./booking-header.js";
import { haversineM } from "./nearby.js";
import { bookingsForDate, renderDayBookings } from "./itinerary-advice.js";
import { extractFlightRefs, type FlightRef, type FlightStatus } from "./flights.js";
import { diffFlightState, renderFlightStatus, type WatchState } from "./flightwatch.js";

/** ORB-125 — `packing` (T-3) and `departure` (T-1) are the ONLY two posts that happen before a
 *  trip now. They replace the roughly fourteen the old `trip.start - 7` window produced: an
 *  evening post plus an 08:30 weather post, every day, from a week out (Bendik: "lets not do
 *  evening and morning posts before the trip, to chatty"). Both count from the DERIVED arrival
 *  date (ORB-124), never `trip.start`. */
export type PostKind =
  | "evening"
  | "arrival"
  | "finale"
  | "checkout"
  | "reminder"
  | "weatherwarn"
  | "packing"
  | "departure";

/**
 * Which slot a lifecycle post fills — everything the proactivity ledger's item key needs beyond
 * the trip and the kind (ORB-193 Task 4: `trip/<slug>/<kind>/<dateISO>`).
 *
 * The date is the POSTING clock's date, the same one the local `sent.json` key carries, so the two
 * ledgers can never disagree about which day a post belongs to.
 */
export interface PostSlot {
  readonly dateISO: string;
  /** The durable id of the thing the post is about, when one day can hold several of the same
   *  kind. Only `reminder` can (one per booking with a time). */
  readonly itemId?: string;
}

/**
 * What a `post` dep did with the message — `@lares/agent-kit/proactivity`'s own three verdicts,
 * spelled out here so this file keeps its zero-dependency shape (the gate lives in
 * `lib/initiation.ts`; the two unions are checked against each other where they meet, in
 * `agent/schedules/trip-lifecycle.ts`).
 *
 * The distinction is what decides the `sent.json` mark, and it is not cosmetic:
 *
 *  - `"send"`   — it went out. Marked, as always.
 *  - `"suppress"` — dropped for GOOD (DND, or quiet hours on the owner clock). The mark STAYS:
 *    a scheduled slot is not a queue, and re-offering it every minute would only write one
 *    suppression row a minute for the rest of the window (ORB-193 plan, Ruling 3).
 *  - `"defer"`  — held until a stated instant (a ceiling, a quiet-hours hold on an event). The
 *    mark comes back OFF: the item must still be eligible when the hold expires.
 *
 * `void` is the pre-gate contract: attempted, treat it as sent.
 */
export type PostVerdict = "send" | "suppress" | "defer";

/** Which flight card a raw send is, for the proactivity ledger's item key (ORB-193 Task 4:
 *  `flight/<slug>/<flightRef>/<state fingerprint>`). */
export interface FlightCard {
  readonly slug: string;
  /** flightwatch's own state key: `<flightNo>:<dateISO>`. */
  readonly flightRef: string;
  /** The material state this message reports — see {@link flightStateFingerprint}. */
  readonly fingerprint: string;
  /** A CANCELLATION alert. It is quiet-hours exempt at the gate (`ownerSetTime`) because the
   *  watcher's own state has already advanced past the cancellation by the time the message is
   *  offered — a deferral here would not be a delay, it would be a loss. See
   *  `agent/schedules/trip-lifecycle.ts`'s `rawSend`. */
  readonly cancelled?: boolean;
}

/**
 * The material flight state a card reports, as one short string: estimated time, gate, check-in,
 * cancellation. This is the ledger's dedupe key, and it is deliberately NOT a hash of the card's
 * text — the card carries an `_Oppdatert HH:MM_` line, so a text hash would make every five-minute
 * poll a brand-new item and the already-seen rule would never hold.
 */
export function flightStateFingerprint(entry: WatchState[string]): string {
  return [entry.estimated ?? "-", entry.gate ?? "-", entry.checkIn ?? "-", entry.cancelled ? "cancelled" : "ok"].join("+");
}

export interface TripScheduleDeps {
  store: TripStore;
  now(): number; // unix seconds
  /** Starts the agent turn that composes AND delivers one lifecycle post. Called once per due
   *  PostKind regardless of whether the resulting agent turn actually sends anything to the chat;
   *  that is the turn's own decision.
   *
   *  Returns the proactivity gate's verdict (ORB-193 Task 4) — see {@link PostVerdict} for what
   *  each one does to the `sent.json` mark. `void` is the pre-gate contract: attempted. */
  post(
    kind: PostKind,
    trip: Trip,
    chatId: string,
    ctx: Record<string, string>,
    slot: PostSlot,
  ): Promise<PostVerdict | void>;
  onJobError?(trip: Trip, key: string, err: unknown): void;
  // Travel-day flight watcher + reminder enrichment. Optional: absent means zero behavior
  // change — no polling, no reminder enrichment.
  flights?: {
    status(ref: FlightRef, opts?: { avinorAirport?: string; direction?: "D" | "A" }): Promise<FlightStatus | null>;
  };
  /** Raw (never an agent turn) flight-card send — deterministic content, see flightwatch.ts.
   *  Used for the legacy per-diff-message path and for cancellation alerts, which always post
   *  fresh even when postFlightMessageWithId/editFlightMessage are wired. `card` is what the
   *  proactivity ledger keys the initiation by (ORB-193 Task 4). */
  postFlightMessage(chatId: string, text: string, card: FlightCard): Promise<void>;
  // Both present → one live status message per flight, edited in place. Either absent →
  // per-diff-message posting via postFlightMessage alone (today's behavior, byte-identical).
  /** `undefined` = nothing was sent (the proactivity gate held the card back), so NO message id is
   *  recorded and the next material change posts a fresh card rather than editing one that does
   *  not exist. */
  postFlightMessageWithId?(chatId: string, text: string, card: FlightCard): Promise<string | undefined>;
  /** An EDIT of a live card, never gated: it is not a new interruption (ORB-193 Task 4). */
  editFlightMessage?(chatId: string, messageId: string, text: string): Promise<boolean>;
  /** International-leg connection-buffer/customs-timing line threshold (Tier 1 #3), passed
   *  straight through to renderFlightStatus. Configurable, not hardcoded inline there. */
  connectionBufferMinutes?: number;
}

const TRIP_MD = "trip.md";
const BOOKINGS_MD = "bookings.md";
const SENT_JSON = "sent.json";
const FLIGHT_STATE_JSON = "flight-state.json";
const FLIGHT_WATCH_BEFORE_HOURS = 6; // start polling T-6h, keep polling until 1h past departure
const FLIGHT_POLL_MINUTES = 5; // self-gate: at most one live lookup per trip per 5 min
const REMINDER_HOURS_FLIGHT = 3;
const REMINDER_HOURS_OTHER = 1;
const QUIET_FLOOR_HHMM = "07:00";
// Posting jobs are matched with >= (a missed tick minute still catches up later), but must not
// catch up forever — once quiet hours start, tonight's post is skipped for good: tomorrow's
// dateISO key means today's job key simply never fires again.
const QUIET_START_HHMM = "22:00";
// ORB-124 — how close to trip.destination a booking has to be for its date to count as the day
// Bendik ARRIVES. Generous on purpose: a hotel in the next borough, an airport an hour out of
// town, a first night in a neighbouring city all still mean "he is there now", while the night
// before departure at Gardermoen (5,700 km from New York) never does.
const ARRIVAL_RADIUS_KM = 200;
// ORB-125 — the two pre-trip posts, counted back from the DERIVED arrival date. Three days is
// inside the range where a forecast is worth packing by; one day is when tomorrow's logistics
// stop being abstract.
const PACKING_DAYS_BEFORE_ARRIVAL = 3;
const DEPARTURE_DAYS_BEFORE_ARRIVAL = 1;


export function isQuietForPost(nowHhmm: string): boolean {
  return nowHhmm >= QUIET_START_HHMM;
}

// --- time helpers -----------------------------------------------------------------
// Both reused from the sv-SE / en-GB hour12:false trick already used elsewhere in this
// service (conversation-log.ts, gatekeeper.ts, weather.ts).

function dateISO(unixSeconds: number, tz: string): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(unixSeconds * 1000));
}

function hhmm(unixSeconds: number, tz: string): string {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(unixSeconds * 1000));
  const [h, m] = formatted.split(":");
  // Some Node/ICU versions render midnight as "24" instead of "00" — normalize.
  const hour = Number(h) % 24;
  return `${String(hour).padStart(2, "0")}:${m}`;
}

// Date-only arithmetic on ISO dates. Noon-UTC avoids DST-edge date drift.
function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetweenISO(fromISO: string, toISO: string): number {
  const from = new Date(`${fromISO}T12:00:00Z`).getTime();
  const to = new Date(`${toISO}T12:00:00Z`).getTime();
  return Math.round((to - from) / 86_400_000);
}

// Booking dates/times are already recorded in the trip's own local timezone (nothing in this
// codebase converts them otherwise — see bookings.ts), so reminder math never needs a real tz
// conversion: treat "<dateISO> <hh:mm>" as a self-consistent wall-clock value, do calendar
// arithmetic on it, and read it back the same way. No real-world DST issue, because the value
// is never actually interpreted as UTC or any real instant.
function wallClockToMs(iso: string, time: string): number {
  const [y, mo, d] = iso.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, h, mi);
}

function msToWallClock(ms: number): { dateISO: string; hhmm: string } {
  const d = new Date(ms);
  return { dateISO: d.toISOString().slice(0, 10), hhmm: d.toISOString().slice(11, 16) };
}

// --- ORB-124: the derived arrival date and the clock that follows from it ----------

/**
 * The day Bendik actually ARRIVES, which is not `trip.start`.
 *
 * `trip.start` is when the JOURNEY starts. On The Big Apple that is 25.8 — the night at
 * Gardermoen, still in Oslo, 5,700 km from the destination. Switching the posting clock on
 * `start` would have put one more evening post at 02:00 Oslo.
 *
 * Rule: the earliest booking date whose `at:<lat>,<lon>` lies within {@link ARRIVAL_RADIUS_KM}
 * of `trip.destination`. Nothing new has to be entered anywhere — `bookings.md` has carried
 * venue coordinates since ORB-109 — and it degrades safely: a trip whose bookings carry no
 * coordinates at all falls back to `trip.start`, exactly today's behaviour.
 *
 * Clamped into `[trip.start, trip.end]`. A booking at the destination dated before the trip
 * starts is a filing mistake, not an earlier arrival, and one dated after the trip ends cannot
 * be an arrival at all; both fall back to `trip.start` rather than inventing a schedule outside
 * the trip.
 */
export function arrivalDateISO(trip: Trip, bookingsMd: string): string {
  const atDestination = bookingHeaders(bookingsMd)
    .filter((b) => b.lat !== undefined && b.lon !== undefined)
    .filter((b) => haversineM({ lat: b.lat!, lon: b.lon! }, trip.destination) <= ARRIVAL_RADIUS_KM * 1000)
    .map((b) => b.start)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();

  const earliest = atDestination[0];
  if (earliest === undefined) return trip.start;
  if (earliest < trip.start || earliest > trip.end) return trip.start;
  return earliest;
}

/**
 * Which clock a tick posts on: home before the arrival date, the trip's own from it.
 *
 * The switch waits until BOTH clocks have reached the arrival date, which matters in opposite
 * ways depending on which way you fly:
 *
 *  - **Westward** (Oslo → New York, trip clock behind home): the trip clock is the late one, so
 *    it decides. The switch happens at midnight in New York, i.e. 06:00 Oslo on arrival day —
 *    and that evening's post lands at 20:00 in New York, where he is.
 *  - **Eastward** (Oslo → Tokyo, trip clock ahead): the HOME clock is the late one. Without this
 *    condition the trip clock would tick over to the arrival date at 17:00 Oslo the day before —
 *    and the T-1 departure post, due at 20:00 home that same evening, would never fire at all,
 *    because `todayISO` had already moved past its date.
 *
 * Taking the later of the two dates is the same thing said once: stay home until home agrees.
 */
export function postingTimezone(trip: Trip, arrivalISO: string, homeTz: string, now: number): string {
  const reached = dateISO(now, trip.timezone) >= arrivalISO && dateISO(now, homeTz) >= arrivalISO;
  return reached ? trip.timezone : homeTz;
}

// --- sent.json (at-most-once ledger) -----------------------------------------------

/** One check-out day, as trip.md records it (ORB-204). */
export interface CheckoutDue {
  readonly dateISO: string;
  /** Recorded check-out time, `HH:MM`, when the line carries one. */
  readonly hhmm?: string;
}

const UTSJEKK_LINE = /^\s*-\s*utsjekk\s*:\s*(.+?)\s*$/gim;
const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})\b/g;
const NORWEGIAN_DATE = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g;
const CLOCK = /\b(\d{1,2})[:.](\d{2})\b/;

/**
 * ORB-204 — the check-out day(s) trip.md records, read off its `- Utsjekk: …` line(s).
 *
 * `Utsjekk:` holds whatever the booking mail said, verbatim (`bookings.ts`'s `stay.checkOut`
 * is a free string): The Big Apple recorded a DATE (`2026-08-30`), the fixtures a TIME
 * (`11:00`), a fuller mail records both, a Norwegian one writes `30.08.2026`. Every date found
 * is a check-out day — one line per hotel, so a multi-stay trip.md already yields one entry per
 * stay. A line with no date at all means trip.end, which is the pre-ORB-204 behaviour kept only
 * as the fallback; no line means no check-out post. Dates are stripped before the clock is
 * read so `30.08.2026` can never be mistaken for a time.
 */
export function checkoutSchedule(tripMd: string, tripEnd: string): CheckoutDue[] {
  const out: CheckoutDue[] = [];
  const seen = new Set<string>();
  const add = (dateISO: string, hhmm: string | undefined): void => {
    if (seen.has(dateISO)) return;
    seen.add(dateISO);
    out.push(hhmm ? { dateISO, hhmm } : { dateISO });
  };
  for (const line of tripMd.matchAll(UTSJEKK_LINE)) {
    const dates: string[] = [];
    const rest = line[1]
      .replace(ISO_DATE, (iso) => {
        dates.push(iso);
        return " ";
      })
      .replace(NORWEGIAN_DATE, (_all, dd: string, mm: string, yyyy: string) => {
        dates.push(`${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`);
        return " ";
      });
    const clock = rest.match(CLOCK);
    const hour = clock ? Number(clock[1]) : NaN;
    const hhmm = clock && hour < 24 && Number(clock[2]) < 60 ? `${String(hour).padStart(2, "0")}:${clock[2]}` : undefined;
    if (dates.length === 0) add(tripEnd, hhmm);
    for (const d of dates) add(d, hhmm);
  }
  return out;
}

function sentPath(trip: Trip): string {
  return path.join(trip.dir, SENT_JSON);
}

function loadSent(trip: Trip): Record<string, boolean> {
  const file = sentPath(trip);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, boolean>;
  } catch {
    return {};
  }
}

function saveSent(trip: Trip, sent: Record<string, boolean>): void {
  fs.mkdirSync(trip.dir, { recursive: true });
  fs.writeFileSync(sentPath(trip), JSON.stringify(sent));
}

/** Takes one mark back off the ledger — the ONE case being a message the proactivity gate
 *  DEFERRED (ORB-193 Task 4): nothing was sent and the hold expires, so the item must stay
 *  eligible. Re-read before the delete so a mark another job wrote while this one was running is
 *  never lost. */
function unmark(trip: Trip, key: string): void {
  const sent = loadSent(trip);
  delete sent[key];
  saveSent(trip, sent);
}

// --- flight-state.json (travel-day watcher state + poll self-gate) ----------------

type FlightWatchState = WatchState & { __lastPollAt?: number };

function flightStatePath(trip: Trip): string {
  return path.join(trip.dir, FLIGHT_STATE_JSON);
}

function loadFlightState(trip: Trip): FlightWatchState {
  const file = flightStatePath(trip);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as FlightWatchState;
  } catch {
    return {};
  }
}

function saveFlightState(trip: Trip, state: FlightWatchState): void {
  fs.mkdirSync(trip.dir, { recursive: true });
  fs.writeFileSync(flightStatePath(trip), JSON.stringify(state));
}

// --- bookings.md parsing (reminder jobs) -------------------------------------------

export interface ReminderBooking {
  id: string;
  kind: string;
  startISO: string;
  time: string;
  /** ORB-127/128 — the venue's coordinates when the block carries them. They decide which
   *  clock the reminder runs on (see {@link bookingTimezone}). */
  lat?: number;
  lon?: number;
}

/**
 * ORB-127 — read through `bookingHeaders`, never a second regex.
 *
 * This function used to carry its own copy of the header pattern, written before ORB-105 added
 * ` provider:` and ORB-109 added ` at:`. Both are optional in `lib/booking-header.ts`'s
 * HEADER_RE and neither existed in the copy, which required ` -->` immediately after `time:` —
 * so every block filed WITH coordinates simply did not match, and got no reminder at all. Not a
 * late reminder: none, silently, because from here the booking did not exist. On The Big Apple
 * that was all four New York dinner reservations. The flight and the airport parking have no
 * coordinates and kept working, which is exactly why it stayed invisible for a fortnight.
 *
 * One grammar, one definition — the reason `lib/booking-header.ts` was split out (ORB-113).
 */
function reminderBookings(bookingsMd: string): ReminderBooking[] {
  return bookingHeaders(bookingsMd)
    .filter((h) => h.time !== undefined) // no known time, nothing to remind about
    .map((h) => ({
      id: h.id,
      kind: h.kind,
      startISO: h.start,
      time: h.time!,
      ...(h.lat !== undefined ? { lat: h.lat, lon: h.lon } : {}),
    }));
}

/**
 * ORB-128 — the clock ONE booking's reminder runs on.
 *
 * Booking times are stored as bare wall-clock values and were read as trip-local throughout.
 * That is wrong on exactly the day it matters most. On The Big Apple, 26.8 holds the airport
 * parking at 07:00 and SK455 at 09:00 — both **Oslo** times — and a dinner at 20:00 in **New
 * York**. One date, two clocks. Reading all three as New York put the flight reminder out at
 * 12:00 Oslo, three hours after the plane left.
 *
 * So the clock is per booking, not per day:
 *
 *  - **Coordinates decide it when we have them.** Within {@link ARRIVAL_RADIUS_KM} of the
 *    destination means he is there; anywhere else means he is not. The four New York dinners
 *    resolve to New York, the Gardermoen hotel to Oslo, from data already on disk.
 *  - **Without coordinates, the arrival date decides.** Up to and INCLUDING the arrival date a
 *    located-nowhere booking is home-side — on the travel day the journey starts at home, which
 *    is where the parking and the outbound flight are. After it, he has landed.
 *
 * Known residual, not solved here: a multi-leg return journey leaves the destination and lands
 * at home on the same booking, and a single timezone cannot describe both. The honest fix is to
 * record each booking's own timezone at filing time, which needs a timezone-from-coordinates
 * source this service does not have.
 */
export function bookingTimezone(
  booking: { lat?: number; lon?: number; startISO: string },
  trip: Trip,
  arrivalISO: string,
  homeTz: string,
): string {
  if (booking.lat !== undefined && booking.lon !== undefined) {
    const atDestination = haversineM({ lat: booking.lat, lon: booking.lon }, trip.destination) <= ARRIVAL_RADIUS_KM * 1000;
    return atDestination ? trip.timezone : homeTz;
  }
  return booking.startISO <= arrivalISO ? homeTz : trip.timezone;
}

// T-3h for flights (drive-to-airport buffer), T-1h otherwise. A natural fire time inside quiet
// hours (22:00–08:00) is deferred FORWARD to the next 07:00 at-or-after it (the reminder
// floor) rather than skipped: a night-time slot rolls over to the same morning, an evening
// slot (22:00–23:59) rolls over to the NEXT day's morning — never backward.
export function reminderFireTime(b: ReminderBooking): { dateISO: string; hhmm: string } {
  const offsetHours = b.kind === "flight" ? REMINDER_HOURS_FLIGHT : REMINDER_HOURS_OTHER;
  const natural = msToWallClock(wallClockToMs(b.startISO, b.time) - offsetHours * 3_600_000);
  if (natural.hhmm >= "22:00") return { dateISO: addDaysISO(natural.dateISO, 1), hhmm: QUIET_FLOOR_HHMM };
  if (natural.hhmm < QUIET_FLOOR_HHMM) return { dateISO: natural.dateISO, hhmm: QUIET_FLOOR_HHMM };
  return natural;
}

function readSitat(trip: Trip, dateISOStr: string): string {
  const file = path.join(trip.dir, `sitat-${dateISOStr}.txt`);
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf8").trim();
}

/**
 * One trip's worth of due-job evaluation for one tick. Exported standalone (not a class
 * method) so it is independently unit-testable without constructing a TripScheduler at all —
 * the brief's own Ruling 2 requirement. TripScheduler.tick() below is a thin loop over trips
 * that calls this once per active trip.
 */
/** Everything one tick already knows about a trip's clocks and dates, gathered once by
 *  `TripScheduler.tick` (ORB-128 — this was seven positional parameters and gaining another). */
export interface TickContext {
  readonly chatId: string;
  readonly now: number; // unix seconds
  /** Today on the POSTING clock (`clockTz`). Every sent.json key is built from it. */
  readonly todayISO: string;
  /** The posting clock: home before the derived arrival date, the trip's own from it. */
  readonly clockTz: string;
  readonly arrivalISO: string;
  readonly homeTz: string;
}

export async function tickTrip(deps: TripScheduleDeps, trip: Trip, ctx0: TickContext): Promise<void> {
  const { chatId, now, todayISO, clockTz, arrivalISO, homeTz } = ctx0;
  // ORB-124 — ONE clock per tick, resolved by the caller (`postingTimezone`), never
  // `trip.timezone` directly. `todayISO` is derived from this same clock, and every sent.json
  // key is built from `todayISO`: reading the date off one clock and the time off another is
  // how a job fires twice or not at all.
  const nowHhmm = hhmm(now, clockTz);

  // Check-and-set BEFORE running: a job is marked sent the instant it's decided to be due, so
  // a failed post logs and moves on rather than retrying forever. The ledger is re-read from
  // disk right before each check-and-set (cheap — a tiny JSON file) so a mark written while an
  // earlier slow job was running (e.g. an overlapping tick) is never missed via a stale
  // in-memory copy.
  const markAndRun = async (key: string, run: () => Promise<PostVerdict | void>): Promise<void> => {
    const sent = loadSent(trip);
    if (sent[key]) return;
    sent[key] = true;
    saveSent(trip, sent);
    try {
      // ORB-193 — only a DEFERRAL un-marks. A deferred post is coming back (the hold has a stated
      // end), so it must stay eligible; a SUPPRESSED scheduled post is dropped for good (plan
      // Ruling 3) and keeping its mark is what stops this schedule from re-offering it — and the
      // ledger from taking one suppression row a minute — for the rest of the window.
      // The mark is still written first and only then removed, so the check-and-set above still
      // protects a slow post from a second tick, exactly as before.
      if ((await run()) === "defer") unmark(trip, key);
    } catch (err) {
      // A FAILED post keeps its mark, as it always has: a job that throws must not retry forever.
      console.error(`trip-schedule: job "${key}" failed`, err);
      deps.onJobError?.(trip, key, err);
    }
  };

  // ORB-125 — the 20:00 slot, one post at a time. Everything below the packing/departure pair
  // is gated on the DERIVED arrival date rather than trip.start: before arrival there are
  // exactly two evenings that say anything, and nothing at all on the others.
  //
  // >= catches up a missed 20:00 minute, but never past quiet hours (22:00) — a very late
  // catch-up is worse than no post at all, and tomorrow's dateISO key means today's job simply
  // never fires again once quiet hours start.
  const packingISO = addDaysISO(arrivalISO, -PACKING_DAYS_BEFORE_ARRIVAL);
  const departureISO = addDaysISO(arrivalISO, -DEPARTURE_DAYS_BEFORE_ARRIVAL);
  const preTripCtx = (): Record<string, string> => ({
    arrival: arrivalISO,
    end: trip.end,
    countdownDays: String(daysBetweenISO(todayISO, arrivalISO)),
  });

  if (nowHhmm >= "20:00" && !isQuietForPost(nowHhmm)) {
    if (todayISO === packingISO) {
      await markAndRun(`${todayISO}:packing`, () => deps.post("packing", trip, chatId, preTripCtx(), { dateISO: todayISO }));
    }
    // Not `else if`: a trip whose arrival is two days after the packing date would otherwise
    // silently lose one of the two. They can only collide when arrival - 3 === arrival - 1,
    // which cannot happen — but the independence is the point, not the arithmetic.
    if (todayISO === departureISO) {
      await markAndRun(`${todayISO}:departure`, () => deps.post("departure", trip, chatId, preTripCtx(), { dateISO: todayISO }));
    }

    // evening / finale — mutually exclusive by date: finale replaces evening on end, and
    // neither fires on end+1. Both start at the arrival date: an evening post about "tomorrow"
    // is worth nothing on a day Bendik is still at home, and it is what produced the roughly
    // fourteen pre-trip posts this ticket removes.
    if (todayISO >= arrivalISO && todayISO <= trip.end) {
      if (todayISO === trip.end) {
        await markAndRun(`${todayISO}:finale`, () => deps.post("finale", trip, chatId, {}, { dateISO: todayISO }));
      } else {
        const ctx: Record<string, string> = {};
        const sitat = readSitat(trip, addDaysISO(todayISO, -1));
        if (sitat) ctx.sitat = sitat;
        // ORB-126 — tomorrow's plans, in the confirmation's own words, so the post can say
        // which of them the weather threatens. Read fresh: a Reise-sveip mid-trip files new
        // bookings, and an evening post composed from yesterday's copy would miss them. Empty
        // when tomorrow holds nothing, and the prompt then says nothing about bookings at all.
        const tomorrowISO = addDaysISO(todayISO, 1);
        const rendered = renderDayBookings(bookingsForDate(deps.store.read(trip, BOOKINGS_MD), tomorrowISO));
        if (rendered) {
          ctx.tomorrow = tomorrowISO;
          ctx.tomorrowBookings = rendered;
        }
        await markAndRun(`${todayISO}:evening`, () => deps.post("evening", trip, chatId, ctx, { dateISO: todayISO }));
      }
    }
  }

  // arrival — 17:00 on the day he actually ARRIVES (ORB-125), not on trip.start. "Dere har
  // akkurat ankommet" was addressed to a family sitting at Gardermoen the night before.
  if (nowHhmm >= "17:00" && !isQuietForPost(nowHhmm) && todayISO === arrivalISO) {
    await markAndRun(`${todayISO}:arrival`, () => deps.post("arrival", trip, chatId, {}, { dateISO: todayISO }));
  }

  // checkout — 09:00 on the RECORDED check-out day (ORB-204), read off trip.md's `Utsjekk:`
  // line(s); trip.end only when no date is recorded there. The Big Apple (2026-08-31) fired on
  // trip.end — the flight home — a day after the hotel check-out trip.md had recorded, and at
  // 09:00 New York = 15:00 Oslo, mid-air. The posting clock is the trip's own from the arrival
  // date and a check-out day is never before arrival, so 09:00 here IS the hotel's 09:00.
  // A recorded check-out TIME closes the window: a reminder for a check-out already behind
  // them is the same defect one level down, so a missed tick minute catches up only until then.
  if (nowHhmm >= "09:00" && !isQuietForPost(nowHhmm)) {
    for (const due of checkoutSchedule(deps.store.read(trip, TRIP_MD), trip.end)) {
      if (due.dateISO !== todayISO) continue;
      if (due.hhmm && nowHhmm > due.hhmm) continue;
      const ctx: Record<string, string> = { checkoutDate: due.dateISO };
      if (due.hhmm) ctx.checkoutTime = due.hhmm;
      await markAndRun(`${todayISO}:checkout`, () => deps.post("checkout", trip, chatId, ctx, { dateISO: todayISO }));
    }
  }

  // weatherwarn — 08:30 daily from the arrival date through trip.end (not end+1); the agent
  // turn itself decides whether anything is extreme and sends nothing when not, so this stays
  // weather-agnostic. ORB-125 added the arrival floor: a severe-weather warning for a city
  // Bendik is not in yet is noise, and the packing post already covers the trip-window forecast.
  if (nowHhmm >= "08:30" && !isQuietForPost(nowHhmm) && todayISO >= arrivalISO && todayISO <= trip.end) {
    await markAndRun(`${todayISO}:weatherwarn`, () => deps.post("weatherwarn", trip, chatId, {}, { dateISO: todayISO }));
  }

  // reminders — one per bookings.md entry with a known time. >= so a missed fire minute still
  // catches up — but, like every posting job, never into quiet hours: a daytime reminder whose
  // minute was missed must not surface at 22:30. (reminderFireTime already floors the early-
  // morning side to 07:00 by construction.)
  const bookingsMd = deps.store.read(trip, BOOKINGS_MD);
  for (const booking of reminderBookings(bookingsMd)) {
    // ORB-128 — judged on the booking's OWN clock, not the tick's. The date and the time must
    // come from the same clock or a reminder fires twice or never; `reminderFireTime` is
    // already clock-free (pure wall-clock arithmetic on the stored value), so the ledger key
    // stays stable whatever the tick's own timezone is.
    const bookingTz = bookingTimezone(booking, trip, arrivalISO, homeTz);
    const bookingToday = dateISO(now, bookingTz);
    const bookingHhmm = hhmm(now, bookingTz);
    const fire = reminderFireTime(booking);
    if (fire.dateISO !== bookingToday || bookingHhmm < fire.hhmm || isQuietForPost(bookingHhmm)) continue;
    await markAndRun(`${fire.dateISO}:reminder:${booking.id}`, async () => {
      const ctx: Record<string, string> = {
        bookingId: booking.id,
        kind: booking.kind,
        start: booking.startISO,
        time: booking.time,
      };
      // Live-status enrichment is best-effort: a flights failure must never break the
      // reminder itself — catch locally and simply omit ctx.flightStatus.
      if (booking.kind === "flight" && deps.flights) {
        const ref = extractFlightRefs(bookingsMd).find((r) => r.dateISO === booking.startISO);
        if (ref) {
          const st = await deps.flights.status(ref, { avinorAirport: "OSL", direction: "D" }).catch(() => null);
          if (st) {
            ctx.flightStatus = `${st.flightNo}: ${st.statusText ?? "i rute"}${st.estimated ? `, ny tid ${st.estimated}` : `, avgang ${st.scheduled}`}${st.gate ? `, gate ${st.gate}` : ", gate publiseres nærmere avgang"}`;
          }
        }
      }
      return deps.post("reminder", trip, chatId, ctx, { dateISO: fire.dateISO, itemId: booking.id });
    });
  }

  // flight watch — travel-day polling for gate/delay/cancellation changes, independent of the
  // once-daily reminder above (see watchFlights for the T-6h window + 5-min gate).
  await watchFlights(deps, trip, chatId, now, arrivalISO, homeTz);
}

// Polls live flight status for today's flight bookings, inside a T-6h..T+1h window around each
// flight's departure, at most once per FLIGHT_POLL_MINUTES per trip (a single __lastPollAt
// gate covers every ref, not one per flight — deliberately coarse). Not run through
// markAndRun/sent.json: flightwatch has its own idempotent ledger (flight-state.json, keyed by
// flightNo:dateISO via diffFlightState) since a trip can have several flights the same day and
// each needs independent repeated polling.
async function watchFlights(
  deps: TripScheduleDeps,
  trip: Trip,
  chatId: string,
  now: number,
  arrivalISO: string,
  homeTz: string,
): Promise<void> {
  const flights = deps.flights;
  if (!flights) return;
  const bookingsMd = deps.store.read(trip, BOOKINGS_MD);

  // ORB-128 — a flight's departure time is local to where it DEPARTS, and each ref is judged on
  // its own clock. SK455 leaves Oslo at 09:00 Oslo time on the arrival date; read on the New
  // York clock, the T-6h watch window opened at the moment the aircraft was already leaving.
  // Flight refs carry no coordinates, so they take bookingTimezone's date rule.
  const withClock = extractFlightRefs(bookingsMd)
    .filter((r) => r.time)
    .map((r) => ({ ref: r, tz: bookingTimezone({ startISO: r.dateISO }, trip, arrivalISO, homeTz) }))
    .filter(({ ref, tz }) => ref.dateISO === dateISO(now, tz));
  if (withClock.length === 0) return;

  const state = loadFlightState(trip);
  if (state.__lastPollAt && now - state.__lastPollAt < FLIGHT_POLL_MINUTES * 60) return;

  for (const { ref, tz } of withClock) {
    const nowHhmm = hhmm(now, tz);
    const departMs = wallClockToMs(ref.dateISO, ref.time!);
    const nowWallMs = wallClockToMs(dateISO(now, tz), nowHhmm);
    if (nowWallMs < departMs - FLIGHT_WATCH_BEFORE_HOURS * 3_600_000) continue; // before the watch window
    if (nowWallMs > departMs + 3_600_000) continue; // more than 1h past departure — done watching
    try {
      // Departure side: ask Avinor when departing Norway (OSL assumed — the adapter falls
      // back to AeroDataBox automatically when Avinor lacks the flight).
      const st = await flights.status(ref, { avinorAirport: "OSL", direction: "D" });
      if (!st) continue;
      const quiet = nowHhmm >= QUIET_START_HHMM || nowHhmm < QUIET_FLOOR_HHMM;
      const { messages, next } = diffFlightState(state, st, { quiet });
      Object.assign(state, next);
      if (messages.length > 0) {
        const flightRef = `${st.flightNo}:${st.dateISO}`;
        const entry = state[flightRef]!;
        // ORB-193 Task 4 — what the proactivity ledger keys this card by. The fingerprint is the
        // material state; a batch of several delta lines carries its ordinal too, so two lines
        // about the same state are two items and not one already-seen pair.
        const fingerprint = flightStateFingerprint(entry);
        const card = (opts: { ordinal?: number; cancelled?: boolean } = {}): FlightCard => ({
          slug: trip.slug,
          flightRef,
          fingerprint: opts.ordinal === undefined ? fingerprint : `${fingerprint}#${opts.ordinal}`,
          ...(opts.cancelled === true ? { cancelled: true } : {}),
        });
        // A batch of several delta lines carries its ordinal, so two lines about one state are two
        // items rather than an already-seen pair.
        const cardFor = (i: number, cancelled?: boolean): FlightCard =>
          card({ ...(messages.length > 1 ? { ordinal: i } : {}), ...(cancelled === true ? { cancelled: true } : {}) });
        if (st.cancelled) {
          // Cancellation must NOTIFY — a silent edit of an old message would bury it, and the card
          // is flagged `cancelled` so the gate treats it as quiet-hours exempt (see rawSend).
          for (const [i, msg] of messages.entries()) await deps.postFlightMessage(chatId, msg, cardFor(i, true));
          delete entry.messageId; // any later revival starts a fresh card
        } else if (deps.postFlightMessageWithId && deps.editFlightMessage) {
          const text = renderFlightStatus(st, nowHhmm, { connectionBufferMinutes: deps.connectionBufferMinutes });
          const edited = entry.messageId !== undefined && (await deps.editFlightMessage(chatId, entry.messageId, text));
          if (!edited) {
            // `undefined` = the gate held the card back. Recording no id is the point: a message
            // that was never sent must not be edited later, and the next material change posts a
            // fresh, current card rather than patching a phantom.
            //
            // KNOWN, ACCEPTED COLLISION on exactly this path: with no message id, a state that
            // goes A → B → A offers the ledger the SAME item key it already has a `sent` row for,
            // so the return to A is suppressed as already-seen and no card is posted. It needs a
            // card that was never posted (or was held back) plus a flip back to a previous state
            // within one owner day — a gate assigned, moved, and moved back. The alternative is
            // worse: a key that carried the poll's own timestamp would make every five-minute poll
            // a new item and switch the dedupe off altogether.
            const id = await deps.postFlightMessageWithId(chatId, text, card());
            if (id !== undefined) entry.messageId = id;
          }
        } else {
          for (const [i, msg] of messages.entries()) await deps.postFlightMessage(chatId, msg, cardFor(i));
        }
      }
    } catch (err) {
      deps.onJobError?.(trip, `flightwatch:${ref.flightNo}`, err);
    }
  }
  state.__lastPollAt = now;
  saveFlightState(trip, state);
}

/**
 * ORB-123 — a trip with no linked chat is skipped, and said so out loud.
 *
 * There is no chat to post into, and — the reason this is worth a log line rather than a silent
 * `continue` — a post composed without a chat runs blind: every trip-aware tool resolves its
 * trip from the chat id on the turn's auth, so the model would improvise an explanation for its
 * own blindness. That improvised message is exactly the 2026-08-19 incident this ticket closes.
 *
 * Once per trip per local day, not once per minute: the schedule ticks every 60s, and a trip
 * sitting unlinked through its whole window would otherwise write ~1440 identical lines a day.
 * Module scope, not instance scope, because `agent/schedules/trip-lifecycle.ts` builds a FRESH
 * `TripScheduler` on every tick.
 */
const chatlessSkipLogged = new Set<string>();

function logChatlessSkip(trip: Trip, todayISO: string): void {
  const key = `${trip.slug}:${todayISO}`;
  if (chatlessSkipLogged.has(key)) return;
  chatlessSkipLogged.add(key);
  console.warn(
    `trip-schedule: trip "${trip.slug}" is inside its posting window but has no linked chat — ` +
      "skipping every post for it (link a group with /link before it can post).",
  );
}

/** The tick owner: kill-switch check, per-trip window filtering, and the in-flight/overlap
 *  guard. Mirrors old Marcel's own split between schedule.ts's pure logic and bin/marcel.ts's
 *  tick owner (setInterval calling scheduler.tick() every 60s). */
export class TripScheduler {
  private deps: TripScheduleDeps;
  private running = false;

  constructor(deps: TripScheduleDeps) {
    this.deps = deps;
  }

  async tick(): Promise<void> {
    // In-flight guard: with >= matching, an overlapping tick (an LLM-backed job can take
    // >60s) would race the still-running one and double-post — serialize instead. The skipped
    // minute's jobs simply catch up on the next tick, which is the whole point of >= matching.
    if (this.running) return;
    this.running = true;
    try {
      // Kill switch silences the whole scheduler: return before touching sent.json at all, so
      // re-enabling later never has to reconcile stale marks. This does mean a job whose due
      // minute passed while Marcel was "av" can fire late (>= matching, see above) once
      // re-enabled the same day — intentional: the evening post should still arrive.
      if (this.deps.store.config().killSwitch) return;
      const now = this.deps.now();
      const homeTz = this.deps.store.homeTimezone();
      for (const trip of this.deps.store.trips()) {
        // ORB-124 — the arrival date is derived from the trip's own bookings, and the clock
        // follows from it. Both are recomputed every tick: bookings.md changes under a running
        // box (Reise-sveip files new ones mid-trip), and a derived arrival date must follow.
        const arrivalISO = arrivalDateISO(trip, this.deps.store.read(trip, BOOKINGS_MD));
        const clockTz = postingTimezone(trip, arrivalISO, homeTz, now);
        const todayISO = dateISO(now, clockTz);
        // ORB-125 deliberately did NOT narrow this window, even though it is what the old
        // fourteen pre-trip posts came out of. The window decides whether a trip is EVALUATED;
        // the gates in tickTrip decide what actually fires, and they now start at arrival - 3.
        // Narrowing here as well would have taken the reminders with it — a booking four days
        // before arrival would lose its reminder — and reminders were explicitly to be left
        // alone. Evaluating a trip costs one small file read a minute; a missed reminder costs
        // a flight.
        const windowStart = addDaysISO(trip.start, -7);
        // Window runs one day PAST trip.end: a reminder deferred past midnight on the final
        // evening still needs to fire at 07:00 on end+1.
        const windowEnd = addDaysISO(trip.end, 1);
        if (todayISO < windowStart || todayISO > windowEnd) continue;
        // Chat check AFTER the window filter (ORB-123): a trip nowhere near its posting window
        // is not worth a word, and the log line below is about a trip that would otherwise be
        // posting right now.
        if (trip.chatId === undefined) {
          logChatlessSkip(trip, todayISO);
          continue;
        }
        await tickTrip(this.deps, trip, { chatId: trip.chatId, now, todayISO, clockTz, arrivalISO, homeTz });
      }
    } finally {
      this.running = false;
    }
  }
}
