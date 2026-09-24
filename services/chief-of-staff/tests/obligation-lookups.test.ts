import { describe, it, expect } from "vitest";

import { GoogleConfigError } from "@lares/agent-kit/google-auth";

import { GoogleUnenrolledError, type CalendarEvent, type ThreadMessage } from "../lib/google.js";
import {
  CALENDAR_LOOKUP_MAX_EVENTS,
  SENT_SEARCH_CEILING,
  gmailAfterDate,
  makeCalendarEndedWith,
  makeGmailSentAfter,
  type CalendarLookupDeps,
  type GmailLookupDeps,
} from "../lib/obligation-lookups.js";

/**
 * ORB-45 Task 10 (B5) — the two REAL lookups behind `resolveElsewhere`'s Gmail and calendar
 * legs. Both answer the same question in their own channel ("did he reach this person after
 * their last message?") and both are wired identically by the morning and evening briefs, which
 * is why they live in one shared module rather than twice inside two schedules.
 *
 * The fixtures here are SHAPED, not verbatim API captures (see CLAUDE.md's third-party rule):
 * they exercise this module's own predicate — whose attendee, which end time, which sender —
 * against the already-mapped `CalendarEvent`/`ThreadMessage` types `lib/google.ts` produces.
 * What they cannot prove is Google's own `timeMin`/`timeMax` window semantics; that belongs to
 * a live sweep, and the module's header says so.
 */

const NOW = new Date("2026-08-12T20:00:00Z");
const SINCE = new Date("2026-08-10T09:00:00Z");
const MINE = async (): Promise<string[]> => ["owner@owner.example", "owner@project.example"];

function message(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: "m-1",
    threadId: "t-1",
    from: "Bendik <owner@owner.example>",
    to: ["Lars Eriksen <lars@partner.example>"],
    subject: "Re: pilot terms",
    bodyText: "body",
    sentAt: "2026-08-11T09:00:00Z",
    messageId: "<m1@owner.example>",
    references: "",
    isCalendarNotice: false,
    headers: {},
    ...overrides,
  };
}

// ─── gmailSentAfter ─────────────────────────────────────────────────────────────────────────

describe("makeGmailSentAfter", () => {
  it("never calls Gmail when the counterparty has no known address", async () => {
    let searched = 0;
    const gmail: GmailLookupDeps = {
      searchThreadIds: async () => { searched++; return []; },
      readThread: async () => [],
    };
    expect(await makeGmailSentAfter(gmail, MINE)([], SINCE)).toBeNull();
    expect(searched).toBe(0);
  });

  it("searches his own sent mail to every known address of theirs, from the day of their message", async () => {
    const queries: Array<{ query: string; ceiling: number }> = [];
    const gmail: GmailLookupDeps = {
      searchThreadIds: async (query, ceiling) => { queries.push({ query, ceiling }); return []; },
      readThread: async () => [],
    };
    await makeGmailSentAfter(gmail, MINE)(["lars@partner.example", "lars.eriksen@partner.example"], SINCE);
    expect(queries).toEqual([{
      query: "from:me (to:lars@partner.example OR to:lars.eriksen@partner.example) after:2026/08/10",
      ceiling: SENT_SEARCH_CEILING,
    }]);
  });

  it("returns the latest message HE sent after theirs", async () => {
    const gmail: GmailLookupDeps = {
      searchThreadIds: async () => ["t-1"],
      readThread: async () => [
        message({ id: "a", sentAt: "2026-08-11T09:00:00Z" }),
        message({ id: "b", sentAt: "2026-08-12T09:00:00Z", from: "owner@project.example" }),
      ],
    };
    const at = await makeGmailSentAfter(gmail, MINE)(["lars@partner.example"], SINCE);
    expect(at?.toISOString()).toBe("2026-08-12T09:00:00.000Z");
  });

  it("ignores messages from THEM — Gmail's from:me is not a guarantee about every message in the thread", async () => {
    const gmail: GmailLookupDeps = {
      searchThreadIds: async () => ["t-1"],
      readThread: async () => [
        message({ id: "a", sentAt: "2026-08-11T09:00:00Z" }),
        message({ id: "b", sentAt: "2026-08-12T09:00:00Z", from: "Lars <lars@partner.example>" }),
      ],
    };
    const at = await makeGmailSentAfter(gmail, MINE)(["lars@partner.example"], SINCE);
    expect(at?.toISOString()).toBe("2026-08-11T09:00:00.000Z");
  });

  it("ignores his own messages sent AT or BEFORE theirs — `after:` is only day-granular", async () => {
    const gmail: GmailLookupDeps = {
      searchThreadIds: async () => ["t-1"],
      // Same Oslo day as their message, but two hours earlier: Gmail's date-granular `after:`
      // returns this thread, and only the timestamp comparison here rejects it.
      readThread: async () => [message({ sentAt: "2026-08-10T07:00:00Z" })],
    };
    expect(await makeGmailSentAfter(gmail, MINE)(["lars@partner.example"], SINCE)).toBeNull();
  });

  it("returns null when the search finds nothing", async () => {
    const gmail: GmailLookupDeps = { searchThreadIds: async () => [], readThread: async () => [] };
    expect(await makeGmailSentAfter(gmail, MINE)(["lars@partner.example"], SINCE)).toBeNull();
  });

  it("reads his addresses ONCE per tick, not once per obligation", async () => {
    let reads = 0;
    const mine = async (): Promise<string[]> => { reads++; return ["owner@owner.example"]; };
    const gmail: GmailLookupDeps = { searchThreadIds: async () => [], readThread: async () => [] };
    const lookup = makeGmailSentAfter(gmail, mine);
    await lookup(["a@b.co"], SINCE);
    await lookup(["c@d.co"], SINCE);
    expect(reads).toBe(1);
  });

  it("does not cache a FAILED address read — one transient blip must not cost the whole tick its email evidence", async () => {
    let calls = 0;
    const mine = async (): Promise<string[]> => {
      calls++;
      if (calls === 1) throw new Error("postgres blip");
      return ["owner@owner.example"];
    };
    const gmail: GmailLookupDeps = {
      searchThreadIds: async () => ["t-1"],
      readThread: async () => [message({ sentAt: "2026-08-11T09:00:00Z" })],
    };
    const lookup = makeGmailSentAfter(gmail, mine);
    await expect(lookup(["lars@partner.example"], SINCE)).rejects.toThrow(/blip/);
    // The next candidate on the same tick retries rather than inheriting the rejection.
    expect((await lookup(["lars@partner.example"], SINCE))?.toISOString()).toBe("2026-08-11T09:00:00.000Z");
    expect(calls).toBe(2);
  });

  it("throws when the identity registry is empty — a lookup that cannot tell his mail from theirs must not answer 'no'", async () => {
    const gmail: GmailLookupDeps = { searchThreadIds: async () => ["t-1"], readThread: async () => [message()] };
    await expect(makeGmailSentAfter(gmail, async () => [])(["lars@partner.example"], SINCE)).rejects.toThrow(/identity registry/);
  });
});

describe("gmailAfterDate", () => {
  it("renders the UTC calendar day in Gmail's YYYY/MM/DD form", () => {
    expect(gmailAfterDate(new Date("2026-08-10T09:00:00Z"))).toBe("2026/08/10");
    expect(gmailAfterDate(new Date("2026-01-05T23:30:00Z"))).toBe("2026/01/05");
  });
});

// ─── calendarEndedWith ──────────────────────────────────────────────────────────────────────

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "e-1",
    summary: "Pilot review",
    start: "2026-08-11T09:00:00Z",
    end: "2026-08-11T10:00:00Z",
    attendees: [{ email: "Lars@partner.example" }, { email: "owner@owner.example" }],
    ...overrides,
  };
}

function calendarWith(events: CalendarEvent[], accounts = ["owner@owner.example"]): CalendarLookupDeps {
  return {
    accounts: async () => accounts,
    clientFor: async () => ({ listEvents: async () => events }),
  };
}

describe("makeCalendarEndedWith", () => {
  it("never calls the calendar when the counterparty has no known address", async () => {
    let called = 0;
    const deps: CalendarLookupDeps = {
      accounts: async () => { called++; return []; },
      clientFor: async () => ({ listEvents: async () => [] }),
    };
    expect(await makeCalendarEndedWith(deps)([], SINCE, NOW)).toBeNull();
    expect(called).toBe(0);
  });

  it("counts a meeting they attended that has already ended, and carries its title as evidence", async () => {
    const out = await makeCalendarEndedWith(calendarWith([event()]))(["lars@partner.example"], SINCE, NOW);
    expect(out).toEqual({ at: new Date("2026-08-11T10:00:00Z"), summary: "Pilot review" });
  });

  it("counts a meeting that STARTED before their message but ENDED after it — the sit-down still happened", async () => {
    const out = await makeCalendarEndedWith(
      calendarWith([event({ start: "2026-08-10T08:00:00Z", end: "2026-08-10T11:00:00Z" })]),
    )(["lars@partner.example"], SINCE, NOW);
    expect(out?.at.toISOString()).toBe("2026-08-10T11:00:00.000Z");
  });

  it("ignores a meeting that ended BEFORE their message — it cannot be an answer to it, whatever the API returns", async () => {
    // The fake returns it regardless of the window, which is the point: this leg must reject it
    // in code rather than rely on Google's `timeMin` semantics to have filtered it out.
    const out = await makeCalendarEndedWith(
      calendarWith([event({ start: "2026-08-09T08:00:00Z", end: "2026-08-09T09:00:00Z" })]),
    )(["lars@partner.example"], SINCE, NOW);
    expect(out).toBeNull();
  });

  it("ignores a meeting that ended at EXACTLY their message's timestamp", async () => {
    const out = await makeCalendarEndedWith(
      calendarWith([event({ start: "2026-08-10T08:00:00Z", end: SINCE.toISOString() })]),
    )(["lars@partner.example"], SINCE, NOW);
    expect(out).toBeNull();
  });

  it("ignores a meeting still in progress — an end in the future is not a meeting that happened", async () => {
    const out = await makeCalendarEndedWith(
      calendarWith([event({ start: "2026-08-12T19:00:00Z", end: "2026-08-12T21:00:00Z" })]),
    )(["lars@partner.example"], SINCE, NOW);
    expect(out).toBeNull();
  });

  it("ignores an all-day entry — its 'end' is a date boundary, not a meeting that ended", async () => {
    const out = await makeCalendarEndedWith(
      calendarWith([event({ start: "2026-08-11", end: "2026-08-12", allDay: true })]),
    )(["lars@partner.example"], SINCE, NOW);
    expect(out).toBeNull();
  });

  it("ignores an event with no end at all", async () => {
    const out = await makeCalendarEndedWith(calendarWith([event({ end: "" })]))(["lars@partner.example"], SINCE, NOW);
    expect(out).toBeNull();
  });

  it("ignores an event they were not on", async () => {
    const out = await makeCalendarEndedWith(
      calendarWith([event({ attendees: [{ email: "someone@else.co" }] })]),
    )(["lars@partner.example"], SINCE, NOW);
    expect(out).toBeNull();
  });

  it("matches the attendee address case-insensitively, in both directions", async () => {
    const out = await makeCalendarEndedWith(calendarWith([event()]))(["LARS@partner.example"], SINCE, NOW);
    expect(out?.summary).toBe("Pilot review");
  });

  it("returns the LATEST qualifying meeting across every enrolled account", async () => {
    const byAccount: Record<string, CalendarEvent[]> = {
      "owner@owner.example": [event({ id: "a", summary: "Older", end: "2026-08-11T10:00:00Z" })],
      "owner@project.example": [event({ id: "b", summary: "Newer", end: "2026-08-12T10:00:00Z" })],
    };
    const deps: CalendarLookupDeps = {
      accounts: async () => Object.keys(byAccount),
      clientFor: async (account) => ({ listEvents: async () => byAccount[account] ?? [] }),
    };
    const out = await makeCalendarEndedWith(deps)(["lars@partner.example"], SINCE, NOW);
    expect(out?.summary).toBe("Newer");
  });

  it("asks each account for the window between their message and now, capped", async () => {
    const asked: Array<{ timeMin: string; timeMax: string; max: number }> = [];
    const deps: CalendarLookupDeps = {
      accounts: async () => ["owner@owner.example"],
      clientFor: async () => ({ listEvents: async (o) => { asked.push(o); return []; } }),
    };
    await makeCalendarEndedWith(deps)(["lars@partner.example"], SINCE, NOW);
    expect(asked).toEqual([{
      timeMin: SINCE.toISOString(), timeMax: NOW.toISOString(), max: CALENDAR_LOOKUP_MAX_EVENTS,
    }]);
  });

  it("skips an account that is not wired on this host, and still reads the others", async () => {
    const deps: CalendarLookupDeps = {
      accounts: async () => ["owner@project.example", "owner@owner.example"],
      clientFor: async (account) => {
        if (account === "owner@project.example") throw new GoogleConfigError("no client secrets mounted for zero7");
        return { listEvents: async () => [event()] };
      },
    };
    const out = await makeCalendarEndedWith(deps)(["lars@partner.example"], SINCE, NOW);
    expect(out?.summary).toBe("Pilot review");
  });

  it("skips an unenrolled account the same way", async () => {
    const deps: CalendarLookupDeps = {
      accounts: async () => ["owner@project.example"],
      clientFor: async () => { throw new GoogleUnenrolledError("no token row"); },
    };
    expect(await makeCalendarEndedWith(deps)(["lars@partner.example"], SINCE, NOW)).toBeNull();
  });

  it("THROWS on any other calendar failure — the caller must record 'calendar' as unreadable, not read it as 'they never met'", async () => {
    const deps: CalendarLookupDeps = {
      accounts: async () => ["owner@owner.example"],
      clientFor: async () => ({ listEvents: async () => { throw new Error("calendar 503"); } }),
    };
    await expect(makeCalendarEndedWith(deps)(["lars@partner.example"], SINCE, NOW)).rejects.toThrow(/503/);
  });
});
