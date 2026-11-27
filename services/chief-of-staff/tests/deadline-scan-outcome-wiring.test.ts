import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEADLINE_SCAN_SKIPS } from "@lares/agent-kit/deadline-scan-outcome";

/**
 * The mail scan for due notices records its outcome (ADR 0031), driven through the morning brief's
 * real `run()`: the scan is the brief's mail pass, so a real slot pass records running, then finished
 * with how many due notices it saw, or failed with the error; a missing or unusable mailbox is a skip
 * with its reason. A test brief records nothing: it is not the day's scan.
 *
 * The harness is `tests/morning-brief-test-brief.test.ts`'s (fresh import, fake timers, a pool that
 * answers nothing), with the outcome calls and the chosen mailbox as spies.
 */

vi.mock("../lib/owner-clock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/owner-clock.js")>()),
  ownerTz: async () => "Europe/Berlin",
}));
vi.mock("@lares/agent-kit/proactivity", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gatedSend: vi.fn(async (_db: unknown, _req: unknown, send: () => Promise<void>) => { await send(); return { verdict: "send" }; }),
  deferredSince: async () => [],
}));

const outcome = vi.hoisted(() => ({
  started: vi.fn(async (..._a: unknown[]) => true),
  finished: vi.fn(async (..._a: unknown[]) => true),
  failed: vi.fn(async (..._a: unknown[]) => true),
  skipped: vi.fn(async (..._a: unknown[]) => true),
}));
vi.mock("@lares/agent-kit/schedule-heartbeat", () => ({
  recordSchedulePass: async () => true,
  recordScheduleTick: async () => true,
  recordRunStarted: outcome.started,
  recordRunFinished: outcome.finished,
  recordRunFailed: outcome.failed,
  recordRunSkipped: outcome.skipped,
  scheduleKey: (agent: string, schedule: string) => `${agent}/${schedule}`,
  tickKey: (key: string) => `${key}#tick`,
}));
vi.mock("../lib/signal-emit.js", () => ({ emitSignal: async () => {} }));

const fakePool = { query: async () => ({ rows: [], rowCount: 0 }) };
vi.mock("@lares/agent-kit/db", () => ({ getPool: () => fakePool, closePool: async () => {} }));
vi.mock("../lib/initiation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/initiation.js")>()),
  alreadySentToday: async () => false,
}));
vi.mock("../lib/deadlines-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/deadlines-store.js")>()),
  markCandidatesSurfaced: async () => {},
  upsertCandidate: async () => {},
}));

const doors = [{ kind: "telegram", enabled: true, settings: {} }];
vi.mock("../lib/definition.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/definition.js")>();
  return {
    ...real,
    thisAgent: async (id: string | undefined) => {
      const r = await real.thisAgent(id);
      return { ...r, loaded: { ...r.loaded, definition: { ...r.loaded.definition, doors } } };
    },
  };
});
vi.mock("../lib/identity-client.js", () => ({ configuredOwnerId: () => "owner-1", listAliases: async () => ["owner@example.com"] }));
vi.mock("../lib/google.js", () => ({
  GoogleUnenrolledError: class GoogleUnenrolledError extends Error {},
  googleClients: () => ({ gmail: async () => ({ searchThreadIds: async () => [], readThread: async () => [] }), calendar: async () => ({}) }),
  listEnrolledMailboxes: async () => ["owner@example.com"],
}));
vi.mock("../lib/calendar-fanout.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/calendar-fanout.js")>()),
  listEventsEverywhere: async () => [],
}));

const mailbox = vi.hoisted(() => ({ result: { ok: true } as { ok: boolean; reason?: string } }));
vi.mock("../lib/chosen-mailbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/chosen-mailbox.js")>()),
  chosenMailbox: async () => mailbox.result,
}));

/** What the gather does: record this many due notices, or throw. */
let gather: { notices: number } | { throws: string } = { notices: 0 };
vi.mock("../lib/obligation-pipeline.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/obligation-pipeline.js")>()),
  gatherOpenObligations: async (deps: { recordCandidate?: (c: unknown) => Promise<void> }) => {
    if ("throws" in gather) throw new Error(gather.throws);
    for (let i = 0; i < gather.notices; i++) await deps.recordCandidate?.({ threadId: `t${i}`, subject: "Invoice due", sender: "them@example.com", seenAt: new Date() });
    return [];
  },
}));
vi.mock("../lib/obligations-store.js", () => ({
  ensureObligationsTableOnce: async () => {}, dismissedThreads: async () => new Set<string>(), upsertSeen: async () => {},
  nightBeforeDelivered: async () => new Set<string>(), resolvedThreads: async () => new Map<string, Date>(),
  markResolved: async () => {}, cachedIntent: async () => null, recordIntent: async () => {},
}));
let queue: { id: string; door: "telegram" }[] = [];
vi.mock("../lib/test-brief.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/test-brief.js")>()),
  claimTestBrief: async () => queue.shift() ?? null,
  finishTestBrief: async () => {},
}));

const ENV_KEYS = ["EVE_SCHEDULES_LIVE", "DATABASE_URL", "TELEGRAM_PRINCIPAL_ID", "TRAVEL_PATH", "BRIEF_PICKS_DIR"];
let saved: Record<string, string | undefined>;
const ctx = {
  to: () => ({ send: () => Promise.resolve({ sessionId: "s", deliveryId: "d" }) }),
  waitUntil: vi.fn(),
  appAuth: { authenticator: "app", principalId: "eve:app", principalType: "runtime" },
} as never;
type Schedule = { run?: (c: never) => Promise<void> };
const morning = async (): Promise<Schedule> => (await import("../agent/schedules/morning-brief.js")).default as Schedule;
async function tick(instant: string): Promise<void> {
  vi.setSystemTime(new Date(instant));
  await (await morning()).run!(ctx);
}
const BRIEF_MINUTE = "2026-09-16T06:00:00Z"; // 08:00 Berlin
const JOB = "chief-of-staff/deadline-scan";

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env["EVE_SCHEDULES_LIVE"] = "1";
  process.env["TELEGRAM_PRINCIPAL_ID"] = "123456";
  mailbox.result = { ok: true };
  gather = { notices: 0 };
  queue = [];
  for (const m of Object.values(outcome)) m.mockClear();
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

describe("the mail scan for due notices records what it did", () => {
  it("a real pass: running, then finished with how many due notices it saw, under the agent's own key", async () => {
    gather = { notices: 2 };
    await tick(BRIEF_MINUTE);
    expect(outcome.started).toHaveBeenCalledTimes(1);
    expect(outcome.started.mock.calls[0]!.slice(1)).toEqual([JOB, { agent: "chief-of-staff", detail: "Scanning mail for due notices." }]);
    expect(outcome.finished).toHaveBeenCalledTimes(1);
    expect(outcome.finished.mock.calls[0]!.slice(1)).toEqual([JOB, { agent: "chief-of-staff", counts: { found: 2 } }]);
    expect(outcome.skipped).not.toHaveBeenCalled();
    expect(outcome.failed).not.toHaveBeenCalled();
  });

  it("a gather that fails is recorded as failed, with its message; the brief still goes out", async () => {
    gather = { throws: "Gmail did not answer" };
    await tick(BRIEF_MINUTE);
    expect(outcome.started).toHaveBeenCalledTimes(1);
    expect(outcome.failed.mock.calls[0]!.slice(1)).toEqual([JOB, "Gmail did not answer", { agent: "chief-of-staff" }]);
    expect(outcome.finished).not.toHaveBeenCalled();
  });

  it("no mailbox chosen: a skip with its reason, and no run recorded", async () => {
    mailbox.result = { ok: false, reason: "none" };
    await tick(BRIEF_MINUTE);
    expect(outcome.skipped).toHaveBeenCalledTimes(1);
    expect(outcome.skipped.mock.calls[0]!.slice(1, 3)).toEqual([JOB, DEADLINE_SCAN_SKIPS.noMailbox]);
    expect(outcome.started).not.toHaveBeenCalled();
    expect(outcome.finished).not.toHaveBeenCalled();
    expect(outcome.failed).not.toHaveBeenCalled();
  });

  it("a mailbox that cannot be used: a skip that says why, in the mailbox's own words", async () => {
    mailbox.result = { ok: false, reason: "account-not-ok" };
    await tick(BRIEF_MINUTE);
    expect(outcome.skipped.mock.calls[0]!.slice(1, 4)).toEqual([JOB, DEADLINE_SCAN_SKIPS.mailboxUnusable,
      "The chosen mailbox cannot be used right now: the chosen account was disconnected or needs to be connected again."]);
  });

  it("a test brief records nothing: it is not the day's scan", async () => {
    queue = [{ id: "r1", door: "telegram" }];
    gather = { notices: 1 };
    await tick("2026-09-16T08:30:00Z"); // 10:30 Berlin, outside the brief's minute
    for (const m of Object.values(outcome)) expect(m).not.toHaveBeenCalled();
  });
});
