// What the console can say about an agent's outside tools beyond its saved definition. Custody
// decides the source, as on the Connections page: key files live on the host, so only the keeper
// can say whether one is there (`outside.status`, presence only, never the key); the descriptions
// check lives in the box's database (`outside_tool_pins`), which the console reads. Every source
// can be unavailable, and unavailable is never shown as "missing" or "not locked".
import { pool } from "./db";
import { credentialActor } from "./credentials";
import { keeper } from "./keeper-client";
import type { Reading } from "./console-overview";

export interface DescribedTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** A tool whose descriptions stopped matching. `seenTools` null: too long to keep. `pinTools` null:
 *  recorded before descriptions were kept. */
export interface OutsideToolLock {
  pinHash: string;
  seenHash: string;
  seenAt: string;
  pinTools: DescribedTool[] | null;
  seenTools: DescribedTool[] | null;
}

export interface OutsideToolEvidence {
  /** Per tool that needs a key: true present, false missing, null the keeper could not tell. */
  keys: Reading<Record<string, boolean | null>>;
  locks: Reading<Record<string, OutsideToolLock>>;
}

const HASH = /^[a-f0-9]{64}$/;

function described(value: unknown): DescribedTool[] | null {
  if (!Array.isArray(value)) return null;
  const out: DescribedTool[] = [];
  for (const t of value) {
    if (typeof t !== "object" || t === null || typeof (t as { name?: unknown }).name !== "string") return null;
    const { name, description, inputSchema } = t as { name: string; description?: unknown; inputSchema?: unknown };
    out.push({ name, description: typeof description === "string" ? description : "", inputSchema: inputSchema ?? null });
  }
  return out;
}

async function keys(name: string): Promise<OutsideToolEvidence["keys"]> {
  const actor = await credentialActor();
  if (!actor) return { available: false };
  try {
    const raw = await keeper<{ tools?: unknown }>("outside.status", { name }, actor);
    if (!Array.isArray(raw?.tools)) return { available: false };
    const value: Record<string, boolean | null> = {};
    for (const t of raw.tools as Array<{ tool?: unknown; needsKey?: unknown; keyPresent?: unknown }>) {
      if (typeof t?.tool !== "string" || t.needsKey !== true) continue;
      value[t.tool] = typeof t.keyPresent === "boolean" ? t.keyPresent : null;
    }
    return { available: true, value };
  } catch {
    return { available: false };
  }
}

async function locks(name: string): Promise<OutsideToolEvidence["locks"]> {
  try {
    const { rows } = await pool.query<{ tool: string; pin_hash: string; seen_hash: string; seen_at: Date; pin_tools: unknown; seen_tools: unknown }>(
      `SELECT tool, pin_hash, seen_hash, seen_at, pin_tools, seen_tools FROM outside_tool_pins
       WHERE agent = $1 AND seen_hash IS NOT NULL`, [name]);
    const value: Record<string, OutsideToolLock> = {};
    for (const r of rows) {
      if (!HASH.test(r.seen_hash) || !HASH.test(r.pin_hash)) continue;
      value[r.tool] = {
        pinHash: r.pin_hash, seenHash: r.seen_hash, seenAt: new Date(r.seen_at).toISOString(),
        pinTools: described(r.pin_tools), seenTools: described(r.seen_tools),
      };
    }
    return { available: true, value };
  } catch {
    return { available: false };
  }
}

/** One keeper call and one query per page render. */
export async function getOutsideToolEvidence(name: string): Promise<OutsideToolEvidence> {
  const [k, l] = await Promise.all([keys(name), locks(name)]);
  return { keys: k, locks: l };
}

export interface DeclaredOutsideServer { name: string; needsKey: boolean; tools: string[] }
export interface DeclaredOutside { agent: string; displayName: string; servers: DeclaredOutsideServer[] }

/** Per agent with a valid definition that declares outside tools: the servers and tool names it
 *  declares. Null when the definitions could not be read. */
export async function declaredOutsideTools(): Promise<DeclaredOutside[] | null> {
  try {
    const { rows } = await pool.query<{ name: string; definition: { display?: unknown; outsideTools?: unknown } }>(
      `SELECT name, definition FROM agent_definitions
        WHERE status = 'valid' AND jsonb_typeof(definition->'outsideTools') = 'array'
          AND jsonb_array_length(definition->'outsideTools') > 0 ORDER BY name`);
    return rows.flatMap((r) => {
      const list = Array.isArray(r.definition.outsideTools) ? r.definition.outsideTools as Array<{ name?: unknown; token?: unknown; tools?: { allow?: unknown } }> : [];
      const servers = list.flatMap((s) => typeof s?.name === "string" ? [{
        name: s.name,
        needsKey: s.token === true,
        tools: Array.isArray(s.tools?.allow) ? s.tools.allow.filter((t): t is string => typeof t === "string") : [],
      }] : []);
      return servers.length ? [{ agent: r.name, displayName: typeof r.definition.display === "string" ? r.definition.display : r.name, servers }] : [];
    });
  } catch {
    return null;
  }
}

/** True when any valid agent definition declares an outside tool; null when that could not be read. */
export async function anyOutsideToolsInUse(): Promise<boolean | null> {
  try {
    const { rows } = await pool.query<{ used: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM agent_definitions
         WHERE status = 'valid' AND jsonb_typeof(definition->'outsideTools') = 'array'
           AND jsonb_array_length(definition->'outsideTools') > 0) AS used`);
    return rows[0]?.used === true;
  } catch {
    return null;
  }
}
