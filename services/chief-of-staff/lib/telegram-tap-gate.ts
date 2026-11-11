/**
 * lib/telegram-tap-gate.ts — which button taps may reach the agent on Telegram.
 *
 * WHY THIS EXISTS. A tap on an approval card executes a real action, and the webhook front door
 * (`agent/channels/telegram-webhook.ts`) is the first code of ours that sees it. This gate
 * refuses a tap from anyone who is not an allowed approver THERE, before the update is forwarded
 * to the framework at all: nothing is resumed, nothing is recorded as an answer, and the card
 * stays up for whoever may actually answer it.
 *
 * eve 1.0 does pass the tapper on (`dispatchCallbackQuery` in
 * `eve/dist/src/public/channels/telegram/telegramChannel.js` resumes a tap with
 * `auth: defaultTelegramAuth({ ...message, from: query.from })`), and its own approval check
 * compares that identity with the requester's. This gate does not lean on either: it is the
 * door's own line, in front of the framework, and it reads the same allowlist every other
 * enforcement point reads (`lib/principals.ts`).
 *
 * HOW A TAP IS RECOGNISED — read off the shipped eve 1.0.0-rc.9 code, not guessed.
 * Telegram caps `callback_data` at 64 bytes, so eve keeps the real answer in durable channel
 * state and puts only a short id on the button. Three lanes exist in this chat:
 *
 *   - APPROVAL CARDS (and any other request eve posts with buttons). `registerTelegramCallback`
 *     in `eve/dist/src/public/channels/telegram/hitl.js` builds
 *     `` `${TELEGRAM_HITL_CALLBACK_PREFIX}${n.toString(36)}` `` from the counter
 *     `nextHitlCallbackId` and stores the answer under that key in `hitlCallbacks`. On the wire
 *     that is `eve:` followed by a base-36 number: `eve:0`, `eve:1`, … `eve:1a`.
 *     `dispatchCallbackQuery` routes on `data.startsWith("eve:")`.
 *   - eve's SIGN-IN buttons: `eve_auth:` followed by the requester's Telegram user id
 *     (`authorization.js`, `authorization-callback.js`). This agent defines no sign-in today; the
 *     lane is recognised so that the day one appears it is gated like a card, not waved through.
 *   - OUR PROPOSAL BUTTONS: `np:a:61` / `ap:r:7` (`lib/proposal-buttons.ts`). They carry their
 *     own identity check in `handleProposalCallback`, which also answers the tapper, so this gate
 *     leaves them strictly alone: refusing them here too would answer the same tap twice.
 *
 * FAIL CLOSED FOR A TAP. The gate decides from what it positively recognises:
 *   - a proposal button is forwarded (that lane refuses a stranger itself);
 *   - one of eve's own buttons is forwarded only for an allowed approver;
 *   - ANYTHING ELSE that is a tap is refused, whoever tapped: callback data in no known lane,
 *     data that only resembles eve's (`eve:` with something other than a base-36 number after
 *     it), no data at all, a `callback_query` that is not an object. If a later eve changes how
 *     it encodes an approval tap, the taps stop here and say so, instead of passing unchecked.
 *
 * FAIL OPEN FOR EVERYTHING THAT IS NOT A TAP, absolutely. A message, an edit, a body that is not
 * JSON, an empty body: this returns `null` and the front door forwards the update exactly as it
 * arrived. The door going deaf is worse than any single mishandled update, and nothing here may
 * ever be the reason a message is dropped. (eve reads `message` before `callback_query`; this
 * gate looks at `callback_query` regardless, so an update carrying both cannot use the one to
 * hide the other.)
 *
 * The question asked is "is this Telegram id an allowed approver". No id is hard-coded here and
 * no new environment variable is introduced: adding a second approver stays a comma in
 * `TELEGRAM_PRINCIPAL_ID`, not a code change.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { isAllowedPrincipalId } from "./principals.js";
import { parseProposalCallback } from "./proposal-buttons.js";

/**
 * eve's own prefix for a posted request's callback data (`TELEGRAM_HITL_CALLBACK_PREFIX`,
 * `eve/dist/src/public/channels/telegram/hitl.js`). `tests/telegram-tap-gate.test.ts` reads the
 * shipped constant and fails if it moves.
 */
export const HITL_CALLBACK_PREFIX = "eve:";

/** eve's own prefix for a sign-in button (`TELEGRAM_AUTHORIZATION_CALLBACK_PREFIX`). */
export const SIGN_IN_CALLBACK_PREFIX = "eve_auth:";

/** What a refused tapper who is not an allowed approver is told, on the tap itself. Names no payload. */
export const TAP_REFUSAL = "Only this installation's owner can answer an approval. Nothing was done.";

/** What anyone is told about a tap the gate does not recognise. Names no payload. */
export const TAP_UNRECOGNISED = "This button is not recognised, so nothing was done.";

/** Which lane a tap's callback data belongs to. */
export type TapLane = "approval" | "sign-in" | "proposal" | "unrecognised";

/**
 * Classifies callback data by the three formats in this file's header. Anything else, including
 * data that is missing or not a string, is `unrecognised`.
 */
export function tapLane(data: unknown): TapLane {
  if (typeof data !== "string") return "unrecognised";
  // The whole value, not just the prefix: `(n).toString(36)` is digits and lower-case letters.
  if (/^eve:[0-9a-z]+$/.test(data)) return "approval";
  if (/^eve_auth:[0-9]+$/.test(data)) return "sign-in";
  if (parseProposalCallback(data) !== undefined) return "proposal";
  return "unrecognised";
}

export interface RefusedTap {
  /** `callback_query.id`, for `answerCallbackQuery`. Empty when Telegram sent none we can read. */
  callbackQueryId: string;
  /** The chat the button sits in, for the log line — `null` when the update carries no message. */
  chatId: string | null;
}

/** A refused tap, with why. */
export interface TapRefusal extends RefusedTap {
  /** `not-allowed`: the tapper may not answer. `unrecognised`: the gate does not know the button. */
  reason: "not-allowed" | "unrecognised";
}

/** Telegram sends numeric ids; eve's normalisation stringifies them. Accept both, refuse the rest. */
function asId(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A tap that must NOT be forwarded, or `null` for everything that may be: a message, a proposal
 * button, one of eve's own buttons tapped by an allowed approver, a body that is not a tap at
 * all. Never throws.
 */
export function refusedTap(raw: string, env: NodeJS.ProcessEnv = process.env): TapRefusal | null {
  let update: unknown;
  try {
    update = JSON.parse(raw);
  } catch {
    return null; // Not JSON: not a tap anyone can act on. The framework rejects it too.
  }

  const envelope = asRecord(update);
  if (envelope === undefined || !("callback_query" in envelope)) return null; // A message, an edit, a service update.
  if (envelope["callback_query"] === null || envelope["callback_query"] === undefined) return null;

  // From here on the update IS a tap, so every way out that is not a positive recognition refuses.
  const query = asRecord(envelope["callback_query"]);
  const chat = asRecord(asRecord(query?.["message"])?.["chat"]);
  const refusal = (reason: TapRefusal["reason"]): TapRefusal => ({
    callbackQueryId: asId(query?.["id"]) ?? "",
    chatId: asId(chat?.["id"]) ?? null,
    reason,
  });
  if (query === undefined) return refusal("unrecognised");

  const lane = tapLane(query["data"]);
  if (lane === "proposal") return null; // Its own identity check, in `handleProposalCallback`.

  const from = asRecord(query["from"]);
  const tapper = from === undefined || from["is_bot"] === true ? undefined : asId(from["id"]);
  if (!isAllowedPrincipalId("telegram", tapper, env)) return refusal("not-allowed");
  if (lane === "unrecognised") return refusal("unrecognised");
  return null;
}

/**
 * The same verdict as `refusedTap`, without the reason: the tap that must not be forwarded, or
 * `null`. Kept under the name and with the shape this module has always exported, for callers
 * that only ask whether a tap is refused.
 */
export function refusedApprovalTap(raw: string, env: NodeJS.ProcessEnv = process.env): RefusedTap | null {
  const refused = refusedTap(raw, env);
  return refused === null ? null : { callbackQueryId: refused.callbackQueryId, chatId: refused.chatId };
}

/**
 * Did TELEGRAM send this request? The public webhook route sits in front of the framework's own
 * route, which is where the secret header is checked — AFTER this file's gate and the
 * day-boundary retirement have already acted on the body. Anything that ACTS on an update
 * (refusing a tap, answering it through the Bot API, retiring yesterday's session) must know
 * first that the update is real.
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
