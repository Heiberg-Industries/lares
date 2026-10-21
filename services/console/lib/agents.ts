import { PgGrantStore } from '@lares/agent-kit/grant-store';
import type { Member } from '@lares/agent-kit/authority-contract';
// The agents on this box, as they registered themselves at start. This reads the registry rather than a
// folder, so it lists only agents that actually run.
import { pool } from "./db";
import type { AutonomyLevel } from "./contracts";

export interface AgentFolder {
  name: string;
  avatarVersion?: string;
  displayName: string;
  role: string;
  /** `areas` is only ever set on the `vault` grant (agent-kit's `grantSchema`), and it is what
   *  splits that one grant into one board row per area. */
  grants: { capability: string; scope: "none" | "read" | "write" | "write-with-confirm"; areas?: string[] }[];
  autonomy: Record<string, AutonomyLevel>;
  skills: string[];
  /**  step 2: the registry now stores each door's KIND and whether it is switched on
   *  (a door may be saved while its setup is pending). Rows written before that release hold a
   *  bare list of kinds and are read as enabled. */
  doors: { kind: string; enabled: boolean }[];
  tools: string[] | null;
  startedAt: string;
}

// The registry stores the role template id (agent.json `role`); the console shows today's chip labels.
const ROLE_LABELS: Record<string, string> = {
  "chief-of-staff": "Chief of Staff",
  creative: "Ideation",
};

export async function listAgents(options: { strict?: boolean } = {}): Promise<AgentFolder[]> {
  const { rows } = await pool
    .query<{
      name: string; display_name: string; role: string | null; grants: AgentFolder["grants"]; autonomy: Record<string, AutonomyLevel>;
      skills: unknown[]; doors: unknown[]; tools: string[] | null; started_at: Date | string;
    }>("SELECT name, display_name, role, grants, autonomy, skills, doors, tools, started_at FROM agent_registry ORDER BY name")
    .catch((err: unknown) => {
      if (options.strict) throw err;
      // A silently empty list here reads as "no agents" on the permissions page — log so an
      // unreadable registry (table missing, connection down) is visible somewhere, not just absent.
      console.error(`[agents] agent registry could not be read: ${err instanceof Error ? err.message : String(err)}`);
      return { rows: [] };
    });
  const avatars = await pool.query<{name:string;version:string}>("SELECT name, extract(epoch from updated_at)::text version FROM agent_avatars").catch(()=>({rows:[]}));
  const versions = new Map(avatars.rows.filter(a=>typeof a.version==='string').map(a=>[a.name,a.version]));
  return rows.map((r) => ({
    avatarVersion: versions.get(r.name),
    name: r.name,
    displayName: r.display_name,
    role: (r.role && ROLE_LABELS[r.role]) ?? r.role ?? "Agent",
    grants: r.grants ?? [],
    autonomy: r.autonomy ?? {},
    skills: (r.skills ?? []).map((s) => (typeof s === "string" ? s : String((s as { name?: string }).name ?? ""))),
    doors: (r.doors ?? []).map((d) => (typeof d === "string" ? { kind: d, enabled: true } : d as { kind: string; enabled: boolean })),
    tools: r.tools,
    startedAt: new Date(r.started_at).toISOString(),
  }));
}

/** Private chat exposes only authorised agent identity, never the owner console's configuration. */
export interface PrivateChatAgent { name: string; displayName: string; role: string }
export async function listPrivateChatAgents(member: Member): Promise<PrivateChatAgent[]> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const visible = await new PgGrantStore(pool).listVisible(member.id, 'agent', { db });
    const names = visible.filter(resource => resource.permissions.includes('use')).map(resource => resource.resource.id);
    if (!names.length) { await db.query('COMMIT'); return []; }
    const { rows } = await db.query<{ name: string; display_name: string; role: string }>(`SELECT r.name,g.display_name,r.applied_definition->>'role' AS role
      FROM agent_resources r JOIN agent_definitions d ON d.name=r.name JOIN agent_registry g ON g.name=r.name
      WHERE r.name=ANY($1::text[]) AND r.state='ready' AND NOT r.pending AND d.status='valid'
      AND r.runtime_control_token=r.ownership_token AND r.applied_definition->>'role' IN ('chief-of-staff','creative') ORDER BY r.name`, [names]);
    await db.query('COMMIT');
    return rows.map(row => ({ name: row.name, displayName: row.display_name, role: ROLE_LABELS[row.role] ?? 'Agent' }));
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}
