/**
 * tests/live/telegram-approval-card.live.mts — the LIVE check behind a settled approval card
 * (`onInteractionSettled` in `agent/channels/telegram.ts`) and behind the sender for code that
 * has no channel handle (`lib/telegram-send.ts`).
 *
 * Per the root AGENTS.md's third-party rule — "a fixture is what we believe an API does; only a
 * live call is what it does." `tests/telegram-approval-card.test.ts` and
 * `tests/telegram-delivery.test.ts` prove the edit and the send against a mocked Bot API. A mock
 * cannot tell us the things the door depends on:
 *
 *   1. `sendMessage` RETURNS THE MESSAGE'S ID. eve keeps a card's id to edit it later, and
 *      `sendTelegramMessage` returns it to a schedule; an empty id means a card that is never
 *      edited — silently.
 *   2. `editMessageText` WITH AN EMPTY KEYBOARD REMOVES THE BUTTONS. The door sends
 *      `reply_markup: { inline_keyboard: [] }`. The edited message Telegram returns must carry no
 *      inline keyboard.
 *   3. A REFUSED EDIT IS RETURNED, NOT THROWN. The door checks `ok` and logs Telegram's
 *      description. Two refusals are provoked here: the same edit twice ("message is not
 *      modified") and an edit of a message the bot cannot edit (id 1).
 *   4. A CARD AT TELEGRAM'S LIMIT STILL TAKES ITS OUTCOME. A card of 4096 characters is posted
 *      and then settled through the door's real `onInteractionSettled`, which shortens the text
 *      to make room for the outcome line. Telegram must accept that edit.
 *   5. A REFUSED SEND IS THROWN, WITH TELEGRAM'S OWN DESCRIPTION. `sendTelegramMessage` to a chat
 *      that does not exist must throw, and the message must not contain the bot token.
 *
 * NOT part of `pnpm test`: it needs the live bot token, which exists only inside the deployed
 * container, and it reaches the Bot API through the egress proxy. Run it by hand, inside that
 * container, whenever the card handler or the sender changes: copy this file into the container,
 * run it with the container's own environment through `tsx`, and delete it afterwards.
 *
 *     tsx telegram-approval-card.live.mts
 *
 * It WRITES TWO MESSAGES: a test card in the first allowed approver's private chat, which it then
 * edits, and a second, long one, which it also edits. Their buttons carry callback data no
 * handler claims and the webhook front door does not recognise, so a tap is refused at the door
 * ("This button is not recognised"). It approves, denies and runs nothing, and it prints no token.
 */
import { emptySessionView, foldEvents } from "eve/events";

import { APPROVAL_OUTCOME_TEXT, onInteractionSettled, telegramCredentials } from "../../agent/channels/telegram.js";
import { allowedPrincipalIds } from "../../lib/principals.js";
import { callTelegramApi, sendTelegramMessage } from "../../lib/telegram-send.js";

const chatId = allowedPrincipalIds("telegram")[0];
if (chatId === undefined) {
  console.log("no allowed Telegram approver configured — nothing to send to");
  process.exit(1);
}

const TEXT = "Live probe: an approval card. Nothing will be done.";
const PROBE_KEYBOARD = { inline_keyboard: [[{ text: "Deny", callback_data: "probe:d" }, { text: "Approve", callback_data: "probe:a" }]] };

/** The edit the door makes, as one direct Bot API call. */
const editText = (messageId: string, text: string) =>
  callTelegramApi({
    credentials: telegramCredentials,
    method: "editMessageText",
    body: { chat_id: chatId, message_id: Number(messageId), reply_markup: { inline_keyboard: [] }, text },
  });

// ── 1. The card, and the id that comes back ──────────────────────────────────────────────
const sent = await sendTelegramMessage({
  credentials: telegramCredentials,
  chatId,
  body: { text: TEXT, reply_markup: PROBE_KEYBOARD },
});
console.log("sendMessage id               :", JSON.stringify(sent.id), sent.id ? "(present — the card can be edited later)" : "(EMPTY — this card could never be edited)");
if (!sent.id) process.exit(1);

// ── 2. The edit the door makes ───────────────────────────────────────────────────────────
const edit = () => editText(sent.id, `${TEXT}\n\n${APPROVAL_OUTCOME_TEXT.approved}`);
const first = await edit();
const edited = (first.body as { result?: { reply_markup?: { inline_keyboard?: unknown[] }; text?: string } } | null)?.result;
console.log("editMessageText ok / status  :", first.ok, first.status);
console.log("  buttons left on the card   :", JSON.stringify(edited?.reply_markup?.inline_keyboard ?? "(none)"));
console.log("  ends with the outcome      :", edited?.text?.endsWith(APPROVAL_OUTCOME_TEXT.approved) ?? false);

// ── 3. Refusals: returned or thrown? ─────────────────────────────────────────────────────
for (const [label, run] of [
  ["the same edit again", edit],
  ["a message the bot cannot edit", () => editText("1", "Live probe.")],
] as const) {
  try {
    const result = await run();
    const description = (result.body as { description?: unknown } | null)?.description;
    console.log(`${label.padEnd(29)}: returned ok=${result.ok} status=${result.status} description=${JSON.stringify(description)}`);
  } catch (err) {
    // If this branch is ever hit, the door's `ok` check is not what catches a refusal — its catch is.
    console.log(`${label.padEnd(29)}: THREW`, err instanceof Error ? err.message : String(err));
  }
}

// ── 4. A card at Telegram's limit, settled through the door's own handler ────────────────
const LONG = `Live probe: a long approval card. Nothing will be done.\n\n${"Every word of a long draft. ".repeat(200)}`.slice(0, 4096);
const long = await sendTelegramMessage({ credentials: telegramCredentials, chatId, body: { text: LONG, reply_markup: PROBE_KEYBOARD } });
console.log("long card: id / characters   :", JSON.stringify(long.id), LONG.length);

const INTERACTION = "live-probe-long";
const at = (line: number, event: Record<string, unknown>) => ({ ...event, meta: { position: { line, index: 0 }, at: new Date().toISOString() } });
const settled = at(4, { type: "interaction.settled", scope: { turnId: "t1" }, data: { interactionId: INTERACTION, outcome: "declined" } });
const view = foldEvents(emptySessionView(), [
  at(0, { type: "session.started", data: {} }),
  at(1, { type: "turn.started", scope: { turnId: "t1" }, data: { turnId: "t1", cause: { deliveryId: "d1" }, follows: null } }),
  at(2, { type: "call.requested", scope: { turnId: "t1" }, data: { callId: "c1", owner: { turnId: "t1" }, capability: { kind: "tool", name: "live_probe" }, input: {} } }),
  at(3, { type: "interaction.opened", scope: { turnId: "t1" }, data: { interactionId: INTERACTION, subject: { callId: "c1" }, request: { kind: "approval", prompt: LONG, options: [{ id: "deny", label: "Deny" }, { id: "approve", label: "Approve" }] } } }),
  settled,
] as never);

const edits: Array<{ ok: boolean; status: number; body?: unknown; characters: number }> = [];
await onInteractionSettled(settled as never, {
  view,
  channel: {
    // The record eve leaves for a card it posted, as the door's handler reads it.
    state: { chatId, hitlPrompts: { [INTERACTION]: { messageId: long.id, text: LONG, options: [] } } } as { chatId: string | null },
    telegram: {
      editMessageText: async (input) => {
        const result = await callTelegramApi({
          credentials: telegramCredentials,
          method: "editMessageText",
          body: { chat_id: chatId, message_id: Number(input.messageId), reply_markup: input.replyMarkup, text: input.text },
        });
        edits.push({ ...result, characters: input.text.length });
        return result;
      },
    },
  },
});
const settledCard = (edits[0]?.body as { result?: { text?: string; reply_markup?: { inline_keyboard?: unknown[] } }; description?: unknown } | null | undefined);
console.log("  edits made by the handler  :", edits.length, edits.length === 1 ? "(one)" : "(EXPECTED ONE)");
console.log("  characters in the edit     :", edits[0]?.characters, "(at most 4096)");
console.log("  Telegram took it           :", edits[0]?.ok, edits[0]?.status, edits[0]?.ok ? "" : JSON.stringify(settledCard?.description));
console.log("  ends with the outcome      :", settledCard?.result?.text?.endsWith(APPROVAL_OUTCOME_TEXT.denied) ?? false);
console.log("  buttons left on the card   :", JSON.stringify(settledCard?.result?.reply_markup?.inline_keyboard ?? "(none)"));

// ── 5. A refused send is thrown, with Telegram's own words and no token ──────────────────
const token = await telegramCredentials.botToken();
try {
  await sendTelegramMessage({ credentials: telegramCredentials, chatId: "1", body: { text: "Live probe." } });
  console.log("send to a chat that is not there: RETURNED (expected it to throw)");
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.log("send to a chat that is not there: THREW", JSON.stringify(message));
  console.log("  the error names the token  :", message.includes(token), "(must be false)");
}
