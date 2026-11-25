// What the connector pages show about which agents use a connector, read from the agents' saved definitions
// (the same source the agent pages read). A connector is matched to an agent's declaration by its technical name.
import { pool } from "./db";

export interface AgentUse {
  agent: string;
  displayName: string;
  needsKey: boolean;
  tools: { name: string; kind: "read" | "change"; free: boolean }[];
}

type Declared = { name?: unknown; token?: unknown; tools?: { allow?: unknown; read?: unknown; trusted?: unknown } };
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];

/** connector name -> the agents that have it. `null` when the definitions could not be read. The placeholder tool is never shown. */
export async function agentUsesByConnector(): Promise<Record<string, AgentUse[]> | null> {
  try {
    const { rows } = await pool.query<{ name: string; definition: { display?: unknown; outsideTools?: unknown } }>(
      `SELECT name, definition FROM agent_definitions
        WHERE status = 'valid' AND jsonb_typeof(definition->'outsideTools') = 'array' AND jsonb_array_length(definition->'outsideTools') > 0 ORDER BY name`);
    const out: Record<string, AgentUse[]> = {};
    for (const r of rows) {
      const list = Array.isArray(r.definition.outsideTools) ? r.definition.outsideTools as Declared[] : [];
      for (const s of list) {
        if (typeof s?.name !== "string") continue;
        const read = new Set(strings(s.tools?.read));
        const free = new Set(Array.isArray(s.tools?.trusted) ? (s.tools.trusted as { tool?: unknown }[]).flatMap(t => typeof t?.tool === "string" ? [t.tool] : []) : []);
        const tools = strings(s.tools?.allow).filter(t => t !== "connect-pending").map(name => ({ name, kind: read.has(name) ? "read" as const : "change" as const, free: free.has(name) }));
        (out[s.name] ??= []).push({ agent: r.name, displayName: typeof r.definition.display === "string" ? r.definition.display : r.name, needsKey: s.token === true, tools });
      }
    }
    return out;
  } catch {
    return null;
  }
}
