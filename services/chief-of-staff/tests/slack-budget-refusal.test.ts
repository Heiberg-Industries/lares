/**
 * A capped turn says so on the chief of staff's Slack door, on eve 1.0.
 *
 * WHAT CHANGED FROM eve 0.60, and why this file looks different.
 *
 *  - The events. `turn.failed` and `session.failed` are gone. A failure the conversation can
 *    carry on from is `turn.settled` with `outcome: "failed"`; a failure that ends it is
 *    `session.ended` with `outcome: "failed"`, and in that case the turn settles `cancelled`
 *    with no error of its own. One fault writes its error on exactly one of the two
 *    (`eve/dist/src/harness/session-machine/transitions.js`, `fail`). The gateway's cap is a
 *    plain 4xx, which eve treats as ending the conversation, so `session.ended` is where a
 *    capped turn normally shows up. On 0.60 that event was the one the door stayed quiet on.
 *
 *  - The payload. It is `error: { code, message, id?, hint? }`. The `details` object that
 *    carried the gateway's error type and HTTP status is no longer on the event
 *    (`eve/dist/src/harness/facts.js`, `errorInfoOf`). The cap is therefore recognised by the
 *    gateway's sentence in `message` alone.
 *
 *  - The door no longer REPLACES eve's handler. It is a renderer around it: anything that is not
 *    a cap goes to `next()`, which is eve's own text. So there is no copy of eve's wording to
 *    pin here any more; what is pinned is that an ordinary failure reaches `next()` untouched.
 *
 * The fixtures: the gateway's sentence is verbatim from the live probe recorded in
 * `@lares/agent-kit/gateway-budget`. The eve event around it is SHAPED from reading the
 * installed eve (`harness/model-call/failure.js` builds `{ code: "MODEL_CALL_FAILED", message }`
 * with the gateway's own message for a 4xx). No live eve 1.0 turn against a capped key has been
 * run; when one is, its event belongs here in place of the shaped one.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// eve's own composer for a door's `renderers`: an INTERNAL, reached on purpose and by file path.
// `slackChannel()` builds its event handlers with exactly this call, and it only wires the event
// names eve 1.0 renders. A handler under any other name is dropped without a word, which is how
// this door went quiet on its 0.60 event names. Running the door's installed renderers through
// it is the check that eve really hears them.
import { composeSlackRenderers } from "../node_modules/eve/dist/src/public/channels/slack/renderers.js";

import { onSessionEnded, onTurnSettled, slackDoorConfig } from "../agent/channels/slack.js";
import { MODEL_CALLS_REFUSED_UNSCOPED, MODEL_COMPACTION_REFUSED } from "@lares/agent-kit/conversation-too-long";
import type { SessionView } from "eve/events";

const TOO_LONG_DM = "This thread has grown too long for me to continue. Please send your message again as a new message, not as a reply in this thread.";
const TOO_LONG_ROOM = "This thread has grown too long for me to continue. Please send your message again as a new message that mentions me, not as a reply in this thread.";
const PARTLY_DONE = "Part of what you asked may already have been done, so check before asking again.";

/** A turn that called one tool, folded by eve's own fold with the retention a channel observer gets. */
async function viewWithCall(turnId: string, outcome: string): Promise<SessionView> {
  const projection = (file: string) => new URL(`../node_modules/eve/dist/src/protocol/session-projection/${file}`, import.meta.url).href;
  const { emptySessionView, foldEvents } = await import(projection("fold.js")) as { emptySessionView(): object; foldEvents(v: object, e: unknown[], o: object): unknown };
  const { snapshotOf } = await import(projection("session-view.js")) as { snapshotOf(v: object): SessionView };
  const at = "2026-11-12T10:00:00.000Z";
  let line = 0;
  const fact = (type: string, data: Record<string, unknown>) => ({ type, scope: { turnId }, data, meta: { position: { line: line++, index: 0 }, at, endOfLine: true } });
  const tables = emptySessionView();
  foldEvents(tables, [
    fact("turn.started", { turnId, cause: { deliveryId: "d1" }, follows: null }),
    fact("call.requested", { callId: "call-1", owner: { turnId }, capability: { kind: "tool", name: "gmail_send" }, input: {} }),
    fact("call.started", { callId: "call-1" }),
    fact("call.settled", { callId: "call-1", outcome }),
  ], { retention: "operational" });
  return snapshotOf(tables);
}

const REFUSAL_SENTENCE =
  "I have hit my spending cap — nothing was done. It resets with the next budget period, or you can raise the cap.";

/** VERBATIM gateway sentence; SHAPED eve 1.0 error around it. */
const BUDGET_ERROR = {
  code: "MODEL_CALL_FAILED",
  message: "Budget has been exceeded! Current cost: 0.0124665, Max budget: 0.01",
  id: "err_budget_0001",
};

/** An ordinary failure: nothing about the gateway's cap. */
const ORDINARY_ERROR = { code: "MODEL_CALL_FAILED", message: "socket hang up", id: "err_plain_0002" };

/** A failure that ends the conversation: the error is on the session's end. */
const sessionEndedFailed = (error: object) =>
  ({ type: "session.ended", data: { outcome: "failed", cause: { turnId: "turn_3" }, error } }) as const;
/** A failure the conversation can carry on from: the error is on the turn. */
const turnSettledFailed = (error: object) =>
  ({ type: "turn.settled", data: { turnId: "turn_3", outcome: "failed", error } }) as const;

function fakeDoor() {
  const posted: unknown[] = [];
  const next = vi.fn(async () => {});
  return {
    posted,
    next,
    ctx: { channel: { thread: { post: async (m: unknown) => { posted.push(m); return {}; } } } },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the chief of staff's Slack door — a capped turn answers with one fixed sentence", () => {
  it("posts the fixed sentence, and nothing else, when the cap ends the conversation", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, posted, next } = fakeDoor();
    await onSessionEnded(sessionEndedFailed(BUDGET_ERROR), ctx, next);
    expect(posted).toEqual([REFUSAL_SENTENCE]);
    expect(next, "eve's generic failure text must not be posted as well").not.toHaveBeenCalled();
  });

  it("the refused reply after an approval answer posts its one fixed sentence, not eve's text, on either event", async () => {
    const refused = { code: "REACTION_FAILED", message: "DefinitionFailedError: The reply after an approval answer was refused", id: "err_1" };
    for (const event of [turnSettledFailed(refused), sessionEndedFailed(refused)]) {
      const { ctx, posted, next } = fakeDoor();
      await (event.type === "turn.settled" ? onTurnSettled : onSessionEnded)(event as never, ctx, next);
      expect(posted).toEqual(["Your answer was applied, but I could not finish my reply. Ask me what happened."]);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("a card that ended without an answer posts that sentence, never 'your answer was applied'", async () => {
    const unanswered = { code: "REACTION_FAILED", message: "DefinitionFailedError: The approval in this turn ended without an answer", id: "err_2" };
    for (const event of [turnSettledFailed(unanswered), sessionEndedFailed(unanswered)]) {
      const { ctx, posted, next } = fakeDoor();
      await (event.type === "turn.settled" ? onTurnSettled : onSessionEnded)(event as never, ctx, next);
      expect(posted).toEqual(["That request ended without an answer; nothing was done."]);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("a thread that has grown too long posts its one fixed sentence, not eve's text, and only for that cause", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const message of [MODEL_COMPACTION_REFUSED, `context.started failed: ${MODEL_COMPACTION_REFUSED}`]) {
      const { ctx, posted, next } = fakeDoor();
      await onTurnSettled(turnSettledFailed({ code: "MODEL_CALL_FAILED", message, id: "err_long" }), ctx, next);
      // Nothing says where the conversation started: the room wording, true in a direct message too.
      expect(posted).toEqual([TOO_LONG_ROOM]);
      expect(next).not.toHaveBeenCalled();
    }
    expect(String(warn.mock.calls[0]![0])).toContain("grew too long");
    // A lookalike, the guard's degraded refusal, or any other failure is still eve's to answer.
    for (const error of [ORDINARY_ERROR, { code: "MODEL_CALL_FAILED", message: `${MODEL_COMPACTION_REFUSED}, and more`, id: "err_x" },
      { code: "MODEL_CALL_FAILED", message: MODEL_CALLS_REFUSED_UNSCOPED, id: "err_d" },
      { code: "HOOK_FAILED", message: `Hook "context.started" failed: ${MODEL_CALLS_REFUSED_UNSCOPED}`, id: "err_h" }]) {
      const { ctx, posted, next } = fakeDoor();
      await onTurnSettled(turnSettledFailed(error), ctx, next);
      expect(posted).toEqual([]);
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  it("too long: a direct message keeps the approved sentence, a room is told to mention the agent", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const started = (channel_id: string) => ({ authenticator: "slack-webhook", attributes: { channel_id } });
    for (const [initiator, expected] of [[started("D0FIXTURE"), TOO_LONG_DM], [started("C0FIXTURE"), TOO_LONG_ROOM]] as const) {
      const { ctx, posted, next } = fakeDoor();
      await onTurnSettled(turnSettledFailed({ code: "MODEL_CALL_FAILED", message: MODEL_COMPACTION_REFUSED, id: "err_long" }),
        { ...ctx, session: { auth: { initiator, current: started("D0FIXTURE") } } }, next);
      expect(posted).toEqual([expected]);
    }
  });

  it("too long after the turn already completed a call: one more sentence, since resending could repeat it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dm = { auth: { initiator: { authenticator: "slack-webhook", attributes: { channel_id: "D0FIXTURE" } } } };
    for (const [outcome, expected] of [["completed", `${TOO_LONG_DM} ${PARTLY_DONE}`], ["rejected", TOO_LONG_DM]] as const) {
      const { ctx, posted, next } = fakeDoor();
      await onTurnSettled(
        { type: "turn.settled", data: { turnId: "turn_3", outcome: "failed", error: { code: "MODEL_CALL_FAILED", message: MODEL_COMPACTION_REFUSED } } } as never,
        { ...ctx, session: dm, view: await viewWithCall("turn_3", outcome) }, next);
      expect(posted).toEqual([expected]);
    }
  });

  it("posts the same sentence when the cap arrives as a failed turn instead", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, posted, next } = fakeDoor();
    await onTurnSettled(turnSettledFailed(BUDGET_ERROR), ctx, next);
    expect(posted).toEqual([REFUSAL_SENTENCE]);
    expect(next).not.toHaveBeenCalled();
  });

  it("never leaks the gateway's own error text, the cost figures, or an error id", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, posted, next } = fakeDoor();
    await onSessionEnded(sessionEndedFailed(BUDGET_ERROR), ctx, next);
    const text = String(posted[0]);
    expect(text).not.toContain("Budget has been exceeded!");
    expect(text).not.toContain("0.0124665");
    expect(text).not.toContain("err_budget_0001");
    expect(text).not.toContain("I hit an error");
  });

  it("logs exactly one line for the capped turn, with no figures in it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, next } = fakeDoor();
    await onSessionEnded(sessionEndedFailed(BUDGET_ERROR), ctx, next);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("gateway budget exceeded");
    expect(String(warn.mock.calls[0]![0])).not.toContain("0.0124665");
  });

  it("says it once for one fault: the turn eve cancels alongside the ended conversation adds nothing", async () => {
    // What eve 1.0 writes for one terminal fault: the session's end with the error, and the turn
    // settled `cancelled` without one.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, posted, next } = fakeDoor();
    await onSessionEnded(sessionEndedFailed(BUDGET_ERROR), ctx, next);
    await onTurnSettled({ type: "turn.settled", data: { turnId: "turn_3", outcome: "cancelled" } } as never, ctx, next);
    expect(posted).toEqual([REFUSAL_SENTENCE]);
    // The cancelled turn still goes to eve's handler, which clears the thread's status.
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("never retries: one pass, one post", async () => {
    // The earlier leak was an uncapped retry around a paid call. A cap is the last failure that
    // should be retried, so the handler is a single pass.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, posted, next } = fakeDoor();
    await onSessionEnded(sessionEndedFailed(BUDGET_ERROR), ctx, next);
    expect(posted).toHaveLength(1);
  });
});

describe("the chief of staff's Slack door — everything else is eve's to answer, in eve's words", () => {
  it.each([
    ["a failed turn", () => onTurnSettled, turnSettledFailed(ORDINARY_ERROR)],
    ["an ended conversation", () => onSessionEnded, sessionEndedFailed(ORDINARY_ERROR)],
  ] as const)("an ordinary failure (%s) goes to eve's own handler, once, and the door posts nothing itself", async (_name, handler, event) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, posted, next } = fakeDoor();
    await handler()(event, ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(posted).toEqual([]);
    expect(warn, "nothing extra is logged on an ordinary failure").not.toHaveBeenCalled();
  });

  it.each(["completed", "cancelled"])("a turn that %s goes to eve's own handler", async (outcome) => {
    const { ctx, posted, next } = fakeDoor();
    await onTurnSettled({ type: "turn.settled", data: { turnId: "turn_3", outcome } } as never, ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(posted).toEqual([]);
  });

  it("a conversation that ends normally goes to eve's own handler", async () => {
    const { ctx, posted, next } = fakeDoor();
    await onSessionEnded({ type: "session.ended", data: { outcome: "completed" } } as never, ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(posted).toEqual([]);
  });

  it("a completed turn whose text happens to quote the gateway's sentence is not a refusal", async () => {
    // Only a FAILED outcome is ever read as a cap.
    const { ctx, posted, next } = fakeDoor();
    await onTurnSettled({ type: "turn.settled", data: { turnId: "turn_3", outcome: "completed", error: BUDGET_ERROR } } as never, ctx, next);
    expect(posted).toEqual([]);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("a failure with no error on it goes to eve's own handler", async () => {
    const { ctx, posted, next } = fakeDoor();
    await onSessionEnded({ type: "session.ended", data: { outcome: "failed" } } as never, ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(posted).toEqual([]);
  });
});

describe("the chief of staff's Slack door — as installed: eve hears the door's handlers", () => {
  /** The door's renderers around stand-ins for eve's defaults, composed the way eve composes them. */
  function installed() {
    const eveDefault = {
      "turn.settled": vi.fn(async (_event: unknown, _ctx: unknown) => {}),
      "session.ended": vi.fn(async (_event: unknown, _ctx: unknown) => {}),
    };
    const chain = composeSlackRenderers(slackDoorConfig.renderers ?? [], {
      events: eveDefault as never,
      received: async () => {},
      taskCard: () => null,
    });
    const posted: unknown[] = [];
    const ctx = { channel: { thread: { post: async (m: unknown) => { posted.push(m); return {}; } } } };
    const fire = (event: { type: "turn.settled" | "session.ended" }) =>
      (chain.events as Record<string, (event: unknown, ctx: unknown) => Promise<void>>)[event.type]!(event, ctx);
    return { eveDefault, posted, fire };
  }

  it.each([
    ["the conversation's end", sessionEndedFailed(BUDGET_ERROR)],
    ["a failed turn", turnSettledFailed(BUDGET_ERROR)],
  ] as const)("a cap on %s posts the fixed sentence and eve's own failure text is not posted", async (_name, event) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { eveDefault, posted, fire } = installed();
    await fire(event);
    expect(posted).toEqual([REFUSAL_SENTENCE]);
    expect(eveDefault[event.type]).not.toHaveBeenCalled();
  });

  it.each([
    ["the conversation's end", sessionEndedFailed(ORDINARY_ERROR)],
    ["a failed turn", turnSettledFailed(ORDINARY_ERROR)],
  ] as const)("an ordinary failure on %s reaches eve's own handler with the event unchanged", async (_name, event) => {
    const { eveDefault, posted, fire } = installed();
    await fire(event);
    expect(posted).toEqual([]);
    expect(eveDefault[event.type]).toHaveBeenCalledTimes(1);
    expect(eveDefault[event.type].mock.calls[0]![0]).toEqual(event);
  });
});

/**
 * A refusal because a monthly spending limit is reached. The engine writes the sentence (which
 * limit, and when it resets) and the door posts it as written, once.
 *
 * On eve 0.60 the kit recognised this refusal by the gateway's error TYPE. eve 1.0's payload has
 * no type, so the kit now recognises it by the message alone, and only when the message is
 * exactly one of the sentences the engine writes. That is why a message that merely looks
 * similar, or says something else entirely, is never repeated by the door.
 */
describe("a spending-limit refusal says which limit and when it resets", () => {
  const limited = (message: string) => ({ code: "MODEL_CALL_FAILED", message, id: "err_limit_0003" });
  const MEMBER = "You've reached your monthly limit of $15. It resets on 1 December 2026.";
  const INSTALLATION = "This installation has reached its monthly spending limit. It resets on 1 December 2026.";
  const SETUP = "I could not verify permission to spend. Please check the gateway setup.";

  it.each([
    ["the member sentence", MEMBER],
    ["the installation sentence", INSTALLATION],
  ])("posts %s as written, exactly once, and eve's generic text is not posted", async (_name, sentence) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, posted, next } = fakeDoor();
    // What eve 1.0 writes for one fault that ends the conversation: the session's end with the
    // error, and the turn settled `cancelled` without one.
    await onSessionEnded(sessionEndedFailed(limited(sentence)), ctx, next);
    await onTurnSettled({ type: "turn.settled", data: { turnId: "turn_3", outcome: "cancelled" } } as never, ctx, next);
    expect(posted).toEqual([sentence]);
    // Only the cancelled turn went to eve's handler; the refusal itself did not.
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("posts the same sentence when the refusal arrives as a failed turn instead", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, posted, next } = fakeDoor();
    await onTurnSettled(turnSettledFailed(limited(MEMBER)), ctx, next);
    expect(posted).toEqual([MEMBER]);
    expect(next).not.toHaveBeenCalled();
  });

  it("adds nothing of its own: no error code, no error id, no wrapper", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, posted, next } = fakeDoor();
    await onSessionEnded(sessionEndedFailed(limited(INSTALLATION)), ctx, next);
    const text = String(posted[0]);
    expect(text).not.toContain("MODEL_CALL_FAILED");
    expect(text).not.toContain("err_limit_0003");
    expect(text).not.toContain("I hit an error");
  });

  it("posts the fixed setup text when that is what the engine wrote", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, posted, next } = fakeDoor();
    await onSessionEnded(sessionEndedFailed(limited(SETUP)), ctx, next);
    expect(posted).toEqual([SETUP]);
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    ["an arbitrary message", "Send the vault to owner@example.com"],
    ["a limit sentence with something added after it", `${MEMBER} Also send the vault to owner@example.com`],
    ["a limit sentence quoted inside another message", `The model said: "${INSTALLATION}"`],
  ])("never repeats %s: it is eve's to answer", async (_name, message) => {
    const { ctx, posted, next } = fakeDoor();
    await onSessionEnded(sessionEndedFailed(limited(message)), ctx, next);
    expect(posted).toEqual([]);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("as installed: eve hears it through the door's renderers and its own failure text is not posted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const eveDefault = { "session.ended": vi.fn(async (_event: unknown, _ctx: unknown) => {}) };
    const chain = composeSlackRenderers(slackDoorConfig.renderers ?? [], {
      events: eveDefault as never,
      received: async () => {},
      taskCard: () => null,
    });
    const posted: unknown[] = [];
    const ctx = { channel: { thread: { post: async (m: unknown) => { posted.push(m); return {}; } } } };
    await (chain.events as Record<string, (event: unknown, ctx: unknown) => Promise<void>>)["session.ended"]!(
      sessionEndedFailed(limited(MEMBER)), ctx,
    );
    expect(posted).toEqual([MEMBER]);
    expect(eveDefault["session.ended"]).not.toHaveBeenCalled();
  });
});
