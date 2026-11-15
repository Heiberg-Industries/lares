import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TEST_BRIEF_LANE,
  TEST_BRIEF_NOTHING_NEW_PROMPT,
  TEST_BRIEF_PROMPT_MARKER,
} from "@lares/agent-kit/delivery";

/**
 * "Send a test brief now", driven through the morning brief's real `run()`: a request the console
 * wrote is claimed by a tick outside the brief's minute, and sent into the chosen door through the
 * same routing and `sendTurn`, under the schedule's own identity. What it must NOT do is just as
 * much the point: no gate, no once-a-day check, no ledger row, none of the real brief's
 * bookkeeping, and never anything that could make the real brief miss its minute.
 *
 * The harness is `tests/brief-owner-day-wiring.test.ts`'s (fresh import, fake timers, a pool that
 * answers nothing), with the request store replaced by a queue so a case decides what is claimed.
 * The store's own SQL is proved against a real database in `tests/test-brief-store.test.ts`.
 */

vi.mock("../lib/owner-clock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/owner-clock.js")>()),
  ownerTz: async () => "Europe/Berlin",
}));

const gatedSendMock = vi.fn(async (_db: unknown, _req: unknown, send: () => Promise<void>) => {
  await send();
  return { verdict: "send" } as never;
});
vi.mock("@lares/agent-kit/proactivity", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gatedSend: gatedSendMock,
  deferredSince: async () => [],
}));

const recordSchedulePass = vi.fn(async () => true);
vi.mock("@lares/agent-kit/schedule-heartbeat", () => ({
  recordSchedulePass,
  recordScheduleTick: async () => true,
  scheduleKey: (agent: string, schedule: string) => `${agent}/${schedule}`,
  tickKey: (key: string) => `${key}#tick`,
}));
const emitSignal = vi.fn(async () => {});
vi.mock("../lib/signal-emit.js", () => ({ emitSignal }));

const queries: string[] = [];
const fakePool = {
  query: async (sql: string) => {
    queries.push(sql);
    return { rows: [], rowCount: 0 };
  },
};
vi.mock("@lares/agent-kit/db", () => ({ getPool: () => fakePool, closePool: async () => {} }));

const alreadySentToday = vi.fn(async () => false);
vi.mock("../lib/initiation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/initiation.js")>()),
  alreadySentToday,
}));

const markCandidatesSurfaced = vi.fn(async () => {});
vi.mock("../lib/deadlines-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/deadlines-store.js")>()),
  markCandidatesSurfaced,
}));

// The agent's definition with Telegram switched on, as it is once the door is connected.
vi.mock("../lib/definition.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/definition.js")>();
  return {
    ...real,
    thisAgent: async (id: string | undefined) => {
      const r = await real.thisAgent(id);
      return { ...r, loaded: { ...r.loaded, definition: { ...r.loaded.definition, doors: [{ kind: "telegram", enabled: true, settings: {} }] } } };
    },
  };
});

vi.mock("../lib/identity-client.js", () => ({
  configuredOwnerId: () => "owner-1",
  listAliases: async () => ["owner@example.com"],
}));
vi.mock("../lib/google.js", () => ({
  googleClients: () => ({
    gmail: async () => ({ searchThreadIds: async () => [], readThread: async () => [] }),
    calendar: async () => ({}),
  }),
  listEnrolledMailboxes: async () => ["owner@example.com"],
}));
vi.mock("../lib/calendar-fanout.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/calendar-fanout.js")>()),
  listEventsEverywhere: async () => [],
}));

const OWED = {
  threadId: "t1", subject: "The proposal", counterpartyName: "Them", counterpartyAddress: "them@example.com",
  lastMessageAt: new Date("2026-09-10T09:00:00Z"), ageHours: 30, isRePing: false, unansweredCount: 1, source: "gmail" as const,
};
let obligations: (typeof OWED)[] = [OWED];
vi.mock("../lib/obligation-pipeline.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/obligation-pipeline.js")>()),
  gatherOpenObligations: async () => obligations,
}));

/** How long last night's delivery record takes to read: the one gathering step with no timeout
 *  of its own, so a case can hold the pass there for as long as it likes. */
let nightBeforeDelayMs = 0;
vi.mock("../lib/obligations-store.js", () => ({
  ensureObligationsTableOnce: async () => {},
  dismissedThreads: async () => new Set<string>(),
  upsertSeen: async () => {},
  nightBeforeDelivered: async () => {
    nightBeforeReads++;
    if (nightBeforeDelayMs > 0) await new Promise((r) => setTimeout(r, nightBeforeDelayMs));
    return new Set<string>();
  },
  resolvedThreads: async () => new Map<string, Date>(),
  markResolved: async () => {},
  cachedIntent: async () => null,
  recordIntent: async () => {},
}));

// The request store: a queue a case fills, and a record of every outcome written.
type Claimed = { id: string; door: "slack" | "telegram" };
let queue: Claimed[] = [];
const claimTestBrief = vi.fn(async (_db: unknown, _agent: string, _owner: string) => queue.shift() ?? null);
const finishTestBrief = vi.fn(async (_db: unknown, _id: string, _r: { outcome: string; door?: string; sentAt?: string }) => {});
vi.mock("../lib/test-brief.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/test-brief.js")>()),
  claimTestBrief,
  finishTestBrief,
}));

// ─── plumbing ───────────────────────────────────────────────────────────────────────────────

const ENV_KEYS = ["EVE_SCHEDULES_LIVE", "DATABASE_URL", "TELEGRAM_PRINCIPAL_ID", "TRAVEL_PATH", "BRIEF_PICKS_DIR"];
let saved: Record<string, string | undefined>;
type Sent = { channel: unknown; target: Record<string, unknown>; prompt: string; options: { auth: Record<string, unknown> } };
let sends: Sent[] = [];
/** What a send does: resolve at once (default), or never. */
let sendNeverSettles = false;

const APP_AUTH = { authenticator: "app", principalId: "eve:app", principalType: "runtime" };
const ctx = {
  to: (channel: unknown, target: Record<string, unknown>) => ({
    send: (prompt: string, options: Sent["options"]) => {
      sends.push({ channel, target, prompt, options });
      return sendNeverSettles ? new Promise(() => {}) : Promise.resolve({ sessionId: "s", deliveryId: "d" });
    },
  }),
  waitUntil: vi.fn(),
  appAuth: APP_AUTH,
} as never;

type Schedule = { run?: (c: never) => Promise<void> };
const morning = async (): Promise<Schedule> => (await import("../agent/schedules/morning-brief.js")).default as Schedule;

/** One cron tick at `instant` (UTC). Berlin is UTC+2 in September; the brief hour is 08:00 Berlin. */
async function tick(schedule: Schedule, instant: string): Promise<void> {
  vi.setSystemTime(new Date(instant));
  await schedule.run!(ctx);
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env["EVE_SCHEDULES_LIVE"] = "1";
  process.env["TELEGRAM_PRINCIPAL_ID"] = "123456";
  queue = [];
  sends = [];
  queries.length = 0;
  obligations = [OWED];
  nightBeforeDelayMs = 0;
  nightBeforeReads = 0;
  sendNeverSettles = false;
  for (const m of [gatedSendMock, recordSchedulePass, emitSignal, alreadySentToday, markCandidatesSurfaced, claimTestBrief, finishTestBrief]) m.mockClear();
  (ctx as unknown as { waitUntil: ReturnType<typeof vi.fn> }).waitUntil.mockClear();
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

const outcomes = () => finishTestBrief.mock.calls.map((c) => c[2].outcome);

/** Let real I/O (the definition read) run until `cond` holds; fake timers do not move meanwhile. */
const realImmediate = setImmediate;
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 5_000 && !cond(); i++) await new Promise((r) => realImmediate(r));
  if (!cond()) throw new Error("the pass never reached the expected point");
}
let nightBeforeReads = 0;

describe("a test brief is the real brief's material, into the chosen door, as an owner job", () => {
  it("sends one turn into Telegram under the schedule's identity, on its own lane, with the marker first", async () => {
    queue = [{ id: "r1", door: "telegram" }];
    await tick(await morning(), "2026-09-16T08:30:00Z"); // 10:30 Berlin

    expect(sends).toHaveLength(1);
    expect(sends[0]!.target).toEqual({ chatId: "123456" });
    expect(sends[0]!.prompt.startsWith(`${TEST_BRIEF_PROMPT_MARKER}\n\n`)).toBe(true);
    expect(sends[0]!.prompt).toContain("The proposal"); // today's real material follows the marker
    const auth = sends[0]!.options.auth;
    expect(auth).toMatchObject(APP_AUTH);
    expect((auth["attributes"] as Record<string, unknown>)["lane"]).toBe(TEST_BRIEF_LANE);
    expect(finishTestBrief).toHaveBeenCalledTimes(1);
    expect(finishTestBrief.mock.calls[0]![1]).toBe("r1");
    expect(finishTestBrief.mock.calls[0]![2]).toMatchObject({ outcome: "sent", door: "telegram" });
    expect(typeof finishTestBrief.mock.calls[0]![2].sentAt).toBe("string");
  });

  it("claims only for this agent and the configured owner", async () => {
    await tick(await morning(), "2026-09-16T08:30:00Z");
    expect(claimTestBrief).toHaveBeenCalledTimes(1);
    expect(claimTestBrief.mock.calls[0]!.slice(1)).toEqual(["chief-of-staff", "owner-1"]);
  });

  it("does none of what a real brief records: no gate, no once-a-day check, no stamps, no pass, no brief-sent", async () => {
    queue = [{ id: "r1", door: "telegram" }];
    await tick(await morning(), "2026-09-16T08:30:00Z");

    expect(sends).toHaveLength(1);
    expect(gatedSendMock).not.toHaveBeenCalled();
    expect(alreadySentToday).not.toHaveBeenCalled();
    expect(markCandidatesSurfaced).not.toHaveBeenCalled();
    expect(recordSchedulePass).not.toHaveBeenCalled();
    expect(emitSignal).not.toHaveBeenCalled();
    expect(queries.some((q) => /initiations|web_inbox/.test(q))).toBe(false);
  });

  it("never registers its send with the tick: the pass waits for the hand-over itself", async () => {
    queue = [{ id: "r1", door: "telegram" }];
    await tick(await morning(), "2026-09-16T08:30:00Z");
    expect(sends).toHaveLength(1);
    expect((ctx as unknown as { waitUntil: ReturnType<typeof vi.fn> }).waitUntil).not.toHaveBeenCalled();
  });

  it("refuses a door that is not connected, with no fallback to web chat", async () => {
    queue = [{ id: "r1", door: "slack" }]; // no Slack address on this agent
    await tick(await morning(), "2026-09-16T08:30:00Z");

    expect(sends).toHaveLength(0);
    expect(outcomes()).toEqual(["door-not-connected"]);
    expect(queries.some((q) => /web_inbox/.test(q))).toBe(false);
  });

  it("on a morning with nothing to say, still sends exactly one turn, with the fixed line", async () => {
    obligations = [];
    queue = [{ id: "r1", door: "telegram" }];
    await tick(await morning(), "2026-09-16T08:30:00Z");

    expect(sends).toHaveLength(1);
    expect(sends[0]!.prompt).toBe(`${TEST_BRIEF_PROMPT_MARKER}\n\n${TEST_BRIEF_NOTHING_NEW_PROMPT}`);
    expect(outcomes()).toEqual(["sent"]);
    expect(recordSchedulePass).not.toHaveBeenCalled();
  });
});

describe("the real brief always keeps its minute", () => {
  it("at minute 0 of the brief hour, the real brief runs and no request is looked at", async () => {
    queue = [{ id: "r1", door: "telegram" }];
    await tick(await morning(), "2026-09-16T06:00:00Z"); // 08:00 Berlin

    expect(claimTestBrief).not.toHaveBeenCalled();
    expect(gatedSendMock).toHaveBeenCalledTimes(1);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.prompt.startsWith(TEST_BRIEF_PROMPT_MARKER)).toBe(false);
    expect(alreadySentToday).toHaveBeenCalledTimes(1);
  });

  it("a request asked for at :57-:59 before the brief hour stays pending, and is claimed after the hour", async () => {
    queue = [{ id: "r1", door: "telegram" }];
    const schedule = await morning();
    await tick(schedule, "2026-09-16T05:56:00Z"); // 07:56 — claimable; take the request out of the way first
    expect(claimTestBrief).toHaveBeenCalledTimes(1);
    claimTestBrief.mockClear();
    sends = [];

    queue = [{ id: "r2", door: "telegram" }];
    for (const at of ["2026-09-16T05:57:00Z", "2026-09-16T05:58:00Z", "2026-09-16T05:59:00Z"]) await tick(schedule, at);
    expect(claimTestBrief).not.toHaveBeenCalled();

    await tick(schedule, "2026-09-16T06:00:00Z"); // 08:00: the real brief
    expect(claimTestBrief).not.toHaveBeenCalled();
    expect(sends.map((s) => s.prompt.startsWith(TEST_BRIEF_PROMPT_MARKER))).toEqual([false]);

    await tick(schedule, "2026-09-16T06:01:00Z"); // 08:01: now the test
    expect(claimTestBrief).toHaveBeenCalledTimes(1);
    expect(sends.map((s) => s.prompt.startsWith(TEST_BRIEF_PROMPT_MARKER))).toEqual([false, true]);
  });

  it("run returns within the budget when the send never settles, and the outcome says so", async () => {
    const { TEST_BRIEF_BUDGET_MS } = await import("../agent/schedules/morning-brief.js");
    sendNeverSettles = true;
    queue = [{ id: "r1", door: "telegram" }];
    const schedule = await morning();
    vi.setSystemTime(new Date("2026-09-16T08:30:00Z"));
    let returned = false;
    const done = schedule.run!(ctx).then(() => { returned = true; });
    await until(() => sends.length === 1);

    await vi.advanceTimersByTimeAsync(TEST_BRIEF_BUDGET_MS + 1_000);
    expect(returned).toBe(true);
    await done;
    expect(sends).toHaveLength(1);
    expect(outcomes()).toEqual(["send-unknown"]);
  });

  it("sends nothing when the budget is already spent before the hand-over", async () => {
    const { TEST_BRIEF_BUDGET_MS, TEST_BRIEF_SEND_WAIT_MS } = await import("../agent/schedules/morning-brief.js");
    nightBeforeDelayMs = TEST_BRIEF_BUDGET_MS - TEST_BRIEF_SEND_WAIT_MS + 5_000; // gathering eats the budget
    queue = [{ id: "r1", door: "telegram" }];
    const schedule = await morning();
    vi.setSystemTime(new Date("2026-09-16T08:30:00Z"));
    const done = schedule.run!(ctx);
    await until(() => nightBeforeReads === 1);

    await vi.advanceTimersByTimeAsync(TEST_BRIEF_BUDGET_MS + 1_000);
    await done;
    expect(sends).toHaveLength(0);
    expect(outcomes()).toEqual(["too-slow"]);
  });

  it("a pass held past the whole budget returns on time, and still sends nothing afterwards", async () => {
    const { TEST_BRIEF_BUDGET_MS } = await import("../agent/schedules/morning-brief.js");
    nightBeforeDelayMs = TEST_BRIEF_BUDGET_MS + 60_000;
    queue = [{ id: "r1", door: "telegram" }];
    const schedule = await morning();
    vi.setSystemTime(new Date("2026-09-16T08:30:00Z"));
    let returned = false;
    const done = schedule.run!(ctx).then(() => { returned = true; });
    await until(() => nightBeforeReads === 1);

    await vi.advanceTimersByTimeAsync(TEST_BRIEF_BUDGET_MS + 1_000);
    expect(returned).toBe(true);
    await done;
    expect(outcomes()).toEqual(["too-slow"]);

    await vi.advanceTimersByTimeAsync(120_000); // the held gathering finishes after the tick returned
    expect(sends).toHaveLength(0);
  });

  it("a claimed request is sent once: the next tick finds nothing to claim", async () => {
    queue = [{ id: "r1", door: "telegram" }];
    const schedule = await morning();
    await tick(schedule, "2026-09-16T08:30:00Z");
    await tick(schedule, "2026-09-16T08:31:00Z");
    expect(sends).toHaveLength(1);
    expect(finishTestBrief).toHaveBeenCalledTimes(1);
  });
});
