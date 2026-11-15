import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { slackChannel } from "eve/channels/slack";

// The framework's own handler for a tap on a card: an eve INTERNAL, reached on purpose through
// the alias in vitest.config.ts. If an eve upgrade moves the file, this import failing is the
// signal to re-check the addresses below.
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { handleInteractionPost } from "eve-internals/slack-interactions";

import { routeDelivery } from "../lib/delivery.js";
import {
  SlackDmChannelError,
  resetSlackDmChannelCacheForTests,
  slackDmChannelId,
} from "../lib/slack-dm-channel.js";

/**
 * THE DEFECT, and how it is avoided on eve 1.0.
 *
 * A schedule used to address the owner by Slack USER id: `to(slack, { channelId: "U…" })`. Slack
 * accepts a user id as `chat.postMessage`'s `channel` and delivers into the direct-message
 * channel `D…`, so the card renders. But eve files the conversation under the address it was
 * GIVEN (`U…:<thread>`), and a tap on the card carries the address Slack DELIVERED to
 * (`D…:<thread>`). Nothing was filed there, so the tap reaches no conversation; eve 1.0 retires
 * the card as "No longer active". Approve and Deny both die the same way.
 *
 * eve 0.60 was patched to adopt the channel Slack reported back. That patch is gone. Instead the
 * conversation is STARTED at `D…`: `lib/slack-dm-channel.ts` asks Slack's `conversations.open`
 * for the direct-message channel behind the user id, once, and schedules pass that.
 *
 * This file checks the addresses with eve's own code on both sides (the real channel object for
 * the start and the first post, eve's real tap handler for the click), so a framework change to
 * either side shows up here. What only Slack can say (that `conversations.open` really returns a
 * `D…` id for this app) is `tests/live/slack-dm-channel.live.mts`.
 */

const OWNER_USER_ID = "U0000000000"; // who a schedule wants to reach
const DM_CHANNEL_ID = "D0000000000"; // where Slack delivers, and what a tap carries
const POSTED_TS = "1700000000.000100";

interface FetchCall { url: string; body: Record<string, unknown> }

/** A fake Slack Web API. `chat.postMessage` echoes the RESOLVED channel, as the real one does. */
function fakeSlack(calls: FetchCall[]) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(init?.body ?? "");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      body = Object.fromEntries(new URLSearchParams(raw));
    }
    calls.push({ url: String(url), body });
    return new Response(
      JSON.stringify({ ok: true, channel: DM_CHANNEL_ID, ts: POSTED_TS, message: { ts: POSTED_TS } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

/** `conversations.open` as the lookup calls it, answering with `response`. */
function fakeConversationsOpen(response: Record<string, unknown>) {
  return vi.fn(async (_input: { operation: string; body: unknown }) => response) as never as
    NonNullable<Parameters<typeof slackDmChannelId>[1]>["call"] & ReturnType<typeof vi.fn>;
}

const channel = slackChannel({ credentials: { botToken: async () => "xoxb-test", signingSecret: "test" } });

/** Start a conversation the way `to(slack, { channelId })` does, and return what eve filed. */
async function startConversationAt(channelId: string) {
  const started: { address: string; state: Record<string, unknown> }[] = [];
  const from = (address: string) => ({
    send: async (_message: unknown, options: { state: Record<string, unknown> }) => {
      started.push({ address, state: options.state });
      return { sessionId: "session-1" };
    },
  });
  await channel.receive!({ message: "PROMPT", target: { channelId }, auth: null } as never, { from } as never);
  expect(started).toHaveLength(1);
  return started[0]!;
}

/** Post the conversation's first message, as a turn does, and return every address eve added. */
async function postFirstMessage(state: Record<string, unknown>, address: string): Promise<string[]> {
  const aliases: string[] = [];
  const adapter = (channel as never as { adapter: { createAdapterContext(input: unknown): {
    thread: { post(message: { text: string }): Promise<unknown> };
  } } }).adapter;
  const ctx = adapter.createAdapterContext({
    state,
    session: { id: "session-1", auth: { current: null, initiator: null } },
    ctx: {},
    continuation: { token: address, alias: (token: string) => aliases.push(token) },
  });
  await ctx.thread.post({ text: "Approve this?" });
  return aliases;
}

/** A tap on a card in the owner's direct messages: Slack always reports the `D…` channel. */
function tapBody(userId: string): string {
  const payload = {
    type: "block_actions",
    team: { id: "T0000000000" },
    user: { id: userId, username: "someone", name: "someone" },
    channel: { id: DM_CHANNEL_ID },
    message: { ts: "1700000000.000200", thread_ts: POSTED_TS, blocks: [] },
    actions: [{
      action_id: "eve_input:tool-approval:interaction-1:button:1",
      block_id: "b1",
      type: "button",
      value: "approve",
      text: { type: "plain_text", text: "Approve" },
    }],
  };
  return "payload=" + encodeURIComponent(JSON.stringify(payload));
}

/** Run eve's tap handler and report which conversation address it asked for. */
async function tap(userId: string, onAnswers: (ctx: { defaultAuth: unknown }, submission: { user: { id: string } }) => unknown) {
  const asked: string[] = [];
  const answers: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  await handleInteractionPost(tapBody(userId), {
    from: (address: string) => {
      asked.push(address);
      return { respond: async (given: unknown) => { answers.push(given); } };
    },
    resolveSession: async () => undefined,
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
  }, {
    config: { credentials: { botToken: async () => "xoxb-test" } },
    onAnswers,
  });
  await Promise.all(pending);
  return { asked, answers };
}

const acceptAnyone = (ctx: { defaultAuth: unknown }) => ({ auth: ctx.defaultAuth });

describe("a scheduled card is filed under the address its tap carries", () => {
  const realFetch = globalThis.fetch;
  let calls: FetchCall[];

  beforeEach(() => {
    calls = [];
    globalThis.fetch = fakeSlack(calls) as unknown as typeof fetch;
    resetSlackDmChannelCacheForTests();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("started at the D… id the lookup returned, a tap carrying D… and the thread finds the conversation", async () => {
    const address = await slackDmChannelId(OWNER_USER_ID, {
      call: fakeConversationsOpen({ ok: true, channel: { id: DM_CHANNEL_ID } }),
    });
    expect(address).toBe(DM_CHANNEL_ID);

    const started = await startConversationAt(address);
    expect(started.state["channelId"], "the conversation is addressed to the direct-message channel").toBe(DM_CHANNEL_ID);
    expect(started.address.startsWith(`${DM_CHANNEL_ID}:`)).toBe(true);

    const aliases = await postFirstMessage(started.state, started.address);
    expect(calls.find((c) => c.url.endsWith("chat.postMessage"))?.body["channel"]).toBe(DM_CHANNEL_ID);
    expect(aliases, "the first post files the conversation under channel and thread").toEqual([`${DM_CHANNEL_ID}:${POSTED_TS}`]);

    const { asked, answers } = await tap(OWNER_USER_ID, acceptAnyone);
    expect(asked, "the tap asks for exactly the address the conversation was filed under").toEqual(aliases);
    expect(answers).toHaveLength(1);
  });

  it("the defect it replaces is still there on eve 1.0: started at U…, the same tap asks for an address nothing was filed under", async () => {
    // Not a behaviour we want; a record of WHY the lookup is needed. If a later eve adopts the
    // delivered channel by itself, this fails, and the lookup can be reconsidered.
    const started = await startConversationAt(OWNER_USER_ID);
    const aliases = await postFirstMessage(started.state, started.address);
    expect(aliases).toEqual([`${OWNER_USER_ID}:${POSTED_TS}`]);

    const { asked } = await tap(OWNER_USER_ID, acceptAnyone);
    expect(asked).toEqual([`${DM_CHANNEL_ID}:${POSTED_TS}`]);
    expect(asked).not.toEqual(aliases);
  });
});

describe("the direct-message lookup", () => {
  beforeEach(() => resetSlackDmChannelCacheForTests());

  it("asks Slack's conversations.open for the user id, with the token it was given", async () => {
    const call = fakeConversationsOpen({ ok: true, channel: { id: DM_CHANNEL_ID } });
    const botToken = async () => "xoxb-test";
    await slackDmChannelId(OWNER_USER_ID, { call, botToken });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith({ botToken, operation: "conversations.open", body: { users: OWNER_USER_ID } });
  });

  it("asks once per user id and answers from memory after that", async () => {
    const call = fakeConversationsOpen({ ok: true, channel: { id: DM_CHANNEL_ID } });
    expect(await slackDmChannelId(OWNER_USER_ID, { call })).toBe(DM_CHANNEL_ID);
    expect(await slackDmChannelId(OWNER_USER_ID, { call })).toBe(DM_CHANNEL_ID);
    expect(await slackDmChannelId(` ${OWNER_USER_ID} `, { call })).toBe(DM_CHANNEL_ID);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("shares one request between two sends that start in the same moment", async () => {
    const call = fakeConversationsOpen({ ok: true, channel: { id: DM_CHANNEL_ID } });
    const both = await Promise.all([
      slackDmChannelId(OWNER_USER_ID, { call }),
      slackDmChannelId(OWNER_USER_ID, { call }),
    ]);
    expect(both).toEqual([DM_CHANNEL_ID, DM_CHANNEL_ID]);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("returns an id that already is a direct-message channel without asking Slack", async () => {
    const call = fakeConversationsOpen({ ok: false, error: "should_not_be_called" });
    expect(await slackDmChannelId(DM_CHANNEL_ID, { call })).toBe(DM_CHANNEL_ID);
    expect(call).not.toHaveBeenCalled();
  });

  it("throws with Slack's own error when Slack refuses, and never hands back the user id", async () => {
    const call = fakeConversationsOpen({ ok: false, error: "missing_scope" });
    const failure = await slackDmChannelId(OWNER_USER_ID, { call }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    expect(failure).not.toHaveProperty("value");
    const { error } = failure as { error: unknown };
    expect(error).toBeInstanceOf(SlackDmChannelError);
    expect((error as SlackDmChannelError).slackError).toBe("missing_scope");
    expect((error as Error).message).toContain("missing_scope");
  });

  it("throws when Slack says ok but returns no direct-message channel", async () => {
    for (const response of [
      { ok: true },
      { ok: true, channel: {} },
      { ok: true, channel: { id: "" } },
      { ok: true, channel: { id: OWNER_USER_ID } },
      { ok: true, channel: { id: "C0000000000" } },
    ]) {
      resetSlackDmChannelCacheForTests();
      await expect(slackDmChannelId(OWNER_USER_ID, { call: fakeConversationsOpen(response) }))
        .rejects.toMatchObject({ slackError: "no_direct_message_channel_returned" });
    }
  });

  it("throws when the request itself fails, without repeating what the transport said", async () => {
    const call = vi.fn(async () => { throw new Error("secret file not readable: /some/path"); }) as never;
    const error = await slackDmChannelId(OWNER_USER_ID, { call }).catch((e: unknown) => e as SlackDmChannelError);
    expect(error).toBeInstanceOf(SlackDmChannelError);
    expect((error as SlackDmChannelError).slackError).toBe("request_failed");
    expect((error as Error).message).not.toContain("/some/path");
  });

  it("does not remember a failure: the next send asks again", async () => {
    const refusing = fakeConversationsOpen({ ok: false, error: "ratelimited" });
    await expect(slackDmChannelId(OWNER_USER_ID, { call: refusing })).rejects.toBeInstanceOf(SlackDmChannelError);
    const working = fakeConversationsOpen({ ok: true, channel: { id: DM_CHANNEL_ID } });
    expect(await slackDmChannelId(OWNER_USER_ID, { call: working })).toBe(DM_CHANNEL_ID);
    expect(working).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty user id", async () => {
    await expect(slackDmChannelId("  ")).rejects.toMatchObject({ slackError: "no_user_id" });
  });
});

describe("a routed delivery: who it is for stays the user id, where it starts is the lookup's answer", () => {
  const loaded = {
    definition: {
      name: "chief-of-staff", channels: [],
      doors: [{ kind: "telegram", enabled: true, settings: {} }, { kind: "slack", enabled: true, settings: {} }],
      delivery: { "track-routing": ["slack"] },
    },
    voiceMd: "",
  } as never;
  const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as never;

  it("starts the conversation at the D… id, and keeps identity and the ledger door on the user id", async () => {
    const slackDmChannel = vi.fn(async () => DM_CHANNEL_ID);
    const routed = routeDelivery("track-routing", loaded, { targets: { slack: OWNER_USER_ID }, db, slackDmChannel })!;

    expect(routed.door).toBe("slack");
    // Unchanged: the conversation's identity and the proactivity ledger are keyed on these.
    expect(routed.target).toBe(OWNER_USER_ID);
    expect(routed.doorId).toBe(`slack:${OWNER_USER_ID}`);
    // New: where `to(slack, ...)` has to be pointed.
    expect(await routed.conversationAddress()).toBe(DM_CHANNEL_ID);
    expect(slackDmChannel).toHaveBeenCalledWith(OWNER_USER_ID);
  });

  it("when the lookup fails the address rejects with Slack's error: nothing is posted, nothing falls back to U…", async () => {
    const slackDmChannel = vi.fn(async () => { throw new SlackDmChannelError("missing_scope"); });
    const routed = routeDelivery("track-routing", loaded, { targets: { slack: OWNER_USER_ID }, db, slackDmChannel })!;

    const to = vi.fn();
    // What a sender does: resolve the address, then start the conversation.
    const send = async () => to({ channelId: await routed.conversationAddress() });
    await expect(send()).rejects.toMatchObject({ name: "SlackDmChannelError", slackError: "missing_scope" });
    expect(to, "no conversation is started, so no card is posted").not.toHaveBeenCalled();
  });

  it("Telegram and web chat are untouched: the address is the target, and Slack is never asked", async () => {
    const slackDmChannel = vi.fn(async () => DM_CHANNEL_ID);
    const telegram = routeDelivery("track-routing", { ...(loaded as object), definition: {
      ...(loaded as { definition: object }).definition, delivery: { "track-routing": ["telegram"] } } } as never,
      { targets: { telegram: "123", slack: OWNER_USER_ID }, db, slackDmChannel })!;
    expect(await telegram.conversationAddress()).toBe("123");
    const web = routeDelivery("track-routing", { ...(loaded as object), definition: {
      ...(loaded as { definition: object }).definition, delivery: { "track-routing": ["web"] } } } as never,
      { targets: { slack: OWNER_USER_ID }, db, slackDmChannel })!;
    expect(await web.conversationAddress()).toBe(web.target);
    expect(slackDmChannel).not.toHaveBeenCalled();
  });
});

/**
 * Every place that starts a Slack conversation, found in the source, must point it at the
 * lookup's answer. A static check, in the manner of `schedule-slack-d4.test.ts`: the property is
 * "this call site does not pass a raw id", and reading the call site proves it more directly than
 * running ten schedules against mocks would.
 */
describe("no call site starts a Slack conversation at a raw id", () => {
  const SERVICE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

  function sources(dir: string): string[] {
    return readdirSync(join(SERVICE_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return entry.name.endsWith(".ts") ? [path] : [];
    });
  }

  /** `to(slack, { channelId: <expr> ...` and `rt.to(rt.slack, { channelId: <expr> ...`. */
  const START = /\bto\(\s*(?:rt\.)?slack\s*,\s*\{\s*channelId:\s*([^}]*)\}/g;

  function slackStarts(): { file: string; line: number; address: string }[] {
    return ["agent", "lib", "catalogue"].flatMap(sources).flatMap((file) => {
      const text = readFileSync(join(SERVICE_ROOT, file), "utf8");
      return [...text.matchAll(START)]
        // A mention inside a comment is prose, not a call.
        .filter((m) => !/^\s*(\*|\/\/|\/\*)/.test(text.slice(text.lastIndexOf("\n", m.index) + 1, m.index)))
        .map((m) => ({
          file: relative(".", file),
          line: text.slice(0, m.index).split("\n").length,
          address: m[1]!.trim(),
        }));
    });
  }

  it("finds the call sites it is meant to guard (the pattern is not stale)", () => {
    expect(slackStarts().map((s) => s.file).sort()).toEqual([
      "agent/schedules/track-routing.ts",
      "lib/delivery-send.ts",
    ]);
  });

  it("track-routing starts its Slack conversation at the lookup's answer", () => {
    const [site] = slackStarts().filter((s) => s.file === "agent/schedules/track-routing.ts");
    expect(site?.address).toBe("await slackDmChannelId(target)");
  });

  // NEEDS ANOTHER PACKET. `lib/delivery-send.ts` belongs to the Telegram door's packet. Until its
  // `sendTurn` passes `await routed.conversationAddress()` instead of `routed.target`, every
  // routed Slack conversation is still started at the user id, and its cards cannot be answered.
  // This test is red on purpose until then; the pull request says so at the top.
  it("the routed sender starts its Slack conversation at routed.conversationAddress()", () => {
    const [site] = slackStarts().filter((s) => s.file === "lib/delivery-send.ts");
    expect(site?.address).toBe("await routed.conversationAddress()");
  });
});
