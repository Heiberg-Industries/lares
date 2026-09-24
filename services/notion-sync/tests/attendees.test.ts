import { describe, it, expect } from "vitest";
import {
  DEFAULT_CREATED_TOLERANCE_MINUTES, DEFAULT_STARVATION_STREAK, DEFAULT_STARVATION_WINDOW_DAYS,
  DEFAULT_TOLERANCE_MINUTES, detectStarvation, formatAttendees, planAttendees, titleSimilarity,
  type CalEvent, type MeetingRow,
} from "../lib/attendees.js";

const SELF = "owner@example.com";
/** The same person's mailbox in a second org — see NotionSyncConfig.selfEmails. */
const SECOND_ORG_SELF = "owner@second-org.example";
const OPTS = {
  selfEmails: [SELF],
  toleranceMinutes: DEFAULT_TOLERANCE_MINUTES,
  createdToleranceMinutes: DEFAULT_CREATED_TOLERANCE_MINUTES,
};

/**
 * The healthy pre-ORB-155 row: a `Date` property that already carries a time, so
 * there is nothing for the write-back to upgrade and every assertion below reads
 * as it did before the fix.
 */
const row = (over: Partial<MeetingRow> = {}): MeetingRow => ({
  pageId: "page-1", matchTitle: "Alex // Bendik",
  startsAt: "2026-06-02T10:30:00.000Z", startsAtSource: "date-property",
  dateHasTime: true, createdAt: "2026-06-02T10:28:00.000Z", attendees: "",
  // ORB-27 added these three to MeetingRow. Nothing this file exercises reads them —
  // formatAttendees, planAttendees, titleSimilarity and detectStarvation all ignore them, and
  // the status advance lives in lib/run.ts, not here — so they carry the same values as
  // tests/run.test.ts's fixture rather than inventing a second convention.
  hasSummary: false, status: "Recorded", statusType: "status",
  ...over,
});

const event = (over: Partial<CalEvent> = {}): CalEvent => ({
  id: "evt-1", summary: "Alex // Bendik", start: "2026-06-02T10:30:00.000Z",
  attendees: [
    { email: "alex@partner.example", displayName: "Alex Partner" },
    { email: SELF, displayName: "The Owner" },
  ],
  ...over,
});

describe("formatAttendees", () => {
  it("puts the owner last and uses display names", () => {
    expect(formatAttendees(event().attendees!, [SELF]))
      .toBe("Alex Partner <alex@partner.example>, The Owner <owner@example.com>");
  });

  it("falls back to the local part when there is no display name", () => {
    expect(formatAttendees([{ email: "lars@fronted.com" }], [SELF]))
      .toBe("lars <lars@fronted.com>");
  });

  it("matches the owner case-insensitively", () => {
    const list = [{ email: "OWNER@EXAMPLE.COM" }, { email: "a@b.co", displayName: "A" }];
    expect(formatAttendees(list, [SELF])).toBe("A <a@b.co>, OWNER <OWNER@EXAMPLE.COM>");
  });

  it("recognises the owner's second-org mailbox, not just the first", () => {
    // A principal enrolled in two orgs owns two addresses. With only the first
    // configured, the second sorts mid-list and the "owner last" format breaks.
    const list = [
      { email: SECOND_ORG_SELF, displayName: "The Owner" },
      { email: "a@b.co", displayName: "A" },
    ];
    expect(formatAttendees(list, [SELF, SECOND_ORG_SELF]))
      .toBe("A <a@b.co>, The Owner <owner@second-org.example>");
  });
});

describe("titleSimilarity", () => {
  it("scores an exact match 1 regardless of case, punctuation or accents", () => {
    expect(titleSimilarity("Alex // Bendik", "alex / bendik")).toBe(1);
    expect(titleSimilarity("Kaffe møte", "Kaffe mote")).toBe(1);
  });

  it("scores 1 when the event summary accounts for every word of the note title", () => {
    expect(titleSimilarity("Alex // Bendik", "Alex / Bendik — Nomono")).toBe(1);
  });

  it("scores a partial word overlap by the NOTE's word count, not the shorter title's", () => {
    expect(titleSimilarity("Weekly sync", "Weekly standup")).toBe(0.5);
    // The denominator is the whole point: under an overlap coefficient (dividing by
    // the smaller word set) the generic "Sync" would score a perfect 1 and beat the
    // real match at 0.75. Dividing by the note's own word count puts it at 0.25.
    expect(titleSimilarity("Weekly sync with Alex", "Weekly sync w/ Alex")).toBe(0.75);
    expect(titleSimilarity("Weekly sync with Alex", "Sync")).toBe(0.25);
  });

  it("scores unrelated titles, and any empty title, 0", () => {
    expect(titleSimilarity("Payroll review", "Dentist")).toBe(0);
    expect(titleSimilarity("", "Dentist")).toBe(0);
    expect(titleSimilarity("Payroll review", "   ")).toBe(0);
  });
});

describe("planAttendees", () => {
  it("fills a row from the single event in the tolerance window", () => {
    const plan = planAttendees([row()], [event()], OPTS);
    expect(plan.unmatched).toEqual([]);
    expect(plan.updates).toEqual([{
      pageId: "page-1",
      attendees: "Alex Partner <alex@partner.example>, The Owner <owner@example.com>",
    }]);
  });

  it("never overwrites a row that already has attendees", () => {
    const plan = planAttendees([row({ attendees: "Someone <x@y.z>" })], [event()], OPTS);
    expect(plan.updates).toEqual([]);
    expect(plan.unmatched).toEqual([]);
  });

  it("flags no-candidate rather than guessing when nothing is in range", () => {
    const far = event({ start: "2026-06-05T10:30:00.000Z" });
    const plan = planAttendees([row()], [far], OPTS);
    expect(plan.updates).toEqual([]);
    expect(plan.unmatched).toEqual([{ pageId: "page-1", reason: "no-candidate" }]);
  });

  it("flags ambiguous when two events in the window have equally similar titles", () => {
    // Same summary on both — the tie-break has nothing to separate them with, so
    // "never guess" wins and the row is flagged rather than filled from either.
    const plan = planAttendees(
      [row()],
      [event(), event({ id: "evt-2", start: "2026-06-02T10:40:00.000Z" })],
      OPTS,
    );
    expect(plan.updates).toEqual([]);
    expect(plan.unmatched).toEqual([{ pageId: "page-1", reason: "ambiguous" }]);
  });

  it("breaks a two-event tie on title when one summary clearly matches", () => {
    const plan = planAttendees(
      [row()],
      [
        event({ id: "evt-other", summary: "Payroll review", attendees: [{ email: "x@y.co" }] }),
        event({ id: "evt-2", start: "2026-06-02T10:40:00.000Z" }),
      ],
      OPTS,
    );
    expect(plan.unmatched).toEqual([]);
    expect(plan.updates).toEqual([{
      pageId: "page-1",
      attendees: "Alex Partner <alex@partner.example>, The Owner <owner@example.com>",
    }]);
  });

  it("never lets a short generic invite title outscore the real match", () => {
    // The regression the tie-break introduced. "Sync" is a word-subset of the note
    // title, so an overlap-coefficient denominator scores the decoy 1.0 against the
    // true match's 0.75 — no tie, above the weak-match floor, both guards silent —
    // and the job writes a stranger's address into Notion. Decoy is listed FIRST so
    // iteration order cannot be what saves it.
    const note = row({ matchTitle: "Weekly sync with Alex", startsAt: "2026-06-02T10:00:00.000Z" });
    const decoy = event({
      id: "evt-decoy",
      summary: "Sync",
      start: "2026-06-02T10:05:00.000Z",
      attendees: [{ email: "decoy@elsewhere.example", displayName: "Decoy" }],
    });
    const trueMatch = event({
      id: "evt-true",
      summary: "Weekly sync w/ Alex",
      start: "2026-06-02T10:00:00.000Z",
    });

    const plan = planAttendees([note], [decoy, trueMatch], OPTS);

    expect(plan.unmatched).toEqual([]);
    expect(plan.updates).toEqual([{
      pageId: "page-1",
      attendees: "Alex Partner <alex@partner.example>, The Owner <owner@example.com>",
    }]);
    // Belt and braces: the decoy's attendee must not appear anywhere in the plan.
    expect(JSON.stringify(plan)).not.toContain("decoy@elsewhere.example");
  });

  it("still flags ambiguous when no candidate title is similar enough to trust", () => {
    const plan = planAttendees(
      [row()],
      [
        event({ id: "evt-a", summary: "Payroll review", attendees: [{ email: "x@y.co" }] }),
        event({ id: "evt-b", start: "2026-06-02T10:40:00.000Z", summary: "Dentist" }),
      ],
      OPTS,
    );
    expect(plan.updates).toEqual([]);
    expect(plan.unmatched).toEqual([{ pageId: "page-1", reason: "ambiguous" }]);
  });

  it("fills an ordinary three-meeting day instead of flagging every row ambiguous", () => {
    // 09:00 / 10:00 / 11:00 is a normal working day, not an edge case. At the old
    // ±90-minute default every row saw all three events and none got filled.
    const at = (hhmm: string): string => `2026-06-02T${hhmm}:00.000Z`;
    const rows: MeetingRow[] = [
      row({ pageId: "p-9", matchTitle: "Alex // Bendik", startsAt: at("09:00") }),
      row({ pageId: "p-10", matchTitle: "Payroll review", startsAt: at("10:00") }),
      row({ pageId: "p-11", matchTitle: "Dentist", startsAt: at("11:00") }),
    ];
    const events: CalEvent[] = [
      event({ id: "e-9", summary: "Alex // Bendik", start: at("09:00") }),
      event({ id: "e-10", summary: "Payroll review", start: at("10:00") }),
      event({ id: "e-11", summary: "Dentist", start: at("11:00") }),
    ];

    const plan = planAttendees(rows, events, OPTS);

    expect(plan.unmatched).toEqual([]);
    expect(plan.updates.map((u) => u.pageId)).toEqual(["p-9", "p-10", "p-11"]);

    // Even at the old ±90-minute window — where every row sees all three events —
    // the title tie-break now separates them rather than flagging the whole day.
    const wide = planAttendees(rows, events, { ...OPTS, toleranceMinutes: 90 });
    expect(wide.unmatched).toEqual([]);
    expect(wide.updates.map((u) => u.pageId)).toEqual(["p-9", "p-10", "p-11"]);
  });

  it("flags no-date when the row has no Date property", () => {
    const plan = planAttendees([row({ startsAt: null })], [event()], OPTS);
    expect(plan.unmatched).toEqual([{ pageId: "page-1", reason: "no-date" }]);
  });

  it("flags a date-only row rather than matching it to midnight", () => {
    const plan = planAttendees([row({ startsAt: "2026-06-02" })], [event()], OPTS);
    expect(plan.unmatched).toEqual([{ pageId: "page-1", reason: "no-candidate" }]);
  });

  it("flags no-attendees when the matched event has an empty attendee list", () => {
    const plan = planAttendees([row()], [event({ attendees: [] })], OPTS);
    expect(plan.unmatched).toEqual([{ pageId: "page-1", reason: "no-attendees" }]);
  });

  it("sorts the owner last for a meeting held in their second org", () => {
    const secondOrgEvent = event({
      attendees: [
        { email: SECOND_ORG_SELF, displayName: "The Owner" },
        { email: "alex@partner.example", displayName: "Alex Partner" },
      ],
    });
    const plan = planAttendees([row()], [secondOrgEvent], {
      ...OPTS,
      selfEmails: [SELF, SECOND_ORG_SELF],
    });

    expect(plan.unmatched).toEqual([]);
    expect(plan.updates).toEqual([{
      pageId: "page-1",
      attendees: "Alex Partner <alex@partner.example>, The Owner <owner@second-org.example>",
    }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ORB-155. Two new facts reach the matcher on every row: WHERE its start time came
// from, and whether the `Date` property was already authoritative. The first
// governs how far the matcher will look and whether the title gate is optional;
// the second is the write-back's whole permission.
// ─────────────────────────────────────────────────────────────────────────────

describe("planAttendees — a start inferred from page creation (ORB-155)", () => {
  /** No `Date`, no title mention: the page's own creation time is all there is. */
  const inferred = (over: Partial<MeetingRow> = {}): MeetingRow => row({
    startsAtSource: "created-time", dateHasTime: false, ...over,
  });

  it("looks further than +/-15 minutes, because a recording starts when a human joins", () => {
    // The live SOMA row: the page was created 28 minutes after the invite's start.
    // At the tight window that is a no-candidate; at the created-time window it is
    // the match it obviously is.
    const note = inferred({ startsAt: "2026-06-02T10:58:00.000Z" });
    expect(planAttendees([note], [event()], OPTS).updates).toHaveLength(1);
    expect(planAttendees([note], [event()], { ...OPTS, createdToleranceMinutes: 15 }).unmatched)
      .toEqual([{ pageId: "page-1", reason: "no-candidate" }]);
  });

  it("still requires the title to agree, even when only ONE event is in the window", () => {
    // The safety the wider window buys back. A stated start is evidence; a creation
    // time is a guess, so the clock alone may never decide the match — an unrelated
    // invite an hour away must not have its attendees written into this note.
    const note = inferred({ matchTitle: "Ad-hoc recording", startsAt: "2026-06-02T11:20:00.000Z" });
    const plan = planAttendees([note], [event()], OPTS);
    expect(plan.updates).toEqual([]);
    expect(plan.unmatched).toEqual([{ pageId: "page-1", reason: "ambiguous" }]);
  });

  it("fills when the lone candidate's title does agree", () => {
    const note = inferred({ startsAt: "2026-06-02T11:20:00.000Z" });
    expect(planAttendees([note], [event()], OPTS).updates.map((u) => u.pageId)).toEqual(["page-1"]);
  });

  it("leaves a STATED start free to match on the clock alone", () => {
    // The tie-break is a fallback for a stated time, not a gate on it: an invite
    // renamed after the fact still matches the note that carries its exact minute.
    const note = row({ matchTitle: "Ad-hoc recording", startsAtSource: "title-mention", dateHasTime: false });
    expect(planAttendees([note], [event()], OPTS).updates.map((u) => u.pageId)).toEqual(["page-1"]);
  });
});

describe("planAttendees — the Date write-back (ORB-155)", () => {
  it("upgrades a row whose `Date` carries no time to the event's own start", () => {
    const note = row({ startsAtSource: "title-mention", dateHasTime: false });
    expect(planAttendees([note], [event()], OPTS).updates).toEqual([{
      pageId: "page-1",
      attendees: "Alex Partner <alex@partner.example>, The Owner <owner@example.com>",
      startsAt: "2026-06-02T10:30:00.000Z",
    }]);
  });

  it("never overwrites a `Date` that already holds a datetime", () => {
    // Provenance, same rule as Attendees: a time a human typed is a statement, and
    // this pass corrects nobody. The event's start is deliberately five minutes off
    // so a write-back would be visible.
    const plan = planAttendees([row()], [event({ start: "2026-06-02T10:35:00.000Z" })], OPTS);
    expect(plan.updates).toEqual([{
      pageId: "page-1",
      attendees: "Alex Partner <alex@partner.example>, The Owner <owner@example.com>",
    }]);
  });

  it("writes nothing back from an all-day event, which has no time to give", () => {
    // Google reports an all-day event's start as a bare date. Writing that into
    // `Date` would replace one date-only value with another and call it a fix.
    const allDay = event({ start: "2026-06-02", summary: "Alex // Bendik" });
    const note = row({ startsAt: "2026-06-02", startsAtSource: "title-mention", dateHasTime: false });
    const plan = planAttendees([note], [allDay], OPTS);
    expect(plan.updates).toEqual([{
      pageId: "page-1",
      attendees: "Alex Partner <alex@partner.example>, The Owner <owner@example.com>",
    }]);
  });
});

describe("detectStarvation — alert on the pattern, never on the row (ORB-155)", () => {
  const NOW = new Date("2026-06-02T12:00:00.000Z");
  const STARVE = {
    now: NOW,
    streak: DEFAULT_STARVATION_STREAK,
    windowDays: DEFAULT_STARVATION_WINDOW_DAYS,
  };
  /** Days before NOW, as a created_time. */
  const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString();

  /** A row that cannot match anything: no event is ever within range of it. */
  const orphan = (pageId: string, createdAt: string): MeetingRow => row({
    pageId, createdAt, matchTitle: pageId,
    startsAt: createdAt, startsAtSource: "created-time", dateHasTime: false,
  });

  const detect = (rows: MeetingRow[], events: CalEvent[] = [event()]): string[] | null =>
    detectStarvation(rows, planAttendees(rows, events, OPTS), STARVE)?.map((r) => r.pageId) ?? null;

  it("says nothing about ONE ad-hoc note with no calendar event", () => {
    // The legitimate case the ticket protects: Bendik hits record with no invite.
    // It stays a quiet flag in the store; nobody's Slack needs to know.
    expect(detect([orphan("solo", daysAgo(1))])).toBeNull();
  });

  it("says nothing while the newest note still matches", () => {
    const matched = row({ pageId: "healthy", createdAt: daysAgo(0) });
    expect(detect([orphan("a", daysAgo(3)), orphan("b", daysAgo(2)), matched])).toBeNull();
  });

  it("fires once the three most recent notes have all failed to match", () => {
    // Three in a row is the shape of a systemic failure — a changed Notion payload,
    // a wrong calendar principal — not of an unusual week.
    expect(detect([
      row({ pageId: "healthy", createdAt: daysAgo(9) }),
      orphan("aug-19", daysAgo(3)),
      orphan("aug-21", daysAgo(2)),
      orphan("aug-24", daysAgo(1)),
    ])).toEqual(["aug-24", "aug-21", "aug-19"]);
  });

  it("needs a full streak before it will say anything", () => {
    expect(detect([orphan("a", daysAgo(2)), orphan("b", daysAgo(1))])).toBeNull();
  });

  it("lets an old permanently-unmatched row age out of the window", () => {
    // Otherwise a trio of genuinely event-less notes would re-alert every day
    // forever. The claim is "recently, nothing is matching" — so it is measured
    // over recent rows only, and a real starvation keeps producing new ones.
    expect(detect([
      orphan("jan", daysAgo(200)), orphan("mar", daysAgo(90)), orphan("apr", daysAgo(60)),
    ])).toBeNull();
  });

  it("ignores rows that already have attendees — they were never work for the matcher", () => {
    const done = (pageId: string, createdAt: string): MeetingRow =>
      row({ pageId, createdAt, attendees: "Someone <x@y.z>" });
    expect(detect([
      done("d1", daysAgo(1)), done("d2", daysAgo(2)), done("d3", daysAgo(3)),
      orphan("only-one", daysAgo(4)),
    ])).toBeNull();
  });
});

describe("planAttendees — the series key (ORB-156)", () => {
  it("carries the matched event's recurringEventId onto the update", () => {
    const series = event({ recurringEventId: "fixture-recurring-event" });
    expect(planAttendees([row()], [series], OPTS).updates).toEqual([{
      pageId: "page-1",
      attendees: "Alex Partner <alex@partner.example>, The Owner <owner@example.com>",
      seriesKey: "fixture-recurring-event",
    }]);
  });

  it("omits seriesKey entirely for a one-off meeting", () => {
    // Absence is the signal Phase 2 reads as "never auto-approvable". An empty string
    // would be a series id that matches nothing, which is a different and worse claim.
    const plan = planAttendees([row()], [event()], OPTS);
    expect("seriesKey" in plan.updates[0]).toBe(false);
  });
});
