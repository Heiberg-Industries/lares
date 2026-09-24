/**
 * At agent start, free the workflow queue jobs a PREVIOUS, dead process of this agent left locked
 * (LAR-73).
 *
 * THE BUG. eve's production shutdown exits the process almost at once on SIGTERM
 * (`eve/internal/nitro/host/sandbox-shutdown-plugin.js`), so graphile-worker never gets to release
 * the job it was running. After a restart that landed inside a turn the workflow database holds a
 * `graphile_worker` job whose `locked_by` names a worker that no longer exists. graphile frees
 * such a lock only after FOUR HOURS (`graphile-worker/dist/sql/resetLockedAt.js`), and the
 * workflow core will not let any other message touch the step that job owned until its
 * inline-ownership lease runs out (~860 s). Every new message to that conversation waits about
 * fourteen minutes, silently. Only redelivery of the ORIGINAL message takes the core's
 * crash-recovery path — and redelivery is exactly what the stale lock prevents.
 *
 * THE FIX. graphile-worker's own supported call for "this worker is dead":
 * `graphile_worker.force_unlock_workers(worker_ids text[])`. In the installed 0.16.6
 * (`sql/000016.sql`) it sets `locked_at = null, locked_by = null` on `_private_jobs` and
 * `_private_job_queues` for those worker ids and touches nothing else — `attempts` stays as the
 * dead worker left it (already counted), `run_at` is unchanged, so the job is runnable at once.
 *
 * WHY A LIVE WORKER'S LOCK CAN NEVER BE RELEASED (releasing one would run a step twice — a second
 * model call, a second send). Three facts, each checked against the installed code:
 *
 *  1. ONE live process per workflow database. The keeper gives every agent its own database
 *     (`agent_resources.workflow_database` is UNIQUE, `services/box/sql/042_agent_resources.sql`)
 *     and one container (`services/keeper/lib/compose-agents.ts`: one `lares-<name>` service, no
 *     replicas). Two eve apps on one workflow database is already a broken arrangement — they
 *     would share one session store and one job queue (`services/creative/agent/agent.ts`) — and
 *     `eve start` runs exactly one server process per container.
 *  2. A worker id belongs to one process. graphile-worker draws a fresh random id at every start
 *     (`graphile-worker/dist/worker.js`: `worker-${randomBytes(9).toString("hex")}`), so an id
 *     that holds a lock from before this process existed cannot be this process's worker.
 *  3. This process cannot have locked anything yet. The callers `await` this at the top of
 *     `agent/instrumentation.ts`, and in the built server that module is evaluated BEFORE the HTTP
 *     server is created (`eve/internal/nitro/host/create-application-nitro.js` lists the
 *     instrumentation plugin among the Nitro plugins; the entry module calls `serve()` only after
 *     every plugin module has finished evaluating). `@workflow/world-postgres` (`dist/queue.js`,
 *     `startRunnerWhenExecutorIsReady`) holds the graphile runner until that HTTP port accepts a
 *     connection. So: unlock finishes, then the port opens, then the runner may lock its first job.
 *
 * Fact 3 is a convenience, not the only guard. "Before this process" is measured on the
 * DATABASE's clock (`now()` minus this process's uptime), never by comparing a Node timestamp with
 * a Postgres one, so clock skew between the two cannot move a live lock across the line; and
 * because of fact 2 a live worker's id never appears in the dead set even if this ran late.
 *
 * NEVER the reason an agent will not start: every failure is one warning line and the boot
 * continues; connect, each statement and the whole call are bounded to a few seconds.
 *
 * Credentials follow the one existing convention: the same connection string the workflow world
 * reads (`WORKFLOW_POSTGRES_URL`, else `DATABASE_URL` — `@workflow/world-postgres/dist/index.js`),
 * password-free, with the password in `PGPASSWORD`, which the runtime's start command exports from
 * its secret file (`images/agent-runtime/start.sh`) and `pg` reads by itself.
 */
import { Client } from "pg";

const CONNECT_TIMEOUT_MS = 3_000;
const STATEMENT_TIMEOUT_MS = 3_000;
const OVERALL_TIMEOUT_MS = 5_000;

/** The database the workflow world in this process uses — the same precedence as
 *  `@workflow/world-postgres`. `undefined` where there is none (`eve build`, unit tests). */
export function workflowDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env["WORKFLOW_POSTGRES_URL"] || env["DATABASE_URL"] || undefined;
}

export interface ReleaseStaleWorkflowLocksOptions {
  env?: NodeJS.ProcessEnv;
  /** How long this process has been alive, in seconds. Injectable for tests only. */
  uptimeSeconds?: () => number;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  connectTimeoutMs?: number;
  overallTimeoutMs?: number;
}

/** Resolves to the number of jobs released (0 when there was nothing to do, or on any failure).
 *  Never rejects. */
export async function releaseStaleWorkflowLocks(opts: ReleaseStaleWorkflowLocksOptions = {}): Promise<number> {
  const warn = opts.warn ?? ((line: string) => console.warn(line));
  const log = opts.log ?? ((line: string) => console.log(line));
  const skipped = (err: unknown): number => {
    try {
      warn(`[workflow-locks] stale job locks NOT checked, boot continues: ${err instanceof Error ? err.message : String(err)}`);
    } catch {
      // a throwing logger must not become a boot failure either
    }
    return 0;
  };

  let client: Client | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const connectionString = workflowDatabaseUrl(opts.env);
    if (!connectionString) return 0;
    const overallMs = opts.overallTimeoutMs ?? OVERALL_TIMEOUT_MS;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`gave up after ${overallMs} ms`)), overallMs);
      timer.unref?.();
    });
    const opened = new Client({
      connectionString,
      connectionTimeoutMillis: opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      query_timeout: STATEMENT_TIMEOUT_MS + 1_000,
      application_name: "lares-release-stale-workflow-locks",
    });
    client = opened;
    // A dropped connection emits 'error' on the client; unhandled, that would kill the process.
    opened.on("error", () => {});
    const work = (async (): Promise<number> => {
      await opened.connect();
      // First boot: world-postgres has not installed graphile-worker's schema yet.
      const present = await opened.query<{ present: boolean }>(
        "SELECT to_regclass('graphile_worker._private_jobs') IS NOT NULL AND to_regclass('graphile_worker._private_job_queues') IS NOT NULL AS present",
      );
      if (present.rows[0]?.present !== true) return 0;
      // Uptime is read as late as possible, so the line sits at (never before) this process's start.
      const uptime = (opts.uptimeSeconds ?? (() => process.uptime()))();
      const dead = await opened.query<{ workers: string[] | null; jobs: number }>(
        `WITH dead AS (
           SELECT locked_by FROM graphile_worker._private_jobs
            WHERE locked_by IS NOT NULL AND locked_at < now() - make_interval(secs => $1::double precision)
           UNION
           SELECT locked_by FROM graphile_worker._private_job_queues
            WHERE locked_by IS NOT NULL AND locked_at < now() - make_interval(secs => $1::double precision)
         )
         SELECT (SELECT array_agg(locked_by) FROM dead) AS workers,
                (SELECT count(*)::int FROM graphile_worker._private_jobs WHERE locked_by IN (SELECT locked_by FROM dead)) AS jobs`,
        [uptime],
      );
      const workers = dead.rows[0]?.workers ?? [];
      if (workers.length === 0) return 0;
      await opened.query("SELECT graphile_worker.force_unlock_workers($1::text[])", [workers]);
      return dead.rows[0]?.jobs ?? 0;
    })();
    // If the deadline wins, `work` is abandoned; its later rejection must not go unhandled.
    work.catch(() => {});
    const released = await Promise.race([work, deadline]);
    if (released > 0) {
      log(`[workflow-locks] released ${released} job(s) left locked by a previous process of this agent; they run again now`);
    }
    return released;
  } catch (err) {
    return skipped(err);
  } finally {
    if (timer) clearTimeout(timer);
    // Closed before returning, but never waited on for long: a connection that never opened can
    // take its own time to give up, and that must not hold the boot.
    if (client) {
      const closed = client.end().catch(() => {});
      await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 500).unref?.())]);
    }
  }
}
