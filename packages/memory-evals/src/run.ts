// packages/memory-evals/src/run.ts
//
// The measurement, not the model. This runs today's keyword search
// (`searchNotes` in @lares/agent-kit/notes-store) over a fixed set of
// questions an owner would plausibly ask, and records where — if at all —
// the note holding the answer showed up in the ranked results. No model is
// involved: this is a yardstick for the search+read layer alone, taken
// before anything about how memory works changes.
//
// Pure computation, no file writes here — the test file owns recording the
// baseline and asserting against it.

import { searchNotes } from "@lares/agent-kit/notes-store";

/** The seven ways a recall case can be hard — see cases/recall.json and the README. */
export const CASE_KINDS = [
  "direct",
  "paraphrase",
  "buried",
  "superseded",
  "ambiguous-name",
  "multilingual",
  "excluded",
] as const;

export type CaseKind = (typeof CASE_KINDS)[number];

export interface RecallCase {
  id: string;
  kind: CaseKind;
  /** What the owner would ask, in natural language. Not fed to search directly. */
  question: string;
  /** What an agent would plausibly type into the search tool. */
  query: string;
  /**
   * Vault-relative paths that would answer the question. Empty for `excluded`
   * cases, where the assertion is the ABSENCE of any `_meta/` path in the
   * results, not the presence of a particular one.
   */
  expect: string[];
}

export interface CaseResult {
  id: string;
  kind: CaseKind;
  /**
   * 1-based rank of the first path in `expect` among the ranked hits, or
   * `null` if none of them came back.
   *
   * For an `excluded` case (`expect` is empty) this is repurposed as a
   * clean/leak flag: `1` when nothing under `_meta/` was returned (the
   * correct outcome), `null` when something under `_meta/` leaked through.
   */
  rank: number | null;
  /** The full ranked hit list `searchNotes` returned, for the missed-case report. */
  hits: string[];
}

export interface KindStats {
  n: number;
  hitAt1: number;
  hitAt3: number;
  mrr: number;
}

export interface RecallReport {
  overall: KindStats;
  byKind: Record<CaseKind, KindStats>;
  results: CaseResult[];
}

function isExcludedPath(path: string): boolean {
  return path === "_meta" || path.startsWith("_meta/");
}

function rankOf(c: RecallCase, hits: readonly string[]): number | null {
  if (c.expect.length === 0) {
    // excluded case: success is a clean result, not a matched path.
    return hits.some(isExcludedPath) ? null : 1;
  }
  const idx = hits.findIndex((h) => c.expect.includes(h));
  return idx === -1 ? null : idx + 1;
}

function statsFor(results: readonly CaseResult[]): KindStats {
  const n = results.length;
  if (n === 0) return { n: 0, hitAt1: 0, hitAt3: 0, mrr: 0 };
  let at1 = 0;
  let at3 = 0;
  let rrSum = 0;
  for (const r of results) {
    if (r.rank !== null) {
      if (r.rank <= 1) at1++;
      if (r.rank <= 3) at3++;
      rrSum += 1 / r.rank;
    }
  }
  return { n, hitAt1: at1 / n, hitAt3: at3 / n, mrr: rrSum / n };
}

/**
 * Runs every case through `searchNotes(query, root)` and scores where the
 * expected note landed in the ranked results.
 */
export function runRecall(root: string, cases: readonly RecallCase[]): RecallReport {
  const results: CaseResult[] = cases.map((c) => {
    const { hits } = searchNotes(c.query, root);
    return { id: c.id, kind: c.kind, rank: rankOf(c, hits), hits };
  });

  const byKind = Object.fromEntries(
    CASE_KINDS.map((k) => [k, statsFor(results.filter((r) => r.kind === k))]),
  ) as Record<CaseKind, KindStats>;

  return { overall: statsFor(results), byKind, results };
}
