import { MEMBER_LIMIT_SENTENCE, INSTALLATION_LIMIT_SENTENCE } from "@lares/agent-kit/limit-sentences";
import { APPROVAL_REPLY_REFUSED_SENTENCE, isApprovalReplyRefused } from "@lares/agent-kit/approval-reply-sentence";

/**
 * The plain spending-limit sentence the gateway wrote, when the newest turn on this session ended
 * as a refused model call for a monthly limit; otherwise null. The message is repeated ONLY when it
 * is exactly one of the two shapes the keeper writes; nothing else a failure says is ever shown.
 *
 * Read from the session's own events. A turn ends with one `turn.settled` event; a failed one has
 * `outcome: "failed"` and `error: { code, message }`. A session that is over ends with
 * `session.ended`, and that is never a limit reply: the member cannot write into it again.
 *
 * The reply after an approval answer that was refused is answered the same way, with its one
 * fixed sentence (`@lares/agent-kit/approval-reply-sentence`): the answer was applied, the
 * conversation carries on, and the member can ask what happened.
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
    if (isApprovalReplyRefused(message)) return APPROVAL_REPLY_REFUSED_SENTENCE;
    return MEMBER_LIMIT_SENTENCE.test(message) || INSTALLATION_LIMIT_SENTENCE.test(message) ? message : null;
  }
  return null;
}
