import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Deep imports into eve's dist — eve INTERNALS, reached on purpose. This suite pins the
// behaviour of our pnpm patch on eve@0.60.1 (patches/eve.patch). If an eve upgrade moves
// these files, this suite failing to import is the signal to re-derive the patch.
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { buildSlackBinding } from "eve-internals/slack-api";
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { slackChannel } from "eve-internals/slack-channel";

/**
 * THE DEFECT (ORB-161, measured live 2026-08-24 on an ORB-156 meeting-followup card).
 *
 * Every Slack-pushing schedule addresses Bendik's DM by his USER id — `to(slack, {
 * channelId: allowedSlackUserIds()[0] })`, i.e. `U_EXAMPLE_OWNER`. Slack accepts a user id as
 * `chat.postMessage`'s `channel` and silently delivers into the DM channel `D0BAQRGLSKA`,
 * so the card RENDERS. But the session was filed under the continuation token
 * `U_EXAMPLE_OWNER:<threadTs>`, while the resulting block_actions payload carries the REAL
 * channel — `D0BAQRGLSKA:<threadTs>`. No session was ever filed under that address, so the
 * click died with "the target session was not found via continuation token", on a process
 * that had never restarted.
 *
 * Approve and Cancel both route through the same `.respond(...)`, so a schedule could
 * render a gate but never act on it — for ALL six Slack-pushing schedules
 * (meeting-followup, crm-routing, outreach-reply-watch, email-triage, digest, dream).
 * A schedule-posted Slack card had never been actionable.
 *
 * THE FIX. Slack already returns the channel it actually delivered to in every
 * `chat.postMessage` response, and eve threw it away. Our patch keeps it and files the
 * session under that address too, reusing eve's own `continuation.alias` — the exact mechanism
 * it already uses to adopt a thread root via `onThreadTsChanged`.
 *
 * eve 0.60 removed `continuation.rekey` and replaced it with the ADDITIVE `continuation.alias`
 * (channel contract 19–22: "Continuation rekey was removed; channel extensions must use
 * additive continuation.alias instead"). So the corrected address is ADDED rather than
 * swapped in: the user-id address the card was posted under stays bound as well. Accepted
 * deliberately — an old address that still reaches the conversation is a gentler failure than
 * one that stops resolving mid-conversation.
 */

const USER_ID = "U_EXAMPLE_OWNER";      // what a schedule addresses
const DM_CHANNEL = "D0BAQRGLSKA";   // where Slack actually delivers, and what a click carries
const POSTED_TS = "1787604621.213469";

interface FetchCall { url: string; body: Record<string, unknown> }

/** Slack's real `chat.postMessage` shape: it echoes the RESOLVED channel, not the one asked for. */
function captureFetch(calls: FetchCall[], channel: string = DM_CHANNEL) {
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
      JSON.stringify({ ok: true, channel, ts: POSTED_TS, message: { ts: POSTED_TS } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

describe("Slack binding surfaces the channel Slack actually delivered to", () => {
  const realFetch = globalThis.fetch;
  let calls: FetchCall[];

  beforeEach(() => {
    calls = [];
    globalThis.fetch = captureFetch(calls) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("fires onChannelIdChanged when a post addressed to a user id lands in a DM channel", async () => {
    const seen: string[] = [];
    const { thread } = buildSlackBinding({
      botToken: async () => "xoxb-test",
      channelId: USER_ID,
      threadTs: "",
      teamId: "T1",
      onChannelIdChanged: (id: string) => seen.push(id),
    });

    await thread.post({ text: "card" });

    expect(seen, "the resolved DM channel must be reported back").toEqual([DM_CHANNEL]);
  });

  it("stays silent when the post lands in the channel it was addressed to", async () => {
    globalThis.fetch = captureFetch(calls, "C0B70G3RUGH") as unknown as typeof fetch;
    const seen: string[] = [];
    const { thread } = buildSlackBinding({
      botToken: async () => "xoxb-test",
      channelId: "C0B70G3RUGH",
      threadTs: "",
      teamId: "T1",
      onChannelIdChanged: (id: string) => seen.push(id),
    });

    await thread.post({ text: "hello" });

    expect(seen, "no address correction is needed when Slack agrees").toEqual([]);
  });
});

describe("a schedule-posted card is filed under the address its click will carry", () => {
  const realFetch = globalThis.fetch;
  let calls: FetchCall[];

  beforeEach(() => {
    calls = [];
    globalThis.fetch = captureFetch(calls) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** The adapter context eve builds per turn: `{...channel.context(state, session), state, ctx, session}`. */
  function contextFor(state: Record<string, unknown>) {
    const aliases: string[] = [];
    const session = {
      id: "sess-1",
      auth: { current: null, initiator: null },
      continuation: {
        token: `${state["channelId"] as string}:${(state["threadTs"] as string) ?? ""}`,
        alias: (t: string) => aliases.push(t),
      },
    };
    const channel = slackChannel({ credentials: { botToken: async () => "xoxb-test" } });
    const ctx = channel.adapter.createAdapterContext({ state, session, ctx: {} });
    return { ctx, aliases };
  }

  it("re-files the session under the DM channel, not the user id it was addressed by", async () => {
    // Exactly what `to(slack, { channelId })` leaves behind for a schedule push: the user
    // id as the channel, and NO thread anchor yet.
    const state: Record<string, unknown> = {
      channelId: USER_ID, threadTs: null, teamId: "T1", triggeringUserId: null,
    };
    const { ctx, aliases } = contextFor(state);

    await ctx.thread.post({ text: "Send meeting follow-up …" });

    expect(aliases, "the session must be reachable at the address the click carries").toEqual([
      `${DM_CHANNEL}:${POSTED_TS}`,
    ]);
    expect(state["channelId"], "durable state must hold the real channel").toBe(DM_CHANNEL);
    expect(state["threadTs"]).toBe(POSTED_TS);
  });

  it("leaves a conversation-opened session alone — no new address, no state churn", async () => {
    // An inbound Slack message already carries the real channel and thread, so there is
    // nothing to correct. This is the regression guard on the untouched path.
    const state: Record<string, unknown> = {
      channelId: DM_CHANNEL, threadTs: POSTED_TS, teamId: "T1", triggeringUserId: "U1",
    };
    const { ctx, aliases } = contextFor(state);

    await ctx.thread.post({ text: "on it" });

    expect(aliases).toEqual([]);
    expect(state["channelId"]).toBe(DM_CHANNEL);
    expect(state["threadTs"]).toBe(POSTED_TS);
  });
});
