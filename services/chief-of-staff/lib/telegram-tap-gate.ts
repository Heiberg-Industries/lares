/**
 * lib/telegram-tap-gate.ts — who may answer an approval card on Telegram (W7A-s3).
 *
 * WHY THIS EXISTS. The framework discards the tapper. eve's Telegram channel resumes a
 * human-in-the-loop tap with `.respond([...], { auth: null })`
 * (`eve/dist/src/public/channels/telegram/telegramChannel.js`, `dispatchCallbackQuery`), so
 * `callback_query.from.id` — the one field that says WHO pressed the button — never reaches the
 * approval machinery. `lib/approvals.ts` can therefore only fall back to whoever opened the
 * chat-day, or to the chat a schedule declared. The honest statement about a card on Telegram
 * today is "whoever can tap this is whoever opened this conversation", not "the owner".
 *
 * The other lane in this chat already does better: `lib/proposal-buttons.ts` checks the real
 * tapper, because eve hands NON-HITL callbacks to the authored `onCallbackQuery` with the query
 * intact. This module gives the HITL lane the same check, at the one place in our own code that
 * still sees the raw update: the webhook front door (`agent/channels/telegram-webhook.ts`).
 *
 * HOW A HITL TAP IS RECOGNISED — read off eve, not guessed.
 * `eve/dist/src/public/channels/telegram/hitl.js` builds every approval button's `callback_data`
 * in `registerTelegramCallback` as `` `${TELEGRAM_HITL_CALLBACK_PREFIX}${n.toString(36)}` `` — the
 * prefix `eve:` followed by a base-36 counter (`eve:0`, `eve:1`, … `eve:1a`). Telegram caps
 * `callback_data` at 64 bytes, which is why eve keeps the real response in durable channel state
 * and puts only that short id on the wire. `dispatchCallbackQuery` routes on exactly this
 * `startsWith` test, so it is the same discrimination eve itself makes, not a parallel guess.
 *
 * The other two lanes in this chat cannot collide with it:
 *   - eve's authorization lane is `eve_auth:` (`channels/telegram/authorization.js`) — `eve_` then
 *     `a`, so it never starts with `eve:`;
 *   - our proposal buttons are `np:a:61` / `ap:r:7` (`lib/proposal-buttons.ts`), which keep their
 *     own identity check and must be left strictly alone by this gate — checking them twice would
 *     answer the same callback query twice.
 *
 * TWO OPPOSITE RULES, ON PURPOSE.
 *   - FAIL-CLOSED for a card tap. A tap this module cannot attribute to an allowed approver is
 *     refused: a stranger's id, a bot, a `from` that is missing or unreadable. Refusing a tap
 *     costs one re-ask; letting the wrong person's tap through executes a real action.
 *   - FAIL-OPEN for everything else, absolutely. A message, a proposal-button tap, a body that is
 *     not JSON at all, an empty body: this function returns `null` and the front door forwards
 *     the update exactly as it arrived. The door going deaf is worse than any single mishandled
 *     update, and nothing here may ever be the reason a message is dropped.
 *
 * Multi-user is coming, so the question asked is "is this Telegram id an allowed approver",
 * through the one allowlist every other enforcement point reads (`lib/principals.ts`). No id is
 * hard-coded here and no new environment variable is introduced: adding a second approver stays
 * a comma in `TELEGRAM_PRINCIPAL_ID`, not a code change.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { isAllowedPrincipalId } from "./principals.js";

/**
 * eve's own prefix for a HITL card's callback data (`TELEGRAM_HITL_CALLBACK_PREFIX`,
 * `eve/dist/src/public/channels/telegram/hitl.js`). A tap whose data starts with this is an
 * answer to one of eve's own input requests — in this service, an approve/cancel on a
 * tool-approval card.
 */
export const HITL_CALLBACK_PREFIX = "eve:";

/** What a refused tapper is told, on the tap itself (owner decision A3). Names no payload. */
export const TAP_REFUSAL = "Only this installation's owner can answer an approval. Nothing was done.";

export interface RefusedTap {
  /** `callback_query.id`, for `answerCallbackQuery`. Empty only if Telegram omitted it. */
  callbackQueryId: string;
  /** The chat the card sits in, for the log line — `null` when the update carries no message. */
  chatId: string | null;
}

/** Telegram sends numeric ids; eve's normalisation stringifies them. Accept both, refuse the rest. */
function asId(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/**
 * A HITL tap that must NOT be forwarded, or `null` for everything else — a message, a
 * non-HITL callback (the proposal-buttons lane), an unreadable body. Never throws.
 */
export function refusedApprovalTap(raw: string, env: NodeJS.ProcessEnv = process.env): RefusedTap | null {
  let update: unknown;
  try {
    update = JSON.parse(raw);
  } catch {
    return null; // Not JSON: not a tap we can recognise, so not ours to refuse.
  }

  const query = asRecord(asRecord(update)?.["callback_query"]);
  if (query === undefined) return null; // A message, an edit, a service update: untouched.

  const data = query["data"];
  if (typeof data !== "string" || !data.startsWith(HITL_CALLBACK_PREFIX)) return null;

  const from = asRecord(query["from"]);
  const tapper = from === undefined || from["is_bot"] === true ? undefined : asId(from["id"]);
  if (isAllowedPrincipalId("telegram", tapper, env)) return null;

  const chat = asRecord(asRecord(query["message"])?.["chat"]);
  return {
    callbackQueryId: asId(query["id"]) ?? "",
    chatId: asId(chat?.["id"]) ?? null,
  };
}

/**
 * Did TELEGRAM send this request? The public webhook route sits in front of the framework's own
 * route, which is where the secret header used to be checked — AFTER this file's gate and the
 * day-boundary reset had already acted on the body. Anything that ACTS on an update (refusing a
 * tap, answering it through the Bot API, resetting yesterday's session) must know first that the
 * update is real; an unauthenticated body is only ever forwarded, for the framework to reject.
 *
 * Compared as SHA-256 digests so the comparison is constant-time whatever the two lengths are.
 * A missing header, or an empty expected secret, is never a match.
 */
export function secretMatches(supplied: string | null | undefined, expected: string): boolean {
  if (typeof supplied !== "string" || supplied.length === 0 || expected.length === 0) return false;
  const a = createHash("sha256").update(supplied).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
