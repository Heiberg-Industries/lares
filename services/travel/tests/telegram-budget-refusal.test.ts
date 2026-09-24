/**
 * LAR-53-s1 — a capped turn says so on Marcel's Telegram door.
 *
 * Copied from eve-saga's `tests/telegram-budget-refusal.test.ts` (`services/chief-of-staff`)
 * and adapted to this door's own exports. One difference that matters: eve words its default
 * failure text differently per channel, but BOTH doors are Telegram here, so the ordinary-
 * failure assertions below pin the SAME wording as the chief-of-staff sibling test — this file
 * exists to prove Marcel's door reproduces it too, not to find a difference.
 *
 * The budget fixture's body is verbatim from the sibling test, which sources it from the live
 * probe transcript named in `docs/runbooks/per-user-spend-caps.md`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { onSessionFailed, onTurnFailed } from "../agent/channels/telegram.js";

const REFUSAL_SENTENCE =
  "I have hit my spending cap — nothing was done. It resets with the next budget period, or you can raise the cap.";

const BUDGET_TURN_FAILED = {
  code: "MODEL_CALL_FAILED",
  message: "Budget has been exceeded! Current cost: 0.0124665, Max budget: 0.01",
  details: {
    errorId: "err_budget_0001",
    name: "Model provider API error",
    apiErrorMessage: "Budget has been exceeded! Current cost: 0.0124665, Max budget: 0.01",
    statusCode: 400,
    upstreamStatusCode: 400,
    upstreamType: "budget_exceeded",
    upstreamMessage: "Budget has been exceeded! Current cost: 0.0124665, Max budget: 0.01",
    responseBodySnippet:
      '{"error":{"message":"Budget has been exceeded! Current cost: 0.0124665, Max budget: 0.01","type":"budget_exceeded","param":null,"code":"400"}}',
  },
  sequence: 3,
  turnId: "turn_3",
};

const ORDINARY_TURN_FAILED = {
  code: "MODEL_CALL_FAILED",
  message: "socket hang up",
  details: { errorId: "err_plain_0002", name: "Model provider API error" },
  sequence: 4,
  turnId: "turn_4",
};

function fakeChat() {
  const posted: unknown[] = [];
  return {
    posted,
    channel: { telegram: { post: async (m: unknown) => { posted.push(m); return {}; } } },
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

describe("Marcel Telegram door — a capped turn answers with one fixed sentence", () => {
  it("posts the fixed sentence, and nothing else, on a gateway budget refusal", async () => {
    const { channel, posted } = fakeChat();
    await onTurnFailed(BUDGET_TURN_FAILED, channel);
    expect(posted).toEqual([REFUSAL_SENTENCE]);
  });

  it("never leaks the gateway's own error text, the cost figures, or an error id", async () => {
    const { channel, posted } = fakeChat();
    await onTurnFailed(BUDGET_TURN_FAILED, channel);
    const text = String(posted[0]);
    expect(text).not.toContain("Budget has been exceeded!");
    expect(text).not.toContain("0.0124665");
    expect(text).not.toContain("err_budget_0001");
    expect(text).not.toContain("I hit an error");
  });

  it("logs exactly one line for the capped turn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { channel } = fakeChat();
    await onTurnFailed(BUDGET_TURN_FAILED, channel);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("gateway budget exceeded");
  });

  it("stays silent on the session.failed that eve emits for the SAME refusal", async () => {
    const { channel, posted } = fakeChat();
    await onTurnFailed(BUDGET_TURN_FAILED, channel);
    await onSessionFailed(BUDGET_TURN_FAILED, channel);
    expect(posted).toEqual([REFUSAL_SENTENCE]);
  });
});

describe("Marcel Telegram door — an ordinary failure keeps today's behaviour, byte for byte", () => {
  it("posts eve 0.32.0's own TELEGRAM turn.failed text (plain error id, not Slack's italics)", async () => {
    const { channel, posted } = fakeChat();
    await onTurnFailed(ORDINARY_TURN_FAILED, channel);
    expect(posted).toEqual([
      [
        "I hit an error while handling your request (Model provider API error: socket hang up).",
        "",
        "Please try again, rephrase, or reach out if it keeps failing.",
        "",
        "Error id: err_plain_0002",
      ].join("\n"),
    ]);
  });

  it("posts eve 0.32.0's own TELEGRAM session.failed text (\"could not\", \"a new message\")", async () => {
    const { channel, posted } = fakeChat();
    await onSessionFailed({ ...ORDINARY_TURN_FAILED, sessionId: "sess_1" }, channel);
    expect(posted).toEqual([
      [
        "This session could not recover from an error (Model provider API error: socket hang up).",
        "",
        "Start a new message to continue.",
        "",
        "Error id: err_plain_0002",
      ].join("\n"),
    ]);
  });

  it("logs nothing extra on an ordinary failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { channel } = fakeChat();
    await onTurnFailed(ORDINARY_TURN_FAILED, channel);
    expect(warn).not.toHaveBeenCalled();
  });

  it("posts a plain string, not the HTML body shape the reply path uses", async () => {
    // `onMessageCompleted` posts `{text, parse_mode: "HTML"}` because a model's reply carries
    // markdown. A failure notice does not, and eve's own default posts a bare string — so the
    // non-budget path stays identical to what the chat saw before this change.
    const { channel, posted } = fakeChat();
    await onTurnFailed(ORDINARY_TURN_FAILED, channel);
    expect(typeof posted[0]).toBe("string");
  });

  it("never retries — one post per event, no second model call, no loop", async () => {
    const { channel, posted } = fakeChat();
    await onTurnFailed(BUDGET_TURN_FAILED, channel);
    expect(posted).toHaveLength(1);
  });
});
