import {slackDoorVerifier,interceptSlackClaim} from '@lares/agent-kit/door-channels';
import {assertDoorAuthority,managedIdentity} from '@lares/agent-kit/door-authority';
/**
 * The Slack door.
 *
 * Inbound: Slack POSTs events to eve's default Slack path (`/eve/v1/slack`). Any relay or
 * reverse proxy in front of the agent only forwards that request and verifies nothing; Slack's
 * signature is checked here, where the signing secret lives (read from a file on each request,
 * never at module load).
 *
 * Outbound: `@lares/agent-kit/slack-dispatcher` routes Slack's domains through the egress
 * proxy, because the service container's network allows nothing else out.
 */
import { readFileSync } from "node:fs";
import {
  callSlackApi,
  defaultSlackAuth,
  slackChannel,
  type SlackBotToken,
  type SlackMessage,
} from "eve/channels/slack";
import type { SessionContext } from "eve/context";

import { isAllowedSlackUserId } from "../../lib/slack-allowlist.js";
import { getPool } from "@lares/agent-kit/db";
import { installSlackProxyDispatcher } from "@lares/agent-kit/slack-dispatcher";
import { slackUnreadableNote } from "@lares/agent-kit/unreadable-content";
import { continuityAuthAttributes, nativeConversationContinuity } from "../../lib/conversation-continuity.js";
import { markRouteDeclineQuestionSent } from "../../lib/route-decline.js";
import {
  respondToSessionFailed,
  respondToTurnFailed,
  type FailureEventData,
} from "@lares/agent-kit/gateway-budget";

const DEFAULT_BOT_TOKEN_FILE = "/run/secrets/eve-slack-bot-token";
const DEFAULT_SIGNING_SECRET_FILE = "/run/secrets/eve-slack-signing-secret";

/**
 * Reads a secret from disk, on every call. Deliberately uncached and deliberately lazy:
 * `eve build` evaluates this module to compile the agent, and a build — like CI — has no
 * secrets at all. Anything read at module scope fails the image build outright.
 *
 * Errors name the path and never the contents, matching `lib/gateway-provider.ts`.
 */
function readSecret(envVar: string, fallbackPath: string): string {
  if (managedIdentity() && !process.env[envVar]) throw new Error("Managed door credential is not configured");
  const path = process.env[envVar] ?? fallbackPath;
  let value: string;
  try {
    value = readFileSync(path, "utf8").trim();
  } catch {
    throw new Error(`secret file not readable: ${path}`);
  }
  if (value.length === 0) throw new Error(`secret file is empty: ${path}`);
  return value;
}

/**
 * Credentials in the two shapes eve will accept lazily.
 *
 * `botToken` takes eve's documented function form, resolved per call. `signingSecret` is
 * typed as a plain string, so it is a **getter** — eve reads it inside `verifyInbound`,
 * once per inbound request, which keeps the read off the build path. If a future eve
 * version ever destructures credentials at construction instead, this breaks loudly at
 * `eve build` rather than quietly in production, which is the right direction to fail.
 */
export const slackCredentials: {
  botToken: () => Promise<string>;
  readonly signingSecret: string;
  readonly webhookVerifier?: ReturnType<typeof slackDoorVerifier>;
} = {
  botToken: async () => { await assertDoorAuthority("slack"); return readSecret("SLACK_BOT_TOKEN_FILE", DEFAULT_BOT_TOKEN_FILE); },
  get webhookVerifier() { return managedIdentity() ? slackDoorVerifier(() => readSecret("SLACK_SIGNING_SECRET_FILE", DEFAULT_SIGNING_SECRET_FILE)) : undefined; },
  get signingSecret(): string {
    return readSecret("SLACK_SIGNING_SECRET_FILE", DEFAULT_SIGNING_SECRET_FILE);
  },
};

/**
 * One fixed line back to a conversation the door has not accepted yet (the claim confirmation,
 * the "cannot act on that yet" line). The normal credentials refuse the bot token until the
 * owner's claim is applied, which is when these lines are needed, so the token file is read
 * directly. Reachable only from the claim handler, after the signature check, and it sends only
 * the fixed text passed in.
 */
async function replyBeforeClaimApplied(channelId: string, text: string): Promise<void> {
  const res = await callSlackApi({
    botToken: async () => readSecret("SLACK_BOT_TOKEN_FILE", DEFAULT_BOT_TOKEN_FILE),
    operation: "chat.postMessage",
    body: { channel: channelId, text },
  });
  if (!res.ok) throw new Error(`slack reply failed: ${String((res as { error?: unknown }).error)}`);
}

/**
 * Who may start a turn. A valid Slack signature proves only that *Slack* sent the event,
 * not that the person behind it is trusted — and Slack Connect can deliver events from
 * outside the workspace. So this is an explicit allowlist and it fails closed: an unset or
 * blank `SLACK_ALLOWED_USER_IDS` admits nobody.
 *
 * This deliberately stops here rather than reading the identity registry. Canonical-principal
 * resolution (`U-EXAMPLE-ID` → the owner) is separate work, and it carries
 * a trap worth restating: principal ids are also channel addresses — canonicalise the
 * *person*, never rewrite channel addresses.
 *
 * This gates who may START a turn. It does NOT gate who may APPROVE one: eve handles HITL
 * button clicks before any authored inbound handler, so that check lives in the gated tool
 * itself (`agent/tools/echo_note.ts`), against the same list in `lib/slack-allowlist.ts`.
 */
export function isAllowedSlackUser(message: SlackMessage): boolean {
  const author = message.author;
  if (!author || author.isBot) return false;
  return isAllowedSlackUserId(author.userId);
}

/**
 * What the agent says when its gateway key hits its cap.
 *
 * `owner-agent` carries a $15/day `max_budget`.
 * When it bites, LiteLLM refuses the model call with HTTP 400 and `error.type:
 * "budget_exceeded"`; eve classifies that as a terminal failure and, before this, the door
 * posted its generic "I hit an error while handling your request" — a capped agent read as a
 * broken agent.
 *
 * English, not Norwegian: every deterministic operational string this agent already emits is
 * English (`agent/channels/telegram.ts`'s "Unsupported action.", `lib/proposal-buttons.ts`'s
 * "✅ Approve" / "Notion proposal #…"). Another agent's equivalent may be in a different language
 * because its fixed strings are. The rule is the door's existing tone, not a fleet-wide language.
 *
 * The sentence is fixed and says only what is true: nothing ran. No retry — an uncapped retry
 * around a paid call is a known cost trap, and a budget refusal is the last place to
 * add one.
 */
const BUDGET_EXCEEDED_TEXT =
  "I have hit my spending cap — nothing was done. It resets with the next budget period, or you can raise the cap.";

const FAILURE_OPTIONS = { refusalText: BUDGET_EXCEEDED_TEXT, dialect: "slack" } as const;

/** The thread surface these handlers need — eve's `SlackEventContext` satisfies it. */
interface FailureThread {
  readonly thread: { post(message: string): Promise<unknown> };
}

/**
 * `turn.failed` — EXPORTED for tests, the convention `agent/channels/telegram.ts`'s
 * `onMessageCompleted` established after an outage.
 *
 * Supplying this REPLACES eve's default handler (object spread in `slackChannel`), and the
 * default's text is what a non-budget failure must still say. That reproduction lives in
 * `@lares/agent-kit/gateway-budget` with a conformance test against the installed eve, so a
 * reworded eve breaks a test rather than a thread.
 */
export async function onTurnFailed(data: FailureEventData, channel: FailureThread): Promise<void> {
  const response = respondToTurnFailed(data, FAILURE_OPTIONS);
  if (response.kind === "silent") return;
  if (response.kind === "budget-refusal") {
    console.warn("chief-of-staff slack: gateway budget exceeded — answered with the fixed refusal; nothing was executed");
  }
  await channel.thread.post(response.text);
}

/**
 * `session.failed` — a budget refusal is terminal, so eve emits it right after `turn.failed`
 * for the same fault. `onTurnFailed` already answered; this stays quiet so a capped turn
 * produces exactly one sentence. Everything else keeps eve's default text.
 */
export async function onSessionFailed(data: FailureEventData, channel: FailureThread): Promise<void> {
  const response = respondToSessionFailed(data, FAILURE_OPTIONS);
  if (response.kind === "silent") return;
  await channel.thread.post(response.text);
}

/**
 * Admits an allowed human's message. eve drops Slack audio and video clips before the
 * turn, so a clip-only message reached the chief of staff as "an empty message". The note tells the agent what arrived,
 * so the agent can say it plainly.
 */
export function admitSlackMessage(
  ctx: Parameters<typeof defaultSlackAuth>[1],
  message: SlackMessage,
): { auth: ReturnType<typeof defaultSlackAuth>; context?: string[] } | null {
  if (!isAllowedSlackUser(message)) return null;
  const note = slackUnreadableNote(message.attachments);
  return note ? { auth: defaultSlackAuth(message, ctx), context: [note] } : { auth: defaultSlackAuth(message, ctx) };
}

/** Continuity is limited to a signed, allowlisted DM. App mentions can be visible to a room and
 * therefore never receive a private-history context. A registry/grant outage only removes the
 * optional context; it does not change the existing message admission decision. */
export async function admitSlackDirectMessage(
  ctx: Parameters<typeof defaultSlackAuth>[1],
  message: SlackMessage,
): Promise<{ auth: ReturnType<typeof defaultSlackAuth>; context?: string[] } | null> {
  const admitted = admitSlackMessage(ctx, message);
  if (!admitted?.auth) return admitted;
  const replyAttributes: Record<string, string> = message.threadTs !== message.ts
    ? { lares_route_decline_reply_anchor: `slack:${message.threadTs}` }
    : {};
  try {
    const continuity = await nativeConversationContinuity("slack", admitted.auth);
    return {
      auth: continuity.identity
        ? { ...admitted.auth, attributes: { ...admitted.auth.attributes, ...replyAttributes, ...continuityAuthAttributes(continuity.identity) } }
        : { ...admitted.auth, attributes: { ...admitted.auth.attributes, ...replyAttributes } },
      ...((admitted.context?.length || continuity.context.length) ? { context: [...continuity.context, ...(admitted.context ?? [])] } : {}),
    };
  } catch (error) {
    console.warn("slack continuity unavailable; continuing without archived context", error instanceof Error ? error.message : "unknown error");
    return admitted;
  }
}

/** Replaces Eve's terminal Slack reply only to bind a scheduled decline question to its exact
 * root DM message. Other replies retain Eve's short-message and long-snippet behavior. */
export async function onSlackMessageCompleted(
  data: { finishReason: string; message?: string | null },
  channel: {
    state: { pendingToolCallMessage?: string | null; triggeringUserId?: string | null };
    thread: {
      post(message: string): Promise<{ id: string }>;
      postDirectMessage(userId: string, message: string): Promise<{ id: string }>;
      startTyping(message?: string): Promise<void>;
    };
    slack: {
      threadTs: string;
      uploadFiles(files: readonly { data: Blob; filename: string; mimeType: string }[], options: {
        initialComment?: string; snippetType: "markdown";
      }): Promise<unknown>;
    };
  },
  ctx: SessionContext,
): Promise<void> {
  if (data.finishReason === "tool-calls") {
    channel.state.pendingToolCallMessage = data.message?.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? null;
    return;
  }
  channel.state.pendingToolCallMessage = null;
  if (!data.message) {
    await channel.thread.startTyping();
    return;
  }

  const attrs = ctx.session.auth.current?.attributes;
  const requestId = attrs?.lares_route_decline_request_id;
  if (typeof requestId === "string") {
    const address = attrs?.lares_continuity_address;
    const linkedUser = typeof address === "string" && address.startsWith("slack-user:")
      ? address.slice("slack-user:".length) : undefined;
    const userId = typeof attrs?.user_id === "string" ? attrs.user_id : linkedUser ?? channel.state.triggeringUserId;
    if (!userId) throw new Error("track-routing decline question has no bound Slack recipient");
    const posted = await channel.thread.postDirectMessage(userId, data.message);
    if (posted.id) await markRouteDeclineQuestionSent(getPool(), requestId, `slack:${posted.id}`);
    return;
  }

  const longResponseNotice = "Here's a snippet with the full response.";
  if (data.message.length <= 12_000) {
    await channel.thread.post(data.message);
    return;
  }
  const alreadyThreaded = channel.slack.threadTs.length > 0;
  if (!alreadyThreaded && (!(await channel.thread.post(longResponseNotice)).id || channel.slack.threadTs.length === 0)) {
    throw new Error("Slack did not return a thread timestamp for the long response notice.");
  }
  await channel.slack.uploadFiles([{ data: new Blob([data.message], { type: "text/markdown" }),
    filename: "eve-response.md", mimeType: "text/markdown" }], {
    ...(alreadyThreaded ? { initialComment: longResponseNotice } : {}), snippetType: "markdown",
  });
}

// Install the outbound proxy routing as this module loads. Safe on the build path: it
// constructs a ProxyAgent (which connects to nothing until used) and reads no secret.
installSlackProxyDispatcher();

export default slackChannel({
  credentials: slackCredentials as { botToken: SlackBotToken; signingSecret: string },
  // Both enabled inbound handlers are overridden. Overriding only one would leave eve's
  // permissive default in place for the other — the documented footgun.
  onAppMention: async (ctx, message) => await interceptSlackClaim(message, undefined, process.env, (text) => replyBeforeClaimApplied(message.channelId, text)) ? null : admitSlackMessage(ctx, message),
  onDirectMessage: async (ctx, message) => await interceptSlackClaim(message, undefined, process.env, (text) => replyBeforeClaimApplied(message.channelId, text)) ? null : admitSlackDirectMessage(ctx, message),
  events: {
    "message.completed": onSlackMessageCompleted,
    "turn.failed": onTurnFailed,
    "session.failed": onSessionFailed,
  },
});
