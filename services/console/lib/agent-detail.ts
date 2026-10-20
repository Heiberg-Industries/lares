import { pool } from "./db";
import { listAgents } from "./agents";
import type { AgentDetailDTO, CapabilityDTO, AutonomyLevel } from "./contracts";

type Row = { capability: string; action: string; level: AutonomyLevel };

export function resolveActionLevel(
  rows: Row[],
  capability: string,
  action: string,
): { level: AutonomyLevel; overridden: boolean } {
  const exact = rows.find((r) => r.capability === capability && r.action === action);
  if (exact) return { level: exact.level, overridden: true };
  const def = rows.find((r) => r.capability === capability && r.action === "");
  return { level: def?.level ?? "gated", overridden: false };
}

// One level per capability. The approval check (@lares/agent-kit/board-approval) reads only the
// capability-wide row (action = ''), so the page offers no per-action switches (final review F5).
// Meeting-series switches are real, and live on the meetings page.
export async function getAgentDetail(name: string): Promise<AgentDetailDTO> {
  const agent = (await listAgents()).find((a) => a.name === name);
  if (!agent) throw new Error(`unknown agent: ${name}`);
  const { rows } = await pool
    .query<Row>(`SELECT capability, action, level FROM ratchet WHERE agent = $1`, [name])
    .catch(() => ({ rows: [] as Row[] }));

  const capabilities: CapabilityDTO[] = agent.grants
    .filter((g) => g.scope !== "none")
    .map((g) => {
      const resolved = resolveActionLevel(rows, g.capability, "");
      const def = resolved.overridden ? resolved.level : (agent.autonomy[g.capability] ?? "gated");
      return { name: g.capability, scope: g.scope, defaultLevel: def };
    });
  return { name: agent.name, role: agent.role, status: "idle", capabilities };
}

export type PromptCacheSummary = {
  /** Model calls recorded in the window. */
  calls: number;
  /** Of those, calls that reported input tokens (the only ones the percentage can use). */
  reporting: number;
  input: number;
  cacheRead: number;
};

const CACHE_WINDOW_WORDS = "last 7 days";

const plural = (n: number) => `${n} model call${n === 1 ? "" : "s"}`;

// BASIS. The AI SDK defines `inputTokens` as the TOTAL prompt tokens, with cache reads and cache
// writes counted inside it (`inputTokenDetails` splits it into noCacheTokens + cacheReadTokens +
// cacheWriteTokens), and eve's `step.completed` usage copies those fields as they are. So the share
// read from cache is sum(cache_read) / sum(input), which cannot exceed 100%. Only calls that
// reported input tokens enter either sum; a call with no input count has no denominator, and a
// missing cache count on a call that did report input counts as zero. The "(M model calls)" is the
// number of calls the percentage is built from.
export function promptCacheLine(s: PromptCacheSummary): string {
  if (s.calls === 0) return `Prompt cache: no model calls recorded in the ${CACHE_WINDOW_WORDS}`;
  if (s.reporting === 0 || s.input <= 0) {
    return `Prompt cache: the provider did not report token counts for the ${plural(s.calls)} in the ${CACHE_WINDOW_WORDS}`;
  }
  const pct = Math.min(100, Math.round((s.cacheRead / s.input) * 100));
  return `Prompt cache: ${pct}% of input tokens read from cache, ${CACHE_WINDOW_WORDS} (${plural(s.reporting)})`;
}

// Best-effort, like the other facts on the agent page: a failed read (the table is missing on a box
// that has not applied the latest database update) shows nothing instead of breaking the page.
export async function getPromptCacheLine(agent: string): Promise<string | null> {
  try {
    const { rows } = await pool.query<{
      calls: string; reporting: string; input: string | null; cache_read: string | null;
    }>(
      `SELECT count(*) AS calls,
              count(input_tokens) AS reporting,
              sum(input_tokens) AS input,
              sum(CASE WHEN input_tokens IS NOT NULL THEN COALESCE(cache_read_tokens, 0) END) AS cache_read
         FROM model_steps
        WHERE agent = $1 AND at >= now() - interval '7 days'`,
      [agent],
    );
    const r = rows[0];
    if (!r) return null;
    return promptCacheLine({
      calls: Number(r.calls), reporting: Number(r.reporting),
      input: Number(r.input ?? 0), cacheRead: Number(r.cache_read ?? 0),
    });
  } catch {
    return null;
  }
}
