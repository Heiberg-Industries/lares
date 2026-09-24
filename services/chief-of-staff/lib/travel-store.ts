/**
 * lib/travel-store.ts — Saga's READ-ONLY window onto Marcel's trip store (ORB-169).
 *
 * Why this exists: on 2026-08-25 Marcel had already resolved a Scandic Oslo Airport
 * reservation as the night before a Wednesday flight — in his own store, correctly — while
 * Saga, composing the brief about that same night, read the same hotel off the calendar as
 * "you're based there all day". The agent who knew could not tell the agent who was talking.
 * This module is that pipe, and nothing more.
 *
 * FOUR THINGS ARE DELIBERATE, and each one was a decision, not an accident:
 *
 * 1. **It lives here, not in the kit** (Ruling 5). `@lares/agent-kit`'s `notes-store.ts` is a
 *    closed union over FLAT markdown stores (`"brain" | "atlas"`); Marcel's store is a
 *    `config.json` plus per-trip directories. Teaching the brand-neutral kit one agent's data
 *    schema is the wrong direction. What IS reused from the kit is the path-containment
 *    primitive (`resolveInStore`) — there is no second copy of that logic anywhere.
 *
 * 2. **It does not import from `services/travel`.** Separate service, separate build, and
 *    eve-saga's image does not contain Marcel's source. The `Trip`/`MarcelConfig` shape and
 *    the `bookings.md` block grammar are therefore MIRRORED here — and pinned by a contract
 *    test (`tests/travel-store.test.ts`) that reads Marcel's source as text and goes red the
 *    day he renames a field. That test is the whole reason the duplication is safe.
 *
 * 3. **There is no write function.** ORB-169 asks that "a write attempt is a type error, not
 *    a runtime refusal", and that is satisfied by there being nothing to call. The container
 *    mount is `:ro` as well; the two are belt and braces, not one guard twice.
 *
 * 4. **Emptiness is a normal answer here, and Brain's ORB-51 posture is inverted on purpose.**
 *    `notes-store.ts` treats an empty store as an outage, because "Bendik has no notes on
 *    this" is a confident lie. Travel is the opposite: on most days there is no trip, so an
 *    empty result cannot be an error. The distinction that DOES survive is the one that
 *    matters — an unset `TRAVEL_PATH` throws {@link TravelPathNotConfiguredError} (Saga was
 *    never wired to the store at all), while a configured-but-sick store degrades to no trips
 *    AND carries an `unavailable` reason the caller can surface, so "I can't see Marcel's
 *    trips" never gets rendered as "you have no travel". Everything else — drifted JSON, a
 *    vanished trip directory, an unreadable file — logs and yields nothing, because a
 *    trip-store hiccup must never cost Bendik the turn he is in.
 *
 * 5. **The day boundary is Bendik's HOME clock, never the trip's.** Do not "fix" this later.
 *    Marcel picks the current trip on the home clock too — `services/travel/lib/current-trip.ts`
 *    resolves `store.homeTimezone()` (default `Europe/Oslo`) and filters on that day — so
 *    reading a New York trip on New York's clock here would make Saga and Marcel disagree
 *    about which day it is: precisely the agent-disagreement ORB-169 exists to remove. A
 *    trip's own `timezone` is carried through for display and nothing else.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";

import { resolveInStore } from "@lares/agent-kit/notes-store";

/** The env var naming Marcel's data root inside Saga's container. Read PER CALL, never at
 *  module scope — `eve build` evaluates this file with no environment at all. */
const TRAVEL_ENV = "TRAVEL_PATH";

/**
 * The only trip files Saga may read (Ruling 6). Marcel's own `TRIP_FILES` also holds
 * `shopping.md` (a family group list), `learned.md` (family-private observations) and
 * `persona-overlay.md` (a generated voice overlay); beside the trips sit `chatlog/` (the
 * family group chat), `extractions.json` (58 KB of parsed email) and `reise-log.md`.
 *
 * This is an ALLOWLIST and not a denylist for exactly that reason: the store holds far more
 * than ORB-169 describes, and a denylist would have exposed the chat log on day one. A new
 * file appearing in Marcel's store is unreadable here until a human adds it below.
 */
export const READABLE_TRIP_FILES = ["trip.md", "itinerary.md", "bookings.md"] as const;
export type ReadableTripFile = (typeof READABLE_TRIP_FILES)[number];

/** Saga has no travel wiring at all — `TRAVEL_PATH` is unset. Distinct from a configured
 *  store that happens to hold no trip today, which is the ordinary case. */
export class TravelPathNotConfiguredError extends Error {
  constructor() {
    super(`travel is not configured: ${TRAVEL_ENV} is unset`);
    this.name = "TravelPathNotConfiguredError";
  }
}

/** The requested file is not one of {@link READABLE_TRIP_FILES}. Refused identically whether
 *  it is family-private (`learned.md`), a traversal (`../../reise-log.md`) or an absolute
 *  path — the caller learns only that it is not readable. */
export class TravelFileNotAllowedError extends Error {
  constructor(readonly file: string) {
    super(
      `not a readable trip file: ${file} — Saga may read only ${READABLE_TRIP_FILES.join(", ")}`,
    );
    this.name = "TravelFileNotAllowedError";
  }
}

/** The store is readable; no trip has this slug. "Look again", not "you are not allowed". */
export class TravelTripNotFoundError extends Error {
  constructor(readonly slug: string) {
    super(`no trip with slug "${slug}" in Marcel's store`);
    this.name = "TravelTripNotFoundError";
  }
}

/** One trip, as Saga sees it. A flattened, read-only projection of Marcel's `Trip`: his
 *  `dir` (a container path) and `chatId` (a Telegram address) are none of Saga's business,
 *  and `destination` collapses to its name because Saga never needs the coordinates. */
export interface TravelTrip {
  readonly slug: string;
  readonly name: string;
  /** Inclusive ISO date — `trip-store.ts` says so in its own comment. */
  readonly start: string;
  /** Inclusive ISO date. */
  readonly end: string;
  /** The destination's clock, e.g. "America/New_York". Reported, never used to decide which
   *  trip covers today — see {@link currentTrips}. */
  readonly timezone: string;
  readonly destination: string;
}

/** One filed reservation, from `bookings.md`. `summary` is the confirmation's own first body
 *  line, verbatim — Marcel's pipeline composed it from the booking mail, and re-writing it
 *  here is how a wrong detail gets stated confidently. */
export interface TravelBooking {
  readonly kind: string;
  readonly start: string;
  readonly end?: string;
  readonly time?: string;
  readonly provider?: string;
  readonly summary: string;
}

/** A trip plus what Saga is allowed to say about it — where he sleeps, how he moves, and the
 *  two free-text files. Nothing here comes from outside {@link READABLE_TRIP_FILES}. */
export interface TravelItinerary {
  readonly trip: TravelTrip;
  readonly lodging: readonly TravelBooking[];
  readonly transport: readonly TravelBooking[];
  /** `trip.md` — the trip's own notes. Empty when absent, which is normal. */
  readonly notes: string;
  /**
   * Everything filed that is neither a bed nor a leg this reader RECOGNISES.
   *
   * This bucket exists because dropping it silently was a real bug in waiting. Marcel's
   * extractor enum is fixed at flight|stay|car|restaurant|other
   * (`services/travel/lib/bookings.ts`, pinned by the contract test), so a Vy train is
   * filed as `other` — and a brief that showed the Bergen hotel with no movement would be
   * the same "based there all day" failure ORB-169 exists to kill, wearing a train ticket.
   *
   * It is a THIRD bucket rather than a widening of {@link transport} on purpose: a dinner
   * reservation is also `other`, and a caller must be able to tell "this is a leg" from
   * "this is a reservation I could not classify". Say what it is; never present it as a
   * confirmed journey.
   */
  readonly other: readonly TravelBooking[];
  /** `itinerary.md`. EMPTY on the box today and has been since 2026-08-17; the substance
   *  lives in `bookings.md`. An empty string here is a normal read, never a failure. */
  readonly itinerary: string;
  /** ORB-174 #1 — store-relative reasons for any allowlisted file that EXISTED but could not be
   *  read. Absent files never appear here. `currentTravel` folds these into its `unavailable`
   *  channel, so the brief's dropped-source line fires for a corrupt file exactly as it does
   *  for a dead mount — one disclosure path, two failure depths. */
  readonly readFailures?: readonly string[];
}

export interface TravelResult<T> {
  readonly trips: readonly T[];
  /** Present only when the store could not be read. The caller must say so rather than
   *  reporting "no travel" — an outage is not an empty calendar. */
  readonly unavailable?: string;
}

/**
 * How far forward "current travel" reaches by DEFAULT, and it is deliberately not 0.
 *
 * The bug ORB-169 exists to fix is the night before: a `stay start:2026-08-24` belonging to a
 * trip that starts on the 25th. On the 24th that trip covers no day yet, so a today-only
 * window hides the very hotel Bendik is sleeping in — the brief goes green and the ticket
 * reopens. Any caller that wants a strictly-today answer must ask for `horizonDays: 0`
 * explicitly, because that is the surprising choice, not this one.
 */
export const DEFAULT_HORIZON_DAYS = 7;

export interface TravelOptions {
  /** Also include trips that START within this many days after `today`. Defaults to
   *  {@link DEFAULT_HORIZON_DAYS}; pass 0 for "covering today only". */
  readonly horizonDays?: number;
  readonly env?: NodeJS.ProcessEnv;
}

/** Marcel's data root, read from the environment on every call. */
export function travelRoot(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[TRAVEL_ENV]?.trim();
  if (value === undefined || value.length === 0) throw new TravelPathNotConfiguredError();
  return value;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One raw `config.json` entry → a {@link TravelTrip}, or `undefined` if it is not shaped
 *  like a trip. Per-entry rather than all-or-nothing on purpose: one malformed entry must
 *  not hide the five good ones beside it. */
function toTrip(raw: unknown): TravelTrip | undefined {
  if (!isRecord(raw)) return undefined;
  const { slug, name, start, end, timezone, destination } = raw;
  if (typeof slug !== "string" || slug.length === 0) return undefined;
  if (typeof start !== "string" || !ISO_DATE_RE.test(start)) return undefined;
  if (typeof end !== "string" || !ISO_DATE_RE.test(end)) return undefined;
  const place = isRecord(destination) && typeof destination.name === "string" ? destination.name : "";
  return {
    slug,
    name: typeof name === "string" ? name : slug,
    start,
    end,
    timezone: typeof timezone === "string" ? timezone : "",
    destination: place,
  };
}

/**
 * Every trip in Marcel's `config.json`.
 *
 * Throws ONLY {@link TravelPathNotConfiguredError}. Every other failure — a missing or
 * unparseable `config.json`, a `trips` key that is no longer a list, an entry missing its
 * dates — is logged and reported as no trips plus an `unavailable` reason.
 */
export function loadTrips(env: NodeJS.ProcessEnv = process.env): TravelResult<TravelTrip> {
  const root = travelRoot(env);
  const file = join(root, "config.json");

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    // `unavailable` can reach a Slack brief, so it carries no filesystem paths — a container
    // path is metadata about our deployment, not an answer to Bendik's question. The absolute
    // path rides in the LOG, where an operator needs it and nobody else can see it.
    const code = (err as NodeJS.ErrnoException).code;
    const reason =
      code === "ENOENT"
        ? "Marcel's trip store has no config.json — it may not be mounted"
        : code === undefined
          ? "Marcel's config.json is not valid JSON"
          : `Marcel's config.json could not be read (${code})`;
    console.error(`travel-store: ${reason} [${file}]`, err);
    return { trips: [], unavailable: reason };
  }

  const raw = isRecord(parsed) ? parsed.trips : undefined;
  if (!Array.isArray(raw)) {
    const reason = "Marcel's config.json has no trips list — his schema may have changed";
    console.error(`travel-store: ${reason} [${file}]`);
    return { trips: [], unavailable: reason };
  }

  const trips: TravelTrip[] = [];
  let dropped = 0;
  for (const entry of raw) {
    const trip = toTrip(entry);
    if (trip === undefined) dropped += 1;
    else trips.push(trip);
  }
  if (dropped > 0) {
    console.error(
      `travel-store: ${dropped} of ${raw.length} entries in ${file} are not shaped like a trip — ` +
        `Marcel's schema may have changed`,
    );
  }
  return { trips };
}

/**
 * The trips covering `todayISO`, plus any starting within `horizonDays` after it.
 *
 * `todayISO` is the caller's day. The per-turn travel block passes the HOME day
 * (`lib/recurrence.ts`'s `osloDate`); the two briefs pass the day the brief is ABOUT, on the
 * owner's clock (LAR-67), because a brief listing one day's meetings beside another day's hotel
 * is the two-boundaries-in-one-paragraph failure named below. A trip's own `timezone` is carried
 * through for display but is deliberately not used to pick the day: his brief is composed on his
 * clock, and two different day boundaries in one paragraph is how "tonight" stops meaning
 * anything.
 *
 * Both ends of a trip are inclusive, matching Marcel's `activeTrips`.
 *
 * Returns the same `{ trips, unavailable }` envelope as {@link currentTravel} rather than a
 * bare list, and for one reason: a caller reaching for the obviously-named function must not
 * be able to render a broken store as "no travel" simply by destructuring the convenient half.
 */
export function currentTrips(todayISO: string, opts: TravelOptions = {}): TravelResult<TravelTrip> {
  const { trips, unavailable } = loadTrips(opts.env ?? process.env);
  return {
    trips: selectTrips(trips, todayISO, opts.horizonDays),
    ...(unavailable === undefined ? {} : { unavailable }),
  };
}

/** The one window calculation, shared by {@link currentTrips} and {@link currentTravel} so the
 *  two can never disagree about which trips are "current". */
function selectTrips(trips: readonly TravelTrip[], todayISO: string, horizonDays?: number): TravelTrip[] {
  const horizon = addDays(todayISO, Math.max(0, horizonDays ?? DEFAULT_HORIZON_DAYS));
  return trips.filter((t) => t.start <= horizon && todayISO <= t.end);
}

/** `todayISO` shifted by whole days, staying on the ISO date string. UTC arithmetic is
 *  correct here because both ends are date-only — no wall clock is involved. */
function addDays(todayISO: string, days: number): string {
  if (days === 0 || !ISO_DATE_RE.test(todayISO)) return todayISO;
  const at = new Date(`${todayISO}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

// -----------------------------------------------------------------------------------------
// bookings.md
// -----------------------------------------------------------------------------------------

/**
 * The block grammar `bookingBlock()` writes and `services/travel/lib/booking-header.ts`
 * owns. Mirrored, not imported (see this file's header); the contract test pins it against
 * Marcel's own regex source. `provider:` and `at:` are optional because blocks filed before
 * ORB-105/ORB-109 carry neither, and a "-" in any field means "not recorded".
 */
export const BOOKING_BLOCK_RE =
  /<!-- booking id:(\S+) kind:(\S+) start:(\S+) end:(\S+) time:(\S+)(?: provider:(\S+))?(?: at:(\S+))? -->\n([\s\S]*?)<!-- \/booking -->/gu;

/** Where he sleeps. */
export const LODGING_KINDS = new Set(["stay"]);

/**
 * How he moves. Marcel's extractor enum is flight/stay/car/restaurant/other today — pinned by
 * the contract test, which is what makes the extra names below safe rather than wishful: the
 * file-writing path sanitises any string, so `train`/`ferry`/`bus` are ready for the day his
 * enum grows (his extraction prompt already says "ferge"), and the pin is what tells us it
 * did.
 *
 * Until then a Vy booking arrives as `other` and lands in {@link TravelItinerary.other} — NOT
 * dropped, and not silently promoted to a confirmed leg either.
 */
export const TRANSPORT_KINDS = new Set(["flight", "car", "train", "ferry", "bus"]);

function field(value: string | undefined): string | undefined {
  return value === undefined || value === "-" ? undefined : value;
}

function parseBookings(content: string): TravelBooking[] {
  const out: TravelBooking[] = [];
  for (const m of content.matchAll(BOOKING_BLOCK_RE)) {
    const kind = m[2] ?? "";
    const start = m[3] ?? "-";
    if (start === "-") continue; // a booking with no date says nothing about a day
    // The details line is the FIRST body line, by Marcel's own contract (`bookingBlock`
    // keeps it first precisely because every reader on his side depends on that).
    const summary = (m[8] ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0)
      ?.replace(/^-\s*/u, "");
    if (summary === undefined) continue;
    out.push({
      kind,
      start,
      ...(field(m[4]) === undefined ? {} : { end: field(m[4])! }),
      ...(field(m[5]) === undefined ? {} : { time: field(m[5])! }),
      ...(field(m[6]) === undefined ? {} : { provider: field(m[6])! }),
      summary,
    });
  }
  return out;
}

// -----------------------------------------------------------------------------------------
// reading a trip's files
// -----------------------------------------------------------------------------------------

function isReadable(file: string): file is ReadableTripFile {
  return (READABLE_TRIP_FILES as readonly string[]).includes(file);
}

/**
 * The absolute path of one allowlisted file of one trip.
 *
 * TWO independent guards, in this order: the allowlist rejects any name that is not one of
 * the three (so `learned.md`, `chatlog/x.md`, `../../reise-log.md` and `/etc/passwd` all fail
 * identically), and the kit's `resolveInStore` then refuses anything that escapes the root
 * once the slug is joined on — a symlink-aware, traversal-aware check that is not
 * reimplemented here.
 */
function tripFilePath(slug: string, file: string, root: string): string {
  if (!isReadable(file)) throw new TravelFileNotAllowedError(file);
  const abs = resolveInStore(join("trips", slug, file), root);

  // The name check above and the containment check inside `resolveInStore` are each blind to
  // the same thing: a symlink PLANTED INSIDE the store — `trips/x/trip.md → trips/x/learned.md`
  // — passes both, because the name is allowlisted and the target is inside the root. Nothing
  // Marcel runs creates symlinks, so this is not a live hole; it is guarded anyway because
  // this is the privacy boundary, and the whole point of an allowlist is that it holds when
  // the store contains something we did not anticipate.
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return abs; // does not exist — nothing is read, and the caller reports it as empty
  }
  if (!isReadable(basename(real))) throw new TravelFileNotAllowedError(file);
  return abs;
}

export interface TravelFileContent {
  readonly slug: string;
  readonly file: ReadableTripFile;
  readonly content: string;
  readonly lines: number;
  /** ORB-174 — present ONLY when the file exists but could not be read. Absent files return
   *  normally with empty content; a consumer that sees this field must say so rather than
   *  reporting an empty file. Store-relative, never a container path. */
  readonly unavailable?: string;
}

/**
 * One allowlisted file of one trip, verbatim.
 *
 * Throws {@link TravelPathNotConfiguredError} when Saga has no travel wiring,
 * {@link TravelFileNotAllowedError} for anything outside the allowlist, and
 * {@link TravelTripNotFoundError} when no trip has that slug. An allowlisted file that
 * simply is not on disk reads as "" — Marcel creates every trip file empty at `/nytur`, so
 * absent and empty mean the same thing in his store.
 */
export function readTripFile(
  slug: string,
  file: string,
  env: NodeJS.ProcessEnv = process.env,
): TravelFileContent {
  const root = travelRoot(env);
  const abs = tripFilePath(slug, file, root);
  const { trips } = loadTrips(env);
  if (!trips.some((t) => t.slug === slug)) throw new TravelTripNotFoundError(slug);

  // ORB-174 — `travel_read`'s consumer is a live turn: a read failure surfaces as its own
  // words rather than an empty file, the same absent-vs-unreadable line the brief now draws.
  const { text: content, failure } = readFileText(abs, `${slug}/${file}`);
  if (failure !== undefined) {
    return { slug, file: file as ReadableTripFile, content: "", lines: 0, unavailable: failure };
  }
  const parts = content.split("\n");
  const lines = parts.length > 0 && parts[parts.length - 1] === "" ? parts.length - 1 : parts.length;
  return { slug, file: file as ReadableTripFile, content, lines };
}

/** An unreadable file is worth a log line and nothing else: the trip still exists, and the
 *  turn Bendik is in must not die because one markdown file vanished mid-trip. `label` is
 *  store-relative (`<slug>/<file>`) so no container path is written anywhere. */
function readFileText(abs: string, label: string): FileReadResult {
  if (!existsSync(abs)) return { text: "" }; // ABSENT is normal (itinerary.md is empty/absent on the box)
  try {
    return { text: readFileSync(abs, "utf8") };
  } catch (err) {
    // ORB-174 #1 — a read FAILURE must be distinguishable from an absent file, or a trip whose
    // bookings.md is corrupt/truncated/permission-denied renders identically to a trip with no
    // bookings, and the brief says "nothing scheduled" about a store it could not read. The
    // failure string is store-relative (label, never abs): `unavailable` can reach a Slack
    // brief, and a container path is deployment metadata, not an answer to Bendik's question.
    console.error(`travel-store: could not read ${label}`, err);
    const code = (err as NodeJS.ErrnoException).code;
    return { text: "", failure: `${label} could not be read${code ? ` (${code})` : ""}` };
  }
}

/** `readFileText`'s result: absent → `{ text: "" }`; unreadable → empty text PLUS a
 *  store-relative reason that rides `currentTravel`'s existing `unavailable` channel. */
interface FileReadResult {
  readonly text: string;
  readonly failure?: string;
}

/** One trip's readable view: lodging, legs, and the two free-text files. Never throws for
 *  anything but a missing `TRAVEL_PATH`. */
export function tripItinerary(
  trip: TravelTrip,
  env: NodeJS.ProcessEnv = process.env,
): TravelItinerary {
  const root = travelRoot(env);
  const readFailures: string[] = []; // ORB-174 #1 — per-file failures, surfaced not swallowed
  const read = (file: ReadableTripFile): string => {
    // The one path that could still throw INTO A LIVE TURN: a hand-edited `config.json` slug
    // like "../.." makes `tripFilePath` raise out of here, through currentTravel, into the
    // turn. `slugify` on Marcel's side strips that, so it is close to unreachable — but
    // "never throw into a turn" is absolute, and a store this reader does not control is
    // exactly where an absolute rule earns its keep.
    try {
      const r = readFileText(tripFilePath(trip.slug, file, root), `${trip.slug}/${file}`);
      if (r.failure !== undefined) readFailures.push(r.failure);
      return r.text;
    } catch (err) {
      console.error(`travel-store: refusing to read ${file} for trip "${trip.slug}"`, err);
      readFailures.push(`${trip.slug}/${file} could not be read`);
      return "";
    }
  };

  const bookings = parseBookings(read("bookings.md"));
  const lodging = bookings.filter((b) => LODGING_KINDS.has(b.kind));
  const transport = bookings.filter((b) => TRANSPORT_KINDS.has(b.kind));
  return {
    trip,
    lodging,
    transport,
    other: bookings.filter((b) => !LODGING_KINDS.has(b.kind) && !TRANSPORT_KINDS.has(b.kind)),
    notes: read("trip.md"),
    itinerary: read("itinerary.md"),
    ...(readFailures.length > 0 ? { readFailures } : {}),
  };
}

/**
 * THE call the tools, the turn-instruction injector (Task 6) and the brief block (Task 7)
 * all make: today's travel, fully resolved, in one place — so those three can never disagree
 * about what Marcel's store says.
 */
export function currentTravel(
  todayISO: string,
  opts: TravelOptions = {},
): TravelResult<TravelItinerary> {
  const env = opts.env ?? process.env;
  const { trips, unavailable } = loadTrips(env);
  const itineraries = selectTrips(trips, todayISO, opts.horizonDays).map((t) => tripItinerary(t, env));
  // ORB-174 #1 — a per-FILE read failure reaches the same channel a dead store does. One level
  // of disclosure, both depths: the renderers already say "a source dropped" for `unavailable`,
  // so a half-written bookings.md stops rendering as "this trip has nothing scheduled".
  const fileFailures = itineraries.flatMap((it) => it.readFailures ?? []);
  const reasons = [...(unavailable === undefined ? [] : [unavailable]), ...fileFailures];
  return {
    trips: itineraries,
    ...(reasons.length === 0 ? {} : { unavailable: reasons.join("; ") }),
  };
}
