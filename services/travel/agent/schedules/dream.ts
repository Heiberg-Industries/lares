/**
 * agent/schedules/dream.ts — Marcel's nightly learning tick (Task 8). Thin eve wrapper around
 * lib/dream.ts's Dreamer.nightly + DreamScheduler: every minute, for each trip whose window
 * (start-7..end+1) includes today and which is linked to a chat, fires the ≥02:00 "dream" job
 * at most once/day — lib/dream.ts's own sent.json ledger, keyed `${date}:dream`, a different
 * namespace from agent/schedules/trip-lifecycle.ts's lifecycle-post keys, so the two schedules
 * (both ticking every minute against the same trip dir) share sent.json safely.
 *
 * INTERNAL ONLY: this never sends to Telegram, faithful to old Marcel's own dream job
 * (services/marcel/lib/schedule.ts's own doc comment: "dream" and "promote" "aren't posts at
 * all"). Nothing in this file imports a channel or calls `to(...)`.
 *
 * `dayLogFor` reads the target date's group-chat transcript via `lib/conversation-log.ts`'s
 * `ConversationLog.day(dateISO)` — JSONL files under `<trip.dir>/chatlog/`, written on every
 * inbound group message by `agent/channels/telegram.ts`'s `onMessage` (Task 8b closed this
 * cross-task gap: the wave plan's inventory had listed `lib/conversation-log.ts` as Task 3's
 * job, but Task 3's own dispatched brief never included it, so both this file and telegram.ts
 * carried a documented placeholder until now). The "Name: text" join below matches old Marcel's
 * own `makeDream` exactly (`services/marcel/bin/marcel.ts:932-940`) — a full day's entries,
 * unlike `transcriptFor`'s windowed `ConversationLog.transcript(n)`. An empty day (no linked
 * chat, or no messages logged yet) still renders safely: `nightlyPrompt` shows "(ingen samtale
 * i dag)" for an empty `dayLog`, and `Dreamer.nightly`'s own guard never wipes non-empty
 * learned.md on an empty/malformed model reply.
 */
import { generateText } from "ai";
import { defineSchedule } from "eve/schedules";
import path from "node:path";

import { getPool } from "@lares/agent-kit/db";
import { scheduleEnabled } from "@lares/agent-kit/schedule-switch";
import { recordSchedulePass, recordScheduleTick } from "@lares/agent-kit/schedule-heartbeat";
import { thisAgent } from "../../lib/definition.js";
import { TripStore, type Trip } from "../../lib/trip-store.js";
import { Dreamer, DreamScheduler } from "../../lib/dream.js";
import { ConversationLog } from "../../lib/conversation-log.js";
import { gatewayModel } from "../../lib/gateway-provider.js";

/** `MARCEL_DATA_ROOT` points at the real `/srv/eve-marcel` bind mount in production
 *  (`services/box/compose.yaml`'s `eve-marcel:` block, review fix finding 1) — same as
 *  every other file's own `dataRoot()`. Re-declared locally, matching every other file's own
 *  lazy per-call read. */
function dataRoot(): string {
  return process.env["MARCEL_DATA_ROOT"] ?? "/data/marcel";
}

function brainModelId(): string {
  const id = process.env["MARCEL_MODEL_BRAIN"];
  if (!id) throw new Error("dream: MARCEL_MODEL_BRAIN is not set");
  return id;
}

/** The target date's group-chat transcript, "Name: text" per line — see this file's top-of-file
 *  doc comment. Ported verbatim from old Marcel's `makeDream` (`bin/marcel.ts:932-940`), against
 *  `lib/trip-store.ts`'s `Trip.dir` instead of old Marcel's own `trip.dir`. */
export async function dayLogFor(trip: Trip, dateISO: string): Promise<string> {
  return new ConversationLog(path.join(trip.dir, "chatlog"), trip.timezone)
    .day(dateISO)
    .map((e) => `${e.marcel ? "Marcel" : e.name}: ${e.text}`)
    .join("\n");
}

/** Raw model call for Dreamer's `distill` dependency — `generateText` with a plain prompt (no
 *  system, no temperature override), `maxOutputTokens: 1500`, matching old Marcel's own
 *  `makeDistill` exactly (services/marcel/bin/marcel.ts:883-888). */
async function distill(prompt: string): Promise<string> {
  const result = await generateText({ model: gatewayModel(brainModelId()), prompt, maxOutputTokens: 1500 });
  return result.text;
}

let running = false;

/** LAR-44 (ORB-175) — the row input-freshness.sh reads; pinned to this filename by the
 *  conformance test. Same shape as Saga's own `dream` schedule: a daily slot underneath a
 *  per-minute tick, so both a `/tick` row (every minute, after the gate) and a pass row (after
 *  the cycle) are stamped. */
export const HEARTBEAT_KEY = "marcel/dream";

export default defineSchedule({
  cron: "* * * * *",
  async run() {
    const { loaded } = await thisAgent(undefined);
    if (!scheduleEnabled(loaded.definition, "dream")) return;
    await recordScheduleTick(getPool(), HEARTBEAT_KEY);
    if (running) return;
    running = true;
    try {
      const store = new TripStore(dataRoot());
      const dreamer = new Dreamer({ distill, store });
      const scheduler = new DreamScheduler({
        store,
        now: () => Math.floor(Date.now() / 1000),
        // Wave 4 (W4C-s9): dreamer.nightly() itself refuses now (one console.warn, no model
        // call, no write) until this role meets ADR-0018 — the gate above and the tick/pass
        // stamps below are unchanged so the heartbeat still ticks for a schedule that is
        // deliberately quiet.
        dream: async (trip, dateISO) => {
          const dayLog = await dayLogFor(trip, dateISO);
          await dreamer.nightly(trip, dayLog, dateISO);
        },
        onJobError: (trip, key, err) => {
          console.error(`dream: job "${key}" failed for trip ${trip.slug}`, err);
        },
      });
      await scheduler.tick();
      await recordSchedulePass(getPool(), HEARTBEAT_KEY);
    } catch (err) {
      console.error("[dream] tick failed:", err);
    } finally {
      running = false;
    }
  },
});
