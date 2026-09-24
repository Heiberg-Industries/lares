/**
 * Lazy singleton `pg.Pool` over `DATABASE_URL`, for each agent's own domain tables
 * (reminders, schedules, trips, taste, …) — separate from `@workflow/world-postgres`'s own
 * `workflow.*`/`workflow_drizzle.*` schema (`sql/001-eve-workflow.sql`), which
 * `agent/agent.ts` connects to on its own.
 *
 * Lazy so `eve build` — which has no secrets and no live Postgres — never touches it: the
 * pool is only constructed the first time `getPool()` is actually called, not at module
 * load.
 *
 * ORB-45 lesson: a fake/mocked Pool that never executes real SQL is exactly the
 * "built+tested+non-functional" defect class that has bitten this project before — this
 * module's own test proves it against a real, disposable Postgres (testcontainers), not
 * a stub.
 */
import { Pool } from "pg";

let pool: Pool | undefined;

/** The live singleton pool, building it on first call from `env.DATABASE_URL`. Throws if
 *  unset — there is no silent fallback to a default connection string. */
export function getPool(env: NodeJS.ProcessEnv = process.env): Pool {
  if (pool === undefined) {
    const connectionString = env["DATABASE_URL"];
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set; getPool() cannot connect.");
    }
    pool = new Pool({ connectionString });
    // node-postgres emits 'error' on the pool when an IDLE client's connection dies
    // underneath it (a Postgres restart, an admin-terminated connection, a container
    // stopping). A Pool with no 'error' listener turns that into an uncaught exception
    // that kills the process — on a box, a Postgres restart would crash the agent
    // instead of letting the pool quietly discard the client and reconnect on the next
    // query. Never log the connection string, only the driver's own message.
    pool.on("error", (err: Error) => {
      console.error(`[db] idle client's connection was lost — discarding it: ${err.message}`);
    });
  }
  return pool;
}

/** Ends the singleton pool and clears it, so the next `getPool()` call builds a fresh one.
 *  Test-only escape hatch (a real process ends its pool on shutdown, not mid-run) — also
 *  useful for a graceful-shutdown hook if one is added later. */
export async function closePool(): Promise<void> {
  if (pool === undefined) return;
  const current = pool;
  pool = undefined;
  await current.end();
}
