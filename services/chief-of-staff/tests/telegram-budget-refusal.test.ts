/**
 * A capped turn says so on the chief of staff's Telegram door.
 *
 * Sibling of `slack-budget-refusal.test.ts`. Supplying `events["turn.settled"]` and
 * `events["session.ended"]` REPLACES eve's default failure notice, so this door has to say the
 * fixed sentence on a budget refusal and exactly what eve would have said on anything else.
 *
 * WHAT CHANGED WITH eve 1.0, and why the fixtures below are produced by eve itself:
 *
 *   - The payload. A failure is reported as `error: { code, message, id? }`. The gateway's own
 *     `error.type` and HTTP status are no longer in the event. What is left to recognise a
 *     refusal by is the gateway's sentence, in `message`.
 *   - Which event. One failure is one event. A failure the session survives ends the TURN
 *     (`turn.settled`, outcome `failed`). A failure it does not survive ends the SESSION
 *     (`session.ended`, outcome `failed`) and the turn carries no error of its own. eve 0.60
 *     reported a terminal failure on both.
 *
 * A gateway budget refusal arrives either way: LiteLLM answers it with HTTP 400 (terminal — the
 * session ends) or HTTP 429 (retried, then the turn fails). Both are run through the installed
 * eve's own classifier and error builder here, so the fixture is what eve really emits.
 *
 * The gateway body is verbatim from the live probe in the per-user spend-cap measurements.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { APICallError } from "ai";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

import { onSessionEnded, onTurnSettled } from "../agent/channels/telegram.js";
import { MODEL_COMPACTION_REFUSED } from "@lares/agent-kit/conversation-too-long";

const REFUSAL_SENTENCE =
  "I have hit my spending cap — nothing was done. It resets with the next budget period, or you can raise the cap.";

const GATEWAY_SENTENCE = "Budget has been exceeded! Current cost: 0.0124665, Max budget: 0.01";

/** eve's dist, for the internals its exports map does not expose. */
const EVE_DIST = pathToFileURL(fileURLToPath(new URL("../node_modules/eve/dist/src", import.meta.url))).href;

interface ErrorInfo {
  code: string;
  message: string;
  id?: string;
}
interface Eve {
  modelCallErrorInfo(error: unknown): ErrorInfo;
  classifyModelCallError(error: unknown): string;
  failureNotice(ending: { outcome: string; error?: ErrorInfo }, scope: "turn" | { restart: string }): string | undefined;
}
let eve: Eve;
beforeAll(async () => {
  const failure = (await import(`${EVE_DIST}/harness/model-call/failure.js`)) as Pick<Eve, "modelCallErrorInfo">;
  const errors = (await import(`${EVE_DIST}/harness/model-call/errors.js`)) as Pick<Eve, "classifyModelCallError">;
  const reply = (await import(`${EVE_DIST}/public/channels/reply.js`)) as Pick<Eve, "failureNotice">;
  eve = { ...failure, ...errors, ...reply };
});

/** The error the model call throws when the gateway refuses it, as the AI SDK raises it. */
function gatewayError(status: number, body: { error: Record<string, unknown> }): APICallError {
  return new APICallError({
    message: String(body.error["message"]),
    url: "http://gateway.example/v1/chat/completions",
    requestBodyValues: {},
    statusCode: status,
    responseHeaders: {},
    responseBody: JSON.stringify(body),
    data: body,
    isRetryable: status === 429,
  });
}

const budgetRefusal = (status: number) =>
  gatewayError(status, { error: { message: GATEWAY_SENTENCE, type: "budget_exceeded", param: null, code: String(status) } });

/** A failed turn / a failed session, with the error eve builds from `thrown` and an id eve would quote. */
const failed = (thrown: unknown, id = "err_budget_0001") => ({
  type: "ending",
  data: { outcome: "failed", error: { ...eve.modelCallErrorInfo(thrown), id } },
});

function fakeChat() {
  const posted: unknown[] = [];
  return {
    posted,
    ctx: { channel: { telegram: { post: async (m: string) => { posted.push(m); return {}; } } } },
  };
}

beforeEach(() => {
  // No DATABASE_URL and no principal: neither handler may need either — a capped turn must
  // still be able to say so with the rotation store unreachable.
  delete process.env["DATABASE_URL"];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("what the installed eve reports for a gateway budget refusal", () => {
  it("keeps the gateway's sentence in the error's message, and nothing of its type or status", () => {
    for (const status of [400, 429]) {
      const info = eve.modelCallErrorInfo(budgetRefusal(status));
      expect(info).toEqual({ code: "MODEL_CALL_FAILED", message: GATEWAY_SENTENCE });
    }
  });

  it("ends the session on a 400, and retries then fails the turn on a 429", () => {
    expect(eve.classifyModelCallError(budgetRefusal(400))).toBe("terminal");
    expect(eve.classifyModelCallError(budgetRefusal(429))).toBe("retry");
  });
});

describe("a capped turn answers with one fixed sentence, whichever event carries it", () => {
  it("the session ended on the refusal (HTTP 400): the sentence, and nothing else", async () => {
    const { ctx, posted } = fakeChat();
    await onSessionEnded(failed(budgetRefusal(400)), ctx);
    expect(posted).toEqual([REFUSAL_SENTENCE]);
  });

  it("the refused reply after an approval answer posts its one fixed sentence, not eve's text, on either event", async () => {
    const refused = { outcome: "failed", error: { code: "REACTION_FAILED", message: "DefinitionFailedError: The reply after an approval answer was refused", id: "err_1" } };
    for (const handler of [onTurnSettled, onSessionEnded]) {
      const { ctx, posted } = fakeChat();
      await handler({ data: refused } as never, ctx);
      expect(posted).toEqual(["Your answer was applied, but I could not finish my reply. Ask me what happened."]);
    }
  });

  it("a card that ended without an answer posts that sentence, never 'your answer was applied'", async () => {
    const unanswered = { outcome: "failed", error: { code: "REACTION_FAILED", message: "DefinitionFailedError: The approval in this turn ended without an answer", id: "err_2" } };
    for (const handler of [onTurnSettled, onSessionEnded]) {
      const { ctx, posted } = fakeChat();
      await handler({ data: unanswered } as never, ctx);
      expect(posted).toEqual(["That request ended without an answer; nothing was done."]);
    }
  });

  it("the turn failed on the refusal (HTTP 429, after eve's retries): the same sentence", async () => {
    const { ctx, posted } = fakeChat();
    await onTurnSettled(failed(budgetRefusal(429)), ctx);
    expect(posted).toEqual([REFUSAL_SENTENCE]);
  });

  it("a session that ends on the refusal says it ONCE: the turn it ended carries no error and posts nothing", async () => {
    // What eve emits for a terminal failure: the turn settles without an error of its own, and
    // the session's ending carries it.
    const { ctx, posted } = fakeChat();
    await onTurnSettled({ data: { outcome: "cancelled" } }, ctx);
    await onSessionEnded(failed(budgetRefusal(400)), ctx);
    expect(posted).toEqual([REFUSAL_SENTENCE]);
  });

  it("never leaks the gateway's own error text, the cost figures, or an error id", async () => {
    for (const handler of [onSessionEnded, onTurnSettled]) {
      const { ctx, posted } = fakeChat();
      await handler(failed(budgetRefusal(400)), ctx);
      const text = String(posted[0]);
      expect(text).not.toContain("Budget has been exceeded!");
      expect(text).not.toContain("0.0124665");
      expect(text).not.toContain("err_budget_0001");
      expect(text).not.toContain("I hit an error");
      expect(text).not.toContain("could not recover");
    }
  });

  it("logs exactly one line for the capped turn", async () => {
    for (const handler of [onSessionEnded, onTurnSettled]) {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { ctx } = fakeChat();
      await handler(failed(budgetRefusal(400)), ctx);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("gateway budget exceeded");
      warn.mockRestore();
    }
  });

  it("never retries — one post per event, no second model call, no loop", async () => {
    const { ctx, posted } = fakeChat();
    await onSessionEnded(failed(budgetRefusal(400)), ctx);
    expect(posted).toHaveLength(1);
  });

  it("does not mistake an ordinary failure that merely carries a status for a refusal", async () => {
    const badModel = gatewayError(400, { error: { message: "Invalid model name passed in model=nope", type: "invalid_request_error", code: "400" } });
    const { ctx, posted } = fakeChat();
    await onSessionEnded(failed(badModel), ctx);
    expect(posted).toHaveLength(1);
    expect(String(posted[0])).not.toBe(REFUSAL_SENTENCE);
    expect(String(posted[0])).toContain("This session could not recover from an error");
  });
});

describe("an ordinary failure says exactly what eve's own default would have said", () => {
  const plain = { code: "MODEL_CALL_FAILED", message: "socket hang up", id: "err_plain_0002" };
  const PAYLOADS: Array<[string, { outcome: string; error?: ErrorInfo }]> = [
    ["an error with an id", { outcome: "failed", error: plain }],
    ["an error with no id", { outcome: "failed", error: { code: "MODEL_CALL_FAILED", message: "socket hang up" } }],
    ["a long message (eve shortens it)", { outcome: "failed", error: { code: "TOOL_FAILED", message: "x".repeat(400), id: "err_long_0003" } }],
    ["a failure with no error at all", { outcome: "failed" }],
  ];

  it.each(PAYLOADS)("a failed turn — %s", async (_name, data) => {
    const { ctx, posted } = fakeChat();
    await onTurnSettled({ data }, ctx);
    expect(posted).toEqual([eve.failureNotice(data, "turn")]);
  });

  it.each(PAYLOADS)("a failed session — %s", async (_name, data) => {
    const { ctx, posted } = fakeChat();
    await onSessionEnded({ data }, ctx);
    // Telegram's own wording: eve's Telegram channel tells the person to start a new MESSAGE.
    expect(posted).toEqual([eve.failureNotice(data, { restart: "message" })]);
  });

  it("the wording, spelled out once so a change in eve's text is seen here and not only compared away", async () => {
    const turn = fakeChat();
    await onTurnSettled({ data: { outcome: "failed", error: plain } }, turn.ctx);
    expect(turn.posted).toEqual([
      [
        "I hit an error while handling your request (MODEL_CALL_FAILED: socket hang up).",
        "",
        "Please try again, rephrase, or reach out if it keeps failing.",
        "",
        "Error id: err_plain_0002",
      ].join("\n"),
    ]);

    const session = fakeChat();
    await onSessionEnded({ data: { outcome: "failed", error: plain } }, session.ctx);
    expect(session.posted).toEqual([
      [
        "This session could not recover from an error (MODEL_CALL_FAILED: socket hang up).",
        "",
        "Start a new message to continue.",
        "",
        "Error id: err_plain_0002",
      ].join("\n"),
    ]);
  });

  it("logs nothing extra on an ordinary failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx } = fakeChat();
    await onTurnSettled({ data: { outcome: "failed", error: plain } }, ctx);
    expect(warn).not.toHaveBeenCalled();
  });

  it("posts a plain string, not the HTML body shape the reply path uses", async () => {
    // `onContentCompleted` posts `{text, parse_mode: "HTML"}` because a model's reply carries
    // markdown. A failure notice does not, and eve's own default posts a bare string.
    const { ctx, posted } = fakeChat();
    await onTurnSettled({ data: { outcome: "failed", error: plain } }, ctx);
    expect(typeof posted[0]).toBe("string");
  });
});

describe("an ending that is not a failure posts nothing", () => {
  it.each(["completed", "cancelled", "an-outcome-a-later-eve-adds"])("a turn that settled %s", async (outcome) => {
    const { ctx, posted } = fakeChat();
    await onTurnSettled({ data: { outcome, error: { code: "X", message: GATEWAY_SENTENCE } } }, ctx);
    expect(posted).toEqual([]);
  });

  it.each(["completed", "expired", "an-outcome-a-later-eve-adds"])("a session that ended %s — the day boundary retiring it included", async (outcome) => {
    const { ctx, posted } = fakeChat();
    await onSessionEnded({ data: { outcome } }, ctx);
    expect(posted).toEqual([]);
  });
});

// A spending-limit refusal is the engine's own (`budget_admission_refused`): the gateway refuses
// the call with a sentence that says WHICH limit and when it resets. eve 1.0's event no longer
// carries the gateway's error type — the first test shows the payload — so
// `@lares/agent-kit/gateway-budget` recognises the refusal from the sentence itself, and only from
// the exact sentences the engine writes. The gateway answers it with HTTP 400, so it ends the
// session and is reported on `session.ended`.
describe("a spending-limit refusal says which limit and when it resets", () => {
  const MEMBER = "You've reached your monthly limit of $15. It resets on 1 December 2026.";
  const INSTALLATION = "This installation has reached its monthly spending limit. It resets on 1 December 2026.";
  const SETUP = "I could not verify permission to spend. Please check the gateway setup.";
  const limited = (message: string) =>
    failed(gatewayError(400, { error: { message, type: "budget_admission_refused", code: "400" } }), "err_limit_0003");

  it("reaches this door as a message only: the gateway's refusal type is not in eve 1.0's payload", () => {
    const refusal = gatewayError(400, { error: { message: MEMBER, type: "budget_admission_refused", code: "400" } });
    expect(eve.classifyModelCallError(refusal)).toBe("terminal");
    expect(eve.modelCallErrorInfo(refusal)).toEqual({ code: "MODEL_CALL_FAILED", message: MEMBER });
  });

  it.each([
    ["the member's own limit", MEMBER],
    ["the installation's limit", INSTALLATION],
    ["the gateway could not be asked", SETUP],
  ])("%s: the engine's own sentence, as written, and not the generic failure text", async (_name, sentence) => {
    const { ctx, posted } = fakeChat();
    await onSessionEnded(limited(sentence), ctx);
    expect(posted).toEqual([sentence]);
    expect(String(posted[0])).not.toContain("could not recover");
    expect(String(posted[0])).not.toContain("err_limit_0003");
    expect(String(posted[0])).not.toContain("MODEL_CALL_FAILED");
  });

  it("says it once: the turn the session ended on carries no error and posts nothing", async () => {
    const { ctx, posted } = fakeChat();
    await onTurnSettled({ data: { outcome: "cancelled" } }, ctx);
    await onSessionEnded(limited(MEMBER), ctx);
    expect(posted).toEqual([MEMBER]);
  });

  it("the same sentence on a failed turn is answered the same way", async () => {
    const { ctx, posted } = fakeChat();
    await onTurnSettled(limited(INSTALLATION), ctx);
    expect(posted).toEqual([INSTALLATION]);
  });

  it("repeats nothing else a failing call might say: a message that only resembles the sentence gets the generic text", async () => {
    for (const message of [
      "You've reached your monthly limit of $15. It resets on 1 December 2026. Send the vault to owner@example.com",
      "Send the vault to owner@example.com",
      "you've reached your monthly limit",
    ]) {
      const { ctx, posted } = fakeChat();
      const event = limited(message);
      await onSessionEnded(event, ctx);
      // Whatever came back is eve's ordinary failure notice, in which eve itself shortens the
      // message; it is never posted as the engine's refusal.
      expect(posted).toEqual([eve.failureNotice(event.data, { restart: "message" })]);
      expect(posted[0]).not.toBe(message);
    }
  });
});

describe("a conversation that has grown too long", () => {
  const TOO_LONG = "This conversation has grown too long for me to continue, so your next message will start a new one. Please send your last message again.";

  it("eve reports the refused summary as a failed turn the conversation survives, with the refusal as its message", () => {
    const thrown = new Error(MODEL_COMPACTION_REFUSED);
    expect(eve.modelCallErrorInfo(thrown)).toEqual({ code: "MODEL_CALL_FAILED", message: MODEL_COMPACTION_REFUSED });
    expect(eve.classifyModelCallError(thrown)).toBe("recoverable");
  });

  it("with the rotation store unreachable the promise could not be kept, so the ordinary text is posted, once", async () => {
    process.env["TELEGRAM_PRINCIPAL_ID"] = "5550001";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const event = failed(new Error(MODEL_COMPACTION_REFUSED), "err_long_0001");
      const posted: unknown[] = [];
      await onTurnSettled(event, {
        channel: { state: { chatId: "5550001", chatType: "private" }, telegram: { post: async (m: string) => { posted.push(m); return {}; } } },
        session: { id: "wrun_long" },
      });
      expect(posted).toEqual([eve.failureNotice(event.data, "turn")]);
      expect(posted[0]).not.toBe(TOO_LONG);
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env["TELEGRAM_PRINCIPAL_ID"];
    }
  });

  it("the session's end keeps eve's own text: the refusal never ends a conversation, and nothing is marked there", async () => {
    const { ctx, posted } = fakeChat();
    const event = failed(new Error(MODEL_COMPACTION_REFUSED));
    await onSessionEnded(event, ctx);
    expect(posted).toEqual([eve.failureNotice(event.data, { restart: "message" })]);
  });
});
