import { describe, it, expect } from "vitest";

import {
  listTodayCalendar,
  listTodayMeetings,
  listTomorrowMeetings,
  nightBeforeCoveredDay,
  readIngestedPicks,
  type CalendarSourceDeps,
  type PicksReader,
} from "../lib/brief-content.js";
import { dateIn } from "../lib/recurrence.js";
import type { CalendarEvent } from "../lib/google.js";

/**
 * LAR-67 — which calendar DAY a brief is about follows the OWNER's clock, not the home clock.
 *
 * LAR-16 moved the clock TIMES a brief prints onto the owner's timezone; this file is the other
 * half, the day boundaries. Two groups, written in this order on purpose:
 *
 *   1. PINS — the owner clock is the home clock (`Europe/Oslo`). Every day decision the ticket
 *      touches answers exactly as it did before, with and without the timezone handed in.
 *   2. THE BUG — the owner is abroad on an evening/morning where the home date and the owner's
 *      date DIFFER. "Tomorrow" and "today" must be the owner's.
 *
 * Every instant is fixed; nothing here reads a real clock. September 2026: Oslo is UTC+2,
 * New York UTC-4, Tokyo UTC+9, Auckland UTC+12 (its summer time starts on the 27th).
 */

const OSLO = "Europe/Oslo";
const NEW_YORK = "America/New_York";
const TOKYO = "Asia/Tokyo";
const AUCKLAND = "Pacific/Auckland";

const timed = (id: string, start: string, end: string): CalendarEvent => ({
  id, summary: id, start, end, attendees: [{ email: "them@example.com" }],
});
const allDay = (id: string, day: string, next: string): CalendarEvent => ({
  id, summary: id, start: day, end: next, allDay: true,
});

/** A fake calendar that honours the window it is asked for, as the real API does — so these
 *  tests also prove the fetched window still covers the owner's day. All-day rows are always
 *  returned: the API places them by the calendar's own zone, which this file has no opinion on. */
function calendar(events: CalendarEvent[]): CalendarSourceDeps {
  return {
    listEvents: async ({ timeMin, timeMax }) =>
      events.filter((e) => e.allDay === true || (e.end > timeMin && e.start < timeMax)),
    myAddresses: async () => ["owner@example.com"],
  };
}

const titles = (rows: Array<{ title: string }>) => rows.map((r) => r.title);

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 1. PINS — owner clock = home clock. Must pass before AND after the change.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** 20:00 in Oslo, Tuesday 15 September. */
const EVENING_OSLO = new Date("2026-09-15T18:00:00Z");
/** 08:00 in Oslo, Wednesday 16 September. */
const MORNING_OSLO = new Date("2026-09-16T06:00:00Z");

const HOME_WEEK: CalendarEvent[] = [
  timed("tue 21:00 oslo", "2026-09-15T19:00:00Z", "2026-09-15T20:00:00Z"),
  allDay("wed all day", "2026-09-16", "2026-09-17"),
  timed("wed 09:00 oslo", "2026-09-16T07:00:00Z", "2026-09-16T08:00:00Z"),
  timed("wed 23:30 oslo", "2026-09-16T21:30:00Z", "2026-09-16T22:00:00Z"),
  allDay("thu all day", "2026-09-17", "2026-09-18"),
  timed("thu 00:30 oslo", "2026-09-16T22:30:00Z", "2026-09-16T23:30:00Z"),
  timed("thu 09:00 oslo", "2026-09-17T07:00:00Z", "2026-09-17T08:00:00Z"),
];
const WEDNESDAY = ["wed all day", "wed 09:00 oslo", "wed 23:30 oslo"];

describe("PIN — with the owner clock = Europe/Oslo nothing moves (LAR-67)", () => {
  it("the evening pass covers tomorrow's Oslo date, with or without the timezone handed in", () => {
    expect(nightBeforeCoveredDay(EVENING_OSLO)).toBe("2026-09-16");
    expect(nightBeforeCoveredDay(EVENING_OSLO, OSLO)).toBe("2026-09-16");
  });

  it("tomorrow's meetings are Wednesday's — timed and all-day, nothing from Tuesday or Thursday", async () => {
    expect(titles(await listTomorrowMeetings(calendar(HOME_WEEK), EVENING_OSLO))).toEqual(WEDNESDAY);
    expect(titles(await listTomorrowMeetings(calendar(HOME_WEEK), EVENING_OSLO, OSLO))).toEqual(WEDNESDAY);
  });

  it("today's meetings are Wednesday's", async () => {
    expect(titles(await listTodayMeetings(calendar(HOME_WEEK), MORNING_OSLO))).toEqual(WEDNESDAY);
    expect(titles(await listTodayMeetings(calendar(HOME_WEEK), MORNING_OSLO, OSLO))).toEqual(WEDNESDAY);
  });

  it("the one-read calendar pass returns the same rows, and bounds clashes to that same day", async () => {
    const clashes: CalendarEvent[] = [
      ...HOME_WEEK,
      timed("wed clash", "2026-09-16T07:30:00Z", "2026-09-16T08:30:00Z"),
      timed("thu clash", "2026-09-17T07:30:00Z", "2026-09-17T08:30:00Z"),
    ];
    for (const opts of [{}, { tz: OSLO }]) {
      const day = await listTodayCalendar(calendar(clashes), MORNING_OSLO, opts);
      expect(titles(day.meetings)).toEqual(["wed all day", "wed 09:00 oslo", "wed clash", "wed 23:30 oslo"]);
      expect(day.conflicts.map((c) => c.events.map((e) => e.title))).toEqual([["wed 09:00 oslo", "wed clash"]]);
    }
  });

  it("last night's covered day IS this morning's today — the stamp and its reader agree", () => {
    expect(nightBeforeCoveredDay(EVENING_OSLO, OSLO)).toBe(dateIn(MORNING_OSLO, OSLO));
  });

  it("an evening where the two clocks happen to agree on the date answers the same on either", () => {
    // 20:00 in Auckland on Tuesday the 15th is 10:00 that same Tuesday in Oslo.
    const EVENING_AUCKLAND = new Date("2026-09-15T08:00:00Z");
    expect(nightBeforeCoveredDay(EVENING_AUCKLAND)).toBe("2026-09-16");
    expect(nightBeforeCoveredDay(EVENING_AUCKLAND, AUCKLAND)).toBe("2026-09-16");
  });
});

/**
 * The picks window is the one day decision that STAYS on the home clock: a note's `created` is a
 * date the vault wrote at home, so the cutoff it is compared against has to come off the same
 * clock. Pinned so nobody "finishes" LAR-67 by moving it.
 */
describe("PIN — the reading-picks cutoff stays on the home clock (LAR-67)", () => {
  const reader: PicksReader = {
    readdir: () => ["edge.md"],
    readFile: () => "---\ntitle: Edge\ncreated: 2026-09-09\n---\nbody",
  };

  it("a note created on the home-clock cutoff day is in; the instant only matters on the home clock", () => {
    // 02:00 in Oslo on the 16th: seven home days back is the 9th, so the note is inside.
    expect(readIngestedPicks("/vault/raw", new Date("2026-09-16T00:00:00Z"), reader)).toHaveLength(1);
    // 02:00 in Oslo on the 17th: the cutoff is the 10th, so it is out.
    expect(readIngestedPicks("/vault/raw", new Date("2026-09-17T00:00:00Z"), reader)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 2. THE BUG — the owner's date and the home date differ.
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("BUG — an evening brief at 20:00 New York is about the OWNER's tomorrow (LAR-67)", () => {
  /** 20:00 in New York on Tuesday the 15th — already 02:00 on Wednesday the 16th in Oslo. */
  const EVENING_NY = new Date("2026-09-16T00:00:00Z");

  const AWAY_WEEK: CalendarEvent[] = [
    allDay("wed all day", "2026-09-16", "2026-09-17"),
    timed("wed 10:00 new york", "2026-09-16T14:00:00Z", "2026-09-16T15:00:00Z"),
    // 22:00 on his Wednesday — already Thursday 04:00 at home.
    timed("wed 22:00 new york", "2026-09-17T02:00:00Z", "2026-09-17T03:00:00Z"),
    allDay("thu all day", "2026-09-17", "2026-09-18"),
    timed("thu 10:00 new york", "2026-09-17T14:00:00Z", "2026-09-17T15:00:00Z"),
  ];

  it("the covered day is Wednesday the 16th, not the home clock's Thursday", () => {
    expect(nightBeforeCoveredDay(EVENING_NY, NEW_YORK)).toBe("2026-09-16");
  });

  it("tomorrow's meetings are his Wednesday — including the late one that is Thursday at home", async () => {
    expect(titles(await listTomorrowMeetings(calendar(AWAY_WEEK), EVENING_NY, NEW_YORK))).toEqual([
      "wed all day", "wed 10:00 new york", "wed 22:00 new york",
    ]);
  });

  it("an all-day entry is read off its DATE, never pushed a day back by a zone west of UTC", async () => {
    const rows = await listTomorrowMeetings(calendar(AWAY_WEEK), EVENING_NY, NEW_YORK);
    expect(titles(rows)).toContain("wed all day");
    expect(titles(rows)).not.toContain("thu all day");
  });

  it("the stamp the evening writes is the day the next New York morning reads", () => {
    const NEXT_MORNING_NY = new Date("2026-09-16T12:00:00Z"); // 08:00 New York, Wednesday
    expect(nightBeforeCoveredDay(EVENING_NY, NEW_YORK)).toBe(dateIn(NEXT_MORNING_NY, NEW_YORK));
  });
});

describe("BUG — a morning brief at 08:00 Tokyo is about the OWNER's today (LAR-67)", () => {
  /** 08:00 in Tokyo on Wednesday the 16th — 01:00 the same Wednesday in Oslo. The two DATES agree
   *  at this instant; what differs is where the day ENDS: Tokyo's Wednesday is over seven hours
   *  before Oslo's, so the home clock pulls his Thursday-morning hours into "today". */
  const MORNING_TOKYO = new Date("2026-09-15T23:00:00Z");

  const TOKYO_WEEK: CalendarEvent[] = [
    timed("wed 22:30 tokyo", "2026-09-16T13:30:00Z", "2026-09-16T14:30:00Z"),
    // 00:30 on his Thursday — still 17:30 on Wednesday at home.
    timed("thu 00:30 tokyo", "2026-09-16T15:30:00Z", "2026-09-16T16:30:00Z"),
  ];

  it("today is his Wednesday: the 00:30 Thursday call is tomorrow's, whatever the home clock says", async () => {
    expect(titles(await listTodayMeetings(calendar(TOKYO_WEEK), MORNING_TOKYO, TOKYO))).toEqual(["wed 22:30 tokyo"]);
    const day = await listTodayCalendar(calendar(TOKYO_WEEK), MORNING_TOKYO, { tz: TOKYO });
    expect(titles(day.meetings)).toEqual(["wed 22:30 tokyo"]);
  });
});

describe("BUG — a morning brief at 08:00 Auckland, while it is still yesterday at home (LAR-67)", () => {
  /** 08:00 in Auckland on Wednesday the 16th — 22:00 on TUESDAY the 15th in Oslo. */
  const MORNING_AUCKLAND = new Date("2026-09-15T20:00:00Z");

  const AUCKLAND_WEEK: CalendarEvent[] = [
    // 22:00 on his Tuesday — noon on the home clock's "today".
    timed("tue 22:00 auckland", "2026-09-15T10:00:00Z", "2026-09-15T11:00:00Z"),
    allDay("tue all day", "2026-09-15", "2026-09-16"),
    allDay("wed all day", "2026-09-16", "2026-09-17"),
    timed("wed 14:00 auckland", "2026-09-16T02:00:00Z", "2026-09-16T03:00:00Z"),
  ];

  it("today is Wednesday the 16th — last night's dinner and Tuesday's all-day block are not on it", async () => {
    expect(titles(await listTodayMeetings(calendar(AUCKLAND_WEEK), MORNING_AUCKLAND, AUCKLAND))).toEqual([
      "wed all day", "wed 14:00 auckland",
    ]);
    const day = await listTodayCalendar(calendar(AUCKLAND_WEEK), MORNING_AUCKLAND, { tz: AUCKLAND });
    expect(titles(day.meetings)).toEqual(["wed all day", "wed 14:00 auckland"]);
  });
});
