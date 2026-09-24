/**
 * agent/schedules/taste-promote.ts — Marcel's end-of-trip taste-lift tick (Task 8). Thin eve
 * wrapper around lib/dream.ts's Dreamer.promoteTaste + PromoteScheduler: every minute, for each
 * trip whose window (start-7..end+1) includes today and which is linked to a chat, fires the
 * "promote" job at 03:00 on trip.end+1 ONLY — after that day's 02:00 dream tick (agent/
 * schedules/dream.ts) has folded the trip's final day into learned.md — and AT MOST ONCE ever
 * for that trip, never mid-trip and never twice.
 *
 * THE GUARD: lib/dream.ts's sent.json ledger (key `${date}:promote`, marked BEFORE the job
 * runs, re-read from disk on every check — see lib/dream.ts's own header comment). Without it,
 * a naive "todayISO === trip.end+1" date check alone would re-run Dreamer.promoteTaste() — which
 * APPENDS to taste/preferences.md — on every one of the ~1440 ticks this schedule's own
 * `cron: "* * * * *"` fires throughout that whole day, duplicating the append 1440 times instead
 * of once. tests/dream.test.ts's "THE double-append guard" and "PromoteScheduler driving the
 * real Dreamer.promoteTaste" cases exercise exactly this: many same-day ticks, asserting exactly
 * one append.
 *
 * INTERNAL ONLY: like dream.ts, this never sends to Telegram — nothing here imports a channel or
 * calls `to(...)`.
 */
import { generateText } from "ai";
import { defineSchedule } from "eve/schedules";

import { getPool } from "@lares/agent-kit/db";
import { scheduleEnabled } from "@lares/agent-kit/schedule-switch";
import { recordSchedulePass } from "@lares/agent-kit/schedule-heartbeat";
import { thisAgent } from "../../lib/definition.js";
import { TripStore } from "../../lib/trip-store.js";
import { Dreamer, PromoteScheduler } from "../../lib/dream.js";
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
  if (!id) throw new Error("taste-promote: MARCEL_MODEL_BRAIN is not set");
  return id;
}

/** Same shape as dream.ts's own `distill` — `generateText` with a plain prompt, no system, no
 *  temperature override, `maxOutputTokens: 1500`, matching old Marcel's `makeDistill`. */
async function distill(prompt: string): Promise<string> {
  const result = await generateText({ model: gatewayModel(brainModelId()), prompt, maxOutputTokens: 1500 });
  return result.text;
}

let running = false;

/** LAR-44 (ORB-175) — the row input-freshness.sh reads; pinned to this filename by the
 *  conformance test. Every-minute polling schedule: no separate `/tick` row, the pass IS the
 *  tick. A day with no trip at `end+1` completes the tick having promoted nothing — a decision,
 *  so it stamps under the ORB-175 rule; a config throw (e.g. `MARCEL_MODEL_BRAIN` unset, reached
 *  only on the rare day a promote job actually fires) propagates to the `catch` below instead,
 *  so it does not. */
export const HEARTBEAT_KEY = "marcel/taste-promote";

export default defineSchedule({
  cron: "* * * * *",
  async run() {
    const { loaded } = await thisAgent(undefined);
    if (!scheduleEnabled(loaded.definition, "taste-promote")) return;
    if (running) return;
    running = true;
    try {
      const store = new TripStore(dataRoot());
      const dreamer = new Dreamer({ distill, store });
      const scheduler = new PromoteScheduler({
        store,
        now: () => Math.floor(Date.now() / 1000),
        // Wave 4 (W4C-s9): dreamer.promoteTaste() itself refuses now (one console.warn, no
        // model call, no append) until this role meets ADR-0018 — the gate above and the pass
        // stamp below are unchanged so the heartbeat still ticks for a schedule that is
        // deliberately quiet.
        promote: (trip) => dreamer.promoteTaste(trip),
        onJobError: (trip, key, err) => {
          console.error(`taste-promote: job "${key}" failed for trip ${trip.slug}`, err);
        },
      });
      await scheduler.tick();
      await recordSchedulePass(getPool(), HEARTBEAT_KEY);
    } catch (err) {
      console.error("[taste-promote] tick failed:", err);
    } finally {
      running = false;
    }
  },
});
