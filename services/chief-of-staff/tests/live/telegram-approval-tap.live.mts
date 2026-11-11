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
 *      tap with one direct Bot API call and logs a refusal. Telegram expires a callback query
 *      after a short window and rejects a second answer to the same one — the door expects that
 *      as a returned `{ ok: false }`, not a throw.
 *
 * NOT part of `pnpm test`: it needs the live bot token, which exists only inside the deployed
 * container, and it speaks to the Bot API through the egress proxy. Run it by hand, inside that
 * container, whenever `lib/telegram-tap-gate.ts` or the front door's refusal branch changes:
 * copy this file into the container, run it with the container's own environment through `tsx`,
 * and delete it afterwards.
 *
 * It takes a callback query id as its first argument and, optionally, the raw update body as its
 * second (or on stdin) — both captured from the door's own log after tapping a card:
 *
 *     tsx telegram-approval-tap.live.mts <callback_query_id> '<raw update json>'
 *
 * With no arguments it prints only the read-only half. It WRITES NOTHING: it answers a callback
 * query (a toast on the tapper's own screen) and reads webhook metadata. It never approves,
 * denies or forwards anything, and it prints no message text, no card payload and no token.
 */
import { telegramCredentials } from "../../agent/channels/telegram.js";
import { allowedPrincipalIds } from "../../lib/principals.js";
import { callTelegramApi } from "../../lib/telegram-send.js";
import { HITL_CALLBACK_PREFIX, refusedTap, tapLane } from "../../lib/telegram-tap-gate.js";

const [callbackQueryId, rawArgument] = process.argv.slice(2);

// ── 1. Why `getUpdates` is not how this is captured ──────────────────────────────────────
// A bot with a webhook set cannot long-poll, so the raw update has to come from the door's own
// log. Printing the webhook state says plainly which regime this container is in.
const info = await callTelegramApi({ credentials: telegramCredentials, method: "getWebhookInfo" });
const infoBody = info.body as { ok?: boolean; result?: Record<string, unknown> } | null;
console.log("getWebhookInfo ok    :", info.ok, `(http ${info.status})`);
console.log("  webhook url set    :", Boolean(infoBody?.result?.["url"]));
console.log("  allowed_updates    :", JSON.stringify(infoBody?.result?.["allowed_updates"] ?? "(default)"));
console.log("  pending updates    :", JSON.stringify(infoBody?.result?.["pending_update_count"]));
console.log("allowed approvers    :", allowedPrincipalIds("telegram").length, "id(s) configured");
console.log("");

// ── 2. The update shape, as Telegram actually sends it ───────────────────────────────────
async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}
const raw = rawArgument ?? (process.stdin.isTTY ? undefined : await readStdin());
if (raw === undefined || raw.trim() === "") {
  console.log("no raw update given — skipping the shape half (pass it as argv[2] or on stdin)");
} else {
  const update = JSON.parse(raw) as { callback_query?: Record<string, unknown> };
  const query = update.callback_query;
  if (query === undefined) {
    console.log("that body carries no callback_query — tap a card and capture THAT update");
  } else {
    const from = query["from"] as Record<string, unknown> | undefined;
    const message = query["message"] as { chat?: Record<string, unknown> } | undefined;
    const data = query["data"];
    console.log("callback_query.id            typeof:", typeof query["id"]);
    console.log("callback_query.from          present:", from !== undefined);
    console.log("callback_query.from.id       typeof:", typeof from?.["id"]);
    console.log("callback_query.from.is_bot   value :", JSON.stringify(from?.["is_bot"]));
    console.log("message.chat.id              typeof:", typeof message?.chat?.["id"]);
    console.log("data                         typeof:", typeof data);
    console.log(
      "data starts with eve's prefix    :",
      typeof data === "string" && data.startsWith(HITL_CALLBACK_PREFIX),
      `(expected prefix ${JSON.stringify(HITL_CALLBACK_PREFIX)}; the rest is a base-36 counter)`,
    );
    // The lane the gate puts this tap in. For a tap on an approval card it must be "approval":
    // "unrecognised" here means the gate would refuse every tap on a real card.
    console.log("the gate reads the data as       :", tapLane(data));
    // The verdict the front door would reach on this exact body, with this container's allowlist.
    const verdict = refusedTap(raw);
    console.log("the gate would:", verdict === null ? "FORWARD it" : `REFUSE it (${JSON.stringify(verdict)})`);
  }
}
console.log("");

// ── 3. answerCallbackQuery, twice, on the same id ────────────────────────────────────────
if (callbackQueryId === undefined) {
  console.log("no callback_query id given — skipping the answer half (pass it as argv[1])");
} else {
  for (const attempt of [1, 2]) {
    try {
      const result = await callTelegramApi({
        credentials: telegramCredentials,
        method: "answerCallbackQuery",
        body: { callback_query_id: callbackQueryId, text: "Live probe — nothing was done.", show_alert: true },
      });
      console.log(`answerCallbackQuery attempt ${attempt}: returned`, JSON.stringify(result));
    } catch (err) {
      // The door expects a refusal as a returned `{ ok: false }`. If this branch is hit for a
      // stale id, the door's try/catch is what handles it, not its `ok` check.
      console.log(`answerCallbackQuery attempt ${attempt}: THREW`, err instanceof Error ? err.message : String(err));
    }
  }
}
