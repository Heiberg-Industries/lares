import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gatekeeper } from "../lib/gatekeeper.js";

const ADMIN_ID = "123456789";
const OTHER_ID = "999999999";

async function freshModule() {
  vi.resetModules();
  return await import("../agent/channels/telegram.js");
}

/** Minimal TelegramMessage stand-in — only the fields the gates actually read. `text` /
 *  `caption` default to "" per eve's contract (never undefined). */
function message(overrides: Record<string, unknown> = {}) {
  return {
    attachments: [],
    caption: "",
    chat: { id: "123", type: "private" },
    from: { id: ADMIN_ID, isBot: false, firstName: "Bendik" },
    messageId: "1",
    raw: {},
    text: "hei",
    ...overrides,
  } as never;
}

function groupMessage(overrides: Record<string, unknown> = {}) {
  return message({
    chat: { id: "-100123", type: "group", title: "Family Trip" },
    from: { id: OTHER_ID, isBot: false, firstName: "Mor" },
    ...overrides,
  });
}

function fakeCtx(botUsername = "marcel_bot") {
  return {
    telegram: {
      botUsername,
      chatId: "",
      chatType: undefined,
      conversationId: undefined,
      messageThreadId: undefined,
      startTyping: vi.fn(async () => {}),
      request: vi.fn(async () => ({ ok: true, status: 200, body: {} })),
      post: vi.fn(async () => ({ id: "1", raw: {} })),
      sendMessage: vi.fn(async () => ({ id: "1", raw: {} })),
      answerCallbackQuery: vi.fn(async () => ({ ok: true, status: 200, body: {} })),
      editMessageReplyMarkup: vi.fn(async () => ({ ok: true, status: 200, body: {} })),
    },
  } as never;
}

describe("eve-marcel Telegram channel", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eve-marcel-telegram-"));
    process.env["MARCEL_ADMIN_TELEGRAM_ID"] = ADMIN_ID;
    process.env["MARCEL_BUDGET_FILE"] = join(dir, "budget.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const k of [
      "MARCEL_ADMIN_TELEGRAM_ID",
      "TELEGRAM_BOT_TOKEN_FILE",
      "TELEGRAM_WEBHOOK_SECRET_TOKEN_FILE",
      "TELEGRAM_BOT_USERNAME",
      "MARCEL_BUDGET_FILE",
      "MARCEL_MODEL_GATE",
    ]) {
      delete process.env[k];
    }
  });

  describe("credentials are read at request time, never at import", () => {
    it("imports and constructs the channel with no secret files present at all", async () => {
      // eve build evaluates this module to compile the agent; neither the build nor CI has
      // any secret. A credential (or MARCEL_MODEL_GATE) read at module scope would fail the
      // image build outright — mirrors agent/channels/slack.ts and eve-saga's telegram.ts.
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

  describe("isAllowedTelegramMessage — private-chat admin allowlist", () => {
    it("admits the configured admin in a private chat", async () => {
      const { isAllowedTelegramMessage } = await freshModule();
      expect(isAllowedTelegramMessage(message())).toBe(true);
    });

    it("rejects any other Telegram user id", async () => {
      const { isAllowedTelegramMessage } = await freshModule();
      expect(isAllowedTelegramMessage(message({ from: { id: OTHER_ID, isBot: false } }))).toBe(
        false,
      );
    });

    it("rejects bots, including ones that carry the admin's id", async () => {
      const { isAllowedTelegramMessage } = await freshModule();
      expect(
        isAllowedTelegramMessage(message({ from: { id: ADMIN_ID, isBot: true } })),
      ).toBe(false);
    });

    it("rejects a group-chat message even from the admin — chat type alone doesn't grant a pass", async () => {
      const { isAllowedTelegramMessage } = await freshModule();
      expect(isAllowedTelegramMessage(groupMessage({ from: { id: ADMIN_ID, isBot: false } }))).toBe(
        false,
      );
    });

    it("admits nobody when MARCEL_ADMIN_TELEGRAM_ID is unset", async () => {
      delete process.env["MARCEL_ADMIN_TELEGRAM_ID"];
      const { isAllowedTelegramMessage } = await freshModule();
      expect(isAllowedTelegramMessage(message())).toBe(false);
    });
  });

  describe("hasDispatchableContent", () => {
    it("admits a text message", async () => {
      const { hasDispatchableContent } = await freshModule();
      expect(hasDispatchableContent(message({ text: "hei" }))).toBe(true);
    });

    it("drops a content-free update", async () => {
      const { hasDispatchableContent } = await freshModule();
      expect(hasDispatchableContent(message({ text: "", caption: "", attachments: [] }))).toBe(
        false,
      );
    });
  });

  describe("createOnMessage — dispatch branching", () => {
    function stubGatekeeper(action: "silent" | "react" | "speak", emoji = "👍") {
      const consider = vi.fn(async () =>
        action === "react" ? { action: "react" as const, emoji } : { action: action as "silent" | "speak" },
      );
      return { consider } as unknown as Gatekeeper;
    }

    /** A Budget-shaped stub, not a real `Budget` — under the daily limit and never having
     *  fired its one-time notify, by default. */
    function stubBudget(overrides: Record<string, unknown> = {}) {
      return {
        exceeded: () => false,
        notifyOnce: () => false,
        add: vi.fn(),
        ...overrides,
      };
    }

    /** A linked-trip stub for tests that don't care about the conversation-log wiring itself —
     *  `dir` still needs to be a plausible path since `appendInbound`'s default is stubbed
     *  out below anyway (`vi.fn()`), never touching real fs unless a test overrides it. */
    function linkedTrip(overrides: Record<string, unknown> = {}) {
      return { tz: "Europe/Paris", dir: join(dir, "trip"), ...overrides };
    }

    function baseDeps(overrides: Record<string, unknown> = {}) {
      return {
        tripForChat: vi.fn(async () => null as { tz: string; dir: string } | null),
        appendInbound: vi.fn(),
        transcriptFor: (_trip: { tz: string; dir: string }, _chatId: string) => "",
        isKillSwitchOn: () => false,
        setKillSwitch: vi.fn(),
        gatekeeper: stubGatekeeper("silent"),
        budget: stubBudget(),
        notifyBudgetExceeded: vi.fn(),
        sendInfoCard: vi.fn(),
        appendNotert: vi.fn(),
        ...overrides,
      };
    }

    it("private admin passes: starts typing and returns auth", async () => {
      const { createOnMessage } = await freshModule();
      const deps = baseDeps();
      const ctx = fakeCtx();

      const result = await createOnMessage(deps as never)(ctx, message());

      expect(result).not.toBeNull();
      expect((ctx as { telegram: { startTyping: ReturnType<typeof vi.fn> } }).telegram.startTyping).toHaveBeenCalled();
    });

    it("private non-admin is rejected: returns null, no typing", async () => {
      const { createOnMessage } = await freshModule();
      const deps = baseDeps();
      const ctx = fakeCtx();

      const result = await createOnMessage(deps as never)(
        ctx,
        message({ from: { id: OTHER_ID, isBot: false } }),
      );

      expect(result).toBeNull();
      expect((ctx as { telegram: { startTyping: ReturnType<typeof vi.fn> } }).telegram.startTyping).not.toHaveBeenCalled();
    });

    it("unlinked group is ignored: gatekeeper never consulted, nothing appended to the log", async () => {
      const { createOnMessage } = await freshModule();
      const gatekeeper = stubGatekeeper("speak");
      const deps = baseDeps({ gatekeeper, tripForChat: vi.fn(async () => null) });
      const ctx = fakeCtx();

      const result = await createOnMessage(deps as never)(ctx, groupMessage({ text: "hva synes dere om middag i kveld?" }));

      expect(result).toBeNull();
      expect((gatekeeper as unknown as { consider: ReturnType<typeof vi.fn> }).consider).not.toHaveBeenCalled();
      // No linked trip means there is nothing to log against — the write side must skip
      // cleanly, not throw and not synthesize a trip to log to.
      expect(deps.appendInbound).not.toHaveBeenCalled();
    });

    it("linked group + gate 'speak' starts a turn", async () => {
      const { createOnMessage } = await freshModule();
      const gatekeeper = stubGatekeeper("speak");
      const deps = baseDeps({
        gatekeeper,
        tripForChat: vi.fn(async () => linkedTrip()),
        transcriptFor: () => "skal vi spise ute i kveld?",
      });
      const ctx = fakeCtx();

      const result = await createOnMessage(deps as never)(
        ctx,
        groupMessage({ text: "skal vi spise ute i kveld?" }),
      );

      expect(result).not.toBeNull();
      expect((ctx as { telegram: { startTyping: ReturnType<typeof vi.fn> } }).telegram.startTyping).toHaveBeenCalled();
      const considerCalls = (gatekeeper as unknown as { consider: ReturnType<typeof vi.fn> }).consider.mock.calls;
      expect(considerCalls[0]).toEqual(["-100123", "skal vi spise ute i kveld?", "Europe/Paris"]);
      // Write side happened too, and (per baseDeps' contract) before the gate ever runs — see
      // the dedicated real-ConversationLog ordering test below for proof of the actual order.
      expect(deps.appendInbound).toHaveBeenCalledTimes(1);
    });

    it("linked group + gate 'react' posts a reaction and returns null (no turn)", async () => {
      const { createOnMessage } = await freshModule();
      const gatekeeper = stubGatekeeper("react", "👍");
      const deps = baseDeps({
        gatekeeper,
        tripForChat: vi.fn(async () => linkedTrip()),
      });
      const ctx = fakeCtx();

      const result = await createOnMessage(deps as never)(
        ctx,
        groupMessage({ text: "haha bra 😂", messageId: "42" }),
      );

      expect(result).toBeNull();
      const requestMock = (ctx as { telegram: { request: ReturnType<typeof vi.fn> } }).telegram.request;
      expect(requestMock).toHaveBeenCalledWith(
        "setMessageReaction",
        expect.objectContaining({
          chat_id: -100123,
          message_id: 42,
          reaction: [{ type: "emoji", emoji: "👍" }],
        }),
      );
    });

    it("linked group + gate 'silent' returns null and posts nothing", async () => {
      const { createOnMessage } = await freshModule();
      const gatekeeper = stubGatekeeper("silent");
      const deps = baseDeps({
        gatekeeper,
        tripForChat: vi.fn(async () => linkedTrip()),
      });
      const ctx = fakeCtx();

      const result = await createOnMessage(deps as never)(ctx, groupMessage({ text: "ok" }));

      expect(result).toBeNull();
      expect((ctx as { telegram: { request: ReturnType<typeof vi.fn> } }).telegram.request).not.toHaveBeenCalled();
    });

    describe("tagged/replied-to bypasses the gate AND the budget check (Fix Wave B, Finding 2)", () => {
      it("a message that @mentions the bot starts a turn unconditionally, without ever consulting the gate or the budget", async () => {
        const { createOnMessage } = await freshModule();
        const gatekeeper = stubGatekeeper("silent"); // would silence an untagged message
        const budget = stubBudget({ exceeded: vi.fn(() => true) }); // would also block an untagged message
        const deps = baseDeps({ gatekeeper, budget, tripForChat: vi.fn(async () => linkedTrip()) });
        const ctx = fakeCtx("marcel_bot");

        const result = await createOnMessage(deps as never)(
          ctx,
          groupMessage({ text: "@marcel_bot hva er klokka?" }),
        );

        expect(result).not.toBeNull();
        expect((ctx as { telegram: { startTyping: ReturnType<typeof vi.fn> } }).telegram.startTyping).toHaveBeenCalled();
        expect((gatekeeper as unknown as { consider: ReturnType<typeof vi.fn> }).consider).not.toHaveBeenCalled();
        expect((budget as unknown as { exceeded: ReturnType<typeof vi.fn> }).exceeded).not.toHaveBeenCalled();
        // Still logged, same as any other group message.
        expect(deps.appendInbound).toHaveBeenCalledTimes(1);
      });

      it("a reply to one of the bot's own messages is tagged even with no @mention in the text", async () => {
        const { createOnMessage } = await freshModule();
        const gatekeeper = stubGatekeeper("silent");
        const deps = baseDeps({ gatekeeper, tripForChat: vi.fn(async () => linkedTrip()) });
        const ctx = fakeCtx("marcel_bot");

        const result = await createOnMessage(deps as never)(
          ctx,
          groupMessage({
            text: "ja takk",
            replyToMessage: {
              chat: { id: "-100123", type: "group" },
              from: { id: "1", isBot: true, username: "marcel_bot" },
              messageId: "5",
            },
          }),
        );

        expect(result).not.toBeNull();
        expect((gatekeeper as unknown as { consider: ReturnType<typeof vi.fn> }).consider).not.toHaveBeenCalled();
      });

      it("a reply to someone else's message is NOT tagged and still goes through the gate", async () => {
        const { createOnMessage } = await freshModule();
        const gatekeeper = stubGatekeeper("silent");
        const deps = baseDeps({ gatekeeper, tripForChat: vi.fn(async () => linkedTrip()) });
        const ctx = fakeCtx("marcel_bot");

        const result = await createOnMessage(deps as never)(
          ctx,
          groupMessage({
            text: "ja takk",
            replyToMessage: {
              chat: { id: "-100123", type: "group" },
              from: { id: "2", isBot: false, username: "cousin_joe" },
              messageId: "5",
            },
          }),
        );

        expect(result).toBeNull(); // gate stub returns "silent"
        expect((gatekeeper as unknown as { consider: ReturnType<typeof vi.fn> }).consider).toHaveBeenCalledTimes(1);
      });

      it("a tagged photo (with a mentioning caption) starts a turn too", async () => {
        const { createOnMessage } = await freshModule();
        const deps = baseDeps({ tripForChat: vi.fn(async () => linkedTrip()) });
        const ctx = fakeCtx("marcel_bot");

        const result = await createOnMessage(deps as never)(
          ctx,
          groupMessage({
            text: "",
            caption: "@marcel_bot hva er dette?",
            attachments: [{ fileId: "f1", kind: "photo" }],
          }),
        );

        expect(result).not.toBeNull();
      });

      it("a tagged but content-free message (voice note, sticker, ...) apologizes instead of starting an empty-prompt turn (Important #2 fix)", async () => {
        const { createOnMessage } = await freshModule();
        const deps = baseDeps({ tripForChat: vi.fn(async () => linkedTrip()) });
        const ctx = fakeCtx("marcel_bot");

        const result = await createOnMessage(deps as never)(
          ctx,
          groupMessage({
            text: "",
            caption: "",
            attachments: [],
            replyToMessage: {
              chat: { id: "-100123", type: "group" },
              from: { id: "1", isBot: true, username: "marcel_bot" },
              messageId: "5",
            },
          }),
        );

        expect(result).toBeNull();
        expect((ctx as { telegram: { sendMessage: ReturnType<typeof vi.fn> } }).telegram.sendMessage).toHaveBeenCalledWith(
          expect.stringContaining("den meldingstypen støtter jeg ikke ennå"),
        );
        expect((ctx as { telegram: { startTyping: ReturnType<typeof vi.fn> } }).telegram.startTyping).not.toHaveBeenCalled();
      });
    });

    describe("husk: shortcut (Fix Wave B, Finding 2 — old Marcel bin/marcel.ts:608-616)", () => {
      it("appends the note and acks with a fixed string, never starting a turn", async () => {
        const { createOnMessage } = await freshModule();
        const gatekeeper = stubGatekeeper("speak"); // would otherwise start a turn — must not be consulted
        const appendNotert = vi.fn();
        const deps = baseDeps({ gatekeeper, appendNotert, tripForChat: vi.fn(async () => linkedTrip()) });
        const ctx = fakeCtx("marcel_bot");

        const result = await createOnMessage(deps as never)(
          ctx,
          groupMessage({ text: "@marcel_bot husk: Emma er allergisk mot nøtter" }),
        );

        expect(result).toBeNull();
        expect(appendNotert).toHaveBeenCalledWith("-100123", "Emma er allergisk mot nøtter");
        expect((ctx as { telegram: { sendMessage: ReturnType<typeof vi.fn> } }).telegram.sendMessage).toHaveBeenCalledWith(
          "Notert! 📝 Emma er allergisk mot nøtter",
        );
        expect((gatekeeper as unknown as { consider: ReturnType<typeof vi.fn> }).consider).not.toHaveBeenCalled();
      });
    });

    describe("group /info (Fix Wave B, Finding 2 — old Marcel bin/marcel.ts:571-575)", () => {
      it("routes directly to sendInfoCard, bypassing the tagged check AND the gate — not admin-gated", async () => {
        const { createOnMessage } = await freshModule();
        const gatekeeper = stubGatekeeper("silent");
        const sendInfoCard = vi.fn();
        const deps = baseDeps({ gatekeeper, sendInfoCard, tripForChat: vi.fn(async () => linkedTrip()) });
        const ctx = fakeCtx("marcel_bot");

        const result = await createOnMessage(deps as never)(ctx, groupMessage({ text: "/info" }));

        expect(result).toBeNull();
        expect(sendInfoCard).toHaveBeenCalledWith("-100123");
        expect((gatekeeper as unknown as { consider: ReturnType<typeof vi.fn> }).consider).not.toHaveBeenCalled();
      });
    });

    describe("group photo captions and location shares are logged for transcript quality (Fix Wave B, Finding 2)", () => {
      it("logs a photo's caption even when the message is untagged", async () => {
        const { createOnMessage } = await freshModule();
        const deps = baseDeps({ tripForChat: vi.fn(async () => linkedTrip()) });
        const ctx = fakeCtx("marcel_bot");

        await createOnMessage(deps as never)(
          ctx,
          groupMessage({ text: "", caption: "utsikten fra terrassen", attachments: [{ fileId: "f1", kind: "photo" }] }),
        );

        expect(deps.appendInbound).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ text: "[foto] utsikten fra terrassen" }),
        );
      });

      it("a captionless photo is not logged (matches old Marcel: only a caption is worth logging)", async () => {
        const { createOnMessage } = await freshModule();
        const deps = baseDeps({ tripForChat: vi.fn(async () => linkedTrip()) });
        const ctx = fakeCtx("marcel_bot");

        await createOnMessage(deps as never)(
          ctx,
          groupMessage({ text: "", caption: "", attachments: [{ fileId: "f1", kind: "photo" }] }),
        );

        expect(deps.appendInbound).not.toHaveBeenCalled();
      });

      it("a non-admin group member's shared location is logged and reacted to, regardless of tag/gate state", async () => {
        const { createOnMessage } = await freshModule();
        const deps = baseDeps({ tripForChat: vi.fn(async () => linkedTrip()) });
        const ctx = fakeCtx("marcel_bot");

        const result = await createOnMessage(deps as never)(
          ctx,
          groupMessage({
            text: "",
            from: { id: OTHER_ID, isBot: false, firstName: "Mor" },
            raw: { location: { latitude: 43.5, longitude: 5.4 } },
          }),
        );

        expect(result).toBeNull();
        expect(deps.appendInbound).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ text: expect.stringContaining("[posisjon] 43.50000, 5.40000") }),
        );
        const requestMock = (ctx as { telegram: { request: ReturnType<typeof vi.fn> } }).telegram.request;
        expect(requestMock).toHaveBeenCalledWith(
          "setMessageReaction",
          expect.objectContaining({ reaction: [{ type: "emoji", emoji: "👌" }] }),
        );
      });

      it("an unlinked group's shared location is not logged (no trip to log against)", async () => {
        const { createOnMessage } = await freshModule();
        const deps = baseDeps({ tripForChat: vi.fn(async () => null) });
        const ctx = fakeCtx("marcel_bot");

        await createOnMessage(deps as never)(
          ctx,
          groupMessage({ text: "", raw: { location: { latitude: 43.5, longitude: 5.4 } } }),
        );

        expect(deps.appendInbound).not.toHaveBeenCalled();
      });
    });

    describe("conversation log — real ConversationLog wiring (Task 8b)", () => {
      it("appends the inbound message to disk BEFORE the gate reads the transcript — the current message influences its own gate decision, matching old Marcel's write-then-read order", async () => {
        const { createOnMessage, defaultDoorDeps } = await freshModule();
        const trip = linkedTrip({ dir: join(dir, "trip-real") });
        const consider = vi.fn(async () => ({ action: "silent" as const }));
        const gatekeeper = { consider } as unknown as Gatekeeper;
        const deps = baseDeps({
          tripForChat: vi.fn(async () => trip),
          appendInbound: defaultDoorDeps.appendInbound,
          transcriptFor: defaultDoorDeps.transcriptFor,
          gatekeeper,
        });
        const ctx = fakeCtx();

        await createOnMessage(deps as never)(
          ctx,
          groupMessage({
            text: "skal vi spise ute i kveld?",
            raw: { date: Math.floor(Date.now() / 1000) },
          }),
        );

        // Write side: a real JSONL entry landed on disk under trip.dir/chatlog.
        const logDir = join(trip.dir, "chatlog");
        const files = readdirSync(logDir);
        expect(files).toHaveLength(1);
        const lines = readFileSync(join(logDir, files[0]!), "utf8").trim().split("\n");
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0]!)).toMatchObject({
          from: OTHER_ID,
          name: "Mor",
          text: "skal vi spise ute i kveld?",
        });

        // Read side + ordering: the transcript handed to `gatekeeper.consider` already
        // contains the just-appended message — proof the append ran first, not after.
        expect(consider).toHaveBeenCalledTimes(1);
        const transcriptArg = consider.mock.calls[0]![1] as string;
        expect(transcriptArg).toContain("skal vi spise ute i kveld?");
      });

      it("an unlinked chat's write side skips cleanly — no directory is created, no throw", async () => {
        const { createOnMessage, defaultDoorDeps } = await freshModule();
        const deps = baseDeps({
          tripForChat: vi.fn(async () => null),
          appendInbound: defaultDoorDeps.appendInbound,
          transcriptFor: defaultDoorDeps.transcriptFor,
        });
        const ctx = fakeCtx();

        await expect(
          createOnMessage(deps as never)(ctx, groupMessage({ text: "hei" })),
        ).resolves.toBeNull();
      });
    });

    it("skips the gate entirely once the daily budget is exceeded — no model call is made", async () => {
      // Mirrors the existing "stays silent during quiet hours... without calling decide"
      // gatekeeper test, but for the caller-side circuit breaker (bin/marcel.ts:631-636):
      // the assertion that matters is that `gatekeeper.consider` — which is what eventually
      // triggers the raw, budget-tracked model call inside makeGateDecide — is never invoked.
      const { createOnMessage } = await freshModule();
      const gatekeeper = stubGatekeeper("speak");
      const deps = baseDeps({
        gatekeeper,
        tripForChat: vi.fn(async () => linkedTrip()),
        budget: stubBudget({ exceeded: () => true, notifyOnce: () => false }),
      });
      const ctx = fakeCtx();

      const result = await createOnMessage(deps as never)(
        ctx,
        groupMessage({ text: "hva bør vi spise til middag?" }),
      );

      expect(result).toBeNull();
      expect((gatekeeper as unknown as { consider: ReturnType<typeof vi.fn> }).consider).not.toHaveBeenCalled();
      // The write side is NOT gated by the budget check — old Marcel logs unconditionally,
      // before the budget/gate logic even runs (bin/marcel.ts:557-561 vs. 631-636).
      expect(deps.appendInbound).toHaveBeenCalledTimes(1);
    });

    it("notifies the admin exactly once when the budget first tips over (notifyOnce() true)", async () => {
      const { createOnMessage } = await freshModule();
      const notifyBudgetExceeded = vi.fn();
      const deps = baseDeps({
        tripForChat: vi.fn(async () => linkedTrip()),
        budget: stubBudget({ exceeded: () => true, notifyOnce: () => true }),
        notifyBudgetExceeded,
      });
      const ctx = fakeCtx();

      const result = await createOnMessage(deps as never)(ctx, groupMessage({ text: "middag i kveld?" }));

      expect(result).toBeNull();
      expect(notifyBudgetExceeded).toHaveBeenCalledTimes(1);
    });

    it("does not re-notify the admin once notifyOnce() has already fired for the day", async () => {
      const { createOnMessage } = await freshModule();
      const notifyBudgetExceeded = vi.fn();
      const deps = baseDeps({
        tripForChat: vi.fn(async () => linkedTrip()),
        budget: stubBudget({ exceeded: () => true, notifyOnce: () => false }),
        notifyBudgetExceeded,
      });
      const ctx = fakeCtx();

      const result = await createOnMessage(deps as never)(ctx, groupMessage({ text: "middag i kveld?" }));

      expect(result).toBeNull();
      expect(notifyBudgetExceeded).not.toHaveBeenCalled();
    });

    it("kill switch short-circuits everything, including the admin in a private chat", async () => {
      const { createOnMessage } = await freshModule();
      const setKillSwitch = vi.fn();
      const deps = baseDeps({ isKillSwitchOn: () => true, setKillSwitch });
      const ctx = fakeCtx();

      const result = await createOnMessage(deps as never)(ctx, message({ text: "hva skjer i dag?" }));

      expect(result).toBeNull();
      expect(setKillSwitch).not.toHaveBeenCalled();
      expect((ctx as { telegram: { startTyping: ReturnType<typeof vi.fn> } }).telegram.startTyping).not.toHaveBeenCalled();
    });

    it("kill switch short-circuits a group message too", async () => {
      const { createOnMessage } = await freshModule();
      const gatekeeper = stubGatekeeper("speak");
      const deps = baseDeps({
        isKillSwitchOn: () => true,
        gatekeeper,
        tripForChat: vi.fn(async () => linkedTrip()),
      });
      const ctx = fakeCtx();

      const result = await createOnMessage(deps as never)(ctx, groupMessage({ text: "middag i kveld?" }));

      expect(result).toBeNull();
      expect((gatekeeper as unknown as { consider: ReturnType<typeof vi.fn> }).consider).not.toHaveBeenCalled();
    });

    it("'/marcel på' from the admin in a private chat re-enables the kill switch, still with no turn", async () => {
      const { createOnMessage } = await freshModule();
      const setKillSwitch = vi.fn();
      const deps = baseDeps({ isKillSwitchOn: () => true, setKillSwitch });
      const ctx = fakeCtx();

      const result = await createOnMessage(deps as never)(ctx, message({ text: "/marcel på" }));

      expect(result).toBeNull();
      expect(setKillSwitch).toHaveBeenCalledWith(false);
    });

    it("'/marcel på' from a non-admin does NOT re-enable the kill switch", async () => {
      const { createOnMessage } = await freshModule();
      const setKillSwitch = vi.fn();
      const deps = baseDeps({ isKillSwitchOn: () => true, setKillSwitch });
      const ctx = fakeCtx();

      const result = await createOnMessage(deps as never)(
        ctx,
        message({ text: "/marcel på", from: { id: OTHER_ID, isBot: false } }),
      );

      expect(result).toBeNull();
      expect(setKillSwitch).not.toHaveBeenCalled();
    });

    it("bot-added-to-group service message on an unlinked group calls the onBotAddedToGroup seam, still returns null", async () => {
      const { createOnMessage } = await freshModule();
      const onBotAddedToGroup = vi.fn();
      const deps = baseDeps({ onBotAddedToGroup });
      const ctx = fakeCtx("marcel_bot");

      const result = await createOnMessage(deps as never)(
        ctx,
        groupMessage({
          text: "",
          raw: { new_chat_members: [{ id: 1, is_bot: true, username: "marcel_bot" }] },
        }),
      );

      expect(result).toBeNull();
      expect(onBotAddedToGroup).toHaveBeenCalledWith("-100123", "Family Trip");
    });

    it("does not treat an ordinary new-member join (not the bot) as an offer-link trigger", async () => {
      const { createOnMessage } = await freshModule();
      const onBotAddedToGroup = vi.fn();
      const deps = baseDeps({ onBotAddedToGroup });
      const ctx = fakeCtx("marcel_bot");

      const result = await createOnMessage(deps as never)(
        ctx,
        groupMessage({
          text: "",
          raw: { new_chat_members: [{ id: 2, is_bot: false, username: "cousin_joe" }] },
        }),
      );

      expect(result).toBeNull();
      expect(onBotAddedToGroup).not.toHaveBeenCalled();
    });

    it("ignores a channel-type chat outright (never dispatched, like eve's own default)", async () => {
      const { createOnMessage } = await freshModule();
      const deps = baseDeps();
      const ctx = fakeCtx();

      const result = await createOnMessage(deps as never)(
        ctx,
        message({ chat: { id: "-1001", type: "channel" }, from: { id: ADMIN_ID, isBot: false } }),
      );

      expect(result).toBeNull();
    });
  });
});

// ── The delivery-first contract (ORB-112) ────────────────────────────────────────────────
//
// Supplying "message.completed" REPLACES eve's default handler, and the default's whole job is
// the post that makes the reply visible. eve-saga shipped exactly this override without the post
// on 2026-08-17 and every Telegram reply went silently undelivered. Nothing had exercised the
// function. This does.
describe("onMessageCompleted — the model's reply actually reaches the chat", () => {
  async function handler() {
    const mod = await import("../agent/channels/telegram.js");
    return mod.onMessageCompleted;
  }

  it("posts the reply — converted to HTML — and that is the first thing it does", async () => {
    const posted: unknown[] = [];
    const onMessageCompleted = await handler();

    await onMessageCompleted(
      { finishReason: "stop", message: "**Fly** kl. 09:00" },
      { telegram: { post: async (m) => { posted.push(m); return {}; } } },
    );

    expect(posted).toEqual([{ text: "<b>Fly</b> kl. 09:00", parse_mode: "HTML" }]);
  });

  it("carries parse_mode on EVERY chunk — eve's own splitter drops it after the first", async () => {
    const posted: { text: string; parse_mode: string }[] = [];
    const onMessageCompleted = await handler();
    const long = Array.from({ length: 400 }, (_, i) => `**linje ${i}** med tekst nok til å dele opp`).join("\n");

    await onMessageCompleted(
      { finishReason: "stop", message: long },
      { telegram: { post: async (m) => { posted.push(m as { text: string; parse_mode: string }); return {}; } } },
    );

    expect(posted.length).toBeGreaterThan(1);
    for (const p of posted) {
      expect(p.parse_mode).toBe("HTML");
      expect((p.text.match(/<b>/g) ?? []).length).toBe((p.text.match(/<\/b>/g) ?? []).length);
    }
  });

  it("stays silent for interim tool-call narration and for an empty message", async () => {
    const posted: unknown[] = [];
    const onMessageCompleted = await handler();
    const channel = { telegram: { post: async (m: unknown) => { posted.push(m); return {}; } } };

    await onMessageCompleted({ finishReason: "tool-calls", message: "tenker…" }, channel);
    await onMessageCompleted({ finishReason: "stop", message: "" }, channel);
    await onMessageCompleted({ finishReason: "stop", message: null }, channel);

    expect(posted).toEqual([]);
  });
});
