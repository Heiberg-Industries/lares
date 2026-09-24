/**
 * lib/telegram-reply-fix.ts — make a REPLY to the agent's Telegram bot reach the agent (ORB-111).
 *
 * ## The bug, in eve 0.32.0, with the line that does it
 *
 * `node_modules/eve/dist/src/public/channels/telegram/telegramChannel.js`, in `dispatchMessage`:
 *
 * ```js
 * u = e.message.replyToMessage?.from?.isBot === true && l.trim().length > 0
 *       ? [telegramReplyInputResponse({ messageId: …, text: l })]
 *       : undefined;
 * …
 * u === void 0 ? await n.send(a, {…}) : await n.respond(u, {…});
 * ```
 *
 * **Any** reply to **any** bot message is routed as an INPUT RESPONSE rather than as a message —
 * unconditionally, whether or not eve is actually waiting for one. It then reaches
 * `resolveTelegramInputResponses` (`…/telegram/hitl.js`):
 *
 * ```js
 * if (r.requestId.startsWith(`telegram_reply:`)) {
 *   const t = r.requestId.slice(15), i = e.pendingFreeformReplies?.[t];
 *   i !== void 0 && r.text !== void 0 && (n.push({ requestId: i, text: r.text }), delete …);
 *   continue;                       // ← no pending prompt ⇒ the reply is DROPPED, silently
 * }
 * ```
 *
 * With nothing left to deliver, `turnStep` (`…/execution/workflow-steps.js`) takes its
 * `input?.kind === "deliver" && g === undefined` branch and returns `action: "park"`. A turn is
 * created, runs for ~20 ms, makes no model call, sends nothing, and completes. The message is
 * gone with no error anywhere.
 *
 * ## What it looked like from the outside
 *
 * The Big Apple group, 2026-08-17 — found on eve-marcel first. Marcel introduced himself at
 * 15:31:22 (message 11). Bendik replied to that message — *"Men, du skal jo ikke være
 * fransk?"* — at 15:31:50 and got nothing. `wrun_01M085KEFFDNYHVZAWX9KR09WH` is that turn:
 * 150 ms, no model call, and its decoded input carries `inputResponses: [{ requestId:
 * "telegram_reply:11", … }]` against an empty `pendingFreeformReplies`. Replying is the
 * natural way to talk to a bot in a busy family group, so from the group's side Marcel had
 * simply gone deaf. Same eve version, same channel, same swallow on every other agent using
 * this fix.
 *
 * ## The fix
 *
 * eve's branch keys on one boolean: `reply_to_message.from.is_bot`. The front door
 * (`agent/channels/telegram-webhook.ts`) already sees the raw update first, so it clears that
 * one flag before forwarding. eve then takes its ordinary `send()` path and the reply becomes a
 * normal message — which is what it always was.
 *
 * Our own reply-tagging is deliberately untouched: each agent's own `agent/channels/telegram.ts`
 * matches `isReplyToBot` on `reply_to_message.from.username`, not `is_bot`, so replying to the
 * bot in a group still counts as tagging it and still answers unconditionally.
 *
 * ## TRIPWIRE — read before adding a freeform eve prompt to an agent using this fix
 *
 * This is safe only for an agent that issues **zero** eve freeform input requests
 * (`force_reply` prompts) — true today for both:
 * - Saga: her HITL is tool APPROVAL (`approval: always()`), and eve renders an approval with
 *   options as inline buttons — the `telegram_callback:` lane, not `force_reply`
 *   (`renderTelegramInputRequest` only falls back to `force_reply` when an input request has no
 *   options at all).
 * - Marcel: no `requireAuth`/`input()` anywhere in `agent/` (grep-confirmed), and his veto and
 *   group-link buttons are inline callbacks handled by our own `onCallbackQuery`, never eve's
 *   HITL lane.
 *
 * The day something here asks a freeform question, the answer would arrive as a normal message
 * instead of resolving the prompt — so make the rewrite conditional then, or drop it if eve has
 * fixed the upstream branch.
 */

/** Shape we care about; everything else in the update is passed through untouched. */
interface MaybeReplyUpdate {
  message?: { reply_to_message?: { from?: { is_bot?: unknown } } };
}

/**
 * Returns the body to forward. Byte-identical to `raw` unless the update is a reply to a bot,
 * in which case `reply_to_message.from.is_bot` is cleared.
 *
 * Never throws: an unparseable body is forwarded exactly as it arrived, because the front door's
 * standing contract is that the agent going deaf is worse than any single update being
 * mishandled.
 */
export function neutralizeBotReplyMarker(raw: string): { body: string; rewritten: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { body: raw, rewritten: false };
  }

  const from = (parsed as MaybeReplyUpdate)?.message?.reply_to_message?.from;
  if (!from || from.is_bot !== true) return { body: raw, rewritten: false };

  from.is_bot = false;
  return { body: JSON.stringify(parsed), rewritten: true };
}
