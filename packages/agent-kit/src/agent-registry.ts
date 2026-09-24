// Each agent registers itself at start (agent-definitions spec, Part 4): name, role, grants, starting
// autonomy, skills, doors and the tools /eve/v1/info will list. The console lists agents from here instead
// of the retired runtime's folder. Never throws: registration must not be the reason an agent won't start.
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { getPool } from "./db.js";
import { doorsOf, parseDefinition } from "./definition.js";

/** The split gate's method (extract.py "available" mode): authored tools + eve framework tools that are
 *  neither disabled nor replaced by an authored one, PLUS whatever the caller's definition resolved
 *  dynamically. null when the build output is not there.
 *
 *  WHY `dynamic` HAS TO BE PASSED IN. Since ORB-278 step 2 (ADR-0015 rule 3) a role service's real
 *  tools are a POOL its `agent/tools/catalogue.ts` resolver picks from at session start, so the
 *  COMPILED MANIFEST CANNOT SEE THEM: eve records the resolver (`dynamicTools: [{slug:
 *  "catalogue"}]`) and not its entries, which is the entire point of resolving them at runtime.
 *  Read without this argument, Calliope registers three tools where she has nine, and the console
 *  tells the owner she has lost her Atlas. The engine cannot compute the list itself — the pool is
 *  a module in the service, and which of it is granted depends on the definition — so the service
 *  hands over `grantedToolNames(CATALOGUE, definition)` from its own instrumentation. */
export async function readResolvedTools(
  serviceDir: string,
  opts: { dynamic?: readonly string[] } = {},
): Promise<string[] | null> {
  try {
    const m = JSON.parse(await readFile(join(serviceDir, ".output/.eve/compile/compiled-agent-manifest.json"), "utf8")) as {
      tools?: Array<{ name: string }>; disabledFrameworkTools?: string[];
    };
    const eve = await realpath(join(serviceDir, "node_modules/eve"));
    const fw = (await import(pathToFileURL(join(eve, "dist/src/runtime/framework-tools/index.js")).href)) as {
      getAllFrameworkToolNames(): Iterable<string>;
    };
    const authored = (m.tools ?? []).map((t) => t.name);
    const disabled = new Set(m.disabledFrameworkTools ?? []);
    const active = [...fw.getAllFrameworkToolNames()].filter((n) => !disabled.has(n) && !authored.includes(n));
    // A dynamic entry OVERRIDES an authored file of the same name rather than duplicating it
    // (Task 1, Q1b — measured), so the union is deduplicated rather than concatenated.
    return [...new Set([...authored, ...active, ...(opts.dynamic ?? [])])].sort();
  } catch {
    return null;
  }
}

export async function registerAgent(opts: {
  manifest: unknown;
  serviceDir?: string;
  pool?: Pool;
  /** What this agent's catalogue resolver hands over for the definition being registered. */
  dynamicTools?: readonly string[];
}): Promise<void> {
  try {
    // ORB-278 step 2: a DEFINITION, not a manifest. `definitionSchema` is `manifestSchema`
    // extended, so every check this made before still runs; what it gains is the definition-only
    // fields — including `doors`, which carries each door's enabled flag where `channels` was a
    // bare list of kinds.
    const m = parseDefinition(opts.manifest);
    const tools = await readResolvedTools(opts.serviceDir ?? process.cwd(), {
      ...(opts.dynamicTools !== undefined ? { dynamic: opts.dynamicTools } : {}),
    });
    const pool = opts.pool ?? getPool();
    await pool.query(
      `INSERT INTO agent_registry (name, display_name, role, grants, autonomy, skills, doors, tools, started_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, now())
       ON CONFLICT (name) DO UPDATE SET display_name = EXCLUDED.display_name, role = EXCLUDED.role,
         grants = EXCLUDED.grants, autonomy = EXCLUDED.autonomy, skills = EXCLUDED.skills,
         doors = EXCLUDED.doors, tools = EXCLUDED.tools, started_at = now()`,
      [
        m.name,
        m.display ?? m.name,
        m.role ?? null,
        JSON.stringify(m.grants),
        JSON.stringify(m.autonomy),
        JSON.stringify(m.skills),
        // `doorsOf` falls back to the legacy `channels` list, so a definition that has not
        // declared `doors` yet still registers every door it actually has, enabled.
        JSON.stringify(doorsOf(m)),
        tools === null ? null : JSON.stringify(tools),
      ],
    );
    if (tools === null) console.warn(`[registry] ${m.name}: registered WITHOUT a tool list (no build output found)`);
  } catch (err) {
    console.error(`[registry] agent not registered: ${(err as Error).message}`);
  }
}
