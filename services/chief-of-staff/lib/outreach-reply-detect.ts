/**
 * Pure reply detection for a tracked outreach thread (ORB-75). Given a thread's messages,
 * find the earliest one that is NOT from the sending account and arrived after the outreach
 * was sent — same "who sent this" comparison brief-content.ts's obligation scan uses
 * (`addressOf`), plus the same calendar-notice exclusion (a Google-generated RSVP is sent
 * FROM the real attendee's address and would otherwise look like a reply).
 */
export interface ThreadMessageLike {
  from: string;
  sentAt: string; // RFC-2822 Date header
  isCalendarNotice: boolean;
}

/** The address inside "Name <email>", lowercased — local copy of brief-content.ts's
 *  addressOf, same "three-line helper, not worth a shared import" convention. */
function addressOf(header: string): string {
  const m = /<([^>]+)>/.exec(header);
  return (m?.[1] ?? header).trim().toLowerCase();
}

/** The earliest qualifying reply, or null if none. `sentAfter` is the outreach's own send
 *  time — only messages strictly after it count. */
export function detectReply<T extends ThreadMessageLike>(messages: T[], account: string, sentAfter: Date): T | null {
  const mine = account.toLowerCase();
  const candidates = messages
    .filter((m) => !m.isCalendarNotice)
    .filter((m) => addressOf(m.from) !== mine)
    .filter((m) => Date.parse(m.sentAt) > sentAfter.getTime())
    .sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
  return candidates[0] ?? null;
}
