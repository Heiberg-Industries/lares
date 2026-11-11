/**
 * — the hook that correlates a turn's runtime events into one conversation-log entry.
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
import { emptySessionView, foldEvents } from "eve/events";

import { makeTurnCapture } from "../agent/hooks/turn-capture.js";
import type { TurnLogEntry } from "../lib/turn-capture.js";
import { configuredOwnerId } from "../lib/identity-client.js";
import { taintTurn, resetTaintForTests } from "@lares/agent-kit/origin-taint";
import { formatConversationContinuity } from "../lib/conversation-continuity.js";

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
  /** Where the event sits on the stream. Omitted, the handler cannot tell a repeat, so it never skips one. */
  position?: { line: number; index: number };
  view?: unknown;
}): never {
  return {
    agent: { name: "agent-a" },
    ...(opts.position === undefined ? {} : { position: opts.position }),
    ...(opts.view === undefined ? {} : { view: opts.view }),
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

/** One eve 1.0 fact: `{ type, scope, data }`. The stream position is not part of the event; it rides on `ctx.position`. */
const ev = (type: string, data: Record<string, unknown>, turnId?: string): never =>
  ({ type, data, ...(turnId === undefined ? {} : { scope: { turnId } }) }) as never;

// Shapes from node_modules/eve/dist/src/protocol/session-events/families/*.d.ts
const started = (turnId: string) => ev("turn.started", { turnId, cause: { deliveryId: "d1" }, follows: null }, turnId);
const received = (turnId: string, message: string) =>
  ev("delivery.consumed", { deliveryId: "d1", turnId, parts: [{ kind: "text", text: message }] }, turnId);
/** One `call.requested` per call (a tool call here, unless `kind` says otherwise). */
const callRequested = (turnId: string, call: { callId: string; kind: string; name: string }) =>
  ev("call.requested", { callId: call.callId, owner: { turnId }, capability: { kind: call.kind, name: call.name }, input: {} }, turnId);
/** A completed part. A finish of "tool-calls" was interim narration in 0.60; it is `phase: "narration"` now. */
const completed = (turnId: string, finishReason: string, message: string | null) =>
  ev("content.completed", {
    partId: "p1", kind: "text", phase: finishReason === "tool-calls" ? "narration" : "reply",
    ...(message === null ? {} : { value: message }),
  }, turnId);
/** The turn waits on a person; the exchange is not over (0.60 ended the turn here). */
const turnPaused = (turnId: string) => ev("turn.paused", { turnId, awaiting: [{ interactionId: "i1" }] }, turnId);
const settled = (turnId: string, outcome: "completed" | "failed" | "cancelled", extra: Record<string, unknown> = {}) =>
  ev("turn.settled", {
    turnId, outcome, ...(outcome === "failed" ? { error: { code: "boom", message: "boom" } } : {}), ...extra,
  }, turnId);

const toolCall = (toolName: string) => ({ callId: `c-${toolName}`, kind: "tool", name: toolName });

/** Handlers for several calls of one turn, in order. */
async function requestCalls(h: { onCallRequested: (e: never, c: never) => Promise<void> }, c: never, turnId: string, calls: Array<{ callId: string; kind: string; name: string }>): Promise<void> {
  for (const call of calls) await h.onCallRequested(callRequested(turnId, call), c);
}

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
  await h.onDeliveryConsumed(received(turnId, input), c);
  await h.onContentCompleted(completed(turnId, "stop", reply), c);
  await h.onTurnPaused(turnPaused(turnId), c);
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
  it("records a scheduled turn under its lane, never as the owner", async () => {
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
  it("durably captures delivered pending approval cards across a restart as quoted context only", async () => {
    const audienceAuth = { ...scheduleAppAuth, attributes: {
      lane: "proactive-brief", lares_continuity_member_id: "member-a",
      lares_continuity_address: "telegram-user:123", lares_continuity_revision: "9",
    } };
    const c = ctx({ kind: "telegram", current: audienceAuth });
    await hook.onTurnStarted(started("post-1"), c);
    // eve 1.0: an approval is an `interaction.opened` about a call; the tool and its input come from the session view.
    const card = (interactionId: string, toolName: string, prompt: string) => ({
      interactionId, callId: `call-${interactionId}`, toolName, prompt,
    });
    const cards = [
      card("approval-a", "calendar.create_event", "Create the event for Tuesday?"),
      card("approval-b", "gmail_send", "Send the drafted reply?"),
    ];
    const at = "2026-10-01T10:00:00.000Z";
    let line = 0;
    const facts = cards.flatMap((k) => [
      { type: "call.requested", scope: { turnId: "post-1" }, data: { callId: k.callId, owner: { turnId: "post-1" }, capability: { kind: "tool", name: k.toolName }, input: { secret: "must not be copied" } }, meta: { position: { line: line++, index: 0 }, at } },
      { type: "interaction.opened", scope: { turnId: "post-1" }, data: { interactionId: k.interactionId, subject: { callId: k.callId }, request: { kind: "approval", prompt: k.prompt, options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }] } }, meta: { position: { line: line++, index: 0 }, at } },
    ]);
    const view = foldEvents(emptySessionView(), facts as never);
    const withView = ctx({ kind: "telegram", current: audienceAuth, view });
    for (const e of facts.filter((r) => r.type === "interaction.opened")) await hook.onInteractionOpened(e as never, withView);
    // A third proactive post needs no approval card; it is captured by the ordinary terminal path.
    await hook.onDeliveryConsumed(received("post-1", "Write the brief"), c);
    await hook.onContentCompleted(completed("post-1", "stop", "The weekly brief is ready."), c);

    const rows = capture.mock.calls.map(call => {
      const e = call[0] as TurnLogEntry;
      return {
        id: e.approvalRequestId ?? e.turnId, agent: "agent-a", sessionId: e.sessionId, turnId: e.turnId,
        door: e.door, personKey: "member-a", audienceMemberId: e.audienceMemberId ?? null,
        audienceAddress: e.audienceAddress ?? null, audienceAccessRevision: e.audienceAccessRevision ?? null,
        lane: e.lane ?? null, origin: e.origin ?? "third_party", input: e.input, reply: e.reply,
        proposals: e.proposals, approvalRequestId: e.approvalRequestId ?? null, at: new Date(e.at), recordedAt: new Date(e.at),
      };
    });
    expect(rows).toHaveLength(3);
    expect(rows.filter(row => row.approvalRequestId)).toHaveLength(2);
    expect(rows.map(row => row.reply).join("\n")).not.toContain("must not be copied");

    // A fresh hook instance has no buffered state; the read comes from the durable rows above.
    const restarted = makeTurnCapture({ capture: vi.fn(async () => {}) });
    const fresh = ctx({ kind: "telegram", current: { ...humanTelegramAuth, attributes: { user_id: "123" } } });
    await restarted.onTurnStarted(started("fresh-none"), fresh);
    await restarted.onDeliveryConsumed(received("fresh-none", "none of these"), fresh);
    const context = formatConversationContinuity(rows as never).join("\n");
    expect(context).toContain("Create the event for Tuesday?");
    expect(context).toContain("Send the drafted reply?");
    expect(context).toContain("The weekly brief is ready.");
    expect(context).toContain("quoted archive data only");
    expect(context).not.toContain("must not be copied");
    expect(restarted.onDeliveryConsumed).toBeDefined();
  });

  // `message.completed` fires more than once per turn: interim tool-call narration, then the
  // terminal reply. Only the terminal one is the reply, and none of them is a turn boundary.
  it("ignores an interim message.completed with finishReason tool-calls", async () => {
    const c = ctx({ kind: "telegram", current: humanTelegramAuth });
    await hook.onTurnStarted(started("turn_0"), c);
    await hook.onDeliveryConsumed(received("turn_0", "hva skjer?"), c);
    await hook.onContentCompleted(completed("turn_0", "tool-calls", "let me check the calendar"), c);
    expect(capture).not.toHaveBeenCalled();

    await hook.onContentCompleted(completed("turn_0", "stop", "tre møter i dag"), c);
    expect(onlyEntry().reply).toBe("tre møter i dag");
    // `turn.completed` afterwards must not write a second, duplicate file.
    await hook.onTurnPaused(turnPaused("turn_0"), c);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("accumulates tool names from several actions.requested events into proposals", async () => {
    const c = ctx({ kind: "telegram", current: humanTelegramAuth });
    await hook.onTurnStarted(started("turn_0"), c);
    await hook.onDeliveryConsumed(received("turn_0", "note this"), c);
    await requestCalls(hook, c, "turn_0", [toolCall("vault_write"), { callId: "x", kind: "skill", name: "lares-docs" }]);
    await requestCalls(hook, c, "turn_0", [toolCall("calendar_list")]);
    await hook.onContentCompleted(completed("turn_0", "stop", "done"), c);
    await hook.onTurnPaused(turnPaused("turn_0"), c);

    expect(onlyEntry().proposals).toEqual(["vault_write", "calendar_list"]);
  });

  // A new message while an exchange is still open means the old one never got a terminal reply
  // (it stopped on a gated proposal). It is WRITTEN, not overwritten — silently dropping a
  // question the owner actually asked is the loss this whole design is trying to avoid.
  it("writes the unfinished exchange when a new message arrives before any reply", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = ctx({ kind: "telegram", current: humanTelegramAuth });
    await hook.onTurnStarted(started("turn_0"), c);
    await hook.onDeliveryConsumed(received("turn_0", "book the flight"), c);
    await requestCalls(hook, c, "turn_0", [toolCall("calendar_create_event")]);
    // No terminal reply — the chief of staff is waiting on approval. The owner types something new instead.
    await hook.onDeliveryConsumed(received("turn_1", "actually never mind"), c);

    expect(capture).toHaveBeenCalledTimes(1);
    const abandoned = capture.mock.calls[0][0] as TurnLogEntry;
    expect(abandoned.input).toBe("book the flight");
    expect(abandoned.reply).toBe("");
    expect(abandoned.proposals).toEqual(["calendar_create_event"]);

    // ...and the new exchange is now the live one, starting clean.
    await hook.onContentCompleted(completed("turn_1", "stop", "Greit."), c);
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
   * while the owner is mid-exchange on Slack shares the id. Keyed on turnId alone, one entry would
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
    await hook.onDeliveryConsumed(received("turn_0", "hva er status?"), human);
    // The brief interleaves, with the very same turnId.
    await hook.onTurnStarted(started("turn_0"), brief);
    await hook.onDeliveryConsumed(received("turn_0", "Write the morning brief for today."), brief);
    await requestCalls(hook, brief, "turn_0", [toolCall("calendar_list")]);
    await hook.onContentCompleted(completed("turn_0", "stop", "Here is your brief."), brief);
    await hook.onTurnPaused(turnPaused("turn_0"), brief);
    await hook.onContentCompleted(completed("turn_0", "stop", "alt er grønt"), human);
    await hook.onTurnPaused(turnPaused("turn_0"), human);

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
   * THE REGRESSION, reproduced.
   *
   * Live output that morning, from ONE exchange: `06-50-05-345Z-telegram.md` held the question
   * and `proposals: gmail_search, gmail_search, gmail_read, gmail_read` with no `**the chief of staff:**` line
   * at all, and `06-50-48-499Z-telegram.md` — 43 seconds later — held the reply above an empty
   * `**the owner:**`. The turn parks at the tool step, eve emits the epilogue, and the continuation
   * arrives as a NEW turn id with no `message.received`.
   *
   * The pre-outage corpus contains no question-less file anywhere, and the dream cycle would
   * otherwise reflect on a question with no answer and an answer with no question.
   */
  it("writes ONE file for a tool-using exchange that eve splits across two turns", async () => {
    const c = ctx({ kind: "telegram", current: humanTelegramAuth });
    const question = "Thanks, you said I owe two replies, other than Marco, what is the second?";

    // Turn one: the question, four tool calls, interim narration, then the park.
    await hook.onTurnStarted(started("turn_0"), c);
    await hook.onDeliveryConsumed(received("turn_0", question), c);
    await requestCalls(hook, c, "turn_0", [toolCall("gmail_search"), toolCall("gmail_search")]);
    await requestCalls(hook, c, "turn_0", [toolCall("gmail_read"), toolCall("gmail_read")]);
    await hook.onContentCompleted(completed("turn_0", "tool-calls", "Let me check your inbox."), c);
    await hook.onTurnPaused(turnPaused("turn_0"), c);
    expect(capture).not.toHaveBeenCalled();

    // Turn two: a different id, NO message.received, and the real answer.
    await hook.onTurnStarted(started("turn_1"), c);
    await hook.onContentCompleted(completed("turn_1", "stop", "The only genuinely-owed reply is Marco..."), c);
    await hook.onTurnPaused(turnPaused("turn_1"), c);

    const entry = onlyEntry();
    expect(entry.input).toBe(question);
    expect(entry.reply).toBe("The only genuinely-owed reply is Marco...");
    expect(entry.proposals).toEqual(["gmail_search", "gmail_search", "gmail_read", "gmail_read"]);
    // Both halves of the exchange landed on ONE entry — neither the question nor the answer
    // was orphaned onto a second one.
  });
});

describe("turn-capture hook — a scheduled push into the owner's session", () => {
  /**
   * THE CRITICAL. Schedules do not get their own session: `to(telegram, { chatId }).send(...)`
   * goes through `deliver()` → `runtime.dispatchContinuation({command, continuationToken})`,
   * which RESUMES a session by token, and for a private chat that token is the same one the owner's
   * own messages resolve to. So a morning brief lands INSIDE the owner's live session.
   *
   * A HITL button tap seeds an empty-input slot (`turn.started` with no `message.received`).
   * When re-seeding was gated on a non-empty input, the brief's prompt was filled into that slot
   * and inherited its door, its lack of a lane, and its proposals — writing
   * `**the owner:** Write the morning brief for today.` into the vault with the tap's proposal
   * attached. A later turn could then quote the owner saying a brief's prompt text. Gating on the
   * TURN instead is what closes it.
   */
  it("never attributes a scheduled prompt to the owner when it lands in a tap's open slot", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = "telegram-chat-day";
    const tap = ctx({ kind: "telegram", sessionId: session, turnId: "turn_4", current: humanTelegramAuth });
    const brief = ctx({
      kind: "telegram",
      sessionId: session,
      turnId: "turn_5",
      current: { ...scheduleAppAuth, attributes: { lane: "morning-brief" } },
    });

    // The owner taps an approval button: a turn starts, with no message.received at all.
    await hook.onTurnStarted(started("turn_4"), tap);
    await requestCalls(hook, tap, "turn_4", [toolCall("twenty_create_opportunity")]);

    // The 06:00 brief fires into the SAME session, on a new turn.
    await hook.onTurnStarted(started("turn_5"), brief);
    await hook.onDeliveryConsumed(received("turn_5", "Write the morning brief for today."), brief);
    await hook.onContentCompleted(completed("turn_5", "stop", "Here is your brief."), brief);

    // ONE file: the brief. The tap spoke no words, so it is dropped rather than written with an
    // empty `**the owner:**` line — but it is still never merged into the brief, which is the point.
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
    await hook.onDeliveryConsumed(received("turn_0", "hva skjer i morgen?"), human);
    await hook.onTurnStarted(started("turn_1"), brief);
    await hook.onDeliveryConsumed(received("turn_1", "Write the evening brief."), brief);
    await hook.onContentCompleted(completed("turn_1", "stop", "Here it is."), brief);

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
    await hook.onDeliveryConsumed(received("turn_0", "who do I owe?"), c);
    await requestCalls(hook, c, "turn_0", [toolCall("gmail_search")]);
    await hook.onTurnPaused(turnPaused("turn_0"), c);
    await hook.onTurnStarted(started("turn_1"), c);
    await hook.onContentCompleted(completed("turn_1", "stop", "Just Marco."), c);

    const entry = onlyEntry();
    expect(entry.input).toBe("who do I owe?");
    expect(entry.reply).toBe("Just Marco.");
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
    await h.onDeliveryConsumed(received("turn_0", "book the flight"), c);
    await requestCalls(h, c, "turn_0", [toolCall("calendar_create_event")]);

    clock = Date.parse("2026-08-20T14:00:00.000Z");
    await h.onTurnPaused(turnPaused("turn_0"), c);

    expect(onlyEntry().at).toBe("2026-08-19T09:15:00.000Z");
    warn.mockRestore();
  });

  it("stamps a superseded exchange with its start time too", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let clock = Date.parse("2026-08-19T09:15:00.000Z");
    const h = makeTurnCapture({ capture: capture as never, now: () => clock });
    const c = ctx({ kind: "telegram", turnId: "turn_0", current: humanTelegramAuth });

    await h.onTurnStarted(started("turn_0"), c);
    await h.onDeliveryConsumed(received("turn_0", "book the flight"), c);

    clock = Date.parse("2026-08-19T20:30:00.000Z");
    await h.onDeliveryConsumed(received("turn_1", "never mind"), c);

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
   * ANOTHER REGRESSION. The chief of staff's Slack door hands the model a structured wrapper, and
   * the raw event text is the whole thing — logging it verbatim put markup and channel
   * identifiers (`sender_id`, `channel_id`, `thread_ts`, `team_id`) into the Brain. The
   * pre-outage corpus has the clean sentence and no envelope anywhere.
   */
  const envelope = [
    "<slack_message>",
    "sender_type: user",
    "sender_id: U_EXAMPLE_OWNER",
    "channel_id: D00000001",
    "thread_ts: 1700000000.000100",
    "message_ts: 1700000000.000100",
    "team_id: T00000000",
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

  // Every malformed shape falls back to the raw text: losing the owner's words would be far worse than
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
   * `inputResponses`, typed `message?: never`), the chief of staff acts and confirms, and no words were ever
   * typed. Across the entire 160-file pre-outage corpus, the number of files with a `**the chief of staff:**`
   * reply above an empty `**the owner:**` line is ZERO — so dropping it is the faithful port.
   *
   * This deliberately loses the chief of staff's confirmation after an approved proposal. If the dream cycle
   * later wants those, that is a separate ticket, not something to reintroduce quietly.
   */
  it("writes NOTHING for a tap-only exchange with a reply but no input", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = ctx({ kind: "telegram", turnId: "turn_3", current: humanTelegramAuth });
    await hook.onTurnStarted(started("turn_3"), c);
    await requestCalls(hook, c, "turn_3", [toolCall("crm_create_note")]);
    await hook.onContentCompleted(completed("turn_3", "stop", "Done — noted in the CRM."), c);
    await hook.onTurnPaused(turnPaused("turn_3"), c);

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
    await h.onDeliveryConsumed(received("turn_0", "book the flight to NYC"), c);
    await requestCalls(h, c, "turn_0", [toolCall("calendar_create_event")]);
    clock += 25 * 60 * 60 * 1000;
    await h.onTurnPaused(turnPaused("turn_0"), c);

    const entry = onlyEntry();
    expect(entry.input).toBe("book the flight to NYC");
    expect(entry.reply).toBe("");
    warn.mockRestore();
  });

  // Belt as well as braces: if turn.started is ever missed, an input still starts a capture.
  it("still captures when only message.received is seen", async () => {
    const c = ctx({ kind: "telegram", current: humanTelegramAuth });
    await hook.onDeliveryConsumed(received("turn_0", "hei"), c);
    await hook.onContentCompleted(completed("turn_0", "stop", "svar"), c);
    await hook.onTurnPaused(turnPaused("turn_0"), c);
    expect(onlyEntry().input).toBe("hei");
  });
});

describe("turn-capture hook — what must NOT be written", () => {
  // A partial or failed turn must never be recorded as a finished one.
  /**
   * A failed turn is never recorded as FINISHED — there is no `**the chief of staff:**` line on what it writes.
   * It is not, however, erased: if the owner actually said something it is written as a reply-less
   * file, because one slot now spans a whole chat-day and a blanket discard would take an
   * unrelated buffered exchange down with it (and a continuation-turn failure would lose the
   * original question, which the pre-outage runtime kept).
   *
   * Note the companion path, which is NOT this one: once a terminal reply has been delivered the
   * exchange is already flushed and gone, so a later `turn.failed` writes nothing extra and
   * cannot unwrite it. A reply the owner has already read is a fact.
   */
  it("writes a failed turn's question, without a reply", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = ctx({ kind: "telegram", turnId: "turn_0", current: humanTelegramAuth });
    await hook.onTurnStarted(started("turn_0"), c);
    await hook.onDeliveryConsumed(received("turn_0", "hei"), c);
    await requestCalls(hook, c, "turn_0", [toolCall("gmail_search")]);
    // It blows up before producing any terminal reply.
    await hook.onTurnSettled(settled("turn_0", "failed"), c);

    const entry = onlyEntry();
    expect(entry.input).toBe("hei");
    expect(entry.reply).toBe("");
    warn.mockRestore();
  });

  it("drops a failed turn that carried no words at all", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = ctx({ kind: "telegram", turnId: "turn_0", current: humanTelegramAuth });
    await hook.onTurnStarted(started("turn_0"), c);
    await hook.onTurnSettled(settled("turn_0", "failed"), c);
    expect(capture).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("drops a cancelled turn that carried no words", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = ctx({ kind: "telegram", turnId: "turn_0", current: humanTelegramAuth });
    await hook.onTurnStarted(started("turn_0"), c);
    await hook.onTurnSettled(settled("turn_0", "cancelled"), c);
    expect(capture).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // A discarded exchange is written at most once: nothing arriving afterwards re-writes it.
  it("does not write a discarded exchange twice when turn.completed follows", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = ctx({ kind: "telegram", turnId: "turn_0", current: humanTelegramAuth });
    await hook.onTurnStarted(started("turn_0"), c);
    await hook.onDeliveryConsumed(received("turn_0", "hei"), c);
    await hook.onTurnSettled(settled("turn_0", "failed"), c);
    await hook.onTurnPaused(turnPaused("turn_0"), c);
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
  // it: nothing in here may ever cost the owner a reply.
  it("NEVER throws when the capture sink rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    capture.mockRejectedValueOnce(new Error("disk full"));
    const c = ctx({ kind: "telegram", current: humanTelegramAuth });
    await hook.onTurnStarted(started("turn_0"), c);
    await hook.onDeliveryConsumed(received("turn_0", "hei"), c);
    await hook.onContentCompleted(completed("turn_0", "stop", "svar"), c);
    await expect(hook.onTurnPaused(turnPaused("turn_0"), c)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("NEVER throws on a malformed event or context", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = {} as never;
    await expect(hook.onTurnStarted(broken, broken)).resolves.toBeUndefined();
    await expect(hook.onDeliveryConsumed(broken, broken)).resolves.toBeUndefined();
    await expect(hook.onCallRequested(broken, broken)).resolves.toBeUndefined();
    await expect(hook.onInteractionOpened(broken, broken)).resolves.toBeUndefined();
    await expect(hook.onContentCompleted(broken, broken)).resolves.toBeUndefined();
    await expect(hook.onTurnPaused(broken, broken)).resolves.toBeUndefined();
    await expect(hook.onTurnSettled(broken, broken)).resolves.toBeUndefined();
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
    await h.onDeliveryConsumed(received("turn_0", "sett opp møtet med Jens"), c);
    await requestCalls(h, c, "turn_0", [toolCall("calendar_create_event")]);

    // Eight hours pass. Heartbeats arrive; nothing is written and nothing is evicted.
    clock += 8 * 60 * 60 * 1000;
    await h.onTurnPaused(turnPaused("turn_0"), c);
    expect(capture).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("UNFINISHED"))).toHaveLength(0);

    await h.onContentCompleted(completed("turn_1", "stop", "Møtet er satt opp."), c);
    const entry = onlyEntry();
    expect(entry.input).toBe("sett opp møtet med Jens");
    expect(entry.reply).toBe("Møtet er satt opp.");
    expect(entry.proposals).toEqual(["calendar_create_event"]);
    warn.mockRestore();
  });

  /**
   * THE EVICTION BOUNDARY, upper half — and the legitimate reply-less file.
   *
   * An exchange that ends on a gated proposal nobody ever approves produces a question and
   * proposals but no reply. Real logs contain such exchanges (3 of them in a 160-file
   * corpus). Eviction must therefore WRITE what it holds, not discard it.
   */
  it("WRITES an exchange abandoned past the ceiling, question and proposals intact", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let clock = 1_000_000;
    const h = makeTurnCapture({ capture: capture as never, now: () => clock });
    const c = ctx({ kind: "telegram", current: humanTelegramAuth });

    await h.onTurnStarted(started("turn_0"), c);
    await h.onDeliveryConsumed(received("turn_0", "book the flight to NYC"), c);
    await requestCalls(h, c, "turn_0", [toolCall("calendar_create_event")]);

    clock += 25 * 60 * 60 * 1000;
    await h.onTurnPaused(turnPaused("turn_0"), c);

    const entry = onlyEntry();
    expect(entry.input).toBe("book the flight to NYC");
    expect(entry.reply).toBe("");
    expect(entry.proposals).toEqual(["calendar_create_event"]);
    // Distinctly logged, so an unfinished write is never mistaken for a normal one.
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("UNFINISHED"))).toHaveLength(1);

    // Written once, and gone from the buffer.
    await h.onTurnPaused(turnPaused("turn_0"), c);
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
    await h.onTurnPaused(turnPaused("turn_0"), c);
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
    await fullTurn(hook, c, "turn_0", "hva sa Marco?", "han sa ja");
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

it('suppresses every tagged private event, including normal, resumed, failed and cancelled exchanges', async()=>{
 const privateAuth={authenticator:'lares-console',attributes:{lares_member_id:'synthetic-member',lares_admission_nonce:'a'.repeat(43),lares_purpose:'human'}};
 const c=ctx({kind:'http',current:privateAuth});
 await hook.onTurnStarted(started('private-turn'),c);
 await hook.onDeliveryConsumed(received('private-turn','PRIVATE_CANARY'),c);
 await requestCalls(hook,c,'private-turn',[toolCall('gmail_read')]);
 await hook.onInteractionOpened(ev('interaction.opened',{interactionId:'i',subject:{callId:'c'},request:{kind:'approval',prompt:'Approve?'}}),c);
 await hook.onContentCompleted(completed('private-turn','stop','PRIVATE_REPLY_CANARY'),c);
 await hook.onTurnPaused(turnPaused('private-turn'),c);
 await hook.onTurnStarted(started('resumed-turn'),c);
 await hook.onTurnSettled(settled('resumed-turn','failed'),c);
 await hook.onTurnSettled(settled('resumed-turn','cancelled'),c);
 expect(capture).not.toHaveBeenCalled();
});

// ── eve 1.0 events ──────────────────────────────────────────────────────────────────────────────
// Every event below is built from the shipped `.d.ts` shapes (see the builders at the top), and the
// hook is fed what eve 1.0 sends: delivery.consumed, call.requested, content.completed, turn.paused
// and turn.settled. Nothing here uses a 0.60 name.
describe("turn-capture hook — eve 1.0 events", () => {
  const telegram = () => ctx({ kind: "telegram", current: humanTelegramAuth });

  it("subscribes to eve 1.0 events only", async () => {
    const mod = (await import("../agent/hooks/turn-capture.js")).default as { events: Record<string, unknown> };
    expect(Object.keys(mod.events).sort()).toEqual([
      "call.requested", "content.completed", "delivery.consumed", "interaction.opened",
      "turn.paused", "turn.settled", "turn.started",
    ]);
  });

  it("completed: ONE row, the reply is the content.completed text with phase reply, narration is not the reply", async () => {
    const c = telegram();
    await hook.onTurnStarted(started("t1"), c);
    await hook.onDeliveryConsumed(received("t1", "what is on today?"), c);
    await requestCalls(hook, c, "t1", [toolCall("calendar_list")]);
    await hook.onContentCompleted(completed("t1", "tool-calls", "let me look"), c);
    expect(capture).not.toHaveBeenCalled();
    await hook.onContentCompleted(completed("t1", "stop", "three meetings"), c);
    await hook.onTurnSettled(settled("t1", "completed", { reply: ["three meetings"] }), c);
    const entry = onlyEntry();
    expect(entry).toMatchObject({ input: "what is on today?", reply: "three meetings", proposals: ["calendar_list"], turnId: "t1", sessionId: "session-1" });
  });

  it("completed with no inline reply text: the settled turn writes it once, with the reply parts eve gives", async () => {
    const c = telegram();
    await hook.onTurnStarted(started("t1"), c);
    await hook.onDeliveryConsumed(received("t1", "hello"), c);
    // A reply carried by reference has no inline value: it flushes nothing here.
    await hook.onContentCompleted(ev("content.completed", { partId: "p", kind: "text", phase: "reply", valueRef: { ref: "r" } }, "t1"), c);
    expect(capture).not.toHaveBeenCalled();
    await hook.onTurnSettled(settled("t1", "completed", { reply: ["part one", "part two"] }), c);
    await hook.onTurnSettled(settled("t1", "completed", { reply: ["part one", "part two"] }), c);
    expect(onlyEntry()).toMatchObject({ input: "hello", reply: "part one\npart two" });
  });

  it("failed: ONE reply-less row for what the owner said, never a finished one", async () => {
    const c = telegram();
    await hook.onTurnStarted(started("t1"), c);
    await hook.onDeliveryConsumed(received("t1", "send the report"), c);
    await requestCalls(hook, c, "t1", [toolCall("gmail_search")]);
    await hook.onTurnSettled(settled("t1", "failed"), c);
    await hook.onTurnSettled(settled("t1", "failed"), c);
    expect(onlyEntry()).toMatchObject({ input: "send the report", reply: "", proposals: ["gmail_search"] });
  });

  it("cancelled: ONE reply-less row", async () => {
    const c = telegram();
    await hook.onTurnStarted(started("t1"), c);
    await hook.onDeliveryConsumed(received("t1", "never mind"), c);
    await hook.onTurnSettled(settled("t1", "cancelled"), c);
    expect(onlyEntry()).toMatchObject({ input: "never mind", reply: "" });
  });

  it("a settled turn with nobody's words writes nothing, whatever its outcome", async () => {
    for (const outcome of ["completed", "failed", "cancelled"] as const) {
      const c = ctx({ kind: "telegram", sessionId: `s-${outcome}`, current: humanTelegramAuth });
      await hook.onTurnStarted(started("t1"), c);
      await hook.onTurnSettled(settled("t1", outcome), c);
    }
    expect(capture).not.toHaveBeenCalled();
  });

  it("a pause is not the end: the same turn continues after the answer and the exchange stays ONE row", async () => {
    const c = telegram();
    await hook.onTurnStarted(started("t1"), c);
    await hook.onDeliveryConsumed(received("t1", "book the room"), c);
    await requestCalls(hook, c, "t1", [toolCall("calendar_create_event")]);
    await hook.onTurnPaused(turnPaused("t1"), c);
    expect(capture).not.toHaveBeenCalled();
    // The answer arrives on the SAME turn: no new turn.started, no new message.
    await requestCalls(hook, c, "t1", [toolCall("gmail_search")]);
    await hook.onContentCompleted(completed("t1", "stop", "booked"), c);
    await hook.onTurnSettled(settled("t1", "completed", { reply: ["booked"] }), c);
    expect(onlyEntry()).toMatchObject({ input: "book the room", reply: "booked", proposals: ["calendar_create_event", "gmail_search"] });
  });

  it("another turn's settle does not write an open exchange", async () => {
    const c = telegram();
    await hook.onTurnStarted(started("t1"), c);
    await hook.onDeliveryConsumed(received("t1", "question"), c);
    await hook.onTurnSettled(settled("t-other", "failed"), c);
    expect(capture).not.toHaveBeenCalled();
    await hook.onContentCompleted(completed("t1", "stop", "answer"), c);
    expect(onlyEntry().reply).toBe("answer");
  });

  it("a second message on the same turn adds to the input; a delivery with no words changes nothing", async () => {
    const c = telegram();
    await hook.onTurnStarted(started("t1"), c);
    await hook.onDeliveryConsumed(received("t1", "first"), c);
    await hook.onDeliveryConsumed(received("t1", "second"), c);
    await hook.onDeliveryConsumed(ev("delivery.consumed", { deliveryId: "d3", turnId: "t1", parts: [] }, "t1"), c);
    await hook.onDeliveryConsumed(ev("delivery.consumed", { deliveryId: "d4", turnId: "t1", parts: [{ kind: "file", mediaType: "text/plain", ref: "r" }, { kind: "from-a-newer-eve" }] }, "t1"), c);
    await hook.onContentCompleted(completed("t1", "stop", "ok"), c);
    expect(onlyEntry().input).toBe("first\nsecond");
  });

  it("only a TOOL call is a proposal; skills, agents and task control are not", async () => {
    const c = telegram();
    await hook.onTurnStarted(started("t1"), c);
    await hook.onDeliveryConsumed(received("t1", "go"), c);
    await requestCalls(hook, c, "t1", [
      { callId: "a", kind: "skill", name: "lares-docs" }, { callId: "b", kind: "agent", name: "helper" },
      { callId: "c", kind: "control", name: "wait" }, { callId: "d", kind: "tool", name: "vault_write" },
      { callId: "e", kind: "from-a-newer-eve", name: "x" },
    ]);
    await hook.onContentCompleted(completed("t1", "stop", "done"), c);
    expect(onlyEntry().proposals).toEqual(["vault_write"]);
  });

  it("only a text part with phase reply ends an exchange: unknown phases, other kinds and empty text do not", async () => {
    const c = telegram();
    await hook.onTurnStarted(started("t1"), c);
    await hook.onDeliveryConsumed(received("t1", "q"), c);
    for (const data of [
      { partId: "1", kind: "text", phase: "narration", value: "thinking aloud" },
      { partId: "2", kind: "text", phase: "from-a-newer-eve", value: "not an answer" },
      { partId: "3", kind: "reasoning", phase: "reply", value: "hidden thoughts" },
      { partId: "4", kind: "result", phase: "reply", value: { a: 1 } },
      { partId: "5", kind: "text", phase: "reply", value: "" },
      { partId: "6", kind: "text", phase: "reply" },
      { partId: "7", kind: "text", value: "no phase" },
    ]) await hook.onContentCompleted(ev("content.completed", data, "t1"), c);
    expect(capture).not.toHaveBeenCalled();
    await hook.onContentCompleted(completed("t1", "stop", "the answer"), c);
    expect(onlyEntry().reply).toBe("the answer");
  });

  describe("an event seen twice (a line read again) changes nothing", () => {
    it("a repeated call.requested adds its tool once; a repeated delivery adds its words once", async () => {
      const at = (line: number, index = 0) => ({ kind: "telegram", current: humanTelegramAuth, position: { line, index } });
      await hook.onTurnStarted(started("t1"), ctx(at(0)));
      for (let i = 0; i < 2; i += 1) await hook.onDeliveryConsumed(received("t1", "hello"), ctx(at(1)));
      for (let i = 0; i < 2; i += 1) await hook.onCallRequested(callRequested("t1", toolCall("calendar_list")), ctx(at(2)));
      await hook.onCallRequested(callRequested("t1", toolCall("calendar_list")), ctx(at(2, 1))); // a different event in the line
      await hook.onContentCompleted(completed("t1", "stop", "ok"), ctx(at(3)));
      expect(onlyEntry()).toMatchObject({ input: "hello", proposals: ["calendar_list", "calendar_list"] });
    });

    it("one stream read twice writes ONE row per exchange", async () => {
      const stream = (c: (line: number) => never) => async (h: typeof hook) => {
        await h.onTurnStarted(started("t1"), c(0));
        await h.onDeliveryConsumed(received("t1", "hi"), c(1));
        await h.onContentCompleted(completed("t1", "stop", "hello"), c(2));
        await h.onTurnSettled(settled("t1", "completed"), c(3));
        await h.onTurnStarted(started("t2"), c(4));
        await h.onDeliveryConsumed(received("t2", "again"), c(5));
        await h.onTurnSettled(settled("t2", "failed"), c(6));
      };
      const read = stream((line) => ctx({ kind: "telegram", current: humanTelegramAuth, position: { line, index: 0 } }));
      await read(hook);
      await read(hook);
      expect(capture).toHaveBeenCalledTimes(2);
      expect(capture.mock.calls.map((call) => (call[0] as TurnLogEntry).turnId)).toEqual(["t1", "t2"]);
    });

    it("a repeat does not skip a different session's event at the same position", async () => {
      const a = ctx({ kind: "telegram", sessionId: "sa", current: humanTelegramAuth, position: { line: 0, index: 0 } });
      const b = ctx({ kind: "telegram", sessionId: "sb", current: humanTelegramAuth, position: { line: 0, index: 0 } });
      await hook.onTurnStarted(started("t1"), a);
      await hook.onTurnStarted(started("t1"), b);
      await hook.onDeliveryConsumed(received("t1", "x"), ctx({ kind: "telegram", sessionId: "sa", current: humanTelegramAuth, position: { line: 1, index: 0 } }));
      await hook.onDeliveryConsumed(received("t1", "y"), ctx({ kind: "telegram", sessionId: "sb", current: humanTelegramAuth, position: { line: 1, index: 0 } }));
      await hook.onTurnSettled(settled("t1", "failed"), ctx({ kind: "telegram", sessionId: "sa", current: humanTelegramAuth, position: { line: 2, index: 0 } }));
      await hook.onTurnSettled(settled("t1", "failed"), ctx({ kind: "telegram", sessionId: "sb", current: humanTelegramAuth, position: { line: 2, index: 0 } }));
      expect(capture.mock.calls.map((call) => (call[0] as TurnLogEntry).input).sort()).toEqual(["x", "y"]);
    });
  });

  it("the console's web channel (channel:eve) is not a door: nothing is written, whatever the outcome", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const outcome of ["completed", "failed", "cancelled"] as const) {
      const c = ctx({ kind: "channel:eve", sessionId: `web-${outcome}`, current: humanTelegramAuth });
      await hook.onTurnStarted(started("t1"), c);
      await hook.onDeliveryConsumed(received("t1", "hello"), c);
      await hook.onContentCompleted(completed("t1", "stop", "hi"), c);
      await hook.onTurnSettled(settled("t1", outcome), c);
    }
    expect(capture).not.toHaveBeenCalled();
  });

  it("a failing capture sink never throws out of a handler: eve 1.0 would fail the turn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failing = makeTurnCapture({ capture: (async () => { throw new Error("vault down"); }) as never });
    const c = telegram();
    await failing.onTurnStarted(started("t1"), c);
    await failing.onDeliveryConsumed(received("t1", "hi"), c);
    await expect(failing.onContentCompleted(completed("t1", "stop", "hello"), c)).resolves.toBeUndefined();
    await failing.onDeliveryConsumed(received("t2", "again"), c);
    await expect(failing.onTurnSettled(settled("t2", "failed"), c)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
