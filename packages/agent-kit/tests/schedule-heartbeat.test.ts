import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { quiet } from "./helpers/quiet-pool.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  scheduleKey, tickKey, recordSchedulePass, recordScheduleTick,
} from "../src/schedule-heartbeat.js";

/**
 * The digest's heartbeat generalised. Proven against a REAL Postgres and the
 * REAL baseline (services/box/sql/001_baseline.sql) — a fake pool that never
 * executes SQL is the "built+tested+non-functional" class this project has paid for.
 */
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(join(here, "..", "..", "..", "services", "box", "sql", "001_baseline.sql"), "utf8");

const ageSeconds = async (pool: Pool, key: string): Promise<number | undefined> => {
  const { rows } = await pool.query(
    "select extract(epoch from (now() - updated_at)) as age from heartbeat where agent = $1", [key],
  );
  return rows[0] ? Number(rows[0].age) : undefined;
};

describe("schedule-heartbeat ", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    pool = quiet(new Pool({ connectionString: container.getConnectionUri() }));
    await pool.query(MIGRATION);
  }, 120_000);

  afterAll(async () => { await pool.end(); await container.stop(); });

  beforeEach(() => { vi.restoreAllMocks(); });

  it("seeds 18 pass rows and 9 tick rows at install time", async () => {
    const { rows } = await pool.query("select agent from heartbeat where agent like 'chief-of-staff/%' order by agent");
    const keys = rows.map((r) => r.agent as string);
    expect(keys.filter((k) => !k.endsWith("/tick"))).toHaveLength(18);
    expect(keys.filter((k) => k.endsWith("/tick"))).toHaveLength(9);
    expect(await ageSeconds(pool, "chief-of-staff/reminders")).toBeLessThan(60);
  });

  it("scheduleKey / tickKey build the row keys and refuse anything else", () => {
    expect(scheduleKey("chief-of-staff", "morning-brief")).toBe("chief-of-staff/morning-brief");
    expect(tickKey("chief-of-staff/morning-brief")).toBe("chief-of-staff/morning-brief/tick");
    expect(() => scheduleKey("Agent", "morning-brief")).toThrow(/key/);
    expect(() => scheduleKey("chief-of-staff", "morning brief")).toThrow(/key/);
    expect(() => tickKey("digest")).toThrow(/key/);
    expect(() => tickKey("chief-of-staff/digest/tick")).toThrow(/key/);
  });

  it("recordSchedulePass moves the row to now() — INSERT … ON CONFLICT", async () => {
    await pool.query("update heartbeat set updated_at = now() - interval '1 hour' where agent = 'chief-of-staff/reminders'");
    expect(await recordSchedulePass(pool, "chief-of-staff/reminders")).toBe(true);
    expect(await ageSeconds(pool, "chief-of-staff/reminders")).toBeLessThan(60);
  });

  it("recordSchedulePass inserts a row that the baseline did not seed (a schedule added later)", async () => {
    expect(await recordSchedulePass(pool, "chief-of-staff/brand-new")).toBe(true);
    expect(await ageSeconds(pool, "chief-of-staff/brand-new")).toBeLessThan(60);
  });

  it("recordScheduleTick stamps the /tick row and leaves the pass row alone", async () => {
    await pool.query("update heartbeat set updated_at = now() - interval '1 hour' where agent in ('chief-of-staff/dream', 'chief-of-staff/dream/tick')");
    expect(await recordScheduleTick(pool, "chief-of-staff/dream")).toBe(true);
    expect(await ageSeconds(pool, "chief-of-staff/dream/tick")).toBeLessThan(60);
    expect(await ageSeconds(pool, "chief-of-staff/dream")).toBeGreaterThan(3500);
  });

  it("a failing database never throws into the schedule — it warns, names the consequence, resolves false", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dead = quiet(new Pool({ connectionString: "postgres://x:y@127.0.0.1:1/nope" }));
    try {
      expect(await recordSchedulePass(dead, "chief-of-staff/reminders")).toBe(false);
      expect(await recordScheduleTick(dead, "chief-of-staff/dream")).toBe(false);
    } finally { await dead.end(); }
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/chief-of-staff\/reminders/);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/health check/);
  });

  it("a hung database is bounded — resolves false after the 5 s cap, not never", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const hung = { query: () => new Promise<never>(() => {}) };
    const started = Date.now();
    expect(await recordSchedulePass(hung, "chief-of-staff/reminders")).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
  }, 10_000);

  it("refuses a malformed key before touching the database", async () => {
    const spy = vi.spyOn(pool, "query");
    await expect(recordSchedulePass(pool, "digest")).rejects.toThrow(/key/);
    expect(spy).not.toHaveBeenCalled();
  });
});
