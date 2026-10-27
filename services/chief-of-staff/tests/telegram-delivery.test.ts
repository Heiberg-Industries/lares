/**
 * The QA outage, pinned: supplying a custom `message.completed` handler REPLACES
 * eve's default (object spread in telegramChannel), and the default is what posts the
 * assistant's reply to the chat. The rotation handler shipped without reproducing
 * that post — every Telegram session reply and both daily briefs were silently undelivered
 * while raw sends (reminders, proposal buttons) kept working and masked it.
 *
 * These tests exercise the EXPORTED handler directly with a fake channel: delivery must
 * happen FIRST, unconditionally of rotation state (even with the DB unreachable), and must
 * mirror the default's gating (no post on tool-call narration or empty message).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn(async () => ({ rows: [], rowCount: 1 })) }));
vi.mock("@lares/agent-kit/db", () => ({ getPool: () => ({ query }) }));

import { onMessageCompleted } from "../agent/channels/telegram.js";

const OWNER_TG = "123456789";

function fakeChannel(chatId: string | null = OWNER_TG, chatType: string | null = "private") {
  const posted: { text: string; parse_mode?: string }[] = [];
  return {
    posted,
    // The third argument eve passes every channel event handler. The rotation half reads the
    // session id off it to write down which conversation served this chat.
    ctx: { session: { id: "wrun_fixture_delivery" } },
    channel: {
      state: { chatId, chatType },
      //: the handler now posts a body object carrying `parse_mode`, not a bare string.
      telegram: { post: async (m: unknown) => { posted.push(m as { text: string; parse_mode?: string }); return { id: `tg-${posted.length}` }; } },
    },
  };
}

beforeEach(() => {
  process.env["TELEGRAM_PRINCIPAL_ID"] = OWNER_TG;
  // No DATABASE_URL: the rotation half MUST fail — delivery must not care.
  delete process.env["DATABASE_URL"];
});

afterEach(() => {
  delete process.env["TELEGRAM_PRINCIPAL_ID"];
});

describe("onMessageCompleted — delivery first, rotation second", () => {
  it("posts a terminal reply to the chat even when the rotation DB is unreachable", async () => {
    const { channel, posted, ctx } = fakeChannel();
    await onMessageCompleted({ finishReason: "stop", message: "hello from agent-a" }, channel, ctx);
    expect(posted).toEqual([{ text: "hello from agent-a", parse_mode: "HTML" }]);
  });

  it("does not post interim tool-call narration (mirrors eve's default gating)", async () => {
    const { channel, posted, ctx } = fakeChannel();
    await onMessageCompleted({ finishReason: "tool-calls", message: "calling vault_search…" }, channel, ctx);
    expect(posted).toEqual([]);
  });

  it("does not post an empty message", async () => {
    const { channel, posted, ctx } = fakeChannel();
    await onMessageCompleted({ finishReason: "stop", message: "" }, channel, ctx);
    expect(posted).toEqual([]);
  });

  it("still posts for chats outside rotation tracking (group/unknown principal) — delivery is unconditional", async () => {
    const { channel, posted, ctx } = fakeChannel("999", "group");
    await onMessageCompleted({ finishReason: "stop", message: "group reply" }, channel, ctx);
    expect(posted).toEqual([{ text: "group reply", parse_mode: "HTML" }]);
  });

  it("a post failure surfaces (does not get swallowed by the rotation catch)", async () => {
    const { channel, ctx } = fakeChannel();
    channel.telegram.post = async () => { throw new Error("telegram down"); };
    await expect(
      onMessageCompleted({ finishReason: "stop", message: "x" }, channel, ctx),
    ).rejects.toThrow("telegram down");
  });

  it("stores the exact native Telegram message id used by the sent question", async () => {
    const { channel, posted } = fakeChannel();
    const ctx = { session: { id: "wrun_question", auth: { current: {
      attributes: { lares_route_decline_request_id: "request-question" },
    } } } };
    await onMessageCompleted({ finishReason: "stop", message: "Reply directly: Not now, or never?" }, channel, ctx);
    expect(posted).toHaveLength(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("question_reply_anchor=$2"), ["request-question", "telegram:tg-1"]);
  });
});

// ──: the reply goes out as Telegram HTML ─────────────────────────────────────────
//
// The chief of staff's replies rendered literal `**bold**` for a reason that applies to any eve agent: eve posts text
// with no parse_mode. Conversion happens on the way out, and — the part that bites — the
// chunking is ours, because eve's own splitter passes the body's extra fields to the first
// chunk only, so every later chunk would lose parse_mode and arrive as visible tag soup.
describe("onMessageCompleted — markdown becomes Telegram HTML", () => {
  it("converts bold, and escapes what Telegram's HTML mode requires", async () => {
    const { channel, posted, ctx } = fakeChannel();

    await onMessageCompleted({ finishReason: "stop", message: "**Tor & Ledgerly** er klar" }, channel, ctx);

    expect(posted).toEqual([{ text: "<b>Tor &amp; Ledgerly</b> er klar", parse_mode: "HTML" }]);
  });

  it("carries parse_mode on EVERY chunk of a long reply, with no tag split across chunks", async () => {
    const { channel, posted, ctx } = fakeChannel();
    const long = Array.from({ length: 400 }, (_, i) => `**punkt ${i}** med nok tekst til å måtte deles`).join("\n");

    await onMessageCompleted({ finishReason: "stop", message: long }, channel, ctx);

    expect(posted.length).toBeGreaterThan(1);
    for (const p of posted) {
      expect(p.parse_mode).toBe("HTML");
      expect((p.text.match(/<b>/g) ?? []).length).toBe((p.text.match(/<\/b>/g) ?? []).length);
    }
  });
});
