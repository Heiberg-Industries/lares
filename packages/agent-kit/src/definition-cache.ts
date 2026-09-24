// Fail closed, never half-configured (ADR-0015 rule 8; spec Part 2).
//
// The definition folder is mounted READ-ONLY and can be hand-edited by anyone with Claude Code
// on the box. A broken edit must not take the agent down and must not silently demote it to the
// image's neutral persona — either would be a surprise change of behaviour at 07:00. So the last
// definition that actually validated is kept in Postgres, and a session that finds a broken
// folder runs on that, loudly.
//
// THE ONE CASE THAT THROWS: a broken folder with no remembered valid one. There is nothing safe
// to run, so the agent does not start. That is the correct failure — a stranger's first
// definition being wrong should stop the container, not boot a nameless agent.
//
// THE AGENT'S IDENTITY IS AN INPUT, NEVER INFERRED. A file that failed to parse or to validate
// is exactly the file we cannot trust to tell us whose agent it is — so this module never reads
// a name off it (no regex-over-raw-text, no cross-call memo, no module-level mutable state). The
// keeper mounts one folder per agent and knows which; it passes that name in as `agentName`. A
// process resolving more than one agent (an eval fixture today, a future multi-agent host) is
// exactly the case a name inferred from content would get wrong, silently repersonating one
// agent as another — worse than the throw this module exists to avoid.
//
// With LARES_DEFINITION_DIR unset (every test, every CI build, every `eve build`) this function
// is a thin pass-through to `loadDefinition` and touches no database.
import type { Pool } from "pg";

import { getPool } from "./db.js";
import { loadDefinition, parseDefinition, type LoadedDefinition } from "./definition.js";
import { assertDefinitionValid } from "./definition-validate.js";

export interface ResolveOptions {
  serviceDir: string;
  roleMd: string;
  deployedTools: string[];
  /** Whose definition this is. Supplied by the caller (the keeper mounts one folder per agent
   *  and knows which) — never read out of the mounted folder itself, since that is precisely
   *  the file this module may not be able to trust. */
  agentName: string;
  pool?: Pool;
  env?: NodeJS.ProcessEnv;
  /** Called once when the folder is unusable and the last valid one is used instead. The role
   *  service passes its own `emitSignal`; the kit never imports a service's emitter. */
  onInvalid?: (agent: string, reason: string) => void;
}

export interface Resolved {
  loaded: LoadedDefinition;
  usedFallback: boolean;
  reason?: string;
}

export async function rememberValid(pool: Pool, loaded: LoadedDefinition): Promise<void> {
  await pool.query(
    `INSERT INTO agent_definitions (name, definition, duties, voice, hash, status, status_reason, valid_at, checked_at)
     VALUES ($1, $2::jsonb, $3, $4, $5, 'valid', NULL, now(), now())
     ON CONFLICT (name) DO UPDATE SET definition = EXCLUDED.definition, duties = EXCLUDED.duties,
       voice = EXCLUDED.voice, hash = EXCLUDED.hash, status = 'valid', status_reason = NULL,
       valid_at = now(), checked_at = now()`,
    [loaded.definition.name, JSON.stringify(loaded.definition), loaded.dutiesMd, loaded.voiceMd, loaded.hash],
  );
}

export async function lastValid(pool: Pool, agent: string): Promise<LoadedDefinition | null> {
  const { rows } = await pool.query<{ definition: unknown; duties: string; voice: string; hash: string }>(
    "SELECT definition, duties, voice, hash FROM agent_definitions WHERE name = $1",
    [agent],
  );
  const row = rows[0];
  if (!row) return null;
  const definition = parseDefinition(row.definition);
  return { definition, dutiesMd: row.duties, voiceMd: row.voice, source: "definition", dir: "<last valid>", hash: row.hash };
}

async function markInvalid(pool: Pool, agent: string, reason: string): Promise<void> {
  // Only ever an UPDATE: with no remembered row there is nothing to mark, and the caller throws.
  await pool.query(
    "UPDATE agent_definitions SET status = 'invalid', status_reason = $2, checked_at = now() WHERE name = $1",
    [agent, reason.slice(0, 2000)],
  );
}

export async function resolveDefinition(opts: ResolveOptions): Promise<Resolved> {
  const env = opts.env ?? process.env;
  const mounted = env["LARES_DEFINITION_DIR"];
  const fromFolder = typeof mounted === "string" && mounted.trim() !== "";

  // The image's own neutral files. No database, no fallback, no signal — this is the path every
  // test and every build takes.
  if (!fromFolder) {
    const loaded = await loadDefinition({ serviceDir: opts.serviceDir, env });
    return { loaded, usedFallback: false };
  }

  const pool = opts.pool ?? getPool();
  let reason: string | null = null;
  let loaded: LoadedDefinition | null = null;

  try {
    loaded = await loadDefinition({ serviceDir: opts.serviceDir, env });
    // A definition that parses and validates but names a DIFFERENT agent than the one this
    // folder is mounted for is a definition sitting in the wrong folder — e.g. someone copied
    // saga/ over marcel/. Refused exactly like any other invalid definition: fall back if there
    // is a remembered row for THIS agent, throw if there is not. Never silently repersonate.
    if (loaded.definition.name !== opts.agentName) {
      throw new Error(
        `definition at ${mounted} declares agent "${loaded.definition.name}", but this folder is mounted for ` +
          `"${opts.agentName}" — refusing to run one agent's definition under another's name`,
      );
    }
    assertDefinitionValid({
      definition: loaded.definition, roleMd: opts.roleMd, deployedTools: opts.deployedTools,
    });
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
    loaded = null;
  }

  if (loaded && reason === null) {
    await rememberValid(pool, loaded);
    return { loaded, usedFallback: false };
  }

  const previous = await lastValid(pool, opts.agentName);
  if (!previous) {
    // Nothing safe to run on. Fail closed, loudly, and let the container restart loop be visible.
    throw new Error(`definition at ${mounted} is unusable and there is no last valid one to fall back to:\n${reason}`);
  }
  await markInvalid(pool, opts.agentName, reason!);
  opts.onInvalid?.(opts.agentName, reason!);
  console.error(`[definition] ${opts.agentName}: running on the last valid definition (${previous.hash.slice(0, 12)}) — ${reason}`);
  return { loaded: previous, usedFallback: true, reason: reason! };
}
