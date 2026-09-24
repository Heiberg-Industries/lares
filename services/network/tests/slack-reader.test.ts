import { describe, it, expect } from "vitest";
import { createSlackReader, parseMentions, SlackApiError, type SlackFetch } from "../lib/importers/slack-reader.js";
import { SlackInvalidCursorError, SlackRateLimitError } from "../lib/importers/slack.js";

const TOKEN = "xoxp-test-token";
const OWN = "U_BENDIK";

type Call = { url: string; method: string; params: URLSearchParams };

/** A stubbed `fetch` that never touches the network — records every call and answers from a
 *  handler map keyed by Slack method name (the last path segment before `?`). */
function stubFetch(handlers: Record<string, (calls: Call[], params: URLSearchParams) => { status?: number; headers?: Record<string, string>; body: unknown }>): {
  fetchImpl: SlackFetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const [path, qs] = url.split("?");
    const method = path!.split("/").pop()!;
    const params = new URLSearchParams(qs ?? "");
    calls.push({ url, method: (init?.method as string) ?? "GET", params });
    const handler = handlers[method];
    if (!handler) throw new Error(`unstubbed Slack method: ${method}`);
    const { status = 200, headers = {}, body } = handler(calls, params);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }) as SlackFetch;
  return { fetchImpl, calls };
}

describe("parseMentions", () => {
  it("extracts Slack user ids from <@U…> mentions", () => {
    expect(parseMentions("hey <@U123ABC> and <@U456DEF|kari> can you look")).toEqual(["U123ABC", "U456DEF"]);
  });
  it("returns [] for no mentions or no text", () => {
    expect(parseMentions("no mentions here")).toEqual([]);
    expect(parseMentions(undefined)).toEqual([]);
  });
});

describe("createSlackReader — listConversations", () => {
  it("maps public_channel, private_channel, im (with counterparty), and mpim (with fetched members)", async () => {
    const { fetchImpl, calls } = stubFetch({
      "conversations.list": () => ({
        body: {
          ok: true,
          channels: [
            { id: "C1", is_channel: true, is_private: false },
            { id: "C2", is_channel: true, is_group: true, is_private: true },
            { id: "D1", is_im: true, user: "U_OTHER" },
            { id: "G1", is_mpim: true },
          ],
        },
      }),
      "conversations.members": () => ({ body: { ok: true, members: ["U_OTHER", "U_SECOND", OWN] } }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    const convos = await reader.listConversations();

    expect(convos).toEqual([
      { id: "C1", type: "public_channel" },
      { id: "C2", type: "private_channel" },
      { id: "D1", type: "im", counterpartyUserId: "U_OTHER" },
      { id: "G1", type: "mpim", members: ["U_OTHER", "U_SECOND", OWN] },
    ]);
    const membersCall = calls.find((c) => c.url.includes("conversations.members"));
    expect(membersCall!.params.get("channel")).toBe("G1");
  });

  it("skips archived conversations and an im with no counterparty (malformed)", async () => {
    const { fetchImpl } = stubFetch({
      "conversations.list": () => ({
        body: {
          ok: true,
          channels: [
            { id: "C1", is_channel: true, is_archived: true },
            { id: "D1", is_im: true },
          ],
        },
      }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    expect(await reader.listConversations()).toEqual([]);
  });

  it("follows pagination via response_metadata.next_cursor", async () => {
    const { fetchImpl, calls } = stubFetch({
      "conversations.list": (allCalls) => {
        const listCallsSoFar = allCalls.filter((c) => c.url.includes("conversations.list")).length;
        if (listCallsSoFar === 1) {
          return { body: { ok: true, channels: [{ id: "C1", is_channel: true }], response_metadata: { next_cursor: "page2" } } };
        }
        return { body: { ok: true, channels: [{ id: "C2", is_channel: true }], response_metadata: { next_cursor: "" } } };
      },
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    const convos = await reader.listConversations();
    expect(convos.map((c) => c.id)).toEqual(["C1", "C2"]);
    const listCalls = calls.filter((c) => c.url.includes("conversations.list"));
    expect(listCalls).toHaveLength(2);
    expect(listCalls[0]!.params.get("cursor")).toBeNull();
    expect(listCalls[1]!.params.get("cursor")).toBe("page2");
  });

  it("keeps an mpim with empty members instead of dropping it (Important 3) — importer's own guard must see it", async () => {
    const { fetchImpl } = stubFetch({
      "conversations.list": () => ({ body: { ok: true, channels: [{ id: "G1", is_mpim: true }] } }),
      "conversations.members": () => ({ body: { ok: true, members: [] } }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    // Previously this conversation vanished silently (`continue`). It must now be returned
    // with an empty members array so importSlack's own "type mpim but has no members" guard
    // (services/network/lib/importers/slack.ts:343-345) fires and records it visibly.
    expect(await reader.listConversations()).toEqual([{ id: "G1", type: "mpim", members: [] }]);
  });

  it("excludes the self-DM (im whose counterparty is ownUserId) — final review, Important 1", async () => {
    const { fetchImpl } = stubFetch({
      "conversations.list": () => ({
        body: {
          ok: true,
          channels: [
            { id: "D_SELF", is_im: true, user: OWN },
            { id: "D1", is_im: true, user: "U_OTHER" },
          ],
        },
      }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    expect(await reader.listConversations()).toEqual([{ id: "D1", type: "im", counterpartyUserId: "U_OTHER" }]);
  });

  it("excludes the Slackbot DM (im whose counterparty is USLACKBOT) — final review, Important 1", async () => {
    const { fetchImpl } = stubFetch({
      "conversations.list": () => ({
        body: {
          ok: true,
          channels: [
            { id: "D_SLACKBOT", is_im: true, user: "USLACKBOT" },
            { id: "D1", is_im: true, user: "U_OTHER" },
          ],
        },
      }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    expect(await reader.listConversations()).toEqual([{ id: "D1", type: "im", counterpartyUserId: "U_OTHER" }]);
  });

  it("excludes the Slack system-notification DM (im whose counterparty is USLACK) — ORB-149 gap-closing", async () => {
    // USLACK is a distinct id from USLACKBOT (Slack's own system/notification user, not the
    // reminders bot) and `users.info` reports it with `is_bot` falsy — the SLACK_SYSTEM_USER_IDS
    // set is the backstop for exactly this case, see its doc comment in slack-reader.ts.
    const { fetchImpl } = stubFetch({
      "conversations.list": () => ({
        body: {
          ok: true,
          channels: [
            { id: "D0BAHDUEC81", is_im: true, user: "USLACK" },
            { id: "D1", is_im: true, user: "U_OTHER" },
          ],
        },
      }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    expect(await reader.listConversations()).toEqual([{ id: "D1", type: "im", counterpartyUserId: "U_OTHER" }]);
  });
});

describe("createSlackReader — history", () => {
  it("maps ts/user/botId and parses mentions from text (text itself never returned)", async () => {
    const { fetchImpl } = stubFetch({
      "conversations.history": () => ({
        body: {
          ok: true,
          messages: [
            { ts: "1700000002.000100", user: "U_OTHER", text: "hey <@U_BENDIK> got a sec?" },
            { ts: "1700000001.000100", bot_id: "B123", text: "automated notice" },
          ],
          has_more: false,
        },
      }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    const page = await reader.history("C1", undefined, undefined);
    expect(page.messages).toEqual([
      { ts: "1700000002.000100", user: "U_OTHER", botId: undefined, mentions: ["U_BENDIK"], threadHasOwnReply: false, threadReplies: [] },
      { ts: "1700000001.000100", user: undefined, botId: "B123", mentions: [], threadHasOwnReply: false, threadReplies: [] },
    ]);
    for (const m of page.messages) expect(m).not.toHaveProperty("text");
    expect(page.nextCursor).toBeNull();
  });

  it("computes threadHasOwnReply=true only when ownUserId is among the thread's replies", async () => {
    const { fetchImpl, calls } = stubFetch({
      "conversations.history": () => ({
        body: {
          ok: true,
          messages: [{ ts: "1700000000.000100", user: "U_OTHER", thread_ts: "1700000000.000100", reply_count: 2 }],
          has_more: false,
        },
      }),
      "conversations.replies": () => ({
        body: {
          ok: true,
          messages: [
            { ts: "1700000000.000100", user: "U_OTHER" }, // parent, excluded
            { ts: "1700000010.000100", user: "U_THIRD" },
            { ts: "1700000020.000100", user: OWN },
          ],
        },
      }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    const page = await reader.history("C1", undefined, undefined);
    expect(page.messages[0]!.threadHasOwnReply).toBe(true);
    const repliesCall = calls.find((c) => c.url.includes("conversations.replies"));
    expect(repliesCall!.params.get("channel")).toBe("C1");
    expect(repliesCall!.params.get("ts")).toBe("1700000000.000100");
  });

  it("ORB-149 defect 2: returns the thread's replies on the parent and reports the .replies request count", async () => {
    const { fetchImpl } = stubFetch({
      "conversations.history": () => ({
        body: {
          ok: true,
          messages: [{ ts: "1700000000.000100", user: "U_OTHER", thread_ts: "1700000000.000100", reply_count: 2 }],
          has_more: false,
        },
      }),
      "conversations.replies": () => ({
        body: {
          ok: true,
          messages: [
            { ts: "1700000000.000100", user: "U_OTHER", text: "the parent" }, // [0] is the parent — excluded
            { ts: "1700000010.000100", user: "U_THIRD", text: "a reply" },
            { ts: "1700000020.000100", bot_id: "B9", text: "a bot reply" },
          ],
        },
      }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    const page = await reader.history("C1", undefined, undefined);

    expect(page.messages[0]!.threadReplies).toEqual([
      { ts: "1700000010.000100", user: "U_THIRD", botId: undefined },
      { ts: "1700000020.000100", user: undefined, botId: "B9" },
    ]);
    // signals only: no message text ever leaves this module, replies included
    for (const r of page.messages[0]!.threadReplies) expect(r).not.toHaveProperty("text");
    expect(page.repliesRequests).toBe(1);
  });

  it("ORB-149 defect 2: thread replies get the same subtype allowlist and system-user botId mapping as top-level messages", async () => {
    const { fetchImpl } = stubFetch({
      "conversations.history": () => ({
        body: {
          ok: true,
          messages: [{ ts: "1.0", user: "U_OTHER", thread_ts: "1.0", reply_count: 3 }],
          has_more: false,
        },
      }),
      "conversations.replies": () => ({
        body: {
          ok: true,
          messages: [
            { ts: "1.0", user: "U_OTHER" }, // parent
            { ts: "2.0", user: "U_JOINER", subtype: "channel_join" }, // not a real message — dropped
            { ts: "3.0", user: "USLACKBOT" }, // Slack's own system user — synthetic botId
            { ts: "4.0", user: "U_THIRD", subtype: "thread_broadcast" }, // an allowlisted subtype — kept
          ],
        },
      }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    const page = await reader.history("C1", undefined, undefined);

    expect(page.messages[0]!.threadReplies).toEqual([
      { ts: "3.0", user: "USLACKBOT", botId: "USLACKBOT" },
      { ts: "4.0", user: "U_THIRD", botId: undefined },
    ]);
  });

  it("ORB-149 defect 3: an invalid_cursor answer throws the typed SlackInvalidCursorError, not a generic SlackApiError", async () => {
    const { fetchImpl } = stubFetch({
      "conversations.history": () => ({ body: { ok: false, error: "invalid_cursor" } }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    await expect(reader.history("C1", undefined, "dGVhbTpDMDAwMA==")).rejects.toBeInstanceOf(SlackInvalidCursorError);
  });

  it("does NOT call conversations.replies for a message with no thread", async () => {
    const { fetchImpl, calls } = stubFetch({
      "conversations.history": () => ({
        body: { ok: true, messages: [{ ts: "1700000000.000100", user: "U_OTHER" }], has_more: false },
      }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    await reader.history("C1", undefined, undefined);
    expect(calls.some((c) => c.url.includes("conversations.replies"))).toBe(false);
  });

  it("follows pagination via has_more + response_metadata.next_cursor, and forwards oldest/cursor", async () => {
    const { fetchImpl, calls } = stubFetch({
      "conversations.history": () => ({
        body: { ok: true, messages: [{ ts: "1700000005.000100", user: "U_OTHER" }], has_more: true, response_metadata: { next_cursor: "abc" } },
      }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    const page = await reader.history("C1", "1699999999.000000", "prevcursor");
    expect(page.nextCursor).toBe("abc");
    expect(calls[0]!.params.get("oldest")).toBe("1699999999.000000");
    expect(calls[0]!.params.get("cursor")).toBe("prevcursor");
  });

  it("429 becomes SlackRateLimitError with retryAfterSeconds from the Retry-After header, after exhausting bounded retries", async () => {
    const { fetchImpl } = stubFetch({
      "conversations.history": () => ({ status: 429, headers: { "Retry-After": "17" }, body: { ok: false, error: "ratelimited" } }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl, sleepImpl: async () => {} });
    await expect(reader.history("C1", undefined, undefined)).rejects.toMatchObject(
      new SlackRateLimitError(17),
    );
    await expect(reader.history("C1", undefined, undefined)).rejects.toBeInstanceOf(SlackRateLimitError);
  });

  it("drops non-real Slack subtypes (Important 4) but keeps the allowlisted ones", async () => {
    const { fetchImpl } = stubFetch({
      "conversations.history": () => ({
        body: {
          ok: true,
          messages: [
            { ts: "3.0", user: "U_OTHER", subtype: "group_join" }, // system event — dropped
            { ts: "2.0", user: "U_OTHER", subtype: "me_message" }, // real message — kept
            { ts: "1.0", user: "U_OTHER" }, // ordinary message, no subtype — kept
          ],
          has_more: false,
        },
      }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    const page = await reader.history("C1", undefined, undefined);
    expect(page.messages.map((m) => m.ts)).toEqual(["2.0", "1.0"]);
  });

  it("BLOCKING (round 3): keeps paging internally when a whole page filters to empty and has_more is true, until a real message survives", async () => {
    const { fetchImpl, calls } = stubFetch({
      "conversations.history": (allCalls) => {
        const n = allCalls.filter((c) => c.url.includes("conversations.history")).length;
        if (n === 1) {
          // page 1: entirely system events — filters to zero, but Slack says there's more.
          // The OLD bug: returning {messages:[], nextCursor:"c2"} here would make importSlack
          // treat the conversation as exhausted BEFORE ever looking at nextCursor, silently
          // promoting the high-water mark past every real message still behind this page.
          return {
            body: {
              ok: true,
              messages: [
                { ts: "3.0", user: "U_A", subtype: "channel_join" },
                { ts: "2.0", user: "U_B", subtype: "group_join" },
              ],
              has_more: true,
              response_metadata: { next_cursor: "c2" },
            },
          };
        }
        // page 2: a real message, end of history.
        return { body: { ok: true, messages: [{ ts: "1.0", user: "U_OTHER" }], has_more: false } };
      },
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    const page = await reader.history("C1", undefined, undefined);
    expect(page.messages.map((m) => m.ts)).toEqual(["1.0"]);
    expect(page.nextCursor).toBeNull();
    const historyCalls = calls.filter((c) => c.url.includes("conversations.history"));
    expect(historyCalls).toHaveLength(2);
    expect(historyCalls[1]!.params.get("cursor")).toBe("c2");
  });

  it("BLOCKING (round 3): a page that filters to empty with has_more FALSE returns messages:[] and nextCursor:null — genuinely exhausted, no bug", async () => {
    const { fetchImpl, calls } = stubFetch({
      "conversations.history": () => ({
        body: { ok: true, messages: [{ ts: "1.0", user: "U_A", subtype: "channel_join" }], has_more: false },
      }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    const page = await reader.history("C1", undefined, undefined);
    expect(page).toEqual({ messages: [], nextCursor: null });
    // Must NOT have made a second call chasing a cursor that doesn't exist.
    expect(calls.filter((c) => c.url.includes("conversations.history"))).toHaveLength(1);
  });

  it("BLOCKING (round 3): throws rather than looping unboundedly past MAX_CONSECUTIVE_EMPTY_HISTORY_PAGES", async () => {
    const { fetchImpl } = stubFetch({
      "conversations.history": (allCalls) => {
        const n = allCalls.filter((c) => c.url.includes("conversations.history")).length;
        return {
          body: {
            ok: true,
            messages: [{ ts: `${n}.0`, user: "U_A", subtype: "channel_join" }],
            has_more: true,
            response_metadata: { next_cursor: `c${n + 1}` },
          },
        };
      },
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    await expect(reader.history("C1", undefined, undefined)).rejects.toThrow(/consecutive/);
  });

  it("maps a Slackbot-authored message to a synthetic botId (final review, Important 1) — carries a real user, no bot_id", async () => {
    const { fetchImpl } = stubFetch({
      "conversations.history": () => ({
        body: {
          ok: true,
          messages: [
            { ts: "2.0", user: "USLACKBOT", text: "a reminder fired" },
            { ts: "1.0", user: "U_OTHER", text: "an ordinary message" },
          ],
          has_more: false,
        },
      }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    const page = await reader.history("C1", undefined, undefined);
    expect(page.messages[0]).toMatchObject({ user: "USLACKBOT", botId: "USLACKBOT" });
    expect(page.messages[1]).toMatchObject({ user: "U_OTHER", botId: undefined });
  });

  it("maps a USLACK-authored channel message to a synthetic botId (ORB-149 gap-closing) — importer's bot-skip then drops it", async () => {
    const { fetchImpl } = stubFetch({
      "conversations.history": () => ({
        body: {
          ok: true,
          messages: [
            { ts: "2.0", user: "USLACK", text: "a system notice" },
            { ts: "1.0", user: "U_OTHER", text: "an ordinary message" },
          ],
          has_more: false,
        },
      }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    const page = await reader.history("C1", undefined, undefined);
    expect(page.messages[0]).toMatchObject({ user: "USLACK", botId: "USLACK" });
    expect(page.messages[1]).toMatchObject({ user: "U_OTHER", botId: undefined });
    // Mirrors the importer's own guard (services/network/lib/importers/slack.ts):
    // `if (!m.user || m.botId) continue` drops the USLACK message, keeps the human one.
    const kept = page.messages.filter((m) => m.user && !m.botId);
    expect(kept).toEqual([{ ts: "1.0", user: "U_OTHER", botId: undefined, mentions: [], threadHasOwnReply: false, threadReplies: [] }]);
  });

  it("never walks .replies for a conversation registered as im or mpim (Important 1)", async () => {
    const { fetchImpl, calls } = stubFetch({
      "conversations.list": () => ({
        body: { ok: true, channels: [{ id: "D1", is_im: true, user: "U_OTHER" }, { id: "G1", is_mpim: true }] },
      }),
      "conversations.members": () => ({ body: { ok: true, members: ["U_OTHER", OWN] } }),
      "conversations.history": () => ({
        body: {
          ok: true,
          messages: [{ ts: "1.0", user: "U_OTHER", thread_ts: "1.0", reply_count: 3 }],
          has_more: false,
        },
      }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    await reader.listConversations(); // registers D1 as im, G1 as mpim in the reader's kind cache
    await reader.history("D1", undefined, undefined);
    await reader.history("G1", undefined, undefined);
    expect(calls.some((c) => c.url.includes("conversations.replies"))).toBe(false);
  });

  it("fetches .replies sequentially, never concurrently, for multiple thread parents on one page (Important 1)", async () => {
    // Needs a REAL async gap inside the .replies handler (setTimeout, not a synchronous
    // return) — otherwise a single-threaded JS engine can never reveal overlap regardless of
    // whether the caller used Promise.all or a sequential loop, making the assertion vacuous.
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("conversations.history")) {
        return new Response(
          JSON.stringify({
            ok: true,
            messages: [
              { ts: "2.0", user: "U_OTHER", thread_ts: "2.0", reply_count: 1 },
              { ts: "1.0", user: "U_OTHER", thread_ts: "1.0", reply_count: 1 },
            ],
            has_more: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return new Response(
        JSON.stringify({ ok: true, messages: [{ ts: "0.0", user: "U_OTHER" }, { ts: "0.5", user: OWN }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as SlackFetch;
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    await reader.history("C1", undefined, undefined);
    expect(maxInFlight).toBe(1);
  });
});

describe("createSlackReader — getUserInfo", () => {
  it("populates email and displayName from Slack's profile shape", async () => {
    const { fetchImpl, calls } = stubFetch({
      "users.info": () => ({
        body: { ok: true, user: { id: "U_OTHER", profile: { email: "lars@partner.example", display_name: "Lars" }, real_name: "Lars Eriksen" } },
      }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    expect(await reader.getUserInfo("U_OTHER")).toEqual({ id: "U_OTHER", email: "lars@partner.example", displayName: "Lars" });
    expect(calls[0]!.params.get("user")).toBe("U_OTHER");
  });

  it("degrades to a name-only contact when users:read.email has nothing on file (D3)", async () => {
    const { fetchImpl } = stubFetch({
      "users.info": () => ({ body: { ok: true, user: { id: "U_GUEST", profile: { display_name: "Guest Person" } } } }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    expect(await reader.getUserInfo("U_GUEST")).toEqual({ id: "U_GUEST", email: null, displayName: "Guest Person" });
  });

  it("returns null for a deactivated/unknown user rather than throwing", async () => {
    const { fetchImpl } = stubFetch({
      "users.info": () => ({ body: { ok: false, error: "user_not_found" } }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    expect(await reader.getUserInfo("U_GONE")).toBeNull();
  });

  it("429 on users.info still becomes SlackRateLimitError, not null, after exhausting bounded retries", async () => {
    const { fetchImpl } = stubFetch({
      "users.info": () => ({ status: 429, headers: { "Retry-After": "5" }, body: { ok: false } }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl, sleepImpl: async () => {} });
    await expect(reader.getUserInfo("U_X")).rejects.toBeInstanceOf(SlackRateLimitError);
  });

  it("also treats 'users_not_found' (plural) as a genuine no-such-user", async () => {
    const { fetchImpl } = stubFetch({ "users.info": () => ({ body: { ok: false, error: "users_not_found" } }) });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    expect(await reader.getUserInfo("U_GONE")).toBeNull();
  });

  it("rethrows a real failure instead of returning null (Critical 2) — missing_scope must never look like 'no such user'", async () => {
    const { fetchImpl } = stubFetch({ "users.info": () => ({ body: { ok: false, error: "missing_scope" } }) });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    const err = await reader.getUserInfo("U_ANYONE").catch((e) => e);
    expect(err).toBeInstanceOf(SlackApiError);
    expect((err as SlackApiError).code).toBe("missing_scope");
  });

  it("rethrows invalid_auth (a revoked/bad token) rather than degrading to null", async () => {
    const { fetchImpl } = stubFetch({ "users.info": () => ({ body: { ok: false, error: "invalid_auth" } }) });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    await expect(reader.getUserInfo("U_ANYONE")).rejects.toBeInstanceOf(SlackApiError);
  });

  it("closes the app-DM door: an is_bot user (Google Drive, GitHub, …) resolves to null, not a contact (ORB-149 closing fix 1)", async () => {
    const { fetchImpl } = stubFetch({
      "users.info": () => ({
        body: { ok: true, user: { id: "U_APP_BOT", is_bot: true, profile: { email: "noreply@google.com", display_name: "Google Drive" } } },
      }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    expect(await reader.getUserInfo("U_APP_BOT")).toBeNull();
  });

  it("an ordinary human counterparty (is_bot absent/false) still resolves normally", async () => {
    const { fetchImpl } = stubFetch({
      "users.info": () => ({
        body: { ok: true, user: { id: "U_OTHER", is_bot: false, profile: { email: "lars@partner.example", display_name: "Lars" } } },
      }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    expect(await reader.getUserInfo("U_OTHER")).toEqual({ id: "U_OTHER", email: "lars@partner.example", displayName: "Lars" });
  });

  it("widens the guard to is_app_user: resolves to null even when is_bot is falsy (ORB-149 gap-closing, USLACK's shape)", async () => {
    const { fetchImpl } = stubFetch({
      "users.info": () => ({
        body: {
          ok: true,
          user: { id: "USLACK", is_bot: false, is_app_user: true, profile: { display_name: "Slack" } },
        },
      }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    expect(await reader.getUserInfo("USLACK")).toBeNull();
  });

  it("an ordinary human counterparty (is_app_user absent/false too) still resolves normally", async () => {
    const { fetchImpl } = stubFetch({
      "users.info": () => ({
        body: {
          ok: true,
          user: { id: "U_OTHER", is_bot: false, is_app_user: false, profile: { email: "lars@partner.example", display_name: "Lars" } },
        },
      }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl });
    expect(await reader.getUserInfo("U_OTHER")).toEqual({ id: "U_OTHER", email: "lars@partner.example", displayName: "Lars" });
  });
});

describe("createSlackReader — 429 retry (final review, Important 3)", () => {
  it("retries with the injected sleepImpl, honouring Retry-After, and succeeds once Slack recovers", async () => {
    const sleepCalls: number[] = [];
    const sleepImpl = async (ms: number) => {
      sleepCalls.push(ms);
    };
    let attempt = 0;
    const { fetchImpl } = stubFetch({
      "conversations.history": () => {
        attempt++;
        if (attempt <= 2) return { status: 429, headers: { "Retry-After": "5" }, body: { ok: false, error: "ratelimited" } };
        return { body: { ok: true, messages: [{ ts: "1.0", user: "U_OTHER" }], has_more: false } };
      },
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl, sleepImpl });
    const page = await reader.history("C1", undefined, undefined);
    expect(page.messages).toHaveLength(1);
    expect(sleepCalls).toEqual([5000, 5000]);
  });

  it("caps the sleep at MAX_RATE_LIMIT_WAIT_SECONDS even when Slack's Retry-After asks for longer — never sleeps unbounded", async () => {
    const sleepCalls: number[] = [];
    const sleepImpl = async (ms: number) => {
      sleepCalls.push(ms);
    };
    let attempt = 0;
    const { fetchImpl } = stubFetch({
      "conversations.history": () => {
        attempt++;
        if (attempt === 1) return { status: 429, headers: { "Retry-After": "999" }, body: { ok: false } };
        return { body: { ok: true, messages: [{ ts: "1.0", user: "U_OTHER" }], has_more: false } };
      },
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl, sleepImpl });
    await reader.history("C1", undefined, undefined);
    expect(sleepCalls).toEqual([60_000]); // capped, not 999_000
  });

  it("gives up and throws SlackRateLimitError after exactly MAX_RATE_LIMIT_RETRIES retries — pinned, not just bounded (ORB-149 closing fix 5)", async () => {
    const sleepCalls: number[] = [];
    const sleepImpl = async (ms: number) => {
      sleepCalls.push(ms);
    };
    const { fetchImpl, calls } = stubFetch({
      "conversations.history": () => ({ status: 429, headers: { "Retry-After": "1" }, body: { ok: false } }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl, sleepImpl });
    await expect(reader.history("C1", undefined, undefined)).rejects.toBeInstanceOf(SlackRateLimitError);
    // Pinned exactly to MAX_RATE_LIMIT_RETRIES (3) — a loose "<= 5" bound would not catch a
    // regression that silently raised the retry ceiling.
    expect(sleepCalls.length).toBe(3);
    const historyCalls = calls.filter((c) => c.url.includes("conversations.history"));
    expect(historyCalls.length).toBe(4); // one extra call after the last sleep, then it gives up
  });

  it("clamps a non-positive Retry-After (0 or negative) to a zero-length sleep instead of a negative one (ORB-149 closing fix 2)", async () => {
    const sleepCalls: number[] = [];
    const sleepImpl = async (ms: number) => {
      sleepCalls.push(ms);
    };
    let attempt = 0;
    const { fetchImpl } = stubFetch({
      "conversations.history": () => {
        attempt++;
        if (attempt === 1) return { status: 429, headers: { "Retry-After": "0" }, body: { ok: false } };
        if (attempt === 2) return { status: 429, headers: { "Retry-After": "-5" }, body: { ok: false } };
        return { body: { ok: true, messages: [{ ts: "1.0", user: "U_OTHER" }], has_more: false } };
      },
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl, sleepImpl });
    await reader.history("C1", undefined, undefined);
    expect(sleepCalls).toEqual([0, 0]); // never negative
  });
});

describe("createSlackReader — run deadline (ORB-149 closing fix 4)", () => {
  it("stops with SlackRateLimitError instead of sleeping once the next wait would cross deadlineAt", async () => {
    const sleepCalls: number[] = [];
    const sleepImpl = async (ms: number) => {
      sleepCalls.push(ms);
    };
    const fixedNow = new Date("2026-08-24T09:30:00.000Z");
    const deadlineAt = new Date("2026-08-24T09:30:10.000Z"); // 10s of budget left
    const { fetchImpl } = stubFetch({
      // Retry-After: 30 would sleep past the 10s remaining before the deadline.
      "conversations.history": () => ({ status: 429, headers: { "Retry-After": "30" }, body: { ok: false } }),
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl, sleepImpl, now: () => fixedNow, deadlineAt });
    await expect(reader.history("C1", undefined, undefined)).rejects.toBeInstanceOf(SlackRateLimitError);
    expect(sleepCalls).toEqual([]); // never slept — the deadline was checked BEFORE the sleep
  });

  it("still retries normally when the wait fits comfortably inside the deadline", async () => {
    const sleepCalls: number[] = [];
    const sleepImpl = async (ms: number) => {
      sleepCalls.push(ms);
    };
    const fixedNow = new Date("2026-08-24T09:30:00.000Z");
    const deadlineAt = new Date("2026-08-24T10:00:00.000Z"); // 30 minutes of budget left
    let attempt = 0;
    const { fetchImpl } = stubFetch({
      "conversations.history": () => {
        attempt++;
        if (attempt === 1) return { status: 429, headers: { "Retry-After": "5" }, body: { ok: false } };
        return { body: { ok: true, messages: [{ ts: "1.0", user: "U_OTHER" }], has_more: false } };
      },
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl, sleepImpl, now: () => fixedNow, deadlineAt });
    const page = await reader.history("C1", undefined, undefined);
    expect(page.messages).toHaveLength(1);
    expect(sleepCalls).toEqual([5000]);
  });

  it("with no deadlineAt set, behaves exactly as before (no deadline check at all)", async () => {
    const sleepCalls: number[] = [];
    const sleepImpl = async (ms: number) => {
      sleepCalls.push(ms);
    };
    let attempt = 0;
    const { fetchImpl } = stubFetch({
      "conversations.history": () => {
        attempt++;
        if (attempt === 1) return { status: 429, headers: { "Retry-After": "5" }, body: { ok: false } };
        return { body: { ok: true, messages: [{ ts: "1.0", user: "U_OTHER" }], has_more: false } };
      },
    });
    const reader = createSlackReader({ token: TOKEN, ownUserId: OWN, fetchImpl, sleepImpl });
    const page = await reader.history("C1", undefined, undefined);
    expect(page.messages).toHaveLength(1);
    expect(sleepCalls).toEqual([5000]);
  });
});
