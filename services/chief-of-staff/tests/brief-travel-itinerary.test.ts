/**
 * ORB-169 Task 7 — the ONE "Travel context" block, now fed by Marcel's itinerary as well as
 * the calendar.
 *
 * The bug the ticket exists for, in one line: on 2026-08-25 the brief said Bendik was "based
 * at Scandic Oslo Airport all day". It was an all-day hotel RESERVATION whose check-in was
 * that evening, the night before a 09:00 Wednesday flight — and Marcel had already resolved
 * exactly that, in his own store, hours earlier. ORB-165 stopped the calendar row from being
 * read as presence; this is what finally lets the brief say what the night actually is.
 *
 * TWO THINGS THESE TESTS PIN THAT NOTHING ELSE CAN:
 *
 *  1. **A multi-day stay on night two.** A calendar event exists only on its check-in day, so
 *     before this task a three-night stay vanished from the brief on nights two and three.
 *     The itinerary knows the span; `night 2 of 3` is the assertion that says so.
 *  2. **An outage is not an empty week.** A store that could not be read renders as a DROPPED
 *     SOURCE inside the block (ORB-164's own vocabulary), never as "no travel".
 *
 * The booking blocks below are written in Marcel's own grammar (`bookingBlock()` in
 * `services/travel/lib/bookings.ts`, mirrored and pinned by `tests/travel-store.test.ts`).
 * The DATES in the regression fixture are the ticket's narrative — check-in the evening of the
 * 25th, out on the 26th, ahead of the 09:00 flight that same morning.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildEveningBrief,
  buildMorningBrief,
  readBriefTravel,
  travelContextBlock,
  TRAVEL_DROPPED_SOURCE_LINE,
  TRAVEL_DROPPED_SOURCE_ONLY_LINE,
  type NightBeforeMeeting,
} from "../lib/brief-content.js";
import { buildMorningPrompt } from "../agent/schedules/morning-brief.js";
import { buildEveningPrompt } from "../agent/schedules/evening-brief.js";

// ── the fixture ─────────────────────────────────────────────────────────────────────────────

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

interface FixtureTrip {
  slug: string;
  name: string;
  start: string;
  end: string;
  timezone?: string;
  destination?: string;
  bookings?: string;
}

/** One booking block in Marcel's grammar. `-` means "not recorded", exactly as he writes it. */
function booking(b: {
  id: string;
  kind: string;
  start: string;
  end?: string;
  time?: string;
  provider?: string;
  summary: string;
}): string {
  return [
    `<!-- booking id:${b.id} kind:${b.kind} start:${b.start} end:${b.end ?? "-"} ` +
      `time:${b.time ?? "-"} provider:${b.provider ?? "-"} -->`,
    `- ${b.summary}`,
    "<!-- /booking -->",
  ].join("\n");
}

/** A `MARCEL_DATA_ROOT`-shaped tree: `config.json` plus `trips/<slug>/bookings.md`. */
function fixture(trips: FixtureTrip[], opts: { config?: string } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-saga-brief-travel-"));
  roots.push(root);

  const config =
    opts.config ??
    JSON.stringify({
      adminId: "123456789",
      homeTimezone: "Europe/Oslo",
      trips: trips.map((t) => ({
        slug: t.slug,
        name: t.name,
        start: t.start,
        end: t.end,
        timezone: t.timezone ?? "Europe/Oslo",
        destination: { name: t.destination ?? "", lat: 0, lon: 0 },
      })),
    });
  fs.writeFileSync(path.join(root, "config.json"), config);

  for (const t of trips) {
    const dir = path.join(root, "trips", t.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "bookings.md"), t.bookings ?? "");
    fs.writeFileSync(path.join(dir, "trip.md"), "");
    fs.writeFileSync(path.join(dir, "itinerary.md"), "");
    // Family-private, and never readable — present so the allowlist is exercised here too.
    fs.writeFileSync(path.join(dir, "learned.md"), "- Barna orker ett museum per dag.\n");
  }
  return root;
}

function envFor(root: string): NodeJS.ProcessEnv {
  return { TRAVEL_PATH: root };
}

// ── the calendar half, as it really looked ──────────────────────────────────────────────────

/** The all-day Gmail row that produced "based there all day" (ORB-165's own literal). */
const CALENDAR_HOTEL: NightBeforeMeeting = {
  title: "Stay at Scandic Oslo Airport",
  startsAt: new Date("2026-08-25T00:00:00Z"),
  allDay: true,
  location: "Ravinevegen 15, 2060, Gardermoen",
  participants: [],
  kind: "lodging",
};

const CALENDAR_MEETING: NightBeforeMeeting = {
  title: "AI & Agenter - TBG Comm",
  startsAt: new Date("2026-08-25T15:00:00Z"),
  endsAt: new Date("2026-08-25T16:50:00Z"),
  location: "FÆRD Kommunikasjon",
  participants: [],
  kind: "in-person",
};

/**
 * The "## Travel context" section, to the next top-level prompt header.
 *
 * Not `indexOf("\n\n")` (the shape ORB-165's own helper uses): the block now holds a blank
 * line between its two sources on purpose, and a helper that stopped at the first one would
 * silently assert about the calendar half only.
 */
function travelBlockOf(prompt: string): string {
  const start = prompt.indexOf("## Travel context");
  expect(start).toBeGreaterThanOrEqual(0);
  const body = prompt.slice(start);
  const end = body.search(/\n(?:New or changed since|Owed a reply,)/u);
  return end === -1 ? body : body.slice(0, end);
}

function morningPromptFor(meetings: NightBeforeMeeting[], day: string, root?: string): string {
  const content = buildMorningBrief({
    meetings,
    obligations: [],
    deliveredLastNight: new Set(),
    picks: [{ title: "something in the Brain" } as never],
  })!;
  const travel = root === undefined ? undefined : readBriefTravel(day, "today", envFor(root));
  return buildMorningPrompt(content, [], travel);
}

// ── 1. the regression the ticket names ──────────────────────────────────────────────────────

describe("ORB-169 — the morning of 2026-08-25, with the Big Apple trip in Marcel's store", () => {
  function bigApple(): string {
    return fixture([
      {
        slug: "the-big-apple",
        name: "The Big Apple",
        // The trip itself starts on the 26th — the hotel is booked the night BEFORE it, which
        // is exactly why `DEFAULT_HORIZON_DAYS` is 7 and not 0.
        start: "2026-08-26",
        end: "2026-08-31",
        timezone: "America/New_York",
        destination: "New York, USA",
        bookings: [
          booking({
            id: "gmail-hotel-1",
            kind: "stay",
            start: "2026-08-25",
            end: "2026-08-26",
            time: "15:00",
            provider: "scandic-oslo-airport",
            summary: "Scandic Oslo Airport, 1 natt, innsjekk 15:00",
          }),
          booking({
            id: "gmail-flight-1",
            kind: "flight",
            start: "2026-08-26",
            time: "09:00",
            provider: "sas",
            summary: "SK4705 OSL → EWR 09:00, ref XY12ZZ",
          }),
        ].join("\n"),
      },
    ]);
  }

  it("says the hotel is TONIGHT, ahead of Wednesday's 09:00 flight — not 'all day'", () => {
    const prompt = morningPromptFor([CALENDAR_HOTEL, CALENDAR_MEETING], "2026-08-25", bigApple());
    const travel = travelBlockOf(prompt);

    // EXACT, not `toContain("tonight")` + `toContain("2026-08-25")`: those two are BOTH
    // satisfied by "upcoming, NOT tonight — checks in 2026-08-25", so the test carrying this
    // ticket's name would have survived the very off-by-one it exists to prevent.
    expect(travel).toContain(
      "- Scandic Oslo Airport, 1 natt, innsjekk 15:00 [from Marcel's itinerary — The Big Apple; " +
        "lodging — where he sleeps; tonight, the night of 2026-08-25; checks out 2026-08-26]",
    );
    // Wednesday's flight, the reason tonight is at an airport hotel at all.
    expect(travel).toContain(
      "- SK4705 OSL → EWR 09:00, ref XY12ZZ [from Marcel's itinerary — The Big Apple; " +
        "transport — where he moves (flight); upcoming, NOT today — 2026-08-26 09:00]",
    );

    // …and nothing anywhere says he is BASED there, or there all day.
    expect(prompt).not.toContain("all day — Stay at Scandic Oslo Airport");
    expect(travel).not.toMatch(/based/i);
  });

  it("attributes the itinerary rows to Marcel, and keeps the calendar row distinguishable", () => {
    const travel = travelBlockOf(morningPromptFor([CALENDAR_HOTEL], "2026-08-25", bigApple()));

    // The calendar row keeps ORB-165's exact shape.
    expect(travel).toContain(
      "- Stay at Scandic Oslo Airport (Ravinevegen 15, 2060, Gardermoen) " +
        "[lodging — where he sleeps; an all-day entry, no clock time on it]",
    );
    // Every itinerary row says where it came from, on the row itself.
    expect(travel).toContain("from Marcel's itinerary");
    expect(travel).toContain("The Big Apple");
  });

  it("ONE block, two sources — never a second travel section with its own rules", () => {
    const prompt = morningPromptFor([CALENDAR_HOTEL], "2026-08-25", bigApple());
    expect(prompt.match(/^## Travel context/gmu)?.length).toBe(1);
    // The grounding sentence governs the whole block, both sources.
    expect(prompt.replace(/\s+/gu, " ")).toContain("where he sleeps or moves, never where he is now");
  });

  it("fires the travel clause even when the CALENDAR half is empty", () => {
    // A day whose only travel is Marcel's: before this task the clause was gated on calendar
    // rows alone, so the block would have arrived with no rule attached to it.
    const prompt = morningPromptFor([CALENDAR_MEETING], "2026-08-25", bigApple());
    expect(prompt).toContain("## Travel context");
    expect(prompt.replace(/\s+/gu, " ")).toContain(
      "BOTH of them are where he sleeps or moves, never where he is now",
    );
  });

  it("the grounding rule governs the INJECTED ## Travel block too, and says which day wins", () => {
    // REVIEW IMPORTANT 3 — `agent/instructions/travel-context.ts` puts a second travel block in
    // every brief turn, anchored to TODAY even when the brief is about tomorrow. A rule written
    // as "the Travel context block …" left that one governed by nothing at all.
    const flat = morningPromptFor([CALENDAR_MEETING], "2026-08-25", bigApple()).replace(/\s+/gu, " ");
    expect(flat).toContain("a ## Travel block in your instructions when there is one");
    expect(flat).toContain(
      "The Travel context block in this brief is the one anchored to the day this brief covers.",
    );
  });

  it("says the calendar row and the itinerary row may be ONE reservation", () => {
    // REVIEW IMPORTANT 2 — the ticket's own day renders the Scandic twice, once per source.
    const flat = morningPromptFor([CALENDAR_HOTEL], "2026-08-25", bigApple()).replace(/\s+/gu, " ");
    expect(flat).toContain(
      "A row from the itinerary may be the same reservation as a calendar row in the same block " +
        "— the itinerary row is the one that knows which night. Report it once.",
    );
  });

  it("the evening pass says TOMORROW night, never tonight", () => {
    const content = buildEveningBrief({ meetings: [CALENDAR_MEETING], obligations: [] })!;
    const travel = readBriefTravel("2026-08-25", "tomorrow", envFor(bigApple()));
    const prompt = buildEveningPrompt(content, [], travel);

    expect(travelBlockOf(prompt)).toContain(
      "lodging — where he sleeps; tomorrow night, the night of 2026-08-25; checks out 2026-08-26",
    );
    expect(travelBlockOf(prompt)).not.toContain("tonight");
  });
});

// ── 2. the multi-day span — the fix deferred from Session A ──────────────────────────────────

describe("ORB-169 — a stay is present on EVERY night of it, not only on check-in day", () => {
  function threeNights(): string {
    return fixture([
      {
        slug: "bergen",
        name: "Bergen",
        start: "2026-08-20",
        end: "2026-08-23",
        destination: "Bergen, Norway",
        bookings: booking({
          id: "gmail-hotel-9",
          kind: "stay",
          start: "2026-08-20",
          end: "2026-08-23", // three nights: the 20th, the 21st and the 22nd
          time: "15:00",
          provider: "opus-xvi",
          summary: "Opus XVI, 3 netter, innsjekk 15:00",
        }),
      },
    ]);
  }

  it("NIGHT TWO: the stay is in the block, and says which night of how many", () => {
    const travel = travelBlockOf(morningPromptFor([CALENDAR_MEETING], "2026-08-21", threeNights()));
    expect(travel).toContain(
      "- Opus XVI, 3 netter, innsjekk 15:00 [from Marcel's itinerary — Bergen; " +
        "lodging — where he sleeps; tonight, the night of 2026-08-21, night 2 of 3; " +
        "checks out 2026-08-23]",
    );
  });

  it("night three counts up, and check-out day says he slept there LAST night", () => {
    expect(travelBlockOf(morningPromptFor([CALENDAR_MEETING], "2026-08-22", threeNights())))
      .toContain("tonight, the night of 2026-08-22, night 3 of 3");

    // Check-out morning: he slept there LAST night. Asserted in full, because a bare
    // `toContain("checks out")` is also true of every night of the stay.
    const checkout = travelBlockOf(morningPromptFor([CALENDAR_MEETING], "2026-08-23", threeNights()));
    expect(checkout).toContain(
      "he checks out today, 2026-08-23 — he slept there the night before, NOT tonight",
    );
    expect(checkout).not.toContain("tonight, the night of");
    expect(checkout).not.toContain("night 3 of 3");
  });

  it("a stay that has not started yet is marked upcoming, never as tonight", () => {
    const travel = travelBlockOf(morningPromptFor([CALENDAR_MEETING], "2026-08-19", threeNights()));
    // The row says "upcoming, NOT tonight" — the word appears only inside the negation, which
    // is the point: a bed he has not checked into yet must not read as tonight's.
    expect(travel).toContain("upcoming, NOT tonight");
    expect(travel).not.toMatch(/tonight, the night of/u);
    expect(travel).not.toContain("night 1 of 3");
  });
});

// ── 3. `other` — a filed reservation is not a departure ──────────────────────────────────────

describe("ORB-169 — the bucket Marcel's extractor has no category for", () => {
  it("renders the Vy train, says it is unclassified, and never presents it as a departure", () => {
    // Marcel's booking enum is flight|stay|car|restaurant|other — a Norwegian train can only
    // be filed as `other`. Dropping it here would reproduce the bug Task 5 fixed one layer up.
    const root = fixture([
      {
        slug: "bergen",
        name: "Bergen",
        start: "2026-08-30",
        end: "2026-09-02",
        destination: "Bergen, Norway",
        bookings: booking({
          id: "gmail-train-1",
          kind: "other",
          start: "2026-08-30",
          time: "08:00",
          provider: "vy",
          summary: "Vy 601 Oslo S → Bergen 08:00, plass 42",
        }),
      },
    ]);
    const travel = travelBlockOf(morningPromptFor([CALENDAR_MEETING], "2026-08-30", root));

    expect(travel).toContain("Vy 601 Oslo S → Bergen 08:00, plass 42");
    expect(travel).toContain("unclassified (other)");
    expect(travel).toMatch(/NOT a confirmed departure/u);
    // It must never wear the sentence a real leg wears.
    expect(travel).not.toContain("transport — where he moves");
  });
});

// ── 4. an outage is a dropped source, never "no travel" ──────────────────────────────────────

describe("ORB-169 — Marcel's store could not be read", () => {
  it("says the source dropped, inside the block, and never that he has no travel", () => {
    const root = fixture([], { config: "{ this is not json" });
    const prompt = morningPromptFor([CALENDAR_HOTEL], "2026-08-25", root);
    const travel = travelBlockOf(prompt);

    expect(travel).toContain(TRAVEL_DROPPED_SOURCE_LINE);
    expect(travel).not.toContain("from Marcel's itinerary — The Big Apple");
    // …and the brief is told to pass it on, the way ORB-164 does for Slack.
    expect(prompt.replace(/\s+/gu, " ")).toContain("Marcel's itinerary could not be read");
  });

  it("renders the block even with NO calendar travel at all — an outage is not silence", () => {
    // REVIEW MINOR 3 — the disclosure changes WORDS here, not meaning. With no calendar rows
    // and no itinerary rows there is nothing above the sentence, so the "the rows above are the
    // calendar's alone" phrasing pointed at rows that did not exist. The distinction it protects
    // matters more in this case rather than less: an empty travel block normally reads as "he is
    // going nowhere", and that reading is exactly what is false here.
    const root = fixture([], { config: "{ this is not json" });
    const prompt = morningPromptFor([CALENDAR_MEETING], "2026-08-25", root);
    expect(prompt).toContain("## Travel context");
    expect(travelBlockOf(prompt)).toContain(TRAVEL_DROPPED_SOURCE_ONLY_LINE);
    expect(travelBlockOf(prompt)).not.toContain("the rows above");
  });
});

// ── 5. absence, and the byte-stable default ──────────────────────────────────────────────────

describe("ORB-169 — nothing to say", () => {
  it("no trip and no calendar travel → the block is ABSENT, not an empty heading", () => {
    const root = fixture([
      { slug: "vinterferie", name: "Vinterferie", start: "2026-02-14", end: "2026-02-21" },
    ]);
    const prompt = morningPromptFor([CALENDAR_MEETING], "2026-08-25", root);
    expect(prompt).not.toContain("Travel context");
  });

  it("TRAVEL_PATH unset → no travel half at all, and the block is byte-identical to ORB-165's", () => {
    expect(readBriefTravel("2026-08-25", "today", {})).toBeUndefined();
    expect(travelContextBlock([CALENDAR_HOTEL], undefined)).toBe(travelContextBlock([CALENDAR_HOTEL]));
  });

  it("a trip in the window whose bookings are all in the past contributes nothing", () => {
    const root = fixture([
      {
        slug: "bergen",
        name: "Bergen",
        start: "2026-08-20",
        end: "2026-08-31",
        bookings: booking({
          id: "gmail-hotel-9",
          kind: "stay",
          start: "2026-08-20",
          end: "2026-08-23",
          summary: "Opus XVI, 3 netter",
        }),
      },
    ]);
    const prompt = morningPromptFor([CALENDAR_MEETING], "2026-08-28", root);
    expect(prompt).not.toContain("Travel context");
  });
});

// ── 6. the two review minors ────────────────────────────────────────────────────────────────

describe("ORB-169 — the shape of the rows", () => {
  it("REVIEW MINOR 5: rows are chronological, not in confirmation-mail arrival order", () => {
    // `bookings.md` is written as the confirmations arrive, so the file order below puts a stay
    // that starts next week ABOVE the bed he sleeps in tonight.
    const root = fixture([
      {
        slug: "the-big-apple",
        name: "The Big Apple",
        start: "2026-08-25",
        end: "2026-08-31",
        destination: "New York, USA",
        bookings: [
          booking({
            id: "gmail-hotel-2",
            kind: "stay",
            start: "2026-08-28",
            end: "2026-08-31",
            summary: "PUBLIC Hotel New York, 3 netter",
          }),
          booking({
            id: "gmail-hotel-1",
            kind: "stay",
            start: "2026-08-25",
            end: "2026-08-26",
            time: "15:00",
            summary: "Scandic Oslo Airport, 1 natt, innsjekk 15:00",
          }),
        ].join("\n"),
      },
    ]);
    const travel = travelBlockOf(morningPromptFor([CALENDAR_MEETING], "2026-08-25", root));
    expect(travel.indexOf("Scandic Oslo Airport")).toBeLessThan(travel.indexOf("PUBLIC Hotel"));
  });

  it("REVIEW MINOR 6: a stay filed with end === start never contradicts itself", () => {
    const root = fixture([
      {
        slug: "gardermoen",
        name: "Gardermoen",
        start: "2026-08-25",
        end: "2026-08-26",
        bookings: booking({
          id: "gmail-hotel-1",
          kind: "stay",
          start: "2026-08-25",
          end: "2026-08-25", // Marcel files some one-night rows this way
          time: "15:00",
          summary: "Scandic Oslo Airport, 1 natt",
        }),
      },
    ]);
    const travel = travelBlockOf(morningPromptFor([CALENDAR_MEETING], "2026-08-25", root));
    expect(travel).toContain("tonight, the night of 2026-08-25]");
    expect(travel).not.toContain("checks out 2026-08-25");
  });
});
