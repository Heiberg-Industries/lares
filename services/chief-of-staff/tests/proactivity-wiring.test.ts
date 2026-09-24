import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { closePool } from "@lares/agent-kit/db";

/**
 * ORB-193 Task 3 — the WIRING proof: every proactive send in this service goes through
 * `@lares/agent-kit/proactivity`'s `gatedSend`, and a held-back initiation costs the schedule
 * its message but NOT its heartbeat.
 *
 * The pattern is `tests/schedule-signal-wiring.test.ts`'s, with one addition: the kit's gate is
 * MOCKED to answer `suppress` without ever invoking the `send` callback it is handed. That is
 * the only way to prove the two properties this ticket turns on, because the real gate under
 * default settings answers `send` for everything this fleet sends (Global Constraints), so a
 * test against the real engine can never distinguish "gated" from "not wired at all":
 *
 *   (a) the door send is NOT called — the whole point of a suppression, and
 *   (b) `recordSchedulePass` still stamps — a schedule that goes quiet because the OWNER asked
 *       for quiet must not read as a dead schedule in `input-freshness.sh` (ORB-179's ten
 *       silent days are the failure this heartbeat exists to make visible).
 *
 * One schedule per initiation class, as the plan's Task 3 requires: `evening-brief` at its slot
 * (scheduled), `reminders` with a due row (scheduled/owner-set-time, and the one lane whose
 * "send" is a raw HTTP call rather than a session), and `reping` with a due re-ping
 * (escalation).
 */

// ─── The mocked gate ────────────────────────────────────────────────────────────────────────

/** The default answer for every case: a genuine hold. `beforeEach` RE-INSTALLS it, because a case
 *  that switches to `already-seen` (`gateSaysAlreadySeen`) would otherwise leak that implementation
 *  into every case after it — and "already seen" is the one verdict that makes a lane write. */
const gatedSendMock = vi.fn(async (_db: unknown, _req: unknown, _send: () => Promise<void>) => ({
  verdict: "suppress",
  reason: "dnd",
}) as never);
const HOLD = async () => ({ verdict: "suppress", reason: "dnd" }) as never;
const deferredSinceMock = vi.fn(async () => [] as Array<{ door: string; count: number }>);

/** LAR-35-s2: `wouldInitiate`'s own mocked gate — the same default hold as `gatedSendMock`, kept
 *  as a SEPARATE `vi.fn` because `wouldSend` takes no `send` callback at all: a case must be able
 *  to tell "the precheck asked" apart from "a real send was gated". */
const wouldSendMock = vi.fn(async (_db: unknown, _req: unknown) => ({
  verdict: "suppress",
  reason: "dnd",
}) as never);

// PARTIAL: `owner-clock.ts`'s `clockParts` (and so every slot in this service) reads this module's
// own `ownerDay`/`wallClock`. Only the two functions the schedules call are replaced.
vi.mock("@lares/agent-kit/proactivity", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gatedSend: gatedSendMock,
  wouldSend: wouldSendMock,
  deferredSince: deferredSinceMock,
}));

const recordSchedulePassMock = vi.fn(async () => true);
const recordScheduleTickMock = vi.fn(async () => true);

vi.mock("@lares/agent-kit/schedule-heartbeat", () => ({
  recordSchedulePass: recordSchedulePassMock,
  recordScheduleTick: recordScheduleTickMock,
  scheduleKey: (agent: string, schedule: string) => `${agent}/${schedule}`,
  tickKey: (key: string) => `${key}#tick`,
}));

/** The owner clock resolves off a database and a trip store; neither exists here, and its own
 *  contract is "never throws, falls back to home" — pinned rather than exercised. */
vi.mock("../lib/owner-clock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/owner-clock.js")>()),
  ownerTz: async () => "Europe/Oslo",
}));

const emitSignalMock = vi.fn(async () => {});
vi.mock("../lib/signal-emit.js", () => ({ emitSignal: emitSignalMock }));

// ─── Shared env plumbing (schedule-signal-wiring.test.ts's own) ─────────────────────────────

const ENV_KEYS = [
  "EVE_SCHEDULES_LIVE",
  "DATABASE_URL",
  "TELEGRAM_PRINCIPAL_ID",
  "SLACK_ALLOWED_USER_IDS",
  "OBLIGATION_REPING_ENABLED",
  "AGENT_OWNER_USER_ID",
];
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.AGENT_OWNER_USER_ID = "bendik"; // explicit legacy fixture identity
  // `mockReset` (not `mockClear`): a case's own `mockImplementation` must not survive into the next.
  gatedSendMock.mockReset();
  gatedSendMock.mockImplementation(HOLD);
  wouldSendMock.mockReset();
  wouldSendMock.mockImplementation(async () => ({ verdict: "suppress", reason: "dnd" }) as never);
  deferredSinceMock.mockClear();
  deferredSinceMock.mockImplementation(async () => []);
  recordSchedulePassMock.mockClear();
  recordScheduleTickMock.mockClear();
  emitSignalMock.mockClear();
  for (const spy of [
    sendTelegramMessage, callSlackApi, markReplied, beginTriage,
    notionMarkAnnounced, atlasMarkAnnounced, markDelivered, createReminder, dueReminders,
    listDeadlines, advanceRung, readLadderEnabled,
  ]) spy.mockClear();
  // `mockReset` (not `mockClear`): a case's own `mockImplementationOnce` (the drafting branch)
  // must not survive into the next case's default ("negative", notify-only) expectation.
  classifyReplyMock.mockReset();
  classifyReplyMock.mockImplementation(async () => "negative" as const);
  draftReplyMock.mockClear();
  dueReminders.mockImplementation(DUE_REMINDER);
  listDeadlines.mockImplementation(async () => [OPEN_DEADLINE]);
  readLadderEnabled.mockImplementation(async () => true);
  gatherOpenObligations.mockClear();
  gatherOpenObligations.mockImplementation(async () => [OWED]);
  await closePool().catch(() => {});
  vi.resetModules();
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.useRealTimers();
  await closePool().catch(() => {});
});

// ─── The pure helpers ───────────────────────────────────────────────────────────────────────

describe("ownerId / doorId (lib/principals.ts)", () => {
  it("ownerId is the identity registry's canonical id by default", async () => {
    const { ownerId } = await import("../lib/principals.js");
    expect(() => ownerId({})).toThrow("Owner identity is not configured");
  });

  it("ownerId reads AGENT_OWNER_USER_ID when set, trimmed", async () => {
    const { ownerId } = await import("../lib/principals.js");
    expect(ownerId({ AGENT_OWNER_USER_ID: " alice " })).toBe("alice");
  });

  it("a blank AGENT_OWNER_USER_ID is not an owner — it falls back", async () => {
    const { ownerId } = await import("../lib/principals.js");
    expect(() => ownerId({ AGENT_OWNER_USER_ID: "   " })).toThrow("Owner identity is not configured");
  });

  it("doorId is `<channel>:<id>` — the ledger's per-door key", async () => {
    const { doorId } = await import("../lib/principals.js");
    expect(doorId("telegram", "123456")).toBe("telegram:123456");
    expect(doorId("slack", "U0ABC")).toBe("slack:U0ABC");
  });
});

describe("heldBackLine (lib/brief-content.ts)", () => {
  it("is null when nothing was held back — the brief gains no line", async () => {
    const { heldBackLine } = await import("../lib/brief-content.js");
    expect(heldBackLine([], "nb")).toBeNull();
  });

  it("names each door, in Norwegian, on one line", async () => {
    const { heldBackLine } = await import("../lib/brief-content.js");
    const line = heldBackLine(
      [
        { door: "slack:U0ABC", count: 3 },
        { door: "telegram:123456", count: 1 },
      ],
      "nb",
    );
    expect(line).toBe(
      "Holdt tilbake siden forrige brief: 3 meldinger på Slack, 1 på Telegram (tak nådd eller stille timer).",
    );
  });

  it("reads singular for one item", async () => {
    const { heldBackLine } = await import("../lib/brief-content.js");
    expect(heldBackLine([{ door: "telegram:1", count: 1 }], "nb")).toBe(
      "Holdt tilbake siden forrige brief: 1 melding på Telegram (tak nådd eller stille timer).",
    );
  });

  it("a zero count is not a held-back item", async () => {
    const { heldBackLine } = await import("../lib/brief-content.js");
    expect(heldBackLine([{ door: "slack:U1", count: 0 }], "nb")).toBeNull();
  });

  it("an unknown door prefix is named as itself rather than dropped", async () => {
    const { heldBackLine } = await import("../lib/brief-content.js");
    expect(heldBackLine([{ door: "email:owner@owner.example", count: 2 }], "nb")).toContain("email");
  });

  it("in English, names each door and pluralises correctly", async () => {
    const { heldBackLine } = await import("../lib/brief-content.js");
    const line = heldBackLine(
      [
        { door: "slack:U0ABC", count: 3 },
        { door: "telegram:123456", count: 1 },
      ],
      "en",
    );
    expect(line).toBe("Held back since the last brief: 3 messages on Slack, 1 on Telegram (ceiling reached or quiet hours).");
  });
});

describe("the re-ping budget is gone — the engine's ceiling is the only one", () => {
  // Asserted against the SOURCE, not the module namespace: a vitest-mocked namespace throws on any
  // unknown property rather than answering `undefined`, so `not.toHaveProperty` cannot see an
  // absence here. Reading the files is also the stronger claim — it catches a re-introduction in
  // the schedule as well as in the library.
  const read = async (rel: string) =>
    (await import("node:fs/promises")).readFile(new URL(rel, import.meta.url), "utf8");

  it("lib/brief-content.ts no longer carries a local re-ping budget", async () => {
    const src = await read("../lib/brief-content.ts");
    for (const name of ["rePingRemaining", "rePingRecord", "EMPTY_REPING_BUDGET", "RePingBudgetState"]) {
      expect(src).not.toContain(`${name} `);
    }
  });

  it("reping.ts reads no per-day cap of its own — the ledger is the only counter", async () => {
    const src = await read("../agent/schedules/reping.ts");
    expect(src).not.toContain('Number(process.env["OBLIGATION_REPING_MAX_PER_DAY"])');
    expect(src).not.toContain("interrupt.slice(");
    // and the OFF switch is untouched
    expect(src).toContain('process.env["OBLIGATION_REPING_ENABLED"] !== "1"');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The wiring proof — one schedule per initiation class
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// Everything below the schedule's own decision is stubbed: a pool that answers every query with
// no rows, the two Google clients, and the pipeline stage that reads them. What is NOT stubbed is
// the schedule's own logic — the slot gate, the null-content gate, the surface assignment, the
// heartbeat stamp — because that is what is under test.

const fakePool = { query: async () => ({ rows: [], rowCount: 0 }) };

vi.mock("@lares/agent-kit/db", () => ({
  getPool: () => fakePool,
  closePool: async () => {},
}));

vi.mock("../lib/identity-client.js", () => ({
  configuredOwnerId: () => "bendik",
  listAliases: async () => ["owner@owner.example"],
}));

vi.mock("../lib/google.js", () => ({
  googleClients: () => ({
    gmail: async () => ({ searchThreadIds: async () => [], readThread: async () => [] }),
    calendar: async () => ({}),
  }),
  listEnrolledMailboxes: async () => ["owner@owner.example"],
}));

vi.mock("../lib/calendar-fanout.js", () => ({ listEventsEverywhere: async () => [] }));

const TOMORROW_MEETING = {
  title: "Coffee with a counterpart",
  startsAt: new Date("2026-06-18T09:00:00Z"),
  participants: ["them@example.com"],
};

const OWED: import("../lib/brief-content.js").Obligation = {
  threadId: "t1",
  subject: "The proposal",
  counterpartyName: "Them",
  counterpartyAddress: "them@example.com",
  lastMessageAt: new Date("2026-06-16T09:00:00Z"),
  ageHours: 30,
  isRePing: true,
  unansweredCount: 2,
  source: "gmail",
};

/** Two more eligible re-pings, so a case can prove the loop STOPS rather than merely that it ran
 *  once. With one thread in the batch, "one gate call" and "broke after the first" are the same
 *  observation — which is how a missing `break` would have gone unnoticed. */
const ALSO_OWED: import("../lib/brief-content.js").Obligation[] = [
  { ...OWED, threadId: "t2", counterpartyName: "Someone", counterpartyAddress: "someone@example.com" },
  { ...OWED, threadId: "t3", counterpartyName: "Another", counterpartyAddress: "another@example.com" },
];

const gatherOpenObligations = vi.fn(async () => [OWED]);

/** Partial: `buildEveningBrief`, `assignSurfaces` and `heldBackLine` stay REAL — only the calendar
 *  read is replaced, so the evening pass genuinely has something to say. */
vi.mock("../lib/brief-content.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/brief-content.js")>()),
  listTomorrowMeetings: async () => [TOMORROW_MEETING],
}));

vi.mock("../lib/obligation-pipeline.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/obligation-pipeline.js")>()),
  gatherOpenObligations,
}));

vi.mock("../lib/obligations-store.js", () => ({
  ensureObligationsTableOnce: async () => {},
  dismissedThreads: async () => new Set<string>(),
  upsertSeen: async () => {},
  markNightBeforeDelivered: async () => {},
  resolvedThreads: async () => new Map<string, Date>(),
  markResolved: async () => {},
  cachedIntent: async () => null,
  recordIntent: async () => {},
  announcedRePings: async () => new Map<string, number>(),
  markRePingAnnounced: async () => {},
  nightBeforeDelivered: async () => new Set<string>(),
}));

// (No standing-facts mock: `listActiveFacts` reads the fake pool above and finds no rows, which is
// exactly the "he has told her nothing yet" path. Mocking the module would also have to re-export
// `standingFactLine`, which `lib/brief-content.ts` imports from it.)

const DUE_REMINDER = async () => [
  {
    id: "r1",
    agent: "saga",
    owner: "bendik",
    due_at: new Date("2026-06-17T06:00:00Z"),
    recurrence: null as string | null,
    payload: { text: "Ring tannlegen", door: "telegram", threadRef: "123456" },
  },
];
const dueReminders = vi.fn(DUE_REMINDER);
const markDelivered = vi.fn(async () => {});
const createReminder = vi.fn(async () => {});
vi.mock("../lib/reminders-store.js", () => ({
  dueReminders,
  markDelivered,
  createReminder,
}));

// ─── deadlines (escalation, ORB-180) ────────────────────────────────────────────────────────

/** Due tomorrow, never rung — so at 16:00 Oslo on the 17th the ladder owes rung 1. */
const OPEN_DEADLINE = {
  id: "d1",
  owner: "bendik",
  entity: "Heiberg Industries AS",
  title: "Aksjonærregisteroppgaven",
  source: "statutory" as const,
  dueDate: "2026-06-18",
  recurrence: "yearly" as const,
  consequence: "Tvangsmulkt fra Skatteetaten løper per dag",
  evidenceRule: "owner confirms",
  status: "open" as const,
  statusReason: null,
  resolvedAt: null,
  rung: 0,
  rungMovedAt: null,
  ruleKey: "aksjonaerregister",
  createdBy: "seed",
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

const listDeadlines = vi.fn(async () => [OPEN_DEADLINE]);
const advanceRung = vi.fn(async () => {});
const readLadderEnabled = vi.fn(async () => true);
vi.mock("../lib/deadlines-store.js", () => ({ listDeadlines, advanceRung, readLadderEnabled }));

/** The raw send primitives `reminders.ts` uses — spied, so "the door was not knocked on" is a
 *  fact about the wire and not about a wrapper. */
const sendTelegramMessage = vi.fn(async () => ({}));
const callSlackApi = vi.fn(async () => ({ ok: true, ts: "1" }));
// PARTIAL, both of them: `agent/channels/{slack,telegram}.ts` import `slackChannel`/
// `telegramChannel` from these same modules at import time, and a wholesale mock takes the whole
// channel down before the schedule is even constructed.
vi.mock("eve/channels/telegram", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTelegramMessage,
}));
vi.mock("eve/channels/slack", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  callSlackApi,
}));

// ─── proposals-watch (event) ────────────────────────────────────────────────────────────────

const NOTION_PROPOSAL = {
  id: 61,
  vaultPath: "Ventures/Orakel.md",
  notionPageId: "page-1",
  proposedBody: "…",
  baseMdHash: "a",
  notionHash: "b",
  diffPreview: "+ one new paragraph",
  kind: "edit" as const,
  notionOwned: true,
  state: "open" as const,
  createdAt: new Date("2026-06-17T08:00:00Z"),
};

const notionUnannounced = vi.fn(async () => [NOTION_PROPOSAL]);
const notionMarkAnnounced = vi.fn(async () => {});
const atlasMarkAnnounced = vi.fn(async () => {});
/** PARTIAL: `buildNotionAnnouncement` quotes this module's own consequence sentences. */
vi.mock("../lib/proposals-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/proposals-store.js")>()),
  getUnannouncedProposals: notionUnannounced,
  markProposalAnnounced: notionMarkAnnounced,
  getUnannouncedAtlasProposals: async () => [],
  markAtlasProposalAnnounced: atlasMarkAnnounced,
}));

// ─── outreach-reply-watch (event) ───────────────────────────────────────────────────────────

const TRACKED_THREAD = {
  id: "row-1",
  threadId: "thread-1",
  account: "owner@owner.example",
  personId: null,
  status: "awaiting_reply" as const,
  sentAt: new Date("2026-06-15T08:00:00Z"),
};
const markReplied = vi.fn(async () => {});
const beginTriage = vi.fn(async () => true);
vi.mock("../lib/outreach-store.js", () => ({
  listAwaitingReply: async () => [TRACKED_THREAD],
  markReplied,
  beginTriage,
  stopTracking: async () => {},
}));
vi.mock("../lib/outreach-reply-detect.js", () => ({
  detectReply: () => ({ from: "them@example.com", to: [], sentAt: new Date("2026-06-16T08:00:00Z"), text: "not now" }),
}));
/** LAR-35-s1: both BILLED calls are `vi.fn`s (not plain stubs) so a test can assert HOW OFTEN they
 *  ran — the whole point of moving them inside the gate. `notifyTextFor` and the act prompts stay
 *  real. Default classification is "negative" (the notify-only branch); a `send`-verdict test that
 *  wants the drafting branch overrides it with `mockImplementationOnce`. */
const classifyReplyMock = vi.fn(async () => "negative" as const);
const draftReplyMock = vi.fn(async () => ({ subject: "Re: hello", body: "draft body" }));
vi.mock("../lib/outreach-reply-triage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/outreach-reply-triage.js")>()),
  classifyReply: classifyReplyMock,
  draftReply: draftReplyMock,
}));

/** A `to(...)` that records every session-starting send, standing in for eve's own. */
function spyingCtx() {
  const send = vi.fn(async () => ({}));
  return {
    send,
    ctx: {
      to: () => ({ send }),
      waitUntil: () => {},
      appAuth: {},
    } as never,
  };
}

describe("a suppressed initiation costs the message, never the heartbeat", () => {
  it("evening-brief (scheduled): the telegram send is skipped, the pass still stamps", async () => {
    vi.useFakeTimers();
    const { osloLocalToDate } = await import("../lib/recurrence.js");
    vi.setSystemTime(osloLocalToDate("2026-06-17 20:00"));
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    process.env["TELEGRAM_PRINCIPAL_ID"] = "123456";

    const { send, ctx } = spyingCtx();
    const { default: schedule, HEARTBEAT_KEY } = await import("../agent/schedules/evening-brief.js");
    await schedule.run!(ctx);

    // (1) the gate was consulted, with the class, door and item key the plan assigns
    expect(gatedSendMock).toHaveBeenCalledTimes(1);
    const req = gatedSendMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(req).toMatchObject({
      owner: "bendik",
      agent: "saga",
      cls: "scheduled",
      door: "telegram:123456",
      itemKey: "evening-brief/2026-06-17T20",
      tz: "Europe/Oslo",
    });
    // (2) the message did NOT go out
    expect(send).not.toHaveBeenCalled();
    // (3) the pass still stamped
    expect(recordSchedulePassMock).toHaveBeenCalledWith(expect.anything(), HEARTBEAT_KEY);
    expect(emitSignalMock).not.toHaveBeenCalled();
  });

  it("reminders (scheduled, owner-set time): nothing is sent, delivered/re-armed, or stamped away", async () => {
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    process.env["TELEGRAM_PRINCIPAL_ID"] = "123456";

    const { default: schedule, HEARTBEAT_KEY } = await import("../agent/schedules/reminders.js");
    await schedule.run!(spyingCtx().ctx);

    expect(gatedSendMock).toHaveBeenCalledTimes(1);
    expect(gatedSendMock.mock.calls[0]![1]).toMatchObject({
      cls: "scheduled",
      door: "telegram:123456",
      itemKey: "reminder/r1",
      ownerSetTime: true,
    });
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    // The row stays PENDING: a held reminder must arrive when the gate reopens, and a recurrence
    // must never advance past a delivery that did not happen.
    expect(markDelivered).not.toHaveBeenCalled();
    expect(createReminder).not.toHaveBeenCalled();
    expect(recordSchedulePassMock).toHaveBeenCalledWith(expect.anything(), HEARTBEAT_KEY);
  });

  it("reping (escalation): one initiation per thread, carrying the rung; nothing sent or marked", async () => {
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    process.env["OBLIGATION_REPING_ENABLED"] = "1";
    process.env["TELEGRAM_PRINCIPAL_ID"] = "123456";

    const { send, ctx } = spyingCtx();
    const { default: schedule, HEARTBEAT_KEY } = await import("../agent/schedules/reping.js");
    await schedule.run!(ctx);

    expect(gatedSendMock).toHaveBeenCalledTimes(1);
    expect(gatedSendMock.mock.calls[0]![1]).toMatchObject({
      cls: "escalation",
      door: "telegram:123456",
      // the rung rides in the key: a NEW bump earns one more message, the same bump does not
      itemKey: "reping/t1#2",
    });
    expect(send).not.toHaveBeenCalled();
    expect(recordSchedulePassMock).toHaveBeenCalledWith(expect.anything(), HEARTBEAT_KEY);
  });

  it("reping: a door-ceiling deferral STOPS the batch — no further gate calls, nothing sent, pass stamps", async () => {
    // The door's daily escalation budget is spent, so every later thread in this batch would get the
    // identical answer. One deferral row is the audit trail; three more identical decisions are noise
    // in the ledger the console shows. Three eligible threads, so "it stopped" is observable at all.
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    process.env["OBLIGATION_REPING_ENABLED"] = "1";
    process.env["TELEGRAM_PRINCIPAL_ID"] = "123456";
    gatherOpenObligations.mockImplementation(async () => [OWED, ...ALSO_OWED]);
    const until = new Date("2026-06-18T22:00:00Z");
    gatedSendMock.mockImplementation(async () => ({ verdict: "defer", reason: "door-ceiling", until }) as never);

    const { send, ctx } = spyingCtx();
    const { default: schedule, HEARTBEAT_KEY } = await import("../agent/schedules/reping.js");
    await schedule.run!(ctx);

    // Asked ONCE, for the first thread — not once per eligible thread.
    expect(gatedSendMock).toHaveBeenCalledTimes(1);
    expect(gatedSendMock.mock.calls[0]![1]).toMatchObject({ cls: "escalation", itemKey: "reping/t1#2" });
    // Nothing went out and nothing was marked announced: every thread stays eligible for tomorrow.
    expect(send).not.toHaveBeenCalled();
    // And the schedule still reports a completed pass — going quiet because the ceiling is spent must
    // not read as a dead schedule in input-freshness.sh (ORB-179's ten silent days).
    expect(recordSchedulePassMock).toHaveBeenCalledWith(expect.anything(), HEARTBEAT_KEY);
  });

  it("deadlines (escalation): the rung is asked for, not sent, and the row does not move", async () => {
    vi.useFakeTimers();
    const { osloLocalToDate } = await import("../lib/recurrence.js");
    vi.setSystemTime(osloLocalToDate("2026-06-17 16:00")); // T-1, past 15:00 — rung 1 is due
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    process.env["TELEGRAM_PRINCIPAL_ID"] = "123456";

    const { send, ctx } = spyingCtx();
    const { default: schedule, HEARTBEAT_KEY } = await import("../agent/schedules/deadlines.js");
    await schedule.run!(ctx);

    expect(gatedSendMock).toHaveBeenCalledTimes(1);
    expect(gatedSendMock.mock.calls[0]![1]).toMatchObject({
      cls: "escalation",
      door: "telegram:123456",
      // the rung rides in the key, so each rung is its own initiation and none repeats
      itemKey: "deadline/d1#1",
      finalStop: false,
    });
    expect(send).not.toHaveBeenCalled();
    // Held, so the row keeps its rung and the ladder reconsiders it when the gate reopens.
    expect(advanceRung).not.toHaveBeenCalled();
    expect(recordSchedulePassMock).toHaveBeenCalledWith(expect.anything(), HEARTBEAT_KEY);
  });

  it("deadlines: the final stop asks with finalStop true — deferred under DND, never dropped", async () => {
    vi.useFakeTimers();
    const { osloLocalToDate } = await import("../lib/recurrence.js");
    vi.setSystemTime(osloLocalToDate("2026-06-19 09:00")); // the day after the due date
    listDeadlines.mockImplementation(async () => [{ ...OPEN_DEADLINE, rung: 2 }]);
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    process.env["TELEGRAM_PRINCIPAL_ID"] = "123456";

    const { default: schedule, HEARTBEAT_KEY } = await import("../agent/schedules/deadlines.js");
    await schedule.run!(spyingCtx().ctx);

    expect(gatedSendMock).toHaveBeenCalledTimes(1);
    expect(gatedSendMock.mock.calls[0]![1]).toMatchObject({
      cls: "escalation",
      itemKey: "deadline/d1#3",
      finalStop: true,
    });
    expect(recordSchedulePassMock).toHaveBeenCalledWith(expect.anything(), HEARTBEAT_KEY);
  });

  it("deadlines: the switch OFF still stamps the pass — a quiet ladder is not a dead schedule", async () => {
    readLadderEnabled.mockImplementation(async () => false);
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    process.env["TELEGRAM_PRINCIPAL_ID"] = "123456";

    const { default: schedule, HEARTBEAT_KEY } = await import("../agent/schedules/deadlines.js");
    await schedule.run!(spyingCtx().ctx);

    expect(gatedSendMock).not.toHaveBeenCalled();
    expect(recordSchedulePassMock).toHaveBeenCalledWith(expect.anything(), HEARTBEAT_KEY);
  });
});

describe("a `send` verdict changes nothing about what goes out", () => {
  it("evening-brief still sends its prompt when the gate says send — the normal-day path", async () => {
    // The gate's default settings answer `send` for everything this fleet sends today (the plan's
    // Global Constraints). This is that day, asserted here rather than assumed: the callback the
    // schedule handed the gate is the real send, and it runs exactly once.
    gatedSendMock.mockImplementationOnce(async (_db, _req, send) => {
      await send();
      return { verdict: "send" } as never;
    });
    vi.useFakeTimers();
    const { osloLocalToDate } = await import("../lib/recurrence.js");
    vi.setSystemTime(osloLocalToDate("2026-06-17 20:00"));
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    process.env["TELEGRAM_PRINCIPAL_ID"] = "123456";

    const { send, ctx } = spyingCtx();
    const { default: schedule, HEARTBEAT_KEY } = await import("../agent/schedules/evening-brief.js");
    await schedule.run!(ctx);

    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]![0])).toContain("the evening prep pass");
    expect(emitSignalMock).toHaveBeenCalledWith(
      "brief-sent",
      "Saga sent the evening brief",
      undefined,
      { kind: "event", severity: "info", key: "evening-brief" },
    );
    expect(recordSchedulePassMock).toHaveBeenCalledWith(expect.anything(), HEARTBEAT_KEY);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The `event` class, and the one suppression that means the OPPOSITE of a hold
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** The gate answers `suppress`/`already-seen`: a `sent` row for this item key exists, so he WAS
 *  told and only the lane's own bookkeeping write failed last time. */
function gateSaysAlreadySeen(): void {
  gatedSendMock.mockImplementation(async () => ({ verdict: "suppress", reason: "already-seen" }) as never);
}

describe("proposals-watch (event): a hold leaves the proposal tellable", () => {
  it("suppress → nothing announced, announced_at NOT stamped, the pass still stamps", async () => {
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    process.env["TELEGRAM_PRINCIPAL_ID"] = "123456";

    const { default: schedule, HEARTBEAT_KEY } = await import("../agent/schedules/proposals-watch.js");
    await schedule.run!(spyingCtx().ctx);

    expect(gatedSendMock).toHaveBeenCalledTimes(1);
    expect(gatedSendMock.mock.calls[0]![1]).toMatchObject({
      cls: "event",
      door: "telegram:123456",
      itemKey: "proposal/notion/61",
    });
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    // The whole point: a proposal he was not told about must stay tellable next tick.
    expect(notionMarkAnnounced).not.toHaveBeenCalled();
    expect(recordSchedulePassMock).toHaveBeenCalledWith(expect.anything(), HEARTBEAT_KEY);
  });

  it("suppress/already-seen → still nothing announced, but announced_at IS stamped", async () => {
    // He was told on an earlier tick; the only thing left undone is the stamp that failed then.
    // Treated as a hold, `notionUnannounced` would re-serve this row every tick forever.
    gateSaysAlreadySeen();
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    process.env["TELEGRAM_PRINCIPAL_ID"] = "123456";

    const { default: schedule } = await import("../agent/schedules/proposals-watch.js");
    await schedule.run!(spyingCtx().ctx);

    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(notionMarkAnnounced).toHaveBeenCalledWith(expect.anything(), 61);
  });
});

describe("outreach-reply-watch (event): one key for both sends of one reply", () => {
  it("suppress → nothing sent and the thread stays tracked, so the next poll reconsiders it", async () => {
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    process.env["SLACK_ALLOWED_USER_IDS"] = "U0ABC";

    const { default: schedule, HEARTBEAT_KEY } = await import("../agent/schedules/outreach-reply-watch.js");
    await schedule.run!(spyingCtx().ctx);

    expect(gatedSendMock).toHaveBeenCalledTimes(1);
    expect(gatedSendMock.mock.calls[0]![1]).toMatchObject({
      cls: "event",
      door: "slack:U0ABC",
      itemKey: "outreach/thread-1",
    });
    expect(callSlackApi).not.toHaveBeenCalled();
    expect(markReplied).not.toHaveBeenCalled();
    // LAR-35-s1: the whole point — a held/suppressed gate must not have billed either call.
    expect(classifyReplyMock).not.toHaveBeenCalled();
    expect(draftReplyMock).not.toHaveBeenCalled();
    expect(recordSchedulePassMock).toHaveBeenCalledWith(expect.anything(), HEARTBEAT_KEY);
  });

  it("suppress/already-seen → markReplied runs, so a billed classify does not loop forever", async () => {
    gateSaysAlreadySeen();
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    process.env["SLACK_ALLOWED_USER_IDS"] = "U0ABC";

    const { default: schedule } = await import("../agent/schedules/outreach-reply-watch.js");
    await schedule.run!(spyingCtx().ctx);

    expect(callSlackApi).not.toHaveBeenCalled();
    expect(markReplied).toHaveBeenCalledWith(expect.anything(), "row-1");
    // LAR-35-s1: already-seen is decided by the gate BEFORE the callback runs — classify never
    // fires even though the outcome ends up handled.
    expect(classifyReplyMock).not.toHaveBeenCalled();
  });

  it("send → classify runs exactly once, the positive branch drafts and starts the act session, and markReplied runs", async () => {
    gatedSendMock.mockImplementationOnce(async (_db, _req, send) => {
      await send();
      return { verdict: "send" } as never;
    });
    classifyReplyMock.mockImplementationOnce(async () => "positive" as const);
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    process.env["SLACK_ALLOWED_USER_IDS"] = "U0ABC";

    const { send, ctx } = spyingCtx();
    const { default: schedule } = await import("../agent/schedules/outreach-reply-watch.js");
    await schedule.run!(ctx);

    expect(classifyReplyMock).toHaveBeenCalledTimes(1);
    expect(draftReplyMock).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1); // the act session prompt — the positive branch, not notify
    expect(callSlackApi).not.toHaveBeenCalled();
    expect(markReplied).toHaveBeenCalledWith(expect.anything(), "row-1");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// wouldInitiate (LAR-35-s2) — the precheck twin, asked directly. No live schedule wires it in
// yet (that is LAR-35-s3's job for meeting-followup); this proves the seam on its own: it asks
// the kit's `wouldSend`, never `gatedSend`, and never has anything to send in the first place.
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("wouldInitiate: asks the kit's wouldSend, never gatedSend, and never sends anything", () => {
  it("builds the same request shape `initiate` would, and hands back the kit's verdict untouched", async () => {
    wouldSendMock.mockImplementationOnce(async () => ({
      verdict: "defer", reason: "quiet-hours", until: "2026-06-18T05:00:00.000Z",
    }) as never);

    const { wouldInitiate } = await import("../lib/initiation.js");
    const outcome = await wouldInitiate("meeting-followup", {
      cls: "event", door: "slack:U0ABC", itemKey: "meeting-followup/page-1",
    });

    expect(wouldSendMock).toHaveBeenCalledTimes(1);
    expect(wouldSendMock.mock.calls[0]![1]).toMatchObject({
      owner: "bendik",
      agent: "saga",
      cls: "event",
      door: "slack:U0ABC",
      itemKey: "meeting-followup/page-1",
      tz: "Europe/Oslo",
    });
    expect(gatedSendMock).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      verdict: "defer", reason: "quiet-hours", sent: false, alreadySeen: false, handled: false,
    });
  });

  it("a send verdict reads handled — the caller may bill, then call `initiate` for the real send", async () => {
    wouldSendMock.mockImplementationOnce(async () => ({ verdict: "send" }) as never);

    const { wouldInitiate } = await import("../lib/initiation.js");
    const outcome = await wouldInitiate("meeting-followup", {
      cls: "event", door: "slack:U0ABC", itemKey: "meeting-followup/page-1",
    });

    expect(outcome).toEqual({ verdict: "send", sent: true, alreadySeen: false, handled: true });
  });

  it("an already-seen verdict is handled too — the same outcome mapping `initiate` uses", async () => {
    wouldSendMock.mockImplementationOnce(async () => ({ verdict: "suppress", reason: "already-seen" }) as never);

    const { wouldInitiate } = await import("../lib/initiation.js");
    const outcome = await wouldInitiate("meeting-followup", {
      cls: "event", door: "slack:U0ABC", itemKey: "meeting-followup/page-1",
    });

    expect(outcome).toEqual({
      verdict: "suppress", reason: "already-seen", sent: false, alreadySeen: true, handled: true,
    });
  });
});

describe("reminders (already-seen): the delivery stands, so the row is closed", () => {
  it("suppress/already-seen → marked delivered and the recurrence re-armed, with no second send", async () => {
    // The at-least-once window this closes: the text reached him, then `markDelivered` failed. Left
    // "eligible", the row would re-fire every minute against a gate that suppresses it every minute.
    gateSaysAlreadySeen();
    dueReminders.mockImplementationOnce(async () => [
      {
        id: "r1",
        agent: "saga",
        owner: "bendik",
        due_at: new Date("2026-06-17T06:00:00Z"),
        recurrence: "daily:08:00",
        payload: { text: "Ring tannlegen", door: "telegram", threadRef: "123456" },
      },
    ]);
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    process.env["TELEGRAM_PRINCIPAL_ID"] = "123456";

    const { default: schedule, HEARTBEAT_KEY } = await import("../agent/schedules/reminders.js");
    await schedule.run!(spyingCtx().ctx);

    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(markDelivered).toHaveBeenCalledWith(expect.anything(), "r1");
    expect(createReminder).toHaveBeenCalledTimes(1); // the recurrence is not lost either
    expect(recordSchedulePassMock).toHaveBeenCalledWith(expect.anything(), HEARTBEAT_KEY);
  });
});

describe("email-triage (event): the draft stands, only the ping is gated", () => {
  it("suppress → the outcome is recorded and the Slack ping is not sent", async () => {
    // Driven through the tick factory with its `gate` dep, which is exactly how the live wiring
    // consumes it (`gate: initiateTo("email-triage", doorId("slack", channelId))`).
    const { makeEmailTriageTick } = await import("../agent/schedules/email-triage.js");
    const notify = vi.fn(async () => {});
    const recorded: Array<[string, string]> = [];
    const asked: Array<Record<string, unknown>> = [];

    const completed = await makeEmailTriageTick({
      mailboxes: async () => ["owner@owner.example"],
      searchCandidates: async () => ["m1"],
      readMessage: async () => ({
        id: "m1", threadId: "t1", from: "them@example.com", to: ["owner@owner.example"],
        subject: "The proposal", body: "Any news?", sentAt: new Date("2026-06-17T07:00:00Z"),
      }) as never,
      readThread: async () => [],
      claim: async () => ({ claimed: true, attempt: 1, isFinalAttempt: false }),
      triage: async () => ({ outcome: "drafted", from: "them@example.com", subject: "The proposal", account: "owner@owner.example" }) as never,
      recordOutcome: async (mailbox, id, outcome) => { recorded.push([id, outcome]); },
      notify,
      gate: async (init, _send) => {
        asked.push(init as Record<string, unknown>);
        return { verdict: "suppress", reason: "dnd", sent: false, alreadySeen: false, handled: false };
      },
      reportDropped: async () => {},
      prune: async () => {},
    }).tick();

    expect(completed).toBe(true);
    expect(asked).toEqual([{ cls: "event", itemKey: "email-triage/owner@owner.example/m1" }]);
    expect(notify).not.toHaveBeenCalled();
    // The draft exists in Gmail and the row says so — the ping is the only thing withheld.
    expect(recorded).toEqual([["m1", "drafted"]]);
  });
});
