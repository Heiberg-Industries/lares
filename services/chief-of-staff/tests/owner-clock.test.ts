import { describe, it, expect, vi } from "vitest";

import { osloParts, osloDate, partsIn, dateIn, slotIn, TZ } from "../lib/recurrence.js";
import { makeCachedOwnerClock, OWNER_TZ_CACHE_MS } from "../lib/owner-clock.js";
import { makeOwnerClockRefresh } from "../agent/schedules/owner-clock.js";
import type { OwnerClock } from "@lares/agent-kit/owner-clock";

/**
 * ORB-193 Task 2, Saga's half of the owner clock: the tz-parameterised slot helpers her seven slot
 * schedules move onto in Task 3, the cached per-service resolver every turn and schedule reads, and
 * the 30-minute refresh that keeps the Slack-profile signal alive.
 *
 * The one rule that outranks correctness here: a clock failure must never stop a schedule. Every
 * failure case below asserts the home timezone comes back, not a throw.
 */

const NY = "America/New_York";

describe("recurrence.ts, generalised — the Oslo helpers become the tz helpers (ORB-193)", () => {
  const instant = new Date("2026-09-09T02:30:00Z"); // 04:30 Oslo, 22:30 on the 8th in New York

  it("partsIn reads the wall clock in the zone it is given", () => {
    expect(partsIn(instant, TZ)).toEqual({ date: "2026-09-09", hour: 4, minute: 30 });
    expect(partsIn(instant, NY)).toEqual({ date: "2026-09-08", hour: 22, minute: 30 });
  });

  it("dateIn is the date on that clock", () => {
    expect(dateIn(instant, NY)).toBe("2026-09-08");
  });

  it("osloParts and osloDate keep answering exactly as before — they are now wrappers", () => {
    expect(osloParts(instant)).toEqual(partsIn(instant, TZ));
    expect(osloDate(instant)).toBe("2026-09-09");
  });

  it("slotIn returns the four copied osloSlotNow helpers' shape: <date>T<hour>, else null", () => {
    expect(slotIn(new Date("2026-09-08T06:00:00Z"), TZ, 8)).toBe("2026-09-08T8");
    expect(slotIn(new Date("2026-09-08T06:01:00Z"), TZ, 8)).toBeNull();
    expect(slotIn(new Date("2026-09-08T07:00:00Z"), TZ, 8)).toBeNull();
  });

  it("slotIn moves with the owner — the 08:00 slot is six hours later in New York", () => {
    expect(slotIn(new Date("2026-09-08T06:00:00Z"), NY, 8)).toBeNull();
    expect(slotIn(new Date("2026-09-08T12:00:00Z"), NY, 8)).toBe("2026-09-08T8");
  });
});

describe("the cached resolver — one clock read per five minutes, never a throw", () => {
  const clockOf = (tz: string, source: OwnerClock["source"] = "trip"): OwnerClock => ({ tz, source, detail: "test" });

  it("resolves once and serves the cache until the window expires", async () => {
    let t = 1_000_000;
    const resolve = vi.fn(async () => clockOf(NY));
    const cached = makeCachedOwnerClock({ resolve, homeTz: () => TZ, now: () => new Date(t) });

    expect(await cached.tz()).toBe(NY);
    expect(await cached.tz()).toBe(NY);
    expect(resolve).toHaveBeenCalledTimes(1);

    t += OWNER_TZ_CACHE_MS - 1;
    expect(await cached.tz()).toBe(NY);
    expect(resolve).toHaveBeenCalledTimes(1);

    t += 2;
    expect(await cached.tz()).toBe(NY);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("a resolver failure is the home timezone plus one log line — never a thrown turn", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const resolve = vi.fn(async () => { throw new Error("no pool"); });
    const cached = makeCachedOwnerClock({ resolve, homeTz: () => TZ, now: () => new Date(1_000_000) });

    await expect(cached.tz()).resolves.toBe(TZ);
    expect((await cached.clock()).source).toBe("home");
    // Logged ONCE, not once per turn: this runs on every message Saga answers.
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("recovers on the next window after a failure, and can warn again", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let t = 1_000_000;
    let fail = true;
    const resolve = vi.fn(async () => { if (fail) throw new Error("no pool"); return clockOf(NY); });
    const cached = makeCachedOwnerClock({ resolve, homeTz: () => TZ, now: () => new Date(t) });

    expect(await cached.tz()).toBe(TZ);
    fail = false;
    t += OWNER_TZ_CACHE_MS + 1;
    expect(await cached.tz()).toBe(NY);

    fail = true;
    t += OWNER_TZ_CACHE_MS + 1;
    expect(await cached.tz()).toBe(TZ);
    expect(err).toHaveBeenCalledTimes(2); // once per failure spell, not once per call
    err.mockRestore();
  });

  it("two concurrent callers share one resolve — a per-turn clock must not fan out", async () => {
    let resolves = 0;
    const resolve = vi.fn(async () => { resolves += 1; await Promise.resolve(); return clockOf(NY); });
    const cached = makeCachedOwnerClock({ resolve, homeTz: () => TZ });
    const [a, b] = await Promise.all([cached.tz(), cached.tz()]);
    expect([a, b]).toEqual([NY, NY]);
    expect(resolves).toBe(1);
  });

  // ORB-193 final review. `tzSync` exists for ONE caller: eve's approval-card rendering, which the
  // patch invokes inline with nowhere to await (see `@lares/agent-kit`'s `registerApprovalSummary`).
  // Everything else awaits `tz()`.
  it("tzSync answers the home clock before the first resolve lands, then the resolved zone", async () => {
    const resolve = vi.fn(async () => clockOf(NY));
    const cached = makeCachedOwnerClock({ resolve, homeTz: () => TZ, now: () => new Date(1_000_000) });

    // Nothing cached yet: home, and a resolve is kicked off for the NEXT caller.
    expect(cached.tzSync()).toBe(TZ);
    await Promise.resolve();
    await Promise.resolve();
    expect(cached.tzSync()).toBe(NY);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("tzSync serves the last known zone rather than home once the cache is stale", async () => {
    // The alternative — falling back to home on staleness — would flip a New York card back to Oslo
    // every five minutes. Stale-but-right beats fresh-but-home.
    let t = 1_000_000;
    const resolve = vi.fn(async () => clockOf(NY));
    const cached = makeCachedOwnerClock({ resolve, homeTz: () => TZ, now: () => new Date(t) });

    expect(await cached.tz()).toBe(NY);
    t += OWNER_TZ_CACHE_MS + 1;
    expect(cached.tzSync()).toBe(NY);
  });

  it("tzSync never throws, even when the resolver is broken", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const resolve = vi.fn(async () => { throw new Error("no pool"); });
    const cached = makeCachedOwnerClock({ resolve, homeTz: () => TZ, now: () => new Date(1_000_000) });

    expect(() => cached.tzSync()).not.toThrow();
    expect(cached.tzSync()).toBe(TZ);
    await cached.clock();
    expect(cached.tzSync()).toBe(TZ);
    err.mockRestore();
  });
});

function fakePool() {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const db = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
  return { db: db as never, calls };
}

describe("the refresh tick — Slack's own answer for where Bendik is", () => {
  it("writes the timezone Slack reports as the owner's slack-profile signal", async () => {
    const { db, calls } = fakePool();
    const tick = makeOwnerClockRefresh({ db, owner: "bendik", readOwnerTimezone: async () => NY });

    expect(await tick.tick()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toMatch(/INSERT INTO owner_clock_signals/i);
    expect(calls[0]!.sql).toMatch(/ON CONFLICT \(owner, source\) DO UPDATE/i);
    expect(calls[0]!.sql).toMatch(/observed_at = now\(\)/i);
    expect(calls[0]!.params).toEqual(["bendik", NY]);
  });

  it("a Slack failure logs and still completes the pass — the signal ages out on its own", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, calls } = fakePool();
    const tick = makeOwnerClockRefresh({
      db, owner: "bendik",
      readOwnerTimezone: async () => { throw new Error("invalid_auth"); },
    });

    expect(await tick.tick()).toBe(true);
    expect(calls).toHaveLength(0); // nothing written — a stale signal is better than a wrong one
    expect(err).toHaveBeenCalledOnce();
    err.mockRestore();
  });

  it("a profile with no timezone writes nothing and still completes the pass", async () => {
    const { db, calls } = fakePool();
    const tick = makeOwnerClockRefresh({ db, owner: "bendik", readOwnerTimezone: async () => null });
    expect(await tick.tick()).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("a WRITE failure does not complete the pass — that is the heartbeat's whole job", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const dead = { query: async () => { throw new Error("connection refused"); } } as never;
    const tick = makeOwnerClockRefresh({ db: dead, owner: "bendik", readOwnerTimezone: async () => NY });
    expect(await tick.tick()).toBe(false);
    err.mockRestore();
  });
});
