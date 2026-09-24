/**
 * agent/channels/telegram-webhook.ts — the webhook front door (ORB-111).
 *
 * WHY THIS EXISTS. eve 0.32.0 routes any reply to a bot message as an INPUT RESPONSE and then
 * drops it when no freeform prompt is pending, so replying to Saga in Telegram produces a turn
 * that makes no model call, sends nothing, and logs no error. Found and fixed on eve-marcel
 * first; her door is the same `telegramChannel` on the same eve version. See
 * `lib/telegram-reply-fix.ts` for the upstream lines and the tripwire.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not verify, dispatch, authenticate, or interpret.
 * It rewrites exactly one boolean and forwards the body to the real Telegram channel, which now
 * listens on an INNER path. Verification stays where the secret is — in the channel — so there
 * is one authority on what counts as authentic, not two.
 *
 * THE ONE THING IT LOOKS AT. eve hands `attachSession` to ROUTE handlers and to nothing else,
 * and retiring a session by its exact id is the only way left to give this chat one
 * conversation per Oslo calendar day (the channel's old rename is additive now — see
 * `lib/telegram-rotation.ts`). So on the way in this door reads one row keyed by the update's
 * chat id and, on the first update of a new day, resets the session recorded as having served
 * the previous one. It still decides nothing about the update itself: a chat with nothing
 * recorded, a body it cannot read, a database it cannot reach — all forward unchanged.
 *
 * The external contract is unchanged: Telegram still POSTs to the same URL it always has (eve's
 * default `/eve/v1/telegram`, which the channel used before this file existed), so there is no
 * `setWebhook` call, no window where updates go nowhere, and rollback is just the previous
 * image.
 *
 * FAIL-OPEN, ALWAYS — WITH ONE NAMED EXCEPTION. This agent going deaf is worse than any single
 * update being mishandled: an unparseable body is forwarded exactly as it arrived. The one thing
 * that may be stopped here is an approval-card tap from somebody who is not an allowed approver
 * (`lib/telegram-tap-gate.ts`, W7A-s3): the framework discards the tapper's identity, so this is
 * the last place it can be read at all, and a tap executes a real action. A message is never
 * refused by that gate, whoever sent it — the inbound allowlist in the channel is what decides
 * whether a message starts a turn, and it still decides it alone.
 */
import { defineChannel, POST } from "eve/channels";
import { answerTelegramCallbackQuery } from "eve/channels/telegram";

import { neutralizeBotReplyMarker } from "@lares/agent-kit/telegram-reply-fix";
import { telegramFetch } from "@lares/agent-kit/telegram-fetch";
import { TELEGRAM_INNER_ROUTE, TELEGRAM_PUBLIC_ROUTE } from "@lares/agent-kit/telegram-routes";
import { retirePriorDaySession } from "../../lib/telegram-rotation.js";
import { refusedApprovalTap, secretMatches, TAP_REFUSAL } from "../../lib/telegram-tap-gate.js";
import { telegramCredentials } from "./telegram.js";

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

function innerUrl(): string {
  const port = process.env["PORT"] ?? "3000";
  return `http://127.0.0.1:${port}${TELEGRAM_INNER_ROUTE}`;
}

export default defineChannel({
  routes: [
    POST(TELEGRAM_PUBLIC_ROUTE, async (request, { attachSession }) => {
      // Read the body ONCE, as text, so the exact bytes Telegram sent are what gets forwarded
      // whenever we do not rewrite — re-serialising would change nothing semantically but
      // everything about being able to say the channel saw what Telegram sent.
      const raw = await request.text();
      const secretToken = request.headers.get(SECRET_HEADER);
      const { body, rewritten } = neutralizeBotReplyMarker(raw);
      if (rewritten) console.log("[telegram-webhook] reply-to-bot forwarded as a message (ORB-111)");

      // The ONE update this door refuses. Only a tap on one of eve's own approval cards can end
      // up here; everything else — every message, every proposal button — reads as null and falls
      // straight through. Nothing is forwarded, so nothing executes and nothing is recorded as an
      // answer: the card stays up, unanswered, for whoever may actually answer it.
      // Nothing below ACTS on the update unless Telegram really sent it. The framework's inner
      // route checks the same header, but it runs after this one — and both the tap gate (which
      // calls the Bot API) and the day-boundary reset (which resets a session) act on the body.
      // An unauthenticated request is forwarded untouched and rejected there. A secret that
      // cannot be read counts as "not authentic": the agent still hears real messages (the
      // forward below is unconditional), it just does nothing of its own on this request.
      let authentic = false;
      try {
        authentic = secretMatches(secretToken, await telegramCredentials.webhookSecretToken());
      } catch (err) {
        console.error("[telegram-webhook] could not read the webhook secret —", err);
      }

      // The gate looks at BOTH the body as it arrived and the body that is actually forwarded:
      // the reply-marker rewrite above must never be a way to show this gate one update and the
      // framework another.
      const refused = authentic ? (refusedApprovalTap(body) ?? refusedApprovalTap(raw)) : null;
      if (refused) {
        console.warn("[telegram-webhook] approval tap from a principal who may not approve — not forwarded");
        try {
          await answerTelegramCallbackQuery({
            credentials: telegramCredentials,
            callbackQueryId: refused.callbackQueryId,
            text: TAP_REFUSAL,
            showAlert: true,
            // The Bot API is only reachable through the egress proxy — the box's seal drops
            // anything else, so this is never a bare global fetch.
            fetch: telegramFetch,
          });
        } catch (err) {
          console.error("[telegram-webhook] could not answer a refused approval tap —", err);
        }
        // 200: the tap was handled, so Telegram must not retry it.
        return new Response("ok");
      }

      // BEFORE the forward, never instead of it. This call swallows every fault it can meet and
      // has its own timeout, so the line below runs whatever happened here.
      if (authentic) await retirePriorDaySession(raw, attachSession);

      try {
        return await fetch(innerUrl(), {
          method: "POST",
          headers: {
            "content-type": request.headers.get("content-type") ?? "application/json",
            ...(secretToken === null ? {} : { [SECRET_HEADER]: secretToken }),
          },
          body,
        });
      } catch (err) {
        // Telegram retries on a non-2xx, which is what we want if the inner hop failed.
        console.error("[telegram-webhook] forward to the Telegram channel failed —", err);
        return new Response("forward failed", { status: 502 });
      }
    }),
  ],
});
