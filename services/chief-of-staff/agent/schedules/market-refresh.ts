/**
 * The nightly market watchlist refresh — ORB-214 item 1. A JOB, never an initiation.
 *
 * `@lares/agent-kit/markets`'s `makeMarketsRefresh(cfg).refresh(opts)` is the one writer in that
 * package: it discovers by Polymarket liquidity, retires long-settled rows, and re-quotes the
 * open ones through the SAME live path a conversation calls. What it deliberately cannot do is
 * post — `RefreshDeps` has no channel, no `send`, no `initiate` (the kit module's own header).
 * This file is the wiring around that job: the switch, the gate, the door. There is no fourth
 * thing, because there is no door — the file imports NEITHER `../channels/*` NOR
 * `eve/channels/*` NOR `../../lib/initiation.js`, and that is a property of the code, not a
 * promise about it: this schedule has nothing to say and nothing it could say it with. Proactive
 * market alerts stay OFF by ruling (ADR 0014 / ORB-189) — if that ever changes, it is a NEW
 * schedule reading this job's output, not this one growing a `send`.
 *
 * CRON IS FIXED, not a slot on the owner's clock: `deadlines.ts` wakes for a rung that has to
 * land near a specific Oslo hour, and `owner-clock.ts` polls every 30 minutes because a Slack
 * timezone can change anytime. Neither reason applies here — nobody is WOKEN by a watchlist
 * refresh, so there is nothing an owner-clock slot would buy. `30 4 * * *` is the container's UTC
 * clock, 06:30 in Oslo: after any US-hours market activity has settled into the day's liquidity
 * ranking and comfortably before the morning brief (08:00) might one day want to read what this
 * job wrote.
 *
 * THE SWITCH IS FAIL-CLOSED, same posture as `deadlines.ts`'s ladder and for the same reason:
 * `markets_settings.refresh_enabled` is a feature switch, and a switch that could not be read is
 * not a licence to start hitting Polymarket and Kalshi every night. It ships OFF; the console
 * (Task 8) is what turns it on. The pass is stamped either way — a refresh that is quiet because
 * the OWNER asked for quiet must not read as a dead schedule in `input-freshness.sh` (ORB-175).
 */
import { defineSchedule } from "eve/schedules";

import { getPool } from "@lares/agent-kit/db";
import { makeMarketsRefresh, type RefreshReport } from "@lares/agent-kit/markets";
import { scheduleEnabled } from "@lares/agent-kit/schedule-switch";
import { thisAgent } from "../../lib/definition.js";
import { recordSchedulePass } from "@lares/agent-kit/schedule-heartbeat";
import { createTelegramFetch } from "@lares/agent-kit/telegram-fetch";

import { readMarketsSettings } from "../../lib/markets-settings-store.js";
import { ownerId } from "../../lib/principals.js";
import { emitSignal } from "../../lib/signal-emit.js";
import { withTimeout } from "../../lib/timeout.js";

// ─── The tick ────────────────────────────────────────────────────────────────────────────────

export interface MarketRefreshDeps {
  /** `markets_settings` for the owner. A throw means "could not read the switch" — see the file
   *  header: that reads as OFF, the same as `deadlines.ts`'s `ladderEnabled`. */
  settings(): Promise<{ refreshEnabled: boolean; watchlistMax: number }>;
  /** The kit job. Left to throw on failure — this tick does not catch it, so the live wiring's
   *  outer catch is what decides how a broken run is reported. */
  refresh(opts: { watchlistMax: number }): Promise<RefreshReport>;
  log?: (line: string) => void;
}

export interface MarketRefreshTickResult {
  ran: boolean;
  report: RefreshReport | null;
  skipped: "off" | null;
}

export interface MarketRefreshTick {
  tick(): Promise<MarketRefreshTickResult>;
}

/** Pure factory over injected deps — no pool, no venue, no environment. */
export function makeMarketRefreshTick(deps: MarketRefreshDeps): MarketRefreshTick {
  const log = deps.log ?? ((line: string) => console.log(line));

  return {
    async tick() {
      let settings: { refreshEnabled: boolean; watchlistMax: number };
      try {
        settings = await deps.settings();
      } catch (err) {
        log(`market-refresh: OFF (${String(err)})`);
        return { ran: false, report: null, skipped: "off" };
      }

      if (!settings.refreshEnabled) {
        log("market-refresh: OFF (markets_settings.refresh_enabled)");
        return { ran: false, report: null, skipped: "off" };
      }

      const report = await deps.refresh({ watchlistMax: settings.watchlistMax });
      log(
        `market-refresh: discovered ${report.discovered}, added ${report.added.length}, ` +
          `retired ${report.retired.length}, quoted ${report.quoted}, edges ${report.edgesRecorded}, ` +
          `skipped ${report.skipped.length}`,
      );
      return { ran: true, report, skipped: null };
    },
  };
}

// ─── Live wiring ─────────────────────────────────────────────────────────────────────────────

let running = false;

/** ORB-175 — the row input-freshness.sh reads; pinned to this filename by the conformance test. */
export const HEARTBEAT_KEY = "saga/market-refresh";

export default defineSchedule({
  cron: "30 4 * * *",
  async run() {
    const { loaded } = await thisAgent(undefined);
    if (!scheduleEnabled(loaded.definition, "market-refresh")) return;
    if (running) return;
    running = true;
    try {
      const pool = getPool();
      const owner = ownerId();
      await makeMarketRefreshTick({
        settings: () => readMarketsSettings(pool, owner),
        refresh: (opts) =>
          withTimeout(
            makeMarketsRefresh({ fetch: createTelegramFetch(), pool }).refresh(opts),
            10 * 60_000,
            "market-refresh",
          ),
      }).tick();

      // Including the OFF pass: the schedule ran and, by configuration, had nothing to do.
      await recordSchedulePass(pool, HEARTBEAT_KEY);
    } catch (e) {
      console.error("market-refresh: tick failed", e);
      await emitSignal("schedule-tick-failed", "market-refresh: tick failed", String(e));
    } finally {
      running = false;
    }
  },
});
