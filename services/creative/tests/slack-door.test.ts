/**
 * Calliope's Slack door — the credential-laziness contract and the fail-closed allowlist.
 *
 * WHAT THIS FILE ACTUALLY EXISTS TO CATCH. `agent/channels/slack.ts` exposes `signingSecret`
 * as a **getter**, not a plain property, so eve reads it inside `verifyInbound` — per request,
 * off the build path. Flattening that getter into an eagerly-evaluated property is a one-line
 * "simplification" that looks harmless, typechecks, and breaks the IMAGE BUILD: `eve build`
 * evaluates this module to compile the agent, and a build (like CI) has no secrets at all.
 * The first test below is the regression guard for exactly that, and it is written so it goes
 * RED if the getter is flattened — the secret files do not exist when the module is imported.
 *
 * The other half is the inbound allowlist. A valid Slack signature proves only that SLACK
 * sent the event, not that the author is trusted, so `isAllowedSlackUser` is an explicit list
 * that admits nobody when unset or blank.
 *
 * NOT tested here, deliberately: a 401 from the live relay URL for an unsigned POST. That
 * needs her container answering, so it is a Task 7 deliverable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freshModule() {
  vi.resetModules();
  return await import("../agent/channels/slack.js");
}

/** Minimal SlackMessage stand-in — only the fields the allowlist actually reads. */
function message(overrides: Record<string, unknown> = {}) {
  return {
    channelId: "D0BENDIKDM",
    text: "give me outlier ideas for Murmur",
    author: { userId: "U_EXAMPLE_OWNER", isBot: false },
    raw: { channel_type: "im" },
    ...overrides,
  } as never;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eve-calliope-slack-"));
  process.env["SLACK_ALLOWED_USER_IDS"] = "U_EXAMPLE_OWNER";
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of ["SLACK_ALLOWED_USER_IDS", "SLACK_BOT_TOKEN_FILE", "SLACK_SIGNING_SECRET_FILE"]) {
    delete process.env[k];
  }
});

describe("credentials are read lazily, never at import", () => {
  it("imports and constructs the channel with NO secret files present at all", async () => {
    // This is what `eve build` does. Both env vars point at files that do not exist, so a
    // module-scope read — or a `signingSecret` flattened from a getter into a property —
    // throws here and this goes red.
    process.env["SLACK_BOT_TOKEN_FILE"] = join(dir, "missing-bot");
    process.env["SLACK_SIGNING_SECRET_FILE"] = join(dir, "missing-sig");

    const mod = await freshModule();

    expect(mod.default).toBeDefined();
  });

  it("still throws when the missing signing secret is finally READ — nothing cached a value at import", async () => {
    // The companion half of the test above. Together they pin the behaviour to "deferred",
    // not merely "swallowed": import is silent, the read is loud.
    process.env["SLACK_SIGNING_SECRET_FILE"] = join(dir, "missing-sig");
    const mod = await freshModule();

    expect(() => mod.slackCredentials.signingSecret).toThrow(/secret file not readable/);
  });

  it("resolves the signing secret only when the property is read — a file created AFTER import is still found", async () => {
    // The sharpest statement of the getter contract: if the value were captured at import,
    // this read could not possibly see a file that did not exist then.
    const secretPath = join(dir, "signing-secret");
    process.env["SLACK_SIGNING_SECRET_FILE"] = secretPath;
    const mod = await freshModule();

    writeFileSync(secretPath, "signing-secret-value\n", "utf8");

    expect(mod.slackCredentials.signingSecret).toBe("signing-secret-value");
  });

  it("resolves the bot token from disk when it is finally called", async () => {
    const tokenPath = join(dir, "bot-token");
    writeFileSync(tokenPath, "xoxb-test-token\n", "utf8");
    process.env["SLACK_BOT_TOKEN_FILE"] = tokenPath;

    const mod = await freshModule();

    await expect(mod.slackCredentials.botToken()).resolves.toBe("xoxb-test-token");
  });

  it("names the unreadable PATH and never the contents", async () => {
    process.env["SLACK_BOT_TOKEN_FILE"] = join(dir, "nope");
    const mod = await freshModule();

    await expect(mod.slackCredentials.botToken()).rejects.toThrow(/nope/);
    await expect(mod.slackCredentials.botToken()).rejects.toThrow(/secret file not readable/);
  });

  it("refuses an EMPTY secret file rather than authenticating with an empty string", async () => {
    // Whitespace-only counts as empty: the reader trims. An empty bot token would otherwise
    // be handed to Slack as a credential, and an empty signing secret would verify nothing.
    const tokenPath = join(dir, "empty-bot");
    writeFileSync(tokenPath, "   \n", "utf8");
    process.env["SLACK_BOT_TOKEN_FILE"] = tokenPath;

    const mod = await freshModule();

    await expect(mod.slackCredentials.botToken()).rejects.toThrow(/secret file is empty/);
  });
});

describe("the default secret paths are HER EXISTING box secret names", () => {
  // Not cosmetic. `/etc/agent-box/calliope-slack-bot-token` (2026-06-23) and
  // `calliope-slack-signing-secret` (2026-08-23) are already provisioned under those exact
  // names. Renaming them here to invented `eve-calliope-*` paths would orphan both files and
  // fail her container at boot with a bare "secret file not readable" — the expensive end of
  // the feedback loop.
  //
  // Asserted BEHAVIOURALLY, through the error each reader actually throws, rather than by
  // grepping this module's source text: a source-text assertion passes on a stale comment and
  // fails on a harmless reformat, which is exactly backwards. Neither `/run/secrets/...` path
  // exists on a dev machine or in CI, so unsetting the env vars reaches the fallback and the
  // failure names it. That is the one code path no other test here exercises.
  beforeEach(() => {
    delete process.env["SLACK_BOT_TOKEN_FILE"];
    delete process.env["SLACK_SIGNING_SECRET_FILE"];
  });

  it("falls back to the reused June bot token, not a newly-invented path", async () => {
    const mod = await freshModule();
    await expect(mod.slackCredentials.botToken()).rejects.toThrow(
      "secret file not readable: /run/secrets/calliope-slack-bot-token",
    );
  });

  it("falls back to the newly provisioned signing secret", async () => {
    const mod = await freshModule();
    expect(() => mod.slackCredentials.signingSecret).toThrow(
      "secret file not readable: /run/secrets/calliope-slack-signing-secret",
    );
  });

  it("invents no eve-calliope-* secret name on either reader", async () => {
    // Asserted on the caught message rather than via `toThrow(expect.not.stringContaining())`:
    // a NEGATED asymmetric matcher inside toThrow does not actually constrain the message, so
    // that spelling passes no matter what the path is. Verified — it stayed green under a
    // deliberate rename. This spelling goes red.
    const mod = await freshModule();

    const tokenError = await mod.slackCredentials.botToken().then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(tokenError?.message).toBeDefined();
    expect(tokenError?.message).not.toContain("eve-calliope");

    expect(() => mod.slackCredentials.signingSecret).toThrow();
    try {
      void mod.slackCredentials.signingSecret;
    } catch (e) {
      expect((e as Error).message).not.toContain("eve-calliope");
    }
  });
});

describe("the inbound allowlist fails closed", () => {
  it("admits exactly the configured principal", async () => {
    const { isAllowedSlackUser } = await freshModule();
    expect(isAllowedSlackUser(message())).toBe(true);
  });

  it("rejects any other Slack user", async () => {
    const { isAllowedSlackUser } = await freshModule();
    expect(isAllowedSlackUser(message({ author: { userId: "U0STRANGER", isBot: false } }))).toBe(
      false,
    );
  });

  it("rejects bots, including one carrying an allow-listed user id", async () => {
    const { isAllowedSlackUser } = await freshModule();
    expect(isAllowedSlackUser(message({ author: { userId: "U_EXAMPLE_OWNER", isBot: true } }))).toBe(
      false,
    );
  });

  it("rejects a message with no author at all", async () => {
    const { isAllowedSlackUser } = await freshModule();
    expect(isAllowedSlackUser(message({ author: undefined }))).toBe(false);
  });

  it("admits NOBODY when the allowlist is unset", async () => {
    delete process.env["SLACK_ALLOWED_USER_IDS"];
    const { isAllowedSlackUser } = await freshModule();
    expect(isAllowedSlackUser(message())).toBe(false);
  });

  it("admits nobody when the allowlist is present but blank", async () => {
    process.env["SLACK_ALLOWED_USER_IDS"] = "  ,  ";
    const { isAllowedSlackUser } = await freshModule();
    expect(isAllowedSlackUser(message())).toBe(false);
  });

  it("reads the SAME list the approval re-check reads — asserted THROUGH the door", async () => {
    // lib/slack-allowlist.ts re-exports lib/principals.ts, which lib/approvals.ts also reads:
    // one list, two enforcement points (who may START a turn, who may APPROVE one).
    //
    // The id here is deliberately arbitrary and NOT Bendik's. A version of this test that
    // only called `isAllowedSlackUserId` directly would never touch the door at all, and so
    // would stay green if `agent/channels/slack.ts` grew its own private allowlist — the
    // exact drift the test claims to catch. Going through `isAllowedSlackUser` with an id no
    // hardcoded list could plausibly contain is what makes it load-bearing.
    process.env["SLACK_ALLOWED_USER_IDS"] = "U0PARITYCHECK";
    const { isAllowedSlackUser } = await freshModule();
    const { isAllowedSlackUserId } = await import("../lib/principals.js");

    for (const id of ["U0PARITYCHECK", "U_EXAMPLE_OWNER", "U0STRANGER"]) {
      expect(
        isAllowedSlackUser(message({ author: { userId: id, isBot: false } })),
        `door and principals disagree about ${id}`,
      ).toBe(isAllowedSlackUserId(id));
    }
    // ...and pin which way round that agreement falls, so "both always false" cannot pass.
    expect(isAllowedSlackUser(message({ author: { userId: "U0PARITYCHECK", isBot: false } }))).toBe(true);
    expect(isAllowedSlackUser(message({ author: { userId: "U_EXAMPLE_OWNER", isBot: false } }))).toBe(false);
  });
});
