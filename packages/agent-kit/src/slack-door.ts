/**
 * The Slack door, written once for every role (ADR-0025). A role's `agent/channels/slack.ts` stays
 * a file of its own, because eve finds a channel by its file under `agent/channels/`, and there it
 * binds this module to the role (`slackDoor({...})`) and adds what only that role has.
 *
 * Inbound: Slack POSTs events to eve's default Slack path (`/eve/v1/slack`). Any relay or reverse
 * proxy in front of the agent only forwards that request and verifies nothing; Slack's signature is
 * checked here, where the signing secret lives (read from a file on each request, never at module
 * load). The door runs in webhook mode, so the signing secret is required and Socket Mode's
 * app-level token is not used.
 *
 * Outbound: `slack-dispatcher.ts` routes Slack's domains through the egress proxy, because the
 * service container's network allows nothing else out.
 */
import { readFileSync } from "node:fs";
import {
  callSlackApi,
  defaultSlackAuth,
  defineSlackRenderer,
  type SlackAnswerResult,
  type SlackBotToken,
  type SlackChannelConfig,
  type SlackMessage,
} from "eve/channels/slack";
import type { SessionAuthContext } from "eve/context";
import { calls, type SessionView } from "eve/events";

import { slackDoorVerifier, interceptSlackClaim, tellRefusedSlackTapper, slackFailureCode, type SlackRefusalNoticeContext } from "./door-channels.js";
import { assertDoorAuthority, managedIdentity } from "./door-authority.js";
import { isAllowedSlackUserId } from "./principals.js";
import { decideTap } from "./card-layer.js";
import { askedCallOf } from "./approval-events.js";
import { recordCardPosted } from "./approval-ledger.js";
import { getPool } from "./db.js";
import { installSlackProxyDispatcher } from "./slack-dispatcher.js";
import { slackUnreadableNote } from "./unreadable-content.js";
import { respondToTurnFailed, SPENDING_CAP_REFUSED_TEXT } from "./gateway-budget.js";
import { anyCallCompleted, conversationTooLongSlackSentence, withPartlyDone } from "./conversation-too-long.js";
import { approvalCardRenderer, installSlackCardHook, slackCardPostedWhole } from "./slack-approval-card.js";

const DEFAULT_BOT_TOKEN_FILE = "/run/secrets/eve-slack-bot-token";
const DEFAULT_SIGNING_SECRET_FILE = "/run/secrets/eve-slack-signing-secret";

/**
 * Reads a secret from disk, on every call. Deliberately uncached and deliberately lazy: `eve build`
 * evaluates the door module to compile the agent, and a build — like CI — has no secrets at all.
 * Anything read at module scope fails the image build outright.
 *
 * Errors name the path and never the contents.
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
 * `botToken` takes eve's documented function form, resolved per call. `signingSecret` is typed as
 * a plain string, so it is a **getter** — eve reads it inside `verifyInbound`, once per inbound
 * request, which keeps the read off the build path. Flattening it into an eagerly-evaluated
 * property would turn `eve build` (and CI, and the image build) into something that needs a
 * secret. If a future eve version ever destructures credentials at construction instead, this
 * breaks loudly at `eve build` rather than quietly in production, which is the right direction to
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
 * One fixed line back to a conversation the door has not accepted yet (the claim confirmation, the
 * "cannot act on that yet" line). The normal credentials refuse the bot token until the owner's
 * claim is applied, which is when these lines are needed, so the token file is read directly.
 * Reachable only from the claim handler, after the signature check, and it sends only the fixed
 * text passed in.
 */
export async function replyBeforeClaimApplied(channelId: string, text: string): Promise<void> {
  const res = await callSlackApi({
    botToken: async () => readSecret("SLACK_BOT_TOKEN_FILE", DEFAULT_BOT_TOKEN_FILE),
    operation: "chat.postMessage",
    body: { channel: channelId, text },
  });
  if (!res.ok) throw new Error(`slack reply failed: ${String((res as { error?: unknown }).error)}`);
}

/**
 * Who may start a turn. A valid Slack signature proves only that *Slack* sent the event, not that
 * the person behind it is trusted — and Slack Connect can deliver events from outside the
 * workspace. So this is an explicit allow-list and it fails closed: an unset or blank
 * `SLACK_ALLOWED_USER_IDS` admits nobody.
 *
 * This gates who may START a turn. Who may ANSWER a card is the card layer's rule
 * (`card-layer.ts`, asked from `authorizeSlackAnswer`), and the gated tools check again themselves
 * when an approved call runs (`approval-policy.ts`). All three read the list in `principals.ts`.
 */
export function isAllowedSlackUser(message: SlackMessage): boolean {
  const author = message.author;
  if (!author || author.isBot) return false;
  return isAllowedSlackUserId(author.userId);
}

/**
 * What the agent says when its gateway key hits its cap. LiteLLM refuses the model call with HTTP
 * 400 and `error.type: "budget_exceeded"`; eve classifies that as a terminal failure and, before
 * this, the door posted its generic "I hit an error while handling your request" — a capped agent
 * read as a broken agent.
 *
 * The same words for every role on purpose: this is an operational fact about the gateway, not a
 * voice. The sentence is fixed and says only what is true: nothing ran. No retry — an uncapped
 * retry around a paid call is a known cost trap, and a budget refusal is the last place to add one.
 */
export const SLACK_BUDGET_EXCEEDED_TEXT = SPENDING_CAP_REFUSED_TEXT;

const FAILURE_OPTIONS = { refusalText: SLACK_BUDGET_EXCEEDED_TEXT, dialect: "slack" } as const;

/**
 * Admits an allowed human's message. eve drops Slack audio and video clips before the turn, so a
 * clip-only message reached the agent as "an empty message". The note tells the agent what
 * arrived, so it can say it plainly.
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
 * An edit to a message the owner already sent starts nothing.
 *
 * eve 1.0 can send an edit to the conversation as a new turn, and when a door says nothing about
 * edits it asks the door's message handlers to decide. The door heard mentions and direct messages
 * and nothing else before the upgrade, so it says so here: correcting a typo must not make the
 * agent answer, or act, a second time. Because this handler exists, eve does not run the two
 * message handlers for an edit at all. Letting edits through is a decision for the owner; it is
 * this one line.
 */
export function ignoreSlackMessageEdit(): null {
  return null;
}

/** eve 1.0's failure payload: `error` on a failed `turn.settled` or `session.ended`. */
interface FailureError {
  readonly code?: string;
  readonly message?: string;
  readonly id?: string;
  readonly hint?: string;
}

/** What the two failure handlers read from the event and the channel. eve's own event and `ctx`
 *  satisfy both; tests pass plain objects. */
export interface SettledEvent {
  readonly data: { readonly outcome: string; readonly turnId?: string; readonly error?: FailureError };
}
export interface ThreadContext {
  readonly channel: { readonly thread: { post(message: string): Promise<unknown> } };
  /** eve's event context carries both; tests that pass neither get the room sentence, alone. */
  readonly session?: unknown;
  readonly view?: SessionView;
}

/** What admitting a message gives eve: the auth, and any context lines for the turn. */
export type SlackAdmission = { auth: ReturnType<typeof defaultSlackAuth>; context?: string[] } | null;

/** A role's settings for its Slack door. */
export interface SlackDoorSettings {
  /** The role's name in log lines and the refused-tapper notice. */
  readonly role: string;
  /** Whether the door answers a claim code (and "cannot act on that yet") with a fixed line. */
  readonly replyBeforeClaim: boolean;
  /** Whether the door posts the kit's sentence when the reply after an answered card was refused,
   *  instead of leaving that failure to eve's own words. */
  readonly postsApprovalReplyRefusal: boolean;
  /** How a direct message is admitted (default: `admitSlackMessage`). */
  readonly admitDirectMessage?: (ctx: Parameters<typeof defaultSlackAuth>[1], message: SlackMessage) => SlackAdmission | Promise<SlackAdmission>;
  /** Renderer handlers the role adds before the door's own failure handlers. */
  readonly events?: Readonly<Record<string, unknown>>;
}

/** What a tap on a Slack card carries that the layer reads: who tapped, and the cards it names. */
export interface SlackTapSubmission {
  readonly user?: { readonly id?: string };
  readonly answers?: ReadonlyArray<{ readonly interactionId?: string }>;
}

export interface SlackDoor {
  readonly authorizeSlackAnswer: (
    ctx: { readonly defaultAuth: SessionAuthContext } & SlackRefusalNoticeContext,
    submission: SlackTapSubmission,
  ) => Promise<SlackAnswerResult>;
  readonly onTurnSettled: (event: SettledEvent, ctx: ThreadContext, next: () => Promise<void>) => Promise<void>;
  readonly onSessionEnded: (event: SettledEvent, ctx: ThreadContext, next: () => Promise<void>) => Promise<void>;
  /** The door's whole configuration, so a test can check what is installed. */
  readonly slackDoorConfig: SlackChannelConfig;
}

// Install the outbound proxy routing as this module loads. Safe on the build path: it constructs a
// ProxyAgent (which connects to nothing until used) and reads no secret. Idempotent.
installSlackProxyDispatcher();

/** The Slack door bound to one role. */
export function slackDoor(settings: SlackDoorSettings): SlackDoor {
  const { role } = settings;
  // The framework patch asks this whether a card was cut, to leave Approve off it (D-6).
  installSlackCardHook();

  /**
   * A tap on a card (or a typed answer in eve's modal). The door's part is small: it says who
   * tapped (Slack's own verified user id) and which cards the tap names, and hands both to the card
   * layer (`decideTap`), which decides whether the tap counts and what to say if it does not. A
   * refused person is told the layer's sentence, privately; the card is not touched and stays as
   * it was.
   *
   * eve calls this for every tap on one of its controls, in the webhook handler, BEFORE the answer
   * is delivered to the conversation. Returning `null` refuses the answer: nothing is delivered,
   * nothing runs. Fails closed (the layer refuses a tap that names nobody).
   *
   * Setting `onAnswers` also makes eve stop reading a typed Slack message as an answer to an open
   * card. That is wanted, but it is not what turns typed approvals off: the framework patch does
   * that for every door, and this door does not rely on the side effect.
   */
  async function authorizeSlackAnswer(
    ctx: { readonly defaultAuth: SessionAuthContext } & SlackRefusalNoticeContext,
    submission: SlackTapSubmission,
  ): Promise<SlackAnswerResult> {
    const tapper = submission?.user?.id;
    const cards = (submission?.answers ?? [])
      .map((answer) => answer?.interactionId)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .map((requestId) => ({ requestId }));
    const verdict = await decideTap({ door: "slack", tapper: typeof tapper === "string" ? tapper : undefined, cards });
    if (verdict.deliver) return { auth: ctx.defaultAuth };
    console.warn(`${role} slack: an answer was not accepted (${verdict.why}); nothing was executed`);
    tellRefusedSlackTapper(ctx, tapper, role, verdict.sentence);
    return null;
  }

  /**
   * What the door says itself about a failure, or `null` when the failure is eve's to answer.
   * Recognition is the kit's (`gateway-budget.ts`); the door hands it the event's `data` and posts
   * what it is given: the gateway's spending cap (the fixed sentence), a monthly spending limit (the
   * sentence the engine itself wrote), a conversation grown too long, and, where the role says so,
   * a refused reply after an answered card.
   *
   * `respondToTurnFailed` is used for BOTH events on purpose. Its sibling for the session's end
   * answers "say nothing" for these refusals, and on eve 1.0 a failure that ends the conversation
   * is reported only there, so that would leave a capped turn with no answer at all.
   */
  function refusalText(data: SettledEvent["data"]): { kind: string; text: string } | null {
    if (data.outcome !== "failed" || data.error === undefined) return null;
    const response = respondToTurnFailed(data, FAILURE_OPTIONS);
    return response.kind === "budget-refusal" || (settings.postsApprovalReplyRefusal && response.kind === "approval-reply-refused") || response.kind === "conversation-too-long"
      ? { kind: response.kind, text: response.text }
      : null;
  }

  async function answerFailure(event: SettledEvent, ctx: ThreadContext, next: () => Promise<void>): Promise<void> {
    const refusal = refusalText(event.data);
    // Anything that is not one of the door's refusals is eve's to answer, in eve's own words.
    if (refusal === null) return next();
    // A thread that has grown too long: eve's summary of it was refused, so every later turn in this
    // thread would fail too. The sentence sends the person to a new top-level message, which opens a
    // new thread and so a new conversation (in a room the new message has to mention the agent, and
    // the room sentence says so).
    if (refusal.kind === "conversation-too-long") console.warn(`${role} slack: the thread grew too long — answered with the fixed sentence; nothing was summarised`);
    else console.warn(`${role} slack: gateway budget exceeded — answered with the fixed refusal; nothing was executed`);
    await ctx.channel.thread.post(refusal.kind === "conversation-too-long" ? tooLongText(event, ctx) : refusal.text);
  }

  /**
   * The too-long sentence for THIS thread: the room wording unless the conversation is known to have
   * started in a direct message, and one more sentence when the failed turn had already completed a
   * call, since sending the message again could repeat it.
   */
  function tooLongText(event: SettledEvent, ctx: ThreadContext): string {
    const turnId = event.data.turnId;
    let partlyDone = false;
    try {
      partlyDone = ctx.view !== undefined && typeof turnId === "string" && anyCallCompleted(calls(ctx.view, { turnId }));
    } catch {
      partlyDone = false;
    }
    return withPartlyDone(conversationTooLongSlackSentence(ctx), partlyDone);
  }

  /**
   * `turn.settled`. A failure the conversation can carry on from arrives here, as
   * `outcome: "failed"` with the error. Every other outcome goes to `next()`, eve's own handler.
   */
  async function onTurnSettled(event: SettledEvent, ctx: ThreadContext, next: () => Promise<void>): Promise<void> {
    await answerFailure(event, ctx, next);
  }

  /**
   * `session.ended`. A failure that ends the conversation arrives here and ONLY here: eve 1.0 writes
   * the error on the session's end and settles the turn `cancelled` with no error of its own. The
   * gateway's cap is a plain 4xx, which eve treats as ending the conversation, so this is where a
   * capped turn is normally answered. One fault produces one of the two events with the error,
   * never both, so a capped turn still gets exactly one sentence.
   */
  async function onSessionEnded(event: SettledEvent, ctx: ThreadContext, next: () => Promise<void>): Promise<void> {
    await answerFailure(event, ctx, next);
  }

  /**
   * `interaction.opened`. eve posts the card in its own handler; once it has, this reads where the
   * card sits (eve keeps it in the channel's state) and writes that into the card record, with
   * whether the card was shown whole. This is the door's adapter function 3 (the card address); the
   * rule about what an address is for lives in the card layer. Never throws: a card whose address
   * is missing is an unknown card to the layer, and a failure costs one log line.
   */
  async function onInteractionOpened(
    event: { readonly data: { readonly interactionId?: string; readonly request?: { readonly kind?: string } } },
    ctx: { readonly channel?: { readonly state?: unknown } },
    next: () => Promise<void>,
  ): Promise<void> {
    await next();
    try {
      const requestId = event.data.interactionId;
      const kind = event.data.request?.kind;
      if (typeof requestId !== "string" || (kind !== "approval" && kind !== "question")) return;
      const cards = (ctx.channel?.state as { interactionCards?: ReadonlyArray<{ channelId?: string; ts?: string; requests?: ReadonlyArray<{ interactionId?: string; blocks?: unknown }> }> } | undefined)?.interactionCards;
      const posted = cards?.find((card) => card.requests?.some((r) => r.interactionId === requestId));
      if (typeof posted?.channelId !== "string" || typeof posted.ts !== "string") return;
      const asked = kind === "approval" ? askedCallOf(ctx, requestId) : undefined;
      const shownWhole = kind === "approval" && asked !== undefined ? slackCardPostedWhole(asked.name, asked.input, posted.requests?.find((r) => r.interactionId === requestId)?.blocks) : kind === "question";
      await recordCardPosted(getPool(), { requestId, door: "slack", address: { channel: posted.channelId, message: posted.ts }, shownWhole });
    } catch (error) {
      console.warn(`${role} slack: could not record where a card was posted`, slackFailureCode(error));
    }
  }

  /** The door's own renderer. Each handler wraps eve's default for that event and calls `next()`
   *  for everything it does not answer itself. */
  const doorRenderer = defineSlackRenderer({
    events: {
      ...(settings.events ?? {}),
      "interaction.opened": onInteractionOpened,
      "turn.settled": onTurnSettled,
      "session.ended": onSessionEnded,
    } as Parameters<typeof defineSlackRenderer>[0]["events"],
  });

  const claimReply = (message: SlackMessage) =>
    settings.replyBeforeClaim ? (text: string) => replyBeforeClaimApplied(message.channelId, text) : undefined;
  const admitDirect = settings.admitDirectMessage ?? admitSlackMessage;

  /**
   * The door's whole configuration. eve 1.0 says nothing about a configuration key or a handler name
   * it does not know; the type below rejects an unknown key, and the tests read this object.
   */
  const slackDoorConfig: SlackChannelConfig = {
    credentials: slackCredentials as { botToken: SlackBotToken; signingSecret: string },
    // Both enabled inbound handlers are overridden. Overriding only one would leave eve's
    // permissive default in place for the other — the documented footgun.
    onAppMention: async (ctx, message) => await interceptSlackClaim(message, undefined, process.env, claimReply(message)) ? null : admitSlackMessage(ctx, message),
    onDirectMessage: async (ctx, message) => await interceptSlackClaim(message, undefined, process.env, claimReply(message)) ? null : admitDirect(ctx, message),
    onMessageEdited: ignoreSlackMessageEdit,
    // The third way in: a tap on a card. The card layer decides whether it counts.
    onAnswers: authorizeSlackAnswer,
    renderers: [approvalCardRenderer, doorRenderer],
  };

  return { authorizeSlackAnswer, onTurnSettled, onSessionEnded, slackDoorConfig };
}
