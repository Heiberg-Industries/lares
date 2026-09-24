/**
 * ORB-188 item 2 — a capped turn says so on Calliope's Slack door.
 *
 * She is the likeliest agent to meet this: `bendik-calliope` carries the fleet's tightest cap
 * ($5/day, ORB-202 — `docs/runbooks/per-user-spend-caps.md`).
 *
 * Two things are pinned, and the second is the one that historically breaks: supplying
 * `events["turn.failed"]` REPLACES eve's default handler, so an ORDINARY failure must still
 * produce the default's exact text.
 *
 * The budget fixture's body is verbatim from the live probe in the spend-caps runbook
 * ("Transcript — run 2026-09-01, against the live gateway", call 6); the eve event wrapper
 * around it is shaped from eve 0.32.0's `dist/src/harness/tool-loop.js`, with a placeholder
 * errorId.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

import { onSessionFailed, onTurnFailed } from "../agent/channels/slack.js";

const REFUSAL_SENTENCE =
  "I have hit my spending cap — nothing was done. It resets with the next budget period, or you can raise the cap.";

const BUDGET_TURN_FAILED = {
  code: "MODEL_CALL_FAILED",
  message: "Budget has been exceeded! Current cost: 5.0124665, Max budget: 5.0",
  details: {
    errorId: "err_budget_0001",
    name: "Model provider API error",
    apiErrorMessage: "Budget has been exceeded! Current cost: 5.0124665, Max budget: 5.0",
    statusCode: 400,
    upstreamStatusCode: 400,
    upstreamType: "budget_exceeded",
    upstreamMessage: "Budget has been exceeded! Current cost: 5.0124665, Max budget: 5.0",
    responseBodySnippet:
      '{"error":{"message":"Budget has been exceeded! Current cost: 5.0124665, Max budget: 5.0","type":"budget_exceeded","param":null,"code":"400"}}',
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

function fakeThread() {
  const posted: unknown[] = [];
  return {
    posted,
    channel: { thread: { post: async (m: unknown) => { posted.push(m); return {}; } } },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Calliope Slack door — a capped turn answers with one fixed sentence", () => {
  it("posts the fixed sentence, and nothing else, on a gateway budget refusal", async () => {
    const { channel, posted } = fakeThread();
    await onTurnFailed(BUDGET_TURN_FAILED, channel);
    expect(posted).toEqual([REFUSAL_SENTENCE]);
  });

  it("never leaks the gateway's own error text, the cost figures, or an error id", async () => {
    const { channel, posted } = fakeThread();
    await onTurnFailed(BUDGET_TURN_FAILED, channel);
    const text = String(posted[0]);
    expect(text).not.toContain("Budget has been exceeded!");
    expect(text).not.toContain("5.0124665");
    expect(text).not.toContain("err_budget_0001");
    expect(text).not.toContain("I hit an error");
  });

  it("logs exactly one line for the capped turn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { channel } = fakeThread();
    await onTurnFailed(BUDGET_TURN_FAILED, channel);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("gateway budget exceeded");
  });

  it("stays silent on the session.failed that eve emits for the SAME refusal", async () => {
    const { channel, posted } = fakeThread();
    await onTurnFailed(BUDGET_TURN_FAILED, channel);
    await onSessionFailed(BUDGET_TURN_FAILED, channel);
    expect(posted).toEqual([REFUSAL_SENTENCE]);
  });
});

describe("Calliope Slack door — an ordinary failure keeps today's behaviour, byte for byte", () => {
  it("posts eve 0.32.0's own turn.failed text", async () => {
    const { channel, posted } = fakeThread();
    await onTurnFailed(ORDINARY_TURN_FAILED, channel);
    expect(posted).toEqual([
      [
        "I hit an error while handling your request (Model provider API error: socket hang up).",
        "",
        "Please try again, rephrase, or reach out if it keeps failing.",
        "",
        "_Error id: `err_plain_0002`_",
      ].join("\n"),
    ]);
  });

  it("posts eve 0.32.0's own session.failed text", async () => {
    const { channel, posted } = fakeThread();
    await onSessionFailed({ ...ORDINARY_TURN_FAILED, sessionId: "sess_1" }, channel);
    expect(posted).toEqual([
      [
        "This session couldn't recover from an error (Model provider API error: socket hang up).",
        "",
        "Start a new thread to continue — I can't pick this one back up.",
        "",
        "_Error id: `err_plain_0002`_",
      ].join("\n"),
    ]);
  });

  it("logs nothing extra on an ordinary failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { channel } = fakeThread();
    await onTurnFailed(ORDINARY_TURN_FAILED, channel);
    expect(warn).not.toHaveBeenCalled();
  });

  it("never retries — one post per event, no second model call, no loop", async () => {
    const { channel, posted } = fakeThread();
    await onTurnFailed(BUDGET_TURN_FAILED, channel);
    expect(posted).toHaveLength(1);
  });
});
