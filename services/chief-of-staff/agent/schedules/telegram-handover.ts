/**
 * The nightly Telegram hand-over — midnight on the owner's clock, for the day that just ended.
 *
 * WHAT IT FIXES. The rotation gives this door one conversation per Oslo calendar day. Since the
 * day's session is retired at the front door on the first message of the next day (eve's session
 * rename became additive, so nothing else can retire it — `lib/telegram-rotation.ts`), the
 * summary of the day being closed used to be produced only when that first turn COMPLETED: the
 * first message of a day was answered by a fresh conversation that had been handed nothing, and
 * the second message was the first to carry yesterday. This writes the hand-over the night
 * before, into the same column the next inbound message already consumes, so message one has it.
 * The model call cannot live at the front door: that handler's whole contract is that it does
 * not verify, dispatch, authenticate or interpret, and always forwards.
 *
 * MIDNIGHT, AND WHAT THAT COSTS. The slot is 00:00 on the owner's clock — the first minute at
 * which the day being summarized is over, so the summary is in place however early the owner
 * writes. A reply that lands in the first seconds after midnight belongs to the new day and is
 * not in it; that is one exchange at the tail of a ~40-exchange window, and worth less than an
 * hour's delay would cost an owner who writes at 06:00. The gate is exact-minute, like every
 * other slot in this service: a container down across midnight misses that night silently, which
 * is the pre-existing house behaviour, and the on-completion fallback then does what it always
 * did.
 *
 * DEFAULT ON, unlike the conversation prune. Three reasons, and they are the whole argument:
 * it RESTORES what the owner had before the eve upgrade (on 0.32 the first message of a day was
 * answered by yesterday's own session, which still held the day), so leaving it off would make
 * an installation keep a regression until somebody edited a definition; it DELETES NOTHING and
 * SENDS NOBODY ANYTHING — it writes one short note into the chat's own rotation row, which the
 * next message consumes; and when it does not run, nothing is lost or surprising, because the
 * on-completion path still closes the day exactly as it does today. So it reads `scheduleEnabled`
 * (silence means ON) and carries a line in `services/box/ops/input-freshness.sh`, like every
 * other schedule that is on by default. An installation that does not want it writes
 * `{ "on": false }` in its definition, the same way it switches off any other schedule.
 *
 * COST. At most one model call per chat that actually spoke that day (in practice one, for the
 * owner's private chat), over the same ~40 exchanges and the same 400-token cap the
 * on-completion path was already spending on the same summary — moved, not added. An
 * installation with no Telegram conversations at all is one SELECT and nothing else.
 */
import { defineSchedule } from "eve/schedules";

import { getPool } from "@lares/agent-kit/db";
import { scheduleEnabled } from "@lares/agent-kit/schedule-switch";
import { recordSchedulePass, recordScheduleTick } from "@lares/agent-kit/schedule-heartbeat";
import { thisAgent } from "../../lib/definition.js";
import { slotIn } from "../../lib/recurrence.js";
import { ownerTz } from "../../lib/owner-clock.js";
import { emitSignal } from "../../lib/signal-emit.js";
import { osloDay, osloDayBefore, runDayHandover } from "../../lib/telegram-rotation.js";

/** Midnight on the owner's clock — see the header for why the day boundary itself, not an hour
 *  after it. A constant, not a `schedule_settings` key: every key there is mirrored by the
 *  console's "when the agents speak" page, and a job that sends nobody anything has no business
 *  on it. No env knob either. */
export const HANDOVER_HOUR = 0;

/** ORB-175 — the row input-freshness.sh reads; pinned to this filename by the conformance test. */
export const HEARTBEAT_KEY = "saga/telegram-handover";

let lastSlot: string | null = null;
let running = false;

export default defineSchedule({
  cron: "* * * * *",
  async run() {
    const { loaded } = await thisAgent(undefined);
    if (!scheduleEnabled(loaded.definition, "telegram-handover")) return;
    await recordScheduleTick(getPool(), HEARTBEAT_KEY);
    if (running) return;

    const slot = slotIn(new Date(), await ownerTz(), HANDOVER_HOUR);
    if (slot === null || slot === lastSlot) return;

    running = true;
    lastSlot = slot;
    try {
      // The day that just ended, read on the same Oslo boundary the rotation rotates on — never
      // "yesterday" as the container's UTC clock would compute it.
      await runDayHandover(getPool(), osloDayBefore(osloDay()));
      // A night with nothing to hand over IS a completed pass: the job ran and found the chats
      // quiet. Only a failure to do the work at all leaves the row to age.
      await recordSchedulePass(getPool(), HEARTBEAT_KEY);
    } catch (e) {
      console.error("telegram-handover: pass failed", e);
      await emitSignal("schedule-tick-failed", "telegram-handover: tick failed", String(e));
    } finally {
      running = false;
    }
  },
});
