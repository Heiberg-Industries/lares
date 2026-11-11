/**
 * tests/live/telegram-approval-tap.live.mts — the LIVE sweep behind the Telegram tap gate
 * (`lib/telegram-tap-gate.ts`).
 *
 * Per the root AGENTS.md's third-party rule — "a fixture is what we believe an API does; only a
 * live call is what it does." `tests/telegram-tap-gate.test.ts` proves the decision against a
 * `callback_query` update whose callback data is produced by the installed eve's own renderer. A
 * fixture still cannot tell us either of the two things the front door depends on:
 *
 *   1. THE UPDATE SHAPE. The gate reads `callback_query.from.id`, `callback_query.id`,
 *      `callback_query.message.chat.id` and `callback_query.data` off the body Telegram POSTs.
 *      If `from.id` ever arrives as something `asId` refuses, an allowed approver's own tap is
 *      REFUSED — a false alarm the owner would meet as "you may not answer your own card". If the
 *      data on a real card is not what the gate recognises as an approval tap (`eve:` followed by
 *      a base-36 number), EVERY tap on a card is refused, the owner's included — the gate fails
 *      closed, so this shows up as cards nobody can answer, never as a stranger getting through.
 *   2. WHAT `answerCallbackQuery` DOES WITH AN ID THAT IS NOT FRESH. The door answers a refused
 *      tap with one direct Bot API call and logs a refusal. Telegram rejects a second answer to
 *      the same tap — the door expects that as a returned `{ ok: false }`, not a throw.
 *
 * HOW THE TAP IS CAPTURED. A bot with a webhook cannot ask Telegram for its updates, and the door
 * logs no update. So this probe asks the running door for one: it leaves a request file in the
 * container's temp directory, the door writes the shape of the NEXT tap beside it — the ids, the
 * chat type and the callback data, picked field by field (`tapShape`), never the card's text, a
 * name or a token — and the request is gone. Nothing is logged but one line saying it happened.
 *
 * NOT part of `pnpm test`: it needs the live bot token, which exists only inside the deployed
 * container, and it speaks to the Bot API through the egress proxy. Run it by hand, inside that
 * container, whenever `lib/telegram-tap-gate.ts` or the front door's refusal branch changes:
 * copy this file into the container, run it with the container's own environment through `tsx`,
 * and delete it afterwards.
 *
 *     tsx telegram-approval-tap.live.mts              read-only: the webhook's state
 *     tsx telegram-approval-tap.live.mts capture      posts a probe button, waits for you to tap it
 *     tsx telegram-approval-tap.live.mts capture-card posts nothing, waits for a tap on a REAL card
 *
 * `capture` WRITES ONE MESSAGE to the first allowed approver's chat: a button whose callback data
 * the door does not recognise, so tapping it is refused at the door and runs nothing. That answers
 * question 1 for everything but the callback data itself, and question 2.
 *
 * `capture-card` writes nothing, but THE TAP IS REAL: it answers whichever approval card you tap.
 * Use it on a card you were going to answer anyway. It is the only way to see the callback data
 * of a real card as Telegram sends it back.
 *
 * It never forwards anything and prints no message text, no card payload and no token.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { telegramCredentials } from "../../agent/channels/telegram.js";
import { allowedPrincipalIds } from "../../lib/principals.js";
import { callTelegramApi, sendTelegramMessage } from "../../lib/telegram-send.js";
import { HITL_CALLBACK_PREFIX, refusedTap, tapCapturePaths, tapLane } from "../../lib/telegram-tap-gate.js";

const mode = process.argv[2];
const WAIT_MS = 120_000;

// ── 1. The webhook's state ───────────────────────────────────────────────────────────────
const info = await callTelegramApi({ credentials: telegramCredentials, method: "getWebhookInfo" });
const infoBody = info.body as { ok?: boolean; result?: Record<string, unknown> } | null;
console.log("getWebhookInfo ok    :", info.ok, `(http ${info.status})`);
console.log("  webhook url set    :", Boolean(infoBody?.result?.["url"]));
console.log("  allowed_updates    :", JSON.stringify(infoBody?.result?.["allowed_updates"] ?? "(default)"));
console.log("  pending updates    :", JSON.stringify(infoBody?.result?.["pending_update_count"]));
console.log("allowed approvers    :", allowedPrincipalIds("telegram").length, "id(s) configured");
console.log("");

if (mode !== "capture" && mode !== "capture-card") {
  console.log("no mode given — that was the read-only half. Run with `capture` or `capture-card` for the rest.");
  process.exit(0);
}

// ── 2. Ask the door for the next tap ─────────────────────────────────────────────────────
const { request, result } = tapCapturePaths();
rmSync(result, { force: true });
writeFileSync(request, "", { mode: 0o600 });

let raw: string | undefined;
try {
  if (mode === "capture") {
    const chatId = allowedPrincipalIds("telegram")[0];
    if (chatId === undefined) {
      console.log("no allowed Telegram approver configured — nothing to send the probe button to");
      process.exit(1);
    }
    await sendTelegramMessage({
      credentials: telegramCredentials,
      chatId,
      body: {
        text: "Live probe: tap the button. Nothing will be done.",
        reply_markup: { inline_keyboard: [[{ text: "Tap me", callback_data: "probe:tap" }]] },
      },
    });
    console.log("a probe button was sent — tap it now");
  } else {
    console.log("tap a REAL approval card now — the tap answers that card");
  }

  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline && !existsSync(result)) await new Promise((resolve) => setTimeout(resolve, 500));
  if (existsSync(result)) raw = readFileSync(result, "utf8");
} finally {
  // Whatever happened, leave nothing behind: an unanswered request would capture a later tap.
  rmSync(request, { force: true });
  rmSync(result, { force: true });
}

if (raw === undefined) {
  console.log(`no tap arrived within ${WAIT_MS / 1000}s — nothing captured. Is this the container the webhook reaches?`);
  process.exit(1);
}

// ── 3. The update shape, as Telegram actually sent it ────────────────────────────────────
const update = JSON.parse(raw) as { callback_query?: Record<string, unknown> };
const query = update.callback_query ?? {};
const from = query["from"] as Record<string, unknown> | undefined;
const message = query["message"] as { chat?: Record<string, unknown> } | undefined;
const data = query["data"];
console.log("");
console.log("callback_query.id            typeof:", typeof query["id"]);
console.log("callback_query.from          present:", from !== undefined);
console.log("callback_query.from.id       typeof:", typeof from?.["id"]);
console.log("callback_query.from.is_bot   value :", JSON.stringify(from?.["is_bot"]));
console.log("message.chat.id              typeof:", typeof message?.chat?.["id"]);
console.log("message.chat.type            value :", JSON.stringify(message?.chat?.["type"]));
console.log("data                         typeof:", typeof data);
console.log(
  "data starts with eve's prefix    :",
  typeof data === "string" && data.startsWith(HITL_CALLBACK_PREFIX),
  mode === "capture"
    ? "(false is expected: this was the probe's own button)"
    : `(expected prefix ${JSON.stringify(HITL_CALLBACK_PREFIX)}; the rest is a base-36 counter)`,
);
// The lane the gate puts this tap in. For a tap on a real approval card it must be "approval":
// "unrecognised" there means the gate refuses every tap on a real card. For the probe's own
// button, "unrecognised" is the expected answer.
console.log("the gate reads the data as       :", tapLane(data));
// The verdict the front door reaches on these fields, with this container's allowlist.
const verdict = refusedTap(raw);
console.log("the gate would                   :", verdict === null ? "FORWARD it" : `REFUSE it (${verdict.reason})`);
console.log("");

// ── 4. answerCallbackQuery on an id that has already been answered ───────────────────────
// The door (or eve) answered this tap when it arrived, so both attempts below are answers to a
// tap that is no longer fresh.
const callbackQueryId = query["id"];
if (typeof callbackQueryId !== "string" || callbackQueryId.length === 0) {
  console.log("the captured tap carried no id — skipping the answer half");
} else {
  for (const attempt of [1, 2]) {
    try {
      const answered = await callTelegramApi({
        credentials: telegramCredentials,
        method: "answerCallbackQuery",
        body: { callback_query_id: callbackQueryId, text: "Live probe — nothing was done.", show_alert: true },
      });
      const description = (answered.body as { description?: unknown } | null)?.description;
      console.log(`answerCallbackQuery attempt ${attempt}: returned ok=${answered.ok} status=${answered.status} description=${JSON.stringify(description)}`);
    } catch (err) {
      // The door expects a refusal as a returned `{ ok: false }`. If this branch is hit for a
      // stale id, the door's try/catch is what handles it, not its `ok` check.
      console.log(`answerCallbackQuery attempt ${attempt}: THREW`, err instanceof Error ? err.message : String(err));
    }
  }
}
