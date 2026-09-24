import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  SCHEDULE_HOUR_DEFAULTS, SINGLE_SLOT, validateHours, readScheduleHours,
} from "../src/schedule-settings.js";

/**
 * LAR-17-s1. Proven against a REAL Postgres and the REAL migration
 * (services/box/sql/065_schedule_settings.sql) — a fake pool that never executes SQL is the
 * "built+tested+non-functional" class this project has paid for (ORB-45).
 */
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(join(here, "..", "..", "..", "services", "box", "sql", "065_schedule_settings.sql"), "utf8");

describe("SCHEDULE_HOUR_DEFAULTS (pure)", () => {
  it("every known schedule key has a default of whole hours in 0-23", () => {
    const keys = Object.keys(SCHEDULE_HOUR_DEFAULTS);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const hours = SCHEDULE_HOUR_DEFAULTS[key]!;
      expect(hours.length).toBeGreaterThan(0);
      for (const h of hours) {
        expect(Number.isInteger(h)).toBe(true);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(23);
      }
      // Every default is already valid under the module's own rule.
      expect(validateHours(key, [...hours])).toEqual({ ok: true });
    }
  });

  it("SINGLE_SLOT is every schedule except digest and crm-routing", () => {
    expect(SINGLE_SLOT.has("digest")).toBe(false);
    expect(SINGLE_SLOT.has("crm-routing")).toBe(false);
    expect(SINGLE_SLOT.has("morning-brief")).toBe(true);
    expect(SINGLE_SLOT.has("evening-brief")).toBe(true);
    expect(SINGLE_SLOT.has("weekly-summary")).toBe(true);
    expect(SINGLE_SLOT.has("voice-learn")).toBe(true);
    expect(SINGLE_SLOT.has("dream")).toBe(true);
  });
});

describe("validateHours (pure)", () => {
  it("refuses an unknown schedule", () => {
    expect(validateHours("nonexistent", [9])).toEqual({ ok: false, message: expect.stringMatching(/not a known schedule/) });
  });
  it("refuses an empty array", () => {
    expect(validateHours("digest", [])).toEqual({ ok: false, message: expect.any(String) });
  });
  it("refuses out-of-range hours", () => {
    expect(validateHours("digest", [-1, 9])).toEqual({ ok: false, message: expect.any(String) });
    expect(validateHours("digest", [9, 24])).toEqual({ ok: false, message: expect.any(String) });
  });
  it("refuses a non-integer hour", () => {
    expect(validateHours("digest", [8.5])).toEqual({ ok: false, message: expect.any(String) });
  });
  it("refuses duplicates", () => {
    expect(validateHours("digest", [9, 9])).toEqual({ ok: false, message: expect.any(String) });
  });
  it("refuses unsorted input", () => {
    expect(validateHours("digest", [17, 9])).toEqual({ ok: false, message: expect.any(String) });
  });
  it("refuses more than one hour for a single-slot schedule", () => {
    expect(validateHours("morning-brief", [8, 9])).toEqual({ ok: false, message: expect.stringMatching(/exactly one/) });
  });
  it("accepts a single valid hour for a single-slot schedule", () => {
    expect(validateHours("morning-brief", [7])).toEqual({ ok: true });
  });
  it("accepts several sorted, unique, in-range hours for a multi-slot schedule", () => {
    expect(validateHours("crm-routing", [9, 13, 17])).toEqual({ ok: true });
  });
});

describe("schedule_settings (sql/065) and readScheduleHours", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(MIGRATION);
  }, 120_000);

  afterAll(async () => { await pool.end(); await container.stop(); });

  it("the migration is idempotent — a second run changes nothing", async () => {
    await pool.query(
      `INSERT INTO schedule_settings (owner, schedule, hours) VALUES ('bendik', 'morning-brief', '{7}')`,
    );
    await pool.query(MIGRATION);
    const { rows } = await pool.query("select owner, schedule, hours from schedule_settings order by schedule");
    expect(rows).toHaveLength(1);
    expect(rows[0].hours).toEqual([7]);
  });

  it("rejects an hour of -1", async () => {
    await expect(pool.query(
      `INSERT INTO schedule_settings (owner, schedule, hours) VALUES ('t', 'digest', '{-1,9}')`,
    )).rejects.toThrow();
  });

  it("rejects an hour of 24", async () => {
    await expect(pool.query(
      `INSERT INTO schedule_settings (owner, schedule, hours) VALUES ('t', 'digest', '{9,24}')`,
    )).rejects.toThrow();
  });

  it("rejects a fractional hour of 8.5", async () => {
    await expect(pool.query(
      `INSERT INTO schedule_settings (owner, schedule, hours) VALUES ('t', 'digest', '{8.5}')`,
    )).rejects.toThrow();
  });

  it("rejects an empty hours array", async () => {
    await expect(pool.query(
      `INSERT INTO schedule_settings (owner, schedule, hours) VALUES ('t', 'digest', '{}')`,
    )).rejects.toThrow();
  });

  it("rejects a malformed schedule key", async () => {
    await expect(pool.query(
      `INSERT INTO schedule_settings (owner, schedule, hours) VALUES ('t', 'Morning Brief', '{8}')`,
    )).rejects.toThrow();
  });

  it("readScheduleHours: no row reads as the engine default", async () => {
    expect(await readScheduleHours(pool, "nobody", "evening-brief")).toEqual([20]);
    expect(await readScheduleHours(pool, "nobody", "digest")).toEqual([9, 17]);
  });

  it("readScheduleHours: a stored value is returned", async () => {
    await pool.query(
      `INSERT INTO schedule_settings (owner, schedule, hours) VALUES ('carol', 'evening-brief', '{19}')`,
    );
    expect(await readScheduleHours(pool, "carol", "evening-brief")).toEqual([19]);
  });

  it("readScheduleHours: an unknown schedule throws at call time, without touching the database", async () => {
    const spy = vi.spyOn(pool, "query");
    await expect(readScheduleHours(pool, "bendik", "not-a-real-schedule")).rejects.toThrow(/not a known schedule/);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("readScheduleHours: a broken database reads as the default, with one warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dead = new Pool({ connectionString: "postgres://x:y@127.0.0.1:1/nope" });
    try {
      expect(await readScheduleHours(dead, "bendik", "weekly-summary")).toEqual([9]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/weekly-summary/);
    } finally {
      await dead.end();
      warn.mockRestore();
    }
  });
});
