import {slackDoorVerifier,interceptSlackClaim} from '@lares/agent-kit/door-channels';
import {assertDoorAuthority,managedIdentity} from '@lares/agent-kit/door-authority';
/**
 * Calliope's Slack door.
 *
 * Ported from `services/chief-of-staff/agent/channels/slack.ts` with exactly two changes: the two
 * secret paths (hers, below) and this comment. Everything else — the lazy `readSecret`, the
 * `signingSecret` getter, the fail-closed allowlist — is kept verbatim and each for a stated
 * reason; see the docblocks on those three things before editing any of them.
 *
 * Inbound reaches this channel the long way round, per ADR-0011: Slack POSTs to
 * `https://calliope.example.com/eve/v1/slack`, a path-scoped nginx relay on ops-1
 * forwards that ONE path over the tailnet — rewriting it to `/eve-calliope/v1/slack` so
 * agent-1's single tailscale-serve listener can tell her container apart from eve-saga's and
 * eve-marcel's — and `tailscale serve` on agent-1 hands it to this container. The relay
 * verifies nothing: Slack's signature is checked here, where the signing secret lives.
 *
 * SHE IS NOT A NEW SLACK APP. Calliope has had her own app since 2026-06-23; this port
 * switches it from Socket Mode to webhook, exactly as Saga's did at her cutover. So:
 *
 *   - the bot token is REUSED as-is (`calliope-slack-bot-token`, on the box since June) — no
 *     new secret, no re-invite, no identity change in the workspace;
 *   - the signing secret is genuinely new (`calliope-slack-signing-secret`, provisioned
 *     2026-08-23), because Socket Mode authenticates by websocket and never needed HMAC;
 *   - `calliope-slack-app-token` (the `xapp-` app-level token) becomes unused but STAYS on
 *     the box. It is the rollback lever: Socket Mode back on restores old Calliope instantly.
 *     Do not remove it before the decommission session.
 *
 * `slack-app-manifest.json` in this directory's parent records the post-cutover target shape
 * of that app. It is documentation of what Bendik applies at cutover, not a manifest to
 * create a second app from.
 *
 * Outbound goes the other long way round: `@lares/agent-kit/slack-dispatcher` routes
 * `*.slack.com` through the squid proxy, because the box's seal drops anything else — as a
 * HANG, not an error.
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

// Her EXISTING box secret names, not invented `eve-calliope-*` ones — the files are already
// provisioned under these names (`root:saga 440`, /etc/agent-box/). Renaming here would
// orphan them. Mirrors eve-marcel, which likewise reuses old Marcel's bot token.
const DEFAULT_BOT_TOKEN_FILE = "/run/secrets/calliope-slack-bot-token";
const DEFAULT_SIGNING_SECRET_FILE = "/run/secrets/calliope-slack-signing-secret";

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
 * once per inbound request, which keeps the read off the build path. Flattening it into an
 * eagerly-evaluated property is the regression `tests/slack-door.test.ts` exists to catch:
 * it would turn `eve build` (and CI, and the image build) into something that needs a secret.
 * If a future eve version ever destructures credentials at construction instead, this breaks
 * loudly at `eve build` rather than quietly in production, which is the right direction to
 * fail.
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
 * Who may start a turn. A valid Slack signature proves only that *Slack* sent the event, not
 * that the person behind it is trusted — and Slack Connect can deliver events from outside
 * the workspace. So this is an explicit allowlist and it fails closed: an unset or blank
 * `SLACK_ALLOWED_USER_IDS` admits nobody.
 *
 * This gates who may START a turn. It does NOT gate who may APPROVE one: eve handles HITL
 * button clicks before any authored inbound handler, so that check lives in the gated tools
 * themselves (`assertApprover` at the top of every tool in `agent/tools/`), against the same
 * list in `lib/principals.ts`. See that file's header for why the second check is not
 * redundant with this one.
 */
export function isAllowedSlackUser(message: SlackMessage): boolean {
  const author = message.author;
  if (!author || author.isBot) return false;
  return isAllowedSlackUserId(author.userId);
}

/**
 * ORB-188 item 2 — what Calliope says when her gateway key hits its cap.
 *
 * `bendik-calliope` carries a $5/day `max_budget` (ORB-202,
 * `docs/runbooks/per-user-spend-caps.md`) — the tightest cap in the fleet, so she is the
 * likeliest agent to meet it. LiteLLM refuses with HTTP 400 and `error.type:
 * "budget_exceeded"`; eve treats that as a terminal failure, and before this the door posted
 * its generic "I hit an error while handling your request".
 *
 * Same wording as `services/chief-of-staff/agent/channels/slack.ts` on purpose — this is an
 * operational fact about the gateway, not a voice. Her voice (`agent/voice.md`: "sharp,
 * economical, a little provocative") belongs to what a model composes, and a capped turn
 * composed nothing.
 */
const BUDGET_EXCEEDED_TEXT =
  "I have hit my spending cap — nothing was done. It resets with the next budget period, or you can raise the cap.";

const FAILURE_OPTIONS = { refusalText: BUDGET_EXCEEDED_TEXT, dialect: "slack" } as const;

/** The thread surface these handlers need — eve's `SlackEventContext` satisfies it. */
interface FailureThread {
  readonly thread: { post(message: string): Promise<unknown> };
}

/**
 * `turn.failed` — EXPORTED for tests. Supplying it REPLACES eve's default handler (object
 * spread in `slackChannel`), so a non-budget failure must still produce the default's exact
 * text; that reproduction lives in `@lares/agent-kit/gateway-budget`, with a conformance test
 * against the installed eve so a reworded eve breaks a test rather than a thread.
 */
export async function onTurnFailed(data: FailureEventData, channel: FailureThread): Promise<void> {
  const response = respondToTurnFailed(data, FAILURE_OPTIONS);
  if (response.kind === "silent") return;
  if (response.kind === "budget-refusal") {
    console.warn("eve-calliope slack: gateway budget exceeded — answered with the fixed refusal; nothing was executed");
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
 * turn; the note tells Calliope what arrived so she can say it plainly (same as eve-saga's door).
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
