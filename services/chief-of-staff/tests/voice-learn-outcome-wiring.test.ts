import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { quiet } from "./helpers/quiet-pool.js";
import { closePool } from "@lares/agent-kit/db";

/**
 * The voice-learn schedule's real `run()`, against a real Postgres with the real migrations: what a
 * console re-learn request turns into, as the Writing style page reads it (`schedule_run`, 041).
 *
 *   - switched off in the definition → "skipped: switched-off", the request is LEFT pending, and the
 *     heartbeat does not move (a closed gate still stamps nothing — monitoring still pages);
 *   - switched off for the whole server → "skipped: schedules-off", the same way;
 *   - switched on → recorded "running" before the request is cleared, then the outcome of the run
 *     (here the mailbox cannot be opened, so "skipped: mailbox-unusable"), and the request is taken.
 *
 * The mailbox, the model gateway and Google are stubbed: no network.
 */
const here = dirname(fileURLToPath(import.meta.url));
const BOX = join(here, "..", "..", "box", "sql");
const BASELINE = readFileSync(join(BOX, "001_baseline.sql"), "utf8");
const OUTCOMES = readFileSync(join(BOX, "041_schedule_run.sql"), "utf8");

let voiceLearnOn = true;
vi.mock("../lib/definition.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/definition.js")>();
  return {
    ...actual,
    thisAgent: async (sessionId: string | undefined) => {
      const resolved = await actual.thisAgent(sessionId);
      return {
        ...resolved,
        loaded: {
          ...resolved.loaded,
          definition: { ...resolved.loaded.definition, schedules: { ...resolved.loaded.definition.schedules, "voice-learn": { on: voiceLearnOn } } },
        },
      };
    },
  };
});

/** What the schedule saw at the moment it asked for the mailbox: the run must already be recorded. */
let seenAtMailbox: { state: string | null; pending: boolean } | null = null;
/** When set, the mailbox answer waits for this promise: a run that is still going. */
let holdMailbox: Promise<void> | null = null;
let pool: Pool;
vi.mock("../lib/agent-mailbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/agent-mailbox.js")>()),
  agentMailbox: async () => {
    const run = await pool.query("SELECT state FROM schedule_run WHERE job = 'chief-of-staff/voice-learn'");
    const req = await pool.query("SELECT relearn_requested_at FROM voice_profile WHERE id = 'default'");
    seenAtMailbox = { state: run.rows[0]?.state ?? null, pending: req.rows[0]?.relearn_requested_at != null };
    if (holdMailbox) await holdMailbox;
    return { ok: false, reason: "account-not-ok" };
  },
}));

let container: StartedPostgreSqlContainer;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["EVE_SCHEDULES_LIVE", "DATABASE_URL"];
const CTX = { to: (() => {}) as never, waitUntil: (() => {}) as never, appAuth: {} as never };

async function runOnce(): Promise<void> {
  const { default: schedule } = await import("../agent/schedules/voice-learn.js");
  await schedule.run!(CTX as never);
}
const outcome = async () => (await pool.query("SELECT state, reason, agent FROM schedule_run WHERE job = 'chief-of-staff/voice-learn'")).rows[0] ?? null;
const pending = async () => (await pool.query("SELECT relearn_requested_at FROM voice_profile WHERE id = 'default'")).rows[0]?.relearn_requested_at != null;
const heartbeatAge = async (key: string) => Number((await pool.query("SELECT extract(epoch from (now() - updated_at)) AS a FROM heartbeat WHERE agent = $1", [key])).rows[0]?.a ?? -1);

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = quiet(new Pool({ connectionString: container.getConnectionUri() }));
  await pool.query(BASELINE);
  await pool.query(OUTCOMES);
}, 120_000);
afterAll(async () => { await closePool().catch(() => {}); await pool.end(); await container.stop(); });

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["DATABASE_URL"] = container.getConnectionUri();
  process.env["EVE_SCHEDULES_LIVE"] = "1";
  voiceLearnOn = true;
  seenAtMailbox = null;
  holdMailbox = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.resetModules();
  await pool.query("TRUNCATE schedule_run");
  await pool.query(`INSERT INTO voice_profile (id) VALUES ('default') ON CONFLICT (id) DO NOTHING`);
  await pool.query("UPDATE voice_profile SET relearn_requested_at = now() WHERE id = 'default'");
  await pool.query("UPDATE heartbeat SET updated_at = now() - interval '1 hour' WHERE agent LIKE 'chief-of-staff/voice-learn%'");
});
afterEach(async () => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.restoreAllMocks();
  await import("@lares/agent-kit/db").then((m) => m.closePool()).catch(() => {});
});

describe("voice-learn: what a re-learn request becomes", () => {
  it("switched off for the agent: skipped with why, the request left pending, the heartbeat untouched", async () => {
    voiceLearnOn = false;
    await runOnce();
    expect(await outcome()).toMatchObject({ state: "skipped", reason: "switched-off" });
    expect(await pending()).toBe(true);
    expect(await heartbeatAge("chief-of-staff/voice-learn/tick")).toBeGreaterThan(3500);
    expect(await heartbeatAge("chief-of-staff/voice-learn")).toBeGreaterThan(3500);
  }, 30_000);

  it("switched off: said once per request, not rewritten every minute", async () => {
    voiceLearnOn = false;
    await runOnce();
    const first = (await pool.query("SELECT updated_at FROM schedule_run")).rows[0].updated_at as Date;
    vi.resetModules();
    await runOnce();
    const second = (await pool.query("SELECT updated_at FROM schedule_run")).rows[0].updated_at as Date;
    expect(second.getTime()).toBe(first.getTime());
  }, 30_000);

  it("schedules switched off on the server: skipped with that reason, nothing stamped", async () => {
    delete process.env["EVE_SCHEDULES_LIVE"];
    await runOnce();
    expect(await outcome()).toMatchObject({ state: "skipped", reason: "schedules-off" });
    expect(await pending()).toBe(true);
    expect(await heartbeatAge("chief-of-staff/voice-learn/tick")).toBeGreaterThan(3500);
  }, 30_000);

  it("nothing asked for and switched off: records nothing", async () => {
    voiceLearnOn = false;
    await pool.query("UPDATE voice_profile SET relearn_requested_at = NULL WHERE id = 'default'");
    await runOnce();
    expect(await outcome()).toBeNull();
  }, 30_000);

  it("switched on: recorded as running before the request is cleared, then its outcome; the request is taken", async () => {
    await runOnce();
    expect(seenAtMailbox).toEqual({ state: "running", pending: false });
    expect(await outcome()).toMatchObject({ state: "skipped", reason: "mailbox-unusable" });
    expect(await pending()).toBe(false);
  }, 30_000);

  it("a request made while a run is going is taken and answered by that run, not started twice", async () => {
    let release!: () => void;
    holdMailbox = new Promise<void>((r) => { release = r; });
    const { default: schedule } = await import("../agent/schedules/voice-learn.js");
    const first = schedule.run!(CTX as never);
    await vi.waitFor(() => expect(seenAtMailbox).not.toBeNull());
    await pool.query("UPDATE voice_profile SET relearn_requested_at = now() WHERE id = 'default'");
    await schedule.run!(CTX as never);
    expect(await outcome()).toMatchObject({ state: "skipped", reason: "already-running" });
    expect(await pending()).toBe(false);
    release();
    await first;
    expect(await outcome()).toMatchObject({ state: "skipped", reason: "mailbox-unusable" });
  }, 30_000);
});
