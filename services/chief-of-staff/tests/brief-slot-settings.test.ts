import { describe, it, expect, vi } from "vitest";

import { makeScheduleHoursCache, SCHEDULE_HOURS_CACHE_MS } from "../lib/schedule-hours.js";
import { readScheduleHours } from "@lares/agent-kit/schedule-settings";

/**
 * LAR-17-s2 — the in-process cache in front of the kit's `readScheduleHours`, and the case for it:
 * these schedules poll every minute, and a settings read must never turn into a query per minute.
 *
 * `makeScheduleHoursCache` is tested as a pure factory over an injected `read`, matching
 * `lib/owner-clock.ts`'s own `makeCachedOwnerClock` tests — no database, no timers beyond an
 * injected `now`.
 */
describe("makeScheduleHoursCache (pure)", () => {
  it("reads once, then serves the cache for repeated calls inside the TTL", async () => {
    let now = 0;
    const read = vi.fn(async () => [8]);
    const cache = makeScheduleHoursCache({ read, now: () => new Date(now) });

    expect(await cache.hours("morning-brief")).toEqual([8]);
    now += SCHEDULE_HOURS_CACHE_MS - 1;
    expect(await cache.hours("morning-brief")).toEqual([8]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads again once the TTL has elapsed — a console change lands within the window, not before it", async () => {
    let now = 0;
    let hours = [8];
    const read = vi.fn(async () => hours);
    const cache = makeScheduleHoursCache({ read, now: () => new Date(now) });

    expect(await cache.hours("morning-brief")).toEqual([8]);
    hours = [7]; // the owner saved a change in the console
    now += SCHEDULE_HOURS_CACHE_MS - 1;
    expect(await cache.hours("morning-brief")).toEqual([8]); // still the old value — cache holds
    now += 2; // now past the TTL
    expect(await cache.hours("morning-brief")).toEqual([7]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("caches each schedule independently", async () => {
    const now = 0;
    const read = vi.fn(async (schedule: string) => (schedule === "morning-brief" ? [8] : [20]));
    const cache = makeScheduleHoursCache({ read, now: () => new Date(now) });

    expect(await cache.hours("morning-brief")).toEqual([8]);
    expect(await cache.hours("evening-brief")).toEqual([20]);
    expect(await cache.hours("morning-brief")).toEqual([8]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent in-flight reads for the same schedule into one call to `read`", async () => {
    let resolveRead: (v: number[]) => void = () => {};
    const read = vi.fn(() => new Promise<number[]>((resolve) => { resolveRead = resolve; }));
    const cache = makeScheduleHoursCache({ read, now: () => new Date(0) });

    const a = cache.hours("morning-brief");
    const b = cache.hours("morning-brief");
    resolveRead([8]);
    expect(await a).toEqual([8]);
    expect(await b).toEqual([8]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("a rejected read propagates — the cache adds no failure handling of its own; the kit reader is what never throws", async () => {
    const read = vi.fn(async () => { throw new Error("boom"); });
    const cache = makeScheduleHoursCache({ read, now: () => new Date(0) });
    await expect(cache.hours("morning-brief")).rejects.toThrow("boom");
  });
});

/**
 * "Checks the behaviour through the kit reader with a fake db" (the slice's own words) — proving
 * the cache composes correctly with the REAL `readScheduleHours` from the kit, backed by a fake db
 * object rather than a mock of the reader itself. This is deliberately a SMALL, targeted check:
 * `readScheduleHours`'s own defaulting/warning contract is exhaustively covered by
 * `packages/agent-kit/tests/schedule-settings.test.ts` (LAR-17-s1); this file only has to show the
 * cache does not get in the way of it.
 */
describe("the cache through readScheduleHours, with a fake db", () => {
  const fakeDb = (rows: unknown[]) => ({ query: async () => ({ rows, rowCount: rows.length }) });

  it("no row: reads as the schedule's engine default", async () => {
    const cache = makeScheduleHoursCache({
      read: (schedule) => readScheduleHours(fakeDb([]), "bendik", schedule),
      now: () => new Date(0),
    });
    expect(await cache.hours("evening-brief")).toEqual([20]);
  });

  it("a stored row: reads back exactly what is stored", async () => {
    const cache = makeScheduleHoursCache({
      read: (schedule) => readScheduleHours(fakeDb([{ hours: [7] }]), "bendik", schedule),
      now: () => new Date(0),
    });
    expect(await cache.hours("morning-brief")).toEqual([7]);
  });

  it("a broken db: reads as the default, with one warning — and the cache still serves it for the TTL", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dead = { query: async () => { throw new Error("connection refused"); } };
    let now = 0;
    const cache = makeScheduleHoursCache({
      read: (schedule) => readScheduleHours(dead, "bendik", schedule),
      now: () => new Date(now),
    });
    expect(await cache.hours("morning-brief")).toEqual([8]);
    now += 1000;
    expect(await cache.hours("morning-brief")).toEqual([8]); // served from cache, dead db not asked again
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

/**
 * PIN — the two brief schedules no longer carry their own hour constant, and read the setting
 * BEFORE computing the slot. Asserted against the SOURCE, not the module namespace: this is a
 * shape check on the file, not a behaviour one (the behaviour is covered in
 * tests/brief-owner-day-wiring.test.ts).
 */
describe("morning-brief.ts / evening-brief.ts read the hour from the setting (LAR-17-s2)", () => {
  const read = async (rel: string) =>
    (await import("node:fs/promises")).readFile(new URL(rel, import.meta.url), "utf8");

  it("morning-brief.ts carries no MORNING_HOUR constant, and asks scheduleHours before slotIn", async () => {
    const src = await read("../agent/schedules/morning-brief.ts");
    expect(src).not.toContain("MORNING_HOUR");
    expect(src.indexOf("scheduleHours(")).toBeGreaterThan(-1);
    expect(src.indexOf("scheduleHours(")).toBeLessThan(src.indexOf("slotIn("));
  });

  it("evening-brief.ts carries no EVENING_HOUR constant, and asks scheduleHours before slotIn", async () => {
    const src = await read("../agent/schedules/evening-brief.ts");
    expect(src).not.toContain("EVENING_HOUR");
    expect(src.indexOf("scheduleHours(")).toBeGreaterThan(-1);
    expect(src.indexOf("scheduleHours(")).toBeLessThan(src.indexOf("slotIn("));
  });
});
