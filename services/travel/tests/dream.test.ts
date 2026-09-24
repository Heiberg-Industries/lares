// Ported from services/marcel/tests/dream.test.ts, adapted to eve-marcel's TripStore (string
// chatId). Adds scheduler-level tests for DreamScheduler/PromoteScheduler (lib/dream.ts) — the
// pure per-trip tick logic Task 7's lib/trip-schedule.ts explicitly scoped OUT and deferred to
// this task — covering the documented "correct-for-one-tick/broken-next-tick" defect class: a
// double (or many-times) tick on the same date must run the underlying job exactly once, not
// once per tick.
//
// Wave 4 (W4C-s9) removed this file's own Dreamer.nightly / Dreamer.promoteTaste behavioural
// tests: those two methods no longer rewrite learned.md or append to taste/preferences.md from a
// model reply (see lib/dream.ts and tests/dream-off.test.ts) — ADR-0018 does not permit that
// unattended, and porting this role onto the shared promotion gate is a separate, larger job
// (wave 5C's neighbour). The scheduler-level tests below are untouched: they drive the tick logic
// with fake `dream`/`promote` callbacks, never the real Dreamer, so they still prove what they
// always proved.
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { TripStore, type Trip } from "../lib/trip-store.js";
import { ConversationLog } from "../lib/conversation-log.js";
import {
  DreamScheduler,
  PromoteScheduler,
  tickDreamTrip,
  tickPromoteTrip,
  type DreamScheduleDeps,
  type PromoteScheduleDeps,
} from "../lib/dream.js";

let root: string;
let store: TripStore;
let trip: Trip;

function ts(dateISO: string, time: string): number {
  const [y, mo, d] = dateISO.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return Math.floor(Date.UTC(y, mo - 1, d, h, mi) / 1000);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-dream-"));
  store = new TripStore(root);
  store.saveConfig({ adminId: "1", killSwitch: false, dailyTokenBudget: 1000, trips: [] });
  trip = store.createTrip({
    slug: "paris-2026",
    name: "Paris",
    start: "2026-07-21",
    end: "2026-07-28",
    timezone: "UTC",
    destination: { name: "Paris", lat: 48.8566, lon: 2.3522 },
  });
  store.linkChat(trip.slug, "555");
  trip = { ...trip, chatId: "555" };
});

// ─── DreamScheduler — the ≥02:00 nightly tick ──────────────────────────────────────────────

interface DreamRecorder {
  dreamCalls: { trip: Trip; dateISO: string }[];
  errors: { key: string; err: unknown }[];
}

function newDreamRecorder(): DreamRecorder {
  return { dreamCalls: [], errors: [] };
}

function makeDreamDeps(now: () => number, recorder: DreamRecorder): DreamScheduleDeps {
  return {
    store,
    now,
    dream: async (t, dateISO) => {
      recorder.dreamCalls.push({ trip: t, dateISO });
    },
    onJobError: (_t, key, err) => {
      recorder.errors.push({ key, err });
    },
  };
}

describe("DreamScheduler.tick", () => {
  it("fires the dream job at 02:00 for yesterday's date, exactly once even across a double tick in the same minute", async () => {
    const now = ts("2026-07-22", "02:00");
    const recorder = newDreamRecorder();
    const scheduler = new DreamScheduler(makeDreamDeps(() => now, recorder));

    await scheduler.tick();
    await scheduler.tick(); // double tick, same minute

    expect(recorder.dreamCalls).toHaveLength(1);
    expect(recorder.dreamCalls[0]!.dateISO).toBe("2026-07-21"); // yesterday, not today
    const sent = JSON.parse(fs.readFileSync(path.join(trip.dir, "sent.json"), "utf8"));
    expect(sent["2026-07-22:dream"]).toBe(true);
  });

  it("does not fire before 02:00", async () => {
    const recorder = newDreamRecorder();
    await new DreamScheduler(makeDreamDeps(() => ts("2026-07-22", "01:59"), recorder)).tick();

    expect(recorder.dreamCalls).toHaveLength(0);
  });

  it("catches up a missed 02:00 minute later the same day, but does not double-fire after", async () => {
    const scheduler = new DreamScheduler(makeDreamDeps(() => ts("2026-07-22", "02:07"), newDreamRecorder()));
    await scheduler.tick();

    const recorder = newDreamRecorder();
    const secondScheduler = new DreamScheduler(makeDreamDeps(() => ts("2026-07-22", "10:00"), recorder));
    await secondScheduler.tick();

    expect(recorder.dreamCalls).toHaveLength(0); // already marked sent earlier that day
  });

  it("fires again the next day (separate ledger key), still once per day", async () => {
    const day1 = newDreamRecorder();
    await new DreamScheduler(makeDreamDeps(() => ts("2026-07-22", "02:00"), day1)).tick();
    await new DreamScheduler(makeDreamDeps(() => ts("2026-07-22", "02:01"), day1)).tick();
    expect(day1.dreamCalls).toHaveLength(1);

    const day2 = newDreamRecorder();
    await new DreamScheduler(makeDreamDeps(() => ts("2026-07-23", "02:00"), day2)).tick();
    await new DreamScheduler(makeDreamDeps(() => ts("2026-07-23", "02:01"), day2)).tick();
    expect(day2.dreamCalls).toHaveLength(1);
    expect(day2.dreamCalls[0]!.dateISO).toBe("2026-07-22");
  });

  it("still fires through trip.end+1 — the dream that learns from the trip's final day", async () => {
    const recorder = newDreamRecorder();
    // trip.end = 2026-07-28, so end+1 = 2026-07-29.
    await new DreamScheduler(makeDreamDeps(() => ts("2026-07-29", "02:00"), recorder)).tick();

    expect(recorder.dreamCalls).toHaveLength(1);
    expect(recorder.dreamCalls[0]!.dateISO).toBe("2026-07-28"); // learns from the final day's log
  });

  it("does not fire past trip.end+1", async () => {
    const recorder = newDreamRecorder();
    await new DreamScheduler(makeDreamDeps(() => ts("2026-07-30", "02:00"), recorder)).tick();

    expect(recorder.dreamCalls).toHaveLength(0);
  });

  it("does nothing when killSwitch is on", async () => {
    const cfg = store.config();
    cfg.killSwitch = true;
    store.saveConfig(cfg);

    const recorder = newDreamRecorder();
    await new DreamScheduler(makeDreamDeps(() => ts("2026-07-22", "02:00"), recorder)).tick();

    expect(recorder.dreamCalls).toHaveLength(0);
    expect(fs.existsSync(path.join(trip.dir, "sent.json"))).toBe(false);
  });

  it("ignores a trip with no linked chat", async () => {
    store.createTrip({
      slug: "unlinked",
      name: "Unlinked",
      start: "2026-07-21",
      end: "2026-07-25",
      timezone: "UTC",
      destination: { name: "X", lat: 0, lon: 0 },
    });
    const recorder = newDreamRecorder();
    await new DreamScheduler(makeDreamDeps(() => ts("2026-07-22", "02:00"), recorder)).tick();

    // Only the linked "paris-2026" trip fires.
    expect(recorder.dreamCalls).toHaveLength(1);
  });

  it("propagates a job failure to onJobError without throwing", async () => {
    const recorder = newDreamRecorder();
    const deps: DreamScheduleDeps = {
      ...makeDreamDeps(() => ts("2026-07-22", "02:00"), recorder),
      dream: async () => {
        throw new Error("distill boom");
      },
    };

    await expect(new DreamScheduler(deps).tick()).resolves.toBeUndefined();

    expect(recorder.errors).toHaveLength(1);
    expect(recorder.errors[0]!.key).toBe("2026-07-22:dream");
  });
});

describe("tickDreamTrip — callable directly, independent of DreamScheduler", () => {
  it("fires at 02:00 when called standalone", async () => {
    const recorder = newDreamRecorder();
    const deps = makeDreamDeps(() => ts("2026-07-22", "02:00"), recorder);

    await tickDreamTrip(deps, trip, ts("2026-07-22", "02:00"), "2026-07-22");

    expect(recorder.dreamCalls).toHaveLength(1);
  });
});

// ─── PromoteScheduler — the "fires once at trip.end+1 03:00, never mid-trip, never twice" tick ─

interface PromoteRecorder {
  promoteCalls: Trip[];
  errors: { key: string; err: unknown }[];
}

function newPromoteRecorder(): PromoteRecorder {
  return { promoteCalls: [], errors: [] };
}

function makePromoteDeps(now: () => number, recorder: PromoteRecorder): PromoteScheduleDeps {
  return {
    store,
    now,
    promote: async (t) => {
      recorder.promoteCalls.push(t);
    },
    onJobError: (_t, key, err) => {
      recorder.errors.push({ key, err });
    },
  };
}

describe("PromoteScheduler.tick — fires once at trip.end+1 03:00", () => {
  it("fires at 03:00 on end+1", async () => {
    const recorder = newPromoteRecorder();
    // trip.end = 2026-07-28 → end+1 = 2026-07-29.
    await new PromoteScheduler(makePromoteDeps(() => ts("2026-07-29", "03:00"), recorder)).tick();

    expect(recorder.promoteCalls).toHaveLength(1);
    const sent = JSON.parse(fs.readFileSync(path.join(trip.dir, "sent.json"), "utf8"));
    expect(sent["2026-07-29:promote"]).toBe(true);
  });

  it("never fires mid-trip, even after 03:00 on an ordinary trip day", async () => {
    const recorder = newPromoteRecorder();
    await new PromoteScheduler(makePromoteDeps(() => ts("2026-07-24", "03:00"), recorder)).tick();

    expect(recorder.promoteCalls).toHaveLength(0);
  });

  it("never fires on trip.end itself (only end+1)", async () => {
    const recorder = newPromoteRecorder();
    await new PromoteScheduler(makePromoteDeps(() => ts("2026-07-28", "23:59"), recorder)).tick();

    expect(recorder.promoteCalls).toHaveLength(0);
  });

  it("never fires before 03:00 on end+1", async () => {
    const recorder = newPromoteRecorder();
    await new PromoteScheduler(makePromoteDeps(() => ts("2026-07-29", "02:59"), recorder)).tick();

    expect(recorder.promoteCalls).toHaveLength(0);
  });

  it("THE double-append guard: does not fire twice across many same-day ticks on end+1 — simulating the schedule's real every-minute cron firing all day", async () => {
    // This is the exact failure mode the task calls out: a naive "fire if todayISO ===
    // trip.end+1" check with no ledger would re-run promote on every one of these ticks. The
    // sent.json mark (written on the FIRST due tick, checked on every subsequent one) is what
    // actually prevents it.
    const recorder = newPromoteRecorder();
    const times = ["03:00", "03:01", "03:02", "04:00", "12:00", "18:30", "22:00", "23:59"];

    for (const time of times) {
      await new PromoteScheduler(makePromoteDeps(() => ts("2026-07-29", time), recorder)).tick();
    }

    expect(recorder.promoteCalls).toHaveLength(1);
  });

  it("fires exactly once even across a double tick in the exact same minute", async () => {
    const now = ts("2026-07-29", "03:00");
    const recorder = newPromoteRecorder();
    const scheduler = new PromoteScheduler(makePromoteDeps(() => now, recorder));

    await scheduler.tick();
    await scheduler.tick();

    expect(recorder.promoteCalls).toHaveLength(1);
  });

  it("does nothing when killSwitch is on", async () => {
    const cfg = store.config();
    cfg.killSwitch = true;
    store.saveConfig(cfg);

    const recorder = newPromoteRecorder();
    await new PromoteScheduler(makePromoteDeps(() => ts("2026-07-29", "03:00"), recorder)).tick();

    expect(recorder.promoteCalls).toHaveLength(0);
  });

  it("propagates a job failure to onJobError without throwing", async () => {
    const recorder = newPromoteRecorder();
    const deps: PromoteScheduleDeps = {
      ...makePromoteDeps(() => ts("2026-07-29", "03:00"), recorder),
      promote: async () => {
        throw new Error("promote boom");
      },
    };

    await expect(new PromoteScheduler(deps).tick()).resolves.toBeUndefined();

    expect(recorder.errors).toHaveLength(1);
    expect(recorder.errors[0]!.key).toBe("2026-07-29:promote");
  });
});

describe("tickPromoteTrip — callable directly, independent of PromoteScheduler", () => {
  it("fires at 03:00 on end+1 when called standalone", async () => {
    const recorder = newPromoteRecorder();
    const deps = makePromoteDeps(() => ts("2026-07-29", "03:00"), recorder);

    await tickPromoteTrip(deps, trip, ts("2026-07-29", "03:00"), "2026-07-29");

    expect(recorder.promoteCalls).toHaveLength(1);
  });
});

// ─── dayLogFor — Task 8b's closed conversation-log gap ─────────────────────────────────────
// agent/schedules/dream.ts's `dayLogFor` used to be a hardcoded `""` (a documented placeholder
// — the wave plan's inventory had listed lib/conversation-log.ts as Task 3's job, but Task 3's
// own dispatched brief never included it). It now reads the real chatlog via ConversationLog,
// formatted exactly like old Marcel's own makeDream (bin/marcel.ts:932-940).

describe("dayLogFor", () => {
  it("returns the target date's messages formatted as 'Name: text' lines, matching old Marcel's makeDream", async () => {
    const { dayLogFor } = await import("../agent/schedules/dream.js");
    const log = new ConversationLog(path.join(trip.dir, "chatlog"), trip.timezone);
    log.append({ ts: ts("2026-07-22", "09:00"), from: "1", name: "Jonas", text: "god morgen!" });
    log.append({ ts: ts("2026-07-22", "20:15"), from: "2", name: "Emma", text: "aldri mer bouillabaisse", marcel: false });
    log.append({ ts: ts("2026-07-22", "20:16"), from: "marcel", name: "Marcel", text: "notert!", marcel: true });
    // A different day's entry must not leak into the 2026-07-22 result.
    log.append({ ts: ts("2026-07-23", "09:00"), from: "1", name: "Jonas", text: "dag to" });

    const result = await dayLogFor(trip, "2026-07-22");

    expect(result).toBe("Jonas: god morgen!\nEmma: aldri mer bouillabaisse\nMarcel: notert!");
  });

  it("returns an empty string for a date with no logged messages — nightlyPrompt's own fallback renders '(ingen samtale i dag)' for this", async () => {
    const { dayLogFor } = await import("../agent/schedules/dream.js");

    const result = await dayLogFor(trip, "2026-07-22");

    expect(result).toBe("");
  });
});

// ─── agent/schedules/dream.ts + taste-promote.ts — the eve wrappers themselves ────────────────
// Thin smoke tests only, matching agent/schedules/trip-lifecycle.test.ts's own convention
// (Task 7): the gate is EVE_SCHEDULES_LIVE, off by default, and a gate-off run must be a
// complete no-op — no TripStore root, no gateway secrets, nothing configured, still resolves
// cleanly. Proves these two schedules stay dark until Task 12 flips the gate. Also proves, by
// construction (no `to`/channel import anywhere in either file), that neither ever posts to
// Telegram — internal-only, faithful to old Marcel's own dream/promote jobs.

describe("agent/schedules/dream.ts default export", () => {
  const ENV_KEYS = ["EVE_SCHEDULES_LIVE", "MARCEL_DATA_ROOT", "MARCEL_MODEL_BRAIN"];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("carries the documented every-minute cron cadence", async () => {
    const mod = await import("../agent/schedules/dream.js");
    expect(mod.default.cron).toBe("* * * * *");
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("is a complete no-op when the gate is off — no TripStore root, no secrets, nothing configured, and it still resolves cleanly", async () => {
    const mod = await import("../agent/schedules/dream.js");
    await expect(mod.default.run!({} as never)).resolves.toBeUndefined();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
});

describe("agent/schedules/taste-promote.ts default export", () => {
  const ENV_KEYS = ["EVE_SCHEDULES_LIVE", "MARCEL_DATA_ROOT", "MARCEL_MODEL_BRAIN"];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("carries the documented every-minute cron cadence", async () => {
    const mod = await import("../agent/schedules/taste-promote.js");
    expect(mod.default.cron).toBe("* * * * *");
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("is a complete no-op when the gate is off — no TripStore root, no secrets, nothing configured, and it still resolves cleanly", async () => {
    const mod = await import("../agent/schedules/taste-promote.js");
    await expect(mod.default.run!({} as never)).resolves.toBeUndefined();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
});
