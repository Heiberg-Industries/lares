import { describe, it, expect } from "vitest";

import {
  listTodayMeetings,
  buildMorningBrief,
  buildEveningBrief,
  transitCandidates,
  transitClause,
  type CalendarSourceDeps,
  type NightBeforeMeeting,
} from "../lib/brief-content.js";
import type { CalendarEvent } from "../lib/google.js";
import { buildMorningPrompt } from "../agent/schedules/morning-brief.js";
import { buildEveningPrompt } from "../agent/schedules/evening-brief.js";

/**
 * ORB-168 — the brief may name a REAL departure.
 *
 * The morning of 2026-08-25 the brief wrote "trains Oslo→Tønsberg run roughly hourly, about
 * 1h40" about a 17:00 in Tønsberg. Every word of that was a guess: it is unverifiable, and it
 * cannot answer the only question he actually had, which is WHICH departure gets him there.
 * Tasks 1–3 gave Saga `agent-kit__transit_plan` (Entur — real departures, real platforms,
 * real-time delay, and arrive-by). This is the half that lets a brief reach for it.
 *
 * WHAT THIS FILE CAN AND CANNOT PIN. Prompt composition is deterministic and is tested here;
 * what the model then does with the prompt is not. So the grounding requirement — "if the
 * lookup fails or returns nothing, say nothing about transport" — is pinned as the instruction
 * being present and unambiguous, and as the estimate vocabulary being explicitly banned rather
 * than merely absent.
 *
 * The events are the REAL 2026-08-25 rows (see `brief-event-kinds.test.ts`, which read them off
 * `events.list` the same day). Note that the 17:00's `location` is the bare string "FÆRD
 * Kommunikasjon" with no town in it at all — which is exactly why the town question cannot be
 * settled by string comparison here, and why the tool (whose result names the resolved
 * locality) is the thing that settles it.
 */

const THAT_MORNING = new Date("2026-08-25T06:00:00Z");

const HOTEL: CalendarEvent = {
  id: "shuic7vnh9dddmt184aebdvbfo",
  summary: "Stay at Scandic Oslo Airport",
  start: "2026-08-25", end: "2026-08-27",
  allDay: true,
  eventType: "fromGmail",
  location: "Ravinevegen 15, 2060, Gardermoen",
  attendees: [{ email: "owner@owner.example" }],
};

const INTRO_CALL: CalendarEvent = {
  id: "fs19irbssj0voco75m0frfo7k4",
  summary: "Intro call — Connor Turland",
  start: "2026-08-25T14:30:00Z", end: "2026-08-25T15:00:00Z",
  eventType: "default",
  hasConferenceLink: true,
  attendees: [{ email: "connor@atcyrus.com" }],
};

const TONSBERG_SESSION: CalendarEvent = {
  id: "_891k2dph84sjab9j74sk6b9k6l34cba28h1jgb9p84oj0ea26d2k6dpo6o",
  summary: "AI & Agenter - TBG Comm",
  start: "2026-08-25T15:00:00Z", end: "2026-08-25T16:50:00Z",
  eventType: "default",
  location: "FÆRD Kommunikasjon",
};

function depsFor(events: CalendarEvent[]): CalendarSourceDeps {
  return { listEvents: async () => events, myAddresses: async () => ["owner@owner.example"] };
}

/** The prompt as SENTENCES rather than as lines. The clause is hard-wrapped like every other
 *  block in these prompts, so asserting a sentence against the raw string would really be
 *  asserting where the wrap falls — and would break on a reflow that changed nothing. */
function sentences(prompt: string): string {
  return prompt.replace(/\s+/g, " ");
}

async function morningPromptFor(events: CalendarEvent[], now = THAT_MORNING): Promise<string> {
  const meetings = await listTodayMeetings(depsFor(events), now);
  const content = buildMorningBrief({ meetings, obligations: [], deliveredLastNight: new Set(), picks: [] });
  expect(content).not.toBeNull();
  return buildMorningPrompt(content!);
}

// ── the gate: which rows could ever earn a lookup ───────────────────────────────────────────

describe("transitCandidates", () => {
  const row = (over: Partial<NightBeforeMeeting>): NightBeforeMeeting => ({
    title: "x", startsAt: new Date("2026-08-25T15:00:00Z"), participants: [], kind: "in-person",
    location: "FÆRD Kommunikasjon", ...over,
  });

  it("an in-person commitment with a venue and a clock time qualifies", () => {
    expect(transitCandidates([row({})])).toHaveLength(1);
  });

  it("a remote call never qualifies — it has no venue by construction (ORB-165)", () => {
    expect(transitCandidates([row({ kind: "remote-call", location: undefined })])).toEqual([]);
  });

  it("a block he set aside has nowhere to go", () => {
    expect(transitCandidates([row({ kind: "block", location: undefined })])).toEqual([]);
  });

  it("an all-day row never qualifies — there is no time to arrive BY", () => {
    expect(transitCandidates([row({ allDay: true })])).toEqual([]);
  });

  it("an in-person row whose location is blank has no destination to plan to", () => {
    expect(transitCandidates([row({ location: "   " })])).toEqual([]);
  });
});

// ── the arrive-by value the brief computes so the model never has to ────────────────────────

describe("the arrive-by the clause hands over", () => {
  const at = (iso: string): NightBeforeMeeting => ({
    title: "Session", startsAt: new Date(iso), participants: [], kind: "in-person", location: "FÆRD Kommunikasjon",
  });

  it("is ISO-8601 WITH the real Oslo offset in summer (CEST)", () => {
    expect(transitClause([at("2026-08-25T15:00:00Z")], [], "today").join("\n"))
      .toContain("arriveBy 2026-08-25T17:00:00+02:00");
  });

  it("…and in winter (CET) — the offset is computed, never assumed", () => {
    expect(transitClause([at("2026-01-14T15:00:00Z")], [], "today").join("\n"))
      .toContain("arriveBy 2026-01-14T16:00:00+01:00");
  });

  // LAR-16-s4 — the same instants, read through a different owner clock. `tz` rides in as the
  // 5th argument, after the (omitted) itinerary, and DEFAULT_HOME_TZ (Europe/Oslo) is what the
  // two cases above exercise implicitly by never passing one.
  it("America/New_York, summer (EDT) — the offset is -04:00", () => {
    expect(transitClause([at("2026-08-25T14:00:00Z")], [], "today", undefined, "America/New_York").join("\n"))
      .toContain("arriveBy 2026-08-25T10:00:00-04:00");
  });

  it("America/New_York, winter (EST) — the offset is -05:00", () => {
    expect(transitClause([at("2026-01-14T14:00:00Z")], [], "today", undefined, "America/New_York").join("\n"))
      .toContain("arriveBy 2026-01-14T09:00:00-05:00");
  });
});

// ── the 2026-08-25 replay ───────────────────────────────────────────────────────────────────

describe("ORB-168 — the brief may state a real departure", () => {
  it("THE TØNSBERG CASE: an in-person out-of-town commitment makes the tool instructed, with its venue and arrive-by", async () => {
    const prompt = await morningPromptFor([HOTEL, INTRO_CALL, TONSBERG_SESSION]);

    expect(prompt).toContain("agent-kit__transit_plan");
    expect(prompt).toContain("AI & Agenter - TBG Comm — venue: FÆRD Kommunikasjon — arriveBy 2026-08-25T17:00:00+02:00");
  });

  it("names the estimate it replaces, so the guess is banned rather than merely unmentioned", async () => {
    const prompt = sentences(await morningPromptFor([HOTEL, INTRO_CALL, TONSBERG_SESSION]));
    // The exact words the 2026-08-25 brief used. "Do not estimate" reads as a style note; the
    // sentence it actually wrote reads as a rule.
    expect(prompt).toContain('"trains run roughly hourly" or "about 1h40"');
    expect(prompt).toContain("an estimate is not an answer");
    expect(prompt).toContain(
      "Never state a departure time, a line, a platform, a duration or a frequency for any " +
        "journey unless a transit lookup returned it in this turn",
    );
  });

  it("A FAILED OR EMPTY LOOKUP IS NOT A TRANSPORT SENTENCE — the absent-block reading, verbatim", async () => {
    const prompt = sentences(await morningPromptFor([HOTEL, INTRO_CALL, TONSBERG_SESSION]));
    // `absentBlockClause`'s own vocabulary (@lares/compose-contract): a thing you were not told
    // about is not a thing you may report as empty.
    expect(prompt).toContain(
      "If a lookup fails, comes back with nothing, or reports that it could not resolve one of " +
        "the place names, you were not told about transport at all: say nothing about it — do " +
        "not report it as empty, and do not state that there was nothing.",
    );
  });

  it("is bounded — one lookup per listed commitment, and none for a venue in the town he is already in", async () => {
    const prompt = sentences(await morningPromptFor([HOTEL, INTRO_CALL, TONSBERG_SESSION]));
    expect(prompt).toContain("At most ONE lookup per commitment listed");
    expect(prompt).toContain("none at all for a venue in the town he is already in");
  });

  it("a CALENDAR lodging row is never the journey's origin — a booking is not evidence he is in that bed", async () => {
    // The word CALENDAR is the whole point after ORB-169's follow-up review: this ban was
    // written when a calendar row was the only kind of lodging row there was. An ITINERARY
    // lodging row — one Marcel resolved — IS an origin, and is named by `transitClause` when it
    // exists. See `brief-transit-origin.test.ts` for the two sentences side by side.
    const prompt = sentences(await morningPromptFor([HOTEL, INTRO_CALL, TONSBERG_SESSION]));
    expect(prompt).toContain("never pass a calendar lodging row as the journey's origin");
  });

  it("A REMOTE CALL DOES NOT: a day of calls never instructs the lookup", async () => {
    const prompt = await morningPromptFor([INTRO_CALL]);
    expect(prompt).not.toContain("agent-kit__transit_plan");
    expect(prompt).not.toContain("Getting there");
    // …but the prohibition still rides, because "the tool was not offered" was never the same
    // thing as "the model may estimate" (review finding 1).
    expect(sentences(prompt)).toContain('"trains run roughly hourly" or "about 1h40"');
  });

  it("neither does a day that is only travel context — a hotel is not somewhere he must get to", async () => {
    const prompt = await morningPromptFor([HOTEL]);
    expect(prompt).not.toContain("agent-kit__transit_plan");
    expect(sentences(prompt)).toContain('"trains run roughly hourly" or "about 1h40"');
  });

  it("both briefs carry the clause from the one helper — neither hand-rolls its own copy", async () => {
    const meetings = await listTodayMeetings(depsFor([HOTEL, INTRO_CALL, TONSBERG_SESSION]), THAT_MORNING);
    const evening = buildEveningPrompt(buildEveningBrief({ meetings, obligations: [] })!);
    const morning = buildMorningPrompt(buildMorningBrief({ meetings, obligations: [], deliveredLastNight: new Set(), picks: [] })!);
    const commitments = meetings.filter((m) => m.kind === "in-person");
    const travel = meetings.filter((m) => m.kind === "lodging");

    expect(morning).toContain(transitClause(commitments, travel, "today").join("\n").trim());
    expect(evening).toContain(transitClause(commitments, travel, "tomorrow").join("\n").trim());
  });

  it("the lodging sentence appears only when a LODGING row is actually there", () => {
    const commitment: NightBeforeMeeting = {
      title: "Session", startsAt: new Date("2026-08-25T15:00:00Z"), participants: [],
      kind: "in-person", location: "FÆRD Kommunikasjon",
    };
    const flight: NightBeforeMeeting = {
      title: "Flight to København (SK 455)", startsAt: new Date("2026-08-25T07:00:00Z"),
      participants: [], kind: "transport", location: "Oslo OSL",
    };
    expect(transitClause([commitment], [], "today").join("\n")).not.toContain("lodging row");
    // Review finding 5: `travel` also carries flights and out-of-office markers, so gating on
    // "any travel context" warned about a hotel that is not on the day at all.
    expect(transitClause([commitment], [flight], "today").join("\n")).not.toContain("lodging row");
  });
});

// ── review round 1 ──────────────────────────────────────────────────────────────────────────

describe("ORB-168 review round 1", () => {
  /** The finding-1 shape: out of town, in person, and NOT a candidate — an all-day row has no
   *  instant to arrive by, so no lookup can be instructed for it. The venue reaches the model
   *  regardless, which is the whole problem. */
  const ALL_DAY_OUT_OF_TOWN: CalendarEvent = {
    id: "allday-tbg",
    summary: "AI & Agenter - TBG Comm",
    start: "2026-08-25", end: "2026-08-26",
    allDay: true,
    eventType: "default",
    location: "FÆRD Kommunikasjon, Tønsberg",
  };

  it("FINDING 1: an all-day out-of-town row earns NO lookup and still carries the ban", async () => {
    const meetings = await listTodayMeetings(depsFor([ALL_DAY_OUT_OF_TOWN]), THAT_MORNING);
    expect(meetings[0]?.kind).toBe("in-person");
    expect(transitCandidates(meetings)).toEqual([]);

    const prompt = await morningPromptFor([ALL_DAY_OUT_OF_TOWN]);
    // The venue really is in front of the model…
    expect(prompt).toContain("FÆRD Kommunikasjon, Tønsberg");
    // …with no lookup offered…
    expect(prompt).not.toContain("agent-kit__transit_plan");
    // …and the guess this ticket exists to kill nonetheless forbidden.
    const flat = sentences(prompt);
    expect(flat).toContain('"trains run roughly hourly" or "about 1h40"');
    expect(flat).toContain("Never state a departure time, a line, a platform, a duration or a frequency");
    expect(flat).toContain("say nothing about it — do not report it as empty");
  });

  it("FINDING 1: the ban rides even on a day with nothing on it at all", () => {
    expect(sentences(transitClause([], [], "today").join("\n")))
      .toContain('"trains run roughly hourly" or "about 1h40"');
    expect(sentences(transitClause([], [], "tomorrow").join("\n")))
      .toContain('"trains run roughly hourly" or "about 1h40"');
  });

  it("FINDING 2: the evening pass anchors the origin on TOMORROW, not on tonight", async () => {
    const meetings = await listTodayMeetings(depsFor([HOTEL, TONSBERG_SESSION]), THAT_MORNING);
    const evening = sentences(buildEveningPrompt(buildEveningBrief({ meetings, obligations: [] })!));

    expect(evening).toContain("DIFFERENT TOWN from where he will be tomorrow");
    expect(evening).toContain("the journey starts wherever he will be TOMORROW MORNING");
    expect(evening).toContain("different question from where he is tonight");
    // The present-tense reading — right at 08:00, wrong at 20:00 — must be gone from this one.
    expect(evening).not.toContain("DIFFERENT TOWN from where he already is");
  });

  it("FINDING 2: …and the morning pass keeps the present tense, which is correct there", async () => {
    const morning = sentences(await morningPromptFor([HOTEL, TONSBERG_SESSION]));
    expect(morning).toContain("DIFFERENT TOWN from where he already is");
    expect(morning).toContain("none at all for a venue in the town he is already in");
    expect(morning).not.toContain("TOMORROW MORNING");
  });

  it("FINDING 3: an unknowable origin must be declared, not assumed", async () => {
    const morning = sentences(await morningPromptFor([HOTEL, TONSBERG_SESSION]));
    expect(morning).toContain("Say in plain words where you assumed the journey starts");
    expect(morning).toContain("If you cannot actually say where he will be, say THAT and look nothing up");
    // Why it matters, stated so the rule is not read as mere politeness.
    expect(morning).toContain("a wrong origin still returns a real departure from a real platform");
  });

  it("FINDING 4: a place name that did not resolve is named as its own non-answer", async () => {
    // `transit_plan` has THREE non-answers: EnturUnavailableError, an empty itinerary list, and
    // `{notFound: {query}}` — which is literally neither of the first two.
    expect(sentences(await morningPromptFor([HOTEL, TONSBERG_SESSION])))
      .toContain("If a lookup fails, comes back with nothing, or reports that it could not resolve one of the place names");
  });

  it("FINDING 6: a venue carrying a newline still renders as ONE candidate row", () => {
    const messy: NightBeforeMeeting = {
      title: "Session", startsAt: new Date("2026-08-25T15:00:00Z"), participants: [], kind: "in-person",
      location: "FÆRD Kommunikasjon\nNedre Langgate 20\n3126 Tønsberg",
    };
    const rows = transitClause([messy], [], "today").filter((l) => l.startsWith("- "));
    expect(rows).toEqual([
      "- Session — venue: FÆRD Kommunikasjon Nedre Langgate 20 3126 Tønsberg — arriveBy 2026-08-25T17:00:00+02:00",
    ]);
  });
});
