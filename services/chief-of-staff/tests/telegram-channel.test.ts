import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TELEGRAM_BENDIK = "123456789";

async function freshModule() {
  vi.resetModules();
  return await import("../agent/channels/telegram.js");
}

/** Minimal TelegramMessage stand-in — only the fields the allowlist and content-gate
 *  actually read. `text`/`caption` default to "" per eve's contract (never undefined). */
function message(overrides: Record<string, unknown> = {}) {
  return {
    attachments: [],
    caption: "",
    chat: { id: TELEGRAM_BENDIK, type: "private" },
    from: { id: TELEGRAM_BENDIK, isBot: false, firstName: "Bendik" },
    messageId: "1",
    raw: {},
    text: "hei",
    ...overrides,
  } as never;
}

describe("eve-saga Telegram channel", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eve-saga-telegram-"));
    process.env["TELEGRAM_PRINCIPAL_ID"] = TELEGRAM_BENDIK;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const k of [
      "TELEGRAM_PRINCIPAL_ID",
      "TELEGRAM_BOT_TOKEN_FILE",
      "TELEGRAM_WEBHOOK_SECRET_TOKEN_FILE",
      "TELEGRAM_BOT_USERNAME",
    ]) {
      delete process.env[k];
    }
  });

  describe("credentials are read at request time, never at import", () => {
    it("imports and constructs the channel with no secret files present at all", async () => {
      // The same trap `agent/channels/slack.ts` documents: `eve build` EVALUATES this
      // module to compile the agent, and neither the build nor CI has any secret. A
      // credential read at module scope fails the image build outright.
      process.env["TELEGRAM_BOT_TOKEN_FILE"] = join(dir, "nope-token");
      process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN_FILE"] = join(dir, "nope-secret");

      const mod = await freshModule();

      expect(mod.default).toBeDefined();
    });

    it("resolves the bot token from disk when it is finally called", async () => {
      const tokenPath = join(dir, "bot-token");
      writeFileSync(tokenPath, "123456:test-token\n", "utf8");
      process.env["TELEGRAM_BOT_TOKEN_FILE"] = tokenPath;

      const mod = await freshModule();

      await expect(mod.telegramCredentials.botToken()).resolves.toBe("123456:test-token");
    });

    it("resolves the webhook secret token only when the function is actually called", async () => {
      // Unlike Slack's signingSecret getter, Telegram's type accepts a function directly —
      // this asserts the function really does defer: the file is created AFTER the module
      // is imported, and the read still finds it.
      const secretPath = join(dir, "webhook-secret");
      process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN_FILE"] = secretPath;
      const mod = await freshModule();

      writeFileSync(secretPath, "webhook-secret-value\n", "utf8");

      await expect(mod.telegramCredentials.webhookSecretToken()).resolves.toBe(
        "webhook-secret-value",
      );
    });

    it("names the unreadable path, never the contents, when a secret is missing", async () => {
      process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN_FILE"] = join(dir, "absent");
      const mod = await freshModule();

      await expect(mod.telegramCredentials.webhookSecretToken()).rejects.toThrow(
        /secret file not readable/,
      );
    });

    it("refuses an empty secret file rather than authenticating with an empty string", async () => {
      const secretPath = join(dir, "empty");
      writeFileSync(secretPath, "   \n", "utf8");
      process.env["TELEGRAM_BOT_TOKEN_FILE"] = secretPath;
      const mod = await freshModule();

      await expect(mod.telegramCredentials.botToken()).rejects.toThrow(/secret file is empty/);
    });
  });

  describe("inbound allowlist — fail closed", () => {
    it("admits the configured principal", async () => {
      const { isAllowedTelegramMessage } = await freshModule();
      expect(isAllowedTelegramMessage(message())).toBe(true);
    });

    it("rejects any other Telegram user id", async () => {
      const { isAllowedTelegramMessage } = await freshModule();
      expect(
        isAllowedTelegramMessage(message({ from: { id: "999999", isBot: false } })),
      ).toBe(false);
    });

    it("rejects bots, including ones that carry the allow-listed user id", async () => {
      const { isAllowedTelegramMessage } = await freshModule();
      expect(
        isAllowedTelegramMessage(message({ from: { id: TELEGRAM_BENDIK, isBot: true } })),
      ).toBe(false);
    });

    it("rejects a message with no author at all (e.g. a channel post)", async () => {
      const { isAllowedTelegramMessage } = await freshModule();
      expect(isAllowedTelegramMessage(message({ from: undefined }))).toBe(false);
    });

    it("admits NOBODY when the principal id is unset", async () => {
      // Fail-closed is the whole point: unlike Slack, a Telegram PRIVATE chat passes
      // everything through eve's default dispatch by default — there is no workspace
      // boundary to lean on, so a missing env var admitting everyone would be worse here
      // than the Slack equivalent, not just as bad.
      delete process.env["TELEGRAM_PRINCIPAL_ID"];
      const { isAllowedTelegramMessage } = await freshModule();
      expect(isAllowedTelegramMessage(message())).toBe(false);
    });

    it("admits nobody when the principal id is present but blank", async () => {
      process.env["TELEGRAM_PRINCIPAL_ID"] = "  ";
      const { isAllowedTelegramMessage } = await freshModule();
      expect(isAllowedTelegramMessage(message())).toBe(false);
    });

    it("still gates a private chat — private chats are not a free pass", async () => {
      const { isAllowedTelegramMessage } = await freshModule();
      expect(
        isAllowedTelegramMessage(
          message({ chat: { id: "999999", type: "private" }, from: { id: "999999", isBot: false } }),
        ),
      ).toBe(false);
    });

    it("rejects a group-chat message even from the allowed principal", async () => {
      // Identity alone would pass here — it's still Bendik's user id. The chat-type check
      // is what has to reject it: this shadow bot is private-chat-only, matching the old
      // door's scope, so a group message must never dispatch regardless of who sent it.
      const { isAllowedTelegramMessage } = await freshModule();
      expect(
        isAllowedTelegramMessage(
          message({ chat: { id: "-100123", type: "group" } }),
        ),
      ).toBe(false);
    });
  });

  describe("content gate — matches eve's default for private chats", () => {
    it("admits a text message", async () => {
      const { hasDispatchableContent } = await freshModule();
      expect(hasDispatchableContent(message({ text: "hei" }))).toBe(true);
    });

    it("admits an attachment with no text", async () => {
      const { hasDispatchableContent } = await freshModule();
      expect(
        hasDispatchableContent(
          message({ text: "", attachments: [{ fileId: "f1", kind: "document" }] }),
        ),
      ).toBe(true);
    });

    it("drops a content-free update (e.g. a service message)", async () => {
      const { hasDispatchableContent } = await freshModule();
      expect(hasDispatchableContent(message({ text: "", caption: "", attachments: [] }))).toBe(
        false,
      );
    });
  });

  describe("ORB-74 session rotation wiring", () => {
    describe("buildRotationContext", () => {
      it("returns undefined when nothing is pending", async () => {
        const { buildRotationContext } = await freshModule();
        expect(buildRotationContext(null)).toBeUndefined();
      });

      it("wraps a pending summary in a labeled continuity block", async () => {
        const { buildRotationContext } = await freshModule();
        const ctx = buildRotationContext("decided to ship ORB-73 first");
        expect(ctx).toHaveLength(1);
        expect(ctx![0]).toContain("conversation summary");
        expect(ctx![0]).toContain("decided to ship ORB-73 first");
      });
    });

    describe("shouldTrackForRotation", () => {
      it("admits a terminal reply on the allowed principal's private chat", async () => {
        const { shouldTrackForRotation } = await freshModule();
        expect(shouldTrackForRotation("stop", "private", TELEGRAM_BENDIK)).toBe(true);
      });

      it("rejects interim tool-call narration (finishReason !== stop)", async () => {
        const { shouldTrackForRotation } = await freshModule();
        expect(shouldTrackForRotation("tool-calls", "private", TELEGRAM_BENDIK)).toBe(false);
      });

      it("rejects a group/supergroup chat — those already anchor per-thread", async () => {
        const { shouldTrackForRotation } = await freshModule();
        expect(shouldTrackForRotation("stop", "group", TELEGRAM_BENDIK)).toBe(false);
      });

      it("rejects a null chatId", async () => {
        const { shouldTrackForRotation } = await freshModule();
        expect(shouldTrackForRotation("stop", "private", null)).toBe(false);
      });

      it("rejects a chat that is not the allowed principal", async () => {
        const { shouldTrackForRotation } = await freshModule();
        expect(shouldTrackForRotation("stop", "private", "999999")).toBe(false);
      });

      it("admits nobody when the principal id is unset — fails closed like the message gate", async () => {
        delete process.env["TELEGRAM_PRINCIPAL_ID"];
        const { shouldTrackForRotation } = await freshModule();
        expect(shouldTrackForRotation("stop", "private", TELEGRAM_BENDIK)).toBe(false);
      });
    });
  });
});
