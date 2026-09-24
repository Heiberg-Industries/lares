import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Direct file imports (bypassing the package exports map) — these are eve INTERNALS,
// reached on purpose: this suite pins the behaviour of our pnpm patch on eve@0.60.1
// (patches/eve.patch). If an eve upgrade moves these files, this suite failing
// to import is the signal to re-derive the patch against the new version.
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { handleInteractionPost } from "eve-internals/slack-interactions";
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { telegramChannel } from "eve-internals/telegram-channel";

/**
 * THE DEFECT (measured live 2026-08-17, Jonas/Finago approval card): a 👍/👎 approval
 * card whose session no longer resolves via continuation token turns into a dead button.
 * eve logs "HITL interaction delivery failed" server-side, gives the clicker NO feedback,
 * and (Slack) still repaints the card as answered. The approved tool never runs.
 *
 * Our patch makes both channels answer back in-channel when delivery fails, and stops
 * Slack from marking an unanswered card as answered.
 *
 * WHAT THE NOTICE MAY SAY (ORB-161). It used to assert "the agent restarted since it was
 * posted" on ANY delivery failure. That was a hard-coded guess, and live on 2026-08-24 it
 * was simply false — the container's RestartCount was 0 and the card was posted 11 minutes
 * after start. The real cause was an address mismatch (see
 * tests/eve-slack-schedule-card-address.test.ts). A wrong diagnosis printed to a human is
 * worse than a raw error: it invites a shrug and a re-trigger that fails the same way. So
 * the notice now reports the failure and quotes the actual reason, and these tests pin
 * that it never again invents a cause.
 */

const SESSION_NOT_FOUND = new Error(
  "Cannot deliver inputResponses — the target session was not found via continuation token.",
);

// ─── Slack ──────────────────────────────────────────────────────────────────────────────────

function slackBlockActionsBody(): string {
  const payload = {
    type: "block_actions",
    team: { id: "T1" },
    user: { id: "U1", username: "bendik", name: "bendik" },
    channel: { id: "C1" },
    message: { ts: "111.222", thread_ts: "111.000", blocks: [] },
    actions: [{
      action_id: "eve_input:req-1",
      block_id: "b1",
      selected_option: { value: "approve", text: { type: "plain_text", text: "Approve" } },
    }],
  };
  return "payload=" + encodeURIComponent(JSON.stringify(payload));
}

interface FetchCall { url: string; body: Record<string, unknown> }

function captureFetch(calls: FetchCall[]) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
}

describe("Slack HITL click whose session is gone (patched eve@0.60.1)", () => {
  const realFetch = globalThis.fetch;
  let calls: FetchCall[];
  let pending: Promise<unknown>[];

  beforeEach(() => {
    calls = [];
    pending = [];
    globalThis.fetch = captureFetch(calls) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function ctx(respond: () => Promise<unknown>) {
    return {
      from: () => ({ respond }),
      resolveSession: async () => undefined,
      waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    };
  }

  // eve 0.60 routes every HITL click through `deps.onInputResponse` before delivering it, so a
  // deps object without one authorises nothing and the click is dropped silently. This is eve's
  // own `defaultOnInputResponse`, which is what `slackChannel()` installs when a channel does
  // not override it.
  const deps = {
    config: { credentials: { botToken: async () => "xoxb-test" } },
    onInputResponse: ({ defaultAuth }: { defaultAuth: unknown }) => ({ auth: defaultAuth }),
  };

  it("posts a failure notice in the thread and does NOT repaint the card as answered", async () => {
    await handleInteractionPost(
      slackBlockActionsBody(),
      ctx(() => Promise.reject(SESSION_NOT_FOUND)),
      deps,
    );
    await Promise.allSettled(pending);

    const postMessage = calls.find((c) => c.url.includes("chat.postMessage"));
    expect(postMessage, "expected an in-thread notice after failed delivery").toBeDefined();
    expect(postMessage!.body.channel).toBe("C1");
    expect(postMessage!.body.thread_ts).toBe("111.000");
    expect(String(postMessage!.body.text)).toMatch(/not executed/i);
    expect(String(postMessage!.body.text)).toContain(SESSION_NOT_FOUND.message);
    expect(
      String(postMessage!.body.text),
      "the notice must not diagnose a cause it cannot observe (ORB-161)",
    ).not.toMatch(/restart/i);

    expect(
      calls.find((c) => c.url.includes("chat.update")),
      "card must NOT be repainted as answered when delivery failed",
    ).toBeUndefined();
  });

  it("normal path unchanged: successful delivery repaints the card, no notice posted", async () => {
    await handleInteractionPost(
      slackBlockActionsBody(),
      ctx(() => Promise.resolve(undefined)),
      deps,
    );
    await Promise.allSettled(pending);

    expect(calls.find((c) => c.url.includes("chat.update"))).toBeDefined();
    expect(calls.find((c) => c.url.includes("chat.postMessage"))).toBeUndefined();
  });
});

// ─── Telegram ───────────────────────────────────────────────────────────────────────────────

describe("Telegram HITL callback whose session is gone (patched eve@0.60.1)", () => {
  const realFetch = globalThis.fetch;
  let calls: FetchCall[];

  beforeEach(() => {
    calls = [];
    globalThis.fetch = captureFetch(calls) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function callbackRequest(): Request {
    return new Request("http://localhost/eve/v1/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "shh",
      },
      body: JSON.stringify({
        update_id: 1,
        callback_query: {
          id: "cbq-1",
          from: { id: 99, is_bot: false, first_name: "Bendik" },
          message: { message_id: 5, date: 0, chat: { id: 99, type: "private" }, text: "card" },
          data: "eve:req-1|approve",
        },
      }),
    });
  }

  async function clickWith(respond: () => Promise<unknown>) {
    const ch = telegramChannel({ credentials: { botToken: "123:abc", webhookSecretToken: "shh" } });
    const handler = ch.routes[0].handler as (req: Request, ctx: unknown) => Promise<Response>;
    const pending: Promise<unknown>[] = [];
    const res = await handler(callbackRequest(), {
      from: () => ({ respond }),
      resolveSession: async () => undefined,
      waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    });
    await Promise.allSettled(pending);
    return res;
  }

  it("sends a visible failure message in the chat when delivery fails", async () => {
    await clickWith(() => Promise.reject(SESSION_NOT_FOUND));

    const sendMessage = calls.find((c) => c.url.includes("/sendMessage"));
    expect(sendMessage, "expected a chat message after failed delivery").toBeDefined();
    expect(String(sendMessage!.body.chat_id)).toBe("99");
    expect(String(sendMessage!.body.text)).toMatch(/not executed/i);
    expect(String(sendMessage!.body.text)).toContain(SESSION_NOT_FOUND.message);
    expect(
      String(sendMessage!.body.text),
      "the notice must not diagnose a cause it cannot observe (ORB-161)",
    ).not.toMatch(/restart/i);
  });

  it("normal path unchanged: successful delivery sends no expiry message", async () => {
    await clickWith(() => Promise.resolve(undefined));
    expect(calls.find((c) => c.url.includes("/sendMessage"))).toBeUndefined();
  });
});
