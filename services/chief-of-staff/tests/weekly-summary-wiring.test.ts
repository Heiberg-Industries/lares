import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * LAR-17-s4 — the weekly summary gets `morning-brief.ts`/`evening-brief.ts`'s own belt-and-braces
 * guard: since LAR-17-s3 its hour is a SETTING an owner can change mid-day, and the ledger's own
 * dedupe is keyed on the SLOT (`weekly-summary/<owner date>T<hour>`), not the day — a hour moved
 * AFTER this week's summary already went out gives the new hour's tick a BRAND NEW key the ledger
 * has never seen, and the gate alone would happily send a second one. `alreadySentToday` (already
 * proven for the two briefs in `tests/brief-owner-day-wiring.test.ts`) is the fix; this file is
 * that same proof, scoped to `weekly-summary.ts`.
 *
 * The pattern is `tests/brief-owner-day-wiring.test.ts`'s: fresh module import per "process", fake
 * timers, and a tiny stateful stand-in for the ledger's one rule that matters here — a `sent` row
 * for an item key, ever, means already-seen — so a "restart" inside a case (`vi.resetModules()`)
 * loses the in-memory `lastSlot` exactly as a real restart does and the ledger still holds.
 */

// ─── the owner clock — fixed at home for every case here ───────────────────────────────────

vi.mock("../lib/owner-clock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/owner-clock.js")>()),
  ownerTz: async () => "Europe/Oslo",
}));

// ─── the ledger's already-seen rule ─────────────────────────────────────────────────────────

const sentKeys: string[] = [];
const gatedSendMock = vi.fn(async (_db: unknown, req: { itemKey: string }, send: () => Promise<void>) => {
  if (sentKeys.includes(req.itemKey)) return { verdict: "suppress", reason: "already-seen" } as never;
  await send();
  sentKeys.push(req.itemKey);
  return { verdict: "send" } as never;
});
vi.mock("@lares/agent-kit/proactivity", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gatedSend: gatedSendMock,
  deferredSince: async () => [],
}));

vi.mock("@lares/agent-kit/schedule-heartbeat", () => ({
  recordSchedulePass: async () => true,
  recordScheduleTick: async () => true,
  scheduleKey: (agent: string, schedule: string) => `${agent}/${schedule}`,
  tickKey: (key: string) => `${key}#tick`,
}));
vi.mock("../lib/signal-emit.js", () => ({ emitSignal: async () => {} }));

// ─── the learning store — always has something to summarise, so the gate is what is under test

vi.mock("../lib/dream-store.js", () => ({
  activePreferences: async () => [{ text: "prefers short answers" }],
}));

/**
 * LAR-17-s4 — the same fake pool shape `brief-owner-day-wiring.test.ts` uses: `schedule_settings`
 * (the kit's `readScheduleHours`, via `lib/schedule-hours.ts`) and the `alreadySentToday` guard's
 * own `initiations` lookup, both derived from THIS FILE's own `sentKeys` so the two never disagree
 * about what has gone out.
 */
let scheduleHoursRow: Record<string, number[]> = {};
const fakePool = {
  query: async (sql: string, params: unknown[] = []) => {
    if (sql.includes("FROM schedule_settings")) {
      const hours = scheduleHoursRow[params[1] as string];
      return hours ? { rows: [{ hours }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM initiations") && sql.includes("item_key LIKE")) {
      const ownerDay = String(params[2] ?? "");
      const prefix = String(params[3] ?? "").replace(/%$/, "");
      const has = sentKeys.some((k) => k.startsWith(prefix) && k.slice(prefix.length).startsWith(`${ownerDay}T`));
      return has ? { rows: [{ "?column?": 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  },
};
vi.mock("@lares/agent-kit/db", () => ({ getPool: () => fakePool, closePool: async () => {} }));

// ─── plumbing ───────────────────────────────────────────────────────────────────────────────

const ENV_KEYS = ["EVE_SCHEDULES_LIVE", "DATABASE_URL", "TELEGRAM_PRINCIPAL_ID"];
let saved: Record<string, string | undefined>;
let prompts: string[] = [];

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env["EVE_SCHEDULES_LIVE"] = "1";
  process.env["TELEGRAM_PRINCIPAL_ID"] = "123456";
  scheduleHoursRow = {};
  sentKeys.length = 0;
  prompts = [];
  gatedSendMock.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers();
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ctx = {
  to: () => ({ send: async (prompt: string) => { prompts.push(prompt); return {}; } }),
  waitUntil: () => {},
  appAuth: {},
} as never;

type Schedule = { run?: (c: never) => Promise<void> };
const weeklySummary = async (): Promise<Schedule> =>
  (await import("../agent/schedules/weekly-summary.js")).default as Schedule;

/** One cron tick at `instant`. */
async function tick(schedule: Schedule, instant: string): Promise<void> {
  vi.setSystemTime(new Date(instant));
  await schedule.run!(ctx);
}

describe("LAR-17-s4 — a stored hour moves the slot; a mid-day change never double-sends", () => {
  it("no row: the default Sunday 09:00 fires once", async () => {
    await tick(await weeklySummary(), "2026-09-20T07:00:00Z"); // 09:00 Oslo, Sunday
    expect(sentKeys).toEqual(["weekly-summary/2026-09-20T9"]);
  });

  it("a stored hour moves the slot — the old hour no longer fires that day", async () => {
    scheduleHoursRow["weekly-summary"] = [10];
    await tick(await weeklySummary(), "2026-09-20T08:00:00Z"); // 10:00 Oslo — the NEW hour
    expect(sentKeys).toEqual(["weekly-summary/2026-09-20T10"]);

    await tick(await weeklySummary(), "2026-09-20T07:00:00Z"); // 09:00 Oslo, the OLD hour, same day
    expect(sentKeys).toEqual(["weekly-summary/2026-09-20T10"]); // still just the one
  });

  it("the hour moves from 9 to 10 AFTER this week's summary already went out — no second send, including across a module reload", async () => {
    await tick(await weeklySummary(), "2026-09-20T07:00:00Z"); // 09:00 Oslo — the default hour
    expect(sentKeys).toEqual(["weekly-summary/2026-09-20T9"]);

    // The owner changes the setting in the console, and the process restarts in between — the
    // harder case: `lastSlot` AND the schedule-hours cache are both gone, so only the DB-backed
    // guard can still catch this.
    scheduleHoursRow["weekly-summary"] = [10];
    vi.resetModules();
    await tick(await weeklySummary(), "2026-09-20T08:00:00Z"); // 10:00 Oslo, the SAME Sunday

    // "weekly-summary/2026-09-20T10" is a BRAND NEW item key the ledger has never seen — the
    // gate alone would happily send it. `alreadySentToday` is what stops it: one summary that day.
    expect(sentKeys).toEqual(["weekly-summary/2026-09-20T9"]);
    expect(prompts).toHaveLength(1);
  });
});
