/**
 * lib/calendar-conflicts.ts — the detection half of the conflict radar (ORB-139).
 *
 * The ticket's own framing is what this file is organised around: the classes are the easy
 * half, and the FALSE-POSITIVE rules are the half that decides whether the feature survives
 * contact with a real calendar. So every exclusion the module claims gets a test that would go
 * red if the exclusion were dropped — an all-day placeholder beside a meeting, a declined
 * invitation, an event marked free, two tentatives, an out-of-office marker, an early start at
 * home, and above all the same meeting read off two calendars, which is the single most common
 * shape in his data (both accounts, every calendar, plus the read-only one he subscribes to).
 *
 * FIXTURES ARE SHAPED, not verbatim: these are hand-built `CalendarEvent` literals in the shape
 * `lib/google.ts`'s mapper produces, not recorded Google responses. What that buys and what it
 * does not is stated in the repo's own third-party rule — a fixture can only re-confirm what we
 * believe the API does. The four wire fields the rules branch on (`status`, `transparency`,
 * `myResponse`, `iCalUID`) are documented against `googleapis`' typings beside the type itself,
 * and every comparison here is written so an unknown value reads as an ordinary committed
 * event. No live sweep of those enumerations has been run.
 */
import { describe, it, expect } from "vitest";

import {
  CONFLICT_PRIORITY,
  DEFAULT_HOME_TIMEZONE,
  commitmentOf,
  dedupeEvents,
  detectCalendarConflicts,
  timezoneOn,
  type ConflictTrip,
} from "../lib/calendar-conflicts.js";
import type { CalendarEvent } from "../lib/google.js";

const DAY = "2026-08-26";
const DAYS = [DAY];

let seq = 0;
/** A timed event on {@link DAY}, Oslo wall clock. `+02:00` is CEST, which is what late August
 *  actually is — the offset is spelled out rather than guessed so the assertions below are
 *  about the rule, never about a DST surprise. */
function timed(overrides: Partial<CalendarEvent> & { from: string; to: string }): CalendarEvent {
  const { from, to, ...rest } = overrides;
  return {
    id: `e${++seq}`,
    summary: "Meeting",
    start: `${DAY}T${from}:00+02:00`,
    end: `${DAY}T${to}:00+02:00`,
    ...rest,
  };
}

/** An all-day entry. Google's `end` is the EXCLUSIVE next midnight — a one-day block ends the
 *  following date, which is why the stay rules step back off it. */
function allDay(overrides: Partial<CalendarEvent> & { start: string; end: string }): CalendarEvent {
  return { id: `a${++seq}`, summary: "Oslo", allDay: true, ...overrides };
}

const NYC_TRIP: ConflictTrip[] = [
  { start: "2026-08-26", end: "2026-08-31", timezone: "America/New_York" },
];

const kinds = (events: CalendarEvent[], ctx = {}): string[] =>
  detectCalendarConflicts(events, { days: DAYS, ...ctx }).map((c) => c.kind);

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Class 1 — double-booked time
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("double-booked time", () => {
  it("reports two timed commitments that overlap", () => {
    const found = detectCalendarConflicts(
      [
        timed({ from: "10:00", to: "11:00", summary: "Board call" }),
        timed({ from: "10:30", to: "11:30", summary: "Investor intro" }),
      ],
      { days: DAYS },
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("double-booked");
    expect(found[0]!.severity).toBe("high");
    expect(found[0]!.events.map((e) => e.title)).toEqual(["Board call", "Investor intro"]);
    expect(found[0]!.explanation).toContain("overlap in time");
  });

  it("does NOT report back-to-back meetings — touching ends are not an overlap", () => {
    expect(kinds([
      timed({ from: "10:00", to: "11:00" }),
      timed({ from: "11:00", to: "12:00" }),
    ])).toEqual([]);
  });

  it("names the earlier event first, whichever order the calendars answered in", () => {
    const late = timed({ from: "10:30", to: "11:30", summary: "Later" });
    const early = timed({ from: "10:00", to: "11:00", summary: "Earlier" });
    const a = detectCalendarConflicts([late, early], { days: DAYS });
    const b = detectCalendarConflicts([early, late], { days: DAYS });
    expect(a[0]!.events.map((e) => e.title)).toEqual(["Earlier", "Later"]);
    expect(a).toEqual(b);
  });
});

describe("double-booked time — the false-positive rules", () => {
  it("an all-day placeholder overlapping a real meeting is NOT a conflict", () => {
    // The ticket names this one explicitly, and it is the most common shape on his calendar:
    // an all-day label ("Oslo", a holiday, a travel day) is not a place he is standing in.
    expect(kinds([
      allDay({ start: DAY, end: "2026-08-27", summary: "Oslo" }),
      timed({ from: "10:00", to: "11:00" }),
    ])).toEqual([]);
  });

  it("a DECLINED invitation cannot double-book him", () => {
    expect(kinds([
      timed({ from: "10:00", to: "11:00" }),
      timed({ from: "10:30", to: "11:30", myResponse: "declined" }),
    ])).toEqual([]);
  });

  it("a CANCELLED event cannot double-book him", () => {
    expect(kinds([
      timed({ from: "10:00", to: "11:00" }),
      timed({ from: "10:30", to: "11:30", status: "cancelled" }),
    ])).toEqual([]);
  });

  it("an event he marked FREE (transparent) cannot double-book him", () => {
    expect(kinds([
      timed({ from: "10:00", to: "11:00" }),
      timed({ from: "10:30", to: "11:30", transparency: "transparent" }),
    ])).toEqual([]);
  });

  it("an out-of-office or working-location marker is availability, not a meeting", () => {
    for (const eventType of ["outOfOffice", "workingLocation"]) {
      expect(kinds([
        timed({ from: "10:00", to: "11:00" }),
        timed({ from: "10:30", to: "11:30", eventType }),
      ]), eventType).toEqual([]);
    }
  });

  it("TWO TENTATIVES do not clash — nothing has been committed yet", () => {
    expect(kinds([
      timed({ from: "10:00", to: "11:00", myResponse: "tentative" }),
      timed({ from: "10:30", to: "11:30", status: "tentative" }),
    ])).toEqual([]);
  });

  it("a tentative DOES clash with an accepted one, and the line says which is soft", () => {
    const found = detectCalendarConflicts(
      [
        timed({ from: "10:00", to: "11:00", myResponse: "accepted" }),
        timed({ from: "10:30", to: "11:30", myResponse: "tentative" }),
      ],
      { days: DAYS },
    );
    expect(found.map((c) => c.kind)).toEqual(["double-booked"]);
    expect(found[0]!.explanation).toContain("only tentative");
  });

  it("an unknown status or response reads as an ordinary commitment — noisier, never blinder", () => {
    // The direction is the whole point: a value Google invents after this was written must not
    // silence the radar.
    expect(commitmentOf(timed({ from: "10:00", to: "11:00", status: "some-new-status" }))).toBe("committed");
    expect(commitmentOf(timed({ from: "10:00", to: "11:00", myResponse: "delegated" }))).toBe("committed");
  });

  it("an event with no attendee data at all is his own block, not an unanswered invitation", () => {
    // ORB-118's lesson: attendee metadata is the exception on his calendar, not the rule.
    expect(commitmentOf(timed({ from: "10:00", to: "11:00" }))).toBe("committed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Class 2 — overlapping stays
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("overlapping stays", () => {
  it("reports two beds booked over the same nights — the founding case", () => {
    // 2026-08-20: two New York hotels, both 26–31, caught only because the model happened to
    // look. Google's exclusive end means the 31st is the check-out, so five nights are shared.
    const found = detectCalendarConflicts(
      [
        allDay({ start: "2026-08-26", end: "2026-08-31", summary: "Stay at PUBLIC Hotel New York", eventType: "fromGmail", transparency: "transparent" }),
        allDay({ start: "2026-08-26", end: "2026-08-31", summary: "Hotel The Standard", eventType: "fromGmail", transparency: "transparent" }),
      ],
      { days: ["2026-08-28"] },
    );
    expect(found.map((c) => c.kind)).toEqual(["overlapping-stay"]);
    expect(found[0]!.severity).toBe("high");
    expect(found[0]!.explanation).toContain("5 nights (2026-08-26 to 2026-08-30)");
  });

  it("a stay that starts days BEFORE the window still counts on a day it covers", () => {
    // The bound is the brief's day, and a multi-night booking overlaps it without starting on
    // it. Reading the window as "events that start today" would have missed the founding case
    // on four of its five mornings.
    expect(kinds([
      allDay({ start: "2026-08-20", end: "2026-08-31", summary: "Hotel A" }),
      allDay({ start: "2026-08-24", end: "2026-08-30", summary: "Hotel B" }),
    ])).toEqual(["overlapping-stay"]);
  });

  it("ignores `transparency` — a booking Gmail files is FREE, and excluding it would delete the class", () => {
    expect(kinds([
      allDay({ start: DAY, end: "2026-08-28", summary: "Hotel A", transparency: "transparent" }),
      allDay({ start: DAY, end: "2026-08-28", summary: "Hotel B", transparency: "transparent" }),
    ])).toEqual(["overlapping-stay"]);
  });

  it("counts nights, not days: check-out on the morning another check-in begins is fine", () => {
    expect(kinds([
      allDay({ start: "2026-08-24", end: DAY, summary: "Hotel A" }),   // last night: the 25th
      allDay({ start: DAY, end: "2026-08-28", summary: "Hotel B" }),   // first night: the 26th
    ])).toEqual([]);
  });

  it("reads a TIMED hotel row as nights too — check-out morning is not a night", () => {
    const found = detectCalendarConflicts(
      [
        // Checks in on the 26th, out on the morning of the 28th: two nights, 26 and 27.
        { id: "t1", summary: "Hotel A", start: "2026-08-26T15:00:00+02:00", end: "2026-08-28T11:00:00+02:00" },
        allDay({ start: "2026-08-27", end: "2026-08-29", summary: "Hotel B" }),
      ],
      { days: ["2026-08-27"] },
    );
    expect(found.map((c) => c.kind)).toEqual(["overlapping-stay"]);
    expect(found[0]!.explanation).toContain("the night of 2026-08-27");
  });

  it("does NOT report an overlap on a night OUTSIDE the window — he already slept through it", () => {
    // Both stays reach into the window day, but the night they share is behind him.
    expect(kinds([
      { id: "s1", summary: "Hotel A", start: "2026-08-24T15:00:00+02:00", end: "2026-08-26T11:00:00+02:00" },
      { id: "s2", summary: "Hotel B", start: "2026-08-25T15:00:00+02:00", end: "2026-08-26T11:00:00+02:00" },
    ])).toEqual([]);
  });

  it("two ordinary all-day placeholders overlapping are NOT a conflict", () => {
    // The ticket's own words. Nothing but a lodging title can produce this class.
    expect(kinds([
      allDay({ start: DAY, end: "2026-08-28", summary: "Oslo" }),
      allDay({ start: DAY, end: "2026-08-28", summary: "Fokusuke" }),
    ])).toEqual([]);
  });

  it("a CANCELLED booking is not a bed", () => {
    expect(kinds([
      allDay({ start: DAY, end: "2026-08-28", summary: "Hotel A" }),
      allDay({ start: DAY, end: "2026-08-28", summary: "Hotel B", status: "cancelled" }),
    ])).toEqual([]);
  });

  it("a restaurant booking is not a bed — 'Reservation at …' alone never counts", () => {
    // Deliberate departure from the bare word "reservation", for the reason `classifyEvent`
    // already records: his one real "Reservation at …" row is a table, not a room.
    expect(kinds([
      allDay({ start: DAY, end: "2026-08-28", summary: "Reservation at Gramercy Tavern" }),
      allDay({ start: DAY, end: "2026-08-28", summary: "Reservation at Frenchie" }),
    ])).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Class 3 — timezone traps
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("timezone traps", () => {
  it("reports a home-time meeting that lands before dawn where he actually is", () => {
    // The ticket's second 2026-08-20 catch: a 12:00 status meeting, booked at home, on a New
    // York day. 12:00 CEST is 06:00 EDT.
    const found = detectCalendarConflicts(
      [timed({ from: "12:00", to: "12:30", summary: "Status meeting" })],
      { days: DAYS, trips: NYC_TRIP },
    );
    expect(found.map((c) => c.kind)).toEqual(["timezone-trap"]);
    expect(found[0]!.severity).toBe("medium");
    expect(found[0]!.explanation).toContain("06:00");
    expect(found[0]!.explanation).toContain("America/New_York");
  });

  it("does NOT report a 06:00 home event on an ordinary home day", () => {
    // The ticket names this one too. Without the "the event's own zone must differ" guard,
    // every early start on his calendar would be a finding.
    expect(kinds([timed({ from: "06:00", to: "07:00" })])).toEqual([]);
  });

  it("does NOT report an event booked in the zone he is actually in", () => {
    expect(kinds(
      [timed({ from: "12:00", to: "12:30", startTimeZone: "America/New_York" })],
      { trips: NYC_TRIP },
    )).toEqual([]);
  });

  it("compares WALL CLOCKS, not zone names — two names for one clock are not a trap", () => {
    // Stockholm and Oslo read the same clock. A string comparison would have made every early
    // morning on a Swedish-tagged invitation a finding.
    expect(kinds([
      timed({ from: "06:00", to: "07:00", startTimeZone: "Europe/Stockholm" }),
    ])).toEqual([]);
  });

  it("a mid-afternoon meeting on a trip day is not a trap — 07:00–22:00 is the bar", () => {
    expect(kinds([timed({ from: "18:00", to: "19:00" })], { trips: NYC_TRIP })).toEqual([]);
  });

  it("an all-day entry has no clock time, so it can never land at a wrong one", () => {
    expect(kinds([allDay({ start: DAY, end: "2026-08-27" })], { trips: NYC_TRIP })).toEqual([]);
  });

  it("a booking Gmail filed is not a trap — a flight boards when it boards", () => {
    expect(kinds(
      [timed({ from: "12:00", to: "13:00", summary: "Flight to Newark (SK 909)", eventType: "fromGmail" })],
      { trips: NYC_TRIP },
    )).toEqual([]);
  });

  it("a declined or cancelled event is not a trap either", () => {
    expect(kinds([timed({ from: "12:00", to: "12:30", myResponse: "declined" })], { trips: NYC_TRIP })).toEqual([]);
    expect(kinds([timed({ from: "12:00", to: "12:30", status: "cancelled" })], { trips: NYC_TRIP })).toEqual([]);
  });

  it("survives a trip filed with an unreadable timezone — one lost finding, never a throw", () => {
    const junk: ConflictTrip[] = [{ start: "2026-08-26", end: "2026-08-31", timezone: "Mars/Olympus_Mons" }];
    expect(() => detectCalendarConflicts([timed({ from: "12:00", to: "12:30" })], { days: DAYS, trips: junk })).not.toThrow();
    expect(kinds([timed({ from: "12:00", to: "12:30" })], { trips: junk })).toEqual([]);
  });
});

describe("timezoneOn", () => {
  it("returns the trip's zone on a day it covers, inclusive at both ends", () => {
    const ctx = { days: DAYS, trips: NYC_TRIP };
    expect(timezoneOn("2026-08-26", ctx)).toBe("America/New_York");
    expect(timezoneOn("2026-08-31", ctx)).toBe("America/New_York");
  });

  it("returns home off the trip, and home is Oslo unless told otherwise", () => {
    expect(timezoneOn("2026-09-01", { days: DAYS, trips: NYC_TRIP })).toBe(DEFAULT_HOME_TIMEZONE);
    expect(timezoneOn("2026-09-01", { days: DAYS })).toBe("Europe/Oslo");
  });

  it("ignores a trip with no zone rather than reading it as an empty one", () => {
    expect(timezoneOn(DAY, { days: DAYS, trips: [{ start: DAY, end: DAY, timezone: "" }] })).toBe("Europe/Oslo");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The same commitment, seen twice — the shape his own data produces constantly
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("de-duplication: one meeting on two calendars is one meeting", () => {
  it("dedupes by iCalUID even though the copy carries its own id", () => {
    const shared = { summary: "Folkepuls", start: `${DAY}T10:00:00+02:00`, end: `${DAY}T13:00:00+02:00`, iCalUID: "abc@google.com" };
    expect(kinds([{ id: "heiberg-1", ...shared }, { id: "zero7-1", ...shared }])).toEqual([]);
  });

  it("dedupes by title + start + end when a copy minted a fresh UID as well as a fresh id", () => {
    const shared = { summary: "Folkepuls", start: `${DAY}T10:00:00+02:00`, end: `${DAY}T13:00:00+02:00` };
    expect(kinds([
      { id: "heiberg-1", iCalUID: "one@google.com", ...shared },
      { id: "vdn-1", iCalUID: "two@google.com", ...shared },
    ])).toEqual([]);
  });

  it("does NOT merge two occurrences of one recurring series — same UID, different days", () => {
    const kept = dedupeEvents([
      { id: "r1", summary: "Standup", start: `${DAY}T09:00:00+02:00`, end: `${DAY}T09:15:00+02:00`, iCalUID: "series@google.com" },
      { id: "r2", summary: "Standup", start: "2026-08-27T09:00:00+02:00", end: "2026-08-27T09:15:00+02:00", iCalUID: "series@google.com" },
    ]);
    expect(kept).toHaveLength(2);
  });

  it("keeps two genuinely different meetings at the same time", () => {
    expect(kinds([
      timed({ from: "10:00", to: "11:00", summary: "Board call" }),
      timed({ from: "10:00", to: "11:00", summary: "Dentist" }),
    ])).toEqual(["double-booked"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The window, the ordering and the bounds
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("the pass itself", () => {
  it("is bounded to the days it was given — tomorrow's clash does not crowd today's brief", () => {
    const tomorrow = [
      { id: "x1", summary: "A", start: "2026-08-27T10:00:00+02:00", end: "2026-08-27T11:00:00+02:00" },
      { id: "x2", summary: "B", start: "2026-08-27T10:30:00+02:00", end: "2026-08-27T11:30:00+02:00" },
    ];
    expect(kinds(tomorrow)).toEqual([]);
    expect(detectCalendarConflicts(tomorrow, { days: ["2026-08-27"] }).map((c) => c.kind)).toEqual(["double-booked"]);
  });

  it("returns [] for an empty `days` rather than scanning everything", () => {
    expect(detectCalendarConflicts([timed({ from: "10:00", to: "11:00" }), timed({ from: "10:30", to: "11:30" })], { days: [] })).toEqual([]);
  });

  it("returns [] for an empty calendar and for a calendar with nothing wrong on it", () => {
    expect(detectCalendarConflicts([], { days: DAYS })).toEqual([]);
    expect(kinds([timed({ from: "10:00", to: "11:00" })])).toEqual([]);
  });

  it("orders findings by the ticket's class priority, then deterministically inside a class", () => {
    const events: CalendarEvent[] = [
      timed({ from: "12:00", to: "12:30", summary: "Status meeting" }),                                   // trap (on the trip)
      allDay({ start: "2026-08-26", end: "2026-08-28", summary: "Hotel A" }),
      allDay({ start: "2026-08-26", end: "2026-08-28", summary: "Hotel B" }),
      timed({ from: "15:00", to: "16:00", summary: "Board call" }),
      timed({ from: "15:30", to: "16:30", summary: "Investor intro" }),
    ];
    const found = detectCalendarConflicts(events, { days: DAYS, trips: NYC_TRIP });
    expect(found.map((c) => c.kind)).toEqual(["double-booked", "overlapping-stay", "timezone-trap"]);
    expect(CONFLICT_PRIORITY).toEqual(["double-booked", "overlapping-stay", "timezone-trap"]);

    // Same events, shuffled: byte-identical result. Nothing may depend on the order the
    // calendars happened to answer in.
    const shuffled = [events[3]!, events[0]!, events[4]!, events[2]!, events[1]!];
    expect(detectCalendarConflicts(shuffled, { days: DAYS, trips: NYC_TRIP })).toEqual(found);
  });

  it("honours `maxEvents` so a runaway read cannot turn a quadratic pass loose", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      ({ id: `m${i}`, summary: `M${i}`, start: `${DAY}T10:00:00+02:00`, end: `${DAY}T11:00:00+02:00` }));
    expect(detectCalendarConflicts(many, { days: DAYS, maxEvents: 2 })).toHaveLength(1);
  });

  it("never mutates the caller's array", () => {
    const events = [timed({ from: "10:30", to: "11:30" }), timed({ from: "10:00", to: "11:00" })];
    const before = [...events];
    detectCalendarConflicts(events, { days: DAYS });
    expect(events).toEqual(before);
  });

  it("carries each event's times VERBATIM — an all-day row never gains a clock time", () => {
    const found = detectCalendarConflicts(
      [
        allDay({ start: DAY, end: "2026-08-28", summary: "Hotel A" }),
        allDay({ start: DAY, end: "2026-08-28", summary: "Hotel B" }),
      ],
      { days: DAYS },
    );
    expect(found[0]!.events[0]).toMatchObject({ start: DAY, end: "2026-08-28", allDay: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// LAR-59-s1 — event refs carry which account and calendar they came from, when the fan-out
// set it. Groundwork only: a later ticket uses this to target the right calendar on delete.
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("LAR-59-s1 — account and calendar identity on conflict refs", () => {
  it("carries account and calendarId onto a finding's event refs, when the fan-out set them", () => {
    const found = detectCalendarConflicts(
      [
        timed({ from: "10:00", to: "11:00", summary: "Board call", account: "owner@owner.example", calendarId: "primary" }),
        timed({ from: "10:30", to: "11:30", summary: "Investor intro", account: "owner@owner.example", calendarId: "vdn" }),
      ],
      { days: DAYS },
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.events[0]).toMatchObject({ account: "owner@owner.example", calendarId: "primary" });
    expect(found[0]!.events[1]).toMatchObject({ account: "owner@owner.example", calendarId: "vdn" });
  });

  it("omits both fields when the input event carries neither — no key appears at all", () => {
    const found = detectCalendarConflicts(
      [
        timed({ from: "10:00", to: "11:00", summary: "Board call" }),
        timed({ from: "10:30", to: "11:30", summary: "Investor intro" }),
      ],
      { days: DAYS },
    );
    expect(found[0]!.events[0]).not.toHaveProperty("account");
    expect(found[0]!.events[0]).not.toHaveProperty("calendarId");
  });

  it("does not change any explanation or finding shape otherwise — byte-identical to the plain case", () => {
    const withIdentity = detectCalendarConflicts(
      [
        timed({ from: "10:00", to: "11:00", summary: "Board call", account: "owner@owner.example", calendarId: "primary" }),
        timed({ from: "10:30", to: "11:30", summary: "Investor intro", account: "owner@owner.example", calendarId: "primary" }),
      ],
      { days: DAYS },
    );
    const plain = detectCalendarConflicts(
      [
        timed({ from: "10:00", to: "11:00", summary: "Board call" }),
        timed({ from: "10:30", to: "11:30", summary: "Investor intro" }),
      ],
      { days: DAYS },
    );
    expect(withIdentity[0]!.explanation).toBe(plain[0]!.explanation);
    expect(withIdentity[0]!.kind).toBe(plain[0]!.kind);
    expect(withIdentity[0]!.severity).toBe(plain[0]!.severity);
  });
});
