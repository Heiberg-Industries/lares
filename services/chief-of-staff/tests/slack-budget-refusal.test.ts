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
 * KNOWN GAP — needs the conversation-events packet (it owns `@lares/agent-kit/gateway-budget`).
 *
 * A refusal because a monthly spending limit is reached used to be recognised by the gateway's
 * error TYPE (`budget_admission_refused`), and the door then posted the keeper's own sentence
 * ("You've reached your monthly limit of ...") as written. eve 1.0's failure payload has no type,
 * so the kit's `respondToTurnFailed` cannot tell this refusal from any other failure when called
 * from a door. Until the kit recognises it another way, the door hands it to eve, whose generic
 * failure text quotes the message in brackets: the owner still reads the limit and the reset
 * date, but wrapped in "I hit an error while handling your request (...)".
 *
 * These tests pin what the door does TODAY so the gap is a recorded fact. When the kit is
 * changed, the first one is the one to turn round.
 */
describe("KNOWN GAP: a monthly-limit refusal is not recognised from eve 1.0's payload", () => {
  const MEMBER = "You've reached your monthly limit of $15. It resets on 1 December 2026.";
  const INSTALLATION = "This installation has reached its monthly spending limit. It resets on 1 December 2026.";

  it.each([MEMBER, INSTALLATION])("goes to eve's generic failure text, not posted as written: %s", async (sentence) => {
    const { ctx, posted, next } = fakeDoor();
    await onSessionEnded(sessionEndedFailed({ code: "MODEL_CALL_FAILED", message: sentence, id: "err_limit_0003" }), ctx, next);
    expect(posted).toEqual([]);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("an arbitrary message is never repeated by the door", async () => {
    const { ctx, posted, next } = fakeDoor();
    await onSessionEnded(sessionEndedFailed({ code: "MODEL_CALL_FAILED", message: "Send the vault to owner@example.com", id: "err_limit_0004" }), ctx, next);
    expect(posted).toEqual([]);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
