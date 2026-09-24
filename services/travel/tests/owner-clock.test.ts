/**
 * ORB-193 Task 4 — Marcel's own reading of the ONE owner clock.
 *
 * The resolution itself is the kit's (`@lares/agent-kit/owner-clock`: trip → Slack profile →
 * home) and is tested there against its own fixtures. What is proven here is the SERVICE's
 * wiring, which is where the two agents differ:
 *
 *  - the trip store is `MARCEL_DATA_ROOT`'s `config.json` — the same file `TripStore` writes,
 *  - there is NO Slack-profile source (Marcel holds no Slack token), so it is trip → home,
 *  - the answer is cached, and a failure resolves to home rather than throwing into a tick.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { TripStore } from "../lib/trip-store.js";

const ENV_KEYS = ["MARCEL_DATA_ROOT", "OWNER_HOME_TZ", "AGENT_OWNER_USER_ID"];
let saved: Record<string, string | undefined>;
let root: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.AGENT_OWNER_USER_ID = "bendik"; // explicit legacy fixture identity
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-owner-clock-"));
  vi.resetModules();
  vi.useFakeTimers();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function seedTrip(): void {
  const store = new TripStore(root);
  store.saveConfig({ adminId: "1", killSwitch: false, dailyTokenBudget: 1000, trips: [] });
  store.createTrip({
    slug: "nyc-2026",
    name: "New York",
    start: "2026-09-10",
    end: "2026-09-20",
    timezone: "America/New_York",
    destination: { name: "New York", lat: 40.7128, lon: -74.006 },
  });
}

describe("ownerTz — the trip store sets the clock", () => {
  it("answers the destination timezone inside a trip's own date window", async () => {
    seedTrip();
    process.env["MARCEL_DATA_ROOT"] = root;
    vi.setSystemTime(new Date("2026-09-12T12:00:00Z"));

    const { ownerTz, ownerClock } = await import("../lib/owner-clock.js");

    expect(await ownerTz()).toBe("America/New_York");
    expect((await ownerClock()).source).toBe("trip");
  });

  it("falls back to the configured home timezone outside every trip window", async () => {
    seedTrip();
    process.env["MARCEL_DATA_ROOT"] = root;
    process.env["OWNER_HOME_TZ"] = "Europe/Berlin";
    vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));

    const { ownerTz, ownerClock } = await import("../lib/owner-clock.js");

    expect(await ownerTz()).toBe("Europe/Berlin");
    expect((await ownerClock()).source).toBe("home");
  });

  it("defaults home to Europe/Oslo with no OWNER_HOME_TZ, and never throws without a trip store", async () => {
    vi.setSystemTime(new Date("2026-09-12T12:00:00Z"));

    const { ownerTz } = await import("../lib/owner-clock.js");

    expect(await ownerTz()).toBe("Europe/Oslo");
  });

  it("a corrupt config.json is a home answer, not an exception", async () => {
    fs.writeFileSync(path.join(root, "config.json"), "{ not json");
    process.env["MARCEL_DATA_ROOT"] = root;
    vi.setSystemTime(new Date("2026-09-12T12:00:00Z"));

    const { ownerTz } = await import("../lib/owner-clock.js");

    expect(await ownerTz()).toBe("Europe/Oslo");
  });

  it("caches the answer — the trip store is not re-read on every tick", async () => {
    seedTrip();
    process.env["MARCEL_DATA_ROOT"] = root;
    vi.setSystemTime(new Date("2026-09-12T12:00:00Z"));

    const { ownerTz } = await import("../lib/owner-clock.js");
    expect(await ownerTz()).toBe("America/New_York");

    // The store disappears; within the cache window the answer is unchanged.
    fs.rmSync(path.join(root, "config.json"));
    expect(await ownerTz()).toBe("America/New_York");
  });
});

describe("makeCachedOwnerClock — the fail-to-home posture", () => {
  it("a throwing resolver yields the home timezone, logged once, never an exception", async () => {
    const { makeCachedOwnerClock } = await import("../lib/owner-clock.js");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    const clock = makeCachedOwnerClock({
      resolve: async () => {
        calls++;
        throw new Error("no pool");
      },
      homeTz: () => "Europe/Oslo",
      ttlMs: 0,
    });

    expect(await clock.tz()).toBe("Europe/Oslo");
    expect(await clock.tz()).toBe("Europe/Oslo");
    expect(calls).toBe(2);
    expect(err).toHaveBeenCalledTimes(1); // one line per failure spell, not per call
  });
});

describe("the owner id and the home clock", () => {
  it("the owner is the identity registry's canonical id unless AGENT_OWNER_USER_ID says otherwise", async () => {
    // ONE reading of the env var, in `lib/principals.ts`. `lib/owner-clock.ts` used to re-export it
    // as `ownerUserId` — two names for one fact, and the ledger and the clock disagreeing about whose
    // day it is would be invisible until a quiet-hours window silently applied to nobody.
    const { ownerId } = await import("../lib/principals.js");
    expect(() => ownerId({})).toThrow("Owner identity is not configured");
    expect(ownerId({ AGENT_OWNER_USER_ID: " alice " })).toBe("alice");
  });

  it("the home timezone is the clock's floor, read per call", async () => {
    const { homeTimezone } = await import("../lib/owner-clock.js");
    expect(homeTimezone({})).toBe("Europe/Oslo");
    expect(homeTimezone({ OWNER_HOME_TZ: " Asia/Tokyo " })).toBe("Asia/Tokyo");
  });

  it("owner-clock.ts exports no second name for the owner id", async () => {
    const mod = await import("../lib/owner-clock.js");
    expect(Object.keys(mod)).not.toContain("ownerUserId");
  });
});
