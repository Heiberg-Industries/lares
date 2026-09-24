import { describe, it, expect } from "vitest";

import { wrapCalendarApi, type CalendarEvent } from "../lib/google.js";
import {
  classifyEvent,
  listTodayMeetings,
  buildMorningBrief,
  buildEveningBrief,
  isTravelContext,
  type CalendarSourceDeps,
  type EventKind,
} from "../lib/brief-content.js";
import { buildMorningPrompt } from "../agent/schedules/morning-brief.js";
import { buildEveningPrompt } from "../agent/schedules/evening-brief.js";

/**
 * ORB-165 — the brief had no notion of WHAT KIND of event it was looking at.
 *
 * On 2026-08-25 that cost two ungrounded assertions in one message: an all-day Gmail-created
 * hotel reservation ("Stay at Scandic Oslo Airport", 25–27 Aug, for Wednesday's 09:00 flight)
 * was rendered as `all day — Stay at Scandic Oslo Airport (Ravinevegen 15, …)` and read back
 * as "you're based at Scandic Oslo Airport all day"; and a 16:30 intro call with an external
 * attendee, no location and a Meet link was treated as a place, producing a "hard clash" with
 * a 17:00 in-person session 100 km away in Tønsberg.
 *
 * Every event literal below is the REAL shape, read off Bendik's calendar the same day
 * (`events.list`, 2026-08-24T22:00Z → 2026-08-27T22:00Z) rather than invented: the titles
 * Gmail generates are regular ("Stay at X", "Flight to X (SK 455)", "Reservation at X"), the
 * hotel row really does carry a `location`, and the intro call really does carry a Meet link
 * with no location at all.
 */

// ── classifyEvent — deterministic, no model call ────────────────────────────────────────────

describe("classifyEvent", () => {
  const kindOf = (e: Parameters<typeof classifyEvent>[0]): EventKind => classifyEvent(e);

  it("THE SCANDIC CASE: a Gmail-created hotel stay is lodging, even though it names a location", () => {
    expect(kindOf({
      summary: "Stay at Scandic Oslo Airport",
      eventType: "fromGmail",
      location: "Ravinevegen 15, 2060, Gardermoen",
    })).toBe("lodging");
  });

  it("a Gmail-created flight is transport, not a place he is at", () => {
    expect(kindOf({
      summary: "Flight to København (SK 455)",
      eventType: "fromGmail",
      location: "Oslo OSL",
    })).toBe("transport");
  });

  it("normalises the enum's other spelling — FROM_GMAIL is the same signal as fromGmail", () => {
    expect(kindOf({ summary: "Stay at PUBLIC Hotel New York", eventType: "FROM_GMAIL" })).toBe("lodging");
    expect(kindOf({ summary: "Flight to Newark (SK 909)", eventType: "FROM_GMAIL", location: "Copenhagen CPH" })).toBe("transport");
  });

  it("the title patterns apply ONLY to Gmail-created events — a normal meeting about a hotel is still in-person", () => {
    expect(kindOf({ summary: "Lunsj på Hotel Bristol", eventType: "default", location: "Kristian IVs gate 7" })).toBe("in-person");
    expect(kindOf({ summary: "Flight review with Ada", eventType: "default", location: "Youngstorget 3" })).toBe("in-person");
  });

  it("a Gmail-created event that is neither a stay nor a journey stays a normal commitment", () => {
    // Verified 2026-08-25: "Reservation at The Tavern at Gramercy Tavern" is a RESTAURANT
    // booking Gmail created — a place he actually goes. The ticket listed the bare word
    // "reservation" as a lodging pattern; the real data says otherwise, so lodging keys off
    // stay/hotel words and a reservation with a venue stays a commitment.
    expect(kindOf({ summary: "Reservation at The Tavern at Gramercy Tavern", eventType: "fromGmail" })).toBe("block");
    expect(kindOf({ summary: "Reservation at PUBLIC Hotel New York", eventType: "fromGmail" })).toBe("lodging");
  });

  it("out-of-office and working-location events are never presence in a brief", () => {
    expect(kindOf({ summary: "Ferie", eventType: "outOfOffice" })).toBe("out-of-office");
    expect(kindOf({ summary: "Home", eventType: "workingLocation" })).toBe("out-of-office");
    expect(kindOf({ summary: "Home", eventType: "WORKING_LOCATION" })).toBe("out-of-office");
  });

  it("THE INTRO-CALL CASE: attendees and no location is a remote call, not a place", () => {
    expect(kindOf({
      summary: "Intro call — Connor Turland",
      eventType: "default",
      participants: ["connor@atcyrus.com"],
      hasConferenceLink: true,
    })).toBe("remote-call");
  });

  it("attendees and no location is remote even with no conference link — a venue-less call is remote", () => {
    expect(kindOf({ summary: "Catch-up", eventType: "default", participants: ["lars@partner.example"] })).toBe("remote-call");
  });

  it("THE HYBRID CASE: a venue he can be at outranks a link he can join", () => {
    // Fix round 1, Finding 1. Google Workspace adds a Meet link to nearly every invitation by
    // default, so letting the link decide announced a meeting at a counterpart's office as
    // "not somewhere he must be" — ORB-165's defect, inverted.
    expect(kindOf({
      summary: "Styremøte",
      eventType: "default",
      participants: ["lars@partner.example"],
      location: "FÆRD Kommunikasjon",
      hasConferenceLink: true,
    })).toBe("in-person");
  });

  it("a conference link only decides when there is nowhere to go — a link-shaped location is not a venue", () => {
    expect(kindOf({
      summary: "Weekly",
      participants: ["lars@partner.example"],
      location: "Meet: https://meet.google.com/ffb-eimd-pea",
      hasConferenceLink: true,
    })).toBe("remote-call");
  });

  it("a join link with nobody listed is still a call — there is nowhere to be", () => {
    expect(kindOf({ summary: "Office hours", hasConferenceLink: true })).toBe("remote-call");
  });

  it("remote-call implies no venue — the invariant the render and the prompt clause rely on", () => {
    const withVenue = { summary: "x", participants: ["a@b.co"], hasConferenceLink: true, location: "Youngstorget 3" };
    expect(kindOf(withVenue)).not.toBe("remote-call");
  });

  it("a location that is only a link is not a venue — the call is still remote", () => {
    expect(kindOf({ summary: "Weekly", participants: ["lars@partner.example"], location: "https://zoom.us/j/123" })).toBe("remote-call");
  });

  it("a located event with nobody on the invitation is in-person — he has to be there", () => {
    expect(kindOf({ summary: "AI & Agenter - TBG Comm", eventType: "default", location: "FÆRD Kommunikasjon" })).toBe("in-person");
  });

  it("no attendees, no location, no Gmail origin — a block he set aside", () => {
    expect(kindOf({ summary: "Klargjøre hus for visning" })).toBe("block");
  });

  it("only lodging, transport and out-of-office are travel context; the rest are commitments", () => {
    expect((["lodging", "transport", "out-of-office"] as EventKind[]).every(isTravelContext)).toBe(true);
    expect((["remote-call", "in-person", "block"] as EventKind[]).some(isTravelContext)).toBe(false);
  });
});

// ── the boundary: eventType and conference data must survive listEvents ─────────────────────

describe("wrapCalendarApi.listEvents — the fields classification needs", () => {
  function apiReturning(items: unknown[]) {
    return { events: { list: async () => ({ data: { items } }) } } as never;
  }

  it("carries eventType through — the field that says 'Gmail created this'", async () => {
    const { items } = await wrapCalendarApi(apiReturning([
      { id: "e1", summary: "Stay at Scandic Oslo Airport", eventType: "fromGmail", location: "Ravinevegen 15, 2060, Gardermoen", start: { date: "2026-08-25" }, end: { date: "2026-08-27" } },
    ])).listEvents({ timeMin: "t1", timeMax: "t2", maxResults: 10 });
    expect(items[0]).toMatchObject({ eventType: "fromGmail", allDay: true, location: "Ravinevegen 15, 2060, Gardermoen" });
  });

  it("marks a hangoutLink as a conference link", async () => {
    const { items } = await wrapCalendarApi(apiReturning([
      { id: "e2", summary: "Intro call — Connor Turland", eventType: "default", hangoutLink: "https://meet.google.com/ffb-eimd-pea", start: { dateTime: "2026-08-25T16:30:00+02:00" }, end: { dateTime: "2026-08-25T17:00:00+02:00" } },
    ])).listEvents({ timeMin: "t1", timeMax: "t2", maxResults: 10 });
    expect(items[0]?.hasConferenceLink).toBe(true);
  });

  it("marks a conferenceData entry point as a conference link", async () => {
    const { items } = await wrapCalendarApi(apiReturning([
      { id: "e3", summary: "Weekly", start: { dateTime: "2026-08-25T09:00:00Z" }, end: { dateTime: "2026-08-25T09:30:00Z" }, conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }] } },
    ])).listEvents({ timeMin: "t1", timeMax: "t2", maxResults: 10 });
    expect(items[0]?.hasConferenceLink).toBe(true);
  });

  it("omits both fields when the API sends neither — an absent field never reads as false data", async () => {
    const { items } = await wrapCalendarApi(apiReturning([
      { id: "e4", summary: "Standup", start: { dateTime: "2026-08-25T09:00:00Z" }, end: { dateTime: "2026-08-25T09:30:00Z" } },
    ])).listEvents({ timeMin: "t1", timeMax: "t2", maxResults: 10 });
    expect(items[0]).toEqual({ id: "e4", summary: "Standup", start: "2026-08-25T09:00:00Z", end: "2026-08-25T09:30:00Z" });
  });
});

// ── the 2026-08-25 replay, end to end ───────────────────────────────────────────────────────

/** 08:00 Oslo on the morning the brief got it wrong. */
const THAT_MORNING = new Date("2026-08-25T06:00:00Z");

/** The three events that produced the two false claims, exactly as the API returned them. */
const THAT_DAY: CalendarEvent[] = [
  {
    id: "shuic7vnh9dddmt184aebdvbfo",
    summary: "Stay at Scandic Oslo Airport",
    start: "2026-08-25", end: "2026-08-27",
    allDay: true,
    eventType: "fromGmail",
    location: "Ravinevegen 15, 2060, Gardermoen",
    attendees: [{ email: "owner@owner.example" }],
  },
  {
    id: "fs19irbssj0voco75m0frfo7k4",
    summary: "Intro call — Connor Turland",
    start: "2026-08-25T14:30:00Z", end: "2026-08-25T15:00:00Z",
    eventType: "default",
    hasConferenceLink: true,
    attendees: [{ email: "connor@atcyrus.com" }],
  },
  {
    id: "_891k2dph84sjab9j74sk6b9k6l34cba28h1jgb9p84oj0ea26d2k6dpo6o",
    summary: "AI & Agenter - TBG Comm",
    start: "2026-08-25T15:00:00Z", end: "2026-08-25T16:50:00Z",
    eventType: "default",
    location: "FÆRD Kommunikasjon",
  },
];

const deps: CalendarSourceDeps = {
  listEvents: async () => THAT_DAY,
  myAddresses: async () => ["owner@owner.example"],
};

/** The prompt's calendar block — everything between its header and the next blank-line break. */
function sectionAfter(prompt: string, header: string): string {
  const start = prompt.indexOf(header);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = prompt.slice(start + header.length);
  const end = body.indexOf("\n\n");
  return end === -1 ? body : body.slice(0, end);
}

describe("ORB-165 regression — the morning of 2026-08-25", () => {
  it("classifies the three events without a model call", async () => {
    const meetings = await listTodayMeetings(deps, THAT_MORNING);
    expect(meetings.map((m) => [m.title, m.kind])).toEqual([
      ["Stay at Scandic Oslo Airport", "lodging"],
      ["Intro call — Connor Turland", "remote-call"],
      ["AI & Agenter - TBG Comm", "in-person"],
    ]);
  });

  it("the hotel is NOT a commitment row — no 'all day — Stay at …' for a brief to read as presence", async () => {
    const meetings = await listTodayMeetings(deps, THAT_MORNING);
    const content = buildMorningBrief({ meetings, obligations: [], deliveredLastNight: new Set(), picks: [] });
    const prompt = buildMorningPrompt(content!);

    const calendar = sectionAfter(prompt, "Today's calendar — meetings, and the blocks he set aside:");
    expect(calendar).not.toContain("Scandic");
    expect(calendar).not.toContain("Ravinevegen");
    expect(prompt).not.toContain("all day — Stay at Scandic Oslo Airport");
  });

  it("the hotel reaches the prompt as travel context, and says what travel context means", async () => {
    const meetings = await listTodayMeetings(deps, THAT_MORNING);
    const prompt = buildMorningPrompt(buildMorningBrief({ meetings, obligations: [], deliveredLastNight: new Set(), picks: [] })!);

    expect(prompt).toContain("## Travel context");
    const travel = sectionAfter(prompt, "## Travel context");
    expect(travel).toContain("Stay at Scandic Oslo Airport");
    expect(travel).toContain("lodging");
    // The one sentence the ticket asks for, in the prompt itself.
    expect(prompt.replace(/\s+/g, " ")).toContain("where he sleeps or moves, never where he is now");
  });

  it("the 16:30 call renders as remote and carries no venue", async () => {
    const meetings = await listTodayMeetings(deps, THAT_MORNING);
    const prompt = buildMorningPrompt(buildMorningBrief({ meetings, obligations: [], deliveredLastNight: new Set(), picks: [] })!);
    const calendar = sectionAfter(prompt, "Today's calendar — meetings, and the blocks he set aside:");

    // Fix round 1, Finding 2 — the SPAN, so "the 16:30 runs into the 17:00" is read, not invented.
    expect(calendar).toContain("16:30–17:00 — Intro call — Connor Turland (remote)");
    expect(calendar).toContain("17:00–18:50 — AI & Agenter - TBG Comm (FÆRD Kommunikasjon)");
    expect(prompt.replace(/\s+/g, " ")).toContain("marked (remote) has no venue");
  });

  it("the same three events render the same way in the evening brief — both briefs agree", async () => {
    // listTomorrowMeetings' day, not listTodayMeetings' — same events, the evening before.
    const evening = buildEveningBrief({
      meetings: await listTodayMeetings(deps, THAT_MORNING),
      obligations: [],
    });
    const prompt = buildEveningPrompt(evening!);
    const calendar = sectionAfter(prompt, "Tomorrow's calendar — meetings, and the blocks he set aside:");

    expect(calendar).not.toContain("Scandic");
    expect(calendar).toContain("(remote)");
    expect(prompt).toContain("## Travel context");
    expect(sectionAfter(prompt, "## Travel context")).toContain("Stay at Scandic Oslo Airport");
  });

  it("a day whose ONLY event is the hotel has no commitments at all", async () => {
    const only: CalendarSourceDeps = { ...deps, listEvents: async () => [THAT_DAY[0]!] };
    const meetings = await listTodayMeetings(only, THAT_MORNING);
    const prompt = buildMorningPrompt(buildMorningBrief({ meetings, obligations: [], deliveredLastNight: new Set(), picks: [] })!);

    expect(sectionAfter(prompt, "Today's calendar — meetings, and the blocks he set aside:").trim()).toBe("(none)");
    expect(sectionAfter(prompt, "## Travel context")).toContain("Stay at Scandic Oslo Airport");
  });

  it("an in-person meeting that also has a join link says so, and keeps its venue", async () => {
    // The 17:00 as it would look with Workspace's default Meet link attached to it.
    const hybrid: CalendarSourceDeps = {
      ...deps,
      listEvents: async () => [{ ...THAT_DAY[2]!, hasConferenceLink: true, attendees: [{ email: "post@faerd.no" }] }],
    };
    const meetings = await listTodayMeetings(hybrid, THAT_MORNING);
    expect(meetings[0]?.kind).toBe("in-person");

    const prompt = buildMorningPrompt(buildMorningBrief({ meetings, obligations: [], deliveredLastNight: new Set(), picks: [] })!);
    const calendar = sectionAfter(prompt, "Today's calendar — meetings, and the blocks he set aside:");
    expect(calendar).toContain("17:00–18:50 — AI & Agenter - TBG Comm (FÆRD Kommunikasjon) (in person; a join link also exists)");
    expect(calendar).not.toContain("(remote)");
    // …and the clause that would have contradicted it is not fired.
    expect(prompt).not.toContain("marked (remote) has no venue");
  });

  it("the Wednesday flight renders as transport context, with its span", async () => {
    // The real 26 Aug row, read the same day, on the morning it is actually today's.
    const flight: CalendarEvent = {
      id: "37ar4f2fjkpnt9bp01no4edkt8",
      summary: "Flight to København (SK 455)",
      start: "2026-08-26T07:00:00Z", end: "2026-08-26T08:10:00Z",
      eventType: "fromGmail",
      location: "Oslo OSL",
      attendees: [{ email: "owner@owner.example" }],
    };
    const wednesday: CalendarSourceDeps = { ...deps, listEvents: async () => [flight] };
    const meetings = await listTodayMeetings(wednesday, new Date("2026-08-26T06:00:00Z"));
    expect(meetings[0]?.kind).toBe("transport");

    const prompt = buildMorningPrompt(buildMorningBrief({ meetings, obligations: [], deliveredLastNight: new Set(), picks: [] })!);
    expect(sectionAfter(prompt, "Today's calendar — meetings, and the blocks he set aside:").trim()).toBe("(none)");
    expect(sectionAfter(prompt, "## Travel context"))
      .toContain("- Flight to København (SK 455) (Oslo OSL) [transport — where he moves; 09:00–10:10]");
  });

  it("a working-location marker is not labelled as an absence", async () => {
    const wl: CalendarSourceDeps = {
      ...deps,
      listEvents: async () => [{
        id: "wl", summary: "Home", start: "2026-08-25", end: "2026-08-26", allDay: true, eventType: "workingLocation",
      }],
    };
    const meetings = await listTodayMeetings(wl, THAT_MORNING);
    const prompt = buildMorningPrompt(buildMorningBrief({ meetings, obligations: [], deliveredLastNight: new Set(), picks: [] })!);
    const travel = sectionAfter(prompt, "## Travel context");
    expect(travel).toContain("working-location marker — not a commitment");
    expect(travel).toContain("an all-day entry, no clock time on it");
  });

  it("neither block is rendered when there is no travel context and no remote call", async () => {
    const inPersonOnly: CalendarSourceDeps = { ...deps, listEvents: async () => [THAT_DAY[2]!] };
    const meetings = await listTodayMeetings(inPersonOnly, THAT_MORNING);
    const prompt = buildMorningPrompt(buildMorningBrief({ meetings, obligations: [], deliveredLastNight: new Set(), picks: [] })!);

    expect(prompt).not.toContain("Travel context");
    expect(prompt).not.toContain("(remote)");
  });
});
