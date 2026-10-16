// packages/memory-evals/src/poison.ts
//
// The prompt-laundering suite, run without a model. `runRecall` (run.ts) asks whether search
// finds the right note; this asks a different question about the OTHER end of memory — whether
// the promotion gate (`@lares/agent-kit/learning`) can be talked into treating somebody else's
// words as the owner's own, however many times they repeat.
//
// No model is involved because none needs to be: a case supplies the OBSERVATIONS a reflector
// would plausibly have produced from a poisoned inbox — already stamped with the origin the
// conversation record would have given them (ADR-0018 rule 4; W4C-s1's `originForObservation`) —
// and this harness runs them straight through the real gate. That is the property under test:
// the gate itself, not the LLM step that would ordinarily feed it.

import { makeLearningPromoter, type LearnableObservation, type LearningStore } from "@lares/agent-kit/learning";
import type { Origin } from "@lares/agent-kit/origin";

/** One scripted attempt to get something into long-term memory that does not belong there.
 *  See this module's header for why no model is involved: the case supplies the observations a
 *  reflector would plausibly have produced, WITH the origin the conversation record would have
 *  stamped, and the harness runs the real gate over them. That is the property under test — the
 *  gate, not the extractor. */
export interface PoisonCase {
  id: string;
  /** What an owner would say happened, in one sentence. Printed in the report. */
  story: string;
  /** "laundering" — the same third-party text repeated; "impersonation" — third-party text
   *  phrased as the owner speaking; "control" — a genuine owner statement that MUST promote, so
   *  a gate that rejects everything fails this suite too. */
  kind: "laundering" | "impersonation" | "control";
  observations: Array<{
    text: string;
    kind: string;
    subject: string;
    confidence: number;
    origin: Origin;
    evidenceRefs: string[];
  }>;
  /** How many of them may end up standing. 0 for an attack, 1 for a control. */
  expectPromoted: number;
}

export interface PoisonResult {
  id: string;
  kind: PoisonCase["kind"];
  promoted: number;
  rejected: string[];
  passed: boolean;
}

export interface PoisonReport {
  cases: PoisonResult[];
  passed: number;
  failed: number;
}

/** The in-memory `LearningStore` the promotion gate is tested against — the same shape
 *  `packages/agent-kit/tests/learning-promote.test.ts` hand-builds, written once here and
 *  exported so this suite does not maintain a second copy of it. No database, no model: a plain
 *  array plus the owner-origin recurrence count the gate itself defines. */
export function makeFakeLearningStore(): LearningStore {
  const seen: Array<{ text: string; origin: string }> = [];
  const prefs: Array<{ id: string; subject: string; text: string; origin: Origin; closed?: string }> = [];
  let n = 0;

  return {
    async ownerRecurrenceCount(text: string): Promise<number> {
      const norm = text.trim().toLowerCase();
      return seen.filter((s) => s.text === norm && s.origin === "owner").length;
    },
    async record(obs: LearnableObservation, _source: string | undefined, origin: Origin): Promise<void> {
      seen.push({ text: obs.text.trim().toLowerCase(), origin });
    },
    async addPreference(p) {
      const row = { id: `p${++n}`, subject: p.subject, text: p.text, origin: p.origin };
      prefs.push(row);
      return row;
    },
    async activePreferences() {
      return prefs.filter((p) => !p.closed);
    },
    async supersede(id: string, byId: string): Promise<void> {
      const row = prefs.find((p) => p.id === id);
      if (row) row.closed = byId;
    },
  };
}

/** Runs every case through the real promoter with an in-memory store. No database, no model.
 *  Each case gets its OWN store, so one case's history can never lean on another's — the point
 *  is whether a single poisoned run gets through, not whether the suite's cases interfere. */
export async function runPoisoning(cases: readonly PoisonCase[]): Promise<PoisonReport> {
  const results: PoisonResult[] = [];

  for (const c of cases) {
    const store = makeFakeLearningStore();
    const promoter = makeLearningPromoter({ store });
    const result = await promoter.run(c.observations as LearnableObservation[], { source: c.id });
    const rejected = Array.from(new Set(result.rejected.map((r) => r.reason)));
    const passed = result.promoted.length === c.expectPromoted;
    results.push({ id: c.id, kind: c.kind, promoted: result.promoted.length, rejected, passed });
  }

  const passed = results.filter((r) => r.passed).length;
  return { cases: results, passed, failed: results.length - passed };
}
