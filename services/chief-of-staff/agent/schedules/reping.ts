/**
 * The re-ping nudge (ORB-45 §4) — the ONE unprompted message in this feature that is not on a
 * fixed clock slot, because it fires on a FACT: someone messaged again on top of a message he
 * never answered (`assignSurfaces`'s `interrupt` bucket — see `lib/brief-content.ts`'s own
 * header on why only a re-ping may buy an interrupt). No model decides this.
 *
 * Ported from `services/agent-runtime/bin/saga.ts`'s re-ping tick (~lines 1282-1398) and deduped in
 * the database (`lib/obligations-store.ts`'s `announcedRePings`, read fresh every tick, never
 * cached) — the failure this feature must not reproduce is Tyche's: messages arriving often enough
 * that he stops reading them.
 *
 * THE CAP IS NO LONGER THIS FILE'S (ORB-193). It used to keep its own in-memory count of the Oslo
 * day (`OBLIGATION_REPING_MAX_PER_DAY`, default 3) and slice the batch to fit. That count died with
 * every container restart, applied to this lane alone, and was invisible to anything else that
 * might also be ringing his phone. The identical ceiling now lives in `@lares/agent-kit`'s
 * proactivity gate — 3 escalations per owner-day per door, in the `initiations` ledger, shared by
 * every lane and visible on the console — so each thread is sent as its OWN `escalation` initiation
 * and the fourth of a day is deferred by the engine rather than sliced off here. The OFF switch
 * below is untouched by that change.
 *
 * `OBLIGATION_REPING_ENABLED` is read here but is NOT set anywhere in this repo — per the
 * task brief, it lives only in the box's compose override/.env, wired up in Task 15 (a
 * live-deploy task, not this one). Unset or anything other than the literal string "1" means
 * OFF, the same fail-closed pattern as `scheduleGate()`.
 */
import { defineSchedule } from "eve/schedules";

import telegram from "../channels/telegram.js";
import { getPool } from "@lares/agent-kit/db";
import { scheduleEnabled } from "@lares/agent-kit/schedule-switch";
import { thisAgent } from "../../lib/definition.js";
import { recordSchedulePass } from "@lares/agent-kit/schedule-heartbeat";
import { configuredOwnerId, listAliases } from "../../lib/identity-client.js";
import { doorId, primaryTelegramChatId, telegramPushAttributes } from "../../lib/principals.js";
import { initiate, type InitiationOutcome } from "../../lib/initiation.js";
import { googleClients } from "../../lib/google.js";
import { assignSurfaces, type Obligation } from "../../lib/brief-content.js";
import { dropResolved, gatherOpenObligations } from "../../lib/obligation-pipeline.js";
import { withTimeout } from "../../lib/timeout.js";
import {
  ensureObligationsTableOnce,
  dismissedThreads,
  upsertSeen,
  announcedRePings,
  markRePingAnnounced,
  resolvedThreads,
} from "../../lib/obligations-store.js";
import { emitSignal } from "../../lib/signal-emit.js";

const OBLIGATION_TIMEOUT_MS = Number(process.env["OBLIGATION_TIMEOUT_MS"]) || 20_000;

function liveTelegramChatId(): string | undefined {
  return primaryTelegramChatId();
}

/** Mechanical facts only — no model-written reason. This lane consumes exactly one field off
 *  each item (`isRePing`, already true for everything in `batch`) plus the counterparty and
 *  the age, both already known; ranking it would spend an LLM call on ~48 ticks a day for a
 *  sentence nothing reads. */
export function buildRePingPrompt(batch: Obligation[]): string {
  return [
    "[scheduled turn — a dropped-ball nudge. This is not a message from a person.]",
    "",
    "Someone has messaged him AGAIN about something he never answered. Tell him, in two lines,",
    "who and what — no preamble, no list formatting for a single item, no proposals.",
    "",
    "TONE: Write to inform, not to prove checking happened. Never state that nothing is outstanding.",
    "",
    ...batch.map((o) => `- ${o.counterpartyName} <${o.counterpartyAddress}> — bumped after ${o.ageHours}h`),
  ].join("\n");
}

let running = false;

/** ORB-175 — the row input-freshness.sh reads; pinned to this filename by the conformance test. */
export const HEARTBEAT_KEY = "saga/reping";

export default defineSchedule({
  cron: "*/30 * * * *",
  async run({ to, waitUntil, appAuth }) {
    const { loaded } = await thisAgent(undefined);
    if (!scheduleEnabled(loaded.definition, "reping")) return;
    if (process.env["OBLIGATION_REPING_ENABLED"] !== "1") {
      // OFF by decision (ORB-193 gates proactivity) — the schedule ran and, by configuration,
      // had nothing to do. That is a completed pass; a closed EVE_SCHEDULES_LIVE gate is not.
      await recordSchedulePass(getPool(), HEARTBEAT_KEY);
      return;
    }
    if (running) return;
    running = true;
    try {
      const now = new Date();
      const chatId = liveTelegramChatId();
      if (!chatId) {
        console.warn("reping: no TELEGRAM_PRINCIPAL_ID configured; skipping");
        return;
      }

      const pool = getPool();
      await ensureObligationsTableOnce(pool);
      const myAddresses = () => listAliases(pool, configuredOwnerId(), "email");

      let all: Obligation[];
      try {
        all = await withTimeout(
          (async () => {
            const gmail = await googleClients().gmail();
            return gatherOpenObligations(
              {
                myAddresses,
                gmail: { searchThreadIds: gmail.searchThreadIds, readThread: gmail.readThread },
                dismissed: () => dismissedThreads(pool),
                upsertSeen: (o, seenAt) => upsertSeen(pool, o, seenAt, configuredOwnerId()),
                // ORB-149, D4: no `slack` here, DELIBERATELY — this schedule sends a Telegram
                // push straight from `assignSurfaces(...).interrupt` (below), the exact proactive
                // surface D4 forbids Slack from ever reaching. `brief-content-slack.ts`'s emitted
                // `theirUnansweredCount` cap already makes `isRePing` mathematically false for any
                // Slack-sourced Obligation, so wiring `slack` in here would be structurally inert
                // even if done — but leaving it out entirely is what makes the omission obvious to
                // the next person reading this file, rather than relying on that cap holding
                // forever. See morning-brief.ts's own call site for the one place `slack` IS wired.
              },
              now,
            );
          })(),
          OBLIGATION_TIMEOUT_MS,
          "reping: obligation gather",
        );
      } catch (e) {
        console.error("reping: could not gather obligations — skipping this tick", e);
        return;
      }

      const announced = await announcedRePings(pool).catch((e) => {
        console.error("reping: could not read announced re-pings — skipping this tick (avoids re-announcing)", e);
        return null;
      });
      if (!announced) return;

      // ORB-45 Task 10 (B5) — a thread he has already handled on ANOTHER channel must never buy
      // an interrupt. `resolvedThreads` is read fresh (like `announcedRePings` above, and for
      // the same reason), and `dropResolved` applies the one rule the briefs apply: a recorded
      // resolution only counts while it is NEWER than their last message — they may have
      // written again since he answered, and that is a new obligation, not a resolved one.
      //
      // Read failure is FAIL-OPEN, unlike `announcedRePings` above: a lost dedupe record risks
      // re-announcing something he was already told, while a lost resolution record risks one
      // nudge about something already handled. Both are annoyances; only the second keeps a
      // genuine dropped ball visible, and this lane exists for dropped balls.
      //
      // This is also the ONE cross-channel step this schedule takes. No `resolve`, no `intent`
      // is wired into its gather above: `interrupt` is a mechanical fact (they wrote again on
      // top of their own unanswered message), and nothing a model says may add to it — nor
      // subtract, at 48 ticks a day, from the one surface allowed to reach through to him.
      const resolvedElsewhere = await resolvedThreads(pool).catch((e) => {
        console.error("reping: could not read recorded resolutions — every re-ping stays eligible this tick", e);
        return new Map<string, Date>();
      });
      const { interrupt } = assignSurfaces(dropResolved(all, resolvedElsewhere), new Set(), announced);
      if (interrupt.length === 0) { await recordSchedulePass(pool, HEARTBEAT_KEY); return; } // nothing owed, this pass

      // ORB-193 — ONE INITIATION PER THREAD, not one per batch. The cap that used to slice this
      // list (`liveBudget`, `OBLIGATION_REPING_MAX_PER_DAY`) is gone: the engine's escalation
      // ceiling (3 per owner-day per door) is now what bounds it, durably and across every lane,
      // and it can only count what it can see one message at a time. The rung rides in the item
      // key — `reping/<threadId>#<unansweredCount>` — so a NEW bump on the same thread earns one
      // more message while the same bump, re-detected, does not.
      let nudged = 0;
      for (const o of interrupt) {
        let initiation: InitiationOutcome;
        try {
          initiation = await initiate(
            "reping",
            {
              cls: "escalation",
              door: doorId("telegram", chatId),
              itemKey: `reping/${o.threadId}#${o.unansweredCount}`,
              now,
            },
            async () => {
              const task = to(telegram, { chatId }).send(buildRePingPrompt([o]), { auth: { ...appAuth, attributes: telegramPushAttributes("reping", chatId) } });
              waitUntil(task);
              await task;
            },
          );
        } catch (err) {
          // Leaving the thread unmarked is the whole point — the next tick retries. A thrown send
          // means nothing reached him, and the gate wrote no `sent` row either.
          console.error(`reping: send FAILED for thread ${o.threadId} — retrying next tick`, err);
          continue;
        }
        // The door's daily escalation ceiling is spent: every later thread in this batch would get
        // the same answer, so stop asking (fix round 1, minor). One deferral row per item is the
        // audit trail; three more identical decisions are not.
        if (initiation.reason === "door-ceiling") {
          console.log(
            `reping: the door's daily ceiling is spent — leaving ${interrupt.length - nudged - 1} ` +
            "more eligible thread(s) for tomorrow",
          );
          break;
        }
        // Held back (quiet hours, DND, the owner-wide ceiling). Unmarked, so it stays eligible; a
        // deferral is reused rather than re-decided on every tick. ALREADY SEEN falls through to the
        // mark instead: a `sent` row for `reping/<threadId>#<count>` proves this exact bump reached
        // him, so `markRePingAnnounced` is finishing the write that failed, not nudging twice.
        if (!initiation.handled) continue;

        nudged += 1;
        await markRePingAnnounced(pool, o.threadId, {
          now, principal: configuredOwnerId(), unansweredCount: o.unansweredCount,
        }).catch((e) => console.error(`reping: failed to mark thread ${o.threadId} announced (may nudge again next tick)`, e));
      }
      console.log(`reping: ${nudged} announced of ${interrupt.length} eligible`);
      await recordSchedulePass(pool, HEARTBEAT_KEY);
    } catch (e) {
      console.error("reping: tick failed", e);
      await emitSignal("schedule-tick-failed", "reping: tick failed", String(e));
    } finally {
      running = false;
    }
  },
});
