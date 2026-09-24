/**
 * ORB-168 + ORB-169, final review IMPORTANT 1 — the brief's OWN itinerary establishes where
 * tomorrow's journey starts.
 *
 * THE CONTRADICTION THIS FILE EXISTS TO PIN. `transitClause` was the one brief helper that never
 * learned about Marcel's itinerary: `travelContextBlock` and `eventKindClauses` both took it,
 * `transitClause` saw only the commitments and the CALENDAR travel rows. So on the evening pass
 * the prompt printed, verbatim, "the journey starts wherever he will be TOMORROW MORNING … and
 * nothing in this brief establishes it" — eleven lines below its own Travel context block naming
 * `Scandic Ørnen, Bergen … tomorrow night, the night of 2026-08-27, night 2 of 4`. And then
 * `ORIGIN_HONESTY` told the model that if it could not say where he would be it should say THAT
 * and look nothing up. On exactly the night ORB-168's evening lookup exists for — away from home,
 * a meeting in another town tomorrow — the prompt asserted its own new block did not exist and
 * talked the feature out of firing.
 *
 * THE RULING BEHIND THE FIX, because the distinction is subtle and is the whole of ORB-169: a
 * CALENDAR lodging row is not presence (ORB-165, unchanged — a reservation says a booking
 * exists), but Marcel's RESOLVED ITINERARY is the authoritative record of where Bendik is
 * actually sleeping. The travel concierge resolved it; that is precisely the knowledge Saga
 * lacked. So an itinerary lodging row covering the night before the briefed day IS evidence of
 * where the journey starts, and it is named.
 *
 * THE FIXTURE IS THE REVIEWER'S, unchanged: a stay 2026-08-26 → 2026-08-30 in Bergen, a meeting
 * in Tønsberg tomorrow, and NO calendar travel rows at all — which is the case the old gate could
 * never cover, because on nights 2..N of a stay there is no calendar event to gate on.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildEveningBrief,
  buildMorningBrief,
  itineraryOrigin,
  readBriefTravel,
  transitClause,
  type NightBeforeMeeting,
} from "../lib/brief-content.js";
import { buildEveningPrompt } from "../agent/schedules/evening-brief.js";
import { buildMorningPrompt } from "../agent/schedules/morning-brief.js";

// ── the reviewer's fixture ──────────────────────────────────────────────────────────────────

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

/** A `MARCEL_DATA_ROOT`-shaped tree holding one Bergen stay, in Marcel's own booking grammar. */
function bergenStay(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-saga-transit-origin-"));
  roots.push(root);
  fs.writeFileSync(
    path.join(root, "config.json"),
    JSON.stringify({
      adminId: "123456789",
      homeTimezone: "Europe/Oslo",
      trips: [
        {
          slug: "bergen",
          name: "Bergen",
          start: "2026-08-26",
          end: "2026-08-30",
          timezone: "Europe/Oslo",
          destination: { name: "Bergen, Norway", lat: 0, lon: 0 },
        },
      ],
    }),
  );
  const dir = path.join(root, "trips", "bergen");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "bookings.md"),
    [
      // Four nights: the 26th, 27th, 28th and 29th. Check-out is the 30th.
      "<!-- booking id:gmail-hotel-bg kind:stay start:2026-08-26 end:2026-08-30 " +
        "time:15:00 provider:scandic-ornen -->",
      "- Scandic Ørnen, Bergen",
      "<!-- /booking -->",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "trip.md"), "");
  fs.writeFileSync(path.join(dir, "itinerary.md"), "");
  return root;
}

/** Tomorrow's out-of-town commitment. In person, with a venue and a clock time, so it is a real
 *  `transitCandidate` — the lookup instruction only appears for one of these. */
const TONSBERG: NightBeforeMeeting = {
  title: "AI & Agenter - TBG Comm",
  startsAt: new Date("2026-08-27T15:00:00Z"),
  endsAt: new Date("2026-08-27T16:50:00Z"),
  location: "FÆRD Kommunikasjon, Tønsberg",
  participants: [],
  kind: "in-person",
};

/** The evening pass, composed the night of the 26th about the 27th. NO calendar travel rows. */
function eveningPrompt(root?: string): string {
  const content = buildEveningBrief({ meetings: [TONSBERG], obligations: [] })!;
  const travel =
    root === undefined ? undefined : readBriefTravel("2026-08-27", "tomorrow", { TRAVEL_PATH: root });
  return buildEveningPrompt(content, [], travel);
}

/** The morning pass, composed on the 27th about the 27th. */
function morningPrompt(root?: string): string {
  const content = buildMorningBrief({
    meetings: [TONSBERG],
    obligations: [],
    deliveredLastNight: new Set(),
    picks: [],
  })!;
  const travel =
    root === undefined ? undefined : readBriefTravel("2026-08-27", "today", { TRAVEL_PATH: root });
  return buildMorningPrompt(content, [], travel);
}

/** The prompt as sentences rather than as lines: every clause here is hard-wrapped, so asserting
 *  against the raw string would really be asserting where the wrap falls. */
function flat(prompt: string): string {
  return prompt.replace(/\s+/gu, " ");
}

// ── 1. the contradiction is gone ────────────────────────────────────────────────────────────

describe("the evening prompt, on a night Marcel's itinerary covers", () => {
  it("NAMES Bergen as the origin instead of claiming nothing establishes it", () => {
    const prompt = flat(eveningPrompt(bergenStay()));

    // The block that was already there, and the sentence that used to deny it.
    expect(prompt).toContain("Scandic Ørnen, Bergen");
    expect(prompt).not.toContain("nothing in this brief establishes it");

    // The origin, named, in the transit clause itself.
    expect(prompt).toContain(
      "This brief DOES establish where the journey starts: Marcel's itinerary has him sleeping " +
        "at Scandic Ørnen, Bergen, the night of 2026-08-26. That is where he sets off tomorrow " +
        "morning.",
    );
    expect(prompt).toContain("Use it as the `from` for the lookup");
  });

  it("does NOT send the model to ORIGIN_HONESTY's 'say you cannot say where he will be'", () => {
    const prompt = flat(eveningPrompt(bergenStay()));
    expect(prompt).not.toContain("If you cannot actually say where he will be");
    expect(prompt).not.toContain("look nothing up");
  });

  it("still says the journey is TOMORROW MORNING's, not tonight's", () => {
    const prompt = flat(eveningPrompt(bergenStay()));
    expect(prompt).toContain(
      "This pass is about TOMORROW, so the journey starts wherever he will be TOMORROW MORNING",
    );
  });

  it("keeps the anti-estimate ban, which is what the whole clause is for", () => {
    const prompt = flat(eveningPrompt(bergenStay()));
    expect(prompt).toContain("\"trains run roughly hourly\" or \"about 1h40\"");
  });
});

// ── 2. ORIGIN_HONESTY is narrowed, not weakened ─────────────────────────────────────────────

describe("with no itinerary lodging row for the night before", () => {
  it("fires ORIGIN_HONESTY verbatim when Saga has no travel wiring at all", () => {
    const prompt = flat(eveningPrompt());
    expect(prompt).toContain("If you cannot actually say where he will be, say THAT and look nothing up");
    expect(prompt).toContain("and nothing in this brief establishes it.");
    expect(prompt).not.toContain("This brief DOES establish where the journey starts");
  });

  it("fires ORIGIN_HONESTY when the itinerary exists but says nothing about that night", () => {
    // The morning of the 26th: the stay's first night is the 26th, so the night BEFORE is the
    // 25th and he was home. Nothing is established, and the clause must say so.
    const content = buildMorningBrief({
      meetings: [{ ...TONSBERG, startsAt: new Date("2026-08-26T15:00:00Z"), endsAt: new Date("2026-08-26T16:50:00Z") }],
      obligations: [],
      deliveredLastNight: new Set(),
      picks: [],
    })!;
    const travel = readBriefTravel("2026-08-26", "today", { TRAVEL_PATH: bergenStay() });
    const prompt = flat(buildMorningPrompt(content, [], travel));

    expect(prompt).toContain("If you cannot actually say where he will be, say THAT and look nothing up");
    expect(prompt).not.toContain("This brief DOES establish where the journey starts");
  });

  it("fires ORIGIN_HONESTY on check-out morning — a bed he has left is not an origin", () => {
    // The 30th is check-out day; the last night slept there was the 29th. The night before the
    // 30th IS the 29th, so this one is still established — the morning AFTER check-out is not.
    const root = bergenStay();
    expect(itineraryOrigin(readBriefTravel("2026-08-30", "today", { TRAVEL_PATH: root }))).toContain(
      "the night of 2026-08-29",
    );
    expect(itineraryOrigin(readBriefTravel("2026-08-31", "today", { TRAVEL_PATH: root }))).toBeUndefined();
  });

  it("establishes nothing when the store could not be read", () => {
    // An unreadable store yields `unavailable` and no trips — a source that dropped establishes
    // nothing, and the honesty clause is exactly right there.
    const travel = readBriefTravel("2026-08-27", "tomorrow", { TRAVEL_PATH: "/nonexistent/travel-root" });
    expect(itineraryOrigin(travel)).toBeUndefined();
  });
});

// ── 3. the two lodging sentences coexist ────────────────────────────────────────────────────

describe("the calendar ban and the itinerary origin, in one prompt", () => {
  const CALENDAR_HOTEL: NightBeforeMeeting = {
    title: "Stay at Scandic Ørnen",
    startsAt: new Date("2026-08-27T00:00:00Z"),
    allDay: true,
    location: "Lars Hilles gate 18, Bergen",
    participants: [],
    kind: "lodging",
  };

  it("bans the CALENDAR row as an origin while naming the ITINERARY row as one", () => {
    const travel = readBriefTravel("2026-08-27", "tomorrow", { TRAVEL_PATH: bergenStay() });
    const lines = transitClause([TONSBERG], [CALENDAR_HOTEL], "tomorrow", travel).join("\n");
    const sentences = lines.replace(/\s+/gu, " ");

    expect(sentences).toContain("This brief DOES establish where the journey starts");
    expect(sentences).toContain(
      "A lodging row from the CALENDAR is still not evidence of where he is, so never pass a " +
        "calendar lodging row as the journey's origin.",
    );
    expect(sentences).toContain(
      "The itinerary row named just above is the one exception, and it is not the same kind of " +
        "thing: Marcel resolved that one, while the calendar merely holds a booking.",
    );
    // Order is load-bearing: the positive statement first, so the ban reads as the exception it
    // is rather than as a retraction of the sentence above it.
    expect(lines.indexOf("This brief DOES establish")).toBeLessThan(
      lines.indexOf("A lodging row from the CALENDAR"),
    );
  });

  it("keeps ORB-165's ban unchanged when there is no itinerary at all", () => {
    const sentences = transitClause([TONSBERG], [CALENDAR_HOTEL], "tomorrow").join(" ").replace(/\s+/gu, " ");
    expect(sentences).toContain(
      "A lodging row from the CALENDAR is not evidence of where he is, so never pass a calendar " +
        "lodging row as the journey's origin.",
    );
    expect(sentences).not.toContain("the one exception");
  });
});

// ── 4. the morning pass gets the same treatment ─────────────────────────────────────────────

describe("the morning prompt", () => {
  it("names last night's bed as this morning's origin", () => {
    const prompt = flat(morningPrompt(bergenStay()));
    expect(prompt).toContain(
      "Marcel's itinerary has him sleeping at Scandic Ørnen, Bergen, the night of 2026-08-26. " +
        "That is where he sets off this morning.",
    );
  });
});

// ── 5. the WHOLE composed prompt does not contradict itself ─────────────────────────────────

/**
 * The same contradiction, twenty-five lines up the page.
 *
 * `eventKindClauses` emits "a hotel booking or a flight IN EITHER is not evidence of his
 * whereabouts, so never say he is based at, at, or in any of it" — and "in either" explicitly
 * includes Marcel's itinerary block. `ORIGIN_ESTABLISHED` then calls that same row the record of
 * where he is actually sleeping and tells the model to say so in plain words. Both fire together
 * on any away night, in both passes.
 *
 * What is at risk is the DECLARATION, not the lookup: "use it as the `from`" is an imperative and
 * survives either way, but the spoken origin is what a sentence above can suppress — and the
 * spoken origin is the whole mitigation for stating an origin confidently instead of hedging.
 */
describe("the full composed prompt, on the reviewer's fixture", () => {
  const SUPPRESSING = "a hotel booking or a flight in either is not evidence of his whereabouts";

  for (const [pass, render] of [
    ["evening", () => eveningPrompt(bergenStay())],
    ["morning", () => morningPrompt(bergenStay())],
  ] as const) {
    it(`${pass}: nothing in it forbids stating the itinerary-established origin`, () => {
      const prompt = flat(render());

      // The origin is established…
      expect(prompt).toContain("This brief DOES establish where the journey starts");
      expect(prompt).toContain("say in plain words that the journey starts there");
      // …and no sentence above it says a row in that block is never evidence of anything.
      expect(prompt).not.toContain(SUPPRESSING);
      expect(prompt).not.toContain("never say he is based at, at, or in any of it.");
    });

    it(`${pass}: keeps the calendar half and the flight half of ORB-165's rule`, () => {
      const prompt = flat(render());
      expect(prompt).toContain(
        "a flight in either, and any hotel row that came off the CALENDAR, are not evidence of " +
          "his whereabouts, so never say he is based at, at, or in any of them.",
      );
      expect(prompt).toContain(
        "The ONE exception is a lodging row MARCEL filed: he resolved that one, so it is the " +
          "record of which night he sleeps where. It is still not a claim about where he is right " +
          "now",
      );
    });
  }

  it("leaves ORB-165's sentence byte-identical when no itinerary row establishes an origin", () => {
    // A CALENDAR lodging row and no travel wiring: the block fires, and the sentence must be
    // exactly what it has always been. (With no travel rows of any kind the whole clause is
    // dropped, which is why this case needs a row to be a test of the wording at all.)
    const CALENDAR_HOTEL: NightBeforeMeeting = {
      title: "Stay at Scandic Ørnen",
      startsAt: new Date("2026-08-27T00:00:00Z"),
      allDay: true,
      location: "Lars Hilles gate 18, Bergen",
      participants: [],
      kind: "lodging",
    };
    const content = buildEveningBrief({ meetings: [TONSBERG, CALENDAR_HOTEL], obligations: [] })!;
    const prompt = flat(buildEveningPrompt(content, []));

    expect(prompt).toContain(SUPPRESSING);
    expect(prompt).toContain("so never say he is based at, at, or in any of it.");
    expect(prompt).not.toContain("The ONE exception is a lodging row MARCEL filed");
  });

  it("keeps the calendar row governed when BOTH sources are in the block", () => {
    // A calendar lodging row alongside the itinerary one: the calendar half of the rule must
    // still be there, and the carve-out must still name only Marcel's.
    const CALENDAR_HOTEL: NightBeforeMeeting = {
      title: "Stay at Scandic Ørnen",
      startsAt: new Date("2026-08-27T00:00:00Z"),
      allDay: true,
      location: "Lars Hilles gate 18, Bergen",
      participants: [],
      kind: "lodging",
    };
    const content = buildEveningBrief({ meetings: [TONSBERG, CALENDAR_HOTEL], obligations: [] })!;
    const travel = readBriefTravel("2026-08-27", "tomorrow", { TRAVEL_PATH: bergenStay() });
    const prompt = flat(buildEveningPrompt(content, [], travel));

    expect(prompt).toContain("any hotel row that came off the CALENDAR, are not evidence");
    expect(prompt).toContain("never pass a calendar lodging row as the journey's origin");
    expect(prompt).toContain("This brief DOES establish where the journey starts");
  });
});
