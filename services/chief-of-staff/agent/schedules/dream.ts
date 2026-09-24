/**
 * The nightly dream cycle — 03:00 on the owner's clock by default, a per-installation setting
 * since LAR-17-s4 (`packages/agent-kit/src/schedule-settings.ts`'s `dream` key, no more env var);
 * `Europe/Oslo` at home, so unchanged on a normal night — ORB-193 put every slot on `ownerTz()`.
 *
 * Replaces the old runtime's `saga-dream` CONTAINER
 * (`services/agent-runtime/bin/saga-dream.ts`). One pass: resolve the cursor from the latest
 * `_meta/dream/<date>.md`, read conversation logs newer than it, reflect, GDPR-scrub, promote,
 * write a dated note, and file anything needing confirmation as a memory proposal.
 *
 * PREREQUISITE, and the reason this port is not a lift-and-shift: the cycle's input used to be
 * `_meta/conversations/**\/*.md` alone, and eve-saga did not write those until ORB-138. Between
 * 2026-08-13 and ORB-138 landing, every nightly pass reflected on an empty window and reported
 * `promoted=0 superseded=0 held=0 needsConfirm=0`. Since W3B-s3 the cycle reads
 * `conversation_entries` (ADR-0020's table) first, falling back to markdown only for the one
 * installation-lifetime gap the table cannot itself answer for (`lib/dream/log-reader.ts`'s
 * `readConversationEntries`). If this schedule reports zeros while conversations exist — in
 * either the table or the markdown log — that is a REAL finding, not the old normal.
 *
 * THIS SCHEDULE SENDS THE OWNER NOTHING (W5X-s4). It used to enqueue one reminder row per run
 * listing the observations it wanted confirmed — a message nothing could answer, because a
 * confirmation had no durable row and no id. Each one is now a `memory_proposals` row with
 * action `add`, and `agent/schedules/proposals-watch.ts` is the single lane that announces it,
 * the list tool shows it and the resolve tool decides it. Two senders for one question is the
 * thing that must not come back.
 *
 * ORDER OF DEPLOY: `services/box/sql/074_memory_proposal_add.sql` is applied to the box BEFORE
 * an image carrying this file runs. Without it nothing can be filed, the confirmation is held
 * (fail closed), and the owner simply hears nothing — which is silence, not a wrong answer, so
 * `makeProposeAdd` warns once per process and names the file.
 *
 * TIMEZONE: "poll every minute, gate on the Oslo wall clock", same as the briefs. The gate is
 * exact-minute, so a container down across 03:00 misses that night silently — the pre-existing
 * house behaviour (stability finding S3b), ported rather than changed.
 */
import { readFileSync } from "node:fs";

import { defineSchedule } from "eve/schedules";

import { getPool } from "@lares/agent-kit/db";
import { scheduleGate } from "@lares/agent-kit/schedule-gate";
import { scheduleEnabled } from "@lares/agent-kit/schedule-switch";
import { recordSchedulePass, recordScheduleTick } from "@lares/agent-kit/schedule-heartbeat";
import { thisAgent } from "../../lib/definition.js";
import { slotIn } from "../../lib/recurrence.js";
import { ownerTz } from "../../lib/owner-clock.js";
import { ownerId } from "../../lib/principals.js";
import { scheduleHours } from "../../lib/schedule-hours.js";
import { storeRoot, listNotes, resolveInStore } from "@lares/agent-kit/notes-store";
import { commitNote } from "@lares/agent-kit/vault-git";
import { gatewayComplete, resolveModelForPurpose, outputTokenBudget } from "../../lib/llm-complete.js";
import { assertStepAffordable, actualStepCost, UnpricedModelError, StepTooExpensiveError } from "../../lib/dream/spend.js";
import { ensureDreamTables, makeDreamStore } from "../../lib/dream/store.js";
import { makeReflector, isDoNotLearn } from "../../lib/dream/reflect.js";
import { makePromoter, makeProposeAdd } from "../../lib/dream/promote.js";
import {
  makeDreamCycle,
  everythingRejected,
  shouldRaiseAllRejectedSignal,
  buildAllRejectedSignalDetail,
  DREAM_ALL_REJECTED_EVENT,
} from "../../lib/dream/cycle.js";
import {
  selectForConfirmation,
  DREAM_CONFIRM_MAX_PER_RUN,
} from "../../lib/dream/surface.js";
import type { Observation } from "../../lib/dream/reflect.js";
import { emitSignal } from "../../lib/signal-emit.js";
import { makeConversationRecord } from "@lares/agent-kit/conversation-record";

export function dreamGate(env: NodeJS.ProcessEnv = process.env): boolean {
  return scheduleGate(env) && env["EVE_DREAM_LIVE"] === "1";
}

/**
 * ORB-193 — takes the timezone rather than assuming Oslo, like every other slot in this service.
 * The NAME is kept (the plan's Task 3 names it) even though it is no longer Oslo-specific; read it
 * as "the slot helper this schedule has always used". `slotIn`/`slotKey` is the shared
 * implementation it delegates to, so all eight slots come off one formatter.
 *
 * The cycle writes a dated note and touches nothing Bendik sees, so moving it onto the owner clock
 * is consistency, not behaviour: at home the resolver answers `Europe/Oslo` and 03:00 is 03:00.
 */
export function osloSlot(now: Date, tz: string, hour: number): string | null {
  return slotIn(now, tz, hour);
}

/**
 * The cycle's structural brain: list + read for the log reader, commitNote for the dated
 * note. `read` resolves the path and reads it directly — it deliberately does NOT go through
 * `readNote()`, which runs a full recursive `listNotes()` vault walk as a health check before
 * every single read. `readConversationLogs` calls `read` once per conversation log in the
 * vault, so routing through `readNote` would make one dream-cycle pass cost
 * O(files × vault-size) instead of O(files). The health check still happens — exactly once
 * per cycle, in `list()` below, which `runOnce()` already calls to enumerate files before it
 * reads any of them.
 */
export function makeDreamBrain(root: string) {
  return {
    list: async () => listNotes(root),
    read: async (path: string) => readFileSync(resolveInStore(path, root), "utf8"),
    commitNote: async (o: { path: string; frontmatter: Record<string, unknown>; body: string; message?: string }) =>
      commitNote({ vaultRoot: root, path: o.path, frontmatter: o.frontmatter, body: o.body, message: o.message }),
  };
}

/**
 * W5X-s4 — what this schedule does with the run's `needsConfirm` items, replacing W4C-s2b's
 * `sendConfirmationNotice`. It FILES each one and SENDS NOTHING.
 *
 * WHY THE SEND IS GONE. The old notice was one combined message listing up to
 * `DREAM_CONFIRM_MAX_PER_RUN` observations — and nothing could answer it: `surface.ts`'s
 * `resolve()` takes the `Observation` object, there was no durable row and no id in the text.
 * Each item is now a `memory_proposals` row with action `add`, and that lane already has an id,
 * a guarded decision, an apply pass, a list tool and `agent/schedules/proposals-watch.ts`,
 * which announces every unannounced proposal within the minute. If this function also sent a
 * notice the owner would get the same question twice, from two lanes, one of them unanswerable.
 *
 * THE CAP SURVIVES, with a changed meaning: it is now how many proposals one run may FILE, not
 * how many one message may list. Everything past it is untouched — not asked, not dismissed,
 * not recorded as either — and comes back on a later night when the cycle re-derives it. The
 * number is RETURNED (and logged by the caller) so a run that held things back says so.
 *
 * Deps as plain arguments, no `getPool()` inside, so the cap and the "sends nothing" behaviour
 * are unit-testable with fakes, the same way `osloSlot`/`makeDreamBrain` are.
 */
export async function fileConfirmations(
  needsConfirm: Observation[],
  deps: {
    propose: (obs: Observation) => Promise<number | null>;
    max?: number;
  },
): Promise<{ filed: number[]; heldBack: number }> {
  if (needsConfirm.length === 0) return { filed: [], heldBack: 0 };

  const { shown, heldBack } = selectForConfirmation(needsConfirm, { max: deps.max });

  const filed: number[] = [];
  for (const obs of shown) {
    // Serially, and one failure at a time: `propose` already fails soft on every condition it
    // expects (a full queue, a question already asked, a box without the migration), so an
    // actual throw here is something unforeseen — and losing the rest of the night's questions
    // to it would be the worse outcome. The note is committed by the time this runs.
    try {
      const id = await deps.propose(obs);
      if (id !== null) filed.push(id);
    } catch (e) {
      console.error("dream: failed to file an observation for the owner to confirm", e);
    }
  }

  return { filed, heldBack };
}

export async function runDreamCycle(): Promise<{ notePath: string; counts: Record<string, number> }> {
  const db = getPool();
  await ensureDreamTables(db);

  const root = storeRoot("brain");
  // Explicit, not guessed inside the store: box 084 / ruling D5. `ownerId()` is the fail-soft
  // owner key (env override, else this installation's one literal fallback) — acceptable for a
  // single-member installation's own writes; a multi-user caller only has to change this line.
  const store = makeDreamStore(db, ownerId());

  // The dated note IS committed (unlike the conversation logs) — one commit a night, and it
  // carries the cursor the next pass reads.
  const brain = makeDreamBrain(root);

  // The label a legacy markdown file's reply line carries, for the reader's markdown gap-fill
  // (W3B-s7) — resolved the same way every other "who am I" read in this service is, never a
  // literal name here.
  const { loaded } = await thisAgent(undefined);
  const agentLabel = loaded.definition.display ?? loaded.definition.name;

  // W4C-s8 — the actual cost of the run's one reflection call, from the provider's own usage
  // report. Stays undefined (never guessed as zero) when the provider reports none.
  let reflectionCostUsd: number | undefined;

  const cycle = makeDreamCycle({
    reflector: makeReflector({
      llm: (prompt: string) => {
        // Priced against the model and the output cap the GATEWAY will actually apply
        // (`outputTokenBudget` raises a thinking purpose's cap), not the 1024 asked below —
        // a cap computed from the smaller number would understate the worst case eightfold.
        const model = resolveModelForPurpose("brain", process.env, process.env["DREAM_MODEL"]);
        const maxOutputTokens = outputTokenBudget("brain", 1024);
        assertStepAffordable({ model, promptChars: prompt.length, maxOutputTokens });
        return gatewayComplete(prompt, {
          model: process.env["DREAM_MODEL"],
          purpose: "brain",
          maxOutputTokens: 1024,
          onUsage: (usage) => { reflectionCostUsd = actualStepCost(model, usage); },
        });
      },
      agentLabel,
    }),
    // The do-not-learn list (ADR-0018 rule 5, W4C-s3): the kit's shared gate records every
    // observation before deciding, so a do-not-learn rejection is reported, never silently
    // dropped — see the comment beside `isDoNotLearn`'s call site in `lib/dream/reflect.ts`.
    promoter: makePromoter({ store, doNotLearn: (o) => isDoNotLearn(o.text, o.subject) }),
    brain,
    entries: makeConversationRecord(db),
    // Must match `lib/turn-capture.ts`'s own fallback exactly — not `thisAgent()`'s resolved
    // name, which falls back to the manifest's name instead of "unknown" when the env var is
    // unset, and would then never find the rows that write path recorded.
    agent: process.env["LARES_AGENT_NAME"] ?? "unknown",
    agentLabel,
  });

  const { notePath, result, allRejectedStreak } = await cycle.runOnce();

  // Each inference the owner has to answer becomes a row they CAN answer; the proposals watch
  // is what tells them, within the minute. This schedule sends nothing about them (W5X-s4).
  const { filed, heldBack: needsConfirmHeldBack } = await fileConfirmations(result.needsConfirm, {
    propose: makeProposeAdd(db),
    max: DREAM_CONFIRM_MAX_PER_RUN,
  });

  const counts = {
    promoted: result.promoted.length,
    superseded: result.superseded.length,
    held: result.held.length,
    needsConfirm: result.needsConfirm.length,
    // Filed AND held back, both, because their difference is the interesting number: an
    // observation that was shown to this function and still did not become a row (the queue is
    // full, the question has already been asked, or the box has no 074) is in neither.
    needsConfirmFiled: filed.length,
    needsConfirmHeldBack,
    rejected: result.rejected.length,
  };

  // OpenClaw's own failure (ADR-0018 rule 6, issue #121232) — but a SINGLE all-rejected night is
  // not yet that failure: with tonight's strict gate a perfectly healthy night can reject
  // everything (a one-off owner remark, the agent's own inference), so the alarm is gated on the
  // STREAK (kept in the note itself, see `cycle.ts`) reaching `DREAM_ALL_REJECTED_SIGNAL_AT` and
  // every 7 nights beyond it, and it is gated on THIS run itself being all-rejected too — a quiet
  // night that merely carries a threshold streak forward must never re-raise it. Wrapped so a
  // bug in the counting or the signal call can never cost the run — the note above is already
  // committed by the time this runs.
  if (everythingRejected(result) && shouldRaiseAllRejectedSignal(allRejectedStreak)) {
    try {
      await emitSignal(
        DREAM_ALL_REJECTED_EVENT,
        "dream: every candidate was rejected this run",
        buildAllRejectedSignalDetail(result.rejected, allRejectedStreak),
      );
    } catch (e) {
      console.error("dream: failed to raise the all-rejected signal", e);
    }
  }

  // W4C-s8 — never a guess: "not reported" when the provider gave no usage back, exactly what
  // `actualStepCost` returns undefined for.
  const reflectionCostText =
    reflectionCostUsd === undefined ? "not reported" : `$${reflectionCostUsd.toFixed(4)}`;
  console.log(
    `dream: cycle wrote ${notePath} (promoted=${counts.promoted} superseded=${counts.superseded} ` +
    `held=${counts.held} needsConfirm=${counts.needsConfirm} needsConfirmFiled=${counts.needsConfirmFiled} ` +
    `needsConfirmHeldBack=${counts.needsConfirmHeldBack} rejected=${counts.rejected})`,
  );
  console.log(`dream: Reflection cost: ${reflectionCostText}`);
  return { notePath, counts };
}

let lastSlot: string | null = null;
let running = false;

/** ORB-175 — the row input-freshness.sh reads; pinned to this filename by the conformance test. */
export const HEARTBEAT_KEY = "saga/dream";

export default defineSchedule({
  cron: "* * * * *",
  async run() {
    const { loaded } = await thisAgent(undefined);
    if (!scheduleEnabled(loaded.definition, "dream")) return;
    if (!dreamGate()) return;
    await recordScheduleTick(getPool(), HEARTBEAT_KEY);
    if (running) return;

    // The forced-run switch, replacing DREAM_RUN_ON_START: the only way to prove a change
    // without waiting until 03:00. Consumed once per container start.
    const forced = process.env["DREAM_RUN_NOW"] === "1" && lastSlot !== "forced";

    // The owner clock, resolved once per tick and cached for five minutes (lib/owner-clock.ts).
    // LAR-17-s4 — the hour is a setting now, cached in-process for a few minutes too
    // (lib/schedule-hours.ts).
    const [hour] = await scheduleHours("dream");
    const slot = osloSlot(new Date(), await ownerTz(), hour);
    const due = slot !== null && slot !== lastSlot;
    if (!due && !forced) return;

    running = true;
    lastSlot = forced ? "forced" : slot;
    try {
      await runDreamCycle();
      await recordSchedulePass(getPool(), HEARTBEAT_KEY);
    } catch (e) {
      // W4C-s8 — an unpriced model or a step over the spend cap is a refusal to run, not a
      // crash: the cursor was never advanced (the throw happens before the note is committed,
      // `lib/dream/cycle.ts`'s `runOnce`), so tomorrow's run retries the same window rather
      // than losing it.
      if (e instanceof UnpricedModelError || e instanceof StepTooExpensiveError) {
        console.warn(`dream: the run was skipped because ${(e as Error).message}`);
        await emitSignal(
          "schedule-tick-failed",
          "dream: the run was skipped because its cost could not be bounded",
          String(e),
        );
      } else {
        console.error("dream: cycle failed", e);
        await emitSignal("schedule-tick-failed", "dream: tick failed", String(e));
      }
    } finally {
      running = false;
    }
  },
});
