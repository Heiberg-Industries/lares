import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  scheduleKey, tickKey, recordSchedulePass, recordScheduleTick,
} from "../src/schedule-heartbeat.js";

/**
 * ORB-175. The digest's ORB-179 heartbeat generalised. Proven against a REAL Postgres and the
 * REAL migration (services/box/sql/031_schedule_heartbeat.sql) — a fake pool that never
 * executes SQL is the "built+tested+non-functional" class this project has paid for (ORB-45),
 * and running 031 here is also the only place the migration is exercised before the box.
 */
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(join(here, "..", "..", "..", "services", "box", "sql", "031_schedule_heartbeat.sql"), "utf8");

const ageSeconds = async (pool: Pool, key: string): Promise<number | undefined> => {
  const { rows } = await pool.query(
    "select extract(epoch from (now() - updated_at)) as age from heartbeat where agent = $1", [key],
  );
  return rows[0] ? Number(rows[0].age) : undefined;
};

describe("schedule-heartbeat (ORB-175)", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    // The old runtime's row, as the box has it today: the migration must carry its age over.
    await pool.query("create table heartbeat (agent text primary key, updated_at timestamptz not null default now())");
    await pool.query("insert into heartbeat values ('saga-digest', now() - interval '3 hours'), ('calliope', now() - interval '10 days')");
    await pool.query(MIGRATION);
  }, 120_000);

  afterAll(async () => { await pool.end(); await container.stop(); });

  beforeEach(() => { vi.restoreAllMocks(); });

  it("the migration is idempotent — a second run changes nothing", async () => {
    const before = await pool.query("select agent, updated_at from heartbeat order by agent");
    await pool.query(MIGRATION);
    const after = await pool.query("select agent, updated_at from heartbeat order by agent");
    expect(after.rows).toEqual(before.rows);
  });

  it("renames the digest's ORB-179 row to the new key and keeps its age", async () => {
    expect(await ageSeconds(pool, "saga-digest")).toBeUndefined();
    expect(await ageSeconds(pool, "saga/digest")).toBeGreaterThan(3 * 3600 - 60);
  });

  it("seeds 13 pass rows and 7 tick rows at install time", async () => {
    const { rows } = await pool.query("select agent from heartbeat where agent like 'saga/%' order by agent");
    const keys = rows.map((r) => r.agent as string);
    expect(keys.filter((k) => !k.endsWith("/tick"))).toHaveLength(13);
    expect(keys.filter((k) => k.endsWith("/tick"))).toHaveLength(7);
    expect(await ageSeconds(pool, "saga/reminders")).toBeLessThan(60);
  });

  it("scheduleKey / tickKey build the row keys and refuse anything else", () => {
    expect(scheduleKey("saga", "morning-brief")).toBe("saga/morning-brief");
    expect(tickKey("saga/morning-brief")).toBe("saga/morning-brief/tick");
    expect(() => scheduleKey("Saga", "morning-brief")).toThrow(/key/);
    expect(() => scheduleKey("saga", "morning brief")).toThrow(/key/);
    expect(() => tickKey("saga-digest")).toThrow(/key/);
    expect(() => tickKey("saga/digest/tick")).toThrow(/key/);
  });

  it("recordSchedulePass moves the row to now() — INSERT … ON CONFLICT, same shape as ORB-179", async () => {
    await pool.query("update heartbeat set updated_at = now() - interval '1 hour' where agent = 'saga/reminders'");
    expect(await recordSchedulePass(pool, "saga/reminders")).toBe(true);
    expect(await ageSeconds(pool, "saga/reminders")).toBeLessThan(60);
  });

  it("recordSchedulePass inserts a row that the migration did not seed (a schedule added later)", async () => {
    expect(await recordSchedulePass(pool, "saga/brand-new")).toBe(true);
    expect(await ageSeconds(pool, "saga/brand-new")).toBeLessThan(60);
  });

  it("recordScheduleTick stamps the /tick row and leaves the pass row alone", async () => {
    await pool.query("update heartbeat set updated_at = now() - interval '1 hour' where agent in ('saga/dream', 'saga/dream/tick')");
    expect(await recordScheduleTick(pool, "saga/dream")).toBe(true);
    expect(await ageSeconds(pool, "saga/dream/tick")).toBeLessThan(60);
    expect(await ageSeconds(pool, "saga/dream")).toBeGreaterThan(3500);
  });

  it("a failing database never throws into the schedule — it warns, names the consequence, resolves false", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dead = new Pool({ connectionString: "postgres://x:y@127.0.0.1:1/nope" });
    try {
      expect(await recordSchedulePass(dead, "saga/reminders")).toBe(false);
      expect(await recordScheduleTick(dead, "saga/dream")).toBe(false);
    } finally { await dead.end(); }
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/saga\/reminders/);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/input-freshness/);
  });

  it("a hung database is bounded — resolves false after the 5 s cap, not never", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const hung = { query: () => new Promise<never>(() => {}) };
    const started = Date.now();
    expect(await recordSchedulePass(hung, "saga/reminders")).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
  }, 10_000);

  it("refuses a malformed key before touching the database", async () => {
    const spy = vi.spyOn(pool, "query");
    await expect(recordSchedulePass(pool, "saga-digest")).rejects.toThrow(/key/);
    expect(spy).not.toHaveBeenCalled();
  });
});
