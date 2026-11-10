// Reply threading: the headers and subject a draft needs to join an existing Gmail
// conversation. Gmail only threads a draft that carries the thread id, In-Reply-To and
// References per RFC 2822, and a matching subject. Both drafting paths (the chat tool and
// scheduled triage) take these from the original message through here, never from the model.
import { bareAddress } from "./reply-recipients.js";

const REPLY_PREFIX = /^\s*(?:re|sv|aw|antw|vs)\s*:/i;

/** The original's subject with one reply prefix: an existing prefix is kept as is, never stacked. */
export function replySubject(originalSubject: string): string {
  const subject = originalSubject.trim();
  if (subject === "") return "Re:";
  return REPLY_PREFIX.test(subject) ? subject : `Re: ${subject}`;
}

/** In-Reply-To and References for a reply to `original`: its References plus its own Message-ID,
 *  space-separated, de-duplicated, order kept. */
export function replyHeaders(original: { messageId?: string; references?: string }): { inReplyTo?: string; references?: string } {
  const messageId = (original.messageId ?? "").trim();
  const ids = [...(original.references ?? "").split(/\s+/), messageId].filter(Boolean);
  const references = [...new Set(ids)].join(" ");
  return {
    ...(messageId ? { inReplyTo: messageId } : {}),
    ...(references ? { references } : {}),
  };
}

/** The message a reply answers, from a thread listed oldest first: the one named by `inReplyTo`
 *  when given (undefined when the thread lacks it); otherwise the newest message not sent from one
 *  of `self`'s addresses; if every message is the owner's, the newest. */
export function pickOriginal<T extends { messageId?: string; from?: string }>(
  thread: readonly T[], inReplyTo: string | undefined, self: readonly string[],
): T | undefined {
  if (inReplyTo) return thread.find((m) => m.messageId === inReplyTo);
  const mine = new Set(self.map(bareAddress).filter(Boolean));
  const fromOthers = thread.filter((m) => !mine.has(bareAddress(m.from ?? "")));
  return (fromOthers.length > 0 ? fromOthers : thread).at(-1);
}
