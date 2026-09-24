// Proves 006-eve-workflow-beta32-to-beta42-upgrade.sql (W2-s8c): the step an existing
// installation runs, once, by hand, so its real workflow.workflow_events rows survive the
// @workflow/world-postgres beta.32 → beta.42 regeneration of 001-eve-workflow.sql.
//
// Real Postgres, real SQL — this is exactly the kind of change a fake connection cannot prove
// (the ORB-45 lesson other tests in this directory already cite). Four cases, matching the
// ticket's proof requirements (a)-(d):
//
//   (a) OLD file, with real rows, → upgrade file → NEW file: all succeed, rows unchanged.
//   (b) upgrade file run twice in a row: the second run changes nothing.
//   (c) a database that never saw ANY version of the schema → upgrade file → NEW file: succeeds.
//   (d) NEW file (already the new shape) → upgrade file: succeeds, changes nothing.
//
// (e), from the ticket, is not a runtime case — it is an algebraic fact, checked here in
// prose rather than in a query: the OLD primary key was on `id` ALONE, so every `id` already
// unique across the WHOLE table. A composite key on `(run_id, id)` can never be a stronger
// requirement than that, so `ADD CONSTRAINT ... PRIMARY KEY (run_id, id)` cannot fail on
// duplicate values for any table that legitimately had the old key. Case (a) below inserts two
// rows sharing one run_id specifically to exercise this — under the old schema they were only
// unique by `id`; under the new one they must remain distinct by `(run_id, id)` too, and they
// are, because their `id`s already differed.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dirname;
const OLD_SQL = readFileSync(join(here, "fixtures", "001-eve-workflow-beta32-pre-regeneration.sql"), "utf8");
const UPGRADE_SQL = readFileSync(join(here, "..", "sql", "006-eve-workflow-beta32-to-beta42-upgrade.sql"), "utf8");
const NEW_SQL = readFileSync(join(here, "..", "sql", "001-eve-workflow.sql"), "utf8");

/** Three rows sharing one run_id on purpose — see the header note on case (e). */
const SEED_ROWS: Array<{
  id: string;
  type: string;
  correlation_id: string | null;
  run_id: string;
  payload: string | null;
  spec_version: number | null;
}> = [
  { id: "01HZYULIDONE00000000000001", type: "step_created", correlation_id: "corr-1", run_id: "run-1", payload: '{"a":1}', spec_version: 1 },
  { id: "01HZYULIDONE00000000000002", type: "attr_set", correlation_id: null, run_id: "run-1", payload: null, spec_version: 2 },
  { id: "01HZYULIDTWO00000000000001", type: "hook_created", correlation_id: "corr-2", run_id: "run-2", payload: '{"b":2}', spec_version: 1 },
];

async function seedRows(pool: Pool): Promise<void> {
  for (const row of SEED_ROWS) {
    await pool.query(
      `INSERT INTO workflow.workflow_events (id, type, correlation_id, run_id, payload, spec_version)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [row.id, row.type, row.correlation_id, row.run_id, row.payload, row.spec_version],
    );
  }
}

/** Every column that matters for "the rows are still there, byte-for-byte" — cast to text so
 *  jsonb/bytea round-tripping through the driver never masks a real difference or invents one. */
async function readRows(pool: Pool): Promise<unknown[]> {
  const { rows } = await pool.query(
    `SELECT id, type, correlation_id, run_id, payload::text AS payload, spec_version
       FROM workflow.workflow_events
      ORDER BY id`,
  );
  return rows;
}

async function constraintExists(pool: Pool, name: string, schema = "workflow"): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM pg_constraint WHERE conname = $1 AND connamespace = $2::regnamespace`,
    [name, schema],
  );
  return rows.length > 0;
}

/** Any relation — index or table — by its schema-qualified name. */
async function relationExists(pool: Pool, schema: string, name: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [`${schema}.${name}`]);
  return Boolean(rows[0]?.present);
}

describe("eve workflow schema upgrade: beta.32 → beta.42 (W2-s8c)", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  // Every test starts from a database that has never seen any version of this schema — the
  // cleanest way to prove each case's OWN starting state rather than carrying state between them.
  beforeEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS workflow CASCADE; DROP SCHEMA IF EXISTS workflow_drizzle CASCADE;`);
  });

  it("(a) OLD file + real rows → upgrade → NEW file: succeeds, rows unchanged, new key in place", async () => {
    await pool.query(OLD_SQL);
    await seedRows(pool);
    const before = await readRows(pool);
    expect(before).toHaveLength(3);

    await pool.query(UPGRADE_SQL);
    await pool.query(NEW_SQL);

    const after = await readRows(pool);
    expect(after).toEqual(before);

    expect(await constraintExists(pool, "workflow_events_pkey")).toBe(false);
    expect(await constraintExists(pool, "workflow_events_run_id_id_pk")).toBe(true);
    expect(await relationExists(pool, "workflow", "workflow_events_run_id_index")).toBe(false);
    // The new table the regenerated file adds is now there too.
    expect(await relationExists(pool, "workflow", "workflow_event_slots")).toBe(true);
  });

  it("(b) upgrade file run twice in a row: the second run is a no-op", async () => {
    await pool.query(OLD_SQL);
    await seedRows(pool);
    await pool.query(UPGRADE_SQL);
    const after1 = await readRows(pool);

    // Running it again must not throw, must not touch the rows, and must not re-add or
    // duplicate the constraint.
    await expect(pool.query(UPGRADE_SQL)).resolves.toBeDefined();
    const after2 = await readRows(pool);
    expect(after2).toEqual(after1);
    expect(await constraintExists(pool, "workflow_events_run_id_id_pk")).toBe(true);

    // NEW file still applies cleanly on top after the repeated run.
    await expect(pool.query(NEW_SQL)).resolves.toBeDefined();
  });

  it("(c) a database that never had ANY version of the schema → upgrade file → NEW file: succeeds", async () => {
    // beforeEach already dropped both schemas — this database has never run any 001-eve-workflow.sql.
    await expect(pool.query(UPGRADE_SQL)).resolves.toBeDefined();
    await expect(pool.query(NEW_SQL)).resolves.toBeDefined();

    expect(await constraintExists(pool, "workflow_events_run_id_id_pk")).toBe(true);
    expect(await constraintExists(pool, "workflow_events_pkey")).toBe(false);
  });

  it("(d) NEW file (already the new shape) → upgrade file: succeeds, changes nothing", async () => {
    await pool.query(NEW_SQL);
    await pool.query(
      `INSERT INTO workflow.workflow_events (id, type, correlation_id, run_id, payload, spec_version)
       VALUES ('evnt_0000000001', 'step_created', NULL, 'run-9', NULL, 1)`,
    );
    const before = await readRows(pool);

    await expect(pool.query(UPGRADE_SQL)).resolves.toBeDefined();

    const after = await readRows(pool);
    expect(after).toEqual(before);
    expect(await constraintExists(pool, "workflow_events_run_id_id_pk")).toBe(true);
    expect(await constraintExists(pool, "workflow_events_pkey")).toBe(false);
  });
});
