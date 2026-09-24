import { pool } from "./db";
import { listAgents } from "./agents";
import type { AgentSummaryDTO, AgentStatus, AuditRowDTO } from "./contracts";
import { countByState, getLastRunAt, type DocState } from "@lares/notion-sync/lib/store.js";

export function rollupStatus(c: { waiting: number; running: number }): AgentStatus {
  if (c.waiting > 0) return "waiting";
  if (c.running > 0) return "running";
  return "idle";
}

export async function getAgentSummaries(): Promise<AgentSummaryDTO[]> {
  const agents = await listAgents();
  const { rows } = await pool
    .query<{ agent: string; status: string; n: string }>(
      `SELECT agent, status, count(*) n FROM workflow_jobs GROUP BY agent, status`,
    )
    .catch(() => ({ rows: [] as { agent: string; status: string; n: string }[] }));
  // confirmations → sessions join: schema 001_init.sql has confirmations.session_id → sessions.id
  // and sessions.agent, so we can count pending per agent directly.
  const pendRows = await pool
    .query<{ agent: string; n: string }>(
      `SELECT s.agent, count(*) n
       FROM confirmations c
       JOIN sessions s ON s.id = c.session_id
       WHERE c.status = 'pending'
       GROUP BY s.agent`,
    )
    .catch(() => ({ rows: [] as { agent: string; n: string }[] }));
  const pendingByAgent = new Map(pendRows.rows.map((r) => [r.agent, Number(r.n)]));
  return agents.map((a) => {
    const mine = rows.filter((r) => r.agent === a.name);
    const waiting = mine
      .filter((r) => r.status === "waiting")
      .reduce((s, r) => s + Number(r.n), 0);
    const running = mine
      .filter((r) => r.status === "running" || r.status === "pending")
      .reduce((s, r) => s + Number(r.n), 0);
    return {
      name: a.name,
      role: a.role,
      status: rollupStatus({ waiting, running }),
      pendingApprovals: pendingByAgent.get(a.name) ?? 0,
      capabilities: a.grants.filter((g) => g.scope !== "none").map((g) => g.capability),
    };
  });
}

export async function getAuditRows(limit = 50): Promise<AuditRowDTO[]> {
  const { rows } = await pool.query<AuditRowDTO>(
    `SELECT to_char(at,'YYYY-MM-DD HH24:MI') at, agent, action, args_summary summary
     FROM audit ORDER BY at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

export interface NotionSyncDTO {
  lastRunAt: string | null;
  synced: number;
  /**
   * `frozen` + `error` — a real queue that shrinks when a human acts. A frozen row blocks until
   * someone runs `notion-sync resolve`; the README is explicit that no pass writes a frozen row's
   * content on either side. An error is a failure.
   */
  needsYou: number;
  /** Transient and self-healing. Visible, but not a call to action. */
  retrying: number;
  /**
   * A Notion meeting row with no matching calendar event — a settled fact, not a queue. Kept on
   * screen rather than hidden: notion-sync skips an org that has an enrolled mailbox but no
   * configured client pair *silently*, and its meetings surface as ordinary unmatched rows, so a
   * climbing count here is the only signal that this is happening.
   */
  unmatched: number;
  /**
   * Set (never `false`) when the query itself failed — DB unreachable, or
   * notion_sync_docs/notion_sync_run not migrated in this environment. Distinct from
   * a clean "never run" (lastRunAt: null, zero counts) so the tile can tell an
   * operator "no data" apart from "nothing to do" instead of quietly showing zeros.
   */
  unavailable?: true;
}

/** Pure shaping, split out so it can be tested without a database. */
export function toNotionSyncDTO(
  counts: Record<DocState, number>,
  lastRunAt: Date | null,
): NotionSyncDTO {
  return {
    lastRunAt: lastRunAt === null ? null : lastRunAt.toISOString(),
    synced: counts.synced,
    needsYou: counts.frozen + counts.error,
    retrying: counts.retrying,
    unmatched: counts.unmatched,
  };
}

export async function getNotionSyncStatus(): Promise<NotionSyncDTO> {
  // Reuses the module's shared pool (same one every other query in this file uses),
  // rather than opening a fresh one: the console's credential delivery is
  // PGPASSWORD/PGPASSWORD_FILE via ./db, not agent-box's poolFromEnv Compose path.
  try {
    return toNotionSyncDTO(await countByState(pool), await getLastRunAt(pool));
  } catch {
    // Degrade like every other query below — a DB hiccup here must not take the
    // whole /integrations page down with it.
    return { lastRunAt: null, synced: 0, needsYou: 0, retrying: 0, unmatched: 0, unavailable: true };
  }
}
