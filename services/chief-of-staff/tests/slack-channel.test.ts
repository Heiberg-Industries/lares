import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { query } = vi.hoisted(() => ({ query: vi.fn(async () => ({ rows: [], rowCount: 1 })) }));
vi.mock("@lares/agent-kit/db", () => ({ getPool: () => ({ query }) }));

async function freshModule() {
  vi.resetModules();
  return await import("../agent/channels/slack.js");
}

/** Minimal SlackMessage stand-in — only the fields the allowlist actually reads. */
function message(overrides: Record<string, unknown> = {}) {
  return {
    channelId: "D0OWNERDM",
    text: "hei",
    author: { userId: "U_EXAMPLE_OWNER", isBot: false },
    raw: { channel_type: "im" },
    ...overrides,
  } as never;
}

describe("chief-of-staff Slack channel", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chief-of-staff-slack-"));
    process.env["SLACK_ALLOWED_USER_IDS"] = "U_EXAMPLE_OWNER";
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const k of [
      "SLACK_ALLOWED_USER_IDS",
      "SLACK_BOT_TOKEN_FILE",
      "SLACK_SIGNING_SECRET_FILE",
    ]) {
      delete process.env[k];
    }
  });

  describe("credentials are read at request time, never at import", () => {
    it("imports and constructs the channel with no secret files present at all", async () => {
      // The trap that breaks an image build: `eve build`
      // EVALUATES this module to compile the agent, and neither the build nor CI has any
      // secret. A credential read at module scope fails the image build outright.
      process.env["SLACK_BOT_TOKEN_FILE"] = join(dir, "nope-token");
      process.env["SLACK_SIGNING_SECRET_FILE"] = join(dir, "nope-secret");

      const mod = await freshModule();

      expect(mod.default).toBeDefined();
    });

    it("resolves the bot token from disk when it is finally called", async () => {
      const tokenPath = join(dir, "bot-token");
      writeFileSync(tokenPath, "xoxb-test-token\n", "utf8");
      process.env["SLACK_BOT_TOKEN_FILE"] = tokenPath;

      const mod = await freshModule();

      await expect(mod.slackCredentials.botToken()).resolves.toBe("xoxb-test-token");
    });

    it("resolves the signing secret only when the property is actually read", async () => {
      // eve reads `credentials.signingSecret` inside verifyInbound — per request — so a
      // getter is safe here. This asserts the getter really does defer: the file is created
      // AFTER the module is imported, and the read still finds it.
      const secretPath = join(dir, "signing-secret");
      process.env["SLACK_SIGNING_SECRET_FILE"] = secretPath;
      const mod = await freshModule();

      writeFileSync(secretPath, "signing-secret-value\n", "utf8");

      expect(mod.slackCredentials.signingSecret).toBe("signing-secret-value");
    });

    it("names the unreadable path, never the contents, when a secret is missing", async () => {
      process.env["SLACK_SIGNING_SECRET_FILE"] = join(dir, "absent");
      const mod = await freshModule();

      expect(() => mod.slackCredentials.signingSecret).toThrow(/secret file not readable/);
    });

    it("refuses an empty secret file rather than authenticating with an empty string", async () => {
      const secretPath = join(dir, "empty");
      writeFileSync(secretPath, "   \n", "utf8");
      process.env["SLACK_SIGNING_SECRET_FILE"] = secretPath;
      const mod = await freshModule();

      expect(() => mod.slackCredentials.signingSecret).toThrow(/secret file is empty/);
    });
  });

  describe("inbound allowlist — fail closed", () => {
    it("admits the configured principal", async () => {
      const { isAllowedSlackUser } = await freshModule();
      expect(isAllowedSlackUser(message())).toBe(true);
    });

    it("rejects any other Slack user", async () => {
      const { isAllowedSlackUser } = await freshModule();
      expect(isAllowedSlackUser(message({ author: { userId: "U0STRANGER", isBot: false } }))).toBe(
        false,
      );
    });

    it("rejects bots, including ones that carry an allow-listed user id", async () => {
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
      // Fail-closed is the whole point: a missing env var must not mean "let everyone in".
      // A valid Slack signature only proves Slack sent the event, not that we trust who
      // wrote it — and this app will live in a workspace reachable by Slack Connect.
      delete process.env["SLACK_ALLOWED_USER_IDS"];
      const { isAllowedSlackUser } = await freshModule();
      expect(isAllowedSlackUser(message())).toBe(false);
    });

    it("admits nobody when the allowlist is present but blank", async () => {
      process.env["SLACK_ALLOWED_USER_IDS"] = "  ,  ";
      const { isAllowedSlackUser } = await freshModule();
      expect(isAllowedSlackUser(message())).toBe(false);
    });
  });

  describe("the scheduled decline question keeps its own reply anchor", () => {
    const declineSession = {
      session: { auth: { current: { attributes: {
        lares_continuity_address: "slack-user:U_EXAMPLE_OWNER",
        lares_route_decline_request_id: "request-1",
      } } } },
    };
    function replyChannel() {
      const posted: string[] = [];
      return {
        posted,
        channel: {
          state: { triggeringUserId: "U_EXAMPLE_OWNER" },
          thread: {
            postDirectMessage: async (userId: string, text: string) => { posted.push(`${userId}:${text}`); return { id: "1700.99" }; },
          },
        },
      };
    }

    it("anchors inbound answers to Slack's native thread root and saves the outbound question root", async () => {
      const mod = await freshModule();
      const inbound = await mod.admitSlackDirectMessage({ slack: { channelId: "D0OWNERDM", threadTs: "1700.01" } } as never,
        message({ ts: "1700.02", threadTs: "1700.01", teamId: "T1" }));
      expect(inbound?.auth?.attributes["lares_route_decline_reply_anchor"]).toBe("slack:1700.01");

      const { channel, posted } = replyChannel();
      const next = vi.fn(async () => {});
      query.mockClear();
      await mod.onSlackContentCompleted(
        { data: { kind: "text", phase: "reply", value: "Question" } },
        { channel, ...declineSession },
        next,
      );
      expect(posted).toEqual(["U_EXAMPLE_OWNER:Question"]);
      expect(next, "the door posted this reply itself; eve must not post it again").not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledWith(expect.stringContaining("question_reply_anchor=$2"), ["request-1", "slack:1700.99"]);
    });

    it.each([
      ["narration before a tool call", { kind: "text", phase: "narration", value: "Looking that up" }],
      ["reasoning", { kind: "reasoning", phase: "reply", value: "thinking" }],
      ["an empty reply", { kind: "text", phase: "reply", value: "" }],
      ["a part of a kind this door does not know", { kind: "file", phase: "reply", value: { name: "a.pdf" } }],
    ])("leaves %s to eve, even in a decline-question conversation", async (_name, data) => {
      const mod = await freshModule();
      const { channel, posted } = replyChannel();
      const next = vi.fn(async () => {});
      await mod.onSlackContentCompleted({ data }, { channel, ...declineSession }, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(posted).toEqual([]);
    });

    it("leaves every reply of an ordinary conversation to eve", async () => {
      const mod = await freshModule();
      const { channel, posted } = replyChannel();
      const next = vi.fn(async () => {});
      await mod.onSlackContentCompleted(
        { data: { kind: "text", phase: "reply", value: "An ordinary answer" } },
        { channel, session: { auth: { current: { attributes: { user_id: "U_EXAMPLE_OWNER" } } } } },
        next,
      );
      await mod.onSlackContentCompleted(
        { data: { kind: "text", phase: "reply", value: "A scheduled post with no signed-in person" } },
        { channel, session: { auth: { current: null } } },
        next,
      );
      expect(next).toHaveBeenCalledTimes(2);
      expect(posted).toEqual([]);
    });

    it("refuses to post a decline question it cannot address, rather than guess a recipient", async () => {
      const mod = await freshModule();
      const { channel, posted } = replyChannel();
      channel.state.triggeringUserId = null as never;
      await expect(mod.onSlackContentCompleted(
        { data: { kind: "text", phase: "reply", value: "Question" } },
        { channel, session: { auth: { current: { attributes: { lares_route_decline_request_id: "request-1" } } } } },
        vi.fn(async () => {}),
      )).rejects.toThrow(/no bound Slack recipient/);
      expect(posted).toEqual([]);
    });
  });

  describe("what the door installs on eve 1.0", () => {
    it("checks every answer with the allowlist, and renders with the approval card and its own handlers", async () => {
      const mod = await freshModule();
      expect(mod.slackDoorConfig.onAnswers).toBe(mod.authorizeSlackAnswer);
      expect(mod.slackDoorConfig.onMessageEdited).toBe(mod.ignoreSlackMessageEdit);
      expect(mod.ignoreSlackMessageEdit()).toBeNull();
      expect(mod.slackDoorConfig.onAppMention).toBeTypeOf("function");
      expect(mod.slackDoorConfig.onDirectMessage).toBeTypeOf("function");

      const renderers = mod.slackDoorConfig.renderers ?? [];
      expect(renderers.filter((r) => r.interactionCard !== undefined), "the approval card renderer").toHaveLength(1);
      const handled = renderers.flatMap((r) => Object.keys(r.events ?? {})).sort();
      expect(handled).toEqual(["content.completed", "session.ended", "turn.settled"]);
    });

    it("eve hears every event name the door handles, and the decline question goes through the door's handler", async () => {
      const mod = await freshModule();
      const { composeSlackRenderers } = await import("../node_modules/eve/dist/src/public/channels/slack/renderers.js");
      const eveDefault = vi.fn(async () => {});
      const chain = composeSlackRenderers(mod.slackDoorConfig.renderers ?? [], {
        events: { "content.completed": eveDefault } as never,
        received: async () => {},
        taskCard: () => null,
      });
      const wired = chain.events as Record<string, ((event: unknown, ctx: unknown) => Promise<void>) | undefined>;
      // eve only wires names it renders; a stale name would be missing here.
      for (const name of ["content.completed", "session.ended", "turn.settled"]) expect(wired[name], name).toBeTypeOf("function");

      const posted: string[] = [];
      const ctx = {
        channel: { state: {}, thread: { postDirectMessage: async (userId: string, text: string) => { posted.push(`${userId}:${text}`); return { id: "1700.99" }; } } },
        session: { auth: { current: { attributes: {
          lares_continuity_address: "slack-user:U_EXAMPLE_OWNER", lares_route_decline_request_id: "request-1" } } } },
      };
      await wired["content.completed"]!({ type: "content.completed", data: { partId: "p1", kind: "text", phase: "reply", value: "Question" } }, ctx);
      expect(posted).toEqual(["U_EXAMPLE_OWNER:Question"]);
      expect(eveDefault).not.toHaveBeenCalled();
    });
  });

  describe("who may answer a card — fail closed, same list as who may start a turn", () => {
    const defaultAuth = { principalId: "slack:T1:someone" } as never;

    it("accepts the configured principal, with the identity eve derived from the tap", async () => {
      const { authorizeSlackAnswer } = await freshModule();
      expect(authorizeSlackAnswer({ defaultAuth }, { user: { id: "U_EXAMPLE_OWNER" } })).toEqual({ auth: defaultAuth });
    });

    it("refuses any other Slack user, and logs one line that names nobody", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { authorizeSlackAnswer } = await freshModule();
      expect(authorizeSlackAnswer({ defaultAuth }, { user: { id: "U0STRANGER" } })).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).not.toContain("U0STRANGER");
      warn.mockRestore();
    });

    it("refuses EVERYBODY when the allowlist is unset or blank", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { authorizeSlackAnswer } = await freshModule();
      delete process.env["SLACK_ALLOWED_USER_IDS"];
      expect(authorizeSlackAnswer({ defaultAuth }, { user: { id: "U_EXAMPLE_OWNER" } })).toBeNull();
      process.env["SLACK_ALLOWED_USER_IDS"] = "  ,  ";
      expect(authorizeSlackAnswer({ defaultAuth }, { user: { id: "U_EXAMPLE_OWNER" } })).toBeNull();
      warn.mockRestore();
    });
  });
});

/**
 * The door as Slack reaches it: a signed request to the real channel's webhook route, with eve's
 * own parsing, verification and dispatch in between. Only the far ends are fakes: the Slack Web
 * API (`fetch`) and the conversation store (`from(address)`).
 */
describe("chief-of-staff Slack door, through its webhook route", () => {
  const OWNER = "U0000000000";
  const STRANGER = "U0000000001";
  const DM = "D0000000000";
  const SECRET = "test-signing-secret";
  const realFetch = globalThis.fetch;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chief-of-staff-slack-route-"));
    writeFileSync(join(dir, "signing-secret"), `${SECRET}\n`, "utf8");
    writeFileSync(join(dir, "bot-token"), "xoxb-test-token\n", "utf8");
    process.env["SLACK_SIGNING_SECRET_FILE"] = join(dir, "signing-secret");
    process.env["SLACK_BOT_TOKEN_FILE"] = join(dir, "bot-token");
    process.env["SLACK_ALLOWED_USER_IDS"] = OWNER;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, ts: "1700000000.000900" }), {
      status: 200, headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
    for (const k of ["SLACK_ALLOWED_USER_IDS", "SLACK_BOT_TOKEN_FILE", "SLACK_SIGNING_SECRET_FILE"]) delete process.env[k];
    vi.restoreAllMocks();
  });

  function signed(body: string, contentType: string, secret = SECRET): Request {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
    return new Request("http://localhost/eve/v1/slack", {
      method: "POST",
      headers: { "content-type": contentType, "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
      body,
    });
  }

  interface Store {
    sent: { address: string; message: unknown; options: Record<string, unknown> }[];
    answered: { address: string; answers: unknown; options: Record<string, unknown> }[];
  }

  /** POST one request to the door and wait for everything it started. */
  type Route = { handler(request: Request, ctx: unknown): Promise<Response> };

  /** POST one request to a channel's route and wait for everything it started. */
  async function deliverTo(route: Route, request: Request, hasSession = false): Promise<Store & { response: Response }> {
    const store: Store = { sent: [], answered: [] };
    const pending: Promise<unknown>[] = [];
    const response = await route.handler(request, {
      from: (address: string) => ({
        send: async (message: unknown, options: Record<string, unknown>) => { store.sent.push({ address, message, options }); return { sessionId: "session-1" }; },
        respond: async (answers: unknown, options: Record<string, unknown>) => { store.answered.push({ address, answers, options }); return {}; },
      }),
      resolveSession: async () => (hasSession ? { id: "session-1" } : undefined),
      waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    });
    await Promise.all(pending);
    return { ...store, response };
  }

  /** POST one request to the door. */
  async function deliver(request: Request, hasSession = false): Promise<Store & { response: Response }> {
    const mod = await freshModule();
    return deliverTo((mod.default as never as { routes: Route[] }).routes[0]!, request, hasSession);
  }

  function tap(userId: string): Request {
    const payload = {
      type: "block_actions",
      team: { id: "T0000000000" },
      user: { id: userId, username: "someone", name: "someone" },
      channel: { id: DM },
      message: { ts: "1700000000.000200", thread_ts: "1700000000.000100", blocks: [] },
      actions: [{
        action_id: "eve_input:tool-approval:interaction-1:button:1", block_id: "b1", type: "button",
        value: "approve", text: { type: "plain_text", text: "Approve" },
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

  function editedDirectMessage(userId: string, text: string): Request {
    return signed(JSON.stringify({
      type: "event_callback",
      team_id: "T0000000000",
      api_app_id: "A0000000000",
      event_id: `Ev${Math.random().toString(36).slice(2)}`,
      event_time: 1700000002,
      authorizations: [{ team_id: "T0000000000", user_id: "U0000000009", is_bot: true }],
      event: {
        type: "message", subtype: "message_changed", channel_type: "im", channel: DM, ts: "1700000002.000100",
        message: { type: "message", user: userId, text, ts: "1700000001.000100", team: "T0000000000", edited: { user: userId, ts: "1700000002.000000" } },
        previous_message: { type: "message", user: userId, text: "send the draft to Tailor", ts: "1700000001.000100" },
      },
    }), "application/json");
  }

  describe("an edit to a message already sent", () => {
    it("starts nothing, even from the owner in a conversation that is still open", async () => {
      const { sent, answered } = await deliver(editedDirectMessage(OWNER, "send the draft to Taylor"), true);
      expect(sent).toEqual([]);
      expect(answered).toEqual([]);
    });

    it("for contrast: a door that says nothing about edits has eve send the same edit on as a new turn", async () => {
      // eve's default, shown so the test above is known to be about this door's decision and not
      // about an event eve never recognised as an edit.
      const { slackChannel } = await import("eve/channels/slack");
      const open = slackChannel({ credentials: { botToken: async () => "xoxb-test", signingSecret: SECRET } });
      const { sent } = await deliverTo((open as never as { routes: Route[] }).routes[0]!, editedDirectMessage(OWNER, "send the draft to Taylor"), true);
      expect(sent).toHaveLength(1);
      expect(String(sent[0]!.message)).toContain("send the draft to Taylor");
    });
  });

  describe("a tap on the owner's card", () => {
    it("from the owner is delivered to the conversation the card belongs to, as the owner", async () => {
      const { answered, response } = await deliver(tap(OWNER));
      expect(response.status).toBe(200);
      expect(answered).toHaveLength(1);
      expect(answered[0]!.address).toBe(`${DM}:1700000000.000100`);
      expect(answered[0]!.answers).toEqual([{ interactionId: "interaction-1", optionId: "approve" }]);
      expect((answered[0]!.options["auth"] as { attributes: { user_id: string } }).attributes.user_id).toBe(OWNER);
    });

    it("from a Slack user who is not allowed is refused: no answer reaches the conversation, so the action does not run", async () => {
      const { answered, sent, response } = await deliver(tap(STRANGER));
      // Slack still gets its 200: a refusal is not an error to the sender of the webhook.
      expect(response.status).toBe(200);
      expect(answered, "the approval was never delivered").toEqual([]);
      expect(sent).toEqual([]);
      // The card is left as it is, buttons and all, for the owner to answer.
      expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    });

    it("is refused for everyone when the allowlist is unset", async () => {
      delete process.env["SLACK_ALLOWED_USER_IDS"];
      const { answered } = await deliver(tap(OWNER));
      expect(answered).toEqual([]);
    });

    it("with a signature made from the wrong secret never reaches the answer check at all", async () => {
      const payload = "payload=" + encodeURIComponent(JSON.stringify({ type: "block_actions" }));
      const { answered, response } = await deliver(signed(payload, "application/x-www-form-urlencoded", "another-secret"));
      expect(response.status).toBe(401);
      expect(answered).toEqual([]);
    });
  });

  /**
   * Typing "approve" must never approve a card. End to end that is the framework patch's job: it
   * turns typed approvals off inside eve for every door, and THAT case is tested there
   * ("depends on the framework patch"). What this door can see, and what is pinned here, is its
   * own half: a typed message is handed to eve as a NEW MESSAGE, never as an answer, and without
   * the typed-answer text eve would otherwise match against an open card.
   */
  describe("typed text approves nothing at this door", () => {
    it("the owner typing \"approve\" is sent on as an ordinary message, not as an answer to the open card", async () => {
      const { sent, answered } = await deliver(directMessage(OWNER, "approve"));
      expect(answered, "the door never turns typed text into an answer").toEqual([]);
      expect(sent).toHaveLength(1);
      expect(String(sent[0]!.message)).toContain("approve");
      // eve attaches the text a typed reply may answer an open card with under this key. The
      // door's `onAnswers` makes eve attach an empty one.
      expect(sent[0]!.options["__eveInputText"]).toBe("");
    });

    it("for contrast: a door with no answer check lets eve attach the typed text as a possible answer", async () => {
      // eve's default, shown so the assertion above is known to be about this door and not about
      // a key that is always empty. If this fails, eve changed how typed answers travel, and the
      // test above needs re-reading.
      const { slackChannel } = await import("eve/channels/slack");
      const open = slackChannel({ credentials: { botToken: async () => "xoxb-test", signingSecret: SECRET } });
      const route = (open as never as { routes: { handler(request: Request, ctx: unknown): Promise<Response> }[] }).routes[0]!;
      const sent: Record<string, unknown>[] = [];
      const pending: Promise<unknown>[] = [];
      await route.handler(directMessage(OWNER, "approve"), {
        from: () => ({ send: async (_message: unknown, options: Record<string, unknown>) => { sent.push(options); return {}; } }),
        resolveSession: async () => undefined,
        waitUntil: (p: Promise<unknown>) => { pending.push(p); },
      });
      await Promise.all(pending);
      expect(sent).toHaveLength(1);
      expect(sent[0]!["__eveInputText"]).toBe("approve");
    });

    it("a stranger typing \"approve\" starts nothing at all", async () => {
      const { sent, answered } = await deliver(directMessage(STRANGER, "approve"));
      expect(sent).toEqual([]);
      expect(answered).toEqual([]);
    });
  });
});
