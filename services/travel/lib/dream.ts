// lib/dream.ts — Marcel's nightly learning loop + the two schedules built on it (Task 8).
//
// Part 1 (Dreamer) is ported from services/marcel/lib/dream.ts: every night he re-reads the
// day's chat log against what he already knows and folds durable observations into learned.md;
// he also captures at most one chat-sourced quote per day. At the end of a trip, promoteTaste()
// lifts anything group-independent and durable up into Bendik's cross-trip taste profile
// (taste/preferences.md, which agent/tools/nearby_places.ts — Task 6 — reads for scoring).
//
// `finale()` (old Marcel's week-in-review composer) is deliberately NOT ported here.
// agent/schedules/trip-lifecycle.ts (Task 7) already composes+sends the "finale" lifecycle post
// itself, via its own prompt and the `to(telegram, {...}).send(...)` agent-turn pattern — its
// own doc comment says so explicitly ("old Marcel's memory-backed Dreamer ... finale's prompt
// below is a plain, reasonable instruction, not a literal port of dreamer.finale"). Porting
// Dreamer.finale here too would be dead code: nothing in this wave calls it.
//
// Part 2 (DreamScheduler / PromoteScheduler) is the pure per-trip tick logic deciding when the
// "dream" (nightly merge, ≥02:00) and "promote" (end-of-trip taste lift, once at trip.end+1
// 03:00) jobs are due — ported from services/marcel/lib/schedule.ts's own dream/promote
// handling. lib/trip-schedule.ts (Task 7) explicitly scoped these two jobs OUT of its own
// TripScheduler and deferred them here (see that file's own header comment). Both share the
// same trip's sent.json at-most-once ledger with trip-lifecycle's lifecycle posts, but in a
// disjoint key namespace (`${date}:dream` / `${date}:promote` vs. lifecycle's `:evening` /
// `:finale` / `:arrival` / `:checkout` / `:weatherwarn` / `:reminder:<id>`), so the two
// schedules — which tick independently, every minute, against the same trip dir — never race
// each other's marks. The ledger helpers (loadSent/saveSent) and the check-and-set-before-run
// pattern are duplicated from lib/trip-schedule.ts rather than imported, matching that file's
// own precedent of not exporting its internals.
//
// This is THE guard against the documented "correct-for-one-tick/broken-next-tick" defect
// class for taste-promote specifically: a naive "fire if todayISO === trip.end+1" check with no
// ledger would re-run promoteTaste() — which APPENDS to taste/preferences.md — on every one of
// the ~1440 ticks that land on trip.end+1, duplicating the append all day. markAndRun below
// marks the job sent BEFORE running it and re-reads the ledger from disk on every check (exactly
// mirroring trip-schedule.ts's own markAndRun), so a second tick in the same minute — or the
// 1439 after it — sees the mark and skips.
import fs from "node:fs";
import path from "node:path";
import type { Trip, TripStore } from "./trip-store.js";

// ─── Dreamer ────────────────────────────────────────────────────────────────────────────────

export interface DreamDeps {
  distill(prompt: string): Promise<string>; // model call injected
  store: TripStore;
}

// Wave 4 (W4C-s9): the decision, and its honest size. The brief's preferred option — moving this
// role's dream modules into @lares/agent-kit alongside the chief-of-staff's — is a bigger job
// than it looks (no observation extractor, a per-trip-markdown store instead of a bi-temporal
// table, and a subject that is a group, so almost everything it would learn is third-party by
// construction). So wave 4 switches the write off with this message instead of porting it; the
// port is wave 5C's neighbour.
const LEARNING_OFF_MESSAGE =
  "learning for this role is off: the nightly job rewrites the whole file from a group chat in " +
  "one model call, with no origin and no recurrence rule, which ADR-0018 (docs/decisions/" +
  "0018-learning-and-dreaming.md) does not permit unattended. The safe version shares the " +
  "promotion gate in @lares/agent-kit/learning and is not built yet.";

export class Dreamer {
  private deps: DreamDeps;

  constructor(deps: DreamDeps) {
    this.deps = deps;
  }

  // Wave 4 (W4C-s9): this job is switched off, not ported. It rewrote the whole of learned.md
  // from a group chat in one unattended model call, with no origin and no recurrence rule —
  // ADR-0018 (docs/decisions/0018-learning-and-dreaming.md) does not permit that. The safe
  // version shares the promotion gate in @lares/agent-kit/learning and is not built yet
  // (see the plan's W4C-s9 for the honest size of that port). The schedule that calls this
  // still ticks and stamps its heartbeat as usual — only the write and the model call stop.
  async nightly(_trip: Trip, _dayLog: string, _dateISO: string): Promise<void> {
    console.warn(LEARNING_OFF_MESSAGE);
  }

  // Wave 4 (W4C-s9): same refusal as nightly() above — this appended to taste/preferences.md
  // from a group trip's chat content via a raw fs.appendFileSync, unattended, which is exactly
  // the third-party-content surface ADR-0018 closes.
  async promoteTaste(_trip: Trip): Promise<void> {
    console.warn(LEARNING_OFF_MESSAGE);
  }
}

// ─── scheduling: dream (nightly, daily) + promote (once, trip.end+1) ─────────────────────────

const SENT_JSON = "sent.json";

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

// Check-and-set BEFORE running: a job is marked sent the instant it's decided to be due, so a
// failed run logs and moves on rather than retrying forever. The ledger is re-read from disk
// right before each check-and-set (cheap — a tiny JSON file) so a mark written by an overlapping
// tick (this schedule's own, or the other one sharing the same sent.json) is never missed via a
// stale in-memory copy — see this file's own header comment for why that matters specifically
// for "promote", which appends rather than overwrites.
async function markAndRun(
  trip: Trip,
  key: string,
  run: () => Promise<void>,
  onJobError?: (trip: Trip, key: string, err: unknown) => void,
): Promise<void> {
  const sent = loadSent(trip);
  if (sent[key]) return;
  sent[key] = true;
  saveSent(trip, sent);
  try {
    await run();
  } catch (err) {
    console.error(`dream: job "${key}" failed`, err);
    onJobError?.(trip, key, err);
  }
}

// --- time helpers -----------------------------------------------------------------
// Same sv-SE / en-GB hour12:false trick already used elsewhere in this service
// (lib/trip-schedule.ts, lib/gatekeeper.ts, lib/weather.ts).

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

// ─── shared per-trip windowing (kill switch, chat-linked, start-7..end+1) ─────────────────────

interface TripJobDeps {
  store: TripStore;
  now(): number; // unix seconds
}

// Iterates every trip due for a job this tick: kill-switch off, linked to a chat (an unlinked
// trip has no chat log to learn from and nobody to promote taste for), and today inside the same
// start-7..end+1 window trip-lifecycle.ts uses (the dream job on end+1 is what learns from the
// trip's final day; promote fires on that same end+1 day, after dream has folded it in).
async function forEachTripDue(
  deps: TripJobDeps,
  perTrip: (trip: Trip, now: number, todayISO: string) => Promise<void>,
): Promise<void> {
  if (deps.store.config().killSwitch) return;
  const now = deps.now();
  for (const trip of deps.store.trips()) {
    if (trip.chatId === undefined) continue;
    const todayISO = dateISO(now, trip.timezone);
    const windowStart = addDaysISO(trip.start, -7);
    const windowEnd = addDaysISO(trip.end, 1);
    if (todayISO < windowStart || todayISO > windowEnd) continue;
    await perTrip(trip, now, todayISO);
  }
}

// ─── dream schedule ─────────────────────────────────────────────────────────────────────────

export interface DreamScheduleDeps extends TripJobDeps {
  /** Runs the nightly merge for one trip/date — the daemon wires this to
   *  Dreamer.nightly(trip, dayLog, dateISO), resolving dayLog itself (see
   *  agent/schedules/dream.ts). */
  dream(trip: Trip, dateISO: string): Promise<void>;
  onJobError?(trip: Trip, key: string, err: unknown): void;
}

// One trip's worth of due-job evaluation for the dream tick. Exported standalone so it is
// independently unit-testable without constructing a DreamScheduler.
export async function tickDreamTrip(deps: DreamScheduleDeps, trip: Trip, now: number, todayISO: string): Promise<void> {
  const nowHhmm = hhmm(now, trip.timezone);
  // dream — 02:00, internal only (never posts). >= so a missed 02:00 minute still catches up
  // later; sent.json keeps it once-per-day. Digests YESTERDAY's log, matching old Marcel's own
  // schedule.ts (the dream on trip.end+1 is what learns from the trip's final day).
  if (nowHhmm >= "02:00") {
    const yesterdayISO = addDaysISO(todayISO, -1);
    await markAndRun(trip, `${todayISO}:dream`, () => deps.dream(trip, yesterdayISO), deps.onJobError);
  }
}

export class DreamScheduler {
  private deps: DreamScheduleDeps;
  private running = false;

  constructor(deps: DreamScheduleDeps) {
    this.deps = deps;
  }

  async tick(): Promise<void> {
    // In-flight guard: with >= matching, an overlapping tick (an LLM-backed job can take >60s)
    // would race the still-running one — serialize instead, matching TripScheduler's own guard.
    if (this.running) return;
    this.running = true;
    try {
      await forEachTripDue(this.deps, (trip, now, todayISO) => tickDreamTrip(this.deps, trip, now, todayISO));
    } finally {
      this.running = false;
    }
  }
}

// ─── taste-promote schedule ─────────────────────────────────────────────────────────────────

export interface PromoteScheduleDeps extends TripJobDeps {
  /** Runs end-of-trip taste promotion for one trip — the daemon wires this to
   *  Dreamer.promoteTaste(trip). */
  promote(trip: Trip): Promise<void>;
  onJobError?(trip: Trip, key: string, err: unknown): void;
}

// One trip's worth of due-job evaluation for the promote tick. Exported standalone for the same
// reason as tickDreamTrip.
export async function tickPromoteTrip(deps: PromoteScheduleDeps, trip: Trip, now: number, todayISO: string): Promise<void> {
  const nowHhmm = hhmm(now, trip.timezone);
  // promote — 03:00 on end+1 ONLY (after the final dream has folded the last day into
  // learned.md), never mid-trip. The `sent.json` mark under key `${todayISO}:promote` is what
  // actually prevents a double-append: without it, every one of the ~1440 ticks that land on
  // end+1 after 03:00 would re-run Dreamer.promoteTaste(), which APPENDS to
  // taste/preferences.md — see this file's own header comment and tests/dream.test.ts's
  // "does not double-append across many same-day ticks" case.
  if (nowHhmm >= "03:00" && todayISO === addDaysISO(trip.end, 1)) {
    await markAndRun(trip, `${todayISO}:promote`, () => deps.promote(trip), deps.onJobError);
  }
}

export class PromoteScheduler {
  private deps: PromoteScheduleDeps;
  private running = false;

  constructor(deps: PromoteScheduleDeps) {
    this.deps = deps;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await forEachTripDue(this.deps, (trip, now, todayISO) => tickPromoteTrip(this.deps, trip, now, todayISO));
    } finally {
      this.running = false;
    }
  }
}
