/**
 * The deadline ladder (ORB-180) — the ONE schedule in this feature that speaks unprompted.
 *
 * A deadline is a dated obligation to an institution: a filing, a payment, a meeting a statute
 * requires. The brief names it on its mention days (`mentionsToday`, Task 4); this lane is what
 * happens when the date is upon him anyway. Three rungs, and then it stops:
 *
 *   rung 1 — 15:00 the day before: "this is tomorrow".
 *   rung 2 — 09:00 on the day, statutory only: a self-imposed date does not earn a second ring.
 *   rung 3 — 09:00 the day after, `finalStop: true`: "I have raised this N times and I am stopping."
 *
 * Which rung is due is `@lares/agent-kit/deadlines`'s `ladderStep` — pure, on the owner's clock,
 * and never caught up (a deadline that slept through T-1 goes straight to the stop). This file
 * adds the three things the kit deliberately does not have: the switch, the gate and the door.
 *
 * ADR 0014, rules 1, 2, 5 and 7:
 *
 *   - **Every rung goes through `initiate()`** (`lib/initiation.ts`), as an `escalation` keyed
 *     `deadline/<id>#<rung>`. The rung is IN the key, so a rung is asked for exactly once even
 *     though this schedule ticks 48 times a day, and a later rung is a new question rather than a
 *     repeat of the last one.
 *   - **Rung 3 carries `finalStop`.** Under do-not-disturb the gate DEFERS a final stop rather than
 *     suppressing it (`proactivity.ts`'s `dnd-final-stop`): the one message that must never be lost
 *     is the one that says the system has stopped chasing. A silent stop is ORB-179 at the scale of
 *     a single item.
 *   - **Bookkeeping branches on `handled`, never on `sent`** — `alreadySeen` means he WAS told and
 *     only `advanceRung` failed last time, so the rung moves without a second message.
 *
 * THE SWITCH IS FAIL-CLOSED, and that is the opposite posture from the gate on purpose. The gate
 * fails OPEN (a dead ledger still delivers) because a missed suppression is an annoyance while a
 * silent stop is a defect. `deadline_settings.ladder_enabled` is a FEATURE switch — the same shape
 * as `OBLIGATION_REPING_ENABLED` — and a switch that could not be read is not a licence to start
 * ringing a phone. It ships OFF; the console (Task 8) is what turns it on.
 *
 * The pass is stamped either way. A ladder that is quiet because the OWNER asked for quiet must not
 * read as a dead schedule in `input-freshness.sh` (ORB-175/179).
 */
import { defineSchedule } from "eve/schedules";

import { getPool } from "@lares/agent-kit/db";
import { daysToDue, ladderStep, type LadderStep } from "@lares/agent-kit/deadlines";
import { scheduleEnabled } from "@lares/agent-kit/schedule-switch";
import { thisAgent } from "../../lib/definition.js";
import { recordSchedulePass } from "@lares/agent-kit/schedule-heartbeat";

import telegram from "../channels/telegram.js";
import { advanceRung, listDeadlines, readLadderEnabled, type DeadlineRow } from "../../lib/deadlines-store.js";
import { initiateTo, type DoorInitiate, type InitiationOutcome } from "../../lib/initiation.js";
import { ownerTz } from "../../lib/owner-clock.js";
import { doorId, ownerId, primaryTelegramChatId, telegramPushAttributes } from "../../lib/principals.js";
import { emitSignal } from "../../lib/signal-emit.js";
import { readBriefLanguage, type BriefLanguage } from "../../lib/brief-settings.js";
import { BRIEF_STRINGS } from "../../lib/brief-strings.js";

// ─── The rung's wording ──────────────────────────────────────────────────────────────────────

/**
 * LAR-68 — the line that reaches him, in `lang` (`readBriefLanguage`'s own contract: falls back
 * to `"en"`, never throws). One line per rung, and the whole message — the model's only job is
 * to relay it (see `deadlinePrompt`). The wording itself lives in `lib/brief-strings.ts`'s
 * `deadlineLadder`, the same table the brief's own fixed strings live in (LAR-16-s2); `lang` is
 * REQUIRED, not defaulted, so a caller can never forget to say which language it wants.
 *
 * `daysToDue` IS read, on the rung-3 stop: a row that was never raised at all has no count to
 * report, so the stop says how late the deadline is instead (review fix, below).
 */
export function rungText(d: DeadlineRow, step: LadderStep, daysToDue: number, lang: BriefLanguage): string {
  const strings = BRIEF_STRINGS[lang].deadlineLadder;
  // Only when the row has one — an empty dash reads as a rendering bug, not as "no consequence".
  const consequence = d.consequence ? ` — ${d.consequence}` : "";
  if (step.rung === 1) return strings.dueTomorrow(d.title, d.entity, consequence);
  if (step.rung === 2) return strings.dueToday(d.title, d.entity, consequence);

  // THE STOP AT RUNG 0 (review fix, ORB-180). `ladderStep` never catches a rung up, so a deadline
  // that passed while the ladder was OFF arrives here having been raised ZERO times — and the
  // count line would then read "… 1 time(s)", which is both a lie and (in nb) ungrammatical. The
  // honest thing to say is that the date went by without him hearing from her at all.
  if (d.rung === 0) {
    const late = Math.max(-daysToDue, 0);
    return strings.stopNeverRaised(d.title, d.entity, late);
  }

  // The count is the rungs actually RAISED — the ones already sent plus this stop, which is itself
  // a raise: a row that slept through rung 2 has been raised twice, and claiming three would be a
  // lie he can check. The singular branch of each language's wording is unreachable today (the
  // `d.rung === 0` branch above always takes the "never raised" wording instead), kept anyway for
  // honesty rather than assuming `times` can never be 1.
  const times = d.rung + 1;
  return strings.stopWithCount(d.title, times);
}

/**
 * The prompt the scheduled turn carries. The rung is the MESSAGE, not a brief for one — so unlike
 * `reping`'s prompt (facts, from which the model writes two lines), this one asks for a relay.
 * The turn shape is still `to(...).send(...)`, the door this service already uses for every push,
 * so the message lands in the same session he replies into ("done"/"dismiss", in whatever
 * language `line` itself is already written in — this instruction does not name one, LAR-68).
 */
export function deadlinePrompt(line: string): string {
  return [
    "[scheduled turn — a deadline reminder. This is not a message from a person.]",
    "",
    "Relay the following to him verbatim, with no preamble and no additions:",
    "",
    line,
  ].join("\n");
}

// ─── The tick ────────────────────────────────────────────────────────────────────────────────

export interface DeadlineLadderStore {
  /** Every OPEN row for the owner. The tick decides which of them owes a rung. */
  open(now: Date, tz: string): Promise<DeadlineRow[]>;
  advanceRung(id: string, rung: number, now: Date): Promise<void>;
  /** `deadline_settings.ladder_enabled`. A throw means OFF — see the file header. */
  ladderEnabled(): Promise<boolean>;
}

export interface DeadlineLadderDeps {
  store: DeadlineLadderStore;
  /** `lib/initiation.ts`, bound to the Telegram door by the live wiring. Required, not defaulted:
   *  a ladder wired without a gate is the failure ADR 0014 exists to prevent. */
  gate: DoorInitiate;
  send(text: string): Promise<void>;
  clock?: () => Date;
  tz: () => Promise<string>;
  /** LAR-68 — read ONCE per pass by the live wiring (`readBriefLanguage`, same call the morning
   *  brief makes) and handed in here, required rather than defaulted: `rungText` must never
   *  guess a language on its own, and a tick that read it twice could disagree with itself
   *  mid-batch if the setting changed between reads. */
  lang: BriefLanguage;
}

export interface DeadlineLadderResult {
  /** Rungs that reached him (or were already his — `alreadySeen`) and moved the row. */
  stepped: number;
  /** Rungs the gate held back. The rows keep their rung and are reconsidered next tick. */
  held: number;
  /** `"off"` when the switch said so; `null` for a pass that actually ran the ladder. */
  skipped: "off" | null;
}

export interface DeadlineLadderTick {
  tick(): Promise<DeadlineLadderResult>;
}

/** Pure factory over injected deps — no pool, no channel, no environment. */
export function makeDeadlineLadderTick(deps: DeadlineLadderDeps): DeadlineLadderTick {
  const { store, gate, send, clock = () => new Date(), tz: readTz, lang } = deps;

  return {
    async tick() {
      let enabled: boolean;
      try {
        enabled = await store.ladderEnabled();
      } catch (err) {
        console.log(`deadlines: ladder is OFF (the switch could not be read: ${String(err)})`);
        return { stepped: 0, held: 0, skipped: "off" };
      }
      if (!enabled) {
        console.log("deadlines: ladder is OFF (deadline_settings.ladder_enabled)");
        return { stepped: 0, held: 0, skipped: "off" };
      }

      const now = clock();
      const tz = await readTz();

      // Resolve every rung FIRST, so "the rest of the batch" below is the rows that actually owe a
      // message — not every open deadline, most of which owe nothing today.
      const due: Array<{ row: DeadlineRow; step: LadderStep }> = [];
      for (const row of await store.open(now, tz)) {
        const step = ladderStep(row, now, tz);
        if (step !== null) due.push({ row, step });
      }

      let stepped = 0;
      let held = 0;
      for (const [i, { row, step }] of due.entries()) {
        let initiation: InitiationOutcome;
        try {
          initiation = await gate(
            {
              cls: "escalation",
              itemKey: `deadline/${row.id}#${step.rung}`,
              finalStop: step.finalStop,
              now,
              tz,
            },
            () => send(rungText(row, step, daysToDue(row.dueDate, now, tz), lang)),
          );
        } catch (err) {
          // Nothing reached him and the gate wrote no `sent` row, so the rung stays owed. One
          // broken send must not cost the rest of the batch its message.
          console.error(`deadlines: send FAILED for ${row.id} (rung ${step.rung}) — retrying next tick`, err);
          continue;
        }

        // The door's daily escalation budget is spent: every later row would get the same answer.
        // One deferral row is the audit trail; three more identical decisions are noise (reping's
        // own rule). Everything left is held, including this one.
        if (initiation.reason === "door-ceiling") {
          const remaining = due.length - i;
          console.log(
            `deadlines: the door's daily ceiling is spent — leaving ${remaining} rung(s) for tomorrow`,
          );
          held += remaining;
          break;
        }

        // A genuine hold (DND, quiet hours, the owner ceiling, or a DEFERRED final stop). The row
        // keeps its rung, so it is asked again — and lands — the moment the gate reopens.
        if (!initiation.handled) {
          held += 1;
          continue;
        }

        stepped += 1;
        // `handled` covers `alreadySeen`: a `sent` row for this exact rung proves the message
        // reached him, so this is the write that failed last tick, not a second ring.
        await store
          .advanceRung(row.id, step.rung, now)
          .catch((e) => console.error(`deadlines: failed to advance ${row.id} to rung ${step.rung} (may ring again next tick)`, e));
      }

      return { stepped, held, skipped: null };
    },
  };
}

// ─── Live wiring ─────────────────────────────────────────────────────────────────────────────

let running = false;

/** ORB-175 — the row input-freshness.sh reads; pinned to this filename by the conformance test. */
export const HEARTBEAT_KEY = "saga/deadlines";

export default defineSchedule({
  // Every 30 minutes: the rungs fire at 15:00 and 09:00 on the owner's clock, and a half-hour grid
  // hits both within the hour they belong to without a slot's once-a-day fragility.
  cron: "*/30 * * * *",
  async run({ to, waitUntil, appAuth }) {
    const { loaded } = await thisAgent(undefined);
    if (!scheduleEnabled(loaded.definition, "deadlines")) return;
    if (running) return;
    running = true;
    try {
      const chatId = primaryTelegramChatId();
      if (!chatId) {
        console.warn("deadlines: no TELEGRAM_PRINCIPAL_ID configured; skipping");
        return;
      }

      const pool = getPool();
      const owner = ownerId();
      // LAR-68 — read once per pass, the same call the morning brief makes
      // (`morning-brief.ts`'s own `const lang = await readBriefLanguage(pool, ownerId());`).
      // Never throws; a settings-table outage costs the ladder nothing beyond an English rung.
      const lang = await readBriefLanguage(pool, owner);
      const result = await makeDeadlineLadderTick({
        store: {
          open: (now, tz) => listDeadlines(pool, owner, { status: "open", now, tz }),
          advanceRung: (id, rung, now) => advanceRung(pool, id, owner, rung, now),
          ladderEnabled: () => readLadderEnabled(pool, owner),
        },
        gate: initiateTo("deadlines", doorId("telegram", chatId)),
        tz: () => ownerTz(),
        lang,
        async send(text) {
          const task = to(telegram, { chatId }).send(deadlinePrompt(text), {
            auth: { ...appAuth, attributes: telegramPushAttributes("deadlines", chatId) },
          });
          waitUntil(task);
          await task;
        },
      }).tick();

      if (result.skipped === null) {
        console.log(`deadlines: ${result.stepped} rung(s) sent, ${result.held} held`);
      }
      // Including the OFF pass: the schedule ran and, by configuration, had nothing to do.
      await recordSchedulePass(pool, HEARTBEAT_KEY);
    } catch (e) {
      console.error("deadlines: tick failed", e);
      await emitSignal("schedule-tick-failed", "deadlines: tick failed", String(e));
    } finally {
      running = false;
    }
  },
});
