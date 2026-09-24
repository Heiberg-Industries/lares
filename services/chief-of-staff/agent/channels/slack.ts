import {slackDoorVerifier,interceptSlackClaim} from '@lares/agent-kit/door-channels';
import {assertDoorAuthority,managedIdentity} from '@lares/agent-kit/door-authority';
/**
 * The shadow Slack door.
 *
 * Inbound reaches this channel the long way round, per ADR-0011: Slack POSTs to
 * `https://slack.example.com/eve/v1/slack`, a path-scoped nginx relay on ops-1
 * forwards that one path over the tailnet, and `tailscale serve` on agent-1 hands it to
 * this container. The relay verifies nothing — Slack's signature is checked here, where
 * the signing secret lives.
 *
 * Outbound goes the other long way round: `lib/slack-dispatcher.ts` routes `*.slack.com`
 * through the squid proxy, because the box's seal drops anything else.
 */
import { readFileSync } from "node:fs";
import {
  defaultSlackAuth,
  slackChannel,
  type SlackBotToken,
  type SlackMessage,
} from "eve/channels/slack";

import { isAllowedSlackUserId } from "../../lib/slack-allowlist.js";
import { installSlackProxyDispatcher } from "@lares/agent-kit/slack-dispatcher";
import { slackUnreadableNote } from "@lares/agent-kit/unreadable-content";
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
 * Who may start a turn. A valid Slack signature proves only that *Slack* sent the event,
 * not that the person behind it is trusted — and Slack Connect can deliver events from
 * outside the workspace. So this is an explicit allowlist and it fails closed: an unset or
 * blank `SLACK_ALLOWED_USER_IDS` admits nobody.
 *
 * The shadow phase deliberately stops here rather than reading the identity registry. The
 * canonical-principal resolution (`U098VSVS9DY` → `bendik`) is Stage E work, and it carries
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
 * ORB-188 item 2 — what Saga says when her gateway key hits its cap.
 *
 * `bendik-saga` carries a $15/day `max_budget` (ORB-202, `docs/runbooks/per-user-spend-caps.md`).
 * When it bites, LiteLLM refuses the model call with HTTP 400 and `error.type:
 * "budget_exceeded"`; eve classifies that as a terminal failure and, before this, the door
 * posted its generic "I hit an error while handling your request" — a capped Saga read as a
 * broken Saga.
 *
 * English, not Norwegian: every deterministic operational string this agent already emits is
 * English (`agent/channels/telegram.ts`'s "Unsupported action.", `lib/proposal-buttons.ts`'s
 * "✅ Approve" / "Notion proposal #…"). Marcel's equivalent is Norwegian because *his* fixed
 * strings are. The rule is the door's existing tone, not a fleet-wide language.
 *
 * The sentence is fixed and says only what is true: nothing ran. No retry — an uncapped retry
 * around a paid call is the 2026-08-14/15 incident, and a budget refusal is the last place to
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
 * `onMessageCompleted` established after the 2026-08-17 outage.
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
    console.warn("eve-saga slack: gateway budget exceeded — answered with the fixed refusal; nothing was executed");
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
 * Admits an allowed human's message. ORB-286: eve drops Slack audio and video clips before the
 * turn, so a clip-only message reached Saga as "an empty message". The note tells her what arrived,
 * so she can say it plainly.
 */
export function admitSlackMessage(
  ctx: Parameters<typeof defaultSlackAuth>[1],
  message: SlackMessage,
): { auth: ReturnType<typeof defaultSlackAuth>; context?: string[] } | null {
  if (!isAllowedSlackUser(message)) return null;
  const note = slackUnreadableNote(message.attachments);
  return note ? { auth: defaultSlackAuth(message, ctx), context: [note] } : { auth: defaultSlackAuth(message, ctx) };
}

// Install the outbound proxy routing as this module loads. Safe on the build path: it
// constructs a ProxyAgent (which connects to nothing until used) and reads no secret.
installSlackProxyDispatcher();

export default slackChannel({
  credentials: slackCredentials as { botToken: SlackBotToken; signingSecret: string },
  // Both enabled inbound handlers are overridden. Overriding only one would leave eve's
  // permissive default in place for the other — the documented footgun.
  onAppMention: async (ctx, message) => await interceptSlackClaim(message) ? null : admitSlackMessage(ctx, message),
  onDirectMessage: async (ctx, message) => await interceptSlackClaim(message) ? null : admitSlackMessage(ctx, message),
  events: {
    "turn.failed": onTurnFailed,
    "session.failed": onSessionFailed,
  },
});
