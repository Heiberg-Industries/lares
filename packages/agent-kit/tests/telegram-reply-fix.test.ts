// a reply to an eve agent's Telegram bot must reach that agent. Found on
// the travel service first (see lib/telegram-reply-fix.ts for the live incident); same eve version,
// same channel, same swallow on every other agent using this fix.
//
// eve 0.32.0 routes ANY reply to a bot message as an input response and then drops it when no
// freeform prompt is pending, so the turn parks with nothing to deliver: no model call, no
// answer, no error. Live case: Example Group group, 2026-08-17 15:31:50Z, the owner replied to
// The travel agent's intro and the message vanished. See lib/telegram-reply-fix.ts for the upstream lines.
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
      reply_to_message: {
        message_id: 11,
        from: { id: 9000000001, is_bot: true, username: "ExampleBot" },
        text: "Bonjour…",
      },
      ...overrides,
    },
  });
}

describe("neutralizeBotReplyMarker", () => {
  it("clears is_bot on the replied-to message so eve delivers it as a message, not an input response", () => {
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
