/**
 * ORB-138 — the hook that correlates a turn's runtime events into one conversation-log entry.
 *
 * These tests drive the exported handlers directly with fake event + ctx objects. They never
 * mock `defineHook` and never touch eve's runtime: the factory takes its `capture` sink and its
 * clock as dependencies, so what is under test here is purely the correlation and attribution
 * logic.
 *
 * THE FIXTURES MUST MATCH PRODUCTION. This file is outside `tsconfig.json`'s `include` and `ctx()`
 * returns `as never`, so nothing type-checks these shapes for us. An earlier revision built every
 * context with `kind: "channel:telegram"` — the instrumentation spelling, which a hook context
 * never carries — and 15 green tests certified a hook that captured nothing in production. The
 * values below are the ones eve really passes (`kindHint: "slack"` / `"telegram"`), with the
 * prefixed form kept in exactly one place, as a tolerance test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { makeTurnCapture } from "../agent/hooks/turn-capture.js";
import type { TurnLogEntry } from "../lib/turn-capture.js";
import { configuredOwnerId } from "../lib/identity-client.js";
import { taintTurn, resetTaintForTests } from "@lares/agent-kit/origin-taint";

const humanTelegramAuth = {
  attributes: {},
  authenticator: "telegram-webhook",
  principalId: "123456789",
  principalType: "user",
};
const humanSlackAuth = {
  attributes: {},
  authenticator: "slack-webhook",
  principalId: "U_EXAMPLE_OWNER",
  principalType: "user",
};
/** Verbatim from eve's `dist/src/channel/schedule-auth.js`. */
const scheduleAppAuth = {
  attributes: {},
  authenticator: "app",
  principalId: "eve:app",
  principalType: "runtime",
};

/**
 * A fake `HookContext`.
 *
 * `turnId` is parameterised deliberately. It used to be hardcoded to `"turn_0"` for every
 * context, which made any guard reading `ctx.session.turn.id` untestable — a mutation of the
 * buffer key once passed under exactly that blind spot. The hook itself reads
 * `event.data.turnId` (required and non-nullable on both `turn.started` and `message.received`),
 * so this field is not what the code under test consults; it is parameterised so that it can
 * never again quietly agree with everything.
 */
function ctx(opts: {
  kind?: string;
  sessionId?: string;
  turnId?: string;
  current?: unknown;
  initiator?: unknown;
}): never {
  return {
    agent: { name: "saga" },
    channel: { kind: opts.kind },
    session: {
      id: opts.sessionId ?? "session-1",
      auth: { current: opts.current ?? null, initiator: opts.initiator ?? opts.current ?? null },
      turn: { id: opts.turnId ?? "turn_unset", sequence: 0 },
    },
    getSandbox: () => Promise.reject(new Error("no sandbox in tests")),
    getSkill: () => {
      throw new Error("no skills in tests");
    },
  } as never;
}

const ev = (type: string, data: Record<string, unknown>): never =>
  ({ type, data, meta: { id: "e1", sequence: 1, timestamp: "2026-08-19T10:00:00.000Z" } }) as never;

const started = (turnId: string) => ev("turn.started", { sequence: 0, turnId });
const received = (turnId: string, message: string) => ev("message.received", { message, sequence: 1, turnId });
const actions = (turnId: string, acts: unknown[]) =>
  ev("actions.requested", { actions: acts, sequence: 2, stepIndex: 0, turnId });
const completed = (turnId: string, finishReason: string, message: string | null) =>
  ev("message.completed", { finishReason, message, sequence: 3, stepIndex: 0, turnId });
const turnCompleted = (turnId: string) => ev("turn.completed", { sequence: 4, turnId });
const turnFailed = (turnId: string) =>
  ev("turn.failed", { code: "boom", message: "boom", sequence: 4, turnId });
const turnCancelled = (turnId: string) => ev("turn.cancelled", { sequence: 4, turnId });

const toolCall = (toolName: string) => ({ callId: `c-${toolName}`, input: {}, kind: "tool-call", toolName });

let capture: ReturnType<typeof vi.fn>;
let hook: ReturnType<typeof makeTurnCapture>;

beforeEach(() => {
  capture = vi.fn(async () => {});
  hook = makeTurnCapture({ capture: capture as never });
  resetTaintForTests();
});

/** The single entry the hook handed to `captureTurn`. */
const onlyEntry = (): TurnLogEntry => {
  expect(capture).toHaveBeenCalledTimes(1);
  return capture.mock.calls[0][0] as TurnLogEntry;
};

/**
 * The ordinary production sequence for a simple exchange with no tool use.
 *
 * The flush happens on the terminal `message.completed`; `turn.completed` afterwards is a no-op
 * and is included because production always emits it.
 */
async function fullTurn(h: typeof hook, c: never, turnId: string, input: string, reply: string): Promise<void> {
  await h.onTurnStarted(started(turnId), c);
  await h.onMessageReceived(received(turnId, input), c);
  await h.onMessageCompleted(completed(turnId, "stop", reply), c);
  await h.onTurnCompleted(turnCompleted(turnId), c);
}

describe("turn-capture hook — a human turn", () => {
  // The base case: one completed Telegram exchange becomes exactly one log entry.
  it("writes ONE entry for started → received → completed → turn.completed, with no lane", async () => {
    const c = ctx({ kind: "telegram", current: humanTelegramAuth });
    await fullTurn(hook, c, "turn_0", "hei", "hei igjen");

    const entry = onlyEntry();
    expect(entry.door).toBe("telegram");
    expect(entry.principal).toBe(configuredOwnerId());
    expect(entry.input).toBe("hei");
    expect(entry.reply).toBe("hei igjen");
    expect(entry.proposals).toEqual([]);
    expect(entry.lane).toBeUndefined();
  });

  it("captures the slack door too", async () => {
    const c = ctx({ kind: "slack", current: humanSlackAuth });
    await fullTurn(hook, c, "turn_0", "hi", "hello");
    expect(onlyEntry().door).toBe("slack");
  });

  // The one place the instrumentation spelling is exercised. A hook context does not carry it,
  // but `doorOf` tolerates it so that a future eve change to the projection cannot silently kill
  // capture the way the wrong-spelling bug did.
  it("also tolerates the prefixed channel:<name> spelling", async () => {
    const c = ctx({ kind: "channel:telegram", current: humanTelegramAuth });
    await fullTurn(hook, c, "turn_0", "hei", "svar");
    expect(onlyEntry().door).toBe("telegram");
  });

  // Part B's cursor reads `at:`; a missing or malformed stamp makes the entry invisible to the
  // dream cycle, which is the failure this whole port exists to end.
  it("stamps a well-formed ISO `at`", async () => {
    const c = ctx({ kind: "telegram", current: humanTelegramAuth });
    await fullTurn(hook, c, "turn_0", "hei", "svar");

    const { at } = onlyEntry();
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(at))).toBe(false);
  });
});

describe("turn-capture hook — attribution", () => {
  it("records a scheduled turn under its lane, never as Bendik", async () => {
    const c = ctx({
      kind: "telegram",
      current: { ...scheduleAppAuth, attributes: { lane: "morning-brief" } },
    });
    await fullTurn(hook, c, "turn_0", "Write the morning brief for today.", "Here is your brief.");

    const entry = onlyEntry();
    expect(entry.lane).toBe("morning-brief");
  });

  // The safety net: a schedule added later whose author forgets the lane attribute must still
  // never be attributed to a human.
  it("falls back to lane 'scheduled' for app-auth with no lane attribute", async () => {
    const c = ctx({ kind: "slack", current: scheduleAppAuth });
    await fullTurn(hook, c, "turn_0", "machine nudge", "ok");

    const entry = onlyEntry();
    expect(entry.lane).toBe("scheduled");
  });

  // THE REGRESSION GUARD. `auth.initiator` stays "eve:app" for the whole life of a
  // schedule-started session, so reading it would record every human reply inside a brief's
  // thread as machine-spoken. `auth.current` is per-turn and is the correct source.
  it("reads auth.current, not auth.initiator — a human replying in a brief's thread is a human", async () => {
    const c = ctx({
      kind: "telegram",
      current: humanTelegramAuth,
      initiator: { ...scheduleAppAuth, attributes: { lane: "morning-brief" } },
    });
    await fullTurn(hook, c, "turn_1", "why that one?", "because ...");

    const entry = onlyEntry();
    expect(entry.lane).toBeUndefined();
    expect(entry.input).toBe("why that one?");
  });

  // The inline app-auth check must match eve's own `isScheduleAppAuth`, which compares all three
  // of authenticator, principalId and principalType. An auth that matches only two of them is not
  // a schedule.
  it("does not treat a partial app-auth match as a schedule", async () => {
    const c = ctx({
      kind: "telegram",
      current: { ...scheduleAppAuth, principalType: "user", attributes: { lane: "morning-brief" } },
    });
    await fullTurn(hook, c, "turn_0", "hei", "svar");
    expect(onlyEntry().lane).toBeUndefined();
  });

  // A non-string lane attribute (the type also permits readonly string[]) and an empty-string one
  // both fall through to the safety net rather than becoming a lane name.
  it("treats a non-string or empty lane attribute as a missing one", async () => {
    const arrayLane = ctx({ kind: "telegram", current: { ...scheduleAppAuth, attributes: { lane: ["a", "b"] } } });
    await fullTurn(hook, arrayLane, "turn_0", "nudge", "ok");
    expect(onlyEntry().lane).toBe("scheduled");

    capture.mockClear();
    const emptyLane = ctx({ kind: "telegram", current: { ...scheduleAppAuth, attributes: { lane: "  " } } });
    await fullTurn(hook, emptyLane, "turn_1", "nudge", "ok");
    expect(onlyEntry().lane).toBe("scheduled");
  });
});

describe("turn-capture hook — correlation", () => {
  // `message.completed` fires more than once per turn: interim tool-call narration, then the
  // terminal reply. Only the terminal one is the reply, and none of them is a turn boundary.
  it("ignores an interim message.completed with finishReason tool-calls", async () => {
    const c = ctx({ kind: "telegram", current: humanTelegramAuth });
    await hook.onTurnStarted(started("turn_0"), c);
    await hook.onMessageReceived(received("turn_0", "hva skjer?"), c);
    await hook.onMessageCompleted(completed("turn_0", "tool-calls", "let me check the calendar"), c);
    expect(capture).not.toHaveBeenCalled();

    await hook.onMessageCompleted(completed("turn_0", "stop", "tre møter i dag"), c);
    expect(onlyEntry().reply).toBe("tre møter i dag");
    // `turn.completed` afterwards must not write a second, duplicate file.
    await hook.onTurnCompleted(turnCompleted("turn_0"), c);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("accumulates tool names from several actions.requested events into proposals", async () => {
    const c = ctx({ kind: "telegram", current: humanTelegramAuth });
    await hook.onTurnStarted(started("turn_0"), c);
    await hook.onMessageReceived(received("turn_0", "note this"), c);
    await hook.onActionsRequested(actions("turn_0", [toolCall("vault_write"), { callId: "x", input: {}, kind: "load-skill" }]), c);
    await hook.onActionsRequested(actions("turn_0", [toolCall("calendar_list")]), c);
    await hook.onMessageCompleted(completed("turn_0", "stop", "done"), c);
    await hook.onTurnCompleted(turnCompleted("turn_0"), c);

    expect(onlyEntry().proposals).toEqual(["vault_write", "calendar_list"]);
  });

  // A new message while an exchange is still open means the old one never got a terminal reply
  // (it stopped on a gated proposal). It is WRITTEN, not overwritten — silently dropping a
  // question Bendik actually asked is the loss this whole design is trying to avoid.
  it("writes the unfinished exchange when a new message arrives before any reply", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = ctx({ kind: "telegram", current: humanTelegramAuth });
    await hook.onTurnStarted(started("turn_0"), c);
    await hook.onMessageReceived(received("turn_0", "book the flight"), c);
    await hook.onActionsRequested(actions("turn_0", [toolCall("calendar_create_event")]), c);
    // No terminal reply — Saga is waiting on approval. He types something new instead.
    await hook.onMessageReceived(received("turn_1", "actually never mind"), c);

    expect(capture).toHaveBeenCalledTimes(1);
    const abandoned = capture.mock.calls[0][0] as TurnLogEntry;
    expect(abandoned.input).toBe("book the flight");
    expect(abandoned.reply).toBe("");
    expect(abandoned.proposals).toEqual(["calendar_create_event"]);

    // ...and the new exchange is now the live one, starting clean.
    await hook.onMessageCompleted(completed("turn_1", "stop", "Greit."), c);
    expect(capture).toHaveBeenCalledTimes(2);
    const fresh = capture.mock.calls[1][0] as TurnLogEntry;
    expect(fresh.input).toBe("actually never mind");
    expect(fresh.proposals).toEqual([]);
    warn.mockRestore();
  });

  // Two exchanges one after the other in the same session are two files. (This replaces an
  // earlier test that interleaved two turns of one session and expected them to be tracked
  // independently — under the exchange model a session holds one exchange at a time, which is
  // the whole point of keying by session.)
  it("writes one file per exchange when a session holds several in a row", async () => {
    const c = ctx({ kind: "telegram", current: humanTelegramAuth });
    await fullTurn(hook, c, "turn_0", "first", "reply-1");
    await fullTurn(hook, c, "turn_1", "second", "reply-2");

    expect(capture).toHaveBeenCalledTimes(2);
    expect((capture.mock.calls[0][0] as TurnLogEntry).input).toBe("first");
    expect((capture.mock.calls[0][0] as TurnLogEntry).reply).toBe("reply-1");
    expect((capture.mock.calls[1][0] as TurnLogEntry).input).toBe("second");
    expect((capture.mock.calls[1][0] as TurnLogEntry).reply).toBe("reply-2");
  });

  /**
   * THE COLLISION GUARD. `turnId` is minted as `turn_${sequence}` from a PER-SESSION counter
   * (`dist/src/harness/emission.js`), so every session's first turn is `turn_0`. Two doors and
   * six schedules make concurrent sessions the normal state: a scheduled Telegram brief firing
   * while Bendik is mid-exchange on Slack shares the id. Keyed on turnId alone, one entry would
   * overwrite the other — filing a human Slack exchange under a scheduled lane, on the wrong
   * door, and writing one file where there should be two.
   */
  it("keeps two SESSIONS apart even when the turnId is identical", async () => {
    const human = ctx({ kind: "slack", sessionId: "slack-session", current: humanSlackAuth });
    const brief = ctx({
      kind: "telegram",
      sessionId: "telegram-brief-session",
      current: { ...scheduleAppAuth, attributes: { lane: "morning-brief" } },
    });

    await hook.onTurnStarted(started("turn_0"), human);
    await hook.onMessageReceived(received("turn_0", "hva er status?"), human);
    // The brief interleaves, with the very same turnId.
    await hook.onTurnStarted(started("turn_0"), brief);
    await hook.onMessageReceived(received("turn_0", "Write the morning brief for today."), brief);
    await hook.onActionsRequested(actions("turn_0", [toolCall("calendar_list")]), brief);
    await hook.onMessageCompleted(completed("turn_0", "stop", "Here is your brief."), brief);
    await hook.onTurnCompleted(turnCompleted("turn_0"), brief);
    await hook.onMessageCompleted(completed("turn_0", "stop", "alt er grønt"), human);
    await hook.onTurnCompleted(turnCompleted("turn_0"), human);

    expect(capture).toHaveBeenCalledTimes(2);
    const [briefEntry, humanEntry] = capture.mock.calls.map((call) => call[0] as TurnLogEntry);

    expect(briefEntry.door).toBe("telegram");
    expect(briefEntry.lane).toBe("morning-brief");
    expect(briefEntry.input).toBe("Write the morning brief for today.");
    expect(briefEntry.proposals).toEqual(["calendar_list"]);

    expect(humanEntry.door).toBe("slack");
    expect(humanEntry.lane).toBeUndefined();
    expect(humanEntry.input).toBe("hva er status?");
    expect(humanEntry.reply).toBe("alt er grønt");
    expect(humanEntry.proposals).toEqual([]);
  });
});

describe("turn-capture hook — one file per exchange", () => {
  /**
   * THE 2026-08-20 REGRESSION, reproduced.
   *
   * Live output that morning, from ONE exchange: `06-50-05-345Z-telegram.md` held the question
   * and `proposals: gmail_search, gmail_search, gmail_read, gmail_read` with no `**Saga:**` line
   * at all, and `06-50-48-499Z-telegram.md` — 43 seconds later — held the reply above an empty
   * `**Bendik:**`. The turn parks at the tool step, eve emits the epilogue, and the continuation
   * arrives as a NEW turn id with no `message.received`.
   *
   * The pre-outage corpus contains no question-less file anywhere, and the dream cycle would
   * otherwise reflect on a question with no answer and an answer with no question.
   */
  it("writes ONE file for a tool-using exchange that eve splits across two turns", async () => {
    const c = ctx({ kind: "telegram", current: humanTelegramAuth });
    const question = "Thanks, you said I owe two replies, other than Luca, what is the second?";

    // Turn one: the question, four tool calls, interim narration, then the park.
    await hook.onTurnStarted(started("turn_0"), c);
    await hook.onMessageReceived(received("turn_0", question), c);
    await hook.onActionsRequested(actions("turn_0", [toolCall("gmail_search"), toolCall("gmail_search")]), c);
    await hook.onActionsRequested(actions("turn_0", [toolCall("gmail_read"), toolCall("gmail_read")]), c);
    await hook.onMessageCompleted(completed("turn_0", "tool-calls", "Let me check your inbox."), c);
    await hook.onTurnCompleted(turnCompleted("turn_0"), c);
    expect(capture).not.toHaveBeenCalled();

    // Turn two: a different id, NO message.received, and the real answer.
    await hook.onTurnStarted(started("turn_1"), c);
    await hook.onMessageCompleted(completed("turn_1", "stop", "The only genuinely-owed reply is Luca..."), c);
    await hook.onTurnCompleted(turnCompleted("turn_1"), c);

    const entry = onlyEntry();
    expect(entry.input).toBe(question);
    expect(entry.reply).toBe("The only genuinely-owed reply is Luca...");
    expect(entry.proposals).toEqual(["gmail_search", "gmail_search", "gmail_read", "gmail_read"]);
    // Both halves of the exchange landed on ONE entry — neither the question nor the answer
    // was orphaned onto a second one.
  });
});

describe("turn-capture hook — a scheduled push into Bendik's session", () => {
  /**
   * THE CRITICAL. Schedules do not get their own session: `to(telegram, { chatId }).send(...)`
   * goes through `deliver()` → `runtime.dispatchContinuation({command, continuationToken})`,
   * which RESUMES a session by token, and for a private chat that token is the same one Bendik's
   * own messages resolve to. So a morning brief lands INSIDE his live session.
   *
   * A HITL button tap seeds an empty-input slot (`turn.started` with no `message.received`).
   * When re-seeding was gated on a non-empty input, the brief's prompt was filled into that slot
   * and inherited its door, its lack of a lane, and its proposals — writing
   * `**Bendik:** Write the morning brief for today.` into the vault with the tap's proposal
   * attached. A later turn could then quote Bendik saying a brief's prompt text. Gating on the
   * TURN instead is what closes it.
   */
  it("never attributes a scheduled prompt to Bendik when it lands in a tap's open slot", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = "telegram-chat-day";
    const tap = ctx({ kind: "telegram", sessionId: session, turnId: "turn_4", current: humanTelegramAuth });
    const brief = ctx({
      kind: "telegram",
      sessionId: session,
      turnId: "turn_5",
      current: { ...scheduleAppAuth, attributes: { lane: "morning-brief" } },
    });

    // He taps an approval button: a turn starts, with no message.received at all.
    await hook.onTurnStarted(started("turn_4"), tap);
    await hook.onActionsRequested(actions("turn_4", [toolCall("twenty_create_opportunity")]), tap);

    // The 06:00 brief fires into the SAME session, on a new turn.
    await hook.onTurnStarted(started("turn_5"), brief);
    await hook.onMessageReceived(received("turn_5", "Write the morning brief for today."), brief);
    await hook.onMessageCompleted(completed("turn_5", "stop", "Here is your brief."), brief);

    // ONE file: the brief. The tap spoke no words, so it is dropped rather than written with an
    // empty `**Bendik:**` line — but it is still never merged into the brief, which is the point.
    expect(capture).toHaveBeenCalledTimes(1);
    const briefEntry = capture.mock.calls[0][0] as TurnLogEntry;

    // The brief is the machine's, with its lane, and carries none of the tap's state.
    expect(briefEntry.lane).toBe("morning-brief");
    expect(briefEntry.input).toBe("Write the morning brief for today.");
    expect(briefEntry.reply).toBe("Here is your brief.");
    expect(briefEntry.proposals).toEqual([]);

    // The tap was dropped, and said so.
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("nobody spoke into"))).toHaveLength(1);
    warn.mockRestore();
  });

  // The same collision with an ordinary human message already in the slot.
  it("does not merge a scheduled prompt into an open human exchange", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = "telegram-chat-day";
    const human = ctx({ kind: "telegram", sessionId: session, turnId: "turn_0", current: humanTelegramAuth });
    const brief = ctx({
      kind: "telegram",
      sessionId: session,
      turnId: "turn_1",
      current: { ...scheduleAppAuth, attributes: { lane: "evening-brief" } },
    });

    await hook.onTurnStarted(started("turn_0"), human);
    await hook.onMessageReceived(received("turn_0", "hva skjer i morgen?"), human);
    await hook.onTurnStarted(started("turn_1"), brief);
    await hook.onMessageReceived(received("turn_1", "Write the evening brief."), brief);
    await hook.onMessageCompleted(completed("turn_1", "stop", "Here it is."), brief);

    expect(capture).toHaveBeenCalledTimes(2);
    const [hisEntry, briefEntry] = capture.mock.calls.map((call) => call[0] as TurnLogEntry);
    expect(hisEntry.input).toBe("hva skjer i morgen?");
    expect(hisEntry.lane).toBeUndefined();
    expect(briefEntry.lane).toBe("evening-brief");
    warn.mockRestore();
  });

  // The tool-park continuation emits NO message.received, so the re-seed rule never fires for it
  // and a tool-using exchange still lands in one file. Guards the L-1 fix against this change.
  it("still merges the tool-park continuation, which emits no message.received", async () => {
    const c = ctx({ kind: "telegram", turnId: "turn_0", current: humanTelegramAuth });
    await hook.onTurnStarted(started("turn_0"), c);
    await hook.onMessageReceived(received("turn_0", "who do I owe?"), c);
    await hook.onActionsRequested(actions("turn_0", [toolCall("gmail_search")]), c);
    await hook.onTurnCompleted(turnCompleted("turn_0"), c);
    await hook.onTurnStarted(started("turn_1"), c);
    await hook.onMessageCompleted(completed("turn_1", "stop", "Just Luca."), c);

    const entry = onlyEntry();
    expect(entry.input).toBe("who do I owe?");
    expect(entry.reply).toBe("Just Luca.");
    expect(entry.proposals).toEqual(["gmail_search"]);
  });
});

describe("turn-capture hook — an unfinished write is stamped when it happened", () => {
  /**
   * `at` is what the conversation record and the dream cycle both key on. Stamping an
   * eviction write at flush time — a day late — would file the gated-proposal entry that
   * write-on-evict exists to preserve under the WRONG day, where the dream cycle would never
   * look for it.
   */
  it("stamps an evicted exchange with its start time, not the eviction time", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const startedAtMs = Date.parse("2026-08-19T09:15:00.000Z");
    let clock = startedAtMs;
    const h = makeTurnCapture({ capture: capture as never, now: () => clock });
    const c = ctx({ kind: "telegram", turnId: "turn_0", current: humanTelegramAuth });

    await h.onTurnStarted(started("turn_0"), c);
    await h.onMessageReceived(received("turn_0", "book the flight"), c);
    await h.onActionsRequested(actions("turn_0", [toolCall("calendar_create_event")]), c);

    clock = Date.parse("2026-08-20T14:00:00.000Z");
    await h.onTurnCompleted(turnCompleted("turn_0"), c);

    expect(onlyEntry().at).toBe("2026-08-19T09:15:00.000Z");
    warn.mockRestore();
  });

  it("stamps a superseded exchange with its start time too", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let clock = Date.parse("2026-08-19T09:15:00.000Z");
    const h = makeTurnCapture({ capture: capture as never, now: () => clock });
    const c = ctx({ kind: "telegram", turnId: "turn_0", current: humanTelegramAuth });

    await h.onTurnStarted(started("turn_0"), c);
    await h.onMessageReceived(received("turn_0", "book the flight"), c);

    clock = Date.parse("2026-08-19T20:30:00.000Z");
    await h.onMessageReceived(received("turn_1", "never mind"), c);

    expect(capture).toHaveBeenCalledTimes(1);
    expect((capture.mock.calls[0][0] as TurnLogEntry).at).toBe("2026-08-19T09:15:00.000Z");
    warn.mockRestore();
  });

  // A finished exchange is stamped now — it just ended.
  it("stamps a completed exchange at flush time", async () => {
    const clock = Date.parse("2026-08-20T07:00:00.000Z");
    const h = makeTurnCapture({ capture: capture as never, now: () => clock });
    const c = ctx({ kind: "telegram", turnId: "turn_0", current: humanTelegramAuth });
    await fullTurn(h, c, "turn_0", "hei", "svar");
    expect(onlyEntry().at).toBe("2026-08-20T07:00:00.000Z");
  });
});

describe("turn-capture hook — the human's words, not the envelope", () => {
  /**
   * THE OTHER 2026-08-20 REGRESSION. Saga's Slack door hands the model a structured wrapper, and
   * the raw event text is the whole thing — logging it verbatim put markup and channel
   * identifiers (`sender_id`, `channel_id`, `thread_ts`, `team_id`) into the Brain. The
   * pre-outage corpus has the clean sentence and no envelope anywhere.
   */
  const envelope = [
    "<slack_message>",
    "sender_type: user",
    "sender_id: U_EXAMPLE_OWNER",
    "channel_id: D0BAQRGLSKA",
    "thread_ts: 1787208678.815859",
    "message_ts: 1787208678.815859",
    "team_id: T098VSVRWKU",
    "<content>",
    "Good morning!",
    "</content>",
    "</slack_message>",
  ].join("\n");

  it("logs only the inner text of a slack_message envelope", async () => {
    const c = ctx({ kind: "slack", current: humanSlackAuth });
    await fullTurn(hook, c, "turn_0", envelope, "Morning!");

    const entry = onlyEntry();
    // The clean sentence, with none of the envelope's markup or identifiers — proven by the
    // entry's input carrying exactly this and nothing else.
    expect(entry.input).toBe("Good morning!");
  });

  // Every malformed shape falls back to the raw text: losing his words would be far worse than
  // keeping a little markup.
  it("falls back to the raw text when there is no <content> block", async () => {
    const c = ctx({ kind: "slack", current: humanSlackAuth });
    const noContent = "<slack_message>\nsender_id: U_EXAMPLE_OWNER\n</slack_message>";
    await fullTurn(hook, c, "turn_0", noContent, "ok");
    expect(onlyEntry().input).toBe(noContent);
  });

  it("falls back to the raw text when the <content> tag is never closed", async () => {
    const c = ctx({ kind: "slack", current: humanSlackAuth });
    const unclosed = "<slack_message>\n<content>\nGood morning!\n</slack_message>";
    await fullTurn(hook, c, "turn_0", unclosed, "ok");
    expect(onlyEntry().input).toBe(unclosed);
  });

  it("falls back to the raw text when the <content> block is empty", async () => {
    const c = ctx({ kind: "slack", current: humanSlackAuth });
    const empty = "<slack_message>\n<content>\n\n</content>\n</slack_message>";
    await fullTurn(hook, c, "turn_0", empty, "ok");
    expect(onlyEntry().input).toBe(empty);
  });

  // Door-agnostic by construction: it keys off the envelope's shape, not on `door === "slack"`.
  it("unwraps the same envelope shape on the telegram door", async () => {
    const c = ctx({ kind: "telegram", current: humanTelegramAuth });
    await fullTurn(hook, c, "turn_0", envelope, "Morn!");
    expect(onlyEntry().input).toBe("Good morning!");
  });

  it("leaves an ordinary message untouched", async () => {
    const c = ctx({ kind: "telegram", current: humanTelegramAuth });
    await fullTurn(hook, c, "turn_0", "hei, hva skjer?", "ikke mye");
    expect(onlyEntry().input).toBe("hei, hva skjer?");
  });
});

describe("turn-capture hook — turns with no message.received", () => {
  /**
   * AN EXCHANGE NOBODY SPOKE INTO IS NOT WRITTEN — the asymmetric rule, and this is its "drop"
   * half. A HITL button tap starts a turn with no `message.received` at all (the delivery carries
   * `inputResponses`, typed `message?: never`), Saga acts and confirms, and no words were ever
   * typed. Across the entire 160-file pre-outage corpus, the number of files with a `**Saga:**`
   * reply above an empty `**Bendik:**` line is ZERO — so dropping it is the faithful port.
   *
   * This deliberately loses Saga's confirmation after an approved proposal. If the dream cycle
   * later wants those, that is a separate ticket, not something to reintroduce quietly.
   */
  it("writes NOTHING for a tap-only exchange with a reply but no input", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = ctx({ kind: "telegram", turnId: "turn_3", current: humanTelegramAuth });
    await hook.onTurnStarted(started("turn_3"), c);
    await hook.onActionsRequested(actions("turn_3", [toolCall("crm_create_note")]), c);
    await hook.onMessageCompleted(completed("turn_3", "stop", "Done — noted in the CRM."), c);
    await hook.onTurnCompleted(turnCompleted("turn_3"), c);

    expect(capture).not.toHaveBeenCalled();
    // Logged, because it is the only way we would notice this rule eating real conversations.
    const skips = warn.mock.calls.filter((call) => String(call[0]).includes("nobody spoke into"));
    expect(skips).toHaveLength(1);
    expect(String(skips[0][0])).toContain("telegram");
    warn.mockRestore();
  });

  // The other half of the asymmetry, and the reason it is asymmetric: an input with NO reply is
  // legitimate and still written. That is the gated proposal awaiting approval — the corpus has 3.
  it("still writes an exchange that has an input but never got a reply", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let clock = 1_000_000;
    const h = makeTurnCapture({ capture: capture as never, now: () => clock });
    const c = ctx({ kind: "telegram", turnId: "turn_0", current: humanTelegramAuth });

    await h.onTurnStarted(started("turn_0"), c);
    await h.onMessageReceived(received("turn_0", "book the flight to NYC"), c);
    await h.onActionsRequested(actions("turn_0", [toolCall("calendar_create_event")]), c);
    clock += 25 * 60 * 60 * 1000;
    await h.onTurnCompleted(turnCompleted("turn_0"), c);

    const entry = onlyEntry();
    expect(entry.input).toBe("book the flight to NYC");
    expect(entry.reply).toBe("");
    warn.mockRestore();
  });

  // Belt as well as braces: if turn.started is ever missed, an input still starts a capture.
  it("still captures when only message.received is seen", async () => {
    const c = ctx({ kind: "telegram", current: humanTelegramAuth });
    await hook.onMessageReceived(received("turn_0", "hei"), c);
    await hook.onMessageCompleted(completed("turn_0", "stop", "svar"), c);
    await hook.onTurnCompleted(turnCompleted("turn_0"), c);
    expect(onlyEntry().input).toBe("hei");
  });
});

describe("turn-capture hook — what must NOT be written", () => {
  // A partial or failed turn must never be recorded as a finished one.
  /**
   * A failed turn is never recorded as FINISHED — there is no `**Saga:**` line on what it writes.
   * It is not, however, erased: if Bendik actually said something it is written as a reply-less
   * file, because one slot now spans a whole chat-day and a blanket discard would take an
   * unrelated buffered exchange down with it (and a continuation-turn failure would lose the
   * original question, which the pre-outage runtime kept).
   *
   * Note the companion path, which is NOT this one: once a terminal reply has been delivered the
   * exchange is already flushed and gone, so a later `turn.failed` writes nothing extra and
   * cannot unwrite it. A reply he has already read is a fact.
   */
  it("writes a failed turn's question, without a reply", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = ctx({ kind: "telegram", turnId: "turn_0", current: humanTelegramAuth });
    await hook.onTurnStarted(started("turn_0"), c);
    await hook.onMessageReceived(received("turn_0", "hei"), c);
    await hook.onActionsRequested(actions("turn_0", [toolCall("gmail_search")]), c);
    // It blows up before producing any terminal reply.
    await hook.onTurnDiscarded(turnFailed("turn_0"), c);

    const entry = onlyEntry();
    expect(entry.input).toBe("hei");
    expect(entry.reply).toBe("");
    warn.mockRestore();
  });

  it("drops a failed turn that carried no words at all", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = ctx({ kind: "telegram", turnId: "turn_0", current: humanTelegramAuth });
    await hook.onTurnStarted(started("turn_0"), c);
    await hook.onTurnDiscarded(turnFailed("turn_0"), c);
    expect(capture).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("drops a cancelled turn that carried no words", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = ctx({ kind: "telegram", turnId: "turn_0", current: humanTelegramAuth });
    await hook.onTurnStarted(started("turn_0"), c);
    await hook.onTurnDiscarded(turnCancelled("turn_0"), c);
    expect(capture).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // A discarded exchange is written at most once: nothing arriving afterwards re-writes it.
  it("does not write a discarded exchange twice when turn.completed follows", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = ctx({ kind: "telegram", turnId: "turn_0", current: humanTelegramAuth });
    await hook.onTurnStarted(started("turn_0"), c);
    await hook.onMessageReceived(received("turn_0", "hei"), c);
    await hook.onTurnDiscarded(turnFailed("turn_0"), c);
    await hook.onTurnCompleted(turnCompleted("turn_0"), c);
    expect(capture).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  // This capture is for the two doors. A subagent's internal turns are not conversations.
  it("writes nothing for a non-door channel kind", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = ctx({ kind: "subagent", current: humanTelegramAuth });
    await fullTurn(hook, c, "turn_0", "internal", "internal reply");
    expect(capture).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("writes nothing when the channel kind is absent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = ctx({ current: humanTelegramAuth });
    await fullTurn(hook, c, "turn_0", "?", "!");
    expect(capture).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("turn-capture hook — totality and hygiene", () => {
  // eve turns a thrown hook into `turn.failed`. Capture is an artifact of the turn, not part of
  // it: nothing in here may ever cost Bendik his reply.
  it("NEVER throws when the capture sink rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    capture.mockRejectedValueOnce(new Error("disk full"));
    const c = ctx({ kind: "telegram", current: humanTelegramAuth });
    await hook.onTurnStarted(started("turn_0"), c);
    await hook.onMessageReceived(received("turn_0", "hei"), c);
    await hook.onMessageCompleted(completed("turn_0", "stop", "svar"), c);
    await expect(hook.onTurnCompleted(turnCompleted("turn_0"), c)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("NEVER throws on a malformed event or context", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = {} as never;
    await expect(hook.onTurnStarted(broken, broken)).resolves.toBeUndefined();
    await expect(hook.onMessageReceived(broken, broken)).resolves.toBeUndefined();
    await expect(hook.onActionsRequested(broken, broken)).resolves.toBeUndefined();
    await expect(hook.onMessageCompleted(broken, broken)).resolves.toBeUndefined();
    await expect(hook.onTurnCompleted(broken, broken)).resolves.toBeUndefined();
    await expect(hook.onTurnDiscarded(broken, broken)).resolves.toBeUndefined();
    expect(capture).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  /**
   * The tripwire. There is an open question only the live box can settle — whether a
   * SCHEDULE-started turn's hook context carries a channel at all. If it does not, scheduled
   * turns are silently never captured, and this warning is how the box tells us on day one
   * instead of going quiet for six days the way the original outage did.
   */
  it("warns ONCE per unrecognised channel kind, and never for a known door", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const odd = ctx({ kind: "kind-never-seen-before", current: humanTelegramAuth });
    await hook.onTurnStarted(started("turn_0"), odd);
    const first = warn.mock.calls.filter((c) => String(c[0]).includes("kind-never-seen-before"));
    expect(first).toHaveLength(1);

    await hook.onTurnStarted(started("turn_1"), odd);
    const second = warn.mock.calls.filter((c) => String(c[0]).includes("kind-never-seen-before"));
    expect(second).toHaveLength(1);

    warn.mockClear();
    const door = ctx({ kind: "telegram", current: humanTelegramAuth });
    await fullTurn(hook, door, "turn_0", "hei", "svar");
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("not capturing turns"))).toHaveLength(0);

    // The "warned already" memory is per-instance, not module-scope: a fresh hook warns again for
    // the same kind. A shared Set would leak this state between tests and let a future test
    // reusing a kind string silently observe no warning at all.
    warn.mockClear();
    const fresh = makeTurnCapture({ capture: capture as never });
    await fresh.onTurnStarted(started("turn_0"), odd);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("kind-never-seen-before"))).toHaveLength(1);
    warn.mockRestore();
  });

  /**
   * THE EVICTION BOUNDARY, lower half: an exchange opened 8 hours ago is still buffered, so when
   * it finally produces its terminal reply the file carries the original question — not an
   * empty-input stub.
   */
  it("does NOT evict an exchange 8 hours old — the ceiling is 24h, not 30 minutes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let clock = 1_000_000;
    const h = makeTurnCapture({ capture: capture as never, now: () => clock });
    const c = ctx({ kind: "telegram", current: humanTelegramAuth });

    await h.onTurnStarted(started("turn_0"), c);
    await h.onMessageReceived(received("turn_0", "sett opp møtet med Jannik"), c);
    await h.onActionsRequested(actions("turn_0", [toolCall("calendar_create_event")]), c);

    // Eight hours pass. Heartbeats arrive; nothing is written and nothing is evicted.
    clock += 8 * 60 * 60 * 1000;
    await h.onTurnCompleted(turnCompleted("turn_0"), c);
    expect(capture).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("UNFINISHED"))).toHaveLength(0);

    await h.onMessageCompleted(completed("turn_1", "stop", "Møtet er satt opp."), c);
    const entry = onlyEntry();
    expect(entry.input).toBe("sett opp møtet med Jannik");
    expect(entry.reply).toBe("Møtet er satt opp.");
    expect(entry.proposals).toEqual(["calendar_create_event"]);
    warn.mockRestore();
  });

  /**
   * THE EVICTION BOUNDARY, upper half — and the legitimate reply-less file.
   *
   * An exchange that ends on a gated proposal nobody ever approves produces a question and
   * proposals but no reply. The old runtime wrote exactly such files (3 of them in the 160-file
   * corpus). Eviction must therefore WRITE what it holds, not discard it.
   */
  it("WRITES an exchange abandoned past the ceiling, question and proposals intact", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let clock = 1_000_000;
    const h = makeTurnCapture({ capture: capture as never, now: () => clock });
    const c = ctx({ kind: "telegram", current: humanTelegramAuth });

    await h.onTurnStarted(started("turn_0"), c);
    await h.onMessageReceived(received("turn_0", "book the flight to NYC"), c);
    await h.onActionsRequested(actions("turn_0", [toolCall("calendar_create_event")]), c);

    clock += 25 * 60 * 60 * 1000;
    await h.onTurnCompleted(turnCompleted("turn_0"), c);

    const entry = onlyEntry();
    expect(entry.input).toBe("book the flight to NYC");
    expect(entry.reply).toBe("");
    expect(entry.proposals).toEqual(["calendar_create_event"]);
    // Distinctly logged, so an unfinished write is never mistaken for a normal one.
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("UNFINISHED"))).toHaveLength(1);

    // Written once, and gone from the buffer.
    await h.onTurnCompleted(turnCompleted("turn_0"), c);
    expect(capture).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  // An empty shell — seeded but never used — is dropped rather than written as a blank file.
  it("evicts an empty seeded exchange without writing anything", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let clock = 1_000_000;
    const h = makeTurnCapture({ capture: capture as never, now: () => clock });
    const c = ctx({ kind: "telegram", current: humanTelegramAuth });

    await h.onTurnStarted(started("turn_0"), c);
    clock += 25 * 60 * 60 * 1000;
    await h.onTurnCompleted(turnCompleted("turn_0"), c);
    expect(capture).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

/**
 * ADR-0020 (docs/decisions/0020-conversations.md) — the origin every entry now carries, and the
 * session/turn keys the conversation record is written under. `flush` computes these itself
 * (`lib/turn-capture.ts`'s `originForTurn`); the pure branches of that function are tested
 * without a hook at all in tests/conversation-record-write.test.ts. This is the proof that the
 * hook actually wires it up — the session/turn ids it hands `originForTurn` are the same ones it
 * hands the entry.
 */
describe("turn-capture hook — origin (ADR-0020)", () => {
  it("stamps a human turn owner, with the session and opening turn id", async () => {
    const c = ctx({ kind: "telegram", current: humanTelegramAuth });
    await fullTurn(hook, c, "turn_0", "hei", "svar");
    const entry = onlyEntry();
    expect(entry.origin).toBe("owner");
    expect(entry.sessionId).toBe("session-1");
    expect(entry.turnId).toBe("turn_0");
  });

  it("stamps a scheduled lane system, never agent", async () => {
    const c = ctx({
      kind: "telegram",
      current: { ...scheduleAppAuth, attributes: { lane: "morning-brief" } },
    });
    await fullTurn(hook, c, "turn_0", "Write the morning brief for today.", "Here is your brief.");
    expect(onlyEntry().origin).toBe("system");
  });

  // Taint is keyed on the exchange's OPENING turn — the one `x.turnId` still names even across a
  // tool-park continuation — so a taint set there narrows the class the hook stamps, even though
  // nothing about the words themselves looks unusual.
  it("narrows to third_party when the opening turn read outside content", async () => {
    taintTurn({ sessionId: "session-1", turnId: "turn_0" }, "third_party");
    const c = ctx({ kind: "telegram", current: humanTelegramAuth });
    await fullTurn(hook, c, "turn_0", "hva sa Luca?", "han sa ja");
    expect(onlyEntry().origin).toBe("third_party");
  });

  // The `person_key` the entry carries is the same identity resolution the door already uses
  // for `principal` — never a display name.
  it("carries the same principal as personKey will be built from downstream", async () => {
    const c = ctx({ kind: "slack", current: humanSlackAuth });
    await fullTurn(hook, c, "turn_0", "hi", "hello");
    expect(onlyEntry().principal).toBe(configuredOwnerId());
  });
});
