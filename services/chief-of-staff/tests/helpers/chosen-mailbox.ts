/** Stand-in for "the agent's owner chose this mailbox": the Gmail and Calendar clients are built from
 *  the stubbed googleapis objects a test supplies. The real choice (stored, rechecked, draft-only) is
 *  covered by agent-mailbox*.test.ts; tools that only need a working mailbox use this. */
import type { AgentMailboxResult } from "../../lib/agent-mailbox.js";
import {
  __setChosenMailboxForTests, makeCalendarClient, makeGmailClient, wrapCalendarApi, wrapGmailApi,
  type CalendarApi, type GmailApi,
} from "../../lib/google.js";

interface Stubs { mailbox: string; gmailApi?: GmailApi; calendarApi?: CalendarApi; ownerMemberId?: string }
let current: Stubs | null = null;

function apply(): void {
  if (!current) { __setChosenMailboxForTests(null); return; }
  const o = current;
  const result: AgentMailboxResult = {
    ok: true,
    mailbox: o.mailbox,
    ownerMemberId: o.ownerMemberId ?? "owner-1",
    gmail: makeGmailClient(wrapGmailApi(o.gmailApi ?? ({} as GmailApi), o.mailbox)),
    calendar: makeCalendarClient(wrapCalendarApi(o.calendarApi ?? ({} as CalendarApi))),
    drive: null,
    recheck: async () => true,
  };
  __setChosenMailboxForTests(result);
}

export function useChosenMailbox(o: Stubs): void { current = { ...o }; apply(); }
/** Swap the Gmail stub of the chosen mailbox (call `useChosenMailbox` first). */
export function stubChosenGmail(api: GmailApi): void { if (current) { current.gmailApi = api; apply(); } }
/** Swap the Calendar stub of the chosen mailbox (call `useChosenMailbox` first). */
export function stubChosenCalendar(api: CalendarApi): void { if (current) { current.calendarApi = api; apply(); } }

/** This agent has no mailbox chosen. */
export function useNoChosenMailbox(): void { current = null; __setChosenMailboxForTests({ ok: false, reason: "none" }); }

export function forgetChosenMailbox(): void { current = null; __setChosenMailboxForTests(null); }
