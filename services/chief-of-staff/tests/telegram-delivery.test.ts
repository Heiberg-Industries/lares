/**
 * The QA outage, pinned: supplying a custom reply handler REPLACES eve's default (object spread
 * in telegramChannel), and the default is what posts the assistant's reply to the chat. The
 * rotation handler once shipped without reproducing that post — every Telegram session reply and
 * both daily briefs were silently undelivered while raw sends (reminders, proposal buttons) kept
 * working and masked it.
 *
 * On eve 1.0 the reply arrives as `content.completed`: a text part whose `phase` is `reply`.
 * These tests exercise the EXPORTED handler directly with a fake channel: delivery must happen
 * FIRST, unconditionally of rotation state (even with the DB unreachable), and must mirror the
 * default's gating (no post for narration before a tool call, for a part that is not text, or
 * for an empty one).
 *
 * The last block is the other way a message leaves this agent for Telegram: a schedule that
 * already holds its final text and has no channel handle (`lib/telegram-send.ts`).
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn(async () => ({ rows: [], rowCount: 1 })) }));
vi.mock("@lares/agent-kit/db", () => ({ getPool: () => ({ query }) }));

// The proxied fetch — the only way out of the box. Everything `lib/telegram-send.ts` does goes
// through it, so it is the seam the scheduled-send tests watch.
const bot = vi.hoisted(() => ({
  requests: [] as Array<{ url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }>,
  respond: (): Response => new Response(JSON.stringify({ ok: true, result: { message_id: 4711, chat: { id: 123456789, type: "private" } } }), { status: 200 }),
}));
vi.mock("@lares/agent-kit/telegram-fetch", () => ({
  telegramFetch: async (url: string | URL, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    bot.requests.push({ url: String(url), init: init ?? {} });
    return bot.respond();
  },
}));

import { onContentCompleted } from "../agent/channels/telegram.js";
import { callTelegramApi, sendTelegramMessage } from "../lib/telegram-send.js";

const OWNER_TG = "123456789";

/** A reply part, as eve 1.0 reports it. */
const reply = (value: unknown, over: Record<string, unknown> = {}) => ({
  type: "content.completed",
  data: { partId: "part-1", kind: "text", phase: "reply", value, ...over },
});

function fakeChannel(chatId: string | null = OWNER_TG, chatType: string | null = "private") {
  const posted: { text: string; parse_mode?: string }[] = [];
  const channel = {
    state: { chatId, chatType },
    // The handler posts a body object carrying `parse_mode`, not a bare string.
    telegram: { post: async (m: unknown): Promise<{ id?: unknown }> => { posted.push(m as { text: string; parse_mode?: string }); return { id: `tg-${posted.length}` }; } },
  };
  return {
    posted,
    channel,
    // What eve hands every channel event handler: the channel's own context, and the session.
    // The rotation half reads the session id to write down which conversation served this chat.
    ctx: { channel, session: { id: "wrun_fixture_delivery" } },
  };
}

beforeEach(() => {
  process.env["TELEGRAM_PRINCIPAL_ID"] = OWNER_TG;
  // No DATABASE_URL: the rotation half MUST fail — delivery must not care.
  delete process.env["DATABASE_URL"];
  bot.requests.length = 0;
  bot.respond = () => new Response(JSON.stringify({ ok: true, result: { message_id: 4711, chat: { id: 123456789, type: "private" } } }), { status: 200 });
});

afterEach(() => {
  delete process.env["TELEGRAM_PRINCIPAL_ID"];
});

describe("onContentCompleted — delivery first, rotation second", () => {
  it("posts the reply to the chat even when the rotation DB is unreachable", async () => {
    const { posted, ctx } = fakeChannel();
    await onContentCompleted(reply("hello from agent-a"), ctx);
    expect(posted).toEqual([{ text: "hello from agent-a", parse_mode: "HTML" }]);
  });

  it("does not post narration before a tool call (mirrors eve's default gating)", async () => {
    const { posted, ctx } = fakeChannel();
    await onContentCompleted(reply("calling vault_search…", { phase: "narration" }), ctx);
    expect(posted).toEqual([]);
  });

  it("does not post a phase it does not know — eve reads an unknown phase as narration", async () => {
    const { posted, ctx } = fakeChannel();
    await onContentCompleted(reply("something new", { phase: "a-phase-a-later-eve-adds" }), ctx);
    expect(posted).toEqual([]);
  });

  it("does not post a part that is not text: reasoning, a structured result, a file", async () => {
    for (const kind of ["reasoning", "result", "file"]) {
      const { posted, ctx } = fakeChannel();
      await onContentCompleted(reply("not for the chat", { kind }), ctx);
      expect(posted, kind).toEqual([]);
    }
  });

  it("does not post an empty reply, or one whose value is not text", async () => {
    for (const value of ["", undefined, null, { text: "x" }]) {
      const { posted, ctx } = fakeChannel();
      await onContentCompleted(reply(value), ctx);
      expect(posted).toEqual([]);
    }
  });

  it("posts exactly what eve's own default would have posted, for every one of the cases above", async () => {
    // eve's default reply handler posts `replyTextOf(event.data)`. Read from the installed eve.
    const eveDist = pathToFileURL(fileURLToPath(new URL("../node_modules/eve/dist/src", import.meta.url))).href;
    const { replyTextOf } = (await import(`${eveDist}/public/channels/reply.js`)) as { replyTextOf(data: unknown): string | undefined };
    const cases = [
      reply("plain words"),
      reply("narrating", { phase: "narration" }),
      reply("unknown", { phase: "later" }),
      reply("thinking", { kind: "reasoning" }),
      reply({ a: 1 }, { kind: "result" }),
      reply(""),
      reply(undefined),
    ];
    for (const event of cases) {
      const { posted, ctx } = fakeChannel();
      await onContentCompleted(event, ctx);
      const expected = replyTextOf(event.data);
      expect(posted.map((p) => p.text), JSON.stringify(event.data)).toEqual(expected === undefined ? [] : [expected]);
    }
  });

  it("still posts for chats outside rotation tracking (group/unknown principal) — delivery is unconditional", async () => {
    const { posted, ctx } = fakeChannel("999", "group");
    await onContentCompleted(reply("group reply"), ctx);
    expect(posted).toEqual([{ text: "group reply", parse_mode: "HTML" }]);
  });

  it("a post failure surfaces (does not get swallowed by the rotation catch)", async () => {
    const { channel, ctx } = fakeChannel();
    channel.telegram.post = async () => { throw new Error("telegram down"); };
    await expect(onContentCompleted(reply("x"), ctx)).rejects.toThrow("telegram down");
  });

  it("stores the exact native Telegram message id used by the sent question", async () => {
    const { channel, posted } = fakeChannel();
    const ctx = { channel, session: { id: "wrun_question", auth: { current: {
      attributes: { lares_route_decline_request_id: "request-question" },
    } } } };
    await onContentCompleted(reply("Reply directly: Not now, or never?"), ctx);
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
describe("onContentCompleted — markdown becomes Telegram HTML", () => {
  it("converts bold, and escapes what Telegram's HTML mode requires", async () => {
    const { posted, ctx } = fakeChannel();

    await onContentCompleted(reply("**Tor & Ledgerly** er klar"), ctx);

    expect(posted).toEqual([{ text: "<b>Tor &amp; Ledgerly</b> er klar", parse_mode: "HTML" }]);
  });

  it("carries parse_mode on EVERY chunk of a long reply, with no tag split across chunks", async () => {
    const { posted, ctx } = fakeChannel();
    const long = Array.from({ length: 400 }, (_, i) => `**punkt ${i}** med nok tekst til å måtte deles`).join("\n");

    await onContentCompleted(reply(long), ctx);

    expect(posted.length).toBeGreaterThan(1);
    for (const p of posted) {
      expect(p.parse_mode).toBe("HTML");
      expect((p.text.match(/<b>/g) ?? []).length).toBe((p.text.match(/<\/b>/g) ?? []).length);
    }
  });
});

// ── A send with no channel handle: lib/telegram-send.ts ──────────────────────────────────
//
// A schedule that already holds its final text (a reminder, a proposal announcement, a routed
// notice) has no inbound update and so no handle. eve 1.0 no longer exports a sender for it; this
// is ours. What matters: it goes through the proxied fetch, it returns the message id, and a
// refusal is thrown with Telegram's own words so the schedule's "not sent" path sees why.
describe("sendTelegramMessage — the sender for code with no channel handle", () => {
  const credentials = { botToken: async () => "1:abc" };

  it("POSTs Telegram's sendMessage through the proxied fetch, to the chat it was given", async () => {
    await sendTelegramMessage({ credentials, chatId: OWNER_TG, body: { text: "Påminnelse: møte kl. 10" } });

    expect(bot.requests).toHaveLength(1);
    expect(bot.requests[0]!.url).toBe("https://api.telegram.org/bot1:abc/sendMessage");
    expect(bot.requests[0]!.init.method).toBe("POST");
    expect(bot.requests[0]!.init.headers).toEqual({ "content-type": "application/json; charset=utf-8" });
    expect(JSON.parse(bot.requests[0]!.init.body!)).toEqual({ chat_id: OWNER_TG, text: "Påminnelse: møte kl. 10" });
  });

  it("returns the id of the message Telegram created", async () => {
    await expect(sendTelegramMessage({ credentials, chatId: OWNER_TG, body: { text: "hei" } })).resolves.toEqual({ id: "4711" });
  });

  it("passes parse_mode and reply_markup through untouched — a proposal announcement carries both", async () => {
    const reply_markup = { inline_keyboard: [[{ text: "✅ Approve", callback_data: "np:a:61" }]] };
    await sendTelegramMessage({ credentials, chatId: 42, body: { text: "<b>Forslag</b>", parse_mode: "HTML", reply_markup } });

    expect(JSON.parse(bot.requests[0]!.init.body!)).toEqual({ chat_id: 42, text: "<b>Forslag</b>", parse_mode: "HTML", reply_markup });
  });

  it("the chat is the caller's, never something the body can override", async () => {
    await sendTelegramMessage({ credentials, chatId: OWNER_TG, body: { text: "hei", chat_id: "999" } });
    expect(JSON.parse(bot.requests[0]!.init.body!).chat_id).toBe(OWNER_TG);
  });

  it("throws with Telegram's own description when Telegram refuses the message", async () => {
    bot.respond = () => new Response(JSON.stringify({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }), { status: 403 });

    await expect(sendTelegramMessage({ credentials, chatId: OWNER_TG, body: { text: "hei" } })).rejects.toThrow(
      "Telegram sendMessage failed with HTTP 403: Forbidden: bot was blocked by the user",
    );
  });

  it("a refusal carried in the body alone (ok: false under a 200) is still a refusal", async () => {
    bot.respond = () => new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), { status: 200 });

    await expect(sendTelegramMessage({ credentials, chatId: OWNER_TG, body: { text: "hei" } })).rejects.toThrow("Bad Request: chat not found");
  });

  it("an error never carries the bot token, whatever came back", async () => {
    for (const respond of [
      () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
      () => new Response("", { status: 500 }),
      () => new Response(JSON.stringify({ ok: false }), { status: 400 }),
    ]) {
      bot.respond = respond;
      const error = await sendTelegramMessage({ credentials, chatId: OWNER_TG, body: { text: "hei" } }).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Telegram sendMessage failed with HTTP");
      expect((error as Error).message).not.toContain("1:abc");
      expect((error as Error).message).not.toContain("api.telegram.org");
    }
  });

  it("refuses to call Telegram at all with an empty token", async () => {
    await expect(sendTelegramMessage({ credentials: { botToken: async () => "" }, chatId: OWNER_TG, body: { text: "hei" } })).rejects.toThrow("bot token is empty");
    expect(bot.requests).toEqual([]);
  });

  it("the credentials are read on every send, never remembered", async () => {
    let reads = 0;
    const counting = { botToken: async () => { reads += 1; return "1:abc"; } };
    await sendTelegramMessage({ credentials: counting, chatId: OWNER_TG, body: { text: "one" } });
    await sendTelegramMessage({ credentials: counting, chatId: OWNER_TG, body: { text: "two" } });
    expect(reads).toBe(2);
  });

  it("callTelegramApi returns a refusal instead of throwing it — the front door logs and carries on", async () => {
    bot.respond = () => new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: query is too old" }), { status: 400 });

    const result = await callTelegramApi({ credentials, method: "answerCallbackQuery", body: { callback_query_id: "cb1", text: "x" } });

    expect(result).toEqual({ ok: false, status: 400, body: { ok: false, error_code: 400, description: "Bad Request: query is too old" } });
    expect(bot.requests[0]!.url).toBe("https://api.telegram.org/bot1:abc/answerCallbackQuery");
  });
});
