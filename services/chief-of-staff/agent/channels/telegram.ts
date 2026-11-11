import {interceptTelegramClaim} from '@lares/agent-kit/door-channels';
import {assertDoorAuthority,managedIdentity} from '@lares/agent-kit/door-authority';
/**
 * The Telegram door.
 *
 * Inbound: Telegram POSTs updates to eve's default Telegram path (`/eve/v1/telegram`). Any relay
 * or reverse proxy in front of the agent only forwards that request and verifies nothing; eve
 * checks `X-Telegram-Bot-Api-Secret-Token` here, where the secret lives.
 *
 * Outbound: `@lares/agent-kit/telegram-fetch` routes Bot API calls through the egress proxy via
 * eve's per-call `api.fetch` seam, because the service container's network allows nothing else
 * out. Inside a handler every call goes through the handle eve gives it (`ctx.telegram` in
 * `onMessage` and `onCallbackQuery`, `ctx.channel.telegram` in an event handler). Code with no
 * handle uses `lib/telegram-send.ts`.
 *
 * Written against eve 1.0.0-rc.9. Approval cards are rendered, posted and registered by eve
 * itself (with the Lares framework patch for their text and buttons). This door adds two things
 * around a card: under one that could not show everything, a line saying where the whole of it
 * can be read and approved; and, once the request is decided, how it ended.
 */
import { readFileSync } from "node:fs";
import type { ChannelEvents } from "eve/channels";
import { APPROVE_OPTION_ID, interaction, type SessionView } from "eve/events";
import {
  defaultTelegramAuth,
  telegramChannel,
  type TelegramBotToken,
  type TelegramChannelEvents,
  type TelegramEventContext,
  type TelegramMessage,
  type TelegramWebhookSecretToken,
} from "eve/channels/telegram";

import { isAllowedPrincipalId } from "../../lib/principals.js";
import { telegramFetch } from "@lares/agent-kit/telegram-fetch";
import { markRouteDeclineQuestionSent } from "../../lib/route-decline.js";
import { continuityAuthAttributes, nativeConversationContinuity } from "../../lib/conversation-continuity.js";
import { TELEGRAM_INNER_ROUTE } from "@lares/agent-kit/telegram-routes";
import { mdToTelegramHtml, splitTelegramHtml } from "@lares/agent-kit/telegram-markdown";
import { getPool } from "@lares/agent-kit/db";
import { answeredVia } from "@lares/agent-kit/approval-ledger";
import { OFFICE_MEDIA_TYPES } from "@lares/agent-kit/attachment-hydration";
import { telegramUnreadableNote } from "@lares/agent-kit/unreadable-content";
import {
  respondToSessionFailed,
  respondToTurnFailed,
  type FailureEventData,
} from "@lares/agent-kit/gateway-budget";
import { handleProposalCallback } from "../../lib/proposal-buttons.js";
import { sendTelegramMessage } from "../../lib/telegram-send.js";
import { resolveProposal, resolveAtlasProposal } from "../../lib/proposals-store.js";
import {
  advanceRotationDay,
  completeRotation,
  consumePendingContext,
  dayHasRolledOver,
  getRotationState,
  homeDay,
  pruneOldExchanges,
  recordExchange,
  recordServingSession,
  summarizeRecentExchanges,
} from "../../lib/telegram-rotation.js";

/**
 * What this door lets through to the chief of staff. Office files were added later: agent-kit's
 * attachment hydration now extracts their text; before that they were dropped here unseen.
 * Voice and audio stay out — nothing reads them yet; the unreadable-content note says so.
 */
export const TELEGRAM_UPLOAD_POLICY = {
  allowedMediaTypes: ["image/*", "application/pdf", "text/*", ...OFFICE_MEDIA_TYPES],
  maxBytes: 10 * 1024 * 1024,
};

const DEFAULT_BOT_TOKEN_FILE = "/run/secrets/eve-telegram-bot-token";
const DEFAULT_WEBHOOK_SECRET_TOKEN_FILE = "/run/secrets/eve-telegram-webhook-secret";

/**
 * The real bot username comes from `TELEGRAM_BOT_USERNAME`. When it is unset this placeholder
 * only affects group `@mention` detection, which this
 * door does not use anyway (see `onMessage` below — the inbound gate does its own dispatch
 * decision and never reaches eve's default group-mention logic).
 */
const PLACEHOLDER_BOT_USERNAME = "lares_example_bot_UNSET";

function botUsername(): string {
  return process.env["TELEGRAM_BOT_USERNAME"] ?? PLACEHOLDER_BOT_USERNAME;
}

/**
 * Reads a secret from disk, on every call. Deliberately uncached and deliberately lazy:
 * `eve build` evaluates this module to compile the agent, and a build — like CI — has no
 * secrets at all. Anything read at module scope fails the image build outright.
 *
 * Errors name the path and never the contents, matching `lib/gateway-provider.ts` and
 * `agent/channels/slack.ts`.
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
 * Credentials in the shape eve documents for both: `TelegramBotToken` and
 * `TelegramWebhookSecretToken` are each `string | ( => string | Promise<string>)`, so
 * both are async functions here, read at request time — never at module scope (the
 * eve-build-has-no-secrets trap, restated in `agent/channels/slack.ts`). Unlike Slack's
 * `signingSecret` (typed as a plain string there, forcing a getter), Telegram's own type
 * accepts a function directly for the webhook secret too.
 */
export const telegramCredentials: {
  botToken: () => Promise<string>;
  webhookSecretToken: () => Promise<string>;
} = {
  botToken: async () => { await assertDoorAuthority("telegram"); return readSecret("TELEGRAM_BOT_TOKEN_FILE", DEFAULT_BOT_TOKEN_FILE); },
  webhookSecretToken: async () => { await assertDoorAuthority("telegram", true); return readSecret("TELEGRAM_WEBHOOK_SECRET_TOKEN_FILE", DEFAULT_WEBHOOK_SECRET_TOKEN_FILE); },
};

/**
 * One fixed line back to a chat the door has not accepted yet (the claim confirmation, the
 * "cannot act on that yet" line). The normal credentials refuse to hand out the bot token until
 * the owner's claim is applied, which is exactly the moment these lines are needed, so this reads
 * the token file directly. It is reachable only from the claim handler, after eve has verified
 * the webhook, and it can send nothing but the fixed text passed in.
 */
async function replyBeforeClaimApplied(chatId: string | number, text: string): Promise<void> {
  await sendTelegramMessage({
    credentials: { botToken: async () => readSecret("TELEGRAM_BOT_TOKEN_FILE", DEFAULT_BOT_TOKEN_FILE) },
    chatId,
    body: { text },
  });
}

/**
 * Who may start a turn. A verified webhook secret proves only that *Telegram* sent the
 * update, not that the person behind it is trusted. Unlike Slack, a Telegram PRIVATE chat
 * passes everything through eve's default dispatch logic by default — there is no
 * workspace boundary to lean on — so this allowlist is the ONLY gate, and it must fail
 * closed: an unset or blank `TELEGRAM_PRINCIPAL_ID` (`lib/principals.ts`) admits nobody,
 * across every chat type, private included.
 *
 * Bots (including the bot's own echoes) are rejected outright, matching
 * `agent/channels/slack.ts`'s `isAllowedSlackUser`.
 *
 * Also rejects anything that isn't a private 1:1 chat. This door has no group code path;
 * this states that scope explicitly rather than by omission. Without this check, identity
 * alone would admit every message the allowed principal sends in ANY chat the bot is a
 * member of — including a group — which is MORE permissive than even eve's own default
 * group-dispatch logic (which additionally requires an @mention/command/reply-to-bot).
 *
 * This gates who may START a turn, not who may APPROVE one — a tap on an approval card is
 * handled by eve before any authored inbound handler reaches it. Who may make that tap is
 * decided at the webhook front door (`lib/telegram-tap-gate.ts`), before the tap reaches eve at
 * all, against the same `lib/principals.ts` list `lib/approvals.ts` reads.
 */
export function isAllowedTelegramMessage(message: TelegramMessage): boolean {
  const from = message.from;
  if (!from || from.isBot) return false;
  if (message.chat.type !== "private") return false;
  return isAllowedPrincipalId("telegram", from.id);
}

/**
 * Drops content-free updates (e.g. service messages carrying no text, caption, or
 * attachment) — the one piece of eve's non-exported `defaultOnMessage` worth keeping
 * once `onMessage` is otherwise fully overridden. Exported so the gate is testable on
 * its own, separate from the identity check above.
 */
export function hasDispatchableContent(message: TelegramMessage): boolean {
  return (
    message.text.trim().length > 0 ||
    message.caption.trim().length > 0 ||
    message.attachments.length > 0
  );
}

/** turns a consumed carry-forward summary (or its absence) into the `context` array
 *  onMessage returns. Exported so this formatting is testable without reaching into the
 *  compiled channel object. */
export function buildRotationContext(pendingContext: string | null): readonly string[] | undefined {
  if (!pendingContext) return undefined;
  return [
    "[conversation summary — continuity notes from the prior day's thread; the full log " +
      "was not carried forward. Facts marked as looked-up may be stale — re-check stores " +
      "before asserting them.]\n" + pendingContext,
  ];
}

/** The three gates that decide whether a `content.completed` event is even a candidate for
 *  rotation tracking — the turn's reply (`phase: "reply"`, not narration before a tool call), on
 *  the allowed principal's private chat. Exported so the gate logic is testable in isolation. */
export function shouldTrackForRotation(
  phase: string, chatType: string | null, chatId: string | null,
): chatId is string {
  return phase === "reply" && chatType === "private" && !!chatId
    && isAllowedPrincipalId("telegram", chatId);
}

/**
 * The events this door answers in eve's place. Each one below reproduces what eve's default did
 * and adds this door's own part.
 */
const replacedEvents = {
  // The reply, then session rotation: logs the reply, writes down which durable session
  // answered, and — once the calendar day (in the home time zone) has rolled over since this
  // chat's live session was anchored — leaves a carry-forward summary waiting for the next
  // message. The retirement of the previous day's session itself happens at the webhook front
  // door (`telegram-webhook.ts`), the only place eve hands out `attachSession`; see
  // `lib/telegram-rotation.ts`. Scoped to the allowed principal's private chat only.
  "content.completed": onContentCompleted,
  // A capped turn says so instead of failing generically. In eve 1.0 one failure is one event:
  // a failure the session survives ends the TURN (`turn.settled`, outcome `failed`), a failure
  // it does not survive ends the SESSION (`session.ended`, outcome `failed`) and the turn
  // carries no error of its own. A gateway budget refusal can arrive as either.
  "turn.settled": onTurnSettled,
  "session.ended": onSessionEnded,
  // A card shows how it ended and loses its buttons once it is settled.
  "interaction.settled": onInteractionSettled,
} satisfies TelegramChannelEvents;

export default telegramChannel({
  // This channel listens on an INNER path. The public webhook URL is unchanged and is owned by
  // agent/channels/telegram-webhook.ts, which refuses the taps that may not be answered, clears
  // the reply-to-bot marker and retires the previous day's conversation before it forwards here.
  // No setWebhook change: the URL Telegram posts to is the same one it always has been.
  route: TELEGRAM_INNER_ROUTE,
  botUsername: botUsername(),
  credentials: telegramCredentials as {
    botToken: TelegramBotToken;
    webhookSecretToken: TelegramWebhookSecretToken;
  },
  // Voice/audio: the door declines gracefully rather than reading audio. Audio stays out of
  // allowedMediaTypes for the same reason. What eve's channel does with a disallowed-type
  // inbound message (silent drop vs a visible reply) is NOT verified here — no live bot to
  // test against. Do not assume parity until it is checked against a live bot.
  uploadPolicy: TELEGRAM_UPLOAD_POLICY,
  // Routes Bot API calls through the squid proxy via eve's documented per-call seam —
  // never the global dispatcher (that stays Slack's, in lib/slack-dispatcher.ts).
  api: { fetch: telegramFetch },
  // Fully overrides eve's default dispatch (`defaultOnMessage`), which is not exported
  // for reuse. This is deliberately simpler than the default's group-mention/command
  // logic: the Telegram door is
  // single-principal and private-chat-only with no group support. The one piece of default behaviour worth keeping is dropping
  // content-free updates (e.g. service messages), so that check is kept explicit here.
  //
  // Whatever this returns, eve dispatches the update as a MESSAGE (`from(...).send(...)`). Text
  // typed into the chat is never turned into the answer to a card here: only a tap on one of
  // eve's own buttons is resumed as an answer, and the front door has already decided who may
  // make that tap.
  onMessage: async (ctx, message) => {
    if (await interceptTelegramClaim(message, undefined, process.env, (text) => replyBeforeClaimApplied(message.chat.id, text))) return null;
    if (!isAllowedTelegramMessage(message)) return null;
    // a voice note, video, sticker, contact or a file outside the policy used to vanish
    // (an empty message, or a turn that never knew a file came). The note names it for the chief of staff.
    const unreadable = telegramUnreadableNote(message, TELEGRAM_UPLOAD_POLICY);
    if (!hasDispatchableContent(message) && unreadable === null) return null;
    await ctx.telegram.startTyping();

    // session rotation (lib/telegram-rotation.ts): log this turn and consume any
    // carry-forward summary a PRIOR turn's day-boundary rotation left waiting. Best-effort —
    // a DB hiccup here must never block a real inbound message from the owner.
    let pendingContext: string | null = null;
    try {
      const pool = getPool();
      const text = message.text || message.caption;
      if (text) await recordExchange(pool, message.chat.id, "user", text);
      pendingContext = await consumePendingContext(pool, message.chat.id);
    } catch (err) {
      console.error("telegram-rotation: onMessage log/consume failed (continuing without it)", err);
    }

    const auth = defaultTelegramAuth(message);
    let continuityContext: string[] = [];
    let admittedAuth = auth ? {
      ...auth,
      attributes: {
        ...auth.attributes,
        ...(message.replyToMessage ? { lares_route_decline_reply_anchor: `telegram:${message.replyToMessage.messageId}` } : {}),
      },
    } : auth;
    if (auth) {
      try {
        const continuity = await nativeConversationContinuity("telegram", auth);
        continuityContext = continuity.context;
        if (continuity.identity) admittedAuth = {
          ...auth,
          attributes: { ...auth.attributes, ...continuityAuthAttributes(continuity.identity) },
        };
      } catch (err) {
        console.warn("telegram continuity unavailable; continuing without archived context", err instanceof Error ? err.message : "unknown error");
      }
    }
    const context = [...continuityContext, ...(buildRotationContext(pendingContext) ?? []), ...(unreadable ? [unreadable] : [])];
    return {
      auth: admittedAuth,
      ...(context.length > 0 ? { context } : {}),
    };
  },
  // One-tap proposal buttons (see lib/proposal-buttons.ts). eve hands every callback query that
  // is not one of its own buttons here, with the tapper's identity — handleProposalCallback
  // verifies it against the Telegram allowlist before resolving. The Bot API calls go through
  // the handle eve built for this tap, which is bound to the chat the button sits in and to the
  // channel's own credentials and proxied fetch. Failures inside the handler must never throw
  // back into the channel (a tap is not worth a 500 to Telegram).
  onCallbackQuery: async (ctx, query) => {
    try {
      const pool = getPool();
      const outcome = await handleProposalCallback(query, {
        resolveNotion: async (id, action) => {
          await resolveProposal(pool, id, action);
        },
        resolveAtlas: async (id, action) => {
          await resolveAtlasProposal(pool, id, action);
        },
        answer: async (callbackQueryId, text) => {
          await ctx.telegram.answerCallbackQuery({ callbackQueryId, text });
        },
        // The chat is the handle's: the announcement the button sits on. `handleProposalCallback`
        // passes that same chat's id, so it is not read again here.
        removeButtons: async (_chatId, messageId) => {
          await ctx.telegram.editMessageReplyMarkup({ messageId });
        },
        confirm: async (_chatId, text) => {
          await ctx.telegram.sendMessage(text);
        },
      });
      if (outcome === "not-a-proposal-callback") {
        // Mirror eve's default for callbacks nobody claims: ack so the client's spinner
        // clears, and say so honestly.
        await ctx.telegram.answerCallbackQuery({ callbackQueryId: query.id, text: "Unsupported action." }).catch(() => {});
      }
    } catch (err) {
      console.error("telegram onCallbackQuery failed", err);
    }
  },
  // SUPPLYING A HANDLER REPLACES eve's DEFAULT FOR THAT EVENT (`{...defaultEvents, ...events}` in
  // telegramChannel); see `replacedEvents` above. Events not named there keep eve's default — in
  // particular `interaction.opened`, which renders an approval card, posts it and registers its
  // buttons. This door does not touch that.
  events: {
    ...replacedEvents,
    // Once per stored line, after that line's handlers have run — so after eve has posted the
    // cards the line opened. A card that could not show everything gets its pointer to the
    // console here. `committed` is the framework's own per-line handler for every channel
    // (`ChannelEvents` in `eve/channels`, wired by `defineChannel`); the Telegram channel's
    // narrower `TelegramChannelEvents` type does not list it, hence the cast. It replaces
    // nothing: eve's Telegram channel has no per-line handler of its own.
    committed: onLineCommitted satisfies NonNullable<ChannelEvents<TelegramEventContext>["committed"]>,
  } as TelegramChannelEvents,
});

// ── A card that could not show everything ───────────────────────────────────────────────

/**
 * The console's Waiting on you page for one request, from `LARES_CONSOLE_URL` — or null when it is
 * unset or not an http(s) address, in which case the note says to open the console instead.
 * The page selects the request by eve's interaction id (`?request=<id>`). EXPORTED for tests.
 */
export function waitingPageLink(interactionId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env["LARES_CONSOLE_URL"]?.trim();
  if (!raw) return null;
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    return null;
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return null;
  const url = new URL("waiting", base.href.endsWith("/") ? base.href : `${base.href}/`);
  url.searchParams.set("request", interactionId);
  return url.href;
}

/** What is said under a card that could not show everything. EXPORTED for tests. */
export function shortenedCardNote(link: string | null): string {
  const lead = "The request above is shortened: Telegram cannot show all of it, so it cannot be approved here.";
  return link === null
    ? `${lead} Open the console to read the whole of it and approve it there. Deny still works here.`
    : `${lead} Read the whole of it and approve it in the console: ${link}\nDeny still works here.`;
}

/** What a note that could not be removed is changed to, once its request is decided. */
export const SHORTENED_NOTE_CLOSED_TEXT = "The request above is closed.";

/** This door's own record of the notes it posted, by request: the Telegram message each one is.
 *  Kept in the channel's state under a key of the door's own, as eve's upgrade guide asks. */
const NOTES_KEY = "laresShortenedCardNotes";

function postedNotes(state: object): Record<string, string> {
  const held = (state as Record<string, unknown>)[NOTES_KEY];
  if (!isRecord(held)) return {};
  return Object.fromEntries(Object.entries(held).filter((e): e is [string, string] => typeof e[1] === "string"));
}

/**
 * True when eve posted a card for this approval WITHOUT an Approve button.
 *
 * The framework patch leaves Approve off a card whose text was cut, at Telegram's limit or by the
 * approval summary itself. That decision is made inside the renderer and is not reported
 * anywhere, so it is read off what the renderer left behind in the channel's state: a card on
 * record for the request (`hitlPrompts`), buttons registered for it (`hitlCallbacks`, one entry
 * per button eve actually rendered), and none of them answering `approve`.
 *
 * Both are fields eve keeps for itself, like the one `takePostedCard` reads. Anything missing or
 * shaped differently answers false: no note is posted, which costs a pointer and nothing else.
 * `tests/telegram-approval-card.test.ts` renders cut and whole cards through the installed,
 * patched eve and checks this against the buttons that were really sent.
 */
function wasPostedWithoutApprove(state: object, interactionId: string): boolean {
  const held = state as { hitlPrompts?: unknown; hitlCallbacks?: unknown };
  if (!isRecord(held.hitlPrompts) || !isRecord(held.hitlPrompts[interactionId])) return false;
  if (!isRecord(held.hitlCallbacks)) return false;
  const answers = Object.values(held.hitlCallbacks)
    .filter((entry): entry is Record<string, unknown> => isRecord(entry) && entry["interactionId"] === interactionId)
    .map((entry) => entry["optionId"]);
  return answers.length > 0 && !answers.includes(APPROVE_OPTION_ID);
}

/** The slice of eve's event context `onLineCommitted` uses. */
interface CommittedLineContext {
  readonly channel: {
    readonly state: { chatId: string | null };
    readonly telegram: { post(message: string): Promise<{ id?: unknown }> };
  };
}

/**
 * `committed` — one stored line's facts, after that line's own handlers have run.
 *
 * For each approval the line opened whose card eve posted without an Approve button, one message
 * goes out under the card: it cannot be approved here, and here is where it can — the console's
 * Waiting on you page for that request, when `LARES_CONSOLE_URL` is set. It is a message of its
 * own, not part of the card: the card's text is composed inside the framework, which does not
 * know the request's id there, and this door does not redraw the card.
 *
 * The note is remembered under the door's own state key so that it is posted once and can be
 * taken away when the request is decided (`onInteractionSettled`).
 *
 * Never throws, and a failed send costs one log line: the card itself is already up, with Deny.
 * EXPORTED for tests.
 */
export async function onLineCommitted(
  line: { readonly facts: ReadonlyArray<{ readonly type: string; readonly data?: unknown }> },
  ctx: CommittedLineContext,
): Promise<void> {
  for (const fact of line.facts) {
    try {
      if (fact.type !== "interaction.opened" || !isRecord(fact.data)) continue;
      const interactionId = fact.data["interactionId"];
      const request = fact.data["request"];
      if (typeof interactionId !== "string" || !isRecord(request) || request["kind"] !== "approval") continue;
      // Only where Approve was on offer and eve left it off. A request that never offered it is
      // not "shortened".
      const offered = Array.isArray(request["options"]) && request["options"].some((o) => isRecord(o) && o["id"] === APPROVE_OPTION_ID);
      if (!offered || !wasPostedWithoutApprove(ctx.channel.state, interactionId)) continue;
      const notes = postedNotes(ctx.channel.state);
      if (notes[interactionId] !== undefined) continue;

      const posted = await ctx.channel.telegram.post(shortenedCardNote(waitingPageLink(interactionId)));
      if (typeof posted?.id === "string" && posted.id.length > 0) {
        (ctx.channel.state as Record<string, unknown>)[NOTES_KEY] = { ...notes, [interactionId]: posted.id };
      }
    } catch (err) {
      console.error("telegram approval card: could not say where a shortened request can be approved", err instanceof Error ? err.message : "unknown error");
    }
  }
}

/**
 * Takes away the note posted under a shortened card, now that its request is decided: the note
 * is only true while the card is open. Deleted when Telegram allows it; a message it will no
 * longer delete is changed to say the request is closed. Forgotten either way. Never throws.
 */
async function removeShortenedCardNote(ctx: SettledCardContext, interactionId: string): Promise<void> {
  try {
    const { [interactionId]: noteId, ...rest } = postedNotes(ctx.channel.state);
    if (noteId === undefined) return;
    (ctx.channel.state as Record<string, unknown>)[NOTES_KEY] = rest;
    const chatId = ctx.channel.state.chatId;
    if (!chatId) return;
    const deleted = await ctx.channel.telegram.request("deleteMessage", { chat_id: chatId, message_id: Number(noteId) });
    if (deleted.ok) return;
    const edited = await ctx.channel.telegram.editMessageText({ messageId: noteId, text: SHORTENED_NOTE_CLOSED_TEXT });
    if (!edited.ok) console.error(`telegram approval card: could not take away a shortened card's note (HTTP ${edited.status})`);
  } catch (err) {
    console.error("telegram approval card: could not take away a shortened card's note", err instanceof Error ? err.message : "unknown error");
  }
}

// ── The card, once it is settled ────────────────────────────────────────────────────────

/** What a settled approval card says under its text. */
export const APPROVAL_OUTCOME_TEXT = {
  approved: "✅ Approved",
  denied: "✖ Denied",
  /** Nobody decided: the request was withdrawn, interrupted, expired or otherwise closed. */
  notApproved: "✖ Not approved — this was closed without an answer.",
} as const;

/** Added under the outcome when the card was closed because the agent proposed a revised one. */
export const APPROVAL_REVISED_TEXT = "Revised — see the new card";

/** What a settled card that is not an approval says (a question with buttons, a budget prompt). */
export const PROMPT_OUTCOME_TEXT = { answered: "Answered", closed: "No longer needed" } as const;

/** Telegram's cap on one message's text. */
const TELEGRAM_TEXT_MAX = 4096;

/** A card eve posted for one request: the Telegram message it is, the text it shows, its buttons. */
interface PostedCard {
  readonly messageId: string;
  readonly text: string;
  readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Takes the card eve posted for a request out of the channel's state, or returns undefined when
 * there is none (the request was never posted in this chat, or its card was already taken).
 *
 * THIS READS A FIELD eve KEEPS FOR ITSELF. eve 1.0 renders and posts an approval card in its own
 * `interaction.opened` handler and records the message under `hitlPrompts[interactionId]`
 * (`registerTelegramHitlPrompt` in `eve/dist/src/public/channels/telegram/hitl.js`), which is
 * where its own default `interaction.settled` reads it back from. This door replaces that
 * default to word the outcome itself, and there is no other place the card's message id exists.
 * The field is not part of eve's public state type, so everything about it is checked before it
 * is used, a missing or reshaped field means "no card" (the card is then left as it is), and
 * `tests/telegram-approval-card.test.ts` posts a card through the installed eve's own handler
 * so that a rename fails a test rather than leaving buttons on decided cards.
 *
 * Taking the card forgets it, as eve's own handler does: a card is edited once.
 */
function takePostedCard(state: object, interactionId: string): PostedCard | undefined {
  const held = state as { hitlPrompts?: unknown };
  if (!isRecord(held.hitlPrompts)) return undefined;
  const { [interactionId]: card, ...rest } = held.hitlPrompts;
  if (!isRecord(card) || typeof card["messageId"] !== "string" || card["messageId"].length === 0 || typeof card["text"] !== "string") {
    return undefined;
  }
  held.hitlPrompts = rest;
  const options = Array.isArray(card["options"])
    ? card["options"].filter(
        (o): o is { id: string; label: string } => isRecord(o) && typeof o["id"] === "string" && typeof o["label"] === "string",
      )
    : [];
  return { messageId: card["messageId"], text: card["text"], options };
}

/** Best-effort: a failed lookup answers false, so the card keeps its plain outcome. */
async function wasRevised(interactionId: string): Promise<boolean> {
  try {
    return (await answeredVia(interactionId)) === "revised";
  } catch {
    return false;
  }
}

/** The card's text with its outcome under it, inside Telegram's limit whatever the card held. */
function settledCardText(cardText: string, outcome: string): string {
  const room = TELEGRAM_TEXT_MAX - outcome.length - 2;
  const body = cardText.length <= room ? cardText : `${cardText.slice(0, room - 1).trimEnd()}…`;
  return `${body}\n\n${outcome}`;
}

/** The slice of eve's event context `onInteractionSettled` uses. */
interface SettledCardContext {
  readonly channel: {
    readonly state: { chatId: string | null };
    readonly telegram: {
      editMessageText(input: {
        messageId: string;
        replyMarkup?: Readonly<Record<string, unknown>>;
        text: string;
      }): Promise<{ ok: boolean; status: number; body?: unknown }>;
      request(method: string, body?: Record<string, string | number>): Promise<{ ok: boolean; status: number; body?: unknown }>;
    };
  };
  readonly view: SessionView;
}

/**
 * `interaction.settled` — a request eve asked a person has ended. Its card keeps its text, gains
 * how it ended on a line of its own, and loses its buttons (an empty keyboard), so it cannot be
 * tapped again. A request this chat holds no card for is left alone.
 *
 * AN APPROVAL IS "APPROVED" ONLY ON `accepted`. eve's outcomes are open-ended: `accepted` and
 * `declined` mean a person decided; `withdrawn` and `interrupted` mean nobody did (a new message
 * arrived while the card waited, the turn was cancelled), and others exist or may be added
 * (`expired`, `abandoned`, `failed`, `invalid`). Everything that is not `accepted` or `declined`
 * reads as not approved. This handler only words the card: it resumes nothing and runs nothing.
 *
 * The ledger is asked whether a card that was not approved was closed because the agent proposed
 * a revised one, and the card says so. The ledger row is settled before eve closes the request.
 *
 * Replacing eve's default also replaces what it does for a sign-in (it updates the sign-in
 * message). This agent defines no sign-in on Telegram; one would need that part put back here.
 *
 * Never throws: an event handler that throws parks the session, and a card that stays unedited
 * is not worth that. Telegram's refusal is a returned `{ ok: false }`, not an exception, so it is
 * checked and logged (status and Telegram's own description only — never the card text).
 * EXPORTED for tests.
 */
export async function onInteractionSettled(
  event: { readonly data: { readonly interactionId: string; readonly outcome: string } },
  ctx: SettledCardContext,
): Promise<void> {
  // Whatever happens to the card, a note this door put under it goes: it said the request could
  // still be approved in the console, and it no longer can.
  await removeShortenedCardNote(ctx, event.data.interactionId);
  try {
    const { interactionId, outcome } = event.data;
    const asked = interaction(ctx.view, interactionId);
    const card = takePostedCard(ctx.channel.state, interactionId);
    if (card === undefined) {
      if (asked?.request.kind === "approval") {
        console.warn("telegram approval card: no posted card on record for a settled approval — nothing to edit");
      }
      return;
    }

    let line: string;
    if (asked?.request.kind === "approval") {
      if (outcome === "accepted") {
        line = APPROVAL_OUTCOME_TEXT.approved;
      } else {
        line = outcome === "declined" ? APPROVAL_OUTCOME_TEXT.denied : APPROVAL_OUTCOME_TEXT.notApproved;
        if (await wasRevised(interactionId)) line = `${line}\n${APPROVAL_REVISED_TEXT}`;
      }
    } else if (outcome === "accepted" || outcome === "declined") {
      // Not an approval (or a request this view no longer holds): say only that it was answered,
      // and with which button when that is known. Never "Approved".
      const chosen = card.options.find((o) => o.id === asked?.answer?.optionId)?.label;
      line = chosen === undefined ? PROMPT_OUTCOME_TEXT.answered : `${PROMPT_OUTCOME_TEXT.answered}: ${chosen}`;
    } else {
      line = PROMPT_OUTCOME_TEXT.closed;
    }

    const result = await ctx.channel.telegram.editMessageText({
      messageId: card.messageId,
      replyMarkup: { inline_keyboard: [] },
      text: settledCardText(card.text, line),
    });
    if (!result.ok) {
      const description = (result.body as { description?: unknown } | undefined | null)?.description;
      console.error(
        `telegram approval card: could not show the outcome (HTTP ${result.status}${typeof description === "string" ? `: ${description}` : ""})`,
      );
    }
  } catch (err) {
    console.error("telegram approval card: could not show the outcome", err);
  }
}

// ── A failed turn, a failed session ─────────────────────────────────────────────────────

/**
 * What the agent says on Telegram when its gateway key hits its cap.
 *
 * Same condition, same sentence and the same reasoning as `agent/channels/slack.ts` (read its
 * docblock, including why the sentence is English by default). Only the dialect differs: eve
 * words its own default failure text slightly differently per channel, and the non-budget path
 * has to reproduce THIS channel's version.
 *
 * Posted as a plain string, not through `mdToTelegramHtml`: the sentence carries no markdown,
 * and eve's own failure posts are plain strings too, so the non-budget path stays identical
 * to what eve would have posted.
 */
const BUDGET_EXCEEDED_TEXT =
  "I have hit my spending cap — nothing was done. It resets with the next budget period, or you can raise the cap.";

const FAILURE_OPTIONS = { refusalText: BUDGET_EXCEEDED_TEXT, dialect: "telegram" } as const;

/** The post surface these handlers need — eve's event context satisfies it. */
interface FailureContext {
  readonly channel: { readonly telegram: { post(message: string): Promise<unknown> } };
}

/** A turn's or a session's ending, as eve 1.0 reports it: an outcome and, on a failure, the
 *  error. This is the event's `data`, and it is handed to `@lares/agent-kit/gateway-budget` as it
 *  is: the kit reads `outcome` and `error: { code, message, id }` itself. */
interface EndingEvent {
  readonly data: FailureEventData;
}

/** `turn.settled` — a turn that FAILED says so. Any other outcome posts nothing, as eve's default.
 *  EXPORTED for tests, the same convention as `onContentCompleted` below. */
export async function onTurnSettled(event: EndingEvent, ctx: FailureContext): Promise<void> {
  if (event.data.outcome !== "failed") return;
  const response = respondToTurnFailed(event.data, FAILURE_OPTIONS);
  if (response.kind === "silent") return;
  if (response.kind === "budget-refusal") {
    console.warn("chief-of-staff telegram: gateway budget exceeded — answered with the fixed refusal; nothing was executed");
  }
  await ctx.channel.telegram.post(response.text);
}

/**
 * `session.ended` — a session that FAILED says so. A session that ended any other way (the day
 * boundary retiring it, a timeout) posts nothing, as eve's default.
 *
 * A budget refusal the gateway answers with a 400 is terminal, and in eve 1.0 a terminal failure
 * is reported HERE and nowhere else. `fail()` in eve's `harness/session-machine/transitions.js`
 * emits EITHER `turn.settled` (failed) OR `session.ended` (failed), never both, and ending the
 * session closes its open turn as `cancelled` with no error (`cascade.js`). So this handler asks
 * the kit the turn question first and answers a refusal itself. `respondToSessionFailed` stays
 * silent on a refusal, and asking only that would leave a capped turn with no answer at all.
 */
export async function onSessionEnded(event: EndingEvent, ctx: FailureContext): Promise<void> {
  if (event.data.outcome !== "failed") return;
  const refusal = respondToTurnFailed(event.data, FAILURE_OPTIONS);
  if (refusal.kind === "budget-refusal") {
    console.warn("chief-of-staff telegram: gateway budget exceeded — answered with the fixed refusal; nothing was executed");
    await ctx.channel.telegram.post(refusal.text);
    return;
  }
  const response = respondToSessionFailed(event.data, FAILURE_OPTIONS);
  if (response.kind === "silent") return;
  await ctx.channel.telegram.post(response.text);
}

// ── The reply ───────────────────────────────────────────────────────────────────────────

/** The slice of eve's event context `onContentCompleted` uses. */
interface ReplyContext {
  readonly channel: {
    readonly state: { chatId: string | null; chatType: string | null };
    readonly telegram: { post(message: { text: string; parse_mode: string }): Promise<{ id?: unknown }> };
  };
  readonly session: { readonly id: string; readonly auth?: { readonly current?: { readonly attributes?: Readonly<Record<string, unknown>> } | null } };
}

/** The reply handler — EXPORTED for tests (an outage once shipped precisely because nothing
 *  exercised this function: it replaced eve's default handler without reproducing the default's
 *  telegram.post). */
export async function onContentCompleted(
  event: { readonly data: { readonly kind: string; readonly phase: string; readonly value?: unknown } },
  ctx: ReplyContext,
): Promise<void> {
  const { kind, phase, value } = event.data;
  // DELIVER THE REPLY FIRST — and this is the whole reason the handler exists at all costs.
  // Supplying "content.completed" here REPLACES eve's default handler, and the default's job IS
  // the `telegram.post` that makes the assistant's reply visible in the chat. This override once
  // shipped without the post: every reply and every brief on Telegram was silently undelivered
  // while raw sends (reminders, proposal buttons) kept working and masked it. Mirrors the
  // default (`replyTextOf` in eve's `public/channels/reply.js`) exactly: post a text part whose
  // phase is `reply`, and nothing else — not narration before a tool call, not an empty part.
  const reply = kind === "text" && phase === "reply" && typeof value === "string" && value.length > 0 ? value : undefined;
  if (reply !== undefined) {
    // As Telegram HTML, so `**bold**` renders instead of arriving as literal asterisks. Chunked
    // here rather than left to eve's `post`: its own splitter passes the body's extra fields to
    // the FIRST chunk only, so every later chunk would lose `parse_mode` and arrive as visible
    // tag soup. Splitting on newlines is safe because `mdToTelegramHtml` never opens a tag on
    // one line and closes it on another.
    const requestId = ctx.session.auth?.current?.attributes?.["lares_route_decline_request_id"];
    const chunks = splitTelegramHtml(mdToTelegramHtml(reply));
    let firstMessageId: string | undefined;
    for (const chunk of chunks) {
      const posted = await ctx.channel.telegram.post({ text: chunk, parse_mode: "HTML" });
      if (!firstMessageId && typeof posted?.id === "string" && posted.id) firstMessageId = posted.id;
    }
    if (typeof requestId === "string" && firstMessageId) {
      await markRouteDeclineQuestionSent(getPool(), requestId, `telegram:${firstMessageId}`);
    }
  }

  const { chatId, chatType } = ctx.channel.state;
  if (!shouldTrackForRotation(phase, chatType, chatId)) return;

  try {
    const pool = getPool();
    const today = homeDay();
    await recordExchange(pool, chatId, "assistant", reply ?? "");
    const state = await getRotationState(pool, chatId, today);

    // The session id is knowable only from inside the turn, and the front door needs it to
    // retire this conversation at the next day boundary. Written on EVERY reply, not only on a
    // rotation: the door reads the last one it finds. Without it the boundary simply passes —
    // the day's conversation keeps answering — so it is worth a line.
    const sessionId = ctx.session?.id;
    if (sessionId) await recordServingSession(pool, chatId, today, sessionId);
    else console.warn("telegram-rotation: the reply carried no session id — the next day boundary has nothing to retire");

    if (!dayHasRolledOver(state, today)) return;

    // The previous day's session has already been retired at the door, before the message
    // that opened this one was forwarded. What is left here is the hand-over: summarize the
    // day being closed and leave it waiting, for `onMessage` to consume into the next turn.
    // Committing the rotation after the summary is the safe direction it always was — a
    // crash in between re-summarizes on the next reply rather than never.
    //
    // UNLESS THE NIGHT ALREADY DID IT. When the overnight hand-over wrote this day's summary
    // (`runDayHandover`), the message that opened this session was answered WITH it, and
    // there is nothing left to produce: only the anchor day moves, so the boundary is not
    // detected again. Re-summarizing here would spend a second model call on the same day
    // and leave a second, differently-worded summary waiting for the next message.
    if (state.handoverDay === state.homeDay) {
      await advanceRotationDay(pool, chatId, today);
    } else {
      const summary = await summarizeRecentExchanges(pool, chatId);
      await completeRotation(pool, chatId, today, summary, state.homeDay);
    }
    await pruneOldExchanges(pool);
  } catch (err) {
    console.error("telegram-rotation: reply-time rotation failed (keeping the live session)", err);
  }
}
