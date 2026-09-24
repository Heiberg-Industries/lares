/**
 * The owner clock's Slack-profile signal, refreshed every 30 minutes (ORB-193 Task 2).
 *
 * The clock has three sources — Marcel's trip window, this signal, then the configured home
 * (`@lares/agent-kit/owner-clock`). Trips cover the travel somebody filed; this covers the travel
 * nobody filed, because Slack updates a user's timezone from the device itself. That is the whole
 * reason it is a source: it needs no human to remember anything.
 *
 * SO THIS SCHEDULE IS A SENSOR, NOT A MESSENGER. It sends nothing to anyone, it starts no agent
 * turn, and it costs no model call: one `users.info` and one upsert. Its output is a row whose
 * `observed_at` is fresh, and freshness IS the signal — the resolver only believes a profile
 * observed within 24 h. Which means the failure mode is benign by construction: if this schedule
 * stops, the signal ages out and the clock falls back to trip-or-home rather than trusting a
 * timezone from last week. So a Slack failure is logged and the pass is STAMPED ANYWAY — the ORB-175
 * heartbeat exists to catch "the schedule is not running", and a schedule that ran and found Slack
 * unreachable did run. A WRITE failure is different and does not stamp: that is the database this
 * agent cannot work without.
 *
 * 30 minutes, not a minute: a timezone changes a handful of times a year, and each tick is an
 * outbound API call. The resolver's own 5-minute cache (`lib/owner-clock.ts`) sits in front of the
 * read side, so the end-to-end lag on a zone change is up to ~35 minutes — a slot schedule fires on
 * the previous clock at most once, which is the trade ORB-193's spec accepts explicitly.
 */
import { defineSchedule } from "eve/schedules";

import { getPool } from "@lares/agent-kit/db";
import { scheduleEnabled } from "@lares/agent-kit/schedule-switch";
import { thisAgent } from "../../lib/definition.js";
import { recordSchedulePass } from "@lares/agent-kit/schedule-heartbeat";
import { recordSlackProfileSignal, type OwnerClockDb } from "@lares/agent-kit/owner-clock";

import { allowedSlackUserIds, ownerId } from "../../lib/principals.js";
import { fetchSlackUserTimezone, resolveSlackToken } from "../../lib/slack-source.js";

/** One Slack call plus one upsert; nothing else has a reason to be slow. */
const SLACK_TIMEOUT_MS = 15_000;

export interface OwnerClockRefreshDeps {
  /** The owner's timezone as Slack reports it, or null when Slack has none. Throwing means "could
   *  not read Slack", which is a logged non-event — see this file's header. */
  readOwnerTimezone(): Promise<string | null>;
  db: OwnerClockDb;
  owner: string;
}

export interface OwnerClockRefreshTick {
  /** `true` for a completed pass (a signal written, or Slack having nothing / being unreachable);
   *  `false` only when the WRITE failed, which is the one failure the heartbeat should surface. */
  tick(): Promise<boolean>;
}

/** Pure factory over injected deps — no pool, no Slack token, no environment. */
export function makeOwnerClockRefresh(deps: OwnerClockRefreshDeps): OwnerClockRefreshTick {
  return {
    async tick() {
      let tz: string | null;
      try {
        tz = await deps.readOwnerTimezone();
      } catch (err) {
        // A stale signal ages out of the 24 h window on its own, and the clock falls back to
        // trip-or-home. Nothing is written on a failed read: a timezone we could not confirm must
        // never be re-stamped as freshly observed.
        console.error(
          "owner-clock: could not read the owner's Slack timezone — leaving the previous signal to " +
            "age out (the clock falls back to trip, then home)",
          err,
        );
        return true;
      }

      if (tz === null) {
        console.warn("owner-clock: Slack reports no timezone for the owner — nothing to record");
        return true;
      }

      try {
        await recordSlackProfileSignal(deps.db, deps.owner, tz);
        return true;
      } catch (err) {
        console.error(
          `owner-clock: could not record the slack-profile signal (${tz}) — the clock keeps using ` +
            "the previous signal until it ages out",
          err,
        );
        return false;
      }
    },
  };
}

/** ORB-175 — the row input-freshness.sh reads; pinned to this filename by the conformance test. */
export const HEARTBEAT_KEY = "saga/owner-clock";

export default defineSchedule({
  cron: "*/30 * * * *",
  async run() {
    const { loaded } = await thisAgent(undefined);
    if (!scheduleEnabled(loaded.definition, "owner-clock")) return;

    // Bendik's own Slack user id: the first allowed principal, the same one the brief's Slack scan
    // treats as "him" (`lib/principals.ts`). Unconfigured means this signal can never exist, which
    // is a deployment fault worth surfacing as a stale heartbeat — the same choice
    // `proposals-watch.ts` makes for a missing TELEGRAM_PRINCIPAL_ID.
    const userId = allowedSlackUserIds()[0];
    if (!userId) {
      console.warn("owner-clock: no SLACK_ALLOWED_USER_IDS configured; skipping");
      return;
    }

    const tick = makeOwnerClockRefresh({
      db: getPool(),
      owner: ownerId(),
      async readOwnerTimezone() {
        const token = await resolveSlackToken();
        return fetchSlackUserTimezone(userId, { token, signal: AbortSignal.timeout(SLACK_TIMEOUT_MS) });
      },
    });

    // Never throws into eve's scheduler: the tick swallows its own failures, and this outer catch
    // covers the two things outside it (an unreachable pool for the heartbeat, a bug here).
    try {
      const completed = await tick.tick();
      if (completed) await recordSchedulePass(getPool(), HEARTBEAT_KEY);
    } catch (err) {
      console.error("owner-clock: tick failed", err);
    }
  },
});
