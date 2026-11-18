/**
 * lib/telegram-tap-gate.ts — which button taps may reach the agent on Telegram.
 *
 * WHY THIS EXISTS. A tap on an approval card executes a real action, and the webhook front door
 * (`agent/channels/telegram-webhook.ts`) is the first code of ours that sees it. This gate is the
 * door's adapter for Telegram (ADR-0025 rule 5): it recognises a tap, reads who tapped (Telegram's
 * own verified id) and where the card sits (the chat and message the button is on), and asks the
 * card layer (`@lares/agent-kit/card-layer`) whether the tap counts. It holds NO rule about who
 * may answer, no table of cards and no sentence: the only decision it keeps is the door's own
 * gate, whether the sender is on this door's allow-list. A tap the layer refuses is not forwarded
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
 *   - one of eve's own buttons is forwarded only when the card layer says the tap counts;
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
 * No id is hard-coded here and no new environment variable is introduced: the allow-list is
 * `TELEGRAM_PRINCIPAL_ID`, and the owner is its first id (`@lares/agent-kit/principals`).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decideTap, type CardDb } from "@lares/agent-kit/card-layer";
import { CARD_REFUSED, CARD_UNRECOGNISED } from "@lares/agent-kit/card-sentences";
import { isAllowedPrincipalId, ownerPrincipalId } from "@lares/agent-kit/principals";
import { parseProposalCallback } from "./proposal-buttons.js";

/**
 * eve's own prefix for a posted request's callback data (`TELEGRAM_HITL_CALLBACK_PREFIX`,
 * `eve/dist/src/public/channels/telegram/hitl.js`). `tests/telegram-tap-gate.test.ts` reads the
 * shipped constant and fails if it moves.
 */
export const HITL_CALLBACK_PREFIX = "eve:";

/** eve's own prefix for a sign-in button (`TELEGRAM_AUTHORIZATION_CALLBACK_PREFIX`). */
export const SIGN_IN_CALLBACK_PREFIX = "eve_auth:";

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

/** A refused tap, with why, and the sentence the card layer gave for it (said on the tap itself). */
export interface TapRefusal extends RefusedTap {
  /** `not-allowed`: the tapper may not answer. `unrecognised`: the gate does not know the button. */
  reason: "not-allowed" | "unrecognised";
  sentence: string;
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
 * button, one of eve's own buttons whose tap the card layer accepts, a body that is not a tap at
 * all. Never throws.
 */
export async function refusedTap(raw: string, env: NodeJS.ProcessEnv = process.env, db?: CardDb): Promise<TapRefusal | null> {
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
  const message = asRecord(query?.["message"]);
  const chat = asRecord(message?.["chat"]);
  const refusal = (reason: TapRefusal["reason"], sentence: string): TapRefusal => ({
    callbackQueryId: asId(query?.["id"]) ?? "",
    chatId: asId(chat?.["id"]) ?? null,
    reason,
    sentence,
  });
  if (query === undefined) return refusal("unrecognised", CARD_UNRECOGNISED);

  const lane = tapLane(query["data"]);
  if (lane === "proposal") return null; // Its own identity check, in `handleProposalCallback`.

  const from = asRecord(query["from"]);
  const tapper = from === undefined || from["is_bot"] === true ? undefined : asId(from["id"]);
  // The door's own gate: is the sender on this door's allow-list. Who may answer is the layer's.
  if (!isAllowedPrincipalId("telegram", tapper, env)) return refusal("not-allowed", CARD_REFUSED);
  if (lane === "unrecognised") return refusal("unrecognised", CARD_UNRECOGNISED);

  // Where the button sits: adapter function 3, read off the update Telegram signed.
  const channel = asId(chat?.["id"]);
  const messageId = asId(message?.["message_id"]);
  const cards = channel !== undefined && messageId !== undefined ? [{ door: "telegram", address: { channel, message: messageId } }] : [];
  const verdict = await decideTap(
    { door: "telegram", tapper, cards },
    { ownerOf: () => ownerPrincipalId("telegram", env), ...(db === undefined ? {} : { db }) },
  );
  return verdict.deliver ? null : refusal("not-allowed", verdict.sentence);
}

// ── The live probe's capture ────────────────────────────────────────────────────────────
//
// `tests/live/telegram-approval-tap.live.mts` has to see a tap as Telegram really sends it. A bot
// with a webhook cannot ask Telegram for its updates, and this door logs no update, so the probe
// asks the door for ONE: it leaves a request file in the container's temp directory, the door
// writes the shape of the next tap beside it, and the request is gone. Nothing is logged, and
// what is written is only what `tapShape` picks out.

/** Where the probe leaves its request, and where the door answers it. Read at call time. */
export function tapCapturePaths(): { request: string; result: string } {
  return {
    request: join(tmpdir(), "lares-telegram-tap-capture.request"),
    result: join(tmpdir(), "lares-telegram-tap-capture.json"),
  };
}

function primitive(value: unknown): string | number | boolean | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

/**
 * The fields of a button tap this gate reads, copied one by one, or `null` when the update is not
 * a tap. An allowlist, not a redaction: the card's text, the tapper's name and username, and
 * anything else Telegram put in the update are never copied, whatever they are. A field that is
 * not a plain value is left out.
 */
export function tapShape(raw: string): Record<string, unknown> | null {
  let update: unknown;
  try {
    update = JSON.parse(raw);
  } catch {
    return null;
  }
  const envelope = asRecord(update);
  const query = asRecord(envelope?.["callback_query"]);
  if (envelope === undefined || query === undefined) return null;
  const from = asRecord(query["from"]);
  const message = asRecord(query["message"]);
  const chat = asRecord(message?.["chat"]);
  return {
    update_id: primitive(envelope["update_id"]),
    callback_query: {
      id: primitive(query["id"]),
      ...(from === undefined ? {} : { from: { id: primitive(from["id"]), is_bot: primitive(from["is_bot"]) } }),
      ...(message === undefined
        ? {}
        : {
            message: {
              message_id: primitive(message["message_id"]),
              ...(chat === undefined ? {} : { chat: { id: primitive(chat["id"]), type: primitive(chat["type"]) } }),
            },
          }),
      data: primitive(query["data"]),
    },
  };
}

/**
 * The same verdict as `refusedTap`, without the reason: the tap that must not be forwarded, or
 * `null`. Kept under the name and with the shape this module has always exported, for callers
 * that only ask whether a tap is refused.
 */
export async function refusedApprovalTap(raw: string, env: NodeJS.ProcessEnv = process.env): Promise<RefusedTap | null> {
  const refused = await refusedTap(raw, env);
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
