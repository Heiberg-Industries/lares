// ADR-0018 ("Agents learn by adding; consolidation proposes, never edits in place; third-party
// content never becomes memory") rule 3: dreaming — and every other schedule that learns from
// conversation content and writes it back unattended — ships OFF for a new installation until
// the safe promotion gate (rules 2, 4-8 of that decision) has landed. `docs/decisions/
// 0018-learning-and-dreaming.md` states the rule; this test pins it so a future template can't
// silently ship one of these schedules on before the safe version exists.
//
// SILENCE MEANS ON (`packages/agent-kit/src/schedule-switch.ts`): a schedule with no entry in a
// definition's `schedules` block runs. So "off" here can only mean one thing — an EXPLICIT
// `{ "on": false }` entry. A missing entry is exactly as unsafe as `{ "on": true }`.
//
// The table below is hand-maintained, not derived, because "does this schedule learn from
// conversation and write memory unattended" is a judgement call the code can't make for itself —
// see each row's `why` and the `scheduleEnabled(definition, "<name>")` call site it cites.
//
// When ADR-0018's safe promotion gate ships, the fix flips the relevant row's template entry to
// `{ "on": true }` — this test then goes red for that role/schedule until the template is
// updated, which is the point: the flip is a decision someone reads, not a diff nobody notices.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDefinition } from "../src/definition.js";

const ROOT = resolve(__dirname, "../templates");

interface LearningSchedule {
  role: string;
  schedule: string;
  /** Why this schedule counts as "learns from conversations or writes learned memory
   *  unattended" under ADR-0018, and where it checks `scheduleEnabled`. */
  why: string;
}

const LEARNING_SCHEDULES: LearningSchedule[] = [
  {
    role: "chief-of-staff",
    schedule: "dream",
    why:
      "the nightly reflect -> promote cycle (services/chief-of-staff/lib/dream/{reflect,promote}.ts) " +
      "reads conversation logs unattended and writes dream_preferences directly, bypassing the " +
      "always-ask approval machinery entirely (ADR-0018 Context) — the exact mechanism the decision " +
      "targets. Consulted at services/chief-of-staff/agent/schedules/dream.ts:179.",
  },
  {
    role: "chief-of-staff",
    schedule: "voice-learn",
    why:
      "the weekly voice-learn job (services/chief-of-staff/lib/voice-learn.ts) reads a mailbox's " +
      "Sent mail unattended, distills it with an LLM, and writes voice_exemplar rows and a proposed " +
      "voice-profile card with no owner in the room. It writes a learned profile from conversation " +
      "content on a schedule, the shape ADR-0018 rule 3 covers even though today's writes are " +
      "additive. Consulted at services/chief-of-staff/agent/schedules/voice-learn.ts:181.",
  },
];

describe("every shipped role template has its learning schedules explicitly off (ADR-0018)", () => {
  for (const { role, schedule, why } of LEARNING_SCHEDULES) {
    it(`${role}'s "${schedule}" schedule ships with an explicit { "on": false } — ${why}`, () => {
      const raw = JSON.parse(readFileSync(resolve(ROOT, role, "definition.json"), "utf8"));
      const d = parseDefinition(raw);
      const entry = d.schedules[schedule];

      // Silence means on — a missing entry is a failure here, not a pass.
      expect(
        entry,
        `${role}: "${schedule}" has no explicit schedule entry in definition.json. ` +
          `Silence means ON (schedule-switch.ts) — ADR-0018 requires an explicit { "on": false } ` +
          `until the safe promotion gate (rules 2, 4-8) has shipped.`,
      ).toBeDefined();
      expect(
        entry?.on,
        `${role}: "${schedule}" is ON in the shipped template. ADR-0018 rule 3: this schedule ` +
          `learns from conversations unattended and must ship off until the safe version lands — ` +
          `flip this to true only in the commit that lands it.`,
      ).toBe(false);
    });
  }
});
