/**
 * agent/channels/telegram-webhook.ts — the webhook front door.
 *
 * WHY THIS EXISTS. It is the one place in our own code that sees an update before the framework
 * does, and the one place the framework hands out `attachSession`. Three things need that:
 *
 *   1. A REPLY TO THE AGENT MUST REACH THE AGENT. See `@lares/agent-kit/telegram-reply-fix` for
 *      what eve does with a reply to a bot message, and why the marker is cleared on the way in.
 *   2. A TAP THAT MAY NOT BE ANSWERED IS STOPPED HERE (`lib/telegram-tap-gate.ts`), before it is
 *      forwarded: an approval-card tap from somebody who is not an allowed approver, and any tap
 *      the gate does not recognise.
 *   3. ONE CONVERSATION PER CALENDAR DAY. Retiring a session by its exact id is the only way to
 *      give this chat one conversation per day in the home time zone (see
 *      `lib/telegram-rotation.ts`). On the first message of a new day this door ends the session
 *      recorded as having served the previous one.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not dispatch, authenticate a person, or interpret a
 * message. It forwards the body to the real Telegram channel, which listens on an INNER path.
 * Verification of the request stays where the framework does it — in the channel — and is
 * repeated here only so that nothing this file DOES is done for a request Telegram did not send.
 *
 * The external contract is unchanged: Telegram still POSTs to the same URL it always has (eve's
 * default `/eve/v1/telegram`), so there is no `setWebhook` call (eve does not make one either),
 * no window where updates go nowhere, and rollback is just the previous image.
 *
 * FAIL OPEN FOR MESSAGES, FAIL CLOSED FOR TAPS. This agent going deaf is worse than any single
 * message being mishandled: a body this file cannot read, a database it cannot reach, a chat with
 * nothing recorded — all forward unchanged, and the inbound allowlist in the channel still
 * decides alone whether a message starts a turn. A button tap is the opposite: it can execute a
 * real action, so a tap the gate refuses is never forwarded, whatever else failed.
 */
import { defineChannel, POST } from "eve/channels";

import { neutralizeBotReplyMarker } from "@lares/agent-kit/telegram-reply-fix";
import { TELEGRAM_INNER_ROUTE, TELEGRAM_PUBLIC_ROUTE } from "@lares/agent-kit/telegram-routes";
import { retirePriorDaySession } from "../../lib/telegram-rotation.js";
import { callTelegramApi } from "../../lib/telegram-send.js";
import { refusedTap, secretMatches, TAP_REFUSAL, TAP_UNRECOGNISED } from "../../lib/telegram-tap-gate.js";
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
      if (rewritten) console.log("[telegram-webhook] reply-to-bot forwarded as a message");

      // Nothing below ACTS on the update unless Telegram really sent it. The framework's inner
      // route checks the same header, but it runs after this one — and both the answer to a
      // refused tap (a Bot API call) and the day-boundary retirement (which ends a session) act
      // on the body. A secret that cannot be read counts as "not authentic".
      let authentic = false;
      try {
        authentic = secretMatches(secretToken, await telegramCredentials.webhookSecretToken());
      } catch (err) {
        console.error("[telegram-webhook] could not read the webhook secret —", err);
      }

      // The updates this door refuses: a tap by somebody who may not answer, and a tap the gate
      // does not recognise. Every message reads as null and falls straight through. The gate
      // looks at BOTH the body as it arrived and the body that is actually forwarded: the
      // reply-marker rewrite above must never be a way to show this gate one update and the
      // framework another.
      //
      // The decision does not wait on `authentic`: it is a pure reading of the body, and a tap
      // that would be refused is not forwarded even when the secret could not be checked here.
      // Only the ANSWER to the tapper needs a request Telegram really sent.
      const refused = refusedTap(body) ?? refusedTap(raw);
      if (refused) {
        if (!authentic) {
          // Not ours to answer, and not forwarded either. 401 is what the framework's own route
          // says to a request it cannot verify; if the secret was merely unreadable for a
          // moment, Telegram retries and the tap is judged again.
          console.warn("[telegram-webhook] a tap this door refuses arrived on a request it could not verify — not forwarded");
          return new Response("unauthorized", { status: 401 });
        }
        console.warn(
          refused.reason === "not-allowed"
            ? "[telegram-webhook] button tap from a principal who may not answer — not forwarded"
            : "[telegram-webhook] button tap with callback data this door does not recognise — not forwarded",
        );
        try {
          // A direct Bot API call: there is no channel handle outside a channel handler. It goes
          // through the egress proxy like every other Telegram call (`lib/telegram-send.ts`).
          const answered = await callTelegramApi({
            credentials: telegramCredentials,
            method: "answerCallbackQuery",
            body: {
              callback_query_id: refused.callbackQueryId,
              text: refused.reason === "not-allowed" ? TAP_REFUSAL : TAP_UNRECOGNISED,
              show_alert: true,
            },
          });
          if (!answered.ok) {
            console.error(`[telegram-webhook] Telegram did not take the answer to a refused tap (HTTP ${answered.status})`);
          }
        } catch (err) {
          console.error("[telegram-webhook] could not answer a refused tap —", err);
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
