import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  clockParts,
  slotKey,
  resolveOwnerClockFromSources,
  resolveOwnerClock,
  readSlackProfileSignal,
  recordSlackProfileSignal,
  loadOwnerClockTrips,
  type OwnerClockTrip,
} from "../src/owner-clock.js";

/**
 * ORB-193 Task 2 — one owner clock, three sources in a fixed priority: the trip Marcel already
 * knows about, then the timezone Slack reports off Bendik's own device, then the configured home.
 *
 * The failure this replaces is documented and paid for: ORB-124/128 and ORB-204 each fired a job
 * on a clock nobody was standing on (09:00 New York, mid-air), because every schedule read
 * `Europe/Oslo` from a constant. The tests below pin the two things that make the answer
 * trustworthy — the priority order, and the fact that a SIGNAL WITH NO AGE is not a signal.
 */

const OSLO = "Europe/Oslo";
const NY = "America/New_York";

const trip = (over: Partial<OwnerClockTrip> = {}): OwnerClockTrip => ({
  slug: "nyc-sep",
  name: "New York",
  start: "2026-09-10",
  end: "2026-09-12",
  timezone: NY,
  ...over,
});

describe("clockParts — wall-clock parts in whatever zone the owner is standing in", () => {
  it("reads the date, time and weekday off the given zone, not the process's", () => {
    // 06:00Z on 2026-09-08 is 08:00 in Oslo (CEST) and 02:00 in New York (EDT) — same instant,
    // two different wall clocks, and one of them is a different hour of the same day.
    expect(clockParts(new Date("2026-09-08T06:00:00Z"), OSLO)).toEqual({
      date: "2026-09-08", hour: 8, minute: 0, hhmm: "08:00", weekday: "Tuesday",
    });
    expect(clockParts(new Date("2026-09-08T06:00:00Z"), NY)).toEqual({
      date: "2026-09-08", hour: 2, minute: 0, hhmm: "02:00", weekday: "Tuesday",
    });
  });

  it("crosses midnight on the owner's clock, not UTC's", () => {
    // 03:30Z on the 9th is still 23:30 on the 8th in New York.
    expect(clockParts(new Date("2026-09-09T03:30:00Z"), NY).date).toBe("2026-09-08");
    expect(clockParts(new Date("2026-09-09T03:30:00Z"), NY).hhmm).toBe("23:30");
  });
});

describe("slotKey — the fleet's slot shape, on the owner's clock", () => {
  it("fires on minute 0 of the named hour and returns <date>T<hour>", () => {
    expect(slotKey(new Date("2026-09-08T06:00:00Z"), OSLO, 8)).toBe("2026-09-08T8");
  });

  it("is null one minute later — a slot is a minute, not an hour", () => {
    expect(slotKey(new Date("2026-09-08T06:01:00Z"), OSLO, 8)).toBeNull();
  });

  it("is null in the wrong hour", () => {
    expect(slotKey(new Date("2026-09-08T07:00:00Z"), OSLO, 8)).toBeNull();
  });

  it("moves with the owner: the same 08:00 slot fires six hours later when he is in New York", () => {
    expect(slotKey(new Date("2026-09-08T06:00:00Z"), NY, 8)).toBeNull();
    expect(slotKey(new Date("2026-09-08T12:00:00Z"), NY, 8)).toBe("2026-09-08T8");
  });
});

describe("resolveOwnerClockFromSources — the priority order IS the contract", () => {
  const now = new Date("2026-09-11T09:00:00Z"); // mid-trip

  it("a trip covering today beats a fresh Slack timezone", () => {
    const out = resolveOwnerClockFromSources(now, {
      trips: [trip()],
      slackProfile: { tz: "Europe/Berlin", observedAt: new Date("2026-09-11T08:00:00Z") },
      homeTz: OSLO,
    });
    expect(out.tz).toBe(NY);
    expect(out.source).toBe("trip");
    expect(out.detail).toContain("nyc-sep");
  });

  it("no trip + a fresh Slack timezone → slack-profile", () => {
    const out = resolveOwnerClockFromSources(now, {
      trips: [],
      slackProfile: { tz: "Europe/Berlin", observedAt: new Date("2026-09-11T08:00:00Z") },
      homeTz: OSLO,
    });
    expect(out).toEqual({ tz: "Europe/Berlin", source: "slack-profile", detail: expect.stringContaining("1h") });
  });

  it("a Slack timezone observed 25 h ago is NOT a signal — it falls to home", () => {
    const out = resolveOwnerClockFromSources(now, {
      trips: [],
      slackProfile: { tz: "Europe/Berlin", observedAt: new Date("2026-09-10T08:00:00Z") },
      homeTz: OSLO,
    });
    expect(out.tz).toBe(OSLO);
    expect(out.source).toBe("home");
  });

  it("a Slack timezone observed 23 h ago still counts — the window is 24 h", () => {
    const out = resolveOwnerClockFromSources(now, {
      trips: [],
      slackProfile: { tz: "Europe/Berlin", observedAt: new Date("2026-09-10T10:00:00Z") },
      homeTz: OSLO,
    });
    expect(out.source).toBe("slack-profile");
  });

  it("nothing at all → the configured home, said out loud", () => {
    expect(resolveOwnerClockFromSources(now, { trips: [], homeTz: OSLO })).toEqual({
      tz: OSLO, source: "home", detail: expect.stringContaining("no trip"),
    });
  });

  it("the trip window is inclusive at BOTH ends, on the TRIP's clock", () => {
    const sources = { trips: [trip()], homeTz: OSLO };
    // 03:00Z on the 10th is still 23:00 on the 9th in New York — the trip has not started.
    expect(resolveOwnerClockFromSources(new Date("2026-09-10T03:00:00Z"), sources).source).toBe("home");
    // 05:00Z on the 10th is 01:00 on the 10th in New York — day one, inclusive.
    expect(resolveOwnerClockFromSources(new Date("2026-09-10T05:00:00Z"), sources).source).toBe("trip");
    // 03:00Z on the 13th is 23:00 on the 12th in New York — the last day, inclusive.
    expect(resolveOwnerClockFromSources(new Date("2026-09-13T03:00:00Z"), sources).source).toBe("trip");
    // 05:00Z on the 13th is 01:00 on the 13th in New York — over.
    expect(resolveOwnerClockFromSources(new Date("2026-09-13T05:00:00Z"), sources).source).toBe("home");
  });

  it("skips a trip with no usable timezone rather than crashing every schedule with it", () => {
    const out = resolveOwnerClockFromSources(now, {
      trips: [trip({ timezone: "Mars/Olympus" }), trip({ slug: "berlin", timezone: "Europe/Berlin" })],
      homeTz: OSLO,
    });
    expect(out.tz).toBe("Europe/Berlin");
  });

  it("skips a Slack timezone that is not a real zone", () => {
    const out = resolveOwnerClockFromSources(now, {
      trips: [],
      slackProfile: { tz: "", observedAt: now },
      homeTz: OSLO,
    });
    expect(out.source).toBe("home");
  });

  it("an unusable home timezone still answers — Europe/Oslo is the floor, never a throw", () => {
    expect(resolveOwnerClockFromSources(now, { trips: [], homeTz: "Nowhere/Nothing" }).tz).toBe(OSLO);
  });
});

describe("loadOwnerClockTrips — Marcel's config.json, read by whoever mounts it", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "owner-clock-")); });
  afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it("reads slug, dates and timezone off each trip", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      trips: [{ slug: "nyc-sep", name: "New York", start: "2026-09-10", end: "2026-09-12", timezone: NY }],
    }));
    expect(loadOwnerClockTrips(dir)).toEqual([
      { slug: "nyc-sep", name: "New York", start: "2026-09-10", end: "2026-09-12", timezone: NY },
    ]);
  });

  it("drops an entry that is not shaped like a trip, and keeps the good one beside it", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      trips: [{ slug: "broken" }, { slug: "ok", start: "2026-09-10", end: "2026-09-12", timezone: NY }],
    }));
    expect(loadOwnerClockTrips(dir).map((t) => t.slug)).toEqual(["ok"]);
  });

  it("an absent or unreadable store is no trips, never a throw — most days have no trip", () => {
    expect(loadOwnerClockTrips(join(dir, "nope"))).toEqual([]);
    writeFileSync(join(dir, "config.json"), "{ not json");
    expect(loadOwnerClockTrips(dir)).toEqual([]);
  });

  it("no trips dir at all is no trips", () => {
    expect(loadOwnerClockTrips(undefined)).toEqual([]);
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const sql = (name: string) => readFileSync(join(here, "..", "..", "..", "services", "box", "sql", name), "utf8");

describe("the Slack-profile signal row, against a real Postgres", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let dir: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(sql("031_schedule_heartbeat.sql")); // 035 seeds a heartbeat row
    await pool.query(sql("035_proactivity.sql"));
    dir = mkdtempSync(join(tmpdir(), "owner-clock-db-"));
  }, 180_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(async () => { await pool.query("delete from owner_clock_signals"); });

  it("records the signal and reads it back with its age", async () => {
    await recordSlackProfileSignal(pool, "bendik", "America/New_York");
    const row = await readSlackProfileSignal(pool, "bendik");
    expect(row?.tz).toBe("America/New_York");
    expect(row?.observedAt).toBeInstanceOf(Date);
  });

  it("upserts on (owner, source) — one row per owner, refreshed, never appended", async () => {
    await recordSlackProfileSignal(pool, "bendik", "America/New_York");
    await recordSlackProfileSignal(pool, "bendik", "Europe/Berlin");
    const { rows } = await pool.query("select tz from owner_clock_signals where owner = 'bendik'");
    expect(rows).toEqual([{ tz: "Europe/Berlin" }]);
  });

  it("resolveOwnerClock reads the seeded row and answers slack-profile", async () => {
    await recordSlackProfileSignal(pool, "bendik", "Europe/Berlin");
    const out = await resolveOwnerClock({ now: new Date(), db: pool, owner: "bendik", homeTz: OSLO });
    expect(out).toMatchObject({ tz: "Europe/Berlin", source: "slack-profile" });
  });

  it("resolveOwnerClock prefers a trip over the row", async () => {
    await recordSlackProfileSignal(pool, "bendik", "Europe/Berlin");
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      trips: [{ slug: "nyc-sep", start: "2026-09-10", end: "2026-09-12", timezone: NY }],
    }));
    const out = await resolveOwnerClock({
      now: new Date("2026-09-11T09:00:00Z"), db: pool, tripsDir: dir, owner: "bendik", homeTz: OSLO,
    });
    expect(out).toMatchObject({ tz: NY, source: "trip" });
  });

  it("no row for this owner → home", async () => {
    const out = await resolveOwnerClock({ now: new Date(), db: pool, owner: "someone-else", homeTz: OSLO });
    expect(out.source).toBe("home");
  });

  it("a dead database is home, not a throw — a clock failure must never stop a schedule", async () => {
    const dead = { query: async () => { throw new Error("connection refused"); } };
    const out = await resolveOwnerClock({ now: new Date(), db: dead as never, owner: "bendik", homeTz: OSLO });
    expect(out).toMatchObject({ tz: OSLO, source: "home" });
  });
});
