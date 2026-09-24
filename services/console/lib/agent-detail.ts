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
