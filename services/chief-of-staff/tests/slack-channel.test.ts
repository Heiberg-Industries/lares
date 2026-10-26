import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

  it("anchors inbound answers to Slack's native thread root and saves the outbound question root", async () => {
    const mod = await freshModule();
    const inbound = await mod.admitSlackDirectMessage({ slack: { channelId: "D0OWNERDM", threadTs: "1700.01" } } as never,
      message({ ts: "1700.02", threadTs: "1700.01", teamId: "T1" }));
    expect(inbound?.auth.attributes.lares_route_decline_reply_anchor).toBe("slack:1700.01");

    const state = { pendingToolCallMessage: null as string | null, triggeringUserId: "U_EXAMPLE_OWNER" };
    const posted: string[] = [];
    const channel = {
      state,
      thread: {
        post: async () => ({ id: "ordinary" }),
        postDirectMessage: async (userId: string, text: string) => { posted.push(`${userId}:${text}`); return { id: "1700.99" }; },
        startTyping: async () => undefined,
      },
      slack: { threadTs: "", uploadFiles: async () => undefined },
    };
    await mod.onSlackMessageCompleted({ finishReason: "stop", message: "Question" }, channel, {
      session: { auth: { current: { attributes: { lares_continuity_address: "slack-user:U_EXAMPLE_OWNER",
        lares_route_decline_request_id: "request-1" } } } },
    } as never);
    expect(posted).toEqual(["U_EXAMPLE_OWNER:Question"]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("question_reply_anchor=$2"), ["request-1", "slack:1700.99"]);
  });
});
