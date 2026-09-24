// The agents on this box, as they registered themselves at start (agent-definitions spec, Part 4). Until
// 2026-09 this read the retired runtime's folder (AGENTS_DIR), which listed old-runtime agents that no
// longer run and missed Marcel entirely.
import { pool } from "./db";
import type { AutonomyLevel } from "./contracts";

export interface AgentFolder {
  name: string;
  displayName: string;
  role: string;
  /** `areas` is only ever set on the `vault` grant (agent-kit's `grantSchema`), and it is what
   *  splits that one grant into one board row per area. */
  grants: { capability: string; scope: "none" | "read" | "write" | "write-with-confirm"; areas?: string[] }[];
  autonomy: Record<string, AutonomyLevel>;
  skills: string[];
  /** ORB-278 step 2: the registry now stores each door's KIND and whether it is switched on
   *  (a door may be saved while its setup is pending). Rows written before that release hold a
   *  bare list of kinds and are read as enabled. */
  doors: { kind: string; enabled: boolean }[];
  tools: string[] | null;
  startedAt: string;
}

// The registry stores the role template id (agent.json `role`); the console shows today's chip labels.
const ROLE_LABELS: Record<string, string> = {
  "chief-of-staff": "Chief of Staff",
  travel: "Travel",
  creative: "Ideation",
};

export async function listAgents(): Promise<AgentFolder[]> {
  const { rows } = await pool
    .query<{
      name: string; display_name: string; role: string | null; grants: AgentFolder["grants"]; autonomy: Record<string, AutonomyLevel>;
      skills: unknown[]; doors: unknown[]; tools: string[] | null; started_at: Date | string;
    }>("SELECT name, display_name, role, grants, autonomy, skills, doors, tools, started_at FROM agent_registry ORDER BY name")
    .catch((err: unknown) => {
      // A silently empty list here reads as "no agents" on the permissions page — log so an
      // unreadable registry (table missing, connection down) is visible somewhere, not just absent.
      console.error(`[agents] agent registry could not be read: ${err instanceof Error ? err.message : String(err)}`);
      return { rows: [] };
    });
  return rows.map((r) => ({
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
