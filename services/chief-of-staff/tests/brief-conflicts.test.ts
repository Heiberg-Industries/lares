/**
 * The conflict radar where the brief meets it (ORB-139) — the block, the clause, the pass, and
 * the one promise that matters most on a quiet morning: with nothing to report, the brief is
 * byte-for-byte the brief that shipped before this feature existed.
 *
 * The detection RULES are `tests/calendar-conflicts.test.ts`'s subject; this file is only about
 * the wiring — what gets rendered, what does not, and that today's rows did not change shape
 * when the same read started feeding a second consumer.
 */
import { describe, it, expect } from "vitest";

import {
  CONFLICT_LINES_MAX,
  buildMorningBrief,
  conflictLine,
  conflictTrips,
  conflictsBlock,
  conflictsClause,
  listTodayCalendar,
  listTodayMeetings,
  type BriefContent,
  type BriefTravel,
  type CalendarSourceDeps,
  type IngestedPick,
  type NightBeforeMeeting,
  type Obligation,
} from "../lib/brief-content.js";
import type { CalendarConflict } from "../lib/calendar-conflicts.js";
import type { ResolvedConflict } from "../lib/conflict-resolution.js";
import type { CalendarEvent } from "../lib/google.js";
import { buildMorningPrompt } from "../agent/schedules/morning-brief.js";

function conflict(overrides: Partial<CalendarConflict> = {}): CalendarConflict {
  return {
    kind: "double-booked",
    severity: "high",
    events: [
      { id: "e1", title: "Board call", start: "2026-08-26T10:00:00+02:00", end: "2026-08-26T11:00:00+02:00" },
      { id: "e2", title: "Investor intro", start: "2026-08-26T10:30:00+02:00", end: "2026-08-26T11:30:00+02:00" },
    ],
    explanation: '"Board call" and "Investor intro" overlap in time — they cannot both happen as booked.',
    ...overrides,
  };
}

function meeting(overrides: Partial<NightBeforeMeeting> = {}): NightBeforeMeeting {
  return {
    title: "Pilot kickoff",
    startsAt: new Date("2026-08-26T09:00:00Z"),
    participants: ["lars@partner.example"],
    kind: "remote-call",
    ...overrides,
  };
}

const EMPTY_CONTENT: BriefContent = { meetings: [], obligations: [], picks: [] };

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The block
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("conflictsBlock", () => {
  it("renders a labeled block when there is at least one finding", () => {
    const block = conflictsBlock([conflict()]);
    expect(block).toContain("## Clashes");
    expect(block).toContain("double-booked");
    expect(block).toContain("overlap in time");
  });

  it("renders NOTHING when there is nothing to report — by exception, never a negative", () => {
    // The same contract the obligations half has carried since the wave-1 plan: silence is the
    // answer, and "no conflicts today" is a sentence this brief must never write.
    expect(conflictsBlock([])).toBe("");
    expect(conflictsBlock([])).not.toMatch(/no conflict|nothing clash|ingen/i);
  });

  it("says plainly that nothing here has been resolved or acted on", () => {
    // Detection ships without resolution on purpose. A block that read as "I checked" would be
    // claiming a reading she has not done.
    const block = conflictsBlock([conflict()]);
    expect(block).toContain("nothing here has been resolved");
    expect(block).toContain("acted on");
  });

  it(`caps at ${CONFLICT_LINES_MAX} lines and says how many it is holding back`, () => {
    const many = [conflict(), conflict({ kind: "overlapping-stay" }), conflict({ kind: "timezone-trap" }), conflict(), conflict()];
    const block = conflictsBlock(many);
    expect(block.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(CONFLICT_LINES_MAX + 1);
    expect(block).toContain("(2 more clashes today, not listed here)");
  });

  it("adds no 'more' line when everything fits, and singularises when one is held back", () => {
    expect(conflictsBlock([conflict()])).not.toContain("not listed here");
    const four = [conflict(), conflict(), conflict(), conflict()];
    expect(conflictsBlock(four)).toContain("(1 more clash today, not listed here)");
  });

  it("quotes the radar's own sentence rather than rewriting it", () => {
    const c = conflict({ explanation: "Two places to sleep are booked over the night of 2026-08-26." });
    expect(conflictLine(c)).toContain("Two places to sleep are booked over the night of 2026-08-26.");
  });
});

describe("conflictsClause", () => {
  it("is empty when there is nothing to say", () => {
    expect(conflictsClause([])).toEqual([]);
  });

  it("tells her to report and STOP — no deciding, no mail, no cancelling", () => {
    const text = conflictsClause([conflict()]).join(" ");
    expect(text).toContain("do not decide which one is right");
    expect(text).toContain("do not check mail");
    expect(text).toMatch(/cancel, decline or move/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// LAR-59-s6 — the morning brief carries the evidence.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** A strong resolution row, the shape `lib/conflict-resolution.ts` attaches. */
function strongResolution(overrides: Partial<NonNullable<ResolvedConflict["resolution"]>> = {}) {
  return {
    staleEventId: "e1",
    account: "owner@example.invalid",
    calendarId: "primary",
    strength: "strong" as const,
    sentence: 'Cancellation mail from The Standard, 18 Aug 2026: "Booking cancelled".',
    ...overrides,
  };
}

describe("LAR-59-s6 pin — with no resolution, rendering is byte-identical to today, in every language", () => {
  it("conflictsBlock ignores lang when nothing carries evidence — nb and en match today's exact wording", () => {
    const today = conflictsBlock([conflict()]);
    expect(conflictsBlock([conflict()], "en")).toBe(today);
    expect(conflictsBlock([conflict()], "nb")).toBe(today);
    expect(today).toContain("nothing here has been resolved");
    expect(today).not.toContain("Evidence:");
    expect(today).not.toContain("Everything under this heading was written by someone else");
  });

  it("conflictLine appends nothing without a resolution, whatever the language", () => {
    const c = conflict();
    const before = conflictLine(c);
    expect(conflictLine(c, "en")).toBe(before);
    expect(conflictLine(c, "nb")).toBe(before);
  });

  it("conflictsClause is unchanged with no resolution present", () => {
    expect(conflictsClause([conflict()])).toEqual([
      "Something on today's calendar contradicts itself. Say so in one clause, name what clashes,",
      "and stop there — do not decide which one is right, do not check mail for the answer, and do",
      "not offer to cancel, decline or move anything.",
      "",
    ]);
  });
});

describe("LAR-59-s6 — a strong resolution adds the evidence line and the third-party notice", () => {
  it("conflictLine appends the evidence sentence, prefixed by the language's own fixed word", () => {
    const c: ResolvedConflict = { ...conflict(), resolution: strongResolution() };
    expect(conflictLine(c, "en")).toBe(`- double-booked — ${c.explanation} Evidence: ${c.resolution!.sentence}`);
    expect(conflictLine(c, "nb")).toBe(`- double-booked — ${c.explanation} Bevis: ${c.resolution!.sentence}`);
  });

  it("a weak match, or no resolution at all, appends nothing — only a strong match earns the evidence line", () => {
    const weak: ResolvedConflict = { ...conflict(), resolution: strongResolution({ strength: "weak" }) };
    expect(conflictLine(weak)).toBe(conflictLine(conflict()));
    const none: ResolvedConflict = { ...conflict() };
    expect(conflictLine(none)).toBe(conflictLine(conflict()));
  });

  it("conflictsBlock renders the evidence exactly once and flags the block third-party", () => {
    const c: ResolvedConflict = { ...conflict(), resolution: strongResolution() };
    const block = conflictsBlock([c]);
    expect((block.match(/Evidence:/g) ?? []).length).toBe(1);
    expect(block).toContain("Everything under this heading was written by someone else");
    expect(block).toContain("checked against mail only where a row says so");
    expect(block).not.toContain("nothing here has been resolved");
  });

  it("a block with no evidence anywhere carries no third-party notice", () => {
    const block = conflictsBlock([conflict()]);
    expect(block).not.toContain("Everything under this heading was written by someone else");
  });

  it("a weak-only match never flags the block third-party either", () => {
    const weak: ResolvedConflict = { ...conflict(), resolution: strongResolution({ strength: "weak" }) };
    const block = conflictsBlock([weak]);
    expect(block).not.toContain("Everything under this heading was written by someone else");
    expect(block).not.toContain("Evidence:");
  });

  it("conflictsClause adds exactly one extra sentence, and keeps the ban on deciding or acting alone", () => {
    const c: ResolvedConflict = { ...conflict(), resolution: strongResolution() };
    const withEvidence = conflictsClause([c]);
    const without = conflictsClause([conflict()]);
    expect(withEvidence.slice(0, without.length - 1)).toEqual(without.slice(0, without.length - 1));
    expect(withEvidence).toHaveLength(without.length + 1);
    const text = withEvidence.join(" ");
    expect(text).toContain("do not decide which one is right");
    expect(text).toContain("offer to remove the stale entry through its approval card");
    expect(text).toContain("wait for his answer");
    expect(text).toContain("never delete it yourself");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The prompt
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("buildMorningPrompt with conflicts", () => {
  const withConflicts: BriefContent = { meetings: [meeting()], obligations: [], picks: [], conflicts: [conflict()] };
  const withoutConflicts: BriefContent = { meetings: [meeting()], obligations: [], picks: [] };

  it("renders the block and the clause when the radar found something", () => {
    const prompt = buildMorningPrompt(withConflicts);
    expect(prompt).toContain("## Clashes");
    expect(prompt).toContain("Something on today's calendar contradicts itself");
  });

  it("renders the block right under the calendar it is about", () => {
    const prompt = buildMorningPrompt(withConflicts);
    expect(prompt.indexOf("Today's calendar")).toBeLessThan(prompt.indexOf("## Clashes"));
    expect(prompt.indexOf("## Clashes")).toBeLessThan(prompt.indexOf("owed a reply"));
  });

  it("renders NOTHING about conflicts otherwise, and the prompt is byte-for-byte the old one", () => {
    // The promise that keeps this feature cheap: on a morning with a clean calendar, the brief
    // is the exact brief that shipped before the radar existed. `conflicts: []` and no
    // `conflicts` key at all must both produce it.
    const before = buildMorningPrompt(withoutConflicts);
    expect(buildMorningPrompt({ ...withoutConflicts, conflicts: [] })).toBe(before);
    expect(before).not.toContain("Clashes");
    expect(before).not.toContain("contradicts itself");
  });

  it("leaves an empty brief untouched too", () => {
    expect(buildMorningPrompt({ ...EMPTY_CONTENT, conflicts: [] })).toBe(buildMorningPrompt(EMPTY_CONTENT));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// buildMorningBrief
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("buildMorningBrief and conflicts", () => {
  const base = {
    obligations: [] as Obligation[],
    deliveredLastNight: new Set<string>(),
    picks: [] as IngestedPick[],
  };

  it("passes findings through onto the content", () => {
    const content = buildMorningBrief({ ...base, meetings: [meeting()], conflicts: [conflict()] });
    expect(content?.conflicts).toHaveLength(1);
  });

  it("omits the key entirely when there is nothing found", () => {
    const content = buildMorningBrief({ ...base, meetings: [meeting()], conflicts: [] });
    expect(content).toEqual(buildMorningBrief({ ...base, meetings: [meeting()] }));
    expect(content && "conflicts" in content).toBe(false);
  });

  it("does NOT make a brief happen on its own — a clash lives on a commitment", () => {
    // There is no such thing as a clash with no meetings, so a conflict can never be the only
    // reason to interrupt him. Asserted so nobody later adds a case that cannot arise.
    expect(buildMorningBrief({ ...base, meetings: [], conflicts: [conflict()] })).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The pass — one read, two consumers
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("listTodayCalendar", () => {
  const NOW = new Date("2026-08-26T06:00:00Z"); // 08:00 Oslo, the morning slot

  /** Today's events as the fan-out would hand them over. */
  const events: CalendarEvent[] = [
    { id: "m1", summary: "Board call", start: "2026-08-26T10:00:00+02:00", end: "2026-08-26T11:00:00+02:00", attendees: [{ email: "lars@partner.example" }] },
    { id: "m2", summary: "Investor intro", start: "2026-08-26T10:30:00+02:00", end: "2026-08-26T11:30:00+02:00", attendees: [{ email: "ida@example.com" }] },
    // A neighbouring day, fetched by the 60-hour window and dropped from today's rows.
    { id: "m3", summary: "Tomorrow's thing", start: "2026-08-27T10:00:00+02:00", end: "2026-08-27T11:00:00+02:00", attendees: [{ email: "x@example.com" }] },
  ];

  function deps(items: CalendarEvent[] = events): CalendarSourceDeps & { reads: number } {
    const d = {
      reads: 0,
      async listEvents() { d.reads++; return items; },
      async myAddresses() { return ["owner@example.invalid"]; },
    };
    return d;
  }

  it("returns exactly the rows listTodayMeetings returns, off ONE read", async () => {
    const a = deps();
    const b = deps();
    const day = await listTodayCalendar(a, NOW);
    expect(day.meetings).toEqual(await listTodayMeetings(b, NOW));
    expect(a.reads).toBe(1);
  });

  it("finds today's clash on the same read", async () => {
    const day = await listTodayCalendar(deps(), NOW);
    expect(day.conflicts.map((c) => c.kind)).toEqual(["double-booked"]);
    expect(day.conflicts[0]!.events.map((e) => e.id)).toEqual(["m1", "m2"]);
  });

  it("is bounded to TODAY — tomorrow's clash is not this morning's business", async () => {
    const tomorrowOnly: CalendarEvent[] = [
      { id: "t1", summary: "A", start: "2026-08-27T10:00:00+02:00", end: "2026-08-27T11:00:00+02:00" },
      { id: "t2", summary: "B", start: "2026-08-27T10:30:00+02:00", end: "2026-08-27T11:30:00+02:00" },
    ];
    const day = await listTodayCalendar(deps(tomorrowOnly), NOW);
    expect(day.conflicts).toEqual([]);
  });

  it("uses the itinerary's clock: a home-time meeting on a trip day is a trap", async () => {
    const statusMeeting: CalendarEvent[] = [
      { id: "s1", summary: "Status meeting", start: "2026-08-26T12:00:00+02:00", end: "2026-08-26T12:30:00+02:00", attendees: [{ email: "team@example.com" }] },
    ];
    const home = await listTodayCalendar(deps(statusMeeting), NOW);
    expect(home.conflicts).toEqual([]);

    const away = await listTodayCalendar(deps(statusMeeting), NOW, {
      trips: [{ start: "2026-08-26", end: "2026-08-31", timezone: "America/New_York" }],
    });
    expect(away.conflicts.map((c) => c.kind)).toEqual(["timezone-trap"]);
    expect(away.conflicts[0]!.explanation).toContain("06:00");
  });

  it("still throws on a truncated read rather than reporting a clean calendar", async () => {
    // The ceiling guard is `readCalendarWindow`'s, unchanged by the split: a cut-off read that
    // answered "nothing clashes" would be the most convincing wrong answer this pass can give.
    const tooMany = Array.from({ length: 250 }, (_, i) =>
      ({ id: `x${i}`, summary: `x${i}`, start: "2026-08-26T10:00:00+02:00", end: "2026-08-26T11:00:00+02:00" }));
    await expect(listTodayCalendar(deps(tooMany), NOW)).rejects.toThrow(/maximum 250 events/);
  });
});

describe("conflictTrips", () => {
  it("is empty with no travel wiring — which reads as the home clock, the honest default", () => {
    expect(conflictTrips(undefined)).toEqual([]);
  });

  it("is empty for a store that could not be read, rather than inventing a zone", () => {
    const sick: BriefTravel = { day: "2026-08-26", dayWord: "today", travel: { trips: [], unavailable: "store unreadable" } };
    expect(conflictTrips(sick)).toEqual([]);
  });

  it("carries each trip's span and zone across, and nothing else", () => {
    const travel: BriefTravel = {
      day: "2026-08-26",
      dayWord: "today",
      travel: {
        trips: [{
          trip: { slug: "nyc", name: "New York", start: "2026-08-26", end: "2026-08-31", timezone: "America/New_York", destination: "New York" },
          lodging: [], transport: [], other: [], notes: "", itinerary: "",
        }],
      },
    };
    expect(conflictTrips(travel)).toEqual([{ start: "2026-08-26", end: "2026-08-31", timezone: "America/New_York" }]);
  });
});
