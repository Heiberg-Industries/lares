/**
 * A signed Slack event pushed through the framework's own Slack route for this role's door, with
 * only the far ends faked: the Slack Web API (`fetch`) and the conversation store (`from(...)`).
 * Everything between (signature check, parsing, deciding it is a mention, building the sender's
 * identity, asking the door's handler) is the framework's and the door's own code.
 *
 * Used by the door's route tests and by the room checks, so the identity those checks read is the
 * one the framework builds, not one written by hand.
 *
 * In this role the door reads no database on this path; the chief of staff copy needs the pool mocked.
 */
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

/** Neutral placeholders; nothing here belongs to a real workspace. */
export const SLACK = {
  team: "T0EXAMPLE",
  app: "A0EXAMPLE",
  agent: "U0AGENT",
  owner: "U0OWNER",
  stranger: "U0STRANGER",
  secret: "test-signing-secret",
} as const;

export interface MentionSpec {
  readonly user: string;
  readonly channel: string;
  readonly text?: string;
  /** Slack's own `app_mention` example carries no `channel_type`; set it only to see what changes. */
  readonly channelType?: string;
}

/** The body of an `app_mention` event, in the shape of Slack's own event documentation. */
export function appMentionBody(spec: MentionSpec): Record<string, unknown> {
  return {
    type: "event_callback",
    team_id: SLACK.team,
    api_app_id: SLACK.app,
    event_id: `Ev${Math.random().toString(36).slice(2)}`,
    event_time: 1700000001,
    authorizations: [{ team_id: SLACK.team, user_id: SLACK.agent, is_bot: true }],
    event: {
      type: "app_mention",
      channel: spec.channel,
      user: spec.user,
      text: spec.text ?? `<@${SLACK.agent}> hello`,
      ts: "1700000001.000100",
      event_ts: "1700000001.000100",
      team: SLACK.team,
      ...(spec.channelType === undefined ? {} : { channel_type: spec.channelType }),
    },
  };
}

/** A direct message event, with the `channel_type: "im"` Slack sends for one. */
export function directMessageBody(spec: { user: string; channel: string; text?: string }): Record<string, unknown> {
  return {
    type: "event_callback",
    team_id: SLACK.team,
    api_app_id: SLACK.app,
    event_id: `Ev${Math.random().toString(36).slice(2)}`,
    event_time: 1700000001,
    authorizations: [{ team_id: SLACK.team, user_id: SLACK.agent, is_bot: true }],
    event: { type: "message", channel_type: "im", channel: spec.channel, user: spec.user, text: spec.text ?? "hello", ts: "1700000001.000100", team: SLACK.team },
  };
}

/** The identity the framework hands the conversation. */
export interface SentAuth {
  readonly authenticator: string;
  readonly principalId: string;
  readonly principalType: string;
  readonly issuer?: string;
  readonly attributes: Record<string, unknown>;
}
export interface SlackCall { readonly method: string; readonly body: Record<string, unknown> }
export interface Delivered {
  readonly sent: { address: string; message: unknown; options: Record<string, unknown> & { auth?: SentAuth } }[];
  readonly answered: unknown[];
  readonly response: Response;
  /** Every Slack Web API call the door made, in order. */
  readonly calls: SlackCall[];
}

export interface DeliverOptions {
  /** What our fake Slack answers for `conversations.info`. This is our belief about Slack. */
  readonly conversationInfo?: Record<string, unknown>;
  /** The people on the door's allow-list; the first is the owner. */
  readonly allowed?: string;
  /** Keep the modules the test file already loaded (a test that mocks or spies on them needs this). */
  readonly keepModules?: boolean;
}

function sign(body: string): Request {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = "v0=" + createHmac("sha256", SLACK.secret).update(`v0:${timestamp}:${body}`).digest("hex");
  return new Request("http://localhost/eve/v1/slack", {
    method: "POST",
    headers: { "content-type": "application/json", "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
    body,
  });
}

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

/** Push one signed event through `routes[0]` of the door's channel and wait for what it started. */
export async function deliverSlackEvent(body: Record<string, unknown>, options: DeliverOptions = {}): Promise<Delivered> {
  const dir = mkdtempSync(join(tmpdir(), "slack-mention-"));
  const realFetch = globalThis.fetch;
  const saved = ["SLACK_ALLOWED_USER_IDS", "SLACK_BOT_TOKEN_FILE", "SLACK_SIGNING_SECRET_FILE"].map((k) => [k, process.env[k]] as const);
  const calls: SlackCall[] = [];
  try {
    writeFileSync(join(dir, "signing-secret"), `${SLACK.secret}\n`, "utf8");
    writeFileSync(join(dir, "bot-token"), "xoxb-test-token\n", "utf8");
    process.env["SLACK_SIGNING_SECRET_FILE"] = join(dir, "signing-secret");
    process.env["SLACK_BOT_TOKEN_FILE"] = join(dir, "bot-token");
    process.env["SLACK_ALLOWED_USER_IDS"] = options.allowed ?? SLACK.owner;
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const method = String(url).split("/").pop()!;
      const raw = String(init?.body ?? "");
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { parsed = Object.fromEntries(new URLSearchParams(raw)); }
      calls.push({ method, body: parsed });
      if (method === "conversations.info") return json(options.conversationInfo ?? { ok: true, channel: { id: String(parsed["channel"]), is_private: false } });
      return json({ ok: true, ts: "1700000000.000900" });
    }) as unknown as typeof fetch;
    if (options.keepModules !== true) vi.resetModules();
    const mod = await import("../../agent/channels/slack.js");
    const route = (mod.default as never as { routes: { handler(request: Request, ctx: unknown): Promise<Response> }[] }).routes[0]!;
    const sent: Delivered["sent"] = [];
    const answered: unknown[] = [];
    const pending: Promise<unknown>[] = [];
    const response = await route.handler(sign(JSON.stringify(body)), {
      from: (address: string) => ({
        send: async (message: unknown, sendOptions: Record<string, unknown>) => { sent.push({ address, message, options: sendOptions }); return { sessionId: "session-1" }; },
        respond: async (answers: unknown) => { answered.push(answers); return {}; },
      }),
      resolveSession: async () => undefined,
      waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    });
    await Promise.all(pending);
    // Anything the door started without awaiting arrives shortly after; read the list once it has.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { sent, answered, response, calls };
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/**
 * The identity the framework builds for the owner's mention in `channel`: the `auth` the door hands
 * to the conversation, as the framework produced it.
 */
export async function frameworkMentionAuth(channel: string, options: Pick<DeliverOptions, "keepModules"> & { user?: string } = {}): Promise<SentAuth> {
  const user = options.user ?? SLACK.owner;
  const { sent } = await deliverSlackEvent(appMentionBody({ user, channel }), { allowed: user, ...(options.keepModules === undefined ? {} : { keepModules: options.keepModules }) });
  if (sent.length !== 1 || sent[0]!.options.auth === undefined) throw new Error(`the mention in ${channel} did not reach the conversation with an identity`);
  return sent[0]!.options.auth;
}
