/**
 * src/approval-stats.ts — asked, approved, cancelled, never answered: the arithmetic over box
 * 086's `approval_asks` (`./approval-ledger.ts`). This is the denominator "What the code
 * contradicts" (5) says does not exist yet: `approval_events` (038) records what the POLICY
 * decided, never what the OWNER answered.
 *
 * TIMEOUT IS NOT A REFUSAL. `ignored`, `expired`, `invalid` and `payload-changed` — and a row with
 * no outcome at all, still parked — are all "never answered", counted separately from `cancelled`
 * and never in the approval-rate denominator (wave-7 brief).
 *
 * READS NEVER THROW. A box that has not applied 086 answers `[]`, the same shape as a box with no
 * history — the console has one sentence for both ("no answers recorded yet"), not an error path.
 */
import type { Queryable } from "@lares/vault-format/forget-ledger";
import { mustAlwaysAsk } from "./always-ask.js";

export interface ApprovalCount {
  agent: string;
  tool: string;
  asked: number;
  approved: number;
  cancelled: number;
  neverAnswered: number;
  firstAt: Date | null;
  lastAt: Date | null;
}

/** approved ÷ (approved + cancelled), or null when nobody has answered anything yet.
 *  Never-answered cards are NOT a refusal and are not in the denominator (wave 7 brief:
 *  "timeout = deny, not counted as a refusal"). */
export function answeredRate(c: Pick<ApprovalCount, "approved" | "cancelled">): number | null {
  const total = c.approved + c.cancelled;
  return total === 0 ? null : c.approved / total;
}

export const APPROVAL_STATS_DAYS = 90;

interface CountRow {
  agent: string;
  tool: string;
  asked: string;
  approved: string;
  cancelled: string;
  never_answered: string;
  first_at: Date | null;
  last_at: Date | null;
}

/** Empty on a box without 086 — never throws. */
export async function readApprovalCounts(
  db: Queryable,
  opts?: { days?: number; now?: Date },
): Promise<ApprovalCount[]> {
  const days = opts?.days ?? APPROVAL_STATS_DAYS;
  const now = opts?.now ?? new Date();
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  try {
    const { rows } = await db.query<CountRow>(
      `SELECT agent, tool,
              count(*)                                              AS asked,
              count(*) FILTER (WHERE outcome = 'approved')          AS approved,
              count(*) FILTER (WHERE outcome = 'cancelled')         AS cancelled,
              count(*) FILTER (WHERE outcome IS NULL
                                  OR outcome IN ('ignored','expired','invalid','payload-changed'))
                                                                    AS never_answered,
              min(asked_at) AS first_at, max(asked_at) AS last_at
         FROM approval_asks
        WHERE asked_at > $1
        GROUP BY agent, tool`,
      [since],
    );
    return rows.map((r) => ({
      agent: r.agent,
      tool: r.tool,
      asked: Number(r.asked),
      approved: Number(r.approved),
      cancelled: Number(r.cancelled),
      neverAnswered: Number(r.never_answered),
      firstAt: r.first_at,
      lastAt: r.last_at,
    }));
  } catch {
    return [];
  }
}

/** Ten cards, thirty days, not one refusal (owner decision B4) — the whole rule this file
 *  implements for "this could act on its own". Nothing here is a lower bound on trust, only on
 *  evidence: fewer cards or a shorter history just means the owner has not been asked enough to
 *  read anything into it yet. */
export const GRADUATION_MIN_ASKS = 10;
export const GRADUATION_MIN_DAYS = 30;

/** A tool the owner has approved every time, for long enough, and that no rule locks.
 *  A SUGGESTION: nothing in this repo may act on it. The console shows it; the owner moves
 *  the dial by hand. */
export interface Graduation {
  agent: string;
  tool: string;
  asked: number;
  sinceDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every tool whose whole recorded history is a clean "yes": no cancellation, no card left
 *  unanswered, at least `GRADUATION_MIN_ASKS` of them, spanning at least `GRADUATION_MIN_DAYS`.
 *  A tool `mustAlwaysAsk` locks (money, delete, first contact, publish, the agent's own autonomy)
 *  is never suggested, however clean its history — that lock is not the owner's dial to move, so
 *  there is nothing to suggest moving. This reads the SAME function `decideApproval` enforces,
 *  never a second hand-written list. Read-only: this never writes to `ratchet` or anywhere else —
 *  the suggestion is a sentence the console renders, and the owner moves the dial by hand. */
export function couldActOnItsOwn(counts: readonly ApprovalCount[], now: Date = new Date()): Graduation[] {
  const out: Graduation[] = [];
  for (const c of counts) {
    if (c.cancelled !== 0 || c.neverAnswered !== 0) continue;
    if (c.approved < GRADUATION_MIN_ASKS) continue;
    if (c.firstAt === null) continue;
    const sinceDays = Math.floor((now.getTime() - c.firstAt.getTime()) / DAY_MS);
    if (sinceDays < GRADUATION_MIN_DAYS) continue;
    if (mustAlwaysAsk(c.tool).ask) continue;
    out.push({ agent: c.agent, tool: c.tool, asked: c.asked, sinceDays });
  }
  return out;
}
