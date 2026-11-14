import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The Bot API, at the one seam every Telegram call goes through: the proxied fetch. Only the
// button-tap block at the end of this file makes any call.
const bot = vi.hoisted(() => ({ calls: [] as Array<{ method: string; body: Record<string, unknown> }> }));
vi.mock("@lares/agent-kit/telegram-fetch", () => ({
  telegramFetch: async (url: string | URL, init?: { body?: string }) => {
    bot.calls.push({ method: String(url).split("/").pop()!, body: JSON.parse(init?.body ?? "{}") as Record<string, unknown> });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 77, chat: { id: 123456789, type: "private" } } }), { status: 200 });
  },
}));
// A proposal's own store, so a tap can be resolved without a database.
const proposals = vi.hoisted(() => ({ resolved: [] as Array<{ lane: string; id: number; action: string }>, open: true }));
vi.mock("../lib/proposals-store.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveProposal: async (_pool: unknown, id: number, action: string) => {
    if (!proposals.open) throw new Error("no open proposal");
    proposals.resolved.push({ lane: "notion", id, action });
  },
  resolveAtlasProposal: async (_pool: unknown, id: number, action: string) => {
    if (!proposals.open) throw new Error("no open proposal");
    proposals.resolved.push({ lane: "atlas", id, action });
  },
}));
vi.mock("@lares/agent-kit/db", () => ({ getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }) }));

const TELEGRAM_OWNER = "123456789";

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
    chat: { id: TELEGRAM_OWNER, type: "private" },
    from: { id: TELEGRAM_OWNER, isBot: false, firstName: "Test Owner" },
    messageId: "1",
    raw: {},
    text: "hei",
    ...overrides,
  } as never;
}

describe("chief-of-staff Telegram channel", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chief-of-staff-telegram-"));
    process.env["TELEGRAM_PRINCIPAL_ID"] = TELEGRAM_OWNER;
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
        isAllowedTelegramMessage(message({ from: { id: TELEGRAM_OWNER, isBot: true } })),
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
      // Identity alone would pass here — it's still the owner's user id. The chat-type check
      // is what has to reject it: this door is private-chat-only, so a group message must never dispatch regardless of who sent it.
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

  describe(" session rotation wiring", () => {
    describe("buildRotationContext", () => {
      it("returns undefined when nothing is pending", async () => {
        const { buildRotationContext } = await freshModule();
        expect(buildRotationContext(null)).toBeUndefined();
      });

      it("wraps a pending summary in a labeled continuity block", async () => {
        const { buildRotationContext } = await freshModule();
        const ctx = buildRotationContext("decided to ship item-73 first");
        expect(ctx).toHaveLength(1);
        expect(ctx![0]).toContain("conversation summary");
        expect(ctx![0]).toContain("decided to ship item-73 first");
      });
    });

    describe("shouldTrackForRotation", () => {
      it("admits the turn's reply on the allowed principal's private chat", async () => {
        const { shouldTrackForRotation } = await freshModule();
        expect(shouldTrackForRotation("reply", "private", TELEGRAM_OWNER)).toBe(true);
      });

      it("rejects narration before a tool call, and any phase it does not know", async () => {
        const { shouldTrackForRotation } = await freshModule();
        expect(shouldTrackForRotation("narration", "private", TELEGRAM_OWNER)).toBe(false);
        expect(shouldTrackForRotation("a-phase-a-later-eve-adds", "private", TELEGRAM_OWNER)).toBe(false);
      });

      it("rejects a group/supergroup chat — those already anchor per-thread", async () => {
        const { shouldTrackForRotation } = await freshModule();
        expect(shouldTrackForRotation("reply", "group", TELEGRAM_OWNER)).toBe(false);
      });

      it("rejects a null chatId", async () => {
        const { shouldTrackForRotation } = await freshModule();
        expect(shouldTrackForRotation("reply", "private", null)).toBe(false);
      });

      it("rejects a chat that is not the allowed principal", async () => {
        const { shouldTrackForRotation } = await freshModule();
        expect(shouldTrackForRotation("reply", "private", "999999")).toBe(false);
      });

      it("admits nobody when the principal id is unset — fails closed like the message gate", async () => {
        delete process.env["TELEGRAM_PRINCIPAL_ID"];
        const { shouldTrackForRotation } = await freshModule();
        expect(shouldTrackForRotation("reply", "private", TELEGRAM_OWNER)).toBe(false);
      });
    });
  });
});

// ── A tap on one of our own proposal buttons ─────────────────────────────────────────────
//
// eve hands every tap that is not on one of its own buttons to the door's `onCallbackQuery`,
// with a handle bound to the chat the button sits in. eve 1.0 removed the free-standing Bot API
// helpers this used to call, so every call below goes through that handle — and so through the
// channel's own credentials and the proxied fetch.
describe("a tap on a proposal button, through the real door", () => {
  const SECRET = "hook-secret";
  let dir: string;

  beforeEach(() => {
    bot.calls.length = 0;
    proposals.resolved.length = 0;
    proposals.open = true;
    dir = mkdtempSync(join(tmpdir(), "chief-of-staff-telegram-tap-"));
    writeFileSync(join(dir, "token"), "1:abc\n");
    writeFileSync(join(dir, "secret"), `${SECRET}\n`);
    process.env["TELEGRAM_PRINCIPAL_ID"] = TELEGRAM_OWNER;
    process.env["TELEGRAM_BOT_TOKEN_FILE"] = join(dir, "token");
    process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN_FILE"] = join(dir, "secret");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const k of ["TELEGRAM_PRINCIPAL_ID", "TELEGRAM_BOT_TOKEN_FILE", "TELEGRAM_WEBHOOK_SECRET_TOKEN_FILE"]) delete process.env[k];
  });

  const tap = (fromId: string, data: string) =>
    JSON.stringify({
      update_id: 1,
      callback_query: {
        id: "cb1",
        from: { id: Number(fromId), is_bot: false, first_name: "X" },
        message: { message_id: 61, date: 1, chat: { id: Number(TELEGRAM_OWNER), type: "private" }, text: "Proposal" },
        chat_instance: "ci",
        data,
      },
    });

  async function post(body: string) {
    const door = (await freshModule()).default as unknown as {
      routes: Array<{ method: string; handler: (request: Request, ctx: unknown) => Promise<Response> }>;
    };
    const pending: Promise<unknown>[] = [];
    const responded: unknown[] = [];
    const res = await door.routes.find((r) => r.method === "POST")!.handler(
      new Request("http://x/inner", { method: "POST", headers: { "x-telegram-bot-api-secret-token": SECRET, "content-type": "application/json" }, body }),
      {
        from: () => ({ respond: async (...a: unknown[]) => { responded.push(a); }, send: async (...a: unknown[]) => { responded.push(a); } }),
        resolveSession: async () => undefined,
        waitUntil: (p: Promise<unknown>) => pending.push(p),
        attachSession: undefined,
      },
    );
    await Promise.all(pending);
    return { res, responded };
  }

  it("the owner's Approve resolves the proposal, answers the tap, strips the buttons and confirms in the chat", async () => {
    const { res, responded } = await post(tap(TELEGRAM_OWNER, "np:a:61"));

    expect(res.status).toBe(200);
    expect(proposals.resolved).toEqual([{ lane: "notion", id: 61, action: "approve" }]);
    expect(bot.calls.map((c) => c.method)).toEqual(["answerCallbackQuery", "editMessageReplyMarkup", "sendMessage"]);
    expect(bot.calls[0]!.body).toEqual({ callback_query_id: "cb1", text: "✅ Approved." });
    // The announcement the button sat on, in the chat it sat in, with no keyboard given: Telegram
    // removes the buttons.
    expect(bot.calls[1]!.body).toEqual({ chat_id: TELEGRAM_OWNER, message_id: 61 });
    expect(bot.calls[2]!.body).toMatchObject({ chat_id: TELEGRAM_OWNER, text: "✅ Approved: Notion proposal #61." });
    // A proposal button is not an answer to eve: nothing is resumed.
    expect(responded).toEqual([]);
  });

  it("an Atlas proposal goes to its own store", async () => {
    await post(tap(TELEGRAM_OWNER, "ap:r:7"));
    expect(proposals.resolved).toEqual([{ lane: "atlas", id: 7, action: "reject" }]);
  });

  it("a stranger's tap resolves nothing and is told so", async () => {
    await post(tap("999000111", "np:a:61"));
    expect(proposals.resolved).toEqual([]);
    expect(bot.calls).toEqual([{ method: "answerCallbackQuery", body: { callback_query_id: "cb1", text: "Not allowed." } }]);
  });

  it("a proposal that is no longer open is answered, and its message is left alone", async () => {
    proposals.open = false;
    await post(tap(TELEGRAM_OWNER, "np:a:61"));
    expect(bot.calls).toEqual([{ method: "answerCallbackQuery", body: { callback_query_id: "cb1", text: "Notion proposal #61 was already resolved." } }]);
  });

  it("a tap nobody claims is acknowledged honestly", async () => {
    // The front door refuses callback data it does not recognise before it gets here; this is
    // what the channel itself does with one all the same.
    await post(tap(TELEGRAM_OWNER, "veto:1"));
    expect(proposals.resolved).toEqual([]);
    expect(bot.calls).toEqual([{ method: "answerCallbackQuery", body: { callback_query_id: "cb1", text: "Unsupported action." } }]);
  });
});
