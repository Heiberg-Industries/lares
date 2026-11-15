// At an agent's Telegram door a reply to the bot is a message, never an answer
// (see src/telegram-reply-fix.ts).
//
// eve 1.0 offers a reply to a bot message as the ANSWER to a pending free-text prompt first, and
// keys that on `reply_to_message.from.is_bot`. The front door clears the flag, so the reply
// arrives as an ordinary message. The second half of this file runs the INSTALLED eve's own
// parser on a rewritten update, so an eve bump that keys on something else fails here.
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";

import { neutralizeBotReplyMarker } from "../src/telegram-reply-fix.js";

/** The shape of the update that was actually lost, trimmed to the fields that decide routing. */
function replyToBot(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    update_id: 1,
    message: {
      message_id: 12,
      chat: { id: -1000000001, type: "group", title: "Example Group" },
      from: { id: 123456789, is_bot: false, first_name: "owner-1" },
      text: "Kan du sende meg lista før lunsj?",
      // As Telegram sends it: the replied-to message carries its own chat. eve reads the
      // reference only when it does (`parseMessageReference` in inbound.js).
      reply_to_message: {
        message_id: 11,
        chat: { id: -1000000001, type: "group", title: "Example Group" },
        from: { id: 9000000001, is_bot: true, username: "ExampleBot" },
        text: "Bonjour…",
      },
      ...overrides,
    },
  });
}

describe("neutralizeBotReplyMarker", () => {
  it("clears is_bot on the replied-to message so eve delivers it as a message, not an answer", () => {
    const { body, rewritten } = neutralizeBotReplyMarker(replyToBot());

    expect(rewritten).toBe(true);
    const parsed = JSON.parse(body);
    expect(parsed.message.reply_to_message.from.is_bot).toBe(false);
  });

  it("keeps the username intact — our own reply-tagging matches on that, not on is_bot", () => {
    const parsed = JSON.parse(neutralizeBotReplyMarker(replyToBot()).body);

    expect(parsed.message.reply_to_message.from.username).toBe("ExampleBot");
    expect(parsed.message.text).toBe("Kan du sende meg lista før lunsj?");
    expect(parsed.message.reply_to_message.message_id).toBe(11);
  });

  it("leaves an ordinary message byte-identical — the front door forwards what Telegram sent", () => {
    const raw = JSON.stringify({ update_id: 2, message: { message_id: 3, text: "hei" } });

    expect(neutralizeBotReplyMarker(raw)).toEqual({ body: raw, rewritten: false });
  });

  it("leaves a reply to a HUMAN alone", () => {
    const raw = replyToBot({
      reply_to_message: { message_id: 9, from: { id: 42, is_bot: false, username: "family-1" }, text: "hei" },
    });

    expect(neutralizeBotReplyMarker(raw).rewritten).toBe(false);
  });

  it("forwards an unparseable body untouched rather than throwing — deaf is worse than mishandled", () => {
    expect(neutralizeBotReplyMarker("not json at all")).toEqual({ body: "not json at all", rewritten: false });
  });

  it("survives an update with no message at all (edited_message, callback_query, …)", () => {
    const raw = JSON.stringify({ update_id: 4, callback_query: { id: "x", data: "veto:1" } });

    expect(neutralizeBotReplyMarker(raw).rewritten).toBe(false);
  });
});

// ── Against the installed eve ────────────────────────────────────────────────────────────
// eve's exports map does not expose these, so they are loaded by file path.
const EVE_TELEGRAM = pathToFileURL(
  fileURLToPath(new URL("../node_modules/eve/dist/src/public/channels/telegram", import.meta.url)),
).href;

interface EveMessage {
  text: string;
  replyToMessage?: { messageId: string; from?: { isBot: boolean; username?: string } };
}
interface EveInternals {
  parseTelegramUpdate(update: unknown): { kind: string; message: EveMessage } | null;
  stateFromTelegramMessage(message: EveMessage, botUsername?: string): { replyToBotMessageId: string | null };
  telegramReplyAnswers(replyToBotMessageId: unknown, message: unknown): Array<{ interactionId: string; text?: string }>;
}

async function eve(): Promise<EveInternals> {
  const inbound = (await import(`${EVE_TELEGRAM}/inbound.js`)) as Pick<EveInternals, "parseTelegramUpdate">;
  const state = (await import(`${EVE_TELEGRAM}/state.js`)) as Pick<EveInternals, "stateFromTelegramMessage">;
  const hitl = (await import(`${EVE_TELEGRAM}/hitl.js`)) as Pick<EveInternals, "telegramReplyAnswers">;
  return { ...inbound, ...state, ...hitl };
}

describe("the installed eve, fed a reply to the bot", () => {
  it("as Telegram sent it: eve marks the replied-to bot message and offers the text as an answer to it", async () => {
    const { parseTelegramUpdate, stateFromTelegramMessage, telegramReplyAnswers } = await eve();
    const update = parseTelegramUpdate(JSON.parse(replyToBot()));
    expect(update?.kind).toBe("message");

    const state = stateFromTelegramMessage(update!.message, "ExampleBot");
    expect(state.replyToBotMessageId).toBe("11");
    // This is the lane the rewrite closes: a synthetic answer addressed to the replied-to message.
    expect(telegramReplyAnswers(state.replyToBotMessageId, update!.message.text)).toEqual([
      { interactionId: "telegram_reply:11", text: "Kan du sende meg lista før lunsj?" },
    ]);
  });

  it("after the rewrite: no marker, so no answer is built and the reply is only a message", async () => {
    const { parseTelegramUpdate, stateFromTelegramMessage, telegramReplyAnswers } = await eve();
    const update = parseTelegramUpdate(JSON.parse(neutralizeBotReplyMarker(replyToBot()).body));
    expect(update?.kind).toBe("message");

    const state = stateFromTelegramMessage(update!.message, "ExampleBot");
    expect(state.replyToBotMessageId).toBeNull();
    expect(telegramReplyAnswers(state.replyToBotMessageId, update!.message.text)).toEqual([]);
    // What an agent's own reply-tagging reads is still there.
    expect(update!.message.text).toBe("Kan du sende meg lista før lunsj?");
    expect(update!.message.replyToMessage?.messageId).toBe("11");
    expect(update!.message.replyToMessage?.from?.username).toBe("ExampleBot");
  });

  it("typing 'approve' as a reply to a card is no different: a message, never an answer", async () => {
    const { parseTelegramUpdate, stateFromTelegramMessage, telegramReplyAnswers } = await eve();
    const raw = replyToBot({ chat: { id: 123456789, type: "private" }, text: "approve" });
    const update = parseTelegramUpdate(JSON.parse(neutralizeBotReplyMarker(raw).body));

    const state = stateFromTelegramMessage(update!.message, "ExampleBot");
    expect(telegramReplyAnswers(state.replyToBotMessageId, update!.message.text)).toEqual([]);
  });
});
