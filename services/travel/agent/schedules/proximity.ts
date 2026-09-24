/**
 * agent/schedules/proximity.ts — the geofence tick (ORB-101).
 *
 * Every minute, IF the admin's shared position is still current, compare it against the saved
 * places that have coordinates and ping once per place per local day. All the deciding lives in
 * `lib/geofence.ts` (pure, fully tested); this file is the wiring: read position, read store,
 * resolve the trip's timezone, send, record.
 *
 * ACTIVE ONLY WHILE A POSITION IS FRESH. With no live share the tick reads one small file, finds
 * nothing, and returns — cheap enough to run every minute all year.
 *
 * The ledger of what has already been said lives beside the position, under the trip data root, so
 * a deploy mid-walk cannot turn one ping into a second one. It is pruned to today's keys on write,
 * which is all the housekeeping a per-day ledger needs.
 *
 * GATED like every other schedule here (`scheduleEnabled()`: this agent's own definition entry,
 * ANDed with the box-level `EVE_SCHEDULES_LIVE`): shipped dark, flipped on deliberately.
 *
 * INTERNAL SEND: this posts to the admin DM through the raw Telegram primitive, never an agent
 * turn — the text is deterministic and composed here, exactly the "verbatim delivery, not an agent
 * turn" rule the sweep report follows.
 *
 * PROACTIVE LANE (ORB-193 Task 4). An unsolicited "you are walking past Katz's" is the definition of
 * an initiation, so it passes `@lares/agent-kit/proactivity`'s gate as an `event` — it counts
 * against the per-door attention ceiling alongside every other thing that rings Bendik's phone.
 * ORDER MATTERS: this file's own three rules (local quiet hours in `decideGeofence`, the 20-minute
 * cooldown, the daily cap) run FIRST and stay the stricter ones; the gate then adds DND, the owner
 * clock's quiet hours and the ceilings. When the gate holds a ping back, the local ledger is NOT
 * written — the cooldown and the daily cap are budgets for messages that actually arrived, and
 * spending one on a message nobody received would silence the next real ping too.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { defineSchedule } from "eve/schedules";

import { getPool } from "@lares/agent-kit/db";
import { scheduleEnabled } from "@lares/agent-kit/schedule-switch";
import { recordSchedulePass } from "@lares/agent-kit/schedule-heartbeat";
import { thisAgent } from "../../lib/definition.js";
import { TripStore, type Trip } from "../../lib/trip-store.js";
import { TasteStore } from "../../lib/taste-store.js";
import { currentPosition, type Position } from "../../lib/position.js";
import {
  bookedVenueCandidates,
  nearestCandidate,
  composeProximityMessage,
  decideGeofence,
  dedupeCandidates,
  geofenceCandidates,
} from "../../lib/geofence.js";
import { bookingHeaders } from "../../lib/booking-header.js";
import { adminChatId, tgSend } from "../../lib/sveip-run.js";
import { initiate, type InitiationVerdict } from "../../lib/initiation.js";
import { doorId } from "../../lib/principals.js";

const LEDGER_FILE = "proximity-alerts.json";
/** No trip linked/active — same fleet-wide fallback every other file here uses. */
const FALLBACK_TZ = "Europe/Oslo";

function dataRoot(): string {
  return process.env["MARCEL_DATA_ROOT"] ?? "/data/marcel";
}

function ledgerPath(root: string): string {
  return path.join(root, LEDGER_FILE);
}

/** What the ledger remembers between ticks: which places have been named today, and — since the
 *  cooldown — when the last ping actually went out and how many have. */
export interface LedgerState {
  readonly keys: string[];
  readonly lastSentSec?: number;
  readonly sentToday: number;
}

/**
 * Reads the ledger, tolerating the shape it used to have.
 *
 * Before the cooldown this file was a bare `string[]`. A running box has one of those on disk, and
 * an upgrade that threw it away would forget what had already been said today and re-ping every
 * place on the next tick — the exact spam the cooldown exists to stop, caused by the fix for it.
 */
export function readLedgerState(root: string): LedgerState {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(ledgerPath(root), "utf8"));
    if (Array.isArray(parsed)) {
      return { keys: parsed.filter((k): k is string => typeof k === "string"), sentToday: 0 };
    }
    if (parsed && typeof parsed === "object") {
      const o = parsed as Record<string, unknown>;
      return {
        keys: Array.isArray(o["keys"]) ? o["keys"].filter((k): k is string => typeof k === "string") : [],
        ...(typeof o["lastSentSec"] === "number" ? { lastSentSec: o["lastSentSec"] } : {}),
        sentToday: typeof o["sentToday"] === "number" ? o["sentToday"] : 0,
      };
    }
    return { keys: [], sentToday: 0 };
  } catch {
    return { keys: [], sentToday: 0 };
  }
}

/** The keys alone — what the decision needs, and what the older tests assert on. */
export function readLedger(root: string): string[] {
  return readLedgerState(root).keys;
}

/**
 * Records a ping: today's keys, the moment it went out, and one more against the daily cap.
 *
 * Everything from an earlier day is dropped, `sentToday` included — the ledger only ever needs to
 * answer "already told him about this, today" and "how much have I said today". The day rolls over
 * by the keys' own prefix rather than by a clock, so a tick just after midnight in the trip's
 * timezone starts a fresh budget without anything having to reset it.
 */
export function writeLedger(root: string, keys: readonly string[], dayISO: string, sentAtSec?: number): void {
  try {
    const prior = readLedgerState(root);
    const carriedOver = prior.keys.some((k) => k.startsWith(`${dayISO}:`));
    const kept = new Set([...prior.keys, ...keys].filter((k) => k.startsWith(`${dayISO}:`)));
    const state: LedgerState = {
      keys: [...kept],
      ...(sentAtSec === undefined ? {} : { lastSentSec: sentAtSec }),
      sentToday: (carriedOver ? prior.sentToday : 0) + (sentAtSec === undefined ? 0 : 1),
    };
    fs.mkdirSync(root, { recursive: true });
    const tmp = `${ledgerPath(root)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, ledgerPath(root));
  } catch (err) {
    console.error("eve-marcel: could not write the proximity ledger —", err);
  }
}

/** Local date + hour in a given timezone — the trip's, so quiet hours mean local quiet hours. */
export function localDayAndHour(tz: string, nowMs: number): { dayISO: string; hour: number } {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(new Date(nowMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { dayISO: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

/** The timezone to judge quiet hours in: the trip whose window contains today, else Oslo. */
export function timezoneForNow(trips: readonly Trip[], nowMs: number): string {
  const todayOslo = localDayAndHour(FALLBACK_TZ, nowMs).dayISO;
  return trips.find((t) => t.start <= todayOslo && todayOslo <= t.end)?.timezone ?? FALLBACK_TZ;
}

/** What one ping is, for the proactivity ledger: `proximity/<tripSlug>/<place>/<localDay>`
 *  (ORB-193 Task 4). The place is the ping's PRIMARY (nearest) hit — a batch of two or three places
 *  is one message and therefore one initiation, and the local ledger already guarantees a place is
 *  named at most once per local day, so the primary is a stable key rather than a lossy one. The day
 *  is the trip's own local day, which is the owner clock's day whenever there is a trip at all. */
export function proximityItemKey(tripSlug: string, placeName: string, dayISO: string): string {
  return `proximity/${tripSlug}/${placeName.trim().toLowerCase().replace(/\s+/g, "-")}/${dayISO}`;
}

export interface ProximityDeps {
  root(): string;
  position(root: string, nowSec: number): Position | null;
  places(): ReturnType<TasteStore["places"]>;
  trips(): Trip[];
  /** Delivers one ping. Returns the proactivity gate's verdict (ORB-193 Task 4): anything but
   *  `"send"` means nothing was delivered, and the caller then leaves the local ledger alone so the
   *  cooldown, the daily cap and the once-per-place-per-day key are all untouched. `void` is the
   *  pre-gate contract: delivered. */
  send(text: string, item: { itemKey: string }): Promise<InitiationVerdict | void>;
  now(): number;
  /** ORB-109 — the raw `bookings.md` of a trip, so booked venues carrying `at:` coordinates can
   *  be geofenced alongside saved places. Injected like everything else here so the test needs
   *  no filesystem. A read failure yields "" and simply contributes no candidates. */
  bookings?(trip: Trip): string;
}

export const defaultProximityDeps: ProximityDeps = {
  root: dataRoot,
  position: currentPosition,
  places: () => new TasteStore().places(),
  trips: () => {
    try {
      return new TripStore(dataRoot()).trips();
    } catch {
      // config.json not seeded yet — no trips, and certainly no reason to crash a tick.
      return [];
    }
  },
  send: async (text, item) => {
    const chatId = adminChatId();
    return initiate(
      "proximity",
      { cls: "event", door: doorId("telegram", chatId), itemKey: item.itemKey },
      async () => {
        await tgSend(chatId, text);
      },
    );
  },
  now: () => Date.now(),
  bookings: (trip) => {
    try {
      return new TripStore(dataRoot()).read(trip, "bookings.md");
    } catch {
      // No trip dir yet, or an unreadable file — no booked candidates, never a failed tick.
      return "";
    }
  },
};

/** One tick, injectable end to end so the test needs no clock, no fs and no Telegram. */
export async function proximityTick(deps: ProximityDeps): Promise<"sent" | "nothing"> {
  const root = deps.root();
  const nowMs = deps.now();
  const position = deps.position(root, Math.floor(nowMs / 1000));
  if (!position) return "nothing";

  const trips = deps.trips();
  const tz = timezoneForNow(trips, nowMs);
  const { dayISO, hour } = localDayAndHour(tz, nowMs);

  // ORB-109: saved places AND the active trip's booked venues. Only trips whose window contains
  // today contribute — a restaurant booked for next year's trip is not something to be pinged
  // about while walking past it this afternoon.
  const todayOslo = localDayAndHour(FALLBACK_TZ, nowMs).dayISO;
  const booked = deps.bookings
    ? trips
        .filter((t) => t.start <= todayOslo && todayOslo <= t.end)
        .flatMap((t) => bookedVenueCandidates(bookingHeaders(deps.bookings!(t))))
    : [];

  const candidates = dedupeCandidates([...geofenceCandidates(deps.places()), ...booked]);
  const ledger = readLedgerState(root);
  const nowSec = Math.floor(nowMs / 1000);
  const decision = decideGeofence({
    candidates,
    position,
    dayISO,
    localHour: hour,
    alerted: new Set(ledger.keys),
    nowSec,
    ...(ledger.lastSentSec === undefined ? {} : { lastSentSec: ledger.lastSentSec }),
    sentToday: ledger.sentToday,
  });

  // ONE line per tick, and only while a position is actually fresh — so a live share is visible in
  // `docker logs` and a quiet walk can be told apart from a broken one. Before this, every outcome
  // looked identical from outside: silence.
  //
  // DELIBERATELY NOT THE COORDINATES, and not the nearest place's NAME unless it is about to be
  // sent anyway. This ticket's privacy posture is that the position never leaves the box and never
  // lands in a file beside the taste store; a per-minute log line carrying lat/lon would quietly
  // turn `docker logs` into a durable movement track — worse than `position.json`, which holds one
  // latest value and expires with the share. A bare distance answers every diagnostic question
  // ("nearest 470 m" is working correctly; "0 candidates" is not) and reconstructs nothing. When
  // an alert IS sent, the name is already going to Bendik over Telegram, so naming it here adds
  // no exposure and makes the ping traceable to its cause. The same holds for "already-told": that
  // name went to him earlier today, so repeating it in a log reveals nothing new.
  //
  // The SKIP REASON is the other half of the diagnosis. Distance alone cannot tell "you are 40 m
  // from Hernández and I already said so this morning" apart from "nothing is near you" — the
  // once-per-place-per-day ledger makes a second pass look exactly like a broken feature. The
  // decision already knows which it is; it just was not being said out loud.
  const nearest = nearestCandidate(candidates, position);
  const namable = decision.alerts.length > 0 || decision.skipped === "already-told";
  console.log(
    `[proximity] position fresh · ${candidates.length} candidates · ` +
      `nearest ${nearest ? `${nearest.distanceM} m${namable ? ` (${nearest.name})` : ""}` : "none"} · ` +
      `${hour}:00 ${tz} · ${decision.alerts.length} to send` +
      (decision.skipped ? ` · skipped: ${decision.skipped}` : ""),
  );

  if (decision.alerts.length === 0) return "nothing";

  // The gate, then the ledger. Both invariants survive the reordering ORB-193 needed:
  //
  //  - a send that THROWS still records the ledger (the `finally`), so a Telegram failure cannot
  //    become a ping loop sixty seconds later — one missed ping beats a loop, as before;
  //  - a ping the GATE held back records nothing, so the place stays eligible and neither the
  //    cooldown nor the daily cap is spent on a message that was never delivered.
  const tripSlug = trips.find((t) => t.start <= todayOslo && todayOslo <= t.end)?.slug ?? "no-trip";
  const itemKey = proximityItemKey(tripSlug, decision.alerts[0]!.name, dayISO);
  let held = false;
  try {
    const verdict = await deps.send(composeProximityMessage(decision.alerts), { itemKey });
    // No log line here: `initiate` inside the send dep already writes the fleet-wide one
    // (`proximity: initiation <verdict> (<reason>) for <itemKey>`), and a second wording is exactly
    // what makes an operator's grep miss the lane that went quiet.
    held = verdict !== undefined && verdict !== "send";
  } finally {
    if (!held) writeLedger(root, decision.keys, dayISO, nowSec);
  }
  return held ? "nothing" : "sent";
}

let running = false;

/** LAR-44 (ORB-175) — the row input-freshness.sh reads; pinned to this filename by the
 *  conformance test. Every-minute polling schedule: no separate `/tick` row, the pass IS the
 *  tick. `proximityTick`'s own "nothing" outcomes (no fresh position, nothing in range) are
 *  decisions under the ORB-175 rule — a quiet tick is still a completed pass — so this stamps
 *  regardless of which of "sent"/"nothing" it returns; only a throw (a config/read/send failure
 *  the `catch` below reports) skips it. */
export const HEARTBEAT_KEY = "marcel/proximity";

export default defineSchedule({
  cron: "* * * * *",
  async run() {
    const { loaded } = await thisAgent(undefined);
    if (!scheduleEnabled(loaded.definition, "proximity")) return;
    if (running) return;
    running = true;
    try {
      await proximityTick(defaultProximityDeps);
      await recordSchedulePass(getPool(), HEARTBEAT_KEY);
    } catch (err) {
      console.error("[proximity] tick failed:", err);
    } finally {
      running = false;
    }
  },
});
