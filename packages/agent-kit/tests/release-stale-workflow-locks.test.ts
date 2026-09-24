import { createRequire } from "node:module";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

import { releaseStaleWorkflowLocks, workflowDatabaseUrl } from "../src/release-stale-workflow-locks.js";

/**
 * LAR-73. Real Postgres (testcontainers — the house rule from db.test.ts: a mocked pool proves
 * nothing), and graphile-worker's REAL schema, installed by the library's own `runMigrations`.
 * Not a hand-written copy of its tables: the unlock leans on `force_unlock_workers` and on the
 * `_private_jobs` / `_private_job_queues` names, and both are the library's to change.
 *
 * graphile-worker is resolved the way the runtime resolves it — as the dependency of the
 * `@workflow/world-postgres` a role service installs — so this runs against the exact version the
 * workflow queue uses, not a second pin that could drift from it (same resolution as
 * bin/regen-eve-workflow-sql.ts).
 */
type TaskList = Record<string, (payload: unknown) => Promise<void>>;
interface GraphileWorker {
  runMigrations(options: { connectionString: string }): Promise<void>;
  runOnce(options: { connectionString: string; taskList: TaskList }): Promise<void>;
}
const fromService = createRequire(new URL("../../../services/chief-of-staff/package.json", import.meta.url));
const graphile = createRequire(fromService.resolve("@workflow/world-postgres"))("graphile-worker") as GraphileWorker;

const TASK = "workflow_flows"; // the task name world-postgres queues under (dist/queue.js, getJobQueueName)

describe("releaseStaleWorkflowLocks", () => {
  let container: StartedPostgreSqlContainer;
  let url: string;
  let pool: Pool;

  const addJob = async (key: string, queueName: string | null = null): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      "SELECT id FROM graphile_worker.add_job($1, '{}'::json, queue_name => $2, job_key => $3, max_attempts => 3)",
      [TASK, queueName, key],
    );
    return r.rows[0]!.id;
  };
  /** What a worker's get_job leaves behind, with the lock taken `secondsAgo` on the database clock. */
  const lockAs = async (id: string, worker: string, secondsAgo: number): Promise<void> => {
    await pool.query(
      `UPDATE graphile_worker._private_jobs SET attempts = attempts + 1, locked_by = $2,
              locked_at = now() - make_interval(secs => $3::double precision) WHERE id = $1`,
      [id, worker, secondsAgo],
    );
    await pool.query(
      `UPDATE graphile_worker._private_job_queues q SET locked_by = $2,
              locked_at = now() - make_interval(secs => $3::double precision)
         FROM graphile_worker._private_jobs j WHERE j.id = $1 AND q.id = j.job_queue_id`,
      [id, worker, secondsAgo],
    );
  };
  const job = async (id: string) =>
    (await pool.query<{ locked_by: string | null; locked_at: Date | null; attempts: number }>(
      "SELECT locked_by, locked_at, attempts FROM graphile_worker.jobs WHERE id = $1", [id])).rows[0];
  const runOnce = async (): Promise<string[]> => {
    const ran: string[] = [];
    await graphile.runOnce({
      connectionString: url,
      taskList: { [TASK]: async (payload) => { ran.push(JSON.stringify(payload)); } },
    });
    return ran;
  };
  const lines = () => {
    const logged: string[] = [];
    const warned: string[] = [];
    return { logged, warned, log: (l: string) => logged.push(l), warn: (l: string) => warned.push(l) };
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    url = container.getConnectionUri();
    pool = new Pool({ connectionString: url });
    await graphile.runMigrations({ connectionString: url });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM graphile_worker._private_jobs");
    await pool.query("DELETE FROM graphile_worker._private_job_queues");
  });

  it("frees a job a dead worker locked before this process started, and the job runs again", async () => {
    const id = await addJob("stale");
    await lockAs(id, "worker-dead", 60);
    expect(await runOnce()).toEqual([]); // the bug: a locked job is invisible to every worker

    const out = lines();
    const released = await releaseStaleWorkflowLocks({ env: { WORKFLOW_POSTGRES_URL: url }, uptimeSeconds: () => 30, ...out });

    expect(released).toBe(1);
    // attempts is NOT reset — force_unlock_workers leaves the dead worker's attempt counted.
    expect(await job(id)).toEqual({ locked_by: null, locked_at: null, attempts: 1 });
    expect(out.logged).toHaveLength(1);
    expect(out.logged[0]).toContain("released 1 job(s)");
    expect(out.warned).toEqual([]);
    expect(await runOnce()).toHaveLength(1); // runnable at once: run_at was never pushed back
  }, 30_000);

  it("leaves a lock taken AFTER this process started alone — that worker is alive", async () => {
    const stale = await addJob("stale");
    const live = await addJob("live");
    await lockAs(stale, "worker-dead", 60);
    await lockAs(live, "worker-live", 5);

    const out = lines();
    const released = await releaseStaleWorkflowLocks({ env: { WORKFLOW_POSTGRES_URL: url }, uptimeSeconds: () => 30, ...out });

    expect(released).toBe(1);
    expect((await job(stale))?.locked_by).toBeNull();
    const kept = await job(live);
    expect(kept?.locked_by).toBe("worker-live");
    expect(kept?.locked_at).not.toBeNull();
    expect(await runOnce()).toHaveLength(1); // only the freed one; the live worker's job is not run twice
  }, 30_000);

  it("says nothing and changes nothing when every lock is younger than this process", async () => {
    const id = await addJob("live");
    await lockAs(id, "worker-live", 5);
    const out = lines();
    expect(await releaseStaleWorkflowLocks({ env: { WORKFLOW_POSTGRES_URL: url }, uptimeSeconds: () => 30, ...out })).toBe(0);
    expect((await job(id))?.locked_by).toBe("worker-live");
    expect(out.logged).toEqual([]);
    expect(out.warned).toEqual([]);
  });

  it("frees the dead worker's named-queue lock too, so the rest of that queue is not stuck behind it", async () => {
    const id = await addJob("queued", "conversation-1");
    await lockAs(id, "worker-dead", 60);
    await releaseStaleWorkflowLocks({ env: { WORKFLOW_POSTGRES_URL: url }, uptimeSeconds: () => 30, ...lines() });
    const q = await pool.query("SELECT locked_by, locked_at FROM graphile_worker._private_job_queues WHERE queue_name = 'conversation-1'");
    expect(q.rows).toEqual([{ locked_by: null, locked_at: null }]);
    expect(await runOnce()).toHaveLength(1);
  }, 30_000);

  it("returns quietly on a first boot, before graphile-worker's schema exists", async () => {
    await pool.query("CREATE DATABASE first_boot");
    const empty = new URL(url);
    empty.pathname = "/first_boot";
    const out = lines();
    expect(await releaseStaleWorkflowLocks({ env: { WORKFLOW_POSTGRES_URL: empty.toString() }, ...out })).toBe(0);
    expect(out.logged).toEqual([]);
    expect(out.warned).toEqual([]);
  });

  it("an unreachable database is one warning line, never a throw", async () => {
    const out = lines();
    const started = Date.now();
    const released = await releaseStaleWorkflowLocks({
      env: { WORKFLOW_POSTGRES_URL: "postgres://nobody@127.0.0.1:1/nowhere" },
      ...out,
    });
    expect(released).toBe(0);
    expect(out.warned).toHaveLength(1);
    expect(out.warned[0]).toContain("boot continues");
    expect(out.logged).toEqual([]);
    expect(Date.now() - started).toBeLessThan(6_000);
  }, 15_000);

  it("gives up at its overall deadline rather than holding the boot", async () => {
    const out = lines();
    expect(await releaseStaleWorkflowLocks({ env: { WORKFLOW_POSTGRES_URL: url }, overallTimeoutMs: 1, ...out })).toBe(0);
    expect(out.warned).toHaveLength(1);
    expect(out.warned[0]).toContain("gave up after 1 ms");
  });

  it("does nothing at all where no workflow database is configured (eve build)", async () => {
    const out = lines();
    expect(await releaseStaleWorkflowLocks({ env: {}, ...out })).toBe(0);
    expect(out.logged).toEqual([]);
    expect(out.warned).toEqual([]);
  });

  it("targets the database the workflow world uses: WORKFLOW_POSTGRES_URL, else DATABASE_URL", () => {
    expect(workflowDatabaseUrl({ WORKFLOW_POSTGRES_URL: "postgres://a/w", DATABASE_URL: "postgres://a/d" })).toBe("postgres://a/w");
    expect(workflowDatabaseUrl({ DATABASE_URL: "postgres://a/d" })).toBe("postgres://a/d");
    expect(workflowDatabaseUrl({})).toBeUndefined();
  });
});
