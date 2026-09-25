import { listAgents, type AgentFolder } from "./agents";
import { pool } from "./db";
export type Reading<T> = { available: true; value: T } | { available: false };
export interface WorkflowCount {
  agent: string;
  status: string;
  n: number;
}
export interface FleetSnapshot {
  agents: Reading<AgentFolder[]>;
  workflows: Reading<WorkflowCount[]>;
}
export async function getFleetSnapshot(): Promise<FleetSnapshot> {
  const [agents, workflows] = await Promise.allSettled([
    listAgents({ strict: true }),
    pool.query<{ agent: string; status: string; n: string }>(
      "SELECT agent, status, count(*) n FROM workflow_jobs GROUP BY agent, status",
    ),
  ]);
  return {
    agents:
      agents.status === "fulfilled"
        ? { available: true, value: agents.value }
        : { available: false },
    workflows:
      workflows.status === "fulfilled"
        ? {
            available: true,
            value: workflows.value.rows.map((r) => ({ ...r, n: Number(r.n) })),
          }
        : { available: false },
  };
}
export interface PermissionEvent {
  id: string;
  agent: string;
  capability: string;
  tool: string;
  decision: string;
  at: string;
}
export interface EventPage {
  rows: PermissionEvent[];
  next: string | null;
}
/** Current policy evidence, not execution history or unresolved approval cards. Filter before LIMIT. */
export async function getPermissionEvents({
  agent,
  before,
  limit = 30,
}: { agent?: string; before?: string; limit?: number } = {}): Promise<
  Reading<EventPage>
> {
  const size = Math.max(1, Math.min(100, Math.floor(limit) || 30));
  const cursor = before && /^\d{1,18}$/.test(before) ? before : null;
  try {
    const result = await pool.query<{
      id: string;
      agent: string;
      capability: string;
      tool: string;
      decision: string;
      at: Date | string;
    }>(
      `SELECT id::text, agent, capability, tool, decision, at FROM approval_events
       WHERE ($1::text IS NULL OR agent=$1) AND ($2::bigint IS NULL OR id<$2)
       ORDER BY id DESC LIMIT $3`,
      [agent || null, cursor, size + 1],
    );
    const rows = result.rows
      .slice(0, size)
      .map((r) => ({ ...r, at: new Date(r.at).toISOString() }));
    return {
      available: true,
      value: { rows, next: result.rows.length > size ? rows.at(-1)!.id : null },
    };
  } catch {
    return { available: false };
  }
}
