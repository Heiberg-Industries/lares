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
 * Each agent records under its own name (`<agent>/voice-learn`): the agent under test is called
 * `first-agent`, and another chief-of-staff agent on the same installation is `other-agent`, whose
 * record this agent must never write and whose run that is going must still hold the request.
 *
 * The mailbox, the model gateway and Google are stubbed: no network.
 */
const here = dirname(fileURLToPath(import.meta.url));
const BOX = join(here, "..", "..", "box", "sql");
const BASELINE = readFileSync(join(BOX, "001_baseline.sql"), "utf8");
const OUTCOMES = readFileSync(join(BOX, "041_schedule_run.sql"), "utf8");

let voiceLearnOn = true;
/** The definition name of the agent under test. */
let agentName = "first-agent";
const OWN = "first-agent/voice-learn";
const OTHER = "other-agent/voice-learn";
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
          definition: { ...resolved.loaded.definition, name: agentName, schedules: { ...resolved.loaded.definition.schedules, "voice-learn": { on: voiceLearnOn } } },
        },
      };
    },
  };
});

/** What the schedule saw at the moment it asked for the mailbox: the run must already be recorded. */
let seenAtMailbox: { state: string | null; pending: boolean } | null = null;
/** When set, the mailbox answer waits for this promise: a run that is still going. */
let holdMailbox: Promise<void> | null = null;
/** When set, only the first mailbox lookup waits for `holdMailbox`. */
let holdFirstOnly = false;
let mailboxLookups = 0;
let pool: Pool;
/** When set, another agent takes the request while this one looks up its hour. */
let otherAgentClaims = false;
vi.mock("../lib/schedule-hours.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/schedule-hours.js")>();
  return {
    ...actual,
    scheduleHours: async (schedule: string) => {
      if (otherAgentClaims) await pool.query("UPDATE voice_profile SET relearn_requested_at = NULL WHERE id = 'default'");
      return actual.scheduleHours(schedule);
    },
  };
});
vi.mock("../lib/agent-mailbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/agent-mailbox.js")>()),
  agentMailbox: async () => {
    const run = await pool.query("SELECT state FROM schedule_run WHERE job = $1", [`${agentName}/voice-learn`]);
    const req = await pool.query("SELECT relearn_requested_at FROM voice_profile WHERE id = 'default'");
    seenAtMailbox ??= { state: run.rows[0]?.state ?? null, pending: req.rows[0]?.relearn_requested_at != null };
    mailboxLookups += 1;
    if (holdMailbox && (!holdFirstOnly || mailboxLookups === 1)) await holdMailbox;
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
const outcomeOf = async (job: string) => (await pool.query("SELECT state, reason, agent FROM schedule_run WHERE job = $1", [job])).rows[0] ?? null;
const outcome = () => outcomeOf(OWN);
const pending = async () => (await pool.query("SELECT relearn_requested_at FROM voice_profile WHERE id = 'default'")).rows[0]?.relearn_requested_at != null;
/** A chief-of-staff agent's saved definition row, as the keeper keeps it (`status`: valid, invalid or retired). */
const defineAgent = (name: string, status = "valid") => pool.query(
  `INSERT INTO agent_definitions (name, definition, hash, status) VALUES ($1, $2, 'fixture-hash', $3)
   ON CONFLICT DO NOTHING`,
  [name, JSON.stringify({ name, role: "chief-of-staff" }), status],
);
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
  agentName = "first-agent";
  seenAtMailbox = null;
  holdMailbox = null;
  holdFirstOnly = false;
  mailboxLookups = 0;
  otherAgentClaims = false;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.resetModules();
  await pool.query("TRUNCATE schedule_run");
  await pool.query("DELETE FROM agent_definitions WHERE name IN ('first-agent', 'other-agent')");
  await defineAgent("first-agent");
  await defineAgent("other-agent");
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

  it("a request another agent took first is not run a second time, and this agent records nothing", async () => {
    // Another agent's claim lands between this agent seeing the request and taking it: simulated
    // inside the hour lookup, which runs between the two.
    otherAgentClaims = true;
    await runOnce();
    expect(seenAtMailbox).toBeNull();
    expect(await pending()).toBe(false);
    expect(await outcome()).toBeNull();
  }, 30_000);

  it("switched off here while another agent takes the request: the other agent's run is not overwritten with a skip", async () => {
    voiceLearnOn = false;
    // The other agent claims and records its run in a transaction that is still open while this
    // agent looks: this agent must wait for it, see the request gone, and write nothing.
    const other = await pool.connect();
    try {
      await other.query("BEGIN");
      await other.query("UPDATE voice_profile SET relearn_requested_at = NULL WHERE id = 'default'");
      await other.query("INSERT INTO schedule_run (job, agent, state) VALUES ('other-agent/voice-learn', 'other-agent', 'running')");
      const tick = runOnce();
      await new Promise((r) => setTimeout(r, 750));
      await other.query("COMMIT");
      await tick;
    } finally {
      other.release();
    }
    expect(await outcomeOf(OTHER)).toMatchObject({ state: "running", agent: "other-agent" });
    expect(await outcome()).toBeNull();
  }, 30_000);

  it("a request that arrives just as a run ends is left for the next tick, not written over the finished outcome", async () => {
    let release!: () => void;
    holdMailbox = new Promise<void>((r) => { release = r; });
    const { default: schedule } = await import("../agent/schedules/voice-learn.js");
    const first = schedule.run!(CTX as never);
    await vi.waitFor(() => expect(seenAtMailbox).not.toBeNull());
    // The run has recorded its end; this process has not yet left its run.
    await pool.query("UPDATE schedule_run SET state = 'finished', counts = '{\"kept\": 3}'::jsonb WHERE job = $1", [OWN]);
    await pool.query("UPDATE voice_profile SET relearn_requested_at = now() WHERE id = 'default'");
    await schedule.run!(CTX as never);
    expect(await outcome()).toMatchObject({ state: "finished" });
    expect(await pending()).toBe(true);
    release();
    await first;
  }, 30_000);

  it("an outcome row someone else is writing never makes this agent hold the request: it waits for the next tick", async () => {
    await pool.query("INSERT INTO schedule_run (job, state) VALUES ($1, 'finished')", [OWN]);
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM schedule_run WHERE job = $1 FOR UPDATE", [OWN]);
      const started = Date.now();
      await runOnce();
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(seenAtMailbox).toBeNull();
      expect(await pending()).toBe(true);
      // The request row is free: nothing is left holding it.
      await expect(pool.query("SELECT 1 FROM voice_profile WHERE id = 'default' FOR UPDATE NOWAIT")).resolves.toBeDefined();
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
    }
  }, 30_000);

  it("a blocked outcome write inside the claim is cancelled on the server and the claim still commits", async () => {
    // The outcome row is free when the claim looks, then taken by someone else before the started
    // record is written: simulated with a trigger that waits on an advisory lock this test holds.
    const holder = await pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(4242)");
      await pool.query(`CREATE OR REPLACE FUNCTION test_slow_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(4242); RETURN NEW; END $$`);
      await pool.query(`CREATE TRIGGER test_slow_outcome BEFORE INSERT OR UPDATE ON schedule_run
        FOR EACH ROW WHEN (NEW.state = 'running') EXECUTE FUNCTION test_slow_outcome()`);
      const tick = runOnce();
      await new Promise((r) => setTimeout(r, 6_500));
      // Past the 4 s server-side limit: the started record was cancelled, the claim committed.
      expect(await pending()).toBe(false);
      await holder.query("SELECT pg_advisory_unlock(4242)");
      await tick;
    } finally {
      await holder.query("SELECT pg_advisory_unlock_all()").catch(() => {});
      holder.release();
      await pool.query("DROP TRIGGER IF EXISTS test_slow_outcome ON schedule_run");
      await pool.query("DROP FUNCTION IF EXISTS test_slow_outcome()");
    }
  }, 40_000);

  it("another agent's run that is going holds the request: no second run, and the request waits", async () => {
    await pool.query("INSERT INTO schedule_run (job, agent, state, started_at) VALUES ('other-agent/voice-learn', 'other-agent', 'running', now())");
    await runOnce();
    expect(seenAtMailbox).toBeNull();
    expect(await pending()).toBe(true);
    expect(await outcomeOf(OTHER)).toMatchObject({ state: "running", agent: "other-agent" });
    expect(await outcome()).toBeNull();
  }, 30_000);

  it("a run that has said nothing for hours is treated as gone: the request is taken and run", async () => {
    await pool.query(`INSERT INTO schedule_run (job, agent, state, started_at, updated_at)
      VALUES ('other-agent/voice-learn', 'other-agent', 'running', now() - interval '3 hours', now() - interval '3 hours')`);
    await runOnce();
    expect(seenAtMailbox).toEqual({ state: "running", pending: false });
    expect(await pending()).toBe(false);
  }, 30_000);

  it("switched off here while another agent is learning: its run is kept, and this agent's skip goes on its own record", async () => {
    voiceLearnOn = false;
    await pool.query("INSERT INTO schedule_run (job, agent, state, started_at) VALUES ('other-agent/voice-learn', 'other-agent', 'running', now())");
    await runOnce();
    expect(await outcomeOf(OTHER)).toMatchObject({ state: "running", agent: "other-agent" });
    expect(await outcome()).toMatchObject({ state: "skipped", reason: "switched-off", agent: "first-agent" });
    expect(await pending()).toBe(true);
  }, 30_000);

  it("a second press during the same run is covered by that run too", async () => {
    let release!: () => void;
    holdMailbox = new Promise<void>((r) => { release = r; });
    const { default: schedule } = await import("../agent/schedules/voice-learn.js");
    const first = schedule.run!(CTX as never);
    await vi.waitFor(() => expect(seenAtMailbox).not.toBeNull());
    for (let press = 0; press < 2; press += 1) {
      await pool.query("UPDATE voice_profile SET relearn_requested_at = now() WHERE id = 'default'");
      await schedule.run!(CTX as never);
      expect(await pending(), `press ${press + 1}`).toBe(false);
      expect(await outcome()).toMatchObject({ state: "skipped", reason: "already-running" });
    }
    release();
    await first;
  }, 30_000);

  it("records under this agent's own name, not under a key every agent shares", async () => {
    await runOnce();
    expect(await outcomeOf(OWN)).toMatchObject({ state: "skipped", reason: "mailbox-unusable", agent: "first-agent" });
    expect(await outcomeOf("chief-of-staff/voice-learn")).toBeNull();
    // The heartbeat is the schedule's, shared by every agent, and keeps its key.
    expect(await heartbeatAge("chief-of-staff/voice-learn/tick")).toBeLessThan(60);
  }, 30_000);

  it("two agents learning at once: one agent's outcome never replaces the other's run that is going", async () => {
    // other-agent takes the request and is still reading mail; first-agent's own weekly pass ends meanwhile.
    agentName = "other-agent";
    let release!: () => void;
    holdMailbox = new Promise<void>((r) => { release = r; });
    holdFirstOnly = true;
    const mod = await import("../agent/schedules/voice-learn.js");
    const first = mod.default.run!(CTX as never);
    await vi.waitFor(() => expect(seenAtMailbox).not.toBeNull());
    expect(await outcomeOf(OTHER)).toMatchObject({ state: "running", agent: "other-agent" });
    await mod.learnAllMailboxes({ agent: "first-agent" });
    expect(await outcomeOf(OWN)).toMatchObject({ state: "skipped", reason: "mailbox-unusable", agent: "first-agent" });
    expect(await outcomeOf(OTHER)).toMatchObject({ state: "running", agent: "other-agent" });
    release();
    await first;
    expect(await outcomeOf(OTHER)).toMatchObject({ state: "skipped", reason: "mailbox-unusable", agent: "other-agent" });
    expect(await outcomeOf(OWN)).toMatchObject({ agent: "first-agent" });
  }, 30_000);

  it("another agent's covering note (a request its run already answers) holds the request too", async () => {
    await pool.query(`INSERT INTO schedule_run (job, agent, state, reason, detail)
      VALUES ('other-agent/voice-learn', 'other-agent', 'skipped', 'already-running', 'Covered.')`);
    await runOnce();
    expect(seenAtMailbox).toBeNull();
    expect(await pending()).toBe(true);
    expect(await outcome()).toBeNull();
  }, 30_000);

  it("another agent's record being written right now: this agent does not claim, and leaves the request for the next tick", async () => {
    await pool.query("INSERT INTO schedule_run (job, agent, state) VALUES ('other-agent/voice-learn', 'other-agent', 'finished')");
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM schedule_run WHERE job = $1 FOR UPDATE", [OTHER]);
      const started = Date.now();
      await runOnce();
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(seenAtMailbox).toBeNull();
      expect(await pending()).toBe(true);
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
    }
  }, 30_000);

  it("a retired agent's record left as running does not hold the request: the page ignores it, and so does the claim", async () => {
    // Retiring only marks the definition retired; a run the retirement cut off leaves its record behind.
    await pool.query("UPDATE agent_definitions SET status = 'retired' WHERE name = 'other-agent'");
    await pool.query("INSERT INTO schedule_run (job, agent, state, started_at) VALUES ('other-agent/voice-learn', 'other-agent', 'running', now())");
    await runOnce();
    expect(seenAtMailbox).toEqual({ state: "running", pending: false });
    expect(await pending()).toBe(false);
  }, 30_000);

  it("an agent whose definition is invalid still runs on its last valid one: its run that is going holds the request", async () => {
    await pool.query("UPDATE agent_definitions SET status = 'invalid' WHERE name = 'other-agent'");
    await pool.query("INSERT INTO schedule_run (job, agent, state, started_at) VALUES ('other-agent/voice-learn', 'other-agent', 'running', now())");
    await runOnce();
    expect(seenAtMailbox).toBeNull();
    expect(await pending()).toBe(true);
  }, 30_000);
});
