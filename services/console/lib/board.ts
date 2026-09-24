// The permissions board (agent-definitions spec, Part 4): per agent × granted integration — the effective
// level and where it came from, the tools that always ask (and why), and the evidence from the approval
// check's own record. A change made here reaches the agent at its next action (the check caches 30 s).
import {
  areaOfTool, capabilityOfTool, mustAlwaysAsk, mustAlwaysAskExceptContact, RECIPIENT_CHECK_REASON, RECIPIENTS_OF, toolsOfCapability,
} from "@lares/agent-kit/always-ask";
import { answeredRate, couldActOnItsOwn, readApprovalCounts } from "@lares/agent-kit/approval-stats";
import { listAgents } from "./agents";
import type { AutonomyLevel, BoardRowDTO } from "./contracts";
import { pool } from "./db";

/** The 🔒 column's line for one tool, in the approval check's own order (board-approval.ts): a
 *  history-checked contact tool (RECIPIENTS_OF) skips only the first-contact lock, because at ✓
 *  it does send to people the owner has written to. */
function lockOf(tool: string): { tool: string; reason: string } | null {
  const history = RECIPIENTS_OF[tool] !== undefined;
  const f = history ? mustAlwaysAskExceptContact(tool) : mustAlwaysAsk(tool);
  if (f.ask) return { tool, reason: f.reason };
  return history ? { tool, reason: RECIPIENT_CHECK_REASON } : null;
}

/**
 * W5C-s8 — THE AREA IS THE ACTION. `vault` replaced `brain`, `atlas` and `memory`, and the
 * approval check reads a vault tool's level under `(agent, "vault", <the tool's area>)`, never the
 * capability-wide `action = ''` row. So one `vault` grant is one board ROW PER GRANTED AREA: a
 * single row would put a dial on screen that writes a key nothing reads, and would merge three
 * decisions the owner is entitled to set apart.
 *
 * The labels are the console's own words for what an area holds — the smallest mapping that keeps
 * the board readable, in the same style as the level glyphs' titles. An area with no label here
 * still shows, under its raw name: a new area is a row nobody can read, never a row nobody sees.
 */
const AREA_LABELS: Record<string, string> = {
  private: "Private notes",
  shared: "Shared notes",
  facts: "Facts",
  taste: "Taste",
};

export async function getBoardRows(): Promise<BoardRowDTO[]> {
  const agents = await listAgents();
  const [ratchet, events, counts] = await Promise.all([
    pool
      .query<{ agent: string; capability: string; action: string; level: AutonomyLevel; updated_by: string; updated_at: string }>(
        // `action = ''` is every other capability's own level; the vault rows are keyed on the area
        // instead. Nothing else is fetched — a meeting series' per-event row is not a board row.
        "SELECT agent, capability, action, level, updated_by, updated_at FROM ratchet WHERE action = '' OR capability = 'vault'",
      )
      .catch(() => ({ rows: [] as never[] })),
    pool
      .query<{ agent: string; capability: string; tool: string; decision: string; n: string; last_at: string }>(
        // Grouped by TOOL as well, because `approval_events` (038) has no action column: the area a
        // vault decision belongs to is read back off the tool's name. Every other capability sums
        // its tools straight back up, so nothing else changes.
        `SELECT agent, capability, tool, decision, count(*) AS n, max(at) AS last_at FROM approval_events
          WHERE at > now() - interval '30 days' GROUP BY agent, capability, tool, decision`,
      )
      .catch(() => ({ rows: [] as never[] })),
    // What the OWNER answered (approval_asks, box 086) — never what the policy decided (above).
    // `readApprovalCounts` never throws: a box that has not applied 086 answers [].
    readApprovalCounts(pool),
  ]);
  const out: BoardRowDTO[] = [];
  for (const a of agents) {
    for (const g of a.grants) {
      if (g.scope === "none") continue;
      // One row per granted area for `vault`; one row, no action, for everything else. A `vault`
      // grant naming no area holds no vault tool at all (agent-kit's `grantedVaultAreas`), so it
      // shows no row rather than a dial that would set nothing.
      const actions = g.capability === "vault" ? (g.areas ?? []) : [""];
      for (const action of actions) {
        const inArea = (tool: string) => g.capability !== "vault" || areaOfTool(tool) === action;
        const set = ratchet.rows.find((r) => r.agent === a.name && r.capability === g.capability && r.action === action);
        const mine = events.rows.filter((e) => e.agent === a.name && e.capability === g.capability && inArea(e.tool));
        const count = (d: string) => mine.filter((e) => e.decision === d).reduce((n, e) => n + Number(e.n), 0);
        const lastAt = mine.map((e) => new Date(e.last_at).toISOString()).sort().at(-1) ?? null;
        // What the owner answered, on this same row (approval_asks has no capability/area column
        // either — a `vault` decision is attributed back to its tool's area, exactly like `events`
        // above, so a private/shared/facts write is never counted three times on the same row).
        const answered = counts.filter((c) => c.agent === a.name && capabilityOfTool(c.tool) === g.capability && inArea(c.tool));
        const answeredSum = answered.reduce(
          (n, c) => ({ approved: n.approved + c.approved, cancelled: n.cancelled + c.cancelled, neverAnswered: n.neverAnswered + c.neverAnswered }),
          { approved: 0, cancelled: 0, neverAnswered: 0 },
        );
        // An agent registered without a tool list (its build output was not found) → the capability's
        // documented tools, so the 🔒 column is never silently empty. Only for a write-with-confirm
        // grant: a read or plain-write grant may not hold those tools, so it lists no locks.
        const tools = (a.tools
          ? a.tools.filter((t) => capabilityOfTool(t) === g.capability)
          : g.scope === "write-with-confirm" ? toolsOfCapability(g.capability) : []).filter(inArea);
        out.push({
          agent: a.name,
          displayName: a.displayName,
          capability: g.capability,
          action,
          actionLabel: action === "" ? null : AREA_LABELS[action] ?? action,
          scope: g.scope,
          level: set?.level ?? a.autonomy[g.capability] ?? "gated",
          source: set ? { kind: "board", by: set.updated_by, at: new Date(set.updated_at).toISOString() } : { kind: "definition" },
          // Only a write-with-confirm grant's tools carry the approval check. Reads are allowed while
          // granted, and a plain `write` grant's tools act without asking — a dial there would do nothing.
          controllable: g.scope === "write-with-confirm",
          lockedTools: tools.flatMap((t) => lockOf(t) ?? []),
          evidence: {
            asked: count("asked"),
            autonomous: count("autonomous"),
            denied: count("denied"),
            locked: count("locked"),
            failedClosed: count("failed-closed"),
            lastAt,
          },
          answers: { ...answeredSum, rate: answeredRate(answeredSum) },
          // A SUGGESTION, never applied: `couldActOnItsOwn` only reads `answered` (this row's own
          // tools, already scoped to this agent/capability/area above) — it writes nothing, to
          // `ratchet` or anywhere else. The owner moves the dial by hand.
          //
          // The dial is per ROW, so the sentence must be true of the row: at least one tool has
          // earned it, the row is still asking (`gated` — a row already acting on its own, or
          // switched off, gets no advice), and NO tool on the row that the dial would free has
          // ever been refused or left unanswered. A tool that always asks whatever the dial
          // says (money, delete, first contact, publishing) is not freed by it, so its refusals
          // do not count against the row.
          couldGraduate:
            (set?.level ?? a.autonomy[g.capability] ?? "gated") === "gated" &&
            couldActOnItsOwn(answered).length > 0 &&
            answered.every((c) => mustAlwaysAsk(c.tool).ask || (c.cancelled === 0 && c.neverAnswered === 0)),
        });
      }
    }
  }
  return out;
}
