import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";

import { osloLocalToDate } from "../lib/recurrence.js";
import { closePool } from "@lares/agent-kit/db";
import { PROPOSALS_SCHEMA } from "./helpers/proposals-schema.js";

/**
 * ORB-175 — the wiring, not the helper (tests/schedule-heartbeat.test.ts in the kit proves
 * that). Three facts per schedule, each driven through the real `run()`:
 *   1. a closed gate stamps NOTHING — the ten-day digest shape (EVE_DIGEST_LIVE=0) must page;
 *   2. a pass that fails stamps no pass (its tick row still moves for the slot-based ones);
 *   3. a quiet pass stamps — proven for the schedules whose quiet path needs no external service
 *      (reminders on an empty table, reping switched off, proposals-watch on empty lanes); the
 *      briefs, digest, dream, crm-routing, email-triage, outreach-reply-watch and voice-learn
 *      reach their quiet path only through Google/Slack/the vault, so for them facts 1 and 2 plus
 *      the conformance test's call-site pin are the coverage.
 *
 * ONE SCHEDULE IS DELIBERATELY THE OTHER WAY ROUND, and it gets its own describe block rather than
 * an exception buried in a loop: `owner-clock` (ORB-193) is a SENSOR, not a messenger. A Slack READ
 * failure still stamps a completed pass — the signal it writes ages out of its own 24 h window and
 * the clock falls back to trip-then-home, so "ran and found Slack unreachable" is a healthy pass and
 * a stale heartbeat there would page for nothing. A WRITE failure does not stamp: that is the one
 * database this agent cannot work without. Fact 2's generic loop would assert the opposite of the
 * first half, so `owner-clock` is excluded from it BY NAME, with the reason stated at the exclusion.
 *
 * Same fresh-import discipline as tests/schedule-signal-wiring.test.ts, for the same reason:
 * module-scope `lastSlot`/`running`/`liveState` must not leak between cases.
 *
 * The database starts holding ONLY migration 031 (the heartbeat table) — no domain tables at
 * all. Every schedule's first real domain query (a SELECT/UPDATE against a table this DB never
 * got) throws, which is what makes "gate open, pass fails" deterministic without mocking any
 * individual store: `DATABASE_URL` points at a real, disposable Postgres, so the heartbeat
 * writes genuinely succeed while everything else genuinely fails. Traced schedule-by-schedule
 * (see task-4-report.md) to confirm every failing-pass case fails on a missing table or an
 * unset config value (GOOGLE_PRINCIPAL_ID, VAULT_PATH, the Twenty key file) — never on a real
 * network call — so no case can hang.
 */
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(join(here, "..", "..", "box", "sql", "031_schedule_heartbeat.sql"), "utf8");

vi.mock("../lib/signal-emit.js", () => ({ emitSignal: vi.fn(async () => {}) }));

/**
 * ADR-0020 — THE FIXTURE OPTS IN TO THE PRUNE, and to nothing else.
 *
 * `conversation-prune` is the one schedule that reads its switch through `scheduleExplicitlyEnabled`
 * (silence means OFF for a job that deletes), and the definition every case here resolves to is
 * this service's own neutral `agent.json`, which carries no `schedules` block at all. Without an
 * explicit entry the prune would never reach its tick and none of this file's three facts could be
 * asserted about it — it would sit in the tables looking covered.
 *
 * So the resolved definition is handed ONE added entry, `conversation-prune: { on: true }`, and
 * every other schedule keeps exactly the definition it had (silence, which still means ON for
 * them). `importOriginal` means the real resolver still runs; only its answer is extended.
 */
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
          definition: {
            ...resolved.loaded.definition,
            schedules: { ...resolved.loaded.definition.schedules, "conversation-prune": { on: true } },
          },
        },
      };
    },
  };
});

/**
 * ORB-193 — `owner-clock` reads the owner's timezone from Slack, and its two documented outcomes
 * (a read that fails, a read that succeeds and then cannot be written) are only reachable by
 * controlling that read. PARTIAL mock, and `resolveSlackToken` THROWS by default: that is exactly
 * what the real one does with no Slack configured, so every other schedule in this file behaves
 * identically to before — in particular the morning brief's Slack scan still fails on config, never
 * on a network call, which is the promise this file's header makes. A case that needs a successful
 * read sets `slackProfile` and gets no network either: `fetchSlackUserTimezone` is stubbed too.
 */
let slackProfile: { token: string | null; tz: string | null } = { token: null, tz: null };
vi.mock("../lib/slack-source.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/slack-source.js")>()),
  resolveSlackToken: async () => {
    if (slackProfile.token === null) throw new Error("no Slack token configured (test default)");
    return slackProfile.token;
  },
  fetchSlackUserTimezone: async () => slackProfile.tz,
}));

const ENV_KEYS = [
  "EVE_SCHEDULES_LIVE", "EVE_DIGEST_LIVE", "EVE_DREAM_LIVE", "DATABASE_URL", "TELEGRAM_PRINCIPAL_ID",
  "SLACK_ALLOWED_USER_IDS", "OBLIGATION_REPING_ENABLED",
  "DIGEST_SLACK_TARGET",
];
let saved: Record<string, string | undefined>;
let container: StartedPostgreSqlContainer;
let pool: Pool;

const CTX = { to: (() => {}) as never, waitUntil: (() => {}) as never, appAuth: {} as never };

/** Each schedule: its env, and the Oslo wall-clock at which its pass is due (null = polling). */
const CASES: Array<{ name: string; slot: string | null; env: Record<string, string> }> = [
  { name: "morning-brief",        slot: "2026-06-17 08:00", env: { TELEGRAM_PRINCIPAL_ID: "123456" } },
  { name: "evening-brief",        slot: "2026-06-17 20:00", env: { TELEGRAM_PRINCIPAL_ID: "123456" } },
  { name: "digest",               slot: "2026-06-17 09:00", env: { EVE_DIGEST_LIVE: "1", SLACK_ALLOWED_USER_IDS: "U123456" } },
  { name: "dream",                slot: "2026-06-17 03:00", env: { EVE_DREAM_LIVE: "1" } },
  // ADR-0020's prune. A `conversation_retention` it cannot read is a REFUSAL, not a pass (see
  // the schedule's own header): nothing is deleted AND the pass row stays put, so fact 2's
  // generic assertion is exactly right for it and it needs no exception below.
  { name: "conversation-prune",   slot: "2026-06-17 04:00", env: {} },
  // The nightly Telegram hand-over. Its slot is the day boundary itself, and with no
  // `telegram_daily_log` here its one worklist query throws — a failed pass, exactly what fact 2
  // asserts, so it needs no exception below.
  { name: "telegram-handover",    slot: "2026-06-17 00:00", env: {} },
  { name: "voice-learn",          slot: "2026-06-21 04:00", env: {} },                       // Sunday
  { name: "weekly-summary",       slot: "2026-06-21 09:00", env: { TELEGRAM_PRINCIPAL_ID: "123456" } },
  { name: "crm-routing",          slot: "2026-06-17 09:00", env: { SLACK_ALLOWED_USER_IDS: "U123456" } },
  { name: "email-triage",         slot: null, env: { SLACK_ALLOWED_USER_IDS: "U123456" } },
  { name: "meeting-followup",     slot: null, env: { SLACK_ALLOWED_USER_IDS: "U123456" } },
  { name: "outreach-reply-watch", slot: null, env: { SLACK_ALLOWED_USER_IDS: "U123456" } },
  { name: "proposals-watch",      slot: null, env: { TELEGRAM_PRINCIPAL_ID: "123456" } },
  { name: "reminders",            slot: null, env: {} },
  { name: "reping",               slot: null, env: { OBLIGATION_REPING_ENABLED: "1", TELEGRAM_PRINCIPAL_ID: "123456" } },
  { name: "owner-clock",          slot: null, env: { SLACK_ALLOWED_USER_IDS: "U123456" } },   // ORB-193 — see the header
  { name: "deadlines",            slot: null, env: { TELEGRAM_PRINCIPAL_ID: "123456" } },     // ORB-180 — see below
  { name: "market-refresh",       slot: null, env: {} },                                       // ORB-214 item 1 — see below
];

/**
 * Excluded from fact 2's loop, each with its reason — both are schedules for which "the read
 * failed" is a COMPLETED pass by design, so fact 2's generic assertion would assert the opposite
 * of their own contract:
 *
 *   - `owner-clock` (ORB-193): a Slack read failure is healthy — the signal ages out and the clock
 *     falls back to trip-then-home.
 *   - `deadlines` (ORB-180): the ladder switch is FAIL-CLOSED. A `deadline_settings` it cannot read
 *     means OFF, not "escalate anyway", and an OFF pass stamps — otherwise a ladder that is quiet
 *     because the owner asked for quiet would page as a dead schedule. Each has its own describe
 *     block below asserting the behaviour fact 2 cannot.
 *   - `market-refresh` (ORB-214 item 1): the SAME fail-closed shape as `deadlines` — a
 *     `markets_settings` it cannot read means OFF, not "refresh anyway", and an OFF pass stamps.
 */
const PASS_ON_READ_FAILURE = ["owner-clock", "deadlines", "market-refresh"];
const SLOT = CASES.filter((c) => c.slot !== null).map((c) => c.name);

/**
 * A literal-specifier import per schedule, not a template-literal dynamic import. Vite rewrites
 * any dynamic `import(\`...${x}...\`)` into an `import.meta.glob` lookup (its "variable dynamic
 * import" transform) — and that glob matches literal on-disk filenames, so a `*.js` pattern
 * matches nothing against this directory's real `.ts` files ("Unknown variable dynamic import",
 * confirmed against this repo's vitest/vite versions). A literal string per entry sidesteps that
 * transform entirely while still resolving `.js` → `.ts` the same way every other relative
 * import in this codebase does, and each entry still re-executes fresh after `vi.resetModules()`
 * exactly like a literal `await import("../agent/schedules/reminders.js")` would.
 */
const IMPORTERS: Record<string, () => Promise<{ default: { run?: (ctx: unknown) => Promise<void> } }>> = {
  "morning-brief": () => import("../agent/schedules/morning-brief.js"),
  "evening-brief": () => import("../agent/schedules/evening-brief.js"),
  "digest": () => import("../agent/schedules/digest.js"),
  "dream": () => import("../agent/schedules/dream.js"),
  "conversation-prune": () => import("../agent/schedules/conversation-prune.js"),
  "telegram-handover": () => import("../agent/schedules/telegram-handover.js"),
  "voice-learn": () => import("../agent/schedules/voice-learn.js"),
  "weekly-summary": () => import("../agent/schedules/weekly-summary.js"),
  "crm-routing": () => import("../agent/schedules/crm-routing.js"),
  "email-triage": () => import("../agent/schedules/email-triage.js"),
  "meeting-followup": () => import("../agent/schedules/meeting-followup.js"),
  "outreach-reply-watch": () => import("../agent/schedules/outreach-reply-watch.js"),
  "proposals-watch": () => import("../agent/schedules/proposals-watch.js"),
  "reminders": () => import("../agent/schedules/reminders.js"),
  "reping": () => import("../agent/schedules/reping.js"),
  "owner-clock": () => import("../agent/schedules/owner-clock.js"),
  "deadlines": () => import("../agent/schedules/deadlines.js"),
  "market-refresh": () => import("../agent/schedules/market-refresh.js"),
};

async function ageAll(): Promise<void> {
  await pool.query("update heartbeat set updated_at = now() - interval '1 hour' where agent like 'saga/%'");
}
async function age(key: string): Promise<number> {
  const { rows } = await pool.query("select extract(epoch from (now() - updated_at)) as a from heartbeat where agent = $1", [key]);
  return Number(rows[0]?.a ?? -1);
}
/**
 * Several schedules' own live wiring does `CREATE TABLE IF NOT EXISTS ...` as part of a pass
 * (dream's `ensureDreamTables`, crm-routing's `ensureRouteTables`, the briefs'/reping's
 * `ensureObligationsTableOnce`) — idempotent in production, but a real side effect against this
 * file's ONE shared container. Left alone, an earlier case's ensure-table call would leave a
 * later case's "domain tables missing" premise false (an empty table reads as "nothing to do"
 * instead of "never migrated", the exact difference this suite exists to keep apart). Dropping
 * every non-heartbeat table between cases keeps each one honestly at "only migration 031", same
 * as the file header claims.
 */
async function resetDomainTables(): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'heartbeat'`,
  );
  for (const { tablename } of rows) {
    await pool.query(`DROP TABLE IF EXISTS "${tablename}" CASCADE`);
  }
}
async function runSchedule(c: (typeof CASES)[number], live: boolean): Promise<void> {
  if (live) process.env["EVE_SCHEDULES_LIVE"] = "1";
  for (const [k, v] of Object.entries(c.env)) process.env[k] = v;
  if (c.slot) { vi.useFakeTimers(); vi.setSystemTime(osloLocalToDate(c.slot)); }
  const importer = IMPORTERS[c.name];
  if (!importer) throw new Error(`no importer registered for schedule "${c.name}"`);
  const { default: schedule } = await importer();
  // Some schedules have no outer catch (proposals-watch, voice-learn) — a rejection is a failed
  // pass too, and is not what these cases assert on.
  await schedule.run!(CTX as never).catch(() => {});
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(MIGRATION);
  // ORB-193 — `saga/owner-clock`'s seed lives in a LATER migration (035_proactivity.sql:54), which
  // this file deliberately does not apply (its premise is "only the heartbeat table exists"). Seeded
  // by hand, verbatim, so every case below can assert on a row that EXISTS: without it "nothing was
  // stamped" and "there is no row at all" would both read as absent, and the second is a different
  // bug (a schedule with no heartbeat row is invisible to input-freshness.sh).
  // ORB-180 — `saga/deadlines` is seeded by 036_deadlines.sql, likewise not applied here, and for
  // this schedule the distinction matters twice over: `age()` answers -1 for a missing row, which
  // is BELOW every "it stamped" threshold — so an unseeded row would make the fail-closed case
  // below pass without the schedule stamping anything at all. `saga/market-refresh` is seeded by
  // the SAME migration (036) and needs the same hand seed for the same reason.
  // ADR-0020 — `saga/conversation-prune`'s two rows are seeded by 070_conversation_prune_heartbeat.sql,
  // likewise not applied here, and both matter: a missing PASS row answers -1 from `age()`, which is
  // below every threshold and would make "a closed gate stamps nothing" pass without the gate doing
  // anything; a missing TICK row would do the same for the slot half of the same assertion.
  // The nightly Telegram hand-over's two rows are seeded by 082_telegram_handover_heartbeat.sql,
  // likewise not applied here, and both matter for the same reason the prune's do: a missing row
  // answers -1 from `age()`, which is below every threshold, so an unseeded row would make "a
  // closed gate stamps nothing" pass without the gate doing anything.
  for (const key of ["saga/owner-clock", "saga/deadlines", "saga/market-refresh",
                     "saga/conversation-prune", "saga/conversation-prune/tick",
                     "saga/telegram-handover", "saga/telegram-handover/tick"]) {
    await pool.query(`INSERT INTO heartbeat (agent) VALUES ($1) ON CONFLICT (agent) DO NOTHING`, [key]);
  }
}, 120_000);
afterAll(async () => { await closePool().catch(() => {}); await pool.end(); await container.stop(); });

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env["DATABASE_URL"] = container.getConnectionUri();
  slackProfile = { token: null, tz: null };
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  await closePool().catch(() => {});
  vi.resetModules();
  await resetDomainTables();
  await ageAll();
});
afterEach(async () => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.useRealTimers();
  vi.restoreAllMocks();
  // The schedule dynamically imported in this test pulled in its OWN fresh instance of
  // "@lares/agent-kit/db" (vi.resetModules() in beforeEach means every dynamic import gets a
  // module registry separate from this file's static `closePool` import above) — so it built
  // its own `getPool()` singleton, which the static `closePool()` call below never touches.
  // No `vi.resetModules()` has run since that dynamic import, so this re-import resolves to the
  // SAME cached instance the schedule used, letting its actual pool be closed here — otherwise
  // it leaks a live connection that `container.stop()` in afterAll then kills, surfacing as an
  // unhandled "terminating connection due to administrator command" exception per leaked pool.
  await import("@lares/agent-kit/db").then((m) => m.closePool()).catch(() => {});
  await closePool().catch(() => {});
});

describe("a closed gate stamps nothing (the ten-day digest shape must page)", () => {
  for (const c of CASES) {
    it(`${c.name}: EVE_SCHEDULES_LIVE unset → no row moves`, async () => {
      await runSchedule(c, false);
      expect(await age(`saga/${c.name}`)).toBeGreaterThan(3500);
      if (SLOT.includes(c.name)) expect(await age(`saga/${c.name}/tick`)).toBeGreaterThan(3500);
    }, 30_000);
  }
  it("digest: EVE_SCHEDULES_LIVE=1 but EVE_DIGEST_LIVE unset → no row moves (exactly the 2026-08-21 outage)", async () => {
    const c = { ...CASES.find((x) => x.name === "digest")!, env: { SLACK_ALLOWED_USER_IDS: "U123456" } };
    await runSchedule(c, true);
    expect(await age("saga/digest")).toBeGreaterThan(3500);
    expect(await age("saga/digest/tick")).toBeGreaterThan(3500);
  }, 30_000);
});

describe("a failing pass stamps no pass — and a slot-based schedule's tick still moves", () => {
  for (const c of CASES.filter((x) => !PASS_ON_READ_FAILURE.includes(x.name))) {
    it(`${c.name}: gate open, domain tables missing → pass row untouched${SLOT.includes(c.name) ? ", tick row fresh" : ""}`, async () => {
      await runSchedule(c, true);
      expect(await age(`saga/${c.name}`), "pass row must not move on a failed pass").toBeGreaterThan(3500);
      if (SLOT.includes(c.name)) expect(await age(`saga/${c.name}/tick`), "tick row must move after the gate").toBeLessThan(60);
    }, 30_000);
  }
});

describe("owner-clock is a sensor, not a messenger (ORB-193's deliberate exception)", () => {
  const c = CASES.find((x) => x.name === "owner-clock")!;

  it("a Slack READ failure STILL stamps — the signal ages out on its own, so this is a healthy pass", async () => {
    // The default stub: `resolveSlackToken` throws, exactly as the real one does unconfigured.
    await runSchedule(c, true);
    expect(await age("saga/owner-clock"), "a read failure is a completed pass").toBeLessThan(60);
  }, 30_000);

  it("Slack having no timezone for the owner also stamps — nothing to record is not a failure", async () => {
    slackProfile = { token: "xoxp-test", tz: null };
    await runSchedule(c, true);
    expect(await age("saga/owner-clock")).toBeLessThan(60);
  }, 30_000);

  it("a WRITE failure does NOT stamp — owner_clock_signals is the one thing it cannot work without", async () => {
    // Read succeeds; `owner_clock_signals` does not exist in this database (resetDomainTables), so
    // `recordSlackProfileSignal` throws and the tick reports an incomplete pass.
    slackProfile = { token: "xoxp-test", tz: "Asia/Tokyo" };
    await runSchedule(c, true);
    expect(await age("saga/owner-clock"), "a failed write must leave the row aging").toBeGreaterThan(3500);
  }, 30_000);
});

/**
 * The list above is a hand-maintained mirror of a directory, which is the shape that silently falls
 * behind — `owner-clock` shipped in Task 2 and was absent from both tables until fix round 1, so
 * eve's newest schedule had none of this file's three facts asserted about it and nothing said so.
 * Pinning the two tables to the directory means the next schedule cannot be added without either
 * registering it here or failing this test.
 */
describe("the registry cannot fall behind the schedules on disk", () => {
  const onDisk = readdirSync(join(here, "..", "agent", "schedules"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => basename(f, ".ts"))
    .sort();

  it("IMPORTERS names exactly the schedules in agent/schedules/", () => {
    expect(Object.keys(IMPORTERS).sort()).toEqual(onDisk);
  });

  it("CASES names exactly the schedules in agent/schedules/", () => {
    expect(CASES.map((c) => c.name).sort()).toEqual(onDisk);
  });
});

describe("the deadline ladder is fail-CLOSED (ORB-180's deliberate exception)", () => {
  const c = CASES.find((x) => x.name === "deadlines")!;

  it("a switch it cannot read is OFF, and an OFF pass STILL stamps", async () => {
    // `deadline_settings` does not exist in this database (resetDomainTables), so
    // `readLadderEnabled` throws — the one thing that must NOT follow is a message.
    await runSchedule(c, true);
    expect(await age("saga/deadlines"), "an OFF pass is a completed pass").toBeLessThan(60);
  }, 30_000);
});

describe("the market refresh switch is fail-CLOSED (ORB-214 item 1's deliberate exception)", () => {
  const c = CASES.find((x) => x.name === "market-refresh")!;

  it("a switch it cannot read is OFF, and an OFF pass STILL stamps", async () => {
    // `markets_settings` does not exist in this database (resetDomainTables), so
    // `readMarketsSettings` throws — the one thing that must NOT follow is a venue call.
    await runSchedule(c, true);
    expect(await age("saga/market-refresh"), "an OFF pass is a completed pass").toBeLessThan(60);
  }, 30_000);
});

describe("a quiet pass stamps (where the quiet path needs no external service)", () => {
  it("reminders: an empty reminders table is a completed pass", async () => {
    // Real DDL, verbatim from services/box/sql/001_init.sql:32 — not a guessed schema.
    // 001_init.sql as a whole also CREATE EXTENSIONs vector/pgcrypto and several other tables
    // this pass never touches; only the reminders table itself is applied here.
    await pool.query(`CREATE TABLE reminders (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      agent        text        NOT NULL,
      owner        text        NOT NULL DEFAULT 'bendik',
      due_at       timestamptz NOT NULL,
      recurrence   text,
      payload      jsonb       NOT NULL,
      status       text        NOT NULL DEFAULT 'pending',
      delivered_at timestamptz,
      created_at   timestamptz NOT NULL DEFAULT now(),
      created_by   text        NOT NULL,
      CONSTRAINT reminders_status_ck
        CHECK (status IN ('pending','delivered','cancelled','failed'))
    )`);
    await pool.query(`CREATE INDEX reminders_due_idx ON reminders (status, due_at)`);

    await runSchedule(CASES.find((x) => x.name === "reminders")!, true);
    expect(await age("saga/reminders")).toBeLessThan(60);
  }, 30_000);

  it("reping: OBLIGATION_REPING_ENABLED unset is a decision, not an outage — the pass stamps", async () => {
    await runSchedule({ name: "reping", slot: null, env: { TELEGRAM_PRINCIPAL_ID: "123456" } }, true);
    expect(await age("saga/reping")).toBeLessThan(60);
  }, 30_000);

  it("proposals-watch: two empty lanes are a completed pass", async () => {
    // Schema mirror shared with tests/proposals.test.ts via tests/helpers/proposals-schema.ts.
    await pool.query(PROPOSALS_SCHEMA);
    await runSchedule(CASES.find((x) => x.name === "proposals-watch")!, true);
    expect(await age("saga/proposals-watch")).toBeLessThan(60);
  }, 30_000);
});
