import { MEMBER_LIMIT_SENTENCE, INSTALLATION_LIMIT_SENTENCE } from "@lares/agent-kit/limit-sentences";

/**
 * The plain spending-limit sentence the gateway wrote, when the most recent failure on this session
 * is a refused model call for a monthly limit; otherwise null. The message is repeated ONLY when it
 * is exactly one of the two shapes the keeper writes; nothing else a failure says is ever shown.
 * Only the newest failure counts, so a later, different failure is never hidden behind it.
 */
export function limitReplyOf(events: readonly { type: string; data?: unknown }[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event || (event.type !== "turn.failed" && event.type !== "session.failed")) continue;
    if (event.type !== "turn.failed") return null;
    const message = (event.data as { message?: unknown } | undefined)?.message;
    if (typeof message !== "string") return null;
    return MEMBER_LIMIT_SENTENCE.test(message) || INSTALLATION_LIMIT_SENTENCE.test(message) ? message : null;
  }
  return null;
}
