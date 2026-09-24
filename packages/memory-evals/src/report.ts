// packages/memory-evals/src/report.ts
//
// A plain fixed-width table — no chart library, no color codes — because the
// only consumer today is `console.log` in a test and a human reading CI
// output.

import { CASE_KINDS, type RecallReport } from "./run.js";
import type { PoisonReport } from "./poison.js";

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

const COLS = { kind: 14, n: 4, hit1: 7, hit3: 7, mrr: 6 } as const;

function row(kind: string, n: number, hitAt1: number, hitAt3: number, mrr: number): string {
  return (
    pad(kind, COLS.kind) +
    pad(String(n), COLS.n) +
    pad(pct(hitAt1), COLS.hit1) +
    pad(pct(hitAt3), COLS.hit3) +
    pad(mrr.toFixed(2), COLS.mrr)
  );
}

/** A fixed-width table, one row per kind plus a total row, and a list of
 *  missed case ids with the top 3 paths that came back instead. */
export function formatReport(r: RecallReport): string {
  const lines: string[] = [];
  lines.push(pad("kind", COLS.kind) + pad("n", COLS.n) + pad("hit@1", COLS.hit1) + pad("hit@3", COLS.hit3) + pad("mrr", COLS.mrr));
  lines.push("-".repeat(COLS.kind + COLS.n + COLS.hit1 + COLS.hit3 + COLS.mrr));
  for (const kind of CASE_KINDS) {
    const s = r.byKind[kind];
    lines.push(row(kind, s.n, s.hitAt1, s.hitAt3, s.mrr));
  }
  lines.push("-".repeat(COLS.kind + COLS.n + COLS.hit1 + COLS.hit3 + COLS.mrr));
  lines.push(row("total", r.overall.n, r.overall.hitAt1, r.overall.hitAt3, r.overall.mrr));

  const missed = r.results.filter((res) => res.rank === null);
  if (missed.length > 0) {
    lines.push("");
    lines.push(`missed (${missed.length}):`);
    for (const m of missed) {
      const top3 = m.hits.slice(0, 3);
      lines.push(`  ${m.id} [${m.kind}] — top hits: ${top3.length > 0 ? top3.join(", ") : "(none)"}`);
    }
  }

  return lines.join("\n");
}

/** One line per case, readable by someone who is not a developer: what was tried, whether the
 *  gate did the right thing, and — for a case that did not pass — what reason it gave. Pass/fail,
 *  never a score: see the README for why a poisoning suite must not have a "close enough". */
export function formatPoisonReport(r: PoisonReport): string {
  const lines: string[] = [];
  for (const c of r.cases) {
    const mark = c.passed ? "PASS" : "FAIL";
    const reasons = c.rejected.length > 0 ? ` (${c.rejected.join(", ")})` : "";
    lines.push(`[${mark}] ${c.id} [${c.kind}] — promoted ${c.promoted}${reasons}`);
  }
  lines.push("");
  lines.push(`${r.passed}/${r.cases.length} cases passed, ${r.failed} failed`);
  return lines.join("\n");
}
