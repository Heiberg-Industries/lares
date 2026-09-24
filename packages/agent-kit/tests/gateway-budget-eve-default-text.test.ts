/**
 * Conformance: our reproduction of eve's default failure text must still match the eve that
 * is actually installed.
 *
 * A door that supplies `events["turn.failed"]` REPLACES eve's default handler outright —
 * object spread in `slackChannel`/`telegramChannel`. The 2026-08-17 outage is the cost of
 * getting that wrong in the other direction (`services/chief-of-staff/tests/telegram-delivery.test.ts`):
 * a `message.completed` override shipped without reproducing the default's post, and every
 * Telegram reply was silently undelivered for days.
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

import { defaultSessionFailedText, defaultTurnFailedText } from "../src/gateway-budget.js";

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

function readDefaults(channel: "slack" | "telegram"): string {
  const file = path.join(eveRoot(), "dist", "src", "public", "channels", channel, "defaults.js");
  if (!existsSync(file)) {
    throw new Error(
      `eve's ${channel} defaults are no longer at ${file}. eve moved its channel defaults; ` +
        "re-read them and re-check src/gateway-budget.ts's reproduction before deleting this test.",
    );
  }
  return readFileSync(file, "utf8");
}

/**
 * Our own text, rendered with no hint and no error id, reduced to the fragments that are
 * contiguous in eve's source: the opening sentence minus the trailing "." that follows the
 * interpolated hint, plus the advice line whole.
 */
function reproducedFragments(dialect: "slack" | "telegram"): string[] {
  const fragments: string[] = [];
  for (const render of [defaultTurnFailedText, defaultSessionFailedText]) {
    const lines = render({}, dialect).split("\n").filter((line) => line.length > 0);
    const [opening, advice] = lines;
    // `...error${hint}.` — the literal before the interpolation ends at the sentence body.
    fragments.push(opening!.replace(/\.$/u, ""));
    fragments.push(advice!);
  }
  return fragments;
}

describe("our reproduction of eve's default failure text still matches the installed eve", () => {
  for (const dialect of ["slack", "telegram"] as const) {
    it(`${dialect}: every sentence we reproduce is present in eve's shipped defaults.js`, () => {
      const source = readDefaults(dialect);
      for (const fragment of reproducedFragments(dialect)) {
        expect(source, `eve's ${dialect} defaults no longer contain: ${fragment}`).toContain(fragment);
      }
    });
  }

  it("slack italicises the error id in backticks; telegram writes it plain", () => {
    // Slack:  `_Error id: \`${o}\`_`      Telegram:  `Error id: ${o}`
    expect(readDefaults("slack")).toContain("_Error id: \\`${");
    expect(readDefaults("telegram")).toContain("[``,`Error id: ${");
  });

  it("both dialects still key the same two failure events", () => {
    for (const dialect of ["slack", "telegram"] as const) {
      expect(readDefaults(dialect)).toContain('"turn.failed"');
      expect(readDefaults(dialect)).toContain('"session.failed"');
    }
  });
});
