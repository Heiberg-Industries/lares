// What the connector pages show about which agents use a connector, read from the agents' saved definitions
// (the same source the agent pages read). A connector is matched to an agent's declaration by its technical name.
import { toolPinHash } from "@lares/agent-kit/outside-pins";
import { pool } from "./db";

export interface AgentUse {
  agent: string;
  displayName: string;
  needsKey: boolean;
  /** `danger`: the designated owner let this tool, which changes something, run without asking (`on`), or did and the tool's description changed since,
   *  so it is switched off again (`changed`). */
  tools: { name: string; kind: "read" | "change"; free: boolean; danger?: "on" | "changed" | null }[];
}

type Declared = { name?: unknown; token?: unknown; tools?: { allow?: unknown; read?: unknown; trusted?: unknown; danger?: unknown } };
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];

/** connector name -> the agents that have it. `null` when the definitions could not be read. The placeholder tool is never shown. */
export async function agentUsesByConnector(): Promise<Record<string, AgentUse[]> | null> {
  try {
    const { rows } = await pool.query<{ name: string; definition: { display?: unknown; outsideTools?: unknown } }>(
      `SELECT name, definition FROM agent_definitions
        WHERE status = 'valid' AND jsonb_typeof(definition->'outsideTools') = 'array' AND jsonb_array_length(definition->'outsideTools') > 0 ORDER BY name`);
    const out: Record<string, AgentUse[]> = {};
    // A danger-zone permission is bound to the description the owner typed the name against. If the stored description now hashes
    // differently (or is gone), the runtime has already stopped it, and the page says so instead of showing a live red badge.
    const pins = new Map<string, Map<string, string>>();
    const wanted = rows.filter(r => Array.isArray(r.definition.outsideTools) && (r.definition.outsideTools as Declared[]).some(s => Array.isArray(s?.tools?.danger) && s.tools.danger.length > 0)).map(r => r.name);
    if (wanted.length > 0) {
      const found = await pool.query<{ agent: string; tool: string; pin_tools: unknown }>("SELECT agent, tool, pin_tools FROM outside_tool_pins WHERE agent = ANY($1::text[]) AND seen_hash IS NULL", [wanted]);
      for (const p of found.rows) {
        const byName = new Map<string, string>();
        if (Array.isArray(p.pin_tools)) for (const t of p.pin_tools as { name?: unknown; description?: unknown; inputSchema?: unknown }[]) if (typeof t?.name === "string")
          byName.set(t.name, toolPinHash({ name: t.name, ...(typeof t.description === "string" ? { description: t.description } : {}), inputSchema: t.inputSchema }));
        pins.set(`${p.agent}\u0000${p.tool}`, byName);
      }
    }
    for (const r of rows) {
      const list = Array.isArray(r.definition.outsideTools) ? r.definition.outsideTools as Declared[] : [];
      for (const s of list) {
        if (typeof s?.name !== "string") continue;
        const read = new Set(strings(s.tools?.read));
        const free = new Set(Array.isArray(s.tools?.trusted) ? (s.tools.trusted as { tool?: unknown }[]).flatMap(t => typeof t?.tool === "string" ? [t.tool] : []) : []);
        const dangerPins = new Map<string, string>(Array.isArray(s.tools?.danger) ? (s.tools.danger as { tool?: unknown; pin?: unknown }[]).flatMap(t => typeof t?.tool === "string" && typeof t?.pin === "string" ? [[t.tool, t.pin] as [string, string]] : []) : []);
        const now = pins.get(`${r.name}\u0000${s.name}`);
        const tools = strings(s.tools?.allow).filter(t => t !== "connect-pending").map(name => {
          const kind = read.has(name) ? "read" as const : "change" as const, bound = dangerPins.get(name);
          const danger = kind === "change" && bound !== undefined ? (now?.get(name) === bound ? "on" as const : "changed" as const) : null;
          return { name, kind, free: free.has(name), danger };
        });
        (out[s.name] ??= []).push({ agent: r.name, displayName: typeof r.definition.display === "string" ? r.definition.display : r.name, needsKey: s.token === true, tools });
      }
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Per agent: the tool names that agent has read from this connector's server (the descriptions it pinned). Only these may be switched
 * on for it again; a tool it never read must go through discovery and review first. Empty when nothing was kept or it could not be read.
 */
export async function knownToolNames(agents: string[], slug: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  if (agents.length === 0) return out;
  try {
    const { rows } = await pool.query<{ agent: string; pin_tools: unknown }>("SELECT agent, pin_tools FROM outside_tool_pins WHERE agent = ANY($1::text[]) AND tool = $2 AND pin_tools IS NOT NULL", [agents, slug]);
    for (const r of rows) if (Array.isArray(r.pin_tools)) for (const t of r.pin_tools as { name?: unknown }[]) if (typeof t?.name === "string" && t.name !== "connect-pending") (out[r.agent] ??= []).push(t.name);
    return out;
  } catch {
    return {};
  }
}
