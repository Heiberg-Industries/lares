/**
 * The nightly prune — ADR-0020 rule 3, against a REAL disposable Postgres running the REAL
 * migration files (060 + 061), because this is the one job in the fleet that DELETES an owner's
 * conversation history. A fake Pool that never executes SQL would prove nothing about the one
 * statement that matters.
 *
 * WHAT EACH CASE IS GUARDING, in one line each — every boundary here is a permanent, silent
 * failure if it is wrong:
 *   - the window: entries past it go, entries inside it stay, and the run says which cutoff it used;
 *   - "keep forever" (a stored NULL) deletes NOTHING, and issues no DELETE at all;
 *   - a setting that cannot be READ (a database outage, or migration 061 not applied on this
 *     installation) deletes NOTHING and says so — the prune fails CLOSED, towards keeping data;
 *   - a clock that is obviously wrong (before 2026) deletes nothing, because a cutoff is computed
 *     from the clock and a wrong clock is a wrong cutoff;
 *   - the thirty-day floor holds however short the owner's setting is;
 *   - one person's entries only — `person_key`, never `agent`;
 *   - a run is bounded, so a first prune on a large table cannot hold a lock for minutes;
 *   - it is idempotent — a second run in the same minute removes nothing more.
 *
 * The prune makes NO model call and sends NO message: there is nothing to mock here, which is
 * itself part of the design.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Pool } from "pg";

import { osloLocalToDate } from "../lib/recurrence.js";
import {
  makeConversationRecord,
  pruneForOwner,
  writeRetentionMonths,
  PRUNE_BATCH_LIMIT,
  PRUNE_FLOOR_DAYS,
} from "@lares/agent-kit/conversation-record";

const here = dirname(fileURLToPath(import.meta.url));
const sqlDir = join(here, "..", "..", "box", "sql");
const entries = readFileSync(join(sqlDir, "060_conversation_entries.sql"), "utf8");
const retention = readFileSync(join(sqlDir, "061_conversation_retention.sql"), "utf8");

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(entries);
  await pool.query(retention);
}, 120_000);
afterAll(async () => { await pool?.end(); await container?.stop(); });
beforeEach(async () => {
  await pool.query("TRUNCATE conversation_entries");
  await pool.query("DELETE FROM conversation_retention");
});

const base = {
  agent: "canary", sessionId: "s1", door: "slack",
  personKey: "fixture-owner", origin: "owner" as const,
  input: "hello", reply: "hi", proposals: [] as string[],
};

async function seed(rows: Array<{ turnId: string; at: Date; personKey?: string }>): Promise<void> {
  const record = makeConversationRecord(pool);
  for (const row of rows) {
    await record.append({ ...base, turnId: row.turnId, at: row.at, personKey: row.personKey ?? base.personKey });
  }
}

async function turnIds(): Promise<string[]> {
  const { rows } = await pool.query<{ turn_id: string }>(
    "SELECT turn_id FROM conversation_entries ORDER BY at ASC",
  );
  return rows.map((r) => r.turn_id);
}

/** A database that cannot answer, in the two shapes an installation really produces. */
const unreadable = (message: string) => ({ query: async () => { throw new Error(message); } }) as never;

describe("the nightly prune", () => {
  const now = new Date("2026-09-18T03:00:00Z");

  it("deletes entries past the window and reports the cutoff", async () => {
    await seed([
      { turnId: "old", at: new Date("2025-01-01T00:00:00Z") },
      { turnId: "new", at: new Date("2026-09-01T00:00:00Z") },
    ]);
    const r = await pruneForOwner(pool, { owner: "fixture-owner", now });
    expect(r).toMatchObject({ outcome: "pruned", deleted: 1 });
    // Twelve calendar months back from `now`, KEEPING the time of day — `cutoffFor` subtracts
    // months and nothing else (packages/agent-kit/src/conversation-record.ts), so a 03:00 run
    // cuts at 03:00. Pinned here because it is the difference between "a year ago" and "a year
    // ago, midnight", and a reader of the log line needs to know which one they are seeing.
    expect(r.cutoff!.toISOString()).toBe("2025-09-18T03:00:00.000Z");
    expect(await turnIds()).toEqual(["new"]);
  });

  it("deletes nothing when the owner chose keep forever", async () => {
    await writeRetentionMonths(pool, "fixture-owner", null, "console");
    await seed([{ turnId: "ancient", at: new Date("2019-01-01T00:00:00Z") }]);
    expect(await pruneForOwner(pool, { owner: "fixture-owner", now }))
      .toMatchObject({ outcome: "kept-forever", deleted: 0 });
    expect(await turnIds()).toEqual(["ancient"]);
  });

  it("refuses rather than prunes when the setting cannot be read", async () => {
    const r = await pruneForOwner(unreadable("connection terminated"), { owner: "fixture-owner", now });
    expect(r.outcome).toBe("refused");
    expect(r.deleted).toBe(0);
    expect(r.reason).toMatch(/could not read the retention setting/i);
  });

  it("refuses when migration 061 was never applied on this installation", async () => {
    // The shape a box that applied 060 but not 061 produces. Same branch as the outage above;
    // pinned separately because it is the likelier of the two and the one an operator must be
    // able to recognise from the log line alone.
    const r = await pruneForOwner(
      unreadable('relation "conversation_retention" does not exist'),
      { owner: "fixture-owner", now },
    );
    expect(r.outcome).toBe("refused");
    expect(r.deleted).toBe(0);
    expect(r.reason).toMatch(/conversation_retention/);
  });

  it("deletes nothing when the clock is obviously wrong", async () => {
    await seed([{ turnId: "ancient", at: new Date("2019-01-01T00:00:00Z") }]);
    const r = await pruneForOwner(pool, { owner: "fixture-owner", now: new Date("2001-01-01T00:00:00Z") });
    expect(r.outcome).toBe("refused");
    expect(r.deleted).toBe(0);
    expect(r.reason).toMatch(/clock/i);
    expect(await turnIds()).toEqual(["ancient"]);
  });

  it("never deletes inside the safety floor, however short the setting", async () => {
    await writeRetentionMonths(pool, "fixture-owner", 1, "console");
    await seed([{ turnId: "yesterday", at: new Date("2026-09-17T00:00:00Z") }]);
    const r = await pruneForOwner(pool, { owner: "fixture-owner", now, floorDays: 30 });
    expect(r.deleted).toBe(0);
    expect(await turnIds()).toEqual(["yesterday"]);
    expect(PRUNE_FLOOR_DAYS).toBe(30);
  });

  it("touches only this owner's entries", async () => {
    await seed([
      { turnId: "mine", at: new Date("2019-01-01T00:00:00Z"), personKey: "fixture-owner" },
      { turnId: "theirs", at: new Date("2019-01-01T00:00:00Z"), personKey: "someone-else" },
    ]);
    await pruneForOwner(pool, { owner: "fixture-owner", now });
    expect(await turnIds()).toEqual(["theirs"]);
  });

  it("is bounded per run: a batch limit leaves the rest for the next night", async () => {
    await seed([
      { turnId: "a", at: new Date("2019-01-01T00:00:00Z") },
      { turnId: "b", at: new Date("2019-01-02T00:00:00Z") },
      { turnId: "c", at: new Date("2019-01-03T00:00:00Z") },
    ]);
    const first = await pruneForOwner(pool, { owner: "fixture-owner", now, batchLimit: 2 });
    expect(first).toMatchObject({ outcome: "pruned", deleted: 2, batchLimited: true });
    expect(await turnIds()).toEqual(["c"]);
    const second = await pruneForOwner(pool, { owner: "fixture-owner", now, batchLimit: 2 });
    expect(second).toMatchObject({ deleted: 1, batchLimited: false });
    expect(PRUNE_BATCH_LIMIT).toBeGreaterThan(0);
  });

  it("is idempotent — a second run in the same minute deletes nothing more", async () => {
    await seed([{ turnId: "old", at: new Date("2019-01-01T00:00:00Z") }]);
    expect((await pruneForOwner(pool, { owner: "fixture-owner", now })).deleted).toBe(1);
    expect((await pruneForOwner(pool, { owner: "fixture-owner", now })).deleted).toBe(0);
  });

  it("touches no other table — only conversation_entries loses rows", async () => {
    // The finding written tonight (docs/research/2026-09-18-eve-session-rows-retention.md) says
    // pruning eve's own workflow/session rows is unknown-until-measured on this version. This
    // pins that this job never widened beyond the one table it owns.
    await writeRetentionMonths(pool, "fixture-owner", 12, "console");
    await seed([{ turnId: "old", at: new Date("2019-01-01T00:00:00Z") }]);
    await pruneForOwner(pool, { owner: "fixture-owner", now });
    const { rows } = await pool.query<{ months: number | null }>("SELECT months FROM conversation_retention");
    expect(rows.map((r) => r.months)).toEqual([12]);
  });
});

describe("the live-installation case: a definition written before this schedule existed", () => {
  it("a definition with NO conversation-prune entry runs nothing and deletes nothing", async () => {
    // The service's own committed agent.json — the neutral default every test and every build
    // resolves to — carries no `schedules` block at all, which is exactly the shape of a
    // definition written before this schedule existed. Under the fleet's "silence means ON" rule
    // that would START the prune on the day the image lands. It must not.
    //
    // EVE_SCHEDULES_LIVE is set deliberately: the box gate is OPEN here, so the only thing that
    // can stop this run is the definition, which is what this case is about.
    // The clock is parked ON the prune's own slot (04:00 on the owner's clock, which resolves to
    // the home timezone here), so nothing but the definition can be the reason nothing happened:
    // let this run through and the row below is gone.
    await writeRetentionMonths(pool, "fixture-owner", 12, "console");
    await seed([{ turnId: "old", at: new Date("2019-01-01T00:00:00Z") }]);
    const saved = {
      live: process.env["EVE_SCHEDULES_LIVE"],
      url: process.env["DATABASE_URL"],
      owner: process.env["AGENT_OWNER_USER_ID"],
    };
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    process.env["DATABASE_URL"] = container.getConnectionUri();
    process.env["AGENT_OWNER_USER_ID"] = "fixture-owner";
    vi.useFakeTimers();
    vi.setSystemTime(osloLocalToDate("2026-06-17 04:00"));
    try {
      const { default: schedule } = await import("../agent/schedules/conversation-prune.js");
      await schedule.run!({} as never);
      expect(await turnIds()).toEqual(["old"]);
    } finally {
      vi.useRealTimers();
      await import("@lares/agent-kit/db").then((m) => m.closePool()).catch(() => {});
      for (const [k, v] of Object.entries({
        EVE_SCHEDULES_LIVE: saved.live, DATABASE_URL: saved.url, AGENT_OWNER_USER_ID: saved.owner,
      })) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  }, 30_000);
});

describe("the prune ships off in the role template", () => {
  it("a destructive schedule is opt-in: the shipped template says { on: false }", () => {
    // Silence means ON (packages/agent-kit/src/schedule-switch.ts), so only an EXPLICIT false
    // keeps a new installation from deleting history before the owner has seen the setting.
    const template = JSON.parse(readFileSync(
      join(here, "..", "..", "..", "packages", "agent-kit", "templates", "chief-of-staff", "definition.json"),
      "utf8",
    )) as { schedules: Record<string, { on: boolean }> };
    expect(template.schedules["conversation-prune"]).toBeDefined();
    expect(template.schedules["conversation-prune"]!.on).toBe(false);
  });
});
