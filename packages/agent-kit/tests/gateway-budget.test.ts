/**
 * The gateway's budget refusal, recognised (ORB-188 item 2).
 *
 * Every 400 fixture below is copied from a LIVE probe, not invented: the transcript in
 * `docs/runbooks/per-user-spend-caps.md` ("Transcript — run 2026-09-01, against the live
 * gateway"), which minted a throwaway key with `max_budget: 0.01`, looped completions, and
 * recorded call 6's refusal verbatim. The 429 fixtures are SHAPED, not live-measured: LiteLLM
 * changed its status between the 2026-09-01 measurement and 2026-09-18, when its own source
 * (`litellm/exceptions.py`, `litellm/proxy/auth/auth_exception_handler.py`) was read and shown
 * to set `status_code = 429` with `type = "budget_exceeded"` intact — same envelope, same
 * markers, different status. `tests/live/litellm-budget-refusal.live.mts` re-measures this by
 * hand; nothing here claims that run has happened.
 *
 * Both directions are covered, because fixing one has historically broken the other:
 *  - the leak — a real refusal that goes unrecognised, and the cap looks like a bug;
 *  - the over-rejection — an ordinary 400 or 429 mistaken for a cap, so the agent claims it
 *    hit its budget about a completely different fault.
 */
import { describe, it, expect } from "vitest";

import {
  GatewayBudgetExceededError,
  LITELLM_BUDGET_EXCEEDED_MESSAGE_PREFIX,
  LITELLM_BUDGET_EXCEEDED_TYPE,
  defaultSessionFailedText,
  defaultTurnFailedText,
  isBudgetExceeded,
  respondToSessionFailed,
  respondToTurnFailed,
} from "../src/gateway-budget.js";

/**
 * VERBATIM — LiteLLM gateway, 2026-09-01, call 6 of the throwaway-key proof
 * (`docs/runbooks/per-user-spend-caps.md`). HTTP 400 with this body.
 */
const LIVE_REFUSAL_BODY = {
  error: {
    message: "Budget has been exceeded! Current cost: 0.0124665, Max budget: 0.01",
    type: "budget_exceeded",
    param: null,
    code: "400",
  },
} as const;

const LIVE_REFUSAL_BODY_TEXT = JSON.stringify(LIVE_REFUSAL_BODY);

/**
 * SHAPED — the same refusal on current LiteLLM, whose source sets HTTP 429 and
 * `"code": "429"` on `BudgetExceededError` (read 2026-09-18; see this file's header). Same
 * message and type as the 400 fixture — only the transport status and the echoed code differ.
 */
const LIVE_REFUSAL_BODY_429 = {
  error: {
    message: "Budget has been exceeded! Current cost: 0.0124665, Max budget: 0.01",
    type: "budget_exceeded",
    param: null,
    code: "429",
  },
} as const;

const LIVE_REFUSAL_BODY_429_TEXT = JSON.stringify(LIVE_REFUSAL_BODY_429);

/**
 * SHAPED — an `AI_APICallError` as `@ai-sdk/anthropic` builds one around the 400 above. The
 * body is verbatim; the wrapper's field names (`statusCode`, `responseBody`, `data`, `url`,
 * `isRetryable`) are the AI SDK's own, and the url is a placeholder.
 */
function aiSdkApiCallError(body: unknown = LIVE_REFUSAL_BODY, statusCode = 400): Error {
  const err = new Error(JSON.stringify(body)) as Error & Record<string, unknown>;
  err.name = "AI_APICallError";
  err["statusCode"] = statusCode;
  err["responseBody"] = JSON.stringify(body);
  err["data"] = body;
  err["url"] = "https://gateway.example.com/v1/messages";
  err["isRetryable"] = false;
  return err;
}

/**
 * SHAPED — eve 0.32.0's `turn.failed` event data for the refusal above, built the way
 * `dist/src/harness/tool-loop.js` builds it: `message` from
 * `extractUpstreamRejectionMessage` (i.e. the gateway's own sentence), `details` from
 * `extractModelCallErrorDetails` + `buildModelCallFailureDetails`. Field names and the
 * `MODEL_CALL_FAILED` code are read from that build; the errorId is a placeholder.
 */
const EVE_TURN_FAILED_BUDGET = {
  code: "MODEL_CALL_FAILED",
  message: "Budget has been exceeded! Current cost: 0.0124665, Max budget: 0.01",
  details: {
    errorId: "err_0000000000",
    name: "Model provider API error",
    message: "Budget has been exceeded! Current cost: 0.0124665, Max budget: 0.01",
    apiErrorMessage: "Budget has been exceeded! Current cost: 0.0124665, Max budget: 0.01",
    statusCode: 400,
    upstreamStatusCode: 400,
    upstreamType: "budget_exceeded",
    upstreamMessage: "Budget has been exceeded! Current cost: 0.0124665, Max budget: 0.01",
    responseBodySnippet: LIVE_REFUSAL_BODY_TEXT,
  },
  sequence: 1,
  turnId: "turn_1",
};

/**
 * VERBATIM — the same runbook transcript's post-delete call, HTTP 401. An ordinary gateway
 * rejection that is emphatically not a budget refusal.
 */
const LIVE_AUTH_ERROR_BODY = {
  error: {
    message:
      "Authentication Error, Invalid proxy server token passed. Received API Key = sk-...<redacted>, " +
      "Key Hash (Token) =375d9133…, Unable to find token in cache or `LiteLLM_VerificationTokenTable`",
    type: "token_not_found_in_db",
    param: "key",
    code: "401",
  },
} as const;

/**
 * SHAPED — an ordinary LiteLLM 400. Same envelope as the refusal, different `type`. This is
 * the over-rejection guard: everything about it looks like the refusal except the marker.
 */
const ORDINARY_400_BODY = {
  error: {
    message: "litellm.BadRequestError: LLM Provider NOT provided. Model=gpt-nonexistent",
    type: "invalid_request_error",
    param: null,
    code: "400",
  },
} as const;

/**
 * SHAPED — an ordinary LiteLLM 429: a plain rate limit, no budget marker at all. This is the
 * over-rejection guard for the new status: the Vercel AI SDK retries 429s by default (see
 * this file's header), so once 429 is an accepted status a ordinary rate limit must still be
 * told apart from a capped key by the marker, not the status.
 */
const ORDINARY_429_RATE_LIMIT_BODY = {
  error: {
    message: "litellm.RateLimitError: You exceeded your current requests per minute quota.",
    type: "rate_limit_exceeded",
    param: null,
    code: "429",
  },
} as const;

describe("isBudgetExceeded — the leak direction (a real refusal must be recognised)", () => {
  it("recognises the raw 400 body, verbatim from the 2026-09-01 live probe", () => {
    expect(isBudgetExceeded(LIVE_REFUSAL_BODY)).toBe(true);
  });

  it("recognises the same body as JSON text (a responseBody nobody parsed)", () => {
    expect(isBudgetExceeded(LIVE_REFUSAL_BODY_TEXT)).toBe(true);
  });

  it("recognises the AI SDK's AI_APICallError wrapper (status 400 + the body)", () => {
    expect(isBudgetExceeded(aiSdkApiCallError())).toBe(true);
  });

  it("recognises the raw 429 body — current LiteLLM (see this file's header)", () => {
    expect(isBudgetExceeded(LIVE_REFUSAL_BODY_429)).toBe(true);
  });

  it("recognises the 429 body as JSON text", () => {
    expect(isBudgetExceeded(LIVE_REFUSAL_BODY_429_TEXT)).toBe(true);
  });

  it("recognises the AI SDK's AI_APICallError wrapper on a 429 refusal, code \"429\" included", () => {
    expect(isBudgetExceeded(aiSdkApiCallError(LIVE_REFUSAL_BODY_429, 429))).toBe(true);
  });

  it("recognises it through a cause chain, the way eve rewraps a model-stream error", () => {
    const wrapped = new Error("model call failed", { cause: aiSdkApiCallError() });
    expect(isBudgetExceeded(wrapped)).toBe(true);
  });

  it("recognises eve's turn.failed event data — the only shape a door actually sees", () => {
    expect(isBudgetExceeded(EVE_TURN_FAILED_BUDGET)).toBe(true);
  });

  it("recognises it from the type alone, if LiteLLM ever rewords the sentence", () => {
    expect(
      isBudgetExceeded({ error: { message: "You are out of money.", type: LITELLM_BUDGET_EXCEEDED_TYPE, code: "400" } }),
    ).toBe(true);
  });

  it("recognises it from the sentence alone, if LiteLLM ever renames the type", () => {
    expect(
      isBudgetExceeded({
        error: { message: `${LITELLM_BUDGET_EXCEEDED_MESSAGE_PREFIX} Current cost: 9, Max budget: 1`, type: "spend_error", code: "400" },
      }),
    ).toBe(true);
  });

  it("recognises the typed error a caller raised itself", () => {
    expect(isBudgetExceeded(new GatewayBudgetExceededError())).toBe(true);
    expect(isBudgetExceeded(new Error("wrapped", { cause: new GatewayBudgetExceededError() }))).toBe(true);
  });
});

describe("GatewayBudgetExceededError — statusCode stays fixed at 400 for eve; observedStatus carries the real value", () => {
  it("statusCode is always 400, even when the real refusal was a 429", () => {
    const err = new GatewayBudgetExceededError(undefined, { observedStatus: 429 });
    expect(err.statusCode).toBe(400);
    expect(err.observedStatus).toBe(429);
  });

  it("observedStatus defaults to 400 when not told otherwise", () => {
    const err = new GatewayBudgetExceededError();
    expect(err.statusCode).toBe(400);
    expect(err.observedStatus).toBe(400);
  });
});

describe("isBudgetExceeded — the over-rejection direction (nothing else may claim the cap)", () => {
  it("an ordinary 400 with the same envelope is NOT a budget refusal", () => {
    expect(isBudgetExceeded(ORDINARY_400_BODY)).toBe(false);
    expect(isBudgetExceeded(aiSdkApiCallError(ORDINARY_400_BODY))).toBe(false);
  });

  it("a plain 429 rate limit with no budget marker is NOT a budget refusal", () => {
    // Accepting 429 as a status must not turn every rate limit into a claimed budget cap —
    // the marker is still required, exactly as for 400.
    expect(isBudgetExceeded(ORDINARY_429_RATE_LIMIT_BODY)).toBe(false);
    expect(isBudgetExceeded(aiSdkApiCallError(ORDINARY_429_RATE_LIMIT_BODY, 429))).toBe(false);
  });

  it("the live 401 auth error from the same transcript is NOT a budget refusal", () => {
    expect(isBudgetExceeded(LIVE_AUTH_ERROR_BODY)).toBe(false);
  });

  it("a plain error, a string, null and undefined are not budget refusals", () => {
    expect(isBudgetExceeded(new Error("socket hang up"))).toBe(false);
    expect(isBudgetExceeded("Bad Request")).toBe(false);
    expect(isBudgetExceeded(null)).toBe(false);
    expect(isBudgetExceeded(undefined)).toBe(false);
  });

  it("a 500 that echoes the marker back is NOT the gateway refusing", () => {
    // The measured refusals are 400 and 429. A visible status outside that set disqualifies,
    // so an upstream mirroring the text into a server error cannot make an agent claim it is
    // capped.
    expect(isBudgetExceeded(aiSdkApiCallError(LIVE_REFUSAL_BODY, 500))).toBe(false);
    expect(isBudgetExceeded(aiSdkApiCallError(LIVE_REFUSAL_BODY_429, 500))).toBe(false);
  });

  it("prose merely mentioning the words is not a marker (types are read as fields)", () => {
    expect(
      isBudgetExceeded({
        error: { message: "Ask the operator about budget_exceeded handling.", type: "invalid_request_error", code: "400" },
      }),
    ).toBe(false);
  });

  it("eve's turn.failed for an ordinary model failure is not a budget refusal", () => {
    expect(
      isBudgetExceeded({
        code: "MODEL_CALL_FAILED",
        message: "Model provider API request failed (HTTP 400).",
        details: { errorId: "err_1", name: "Model provider API error", statusCode: 400, upstreamType: "invalid_request_error" },
      }),
    ).toBe(false);
  });

  it("does not loop on a self-referencing cause chain", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b", { cause: a }) as Error & { cause?: unknown };
    a.cause = b;
    expect(isBudgetExceeded(a)).toBe(false);
  });
});

describe("respondToTurnFailed / respondToSessionFailed", () => {
  const options = { refusalText: "FIXED SENTENCE", dialect: "slack" } as const;

  it("a capped turn answers with the door's fixed sentence and nothing else", () => {
    expect(respondToTurnFailed(EVE_TURN_FAILED_BUDGET, options)).toEqual({
      kind: "budget-refusal",
      text: "FIXED SENTENCE",
    });
  });

  it("the session.failed that follows the same refusal stays silent — one sentence per turn", () => {
    // eve classifies a non-transient 4xx as terminal, so a budget refusal emits turn.failed
    // AND session.failed for one fault. Speaking twice would be a second claim.
    expect(
      respondToSessionFailed({ ...EVE_TURN_FAILED_BUDGET, message: EVE_TURN_FAILED_BUDGET.message }, options),
    ).toEqual({ kind: "silent" });
  });

  it("an ordinary failure keeps eve's own default text, unchanged", () => {
    const data = { code: "MODEL_CALL_FAILED", message: "socket hang up", details: { errorId: "err_9", name: "Model provider API error" } };
    expect(respondToTurnFailed(data, options)).toEqual({
      kind: "default",
      text: defaultTurnFailedText(data, "slack"),
    });
    expect(respondToSessionFailed(data, options)).toEqual({
      kind: "default",
      text: defaultSessionFailedText(data, "slack"),
    });
  });
});

describe("defaultTurnFailedText / defaultSessionFailedText — eve 0.32.0's own wording", () => {
  const data = {
    code: "MODEL_CALL_FAILED",
    message: "socket hang up",
    details: { errorId: "err_abc", name: "Model provider API error" },
  };

  it("reproduces Slack's turn.failed text, error id italicised in backticks", () => {
    expect(defaultTurnFailedText(data, "slack")).toBe(
      [
        "I hit an error while handling your request (Model provider API error: socket hang up).",
        "",
        "Please try again, rephrase, or reach out if it keeps failing.",
        "",
        "_Error id: `err_abc`_",
      ].join("\n"),
    );
  });

  it("reproduces Telegram's turn.failed text, error id plain", () => {
    expect(defaultTurnFailedText(data, "telegram")).toBe(
      [
        "I hit an error while handling your request (Model provider API error: socket hang up).",
        "",
        "Please try again, rephrase, or reach out if it keeps failing.",
        "",
        "Error id: err_abc",
      ].join("\n"),
    );
  });

  it("reproduces Slack's session.failed text (\"couldn't\", \"a new thread\")", () => {
    expect(defaultSessionFailedText(data, "slack")).toBe(
      [
        "This session couldn't recover from an error (Model provider API error: socket hang up).",
        "",
        "Start a new thread to continue — I can't pick this one back up.",
        "",
        "_Error id: `err_abc`_",
      ].join("\n"),
    );
  });

  it("reproduces Telegram's session.failed text (\"could not\", \"a new message\")", () => {
    expect(defaultSessionFailedText(data, "telegram")).toBe(
      [
        "This session could not recover from an error (Model provider API error: socket hang up).",
        "",
        "Start a new message to continue.",
        "",
        "Error id: err_abc",
      ].join("\n"),
    );
  });

  it("omits the error id block when there is none, and the hint when there is nothing to hint", () => {
    expect(defaultTurnFailedText({}, "slack")).toBe(
      ["I hit an error while handling your request.", "", "Please try again, rephrase, or reach out if it keeps failing."].join("\n"),
    );
  });

  it("hints with the name alone when the message is empty", () => {
    expect(defaultTurnFailedText({ message: "   ", details: { name: "GatewayInternalServerError" } }, "slack")).toBe(
      [
        "I hit an error while handling your request (GatewayInternalServerError).",
        "",
        "Please try again, rephrase, or reach out if it keeps failing.",
      ].join("\n"),
    );
  });

  it("truncates a long message at 160 chars with an ellipsis, as eve does", () => {
    const long = "x".repeat(400);
    const text = defaultTurnFailedText({ message: long }, "slack");
    expect(text.startsWith(`I hit an error while handling your request (${"x".repeat(159)}…).`)).toBe(true);
  });
});
