/**
 * The nightly conversation prune — ADR-0020 rule 3. 04:00 on the owner's clock.
 *
 * WHY 04:00 AND NOT 03:00: the dream cycle runs at 03:00 and reads `conversation_entries`. A
 * night's entries are reflected on BEFORE anything can be pruned; running the two the other way
 * round would let a retention boundary silently take a night's input away from the cycle that was
 * about to read it.
 *
 * OPT-IN EVERYWHERE, not merely off in the template. Silence means ON for every other schedule
 * (`packages/agent-kit/src/schedule-switch.ts`), and the template's `{ "on": false }` only reaches
 * definitions generated after it — a definition already on a running box predates this schedule,
 * says nothing about it, and would therefore START it. So this one asks
 * `scheduleExplicitlyEnabled`: the box gate open AND `on: true` written out in the definition.
 * ADR-0020's twelve months is the DEFAULT WINDOW, not a default to start deleting. Turning it on
 * is one definition edit, and it belongs with the console control (wave 5A).
 *
 * IT MAKES NO MODEL CALL AND SENDS THE OWNER NOTHING. A deletion is not news to be delivered; it
 * is bookkeeping that must be auditable. What it leaves behind is one log line per run naming the
 * outcome, the cutoff and the count, a heartbeat the box's `input-freshness.sh` reads, and — on a
 * refusal — a signal, because a prune that has been quietly refusing for weeks is the
 * silent-degradation shape this fleet keeps producing (ADR-0018 rule 6).
 *
 * A REFUSAL DOES NOT STAMP A PASS. `pruneForOwner` refuses rather than guesses when the retention
 * setting cannot be read (a database outage, or migration 061 not applied here) or when the clock
 * is obviously wrong. That is the right answer for the DATA — nothing is deleted — but it is not a
 * completed pass: the job cannot do its work at all, so the pass row goes stale and
 * `input-freshness.sh` pages, exactly as its own header asks ("an unreadable check is failing,
 * never passing"). A "keep forever" or an empty window IS a completed pass and stamps.
 *
 * NOT OPTED IN LOOKS EXACTLY LIKE SWITCHED OFF, and that is the whole of it. `input-freshness.sh`
 * has no exemption for a schedule a definition has switched off: every schedule in this service
 * returns BEFORE `recordScheduleTick`, so an off schedule stamps neither row, both age, and
 * section 5b reports it stale — "a closed gate looks exactly like this" is in the script's own
 * DEAD_LOOPS message. That is deliberate (the ten-day digest outage looked healthy), and this
 * schedule does not get a special case: the switch sits in the same place, so an installation that
 * has not opted in is indistinguishable from one that switched the prune off, and the box's report
 * says the same thing about both. Stamping a tick before the switch to quieten it would make an
 * off schedule look alive, which is the failure that script exists to catch.
 *
 * WHICH OWNER. The prune keys on `conversation_entries.person_key` and reads the retention
 * setting under the same string, so the promise and the delete cannot disagree: `ownerId()`, the
 * installation's own owner id, as every other settings read in this service uses
 * (`lib/schedule-hours.ts`). The door's write path stamps `person_key` from
 * `CANONICAL_USER_ID` (`agent/hooks/turn-capture.ts`); on an installation where those two strings
 * differ, this prune deletes NOTHING and the log line's count says so — the safe direction, and
 * the reason the count is in the line at all.
 *
 * THE HOUR IS A CONSTANT HERE, not a `schedule_settings` key. Every key in
 * `SCHEDULE_HOUR_DEFAULTS` is mirrored by the console and offered on the "when the agents speak"
 * page; a destructive job that ships off has no business on that page, and adding the key would
 * drift the console's mirror in a wave that touches no console file. No env knob either.
 */
import { defineSchedule } from "eve/schedules";

import { getPool } from "@lares/agent-kit/db";
import { scheduleExplicitlyEnabled } from "@lares/agent-kit/schedule-switch";
import { recordSchedulePass, recordScheduleTick } from "@lares/agent-kit/schedule-heartbeat";
import { pruneForOwner } from "@lares/agent-kit/conversation-record";
import { thisAgent } from "../../lib/definition.js";
import { slotIn } from "../../lib/recurrence.js";
import { ownerTz } from "../../lib/owner-clock.js";
import { ownerId } from "../../lib/principals.js";
import { emitSignal } from "../../lib/signal-emit.js";

/** 04:00 on the owner's clock — see the header for why it is after the dream cycle, not before. */
export const PRUNE_HOUR = 4;

let lastSlot: string | null = null;
let running = false;

/** ORB-175 — the row input-freshness.sh reads; pinned to this filename by the conformance test. */
export const HEARTBEAT_KEY = "saga/conversation-prune";

/** One pass. Returns the outcome so a caller (and the test) can read what happened. */
export async function runConversationPrune(now: Date = new Date()): Promise<boolean> {
  const owner = ownerId();
  const result = await pruneForOwner(getPool(), { owner, now });
  const line =
    `conversation-prune: ${result.outcome} — owner=${owner} deleted=${result.deleted} deletedReads=${result.deletedReads}` +
    (result.cutoff ? ` cutoff=${result.cutoff.toISOString()}` : "") +
    (result.batchLimited ? " (batch limit reached; the rest waits for the next run)" : "") +
    (result.reason ? ` — ${result.reason}` : "");

  if (result.outcome === "refused") {
    console.error(line);
    await emitSignal("conversation-prune-refused", "conversation-prune: refused, nothing deleted", result.reason ?? "");
    return false;
  }
  console.log(line);
  return true;
}

export default defineSchedule({
  cron: "* * * * *",
  async run() {
    const { loaded } = await thisAgent(undefined);
    // Before the tick stamp, exactly where every other schedule puts its switch: a schedule this
    // installation has not opted into stamps NOTHING — no tick, no pass — which is bit-for-bit
    // what an explicitly `{ "on": false }` schedule does today, so `input-freshness.sh` cannot
    // tell the two apart and no new alarm shape is introduced (see the header).
    if (!scheduleExplicitlyEnabled(loaded.definition, "conversation-prune")) return;
    await recordScheduleTick(getPool(), HEARTBEAT_KEY);
    if (running) return;

    const slot = slotIn(new Date(), await ownerTz(), PRUNE_HOUR);
    if (slot === null || slot === lastSlot) return;

    running = true;
    lastSlot = slot;
    try {
      if (await runConversationPrune()) await recordSchedulePass(getPool(), HEARTBEAT_KEY);
    } catch (e) {
      console.error("conversation-prune: pass failed", e);
      await emitSignal("schedule-tick-failed", "conversation-prune: tick failed", String(e));
    } finally {
      running = false;
    }
  },
});
