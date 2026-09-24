/**
 * Persistence for studio runs. Ported verbatim from
 * `services/agent-runtime/lib/adapters/studio/store.ts` (ORB-135) with one change: the
 * `MiniPool` type is inlined below instead of imported from the old runtime's
 * `adapters/heartbeat.ts`, so nothing in this service reaches into `agent-runtime`.
 *
 * WHICH DATABASE THIS WRITES TO, and why it matters
 * -------------------------------------------------
 * `studio_runs` is deliberately UNQUALIFIED — no schema prefix — so it lands in whatever
 * database the caller's pool is connected to. In production the caller passes
 * `getPool()` from `@lares/agent-kit/db`, which reads `DATABASE_URL`, and per the port's
 * two-database decision `DATABASE_URL` STAYS on `lares_state` (only `WORKFLOW_POSTGRES_URL`
 * moves to `lares_calliope`).
 *
 * Consequence, stated so nobody rediscovers it during the cutover: this is the SAME
 * `studio_runs` table the old agent-runtime Calliope already writes to. Her run history
 * carries across the cutover instead of forking into a second, empty table. The table
 * therefore already exists on the box, and `ensureStudioTables` is idempotent, so no manual
 * DDL is needed for it — unlike `sql/001-eve-workflow.sql`, which does need applying by hand
 * into the new `lares_calliope` database (the box has no auto-migrate).
 */
import type { Pool } from "pg";
import type { StudioRun } from "./types.js";

/**
 * The one-method structural slice of a Postgres pool this module needs. `pg.Pool` satisfies
 * it structurally, so `getPool()` passes unchanged and a test can pass a recording fake
 * without a container. Same shape as the old runtime's `adapters/heartbeat.ts` export it
 * replaces — inlined rather than imported so this service has no cross-service dependency.
 */
export interface MiniPool { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }

/**
 * Type-level proof that the inlined interface above still accepts the real thing — `getPool()`
 * from `@lares/agent-kit/db` returns a `pg.Pool`. `import type` is erased, so this costs nothing
 * at runtime and nothing in the bundle; it exists so `pnpm typecheck` fails HERE, next to the
 * interface, rather than inside Task 5's tool if a `pg` upgrade ever changes `query`'s shape.
 */
type Assert<T extends true> = T;
type _PoolSatisfiesMiniPool = Assert<Pool extends MiniPool ? true : false>;

/** Idempotent — safe to call on every startup. One row per studio run; `picks` is filled
 *  later by the (deferred) UI/taste loop, so it is nullable here. */
export async function ensureStudioTables(db: MiniPool): Promise<void> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS studio_runs (
       id         uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
       brief      text          NOT NULL,
       consensus  text          NOT NULL,
       spread     jsonb         NOT NULL,
       picks      jsonb,
       principal  text          NOT NULL,
       created_at timestamptz   NOT NULL DEFAULT now()
     )`,
  );
}

export function makeStudioStore(db: MiniPool) {
  return {
    async recordRun(run: StudioRun, meta: { principal: string }): Promise<{ id: string }> {
      const { rows } = await db.query(
        `INSERT INTO studio_runs (brief, consensus, spread, principal)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [run.brief, run.consensus, JSON.stringify(run.spread), meta.principal],
      );
      return rows[0] as { id: string };
    },
  };
}
