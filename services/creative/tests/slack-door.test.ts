/**
 * The creative role's Slack door — the credential-laziness contract and the fail-closed allowlist.
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
 * needs the agent's container answering, so it belongs to a live deploy check.
 *
 * The second half of the file is the door on eve 1.0: who may answer a card, what the door
 * installs, the approval card, and the door reached through its real webhook route.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
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
    channelId: "D0OWNERDM",
    text: "give me outlier ideas for Another Product",
    author: { userId: "U_EXAMPLE_OWNER", isBot: false },
    raw: { channel_type: "im" },
    ...overrides,
  } as never;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "creative-slack-"));
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

describe("the default secret paths use neutral names", () => {
  // The defaults apply only when the keeper has not set the *_FILE variables. They carry no
  // agent or installation name.
  //
  // Asserted BEHAVIOURALLY, through the error each reader actually throws, rather than by
  // grepping this module's source text. Neither `/run/secrets/...` path exists on a dev machine
  // or in CI, so unsetting the env vars reaches the fallback and the failure names it.
  beforeEach(() => {
    delete process.env["SLACK_BOT_TOKEN_FILE"];
    delete process.env["SLACK_SIGNING_SECRET_FILE"];
  });

  it("falls back to the neutral bot token path", async () => {
    const mod = await freshModule();
    await expect(mod.slackCredentials.botToken()).rejects.toThrow(
      "secret file not readable: /run/secrets/eve-slack-bot-token",
    );
  });

  it("falls back to the neutral signing secret path", async () => {
    const mod = await freshModule();
    expect(() => mod.slackCredentials.signingSecret).toThrow(
      "secret file not readable: /run/secrets/eve-slack-signing-secret",
    );
  });

  it("uses the neutral file name in both default paths", async () => {
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
    expect(tokenError?.message).toContain("/run/secrets/eve-slack-bot-token");

    expect(() => mod.slackCredentials.signingSecret).toThrow();
    try {
      void mod.slackCredentials.signingSecret;
    } catch (e) {
      expect((e as Error).message).toContain("/run/secrets/eve-slack-signing-secret");
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
    // The id here is deliberately arbitrary and NOT the owner's. A version of this test that
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

describe("who may answer a card — the owner only, Approve and Deny alike, fail closed", () => {
  const defaultAuth = { principalId: "slack:T1:someone" } as never;
  const MANAGED = ["LARES_AGENT_NAME", "LARES_AGENT_INCARNATION", "LARES_SLACK_PRINCIPAL"];

  beforeEach(() => {
    // Two trusted people may talk to the agent. The first is the owner.
    process.env["SLACK_ALLOWED_USER_IDS"] = "U_EXAMPLE_OWNER, U_EXAMPLE_SECOND";
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    for (const k of MANAGED) delete process.env[k];
    vi.restoreAllMocks();
  });

  it("the owner is the first id on the list", async () => {
    const { slackOwnerUserId } = await freshModule();
    expect(slackOwnerUserId()).toBe("U_EXAMPLE_OWNER");
  });

  it("accepts the owner, with the identity eve derived from the tap", async () => {
    const { authorizeSlackAnswer } = await freshModule();
    expect(authorizeSlackAnswer({ defaultAuth }, { user: { id: "U_EXAMPLE_OWNER" } })).toEqual({ auth: defaultAuth });
  });

  it("refuses a second trusted member: allowed to start a turn, not allowed to answer a card", async () => {
    const { authorizeSlackAnswer, isAllowedSlackUser } = await freshModule();
    expect(isAllowedSlackUser(message({ author: { userId: "U_EXAMPLE_SECOND", isBot: false } }))).toBe(true);
    expect(authorizeSlackAnswer({ defaultAuth }, { user: { id: "U_EXAMPLE_SECOND" } })).toBeNull();
  });

  it("refuses any other Slack user, and logs one line that names nobody", async () => {
    const { authorizeSlackAnswer } = await freshModule();
    expect(authorizeSlackAnswer({ defaultAuth }, { user: { id: "U0STRANGER" } })).toBeNull();
    const warn = vi.mocked(console.warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).not.toContain("U0STRANGER");
    expect(String(warn.mock.calls[0]![0])).not.toContain("U_EXAMPLE_OWNER");
  });

  it("refuses EVERYBODY when there is no owner id: the list unset, or blank", async () => {
    const { authorizeSlackAnswer, slackOwnerUserId } = await freshModule();
    delete process.env["SLACK_ALLOWED_USER_IDS"];
    expect(slackOwnerUserId()).toBeUndefined();
    expect(authorizeSlackAnswer({ defaultAuth }, { user: { id: "U_EXAMPLE_OWNER" } })).toBeNull();
    process.env["SLACK_ALLOWED_USER_IDS"] = "  ,  ";
    expect(slackOwnerUserId()).toBeUndefined();
    expect(authorizeSlackAnswer({ defaultAuth }, { user: { id: "U_EXAMPLE_OWNER" } })).toBeNull();
    // An empty id never matches an empty owner.
    expect(authorizeSlackAnswer({ defaultAuth }, { user: { id: "" } })).toBeNull();
  });

  it("refuses an answer that names nobody, without throwing", async () => {
    const { authorizeSlackAnswer } = await freshModule();
    expect(authorizeSlackAnswer({ defaultAuth }, {})).toBeNull();
    expect(authorizeSlackAnswer({ defaultAuth }, { user: {} })).toBeNull();
    expect(authorizeSlackAnswer({ defaultAuth }, undefined as never)).toBeNull();
  });

  it("refuses everybody when the owner id cannot be read", async () => {
    const { slackOwnerUserId } = await freshModule();
    const unreadable = new Proxy({}, { get() { throw new Error("environment not readable"); } }) as NodeJS.ProcessEnv;
    expect(slackOwnerUserId(unreadable)).toBeUndefined();
  });

  it("on a managed agent the owner is the door's claimed principal, not the old list", async () => {
    process.env["LARES_AGENT_NAME"] = "example-agent";
    process.env["LARES_AGENT_INCARNATION"] = "00000000-0000-4000-8000-000000000000";
    process.env["LARES_SLACK_PRINCIPAL"] = "U_EXAMPLE_CLAIMED";
    const { authorizeSlackAnswer, slackOwnerUserId } = await freshModule();
    expect(slackOwnerUserId()).toBe("U_EXAMPLE_CLAIMED");
    expect(authorizeSlackAnswer({ defaultAuth }, { user: { id: "U_EXAMPLE_CLAIMED" } })).toEqual({ auth: defaultAuth });
    expect(authorizeSlackAnswer({ defaultAuth }, { user: { id: "U_EXAMPLE_OWNER" } })).toBeNull();
    // A managed agent whose door nobody has claimed yet has no owner: refuse.
    delete process.env["LARES_SLACK_PRINCIPAL"];
    expect(slackOwnerUserId()).toBeUndefined();
    expect(authorizeSlackAnswer({ defaultAuth }, { user: { id: "U_EXAMPLE_OWNER" } })).toBeNull();
  });
});

describe("what the door installs on eve 1.0", () => {
  it("checks every answer with the allowlist, and renders with the approval card and its own handlers", async () => {
    const mod = await freshModule();
    expect(mod.slackDoorConfig.onAnswers).toBe(mod.authorizeSlackAnswer);
    // An edit to a message already sent starts nothing: the door heard mentions and direct
    // messages only before the upgrade (the chief of staff's door test drives a real edit).
    expect(mod.slackDoorConfig.onMessageEdited).toBe(mod.ignoreSlackMessageEdit);
    expect(mod.ignoreSlackMessageEdit()).toBeNull();
    expect(mod.slackDoorConfig.onAppMention).toBeTypeOf("function");
    expect(mod.slackDoorConfig.onDirectMessage).toBeTypeOf("function");

    const renderers = mod.slackDoorConfig.renderers ?? [];
    expect(renderers.filter((r) => r.interactionCard !== undefined), "the approval card renderer").toHaveLength(1);
    const handled = renderers.flatMap((r) => Object.keys(r.events ?? {})).sort();
    expect(handled).toEqual(["session.ended", "turn.settled"]);
  });

  // eve's own way of running a door's card renderers, an INTERNAL reached by file path: it
  // renders its default card, runs the chain around it, and throws the result away in favour of
  // its default if the result breaks eve's rules for a card. The chief of staff's
  // `tests/approval-card-tool-input.test.ts` covers the card in full; this is the check that
  // THIS door's copy of the renderer is installed and that eve accepts what it returns.
  it("an email approval shows subject and body with Deny and Approve, no raw JSON, and keeps them after the answer", async () => {
    const mod = await freshModule();
    const { renderRequestCard } = await import("../node_modules/eve/dist/src/public/channels/slack/request-card-render.js");
    const { composeInteractionCards } = await import("../node_modules/eve/dist/src/public/channels/slack/renderers.js");
    const chain = composeInteractionCards(mod.slackDoorConfig.renderers ?? []);
    const interaction = {
      interactionId: "interaction-1", turnId: "turn-1", stepIndex: 0, status: "open",
      call: { callId: "call-1", name: "gmail_send", input: { to: ["taylor@example.com"], subject: "Draft for review", bodyText: "Here is the draft." } },
      request: { kind: "approval", prompt: "Send email to taylor@example.com", options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }] },
    };
    const card = (over: object) => ({ interaction: { ...interaction, ...over }, destination: "thread", audience: "private", view: {} }) as never;

    const open = renderRequestCard(chain, card({}), undefined);
    const openText = JSON.stringify(open.parts);
    expect(openText).not.toBe(JSON.stringify(open.fallback));
    expect(openText).toContain("*Subject:* Draft for review");
    expect(openText).toContain("Here is the draft.");
    expect(openText).not.toContain("Tool input");
    expect(openText).not.toContain("bodyText");
    expect(open.parts.details).toBeUndefined();
    const buttons = (open.parts.controls.blocks[0] as { actions: { text: { text: string } }[] }).actions.map((a) => a.text.text);
    expect(buttons).toEqual(["Deny", "Approve"]);

    const answered = renderRequestCard(chain, card({
      status: "settled", outcome: "accepted", answer: { interactionId: "interaction-1", optionId: "approve" },
    }), undefined);
    const answeredText = JSON.stringify(answered.parts);
    expect(answeredText).toContain("*Subject:* Draft for review");
    expect(answeredText).toContain("Here is the draft.");
    expect(answeredText).not.toContain("eve_input:");
  });

  it("a tool without a Lares summary keeps eve's own card", async () => {
    const mod = await freshModule();
    const { renderRequestCard } = await import("../node_modules/eve/dist/src/public/channels/slack/request-card-render.js");
    const { composeInteractionCards } = await import("../node_modules/eve/dist/src/public/channels/slack/renderers.js");
    const rendered = renderRequestCard(composeInteractionCards(mod.slackDoorConfig.renderers ?? []), {
      interaction: {
        interactionId: "interaction-1", turnId: "turn-1", stepIndex: 0, status: "open",
        call: { callId: "call-1", name: "some_tool_nobody_summarised", input: { target: "x" } },
        request: { kind: "approval", prompt: "Approve tool call", options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }] },
      },
      destination: "thread", audience: "private", view: {},
    } as never, undefined);
    expect(rendered.parts).toEqual(rendered.fallback);
    expect(JSON.stringify(rendered.parts.details)).toContain("Tool input");
  });
});

/**
 * The door as Slack reaches it: a signed request to the real channel's webhook route, with eve's
 * own parsing, verification and dispatch in between. Only the far ends are fakes: the Slack Web
 * API (`fetch`) and the conversation store (`from(address)`).
 */
describe("the creative Slack door, through its webhook route", () => {
  const OWNER = "U0000000000";
  const STRANGER = "U0000000001";
  /** A second trusted person: on the list, so may talk to the agent, but not the owner. */
  const SECOND = "U0000000002";
  const DM = "D0000000000";
  const SECRET = "test-signing-secret";
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    writeFileSync(join(dir, "signing-secret"), `${SECRET}\n`, "utf8");
    writeFileSync(join(dir, "bot-token"), "xoxb-test-token\n", "utf8");
    process.env["SLACK_SIGNING_SECRET_FILE"] = join(dir, "signing-secret");
    process.env["SLACK_BOT_TOKEN_FILE"] = join(dir, "bot-token");
    process.env["SLACK_ALLOWED_USER_IDS"] = `${OWNER},${SECOND}`;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, ts: "1700000000.000900" }), {
      status: 200, headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  function signed(body: string, contentType: string): Request {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = "v0=" + createHmac("sha256", SECRET).update(`v0:${timestamp}:${body}`).digest("hex");
    return new Request("http://localhost/eve/v1/slack", {
      method: "POST",
      headers: { "content-type": contentType, "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
      body,
    });
  }

  async function deliver(request: Request) {
    const mod = await freshModule();
    const route = (mod.default as never as { routes: { handler(request: Request, ctx: unknown): Promise<Response> }[] }).routes[0]!;
    const sent: { message: unknown; options: Record<string, unknown> }[] = [];
    const answered: { address: string; answers: unknown; userId?: unknown }[] = [];
    const pending: Promise<unknown>[] = [];
    const response = await route.handler(request, {
      from: (address: string) => ({
        send: async (message: unknown, options: Record<string, unknown>) => { sent.push({ message, options }); return { sessionId: "session-1" }; },
        respond: async (answers: unknown, options: { auth?: { attributes?: { user_id?: unknown } } }) => {
          answered.push({ address, answers, userId: options.auth?.attributes?.user_id });
          return {};
        },
      }),
      resolveSession: async () => undefined,
      waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    });
    await Promise.all(pending);
    return { sent, answered, response };
  }

  /** A tap on Approve (the default) or Deny, on a card in the thread `threadTs`. */
  function tap(userId: string | null, answer: "approve" | "deny" = "approve", threadTs = "1700000000.000100"): Request {
    const payload = {
      type: "block_actions",
      team: { id: "T0000000000" },
      // `null`: a payload with no `user` object at all.
      ...(userId === null ? {} : { user: { id: userId, username: "someone", name: "someone" } }),
      channel: { id: DM },
      message: { ts: "1700000000.000200", thread_ts: threadTs, blocks: [] },
      actions: [{
        action_id: `eve_input:tool-approval:interaction-1:button:${answer === "approve" ? 1 : 0}`, block_id: "b1", type: "button",
        value: answer, text: { type: "plain_text", text: answer === "approve" ? "Approve" : "Deny" },
      }],
    };
    return signed("payload=" + encodeURIComponent(JSON.stringify(payload)), "application/x-www-form-urlencoded");
  }

  function directMessage(userId: string, text: string): Request {
    return signed(JSON.stringify({
      type: "event_callback",
      team_id: "T0000000000",
      api_app_id: "A0000000000",
      event_id: `Ev${Math.random().toString(36).slice(2)}`,
      event_time: 1700000001,
      authorizations: [{ team_id: "T0000000000", user_id: "U0000000009", is_bot: true }],
      event: { type: "message", channel_type: "im", channel: DM, user: userId, text, ts: "1700000001.000100", team: "T0000000000" },
    }), "application/json");
  }

  it.each(["approve", "deny"] as const)("the owner's %s is delivered to the conversation the card belongs to, as the owner", async (answer) => {
    const { answered } = await deliver(tap(OWNER, answer));
    expect(answered).toEqual([{
      address: `${DM}:1700000000.000100`,
      answers: [{ interactionId: "interaction-1", optionId: answer }],
      userId: OWNER,
    }]);
  });

  // The binding rule: only the owner decides. The second member is trusted enough to talk to the
  // agent, and still may not answer a card. Deny matters as much as Approve, and more in one
  // way: the tools' own check runs only when an approved call executes, so nothing else would
  // ever stop somebody else's Deny.
  it.each(["approve", "deny"] as const)("a second trusted member's %s is refused and the card stays pending", async (answer) => {
    const { answered, sent, response } = await deliver(tap(SECOND, answer));
    expect(response.status).toBe(200);
    expect(answered, "no answer reaches the conversation, so the request is still open").toEqual([]);
    expect(sent).toEqual([]);
    // The card itself is not touched: no repaint, no notice. Its buttons are still there.
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("the second member can still talk to the agent: the answer rule is narrower than the message rule", async () => {
    const { sent, answered } = await deliver(directMessage(SECOND, "give me three ideas"));
    expect(sent).toHaveLength(1);
    expect(answered).toEqual([]);
  });

  // A payload Slack would not send, but the route must not fall open on. eve's own parsing gives
  // such a tap a user with an empty id; the door's check refuses it.
  it.each(["approve", "deny"] as const)("a %s with no user on the payload is refused, and the route still answers 200", async (answer) => {
    const { answered, sent, response } = await deliver(tap(null, answer));
    expect(response.status).toBe(200);
    expect(answered).toEqual([]);
    expect(sent).toEqual([]);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("every tap is refused when there is no owner id", async () => {
    delete process.env["SLACK_ALLOWED_USER_IDS"];
    for (const answer of ["approve", "deny"] as const) {
      const { answered } = await deliver(tap(OWNER, answer));
      expect(answered).toEqual([]);
    }
  });

  /**
   * A card raised by a SCHEDULED job. This role has no schedule that posts to Slack today; the
   * door is the same code, so the rule is pinned here as well, for the day one is added. The
   * conversation is started with the app's own identity, so no person asked for the action, and
   * whatever eve's own rule about answers then says, it is not "the owner". The door's check runs
   * first and is the one that has to refuse.
   */
  it("a card raised by a scheduled job can be answered only by the owner", async () => {
    const POSTED_TS = "1700000000.000900"; // the ts the fake Slack gives the job's first post
    const mod = await freshModule();
    const door = mod.default as never as {
      receive(input: unknown, ctx: unknown): Promise<unknown>;
      adapter: { createAdapterContext(input: unknown): { thread: { post(m: { text: string }): Promise<unknown> } } };
    };

    // 1. The schedule starts the conversation as the app, at the owner's direct-message channel.
    const appAuth = { authenticator: "app", principalId: "eve:app", principalType: "runtime", attributes: { lane: "example" } };
    const started: { address: string; state: Record<string, unknown>; auth: unknown }[] = [];
    await door.receive({ message: "PROMPT", target: { channelId: DM }, auth: appAuth }, {
      from: (address: string) => ({
        send: async (_m: unknown, options: { state: Record<string, unknown>; auth: unknown }) => {
          started.push({ address, state: options.state, auth: options.auth });
          return { sessionId: "session-1" };
        },
      }),
    });
    expect(started).toHaveLength(1);
    expect(started[0]!.auth, "no person is behind this conversation").toEqual(appAuth);
    expect(started[0]!.state["triggeringUserId"]).toBeNull();

    // 2. Its first post files the conversation under channel and thread.
    const filed: string[] = [];
    await door.adapter.createAdapterContext({
      state: started[0]!.state,
      session: { id: "session-1", auth: { current: appAuth, initiator: appAuth } },
      ctx: {},
      continuation: { token: started[0]!.address, alias: (token: string) => filed.push(token) },
    }).thread.post({ text: "Approve this?" });
    expect(filed).toEqual([`${DM}:${POSTED_TS}`]);
    vi.mocked(globalThis.fetch).mockClear();

    // 3. Anyone but the owner: refused, for Approve and for Deny, and the card is not touched.
    for (const who of [SECOND, STRANGER]) {
      for (const answer of ["approve", "deny"] as const) {
        const refused = await deliver(tap(who, answer, POSTED_TS));
        expect(refused.answered, `${answer} from someone other than the owner`).toEqual([]);
      }
    }
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();

    // 4. The owner: delivered to that conversation, as the owner.
    const accepted = await deliver(tap(OWNER, "approve", POSTED_TS));
    expect(accepted.answered).toEqual([{
      address: filed[0],
      answers: [{ interactionId: "interaction-1", optionId: "approve" }],
      userId: OWNER,
    }]);
  });

  it("a tap from a Slack user who is not allowed is refused: no answer reaches the conversation, so the action does not run", async () => {
    const { answered, sent, response } = await deliver(tap(STRANGER));
    expect(response.status).toBe(200);
    expect(answered).toEqual([]);
    expect(sent).toEqual([]);
    expect(vi.mocked(globalThis.fetch), "the card is left as it is for the owner").not.toHaveBeenCalled();
  });

  // Typing "approve" must never approve a card. End to end that depends on the framework patch,
  // which turns typed approvals off inside eve for every door and is tested there. This is the
  // door's own half: typed text goes in as a new message, never as an answer, and without the
  // typed-answer text eve would otherwise match against an open card.
  it("the owner typing \"approve\" is sent on as an ordinary message, not as an answer to an open card", async () => {
    const { sent, answered } = await deliver(directMessage(OWNER, "approve"));
    expect(answered).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(String(sent[0]!.message)).toContain("approve");
    expect(sent[0]!.options["__eveInputText"]).toBe("");
  });

  it("a stranger typing \"approve\" starts nothing at all", async () => {
    const { sent, answered } = await deliver(directMessage(STRANGER, "approve"));
    expect(sent).toEqual([]);
    expect(answered).toEqual([]);
  });
});
