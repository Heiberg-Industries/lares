import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionNotActiveError } from "eve/sessions";

// eve's own handler for a tap on a card: an INTERNAL, reached on purpose through the alias in
// vitest.config.ts. This suite pins what eve 1.0.0-rc.9 does BY ITSELF when a tap cannot be
// delivered; Lares no longer patches this path. If an eve upgrade moves the file, the import
// failing is the signal to re-read the behaviour and this file's header.
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { handleInteractionPost } from "eve-internals/slack-interactions";

/**
 * A tap on a Slack card that cannot be delivered. Two cases, and eve 1.0 treats them differently.
 *
 * 1. THE CONVERSATION IS GONE (it ended, or was never filed at the address the tap carries).
 *    eve retires the card in place: the buttons go, the card reads "No longer active", and the
 *    person who tapped is told, in a message only they see, "This request is no longer active.
 *    Send a new message to start again." Nothing runs. This is the behaviour Lares used to add
 *    with a framework patch; the framework now does it, so the patch is dropped.
 *
 * 2. A PASSING FAILURE (the database is down, a timeout: anything that is not "no such
 *    conversation"). eve writes one log line and does NOTHING the person can see: the card keeps
 *    its buttons and no notice is posted.
 *
 *    THIS IS A KNOWN GAP, ACCEPTED. The old patch posted "not executed" with the reason in the
 *    thread. On eve 1.0 the person sees a tap that did nothing and has to tap again. The upside
 *    of eve's choice is that the card stays answerable, so a second tap after the fault clears
 *    does work. The test below pins the gap so that it is a recorded decision, and so that an eve
 *    release which starts telling the person shows up as a failing test to be read, not as a
 *    surprise.
 *
 * The Telegram half of the old file is gone from here: the Telegram door's packet tests its own.
 */

const OWNER_USER_ID = "U0000000000";
const DM_CHANNEL_ID = "D0000000000";
const CARD_TS = "1700000000.000200";
const THREAD_TS = "1700000000.000100";
const ACTION_ID = "eve_input:tool-approval:interaction-1";

/** What a Lares approval card looks like when it is tapped: eve's card block with the two
 *  buttons, and the draft section Lares's renderer adds under it. */
const CARD_BLOCKS = [
  {
    type: "card",
    body: { type: "mrkdwn", text: "*Send email to taylor@example.com*", verbatim: false },
    subtext: { type: "mrkdwn", text: "I've paused until someone approves or denies." },
    actions: [
      { type: "button", action_id: `${ACTION_ID}:button:0`, value: "deny", text: { type: "plain_text", text: "Deny", emoji: false } },
      { type: "button", action_id: `${ACTION_ID}:button:1`, value: "approve", style: "primary", text: { type: "plain_text", text: "Approve", emoji: false } },
    ],
  },
  { type: "section", text: { type: "mrkdwn", text: "*Subject:* Notes from today\n\nThanks for the meeting." } },
];

function tapBody(): string {
  const payload = {
    type: "block_actions",
    team: { id: "T0000000000" },
    user: { id: OWNER_USER_ID, username: "owner", name: "owner" },
    channel: { id: DM_CHANNEL_ID },
    message: { ts: CARD_TS, thread_ts: THREAD_TS, blocks: CARD_BLOCKS },
    actions: [{
      action_id: `${ACTION_ID}:button:1`,
      block_id: "b1",
      type: "button",
      value: "approve",
      text: { type: "plain_text", text: "Approve" },
    }],
  };
  return "payload=" + encodeURIComponent(JSON.stringify(payload));
}

interface SlackCall { method: string; body: Record<string, unknown> }

/** A fake Slack Web API that records each call. eve form-encodes, with `blocks` as JSON text. */
function fakeSlack(calls: SlackCall[]) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(init?.body ?? "");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      body = Object.fromEntries(new URLSearchParams(raw));
    }
    calls.push({ method: String(url).split("/").pop()!, body });
    return new Response(JSON.stringify({ ok: true, ts: "1700000000.000300" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
}

describe("a tap on a Slack card that cannot be delivered (eve 1.0.0-rc.9, unpatched)", () => {
  const realFetch = globalThis.fetch;
  let calls: SlackCall[];
  let pending: Promise<unknown>[];
  let delivered: number;

  beforeEach(() => {
    calls = [];
    pending = [];
    delivered = 0;
    globalThis.fetch = fakeSlack(calls) as unknown as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  async function tap(respond: () => Promise<unknown>) {
    await handleInteractionPost(tapBody(), {
      from: () => ({ respond: async () => { await respond(); delivered += 1; } }),
      resolveSession: async () => undefined,
      waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    }, {
      config: { credentials: { botToken: async () => "xoxb-test" } },
      // eve's own default, which `slackChannel()` installs when a door sets none.
      onAnswers: ({ defaultAuth }: { defaultAuth: unknown }) => ({ auth: defaultAuth }),
    });
    await Promise.all(pending);
  }

  const blocksOf = (call: SlackCall | undefined): string =>
    typeof call?.body["blocks"] === "string" ? call.body["blocks"] : JSON.stringify(call?.body["blocks"] ?? "");

  it("the conversation is gone: the card is retired as \"No longer active\" and the person who tapped is told", async () => {
    await tap(() => Promise.reject(new SessionNotActiveError()));

    expect(delivered, "nothing was approved").toBe(0);

    const update = calls.find((c) => c.method === "chat.update");
    expect(update, "the card is repainted in place").toBeDefined();
    expect(update!.body["channel"]).toBe(DM_CHANNEL_ID);
    expect(update!.body["ts"]).toBe(CARD_TS);
    expect(update!.body["text"]).toBe("No longer active");
    const repainted = blocksOf(update);
    expect(repainted).toContain("No longer active");
    expect(repainted, "the buttons are gone, so the dead card cannot be tapped again").not.toContain("eve_input:");
    expect(repainted, "the draft the card was about stays readable").toContain("Thanks for the meeting.");

    const notice = calls.find((c) => c.method === "chat.postEphemeral");
    expect(notice, "the person is told, in a message only they see").toBeDefined();
    expect(notice!.body["user"]).toBe(OWNER_USER_ID);
    expect(notice!.body["channel"]).toBe(DM_CHANNEL_ID);
    expect(JSON.stringify(notice!.body)).toContain("This request is no longer active. Send a new message to start again.");

    expect(calls.filter((c) => c.method === "chat.postMessage"), "nothing is posted for everyone to see").toEqual([]);
  });

  it("KNOWN GAP, accepted: a passing failure is only logged; the person sees nothing and the card keeps its buttons", async () => {
    const error = vi.mocked(console.error);
    await tap(() => Promise.reject(new Error("connection terminated unexpectedly")));

    expect(delivered).toBe(0);
    expect(calls, "no repaint, no notice, no message: nothing the person can see").toEqual([]);
    expect(
      error.mock.calls.some((args) => args.some((a) => String(a).includes("input response delivery failed"))),
      "the one trace is eve's log line",
    ).toBe(true);
  });

  it("a tap that is delivered leaves the card alone here: the repaint comes from the conversation, not from the tap", async () => {
    await tap(() => Promise.resolve(undefined));

    expect(delivered).toBe(1);
    expect(calls).toEqual([]);
  });
});
