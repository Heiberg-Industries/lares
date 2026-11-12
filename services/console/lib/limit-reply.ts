import { MEMBER_LIMIT_SENTENCE, INSTALLATION_LIMIT_SENTENCE } from "@lares/agent-kit/limit-sentences";
import { approvalReplySentence } from "@lares/agent-kit/approval-reply-sentence";
import { CONVERSATION_TOO_LONG_WEB, isConversationTooLong } from "@lares/agent-kit/conversation-too-long";

/**
 * The plain spending-limit sentence the gateway wrote, when the newest turn on this session ended
 * as a refused model call for a monthly limit; otherwise null. The message is repeated ONLY when it
 * is exactly one of the two shapes the keeper writes; nothing else a failure says is ever shown.
 *
 * Read from the session's own events. A turn ends with one `turn.settled` event; a failed one has
 * `outcome: "failed"` and `error: { code, message }`. A session that is over ends with
 * `session.ended`, and that is never a limit reply: the member cannot write into it again.
 *
 * A refused reply in a turn that asked a card is answered the same way, with its fixed sentence
 * (`@lares/agent-kit/approval-reply-sentence`): either the answer was applied, or the card ended
 * without one. The conversation carries on, and the member can ask what happened.
 *
 * Only the newest ending counts, so a later, different failure is never hidden behind an older
 * limit refusal — and neither is a later turn that ended any other way.
 */
export function limitReplyOf(events: readonly { type: string; data?: unknown }[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event) continue;
    if (event.type === "session.ended") return null;
    if (event.type !== "turn.settled") continue;
    const data = event.data as { outcome?: unknown; error?: { message?: unknown } | null } | undefined;
    if (data?.outcome !== "failed") return null;
    const message = data.error?.message;
    if (typeof message !== "string") return null;
    const sentence = approvalReplySentence(message);
    if (sentence !== undefined) return sentence;
    return MEMBER_LIMIT_SENTENCE.test(message) || INSTALLATION_LIMIT_SENTENCE.test(message) ? message : null;
  }
  return null;
}

/**
 * The fixed sentence for a conversation that has grown too long, when the newest ending on this
 * session is a turn that failed because eve's summary of the history was refused
 * (`@lares/agent-kit/conversation-too-long`); otherwise null. Unlike a limit reply this IS a broken
 * conversation (every later turn in it would fail the same way), so the page keeps treating it as
 * one, with its "Start a new conversation" control, and shows this sentence in place of
 * "This conversation is unavailable." The same newest-ending rule as {@link limitReplyOf}.
 */
export function conversationTooLongOf(events: readonly { type: string; data?: unknown }[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event) continue;
    if (event.type === "session.ended") return null;
    if (event.type !== "turn.settled") continue;
    const data = event.data as { outcome?: unknown; error?: { message?: unknown } | null } | undefined;
    if (data?.outcome !== "failed") return null;
    return isConversationTooLong(data.error?.message) ? CONVERSATION_TOO_LONG_WEB : null;
  }
  return null;
}
