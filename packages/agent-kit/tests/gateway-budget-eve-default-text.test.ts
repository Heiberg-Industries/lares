/**
 * Conformance: our reproduction of eve's default failure text must still match the eve that
 * is actually installed.
 *
 * A door that supplies `events["turn.failed"]` REPLACES eve's default handler outright —
 * object spread in `slackChannel`/`telegramChannel`. Getting that wrong in the other direction
 * is costly (see `services/chief-of-staff/tests/telegram-delivery.test.ts`):
 * a `message.completed` override that does not reproduce the default's post leaves every
 * Telegram reply silently undelivered.
 *
 * eve exports neither `defaultEvents` nor the `formatErrorHint`/`extractErrorId` helpers
 * behind them (`#internal/...`, `#public/...` — no deep-path export), so
 * `src/gateway-budget.ts` reproduces the text instead. This test reads the INSTALLED eve's
 * shipped `defaults.js` and asserts every literal we reproduce is still in it. On an eve
 * upgrade that rewords a failure message, this fails loudly here — at test time, in the
 * package that owns the copy — rather than quietly in a Slack thread.
 *
 * eve's bundle is minified, and each sentence is a template literal interpolating the error
 * hint (`...your request${a}.`). Only the parts either side of an interpolation are
 * contiguous in the file, so the assertions below are on those fragments, not whole lines.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { defaultSessionFailedText, defaultTurnFailedText, respondToTurnFailed } from "../src/gateway-budget.js";

const require = createRequire(import.meta.url);

/** The installed eve package root, resolved through Node rather than guessed from a path. */
function eveRoot(): string {
  let dir = path.dirname(require.resolve("eve"));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, "package.json")) && path.basename(dir) === "eve") return dir;
    dir = path.dirname(dir);
  }
  throw new Error("could not locate the installed eve package root from require.resolve('eve')");
}

/** The files eve 1.0 renders a failed turn / session from. Slack has its own; Telegram (and every
 *  other surface) renders through the shared `failureNotice` in `reply.js`, with a per-channel
 *  "restart" noun that Telegram's defaults set to `message`. */
function read(...segments: string[]): string {
  const file = path.join(eveRoot(), "dist", "src", ...segments);
  if (!existsSync(file)) {
    throw new Error(
      `eve moved ${segments.join("/")}. Re-read where eve 1.0 renders failure text; ` +
        "re-check src/gateway-budget.ts's reproduction before deleting this test.",
    );
  }
  return readFileSync(file, "utf8");
}
const defaultsFor = (channel: "slack" | "telegram"): string =>
  channel === "slack" ? read("public", "channels", "slack", "defaults.js") : read("public", "channels", "reply.js");

/**
 * Our own text, rendered with no hint and no error id, reduced to the fragments that are
 * contiguous in eve's source: the opening sentence minus the trailing "." that follows the
 * interpolated hint, plus the advice line whole. Telegram's advice is `Start a new ${restart} to
 * continue.` in eve, so the noun is checked separately below.
 */
function reproducedFragments(dialect: "slack" | "telegram"): string[] {
  const fragments: string[] = [];
  for (const render of [defaultTurnFailedText, defaultSessionFailedText]) {
    const lines = render({}, dialect).split("\n").filter((line) => line.length > 0);
    const [opening, advice] = lines;
    // `...error${hint}.` — the literal before the interpolation ends at the sentence body.
    fragments.push(opening!.replace(/\.$/u, ""));
    fragments.push(dialect === "telegram" && advice!.startsWith("Start a new ") ? "to continue." : advice!);
  }
  return fragments;
}

describe("our reproduction of eve's default failure text still matches the installed eve", () => {
  for (const dialect of ["slack", "telegram"] as const) {
    it(`${dialect}: every sentence we reproduce is present in eve's shipped source`, () => {
      const source = defaultsFor(dialect);
      for (const fragment of reproducedFragments(dialect)) {
        expect(source, `eve's ${dialect} failure text no longer contains: ${fragment}`).toContain(fragment);
      }
    });
  }

  it("telegram's restart noun is 'message', slack's advice says 'thread'", () => {
    expect(read("public", "channels", "telegram", "defaults.js")).toContain("restart:`message`");
    expect(read("public", "channels", "reply.js")).toContain("Start a new ${");
    expect(defaultSessionFailedText({}, "telegram")).toContain("Start a new message to continue.");
    expect(defaultSessionFailedText({}, "slack")).toContain("Start a new thread to continue");
  });

  it("slack italicises the error id in backticks; telegram writes it plain", () => {
    // Slack:  `_Error id: \`${o}\`_`      Telegram:  `Error id: ${o}`
    expect(defaultsFor("slack")).toContain("_Error id: \\`${");
    expect(defaultsFor("telegram")).toContain("`Error id: ${");
  });

  it("the hint's name is the error's code, and slack quotes a hinted error as 'How to fix'", () => {
    // eve: `errorHintOf(e) = { details: { name: e.code }, message: e.message }`.
    expect(read("public", "channels", "reply.js")).toContain("details:{name:e.code}");
    expect(defaultsFor("slack")).toContain("**How to fix**");
  });

  it("failures are keyed on turn.settled and session.ended (the 0.60 failed events are gone)", () => {
    for (const source of [defaultsFor("slack"), read("channel", "surface.js")]) {
      expect(source).toContain("session.ended");
    }
    expect(defaultsFor("slack")).toContain("turn.settled");
    expect(read("channel", "surface.js")).toContain("turn.settled");
  });
});

describe("the installed eve carries the gateway's limit sentence into the failed turn", () => {
  it("puts the message from a refused model call into the event's error message", async () => {
    const file = path.join(eveRoot(), "dist", "src", "harness", "model-call", "errors.js");
    const { extractUpstreamRejectionMessage, extractModelCallErrorDetails } = (await import(file)) as {
      extractUpstreamRejectionMessage(e: unknown): { message: string } | null;
      extractModelCallErrorDetails(e: unknown): Record<string, unknown>;
    };
    const sentence = "You've reached your monthly limit of $15. It resets on 1 December 2026.";
    const body = { error: { type: "budget_admission_refused", code: "budget_admission_refused", message: sentence } };
    const error = Object.assign(new Error("Bad Request"), { name: "AI_APICallError", statusCode: 400, responseBody: JSON.stringify(body), data: body });
    // eve 1.0 (`harness/model-call/failure.js`): the event is `{ code: "MODEL_CALL_FAILED", message }` and the
    // old `details` (including the gateway's type) is not carried to the stream.
    const event = { error: { code: "MODEL_CALL_FAILED", message: extractUpstreamRejectionMessage(error)?.message } };
    expect(extractModelCallErrorDetails(error)["upstreamType"]).toBe("budget_admission_refused");
    expect(event.error.message).toBe(sentence);
    expect(respondToTurnFailed(event, { refusalText: "exhausted", dialect: "slack" })).toEqual({ kind: "budget-refusal", text: sentence });
  });
});
