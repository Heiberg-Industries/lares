/**
 * tests/live/telegram-approval-card.live.mts — the LIVE check behind a decided approval card
 * (`onInputRequested` / `onApprovalSettled` in `agent/channels/telegram.ts`).
 *
 * Per the root AGENTS.md's third-party rule — "a fixture is what we believe an API does; only a
 * live call is what it does." `tests/telegram-approval-card.test.ts` proves the edit against a
 * mocked Bot API. A mock cannot tell us the three things the door now depends on:
 *
 *   1. `sendMessage` RETURNS THE CARD'S MESSAGE ID. The door keeps it to edit the card later; an
 *      empty id means the card is never remembered and never edited — silently.
 *   2. `editMessageText` WITH AN EMPTY KEYBOARD REMOVES THE BUTTONS. The door sends
 *      `reply_markup: { inline_keyboard: [] }` (what eve's own authorization card does). The
 *      edited message Telegram returns must carry no inline keyboard.
 *   3. A REFUSED EDIT IS RETURNED, NOT THROWN. The door checks `ok` and logs Telegram's
 *      description. Two refusals are provoked here: the same edit twice ("message is not
 *      modified") and an edit of a message the bot cannot edit (id 1).
 *   4. A CARD TOO LONG FOR ONE MESSAGE goes out as ONE message of at most 4000 characters, with
 *      the note pointing at the console, a link Telegram recognises (a `url` entity), and a
 *      single Cancel button. Posted through the door's real `onInputRequested`, so what is sent
 *      is exactly what the door composes. The link uses `LARES_CONSOLE_URL`, or a placeholder
 *      address when it is unset (the link then goes nowhere; Telegram still shows whether it
 *      recognised it).
 *
 * NOT part of `pnpm test`: it needs the live bot token, which exists only inside the deployed
 * container, and it reaches the Bot API through the egress proxy. Run it by hand, inside that
 * container, whenever the card handlers change: copy this file into the container, run it with
 * the container's own environment through `tsx`, and delete it afterwards.
 *
 *     tsx telegram-approval-card.live.mts
 *
 * It WRITES TWO MESSAGES: a test card in the first allowed approver's private chat, which it then
 * edits, and the long card of step 4. The first card's buttons carry callback data no handler
 * claims, so a tap only answers "Unsupported action."; the long card's Cancel is registered only in
 * this script's throwaway state, so a tap on it resolves to nothing. It approves, cancels and runs
 * nothing, and it prints no token.
 */
import { editTelegramMessageText, sendTelegramMessage } from "eve/channels/telegram";
import { telegramFetch } from "@lares/agent-kit/telegram-fetch";

import { APPROVAL_OUTCOME_TEXT, onInputRequested, telegramCredentials } from "../../agent/channels/telegram.js";
import { allowedPrincipalIds } from "../../lib/principals.js";

const chatId = allowedPrincipalIds("telegram")[0];
if (chatId === undefined) {
  console.log("no allowed Telegram approver configured — nothing to send to");
  process.exit(1);
}

const TEXT = "Live probe: an approval card. Nothing will be done.";

// ── 1. The card, and the id the door keeps ───────────────────────────────────────────────
const sent = await sendTelegramMessage({
  credentials: telegramCredentials,
  chatId,
  body: {
    text: TEXT,
    reply_markup: { inline_keyboard: [[{ text: "Cancel", callback_data: "probe:c" }, { text: "Approve", callback_data: "probe:a" }]] },
  },
  fetch: telegramFetch,
});
console.log("sendMessage id               :", JSON.stringify(sent.id), sent.id ? "(present — the door can remember the card)" : "(EMPTY — the door would never edit this card)");
if (!sent.id) process.exit(1);

// ── 2. The edit the door makes ───────────────────────────────────────────────────────────
const edit = () =>
  editTelegramMessageText({
    credentials: telegramCredentials,
    chatId,
    messageId: sent.id,
    replyMarkup: { inline_keyboard: [] },
    text: `${TEXT}\n\n${APPROVAL_OUTCOME_TEXT.approved}`,
    fetch: telegramFetch,
  });
const first = await edit();
const edited = (first.body as { result?: { reply_markup?: { inline_keyboard?: unknown[] }; text?: string } } | undefined)?.result;
console.log("editMessageText ok / status  :", first.ok, first.status);
console.log("  buttons left on the card   :", JSON.stringify(edited?.reply_markup?.inline_keyboard ?? "(none)"));
console.log("  ends with the outcome      :", edited?.text?.endsWith(APPROVAL_OUTCOME_TEXT.approved) ?? false);

// ── 3. Refusals: returned or thrown? ─────────────────────────────────────────────────────
for (const [label, run] of [
  ["the same edit again", edit],
  [
    "a message the bot cannot edit",
    () =>
      editTelegramMessageText({
        credentials: telegramCredentials,
        chatId,
        messageId: "1",
        replyMarkup: { inline_keyboard: [] },
        text: "Live probe.",
        fetch: telegramFetch,
      }),
  ],
] as const) {
  try {
    const result = await run();
    const description = (result.body as { description?: unknown } | undefined)?.description;
    console.log(`${label.padEnd(29)}: returned ok=${result.ok} status=${result.status} description=${JSON.stringify(description)}`);
  } catch (err) {
    // If this branch is ever hit, the door's `ok` check is not what catches a refusal — its catch is.
    console.log(`${label.padEnd(29)}: THREW`, err instanceof Error ? err.message : String(err));
  }
}

// ── 4. A card too long for one message ───────────────────────────────────────────────────
if (!process.env["LARES_CONSOLE_URL"]) process.env["LARES_CONSOLE_URL"] = "https://console.example.com";
const sentLong: Array<{ id: string; raw: unknown; text: string }> = [];
await onInputRequested(
  {
    requests: [
      {
        requestId: "live-probe-long",
        kind: "tool-approval",
        prompt: `Live probe: a long approval card. Nothing will be done.\n\n${"Every word of a long draft. ".repeat(200)}`,
        options: [
          { id: "approve", label: "Approve" },
          { id: "cancel", label: "Cancel" },
        ],
        action: { kind: "tool-call", callId: "live-probe-call", toolName: "live_probe", input: {} },
      } as never,
    ],
  },
  {
    state: {},
    telegram: {
      post: async (message) => {
        const result = await sendTelegramMessage({ credentials: telegramCredentials, chatId, body: message as never, fetch: telegramFetch });
        sentLong.push({ ...result, text: message.text });
        return result;
      },
      editMessageText: async () => ({ ok: true, status: 200 }),
    },
  },
);
const longCard = (sentLong[0]?.raw as { result?: { text?: string; entities?: Array<{ type: string }>; reply_markup?: { inline_keyboard?: Array<Array<{ text: string }>> } } } | undefined)?.result;
console.log("long card: messages sent     :", sentLong.length, sentLong.length === 1 ? "(one — not split)" : "(SPLIT — the note or the keyboard may be on the wrong message)");
console.log("  characters sent            :", sentLong[0]?.text.length);
console.log("  url entity recognised      :", longCard?.entities?.some((e) => e.type === "url") ?? false);
console.log("  buttons on the card        :", JSON.stringify(longCard?.reply_markup?.inline_keyboard?.flat().map((b) => b.text) ?? "(none)"));
