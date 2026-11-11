/**
 * src/telegram-reply-fix.ts — at an agent's Telegram door, a REPLY to the bot is a message.
 *
 * ## What eve does with a reply to a bot message (1.0.0-rc.9)
 *
 * `node_modules/eve/dist/src/public/channels/telegram/state.js`, in `stateFromTelegramMessage`:
 *
 * ```js
 * replyToBotMessageId: e.replyToMessage?.from?.isBot === true ? e.replyToMessage.messageId : null
 * ```
 *
 * and `telegramChannel.js`, in the channel's `deliver` hook:
 *
 * ```js
 * let r = [...(e.answers ?? []), ...telegramReplyAnswers(n?.replyToBotMessageId, e.message)];
 * if (r.some(isTelegramSyntheticResponse)) {
 *   let n = resolveTelegramAnswers(t.state, r);
 *   return n.length > 0 ? { answers: n, context: e.context }
 *        : e.message === void 0 ? void 0 : { message: e.message, context: e.context };
 * }
 * ```
 *
 * A reply to a bot message is first offered as an ANSWER to a pending free-text prompt
 * (`telegram_reply:<message id>`, matched against `pendingFreeformReplies` in `hitl.js`). Only
 * when no prompt was posted as that message does it fall back to being a message.
 *
 * ## Why this file exists, and why it stayed across the upgrade
 *
 * In eve 0.32 through 0.60 there was no fallback: a reply to any bot message with no free-text
 * prompt pending was dropped. The turn made no model call, sent nothing and logged no error, so
 * an agent looked deaf to the most natural way of talking to a bot. This fix was written for
 * that. eve 1.0 added the fallback, so the swallow is gone upstream.
 *
 * The rewrite is kept because its effect is still wanted, and is now a rule of the door: with the
 * marker cleared, eve never builds a `telegram_reply:` answer at all, so TYPED TEXT IS ALWAYS A
 * MESSAGE AND NEVER AN ANSWER. Nothing typed into the chat, as a reply to a card or otherwise,
 * can be read as the answer to a request eve posted. `tests/telegram-reply-fix.test.ts` runs the
 * shipped eve's own parser on a rewritten update and fails if the marker moves.
 *
 * ## The fix
 *
 * eve's branch keys on one boolean: `reply_to_message.from.is_bot`. The front door
 * (`agent/channels/telegram-webhook.ts`) sees the raw update first, so it clears that one flag
 * before forwarding. Everything else in the update is passed through untouched; in particular
 * `reply_to_message.message_id` and `from.username` survive, which is what an agent's own
 * reply-tagging reads.
 *
 * ## TRIPWIRE — read before adding a free-text eve prompt to an agent using this fix
 *
 * This is right only for an agent that issues **zero** eve free-text requests (`force_reply`
 * prompts) — true today for the chief of staff: its human-in-the-loop step is tool APPROVAL, and
 * eve renders a request with options as inline buttons, answered by a tap
 * (`renderTelegramInteraction` falls back to `force_reply` only when a request has no options at
 * all).
 *
 * The day something here asks a free-text question, the answer would arrive as a normal message
 * instead of resolving the prompt — so make the rewrite conditional then.
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
