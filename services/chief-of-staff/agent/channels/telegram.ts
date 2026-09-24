import {interceptTelegramClaim} from '@lares/agent-kit/door-channels';
import {assertDoorAuthority,managedIdentity} from '@lares/agent-kit/door-authority';
/**
 * The Telegram door.
 *
 * Inbound reaches this channel the long way round, per ADR-0011: Telegram POSTs to
 * `https://telegram.example.com/eve/v1/telegram`, a path-scoped nginx relay on ops-1
 * forwards that one path over the tailnet, and `tailscale serve` on agent-1 hands it to
 * this container. The relay verifies nothing — eve checks
 * `X-Telegram-Bot-Api-Secret-Token` here, where the secret lives.
 *
 * Outbound goes the other long way round: `lib/telegram-fetch.ts` routes Bot API calls
 * through the squid proxy via eve's per-call `api.fetch` seam, because the box's seal
 * drops anything else.
 *
 * This is the shadow/code-only slice of Task 14, pulled forward because Task 10
 * (reminders) imports this module. The remaining Task 14 steps — DNS, the relay's second
 * server block, the shadow BotFather bot, box secrets, the Kuma monitor, and any live
 * message/HITL test — are NOT done here. See task-14-code-report.md for the full list of
 * what is deferred and why.
 */
import { readFileSync } from "node:fs";
import {
  answerTelegramCallbackQuery,
  defaultTelegramAuth,
  editTelegramMessageReplyMarkup,
  sendTelegramMessage,
  telegramChannel,
  type TelegramBotToken,
  type TelegramMessage,
  type TelegramWebhookSecretToken,
} from "eve/channels/telegram";

import { isAllowedPrincipalId } from "../../lib/principals.js";
import { telegramFetch } from "@lares/agent-kit/telegram-fetch";
import { TELEGRAM_INNER_ROUTE } from "@lares/agent-kit/telegram-routes";
import { mdToTelegramHtml, splitTelegramHtml } from "@lares/agent-kit/telegram-markdown";
import { getPool } from "@lares/agent-kit/db";
import { OFFICE_MEDIA_TYPES } from "@lares/agent-kit/attachment-hydration";
import { telegramUnreadableNote } from "@lares/agent-kit/unreadable-content";
import {
  respondToSessionFailed,
  respondToTurnFailed,
  type FailureEventData,
} from "@lares/agent-kit/gateway-budget";
import { handleProposalCallback } from "../../lib/proposal-buttons.js";
import { resolveProposal, resolveAtlasProposal } from "../../lib/proposals-store.js";
import {
  advanceRotationDay,
  completeRotation,
  consumePendingContext,
  dayHasRolledOver,
  getRotationState,
  osloDay,
  pruneOldExchanges,
  recordExchange,
  recordServingSession,
  summarizeRecentExchanges,
} from "../../lib/telegram-rotation.js";

/**
 * What this door lets through to Saga. Office files joined on 2026-09-14 (ORB-286): agent-kit's
 * attachment hydration now extracts their text; before that they were dropped here unseen.
 * Voice and audio stay out — nothing reads them yet (ORB-221); the unreadable-content note says so.
 */
export const TELEGRAM_UPLOAD_POLICY = {
  allowedMediaTypes: ["image/*", "application/pdf", "text/*", ...OFFICE_MEDIA_TYPES],
  maxBytes: 10 * 1024 * 1024,
};

const DEFAULT_BOT_TOKEN_FILE = "/run/secrets/eve-telegram-bot-token";
const DEFAULT_WEBHOOK_SECRET_TOKEN_FILE = "/run/secrets/eve-telegram-webhook-secret";

/**
 * No real bot exists yet — Task 14's remaining BotFather step (Step 6 of the full brief)
 * creates the shadow `@lares_saga_eve_bot` and sets this for real via the box's compose
 * env. Until then this placeholder only affects group `@mention` detection, which this
 * door does not use anyway (see `onMessage` below — the inbound gate does its own dispatch
 * decision and never reaches eve's default group-mention logic).
 */
const PLACEHOLDER_BOT_USERNAME = "lares_saga_eve_bot_UNSET";

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
 * `TelegramWebhookSecretToken` are each `string | (() => string | Promise<string>)`, so
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
 * Also rejects anything that isn't a private 1:1 chat. The old door
 * (`services/agent-runtime/lib/adapters/door-telegram.ts`) had no group code path at all;
 * this matches that scope explicitly rather than by omission. Without this check, identity
 * alone would admit every message the allowed principal sends in ANY chat the bot is a
 * member of — including a group — which is MORE permissive than even eve's own default
 * group-dispatch logic (which additionally requires an @mention/command/reply-to-bot).
 *
 * This gates who may START a turn, not who may APPROVE one — HITL button clicks are
 * handled by eve before any authored inbound handler reaches them, so that check lives in
 * `lib/approvals.ts` against the same `lib/principals.ts` list.
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

/** ORB-74: turns a consumed carry-forward summary (or its absence) into the `context` array
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

/** ORB-74: the three gates that decide whether a `message.completed` event is even a
 *  candidate for rotation tracking — a terminal reply (not tool-call narration), on the
 *  allowed principal's private chat. Exported so the gate logic is testable in isolation. */
export function shouldTrackForRotation(
  finishReason: string, chatType: string | null, chatId: string | null,
): chatId is string {
  return finishReason === "stop" && chatType === "private" && !!chatId
    && isAllowedPrincipalId("telegram", chatId);
}

export default telegramChannel({
  // ORB-111: this channel now listens on an INNER path. The public webhook URL is unchanged and
  // is owned by agent/channels/telegram-webhook.ts, which puts a reply-to-Saga back on eve's
  // ordinary message path (eve routes it as an input response and then drops it). No setWebhook
  // change: the URL Telegram posts to is the same one it always has been.
  route: TELEGRAM_INNER_ROUTE,
  botUsername: botUsername(),
  credentials: telegramCredentials as {
    botToken: TelegramBotToken;
    webhookSecretToken: TelegramWebhookSecretToken;
  },
  // Voice/audio parity verdict (recorded 2026-08-14, see task-14-brief.md — don't re-derive):
  // the old door declines gracefully rather than reading audio. Audio stays out of
  // allowedMediaTypes for the same reason. What eve's channel does with a disallowed-type
  // inbound message (silent drop vs a visible reply) is NOT verified here — no live bot to
  // test against. Flagged in task-14-code-report.md as deferred to Task 14's live-testing
  // phase; do not assume parity until it is checked there.
  uploadPolicy: TELEGRAM_UPLOAD_POLICY,
  // Routes Bot API calls through the squid proxy via eve's documented per-call seam —
  // never the global dispatcher (that stays Slack's, in lib/slack-dispatcher.ts).
  api: { fetch: telegramFetch },
  // Fully overrides eve's default dispatch (`defaultOnMessage`), which is not exported
  // for reuse. This is deliberately simpler than the default's group-mention/command
  // logic: the old Telegram door (`services/agent-runtime/lib/adapters/door-telegram.ts`)
  // was single-principal, private-chat-only with no group support, and this shadow bot
  // has the same scope. The one piece of default behaviour worth keeping is dropping
  // content-free updates (e.g. service messages), so that check is kept explicit here.
  onMessage: async (ctx, message) => {
    if (await interceptTelegramClaim(message)) return null;
    if (!isAllowedTelegramMessage(message)) return null;
    // ORB-286: a voice note, video, sticker, contact or a file outside the policy used to vanish
    // (an empty message, or a turn that never knew a file came). The note names it for Saga.
    const unreadable = telegramUnreadableNote(message, TELEGRAM_UPLOAD_POLICY);
    if (!hasDispatchableContent(message) && unreadable === null) return null;
    await ctx.telegram.startTyping();

    // ORB-74 session rotation (lib/telegram-rotation.ts): log this turn and consume any
    // carry-forward summary a PRIOR turn's day-boundary rotation left waiting. Best-effort —
    // a DB hiccup here must never block a real inbound message from Bendik.
    let pendingContext: string | null = null;
    try {
      const pool = getPool();
      const text = message.text || message.caption;
      if (text) await recordExchange(pool, message.chat.id, "user", text);
      pendingContext = await consumePendingContext(pool, message.chat.id);
    } catch (err) {
      console.error("telegram-rotation: onMessage log/consume failed (continuing without it)", err);
    }

    const context = [...(buildRotationContext(pendingContext) ?? []), ...(unreadable ? [unreadable] : [])];
    return {
      auth: defaultTelegramAuth(message),
      ...(context.length > 0 ? { context } : {}),
    };
  },
  // One-tap proposal buttons (2026-08-16 — see lib/proposal-buttons.ts). eve hands every
  // NON-HITL callback query here, and unlike HITL taps these carry the tapper's identity —
  // handleProposalCallback verifies it against the Telegram allowlist before resolving.
  // The api calls reuse the channel's own credentials + proxied fetch; failures inside the
  // handler must never throw back into the channel (a tap is not worth a 500 to Telegram).
  onCallbackQuery: async (_ctx, query) => {
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
          await answerTelegramCallbackQuery({
            credentials: telegramCredentials,
            callbackQueryId,
            text,
            fetch: telegramFetch,
          });
        },
        removeButtons: async (chatId, messageId) => {
          await editTelegramMessageReplyMarkup({
            credentials: telegramCredentials,
            chatId,
            messageId,
            replyMarkup: undefined,
            fetch: telegramFetch,
          });
        },
        confirm: async (chatId, text) => {
          await sendTelegramMessage({
            credentials: telegramCredentials,
            chatId,
            body: { text },
            fetch: telegramFetch,
          });
        },
      });
      if (outcome === "not-a-proposal-callback") {
        // Mirror eve's default for callbacks nobody claims: ack so the client's spinner
        // clears, and say so honestly.
        await answerTelegramCallbackQuery({
          credentials: telegramCredentials,
          callbackQueryId: query.id,
          text: "Unsupported action.",
          fetch: telegramFetch,
        }).catch(() => {});
      }
    } catch (err) {
      console.error("telegram onCallbackQuery failed", err);
    }
  },
  events: {
    // ORB-74 session rotation: logs the terminal reply, writes down which durable session
    // answered, and — once the Oslo calendar day has rolled over since this chat's live
    // session was anchored — leaves a carry-forward summary waiting for the next message.
    // The retirement of the previous day's session itself happens at the webhook front door
    // (`telegram-webhook.ts`), the only place eve hands out `attachSession`; see
    // `lib/telegram-rotation.ts` for why a rename cannot do it any more. Scoped to the allowed
    // principal's private chat only — group/supergroup sessions already anchor per-thread and
    // are untouched. Gated on finishReason === "stop" so interim tool-call narration (which
    // also fires message.completed) is never logged or treated as a turn boundary. Failures
    // are swallowed: rotation must never break a live reply that already reached the user.
    "message.completed": onMessageCompleted,
    // ORB-188 item 2 — a capped turn says so instead of failing generically. Same trap as
    // `message.completed` above: supplying a handler REPLACES eve's default, so both of
    // these reproduce the default's own text for every non-budget failure.
    "turn.failed": onTurnFailed,
    "session.failed": onSessionFailed,
  },
});

/**
 * ORB-188 item 2 — what Saga says on Telegram when her gateway key hits its cap.
 *
 * Same condition, same sentence and the same reasoning as `agent/channels/slack.ts` (read its
 * docblock, including why the sentence is English while Marcel's is Norwegian). Only the
 * dialect differs: eve words its own default failure text slightly differently per channel —
 * Telegram writes the error id plain, Slack italicises it in backticks — and the non-budget
 * path has to reproduce THIS channel's version.
 *
 * Posted as a plain string, not through `mdToTelegramHtml`: the sentence carries no markdown,
 * and eve's own failure posts are plain strings too, so the non-budget path stays identical
 * to what the chat saw before.
 */
const BUDGET_EXCEEDED_TEXT =
  "I have hit my spending cap — nothing was done. It resets with the next budget period, or you can raise the cap.";

const FAILURE_OPTIONS = { refusalText: BUDGET_EXCEEDED_TEXT, dialect: "telegram" } as const;

/** The post surface these handlers need — eve's `TelegramEventContext` satisfies it. */
interface FailureChat {
  readonly telegram: { post(message: unknown): Promise<unknown> };
}

/** `turn.failed` — EXPORTED for tests, the same convention as `onMessageCompleted` below. */
export async function onTurnFailed(data: FailureEventData, channel: FailureChat): Promise<void> {
  const response = respondToTurnFailed(data, FAILURE_OPTIONS);
  if (response.kind === "silent") return;
  if (response.kind === "budget-refusal") {
    console.warn("eve-saga telegram: gateway budget exceeded — answered with the fixed refusal; nothing was executed");
  }
  await channel.telegram.post(response.text);
}

/**
 * `session.failed` — a budget refusal is terminal, so eve emits it right after `turn.failed`
 * for the same fault. `onTurnFailed` already answered; this stays quiet so a capped turn
 * produces exactly one sentence. Everything else keeps eve's default text.
 */
export async function onSessionFailed(data: FailureEventData, channel: FailureChat): Promise<void> {
  const response = respondToSessionFailed(data, FAILURE_OPTIONS);
  if (response.kind === "silent") return;
  await channel.telegram.post(response.text);
}

/** ORB-74's terminal-reply handler — EXPORTED for tests (the 2026-08-17 outage shipped
 *  precisely because nothing exercised this function: it replaced eve's default handler
 *  without reproducing the default's telegram.post). */
export async function onMessageCompleted(
  data: { finishReason: string; message?: string | null },
  channel: {
    state: { chatId: string | null; chatType: string | null };
    telegram: { post(message: unknown): Promise<unknown> };
  },
  ctx: { session: { id: string } },
): Promise<void> {
      // DELIVER THE REPLY FIRST — and this line is the whole reason the handler exists at
      // all costs. Supplying "message.completed" here REPLACES eve's default handler
      // (`{...defaultEvents, ...events}` in telegramChannel), and the default's job IS the
      // `telegram.post` that makes the assistant's reply visible in the chat. QA finding
      // 2026-08-17: this override shipped without the post — every session reply and every
      // brief on Telegram was silently undelivered (the schedule still logged "delivered",
      // because eve accepted the send), while raw sends (reminders, proposal buttons) kept
      // working and masked it. Mirrors defaultEvents exactly: post unless the turn is
      // interim tool-call narration or empty.
      if (data.finishReason !== "tool-calls" && data.message) {
        // ORB-112 — as Telegram HTML, so `**bold**` renders instead of arriving as literal
        // asterisks. Chunked here rather than left to eve's `post`: its own splitter passes the
        // body's extra fields to the FIRST chunk only, so every later chunk would lose
        // `parse_mode` and arrive as visible tag soup. Splitting on newlines is safe because
        // `mdToTelegramHtml` never opens a tag on one line and closes it on another.
        for (const chunk of splitTelegramHtml(mdToTelegramHtml(data.message))) {
          await channel.telegram.post({ text: chunk, parse_mode: "HTML" } as never);
        }
      }

      const { chatId, chatType } = channel.state;
      if (!shouldTrackForRotation(data.finishReason, chatType, chatId)) return;

      try {
        const pool = getPool();
        const today = osloDay();
        await recordExchange(pool, chatId, "assistant", data.message ?? "");
        const state = await getRotationState(pool, chatId, today);

        // The session id is knowable only from inside the turn, and the front door needs it to
        // retire this conversation at the next day boundary. Written on EVERY terminal reply,
        // not only on a rotation: the door reads the last one it finds. Without it the boundary
        // simply passes — the day's conversation keeps answering — so it is worth a line.
        const sessionId = ctx?.session?.id;
        if (sessionId) await recordServingSession(pool, chatId, today, sessionId);
        else console.warn("telegram-rotation: message.completed carried no session id — the next day boundary has nothing to retire");

        if (!dayHasRolledOver(state, today)) return;

        // The previous day's session has already been retired at the door, before the message
        // that opened this one was forwarded. What is left here is the hand-over: summarize the
        // day being closed and leave it waiting, for `onMessage` to consume into the next turn.
        // Committing the rotation after the summary is the safe direction it always was — a
        // crash in between re-summarizes on the next terminal reply rather than never.
        //
        // UNLESS THE NIGHT ALREADY DID IT. When the overnight hand-over wrote this day's summary
        // (`runDayHandover`), the message that opened this session was answered WITH it, and
        // there is nothing left to produce: only the anchor day moves, so the boundary is not
        // detected again. Re-summarizing here would spend a second model call on the same day
        // and leave a second, differently-worded summary waiting for the next message.
        if (state.handoverDay === state.osloDay) {
          await advanceRotationDay(pool, chatId, today);
        } else {
          const summary = await summarizeRecentExchanges(pool, chatId);
          await completeRotation(pool, chatId, today, summary, state.osloDay);
        }
        await pruneOldExchanges(pool);
      } catch (err) {
        console.error("telegram-rotation: message.completed rotation failed (keeping the live session)", err);
      }
}
