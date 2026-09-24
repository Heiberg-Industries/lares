import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The nightly hand-over schedule's own wiring — the gate, the slot, the pass, and what a failure
 * inside the job costs. The WORK itself (which day is summarized, where the summary is stored,
 * and the stamp that keeps it from colliding with the on-completion path) is proved against a
 * real disposable Postgres in `tests/telegram-rotation.test.ts`; nothing here needs a database.
 *
 * The clock is pinned per case because the slot gate is exact-minute: `slotIn` answers non-null
 * only on minute 0 of the hour, and the module remembers the last slot it ran, so two cases that
 * both reach the slot must sit on different nights.
 */
const enabled = vi.hoisted(() => ({ on: true }));
const hb = vi.hoisted(() => ({ ticks: [] as string[], passes: [] as string[] }));
const pool = vi.hoisted(() => ({ queries: [] as string[] }));
const signals = vi.hoisted(() => ({ raised: [] as string[] }));
const job = vi.hoisted(() => ({ impl: null as null | ((...args: never[]) => unknown) }));

vi.mock("@lares/agent-kit/db", () => ({
  getPool: () => ({
    query: async (sql: string) => {
      pool.queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
  }),
}));
vi.mock("@lares/agent-kit/schedule-switch", () => ({
  scheduleEnabled: () => enabled.on,
}));
vi.mock("@lares/agent-kit/schedule-heartbeat", () => ({
  recordScheduleTick: async (_db: unknown, key: string) => { hb.ticks.push(key); },
  recordSchedulePass: async (_db: unknown, key: string) => { hb.passes.push(key); },
}));
vi.mock("../lib/definition.js", () => ({
  thisAgent: async () => ({ loaded: { definition: { name: "fixture-agent" } } }),
}));
vi.mock("../lib/owner-clock.js", () => ({ ownerTz: async () => "Europe/Oslo" }));
vi.mock("../lib/signal-emit.js", () => ({
  emitSignal: async (event: string) => { signals.raised.push(event); },
}));
// Proves the "no model call" claims: any summary would have to come through here.
vi.mock("../lib/llm-complete.js", () => ({ gatewayComplete: vi.fn(async () => "never asked for") }));
// The job is reached through a seam so a case can watch its arguments, make it throw, or let the
// real implementation run against the fake pool above.
vi.mock("../lib/telegram-rotation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/telegram-rotation.js")>();
  return {
    ...actual,
    runDayHandover: (...args: never[]) => job.impl!(...args),
  };
});

const realRotation =
  await vi.importActual<typeof import("../lib/telegram-rotation.js")>("../lib/telegram-rotation.js");
const schedule = (await import("../agent/schedules/telegram-handover.js")).default as {
  cron: string;
  run: () => Promise<void>;
};

const quiet =() => vi.fn(async () => ({ day: "", chats: 0, written: 0, skipped: 0, failed: 0 }));

beforeEach(() => {
  enabled.on = true;
  hb.ticks.length = 0;
  hb.passes.length = 0;
  pool.queries.length = 0;
  signals.raised.length = 0;
  job.impl = quiet();
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the nightly Telegram hand-over schedule", () => {
  it("runs every minute, like every other slot schedule in this service", () => {
    expect(schedule.cron).toBe("* * * * *");
  });

  it("a switched-off schedule stamps nothing and does no work", async () => {
    enabled.on = false;
    vi.setSystemTime(new Date("2026-08-17T22:00:00Z"));

    await schedule.run();

    expect(hb.ticks).toEqual([]);
    expect(hb.passes).toEqual([]);
    expect(job.impl).not.toHaveBeenCalled();
  });

  it("stamps its tick every minute, but only works on the slot", async () => {
    // 00:30 Oslo — past the hour, so not the slot.
    vi.setSystemTime(new Date("2026-08-17T22:30:00Z"));

    await schedule.run();

    expect(hb.ticks).toEqual(["saga/telegram-handover"]);
    expect(hb.passes).toEqual([]);
    expect(job.impl).not.toHaveBeenCalled();
  });

  it("on the slot, hands over the day that just ENDED, once, and stamps the pass", async () => {
    // 2026-08-18 00:00 Oslo: the day being closed is the 17th.
    vi.setSystemTime(new Date("2026-08-17T22:00:00Z"));

    await schedule.run();
    await schedule.run(); // the same slot again — a minute later, nothing more to do

    expect(job.impl).toHaveBeenCalledTimes(1);
    expect(vi.mocked(job.impl!).mock.calls[0]![1]).toBe("2026-08-17");
    expect(hb.passes).toEqual(["saga/telegram-handover"]);
  });

  it("an installation with no Telegram conversations at all is one query and no model call", async () => {
    job.impl = vi.fn(realRotation.runDayHandover) as never;
    vi.setSystemTime(new Date("2026-08-18T22:00:00Z"));

    await schedule.run();

    expect(pool.queries).toHaveLength(1);
    expect(pool.queries[0]).toMatch(/FROM telegram_daily_log/);
    const { gatewayComplete } = await import("../lib/llm-complete.js");
    expect(vi.mocked(gatewayComplete)).not.toHaveBeenCalled();
    expect(hb.passes).toEqual(["saga/telegram-handover"]);
  });

  it("a failure inside the job costs one log line and a signal, and never stamps a pass", async () => {
    job.impl = vi.fn(async () => { throw new Error("the database is unreachable"); });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.setSystemTime(new Date("2026-08-19T22:00:00Z"));

    try {
      await expect(schedule.run()).resolves.toBeUndefined();
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }

    expect(hb.ticks).toEqual(["saga/telegram-handover"]);
    expect(hb.passes).toEqual([]);
    expect(signals.raised).toEqual(["schedule-tick-failed"]);
  });
});
