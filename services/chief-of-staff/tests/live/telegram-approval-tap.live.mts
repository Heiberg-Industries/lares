/**
 * tests/live/telegram-approval-tap.live.mts — the LIVE sweep behind the Telegram tap gate
 * (`lib/telegram-tap-gate.ts`, W7A-s3).
 *
 * Per the root CLAUDE.md's third-party rule — "a fixture is what we believe an API does; only a
 * live call is what it does." `tests/telegram-tap-gate.test.ts` proves the decision against a
 * fixture of a `callback_query` update. A fixture cannot tell us either of the two things the
 * front door now depends on:
 *
 *   1. THE UPDATE SHAPE. The gate reads `callback_query.from.id`, `callback_query.id`,
 *      `callback_query.message.chat.id` and the `callback_data` prefix off the body Telegram
 *      POSTs. If `from.id` ever arrives as something `asId` refuses, an allowed approver's own
 *      tap is REFUSED — a false alarm the owner would meet as "you may not answer your own card".
 *      If the prefix is not what eve's `hitl.js` says it builds, a stranger's tap is FORWARDED.
 *      Both are silent.
 *   2. WHAT `answerCallbackQuery` DOES WITH AN ID THAT IS NOT FRESH. The door answers a refused
 *      tap and wraps that call in try/catch. Telegram expires a callback query after a short
 *      window and rejects a second answer to the same one — but whether eve's helper THROWS or
 *      returns `{ok: false}` on that decides whether the catch is doing anything at all, and
 *      whether a refusal ever surfaces as a red error line for a tap that was refused correctly.
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
 * cancels or forwards anything, and it prints no message text, no card payload and no token.
 */
import { answerTelegramCallbackQuery } from "eve/channels/telegram";
import { telegramFetch } from "@lares/agent-kit/telegram-fetch";

import { telegramCredentials } from "../../agent/channels/telegram.js";
import { HITL_CALLBACK_PREFIX, refusedApprovalTap } from "../../lib/telegram-tap-gate.js";
import { allowedPrincipalIds } from "../../lib/principals.js";

const [callbackQueryId, rawArgument] = process.argv.slice(2);

// ── 1. Why `getUpdates` is not how this is captured ──────────────────────────────────────
// A bot with a webhook set cannot long-poll, so the raw update has to come from the door's own
// log. Printing the webhook state says plainly which regime this container is in.
const token = await telegramCredentials.botToken();
const info = await telegramFetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
const infoBody = (await info.json()) as { ok: boolean; result?: Record<string, unknown> };
console.log("getWebhookInfo ok    :", infoBody.ok, `(http ${info.status})`);
console.log("  webhook url set    :", Boolean(infoBody.result?.["url"]));
console.log("  allowed_updates    :", JSON.stringify(infoBody.result?.["allowed_updates"] ?? "(default)"));
console.log("  pending updates    :", JSON.stringify(infoBody.result?.["pending_update_count"]));
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
      "data starts with the HITL prefix:",
      typeof data === "string" && data.startsWith(HITL_CALLBACK_PREFIX),
      `(expected prefix ${JSON.stringify(HITL_CALLBACK_PREFIX)}; the rest is a base-36 counter)`,
    );
    // The verdict the front door would reach on this exact body, with this container's allowlist.
    const verdict = refusedApprovalTap(raw);
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
      const result = await answerTelegramCallbackQuery({
        credentials: telegramCredentials,
        callbackQueryId,
        text: "Live probe — nothing was done.",
        showAlert: true,
        fetch: telegramFetch,
      });
      console.log(`answerCallbackQuery attempt ${attempt}: returned`, JSON.stringify(result));
    } catch (err) {
      // THE branch the front door's catch exists for.
      console.log(`answerCallbackQuery attempt ${attempt}: THREW`, err instanceof Error ? err.message : String(err));
    }
  }
}
