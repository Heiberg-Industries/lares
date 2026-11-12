import {slackDoorVerifier,interceptSlackClaim,tellRefusedSlackTapper,SLACK_TAP_REFUSAL,type SlackRefusalNoticeContext} from '@lares/agent-kit/door-channels';
import {assertDoorAuthority,managedIdentity} from '@lares/agent-kit/door-authority';
/**
 * The creative role's Slack door.
 *
 * Ported from `services/chief-of-staff/agent/channels/slack.ts`. It differs in the default
 * secret paths, this comment, and in what it leaves out: this role has no scheduled
 * conversations, so there is no conversation continuity and no reply handler here. Everything
 * else — the lazy `readSecret`, the `signingSecret` getter, the fail-closed allowlist — is kept
 * verbatim and each for a stated reason; see the docblocks on those three things before editing
 * any of them.
 *
 * Inbound reaches this channel through a path-scoped relay that forwards that ONE path to this
 * container and verifies nothing: Slack's signature is checked here, where the signing secret
 * lives. The door runs in webhook mode, so the signing secret is required and the app-level
 * (`xapp-`) token of Socket Mode is not used.
 *
 * `slack-app-manifest.json` in this directory's parent records the target shape of the Slack
 * app. It is documentation, not a manifest to create a second app from.
 *
 * Outbound goes the other long way round: `@lares/agent-kit/slack-dispatcher` routes
 * `*.slack.com` through the squid proxy, because the box's seal drops anything else — as a
 * HANG, not an error.
 */
import { readFileSync } from "node:fs";
import {
  defaultSlackAuth,
  defineSlackRenderer,
  slackChannel,
  type SlackAnswerResult,
  type SlackBotToken,
  type SlackChannelConfig,
  type SlackMessage,
} from "eve/channels/slack";
import type { SessionAuthContext } from "eve/context";

import { allowedSlackUserIds, isAllowedSlackUserId } from "../../lib/slack-allowlist.js";
import { installSlackProxyDispatcher } from "@lares/agent-kit/slack-dispatcher";
import { slackUnreadableNote } from "@lares/agent-kit/unreadable-content";
import { respondToTurnFailed } from "@lares/agent-kit/gateway-budget";
import { approvalCardRenderer } from "../../lib/slack-approval-card.js";

// Default secret paths when the keeper has not set `SLACK_BOT_TOKEN_FILE` /
// `SLACK_SIGNING_SECRET_FILE`: the same neutral names the chief of staff's door uses.
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
 * This gates who may START a turn. Who may ANSWER a card is narrower, the owner alone
 * (`authorizeSlackAnswer` below), and the gated tools check again themselves when an approved
 * call runs (`assertApprover` at the top of every tool in `agent/tools/`). All three read the
 * list in `lib/principals.ts`. See that file's header for why the tool's check is not redundant
 * with the door's.
 */
export function isAllowedSlackUser(message: SlackMessage): boolean {
  const author = message.author;
  if (!author || author.isBot) return false;
  return isAllowedSlackUserId(author.userId);
}

/**
 * The owner's Slack user id: the FIRST id on the door's list, the same one scheduled messages are
 * addressed to (`lib/delivery.ts`, `liveTargets`). `undefined` when the list is unset, blank or
 * cannot be read, and every caller treats that as "nobody".
 */
export function slackOwnerUserId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const owner = allowedSlackUserIds(env)[0];
    return typeof owner === "string" && owner.length > 0 ? owner : undefined;
  } catch {
    return undefined;
  }
}

/** What a refused tapper is told, privately: the kit's sentence, shared with the chief of staff's Slack door. */
export { SLACK_TAP_REFUSAL };

/**
 * Who may answer an approval or a question card: THE OWNER, and nobody else. Approve and Deny
 * alike.
 *
 * This is deliberately narrower than who may start a turn. `SLACK_ALLOWED_USER_IDS` can hold
 * several trusted people, and any of them may talk to the agent; only the first of them, the
 * owner, decides what the agent is allowed to do. It matters most for Deny: the tool's own check
 * runs only when an approved call executes, so a Deny from someone else would never meet it.
 *
 * eve calls this for every tap on one of its controls and every typed answer in its modal, in
 * the webhook handler, BEFORE the answer is delivered to the conversation and so before eve's own
 * rule about who may answer is consulted. Returning `null` refuses the answer: nothing is
 * delivered, nothing runs, and the card stays as it is, still pending, for the owner. The person
 * refused is told so privately (`SLACK_TAP_REFUSAL`, the kit's sentence, the same as the chief of
 * staff's Slack door), so their tap is not met with silence.
 *
 * It fails closed. No owner id (an unset or blank list, or one that cannot be read) refuses
 * everybody.
 *
 * Setting `onAnswers` also makes eve stop reading a typed Slack message as an answer to an open
 * card. That is wanted, but it is not what turns typed approvals off: the framework patch does
 * that for every door, and this door does not rely on the side effect.
 */
export function authorizeSlackAnswer(
  ctx: { readonly defaultAuth: SessionAuthContext } & SlackRefusalNoticeContext,
  submission: { readonly user?: { readonly id?: string } },
): SlackAnswerResult {
  const owner = slackOwnerUserId();
  // An answer that names nobody (no user on the payload, or no id) is not the owner's.
  const answeredBy = submission?.user?.id;
  if (owner === undefined || typeof answeredBy !== "string" || answeredBy !== owner) {
    console.warn("creative slack: an answer from someone other than the owner was refused; nothing was executed and the card is still pending");
    tellRefusedSlackTapper(ctx, answeredBy, "creative");
    return null;
  }
  return { auth: ctx.defaultAuth };
}

/**
 * What the creative agent says when its gateway key hits its cap.
 *
 * This agent may carry a small daily `max_budget` — a tight cap, so it is the
 * likeliest agent to meet it. LiteLLM refuses with HTTP 400 and `error.type:
 * "budget_exceeded"`; eve treats that as a terminal failure, and before this the door posted
 * its generic "I hit an error while handling your request".
 *
 * Same wording as `services/chief-of-staff/agent/channels/slack.ts` on purpose — this is an
 * operational fact about the gateway, not a voice. Its voice (`agent/voice.md`) belongs to what a model composes, and a capped turn
 * composed nothing.
 */
const BUDGET_EXCEEDED_TEXT =
  "I have hit my spending cap — nothing was done. It resets with the next budget period, or you can raise the cap.";

const FAILURE_OPTIONS = { refusalText: BUDGET_EXCEEDED_TEXT, dialect: "slack" } as const;

/** eve 1.0's failure payload: `error` on a failed `turn.settled` or `session.ended`. */
interface FailureError {
  readonly code?: string;
  readonly message?: string;
  readonly id?: string;
  readonly hint?: string;
}

/** What the two failure handlers read from the event and the channel. eve's own event and
 *  `ctx` satisfy both; tests pass plain objects. */
interface SettledEvent {
  readonly data: { readonly outcome: string; readonly error?: FailureError };
}
interface ThreadContext {
  readonly channel: { readonly thread: { post(message: string): Promise<unknown> } };
}

/**
 * What the door says itself about a failure, or `null` when the failure is eve's to answer.
 *
 * Recognition is the kit's (`@lares/agent-kit/gateway-budget`); this door hands it the event's
 * `data` and posts what it is given. Two refusals are the door's:
 *
 *  - the gateway's spending cap, answered with this door's one fixed sentence;
 *  - a monthly spending limit, answered with the sentence the engine itself wrote (which limit,
 *    and when it resets), posted as written.
 *
 * eve 1.0's payload is `error: { code, message, id?, hint? }` and no longer carries the
 * gateway's error type or HTTP status, so the kit recognises both by `message` alone: the cap by
 * the gateway's opening words, the limit only when the message is exactly one of the sentences
 * the engine writes.
 *
 * The kit's `respondToTurnFailed` is used for BOTH events on purpose. Its sibling for the
 * session's end answers "say nothing" for these refusals, and on eve 1.0 a failure that ends the
 * conversation is reported only there (see `onSessionEnded`), so that would leave a capped turn
 * with no answer at all.
 */
function refusalText(data: SettledEvent["data"]): string | null {
  if (data.outcome !== "failed" || data.error === undefined) return null;
  const response = respondToTurnFailed(data, FAILURE_OPTIONS);
  return response.kind === "budget-refusal" ? response.text : null;
}

async function answerFailure(event: SettledEvent, ctx: ThreadContext, next: () => Promise<void>): Promise<void> {
  const refusal = refusalText(event.data);
  // Anything that is not a spending refusal is eve's to answer, in eve's own words.
  if (refusal === null) return next();
  console.warn("creative slack: gateway budget exceeded — answered with the fixed refusal; nothing was executed");
  await ctx.channel.thread.post(refusal);
}

/**
 * `turn.settled` — EXPORTED for tests. A failure the conversation can carry on from arrives
 * here, as `outcome: "failed"` with the error. A capped turn gets the one fixed sentence; every
 * other outcome goes to `next()`, which is eve's own handler and eve's own text. (On eve 0.60
 * this door had to REPLACE eve's handler and reproduce its wording. A renderer wraps it instead,
 * so there is nothing left to keep in step.)
 */
export async function onTurnSettled(event: SettledEvent, ctx: ThreadContext, next: () => Promise<void>): Promise<void> {
  await answerFailure(event, ctx, next);
}

/**
 * `session.ended` — EXPORTED for tests. A failure that ends the conversation arrives here and
 * ONLY here: eve 1.0 writes the error on the session's end and settles the turn `cancelled`
 * with no error of its own (`harness/session-machine/transitions.js`, `fail`). The gateway's cap
 * is a plain 4xx, which eve treats as ending the conversation, so this is where a capped turn
 * is normally answered. One fault produces one of the two events with the error, never both,
 * so a capped turn still gets exactly one sentence.
 */
export async function onSessionEnded(event: SettledEvent, ctx: ThreadContext, next: () => Promise<void>): Promise<void> {
  await answerFailure(event, ctx, next);
}

/**
 * Admits an allowed human's message. eve drops Slack audio and video clips before the
 * turn; the note tells the creative agent what arrived so it can say it plainly (same as chief-of-staff's door).
 */
export function admitSlackMessage(
  ctx: Parameters<typeof defaultSlackAuth>[1],
  message: SlackMessage,
): { auth: ReturnType<typeof defaultSlackAuth>; context?: string[] } | null {
  if (!isAllowedSlackUser(message)) return null;
  const note = slackUnreadableNote(message.attachments);
  return note ? { auth: defaultSlackAuth(message, ctx), context: [note] } : { auth: defaultSlackAuth(message, ctx) };
}

/**
 * The door's own renderer. Each handler wraps eve's default for that event and calls `next()`
 * for everything it does not answer itself.
 */
const doorRenderer = defineSlackRenderer({
  events: {
    "turn.settled": onTurnSettled,
    "session.ended": onSessionEnded,
  },
});

// Install the outbound proxy routing as this module loads. Safe on the build path: it
// constructs a ProxyAgent (which connects to nothing until used) and reads no secret.
installSlackProxyDispatcher();

/**
 * An edit to a message the owner already sent starts nothing.
 *
 * eve 1.0 can send an edit to the conversation as a new turn, and when a door says nothing about
 * edits it asks the door's message handlers to decide. This door heard mentions and direct
 * messages and nothing else before the upgrade, so it says so here: correcting a typo must not
 * make the agent answer, or act, a second time. Because this handler exists, eve does not run the
 * two message handlers for an edit at all. Letting edits through is a decision for the owner; it
 * is this one line.
 */
export function ignoreSlackMessageEdit(): null {
  return null;
}

/**
 * The door's whole configuration, exported so a test can check what is installed. eve 1.0 says
 * nothing about a configuration key or a handler name it does not know (the `events` block this
 * door used on eve 0.60 was simply no longer heard); the type below rejects an unknown key, and
 * the tests read this object.
 */
export const slackDoorConfig: SlackChannelConfig = {
  credentials: slackCredentials as { botToken: SlackBotToken; signingSecret: string },
  // Both enabled inbound handlers are overridden. Overriding only one would leave eve's
  // permissive default in place for the other — the documented footgun.
  onAppMention: async (ctx, message) => await interceptSlackClaim(message) ? null : admitSlackMessage(ctx, message),
  onDirectMessage: async (ctx, message) => await interceptSlackClaim(message) ? null : admitSlackMessage(ctx, message),
  onMessageEdited: ignoreSlackMessageEdit,
  // The third way in: a tap on a card. Narrower than the two above: the owner only.
  onAnswers: authorizeSlackAnswer,
  renderers: [approvalCardRenderer, doorRenderer],
};

export default slackChannel(slackDoorConfig);
