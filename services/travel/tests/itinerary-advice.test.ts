// ORB-126 — weather-aware itinerary suggestions, and the honesty rules that bound them.
//
// What is tested here is the DETERMINISTIC half: which bookings reach the prompt, that their
// text reaches it unaltered, and that the rules ride along. The other half — whether the model
// then stays quiet on a fine day and speaks up on a wet one — is not a unit test's to make; it
// is the ticket's shape-before-shipping gate, run against real generated posts on the box.
import { describe, it, expect } from "vitest";

import { bookingBlocks } from "../lib/booking-header.js";
import {
  bookingsForDate,
  renderDayBookings,
  weatherAdviceInstruction,
  BOOKING_HONESTY_RULES,
} from "../lib/itinerary-advice.js";
import { composePrompt } from "../agent/schedules/trip-lifecycle.js";
import type { Trip } from "../lib/trip-store.js";

// The real file from /srv/eve-marcel/trips/the-big-apple/bookings.md, verbatim — including the
// exact policy sentences, which are the thing this ticket is about.
const OUTDOOR_WITH_POLICY =
  "<!-- booking id:19fd153c173592fe kind:restaurant start:2026-08-26 end:- time:20:00 at:40.73846,-73.98851 -->\n" +
  "- Outdoor Tavern Dining, table for 2 guests. Under name Bendik Heiberg. Cancellations at least 3 hours in advance; no-shows may incur $35 per person. Phone: (212) 477-0777\n" +
  "<!-- /booking -->\n";

const INDOOR_WITH_POLICY =
  "<!-- booking id:1a004ba6eab0b05e kind:restaurant start:2026-08-28 end:- time:20:00 at:40.72583,-73.99300 -->\n" +
  "- Reservation for 2 guests, inside seating. Reserved via Resy. 15 minute grace period. Cancellation fee $25/person if cancelled after Aug 27 at 8:00pm. Phone: +1 212-533-1932\n" +
  "<!-- /booking -->\n";

// A block whose text says NOTHING about changing or cancelling. This is the case the rules
// exist for: the model must say so rather than fill the silence.
const NO_POLICY =
  "<!-- booking id:19ccd80c14716be7 kind:flight start:2026-08-26 end:2026-08-31 time:09:00 -->\n" +
  "- SAS flight for passenger Bendik Heiberg. Outbound: SK455 Oslo Gardermoen-Copenhagen Kastrup 26AUG 09:00-10:10. Business class, 2PC baggage. Ticket 117-2543957008.\n" +
  "<!-- /booking -->\n";

// A five-night hotel: spans the whole trip, is not a plan, and must not turn up every day.
const MULTI_NIGHT_STAY =
  "<!-- booking id:19fcbf629643c74b kind:stay start:2026-08-26 end:2026-08-30 time:- -->\n" +
  "- QUEEN GREAT VIEW room. Total stay $1,754.12 (includes tax). All Access Fee $45/night.\n" +
  "<!-- /booking -->\n";

const ALL = OUTDOOR_WITH_POLICY + INDOOR_WITH_POLICY + NO_POLICY + MULTI_NIGHT_STAY;

const TRIP: Trip = {
  slug: "the-big-apple",
  name: "The Big Apple",
  start: "2026-08-25",
  end: "2026-08-31",
  timezone: "America/New_York",
  destination: { name: "New York, USA", lat: 40.7128, lon: -74.006 },
  chatId: "-5405035031",
  dir: "/nowhere",
};

describe("bookingBlocks — the body text bookingHeaders throws away", () => {
  it("returns each block's body exactly as filed, policy sentence included", () => {
    const blocks = bookingBlocks(OUTDOOR_WITH_POLICY);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.header.id).toBe("19fd153c173592fe");
    expect(blocks[0]!.header.lat).toBeCloseTo(40.73846, 5);
    expect(blocks[0]!.text).toBe(
      "- Outdoor Tavern Dining, table for 2 guests. Under name Bendik Heiberg. Cancellations at least 3 hours in advance; no-shows may incur $35 per person. Phone: (212) 477-0777",
    );
  });

  it("reads headers with and without the optional at: field", () => {
    expect(bookingBlocks(ALL).map((b) => b.header.id)).toEqual([
      "19fd153c173592fe",
      "1a004ba6eab0b05e",
      "19ccd80c14716be7",
      "19fcbf629643c74b",
    ]);
  });
});

describe("bookingsForDate", () => {
  it("picks the day's own plans", () => {
    expect(bookingsForDate(ALL, "2026-08-26").map((b) => b.header.id)).toEqual([
      "19fd153c173592fe",
      "19ccd80c14716be7",
      "19fcbf629643c74b",
    ]);
    expect(bookingsForDate(ALL, "2026-08-28").map((b) => b.header.id)).toEqual(["1a004ba6eab0b05e"]);
  });

  it("does not repeat a multi-night stay on every day it spans — a hotel is not a plan the weather can ruin", () => {
    expect(bookingsForDate(ALL, "2026-08-27").map((b) => b.header.id)).toEqual([]);
    expect(bookingsForDate(ALL, "2026-08-29")).toEqual([]);
  });

  it("returns nothing for a day with no bookings at all", () => {
    expect(bookingsForDate(ALL, "2026-08-31")).toEqual([]);
  });
});

describe("renderDayBookings — verbatim is the contract", () => {
  it("carries the cancellation terms through character for character", () => {
    const rendered = renderDayBookings(bookingsForDate(ALL, "2026-08-28"));
    expect(rendered).toContain("Cancellation fee $25/person if cancelled after Aug 27 at 8:00pm");
    expect(rendered).toContain("15 minute grace period");
  });

  it("carries the indoor/outdoor wording, which is how the model can tell them apart at all", () => {
    expect(renderDayBookings(bookingsForDate(ALL, "2026-08-26"))).toContain("Outdoor Tavern Dining");
    expect(renderDayBookings(bookingsForDate(ALL, "2026-08-28"))).toContain("inside seating");
  });

  it("marks a booking with no coordinates and one with no time honestly rather than omitting the fact", () => {
    const rendered = renderDayBookings(bookingsForDate(MULTI_NIGHT_STAY, "2026-08-26"));
    expect(rendered).toContain("uten klokkeslett");
    expect(rendered).toContain("uten koordinater");
  });

  it("invents no policy for a booking whose text carries none", () => {
    const rendered = renderDayBookings(bookingsForDate(NO_POLICY, "2026-08-26"));
    expect(rendered).toContain("SK455 Oslo Gardermoen-Copenhagen Kastrup");
    for (const word of ["cancel", "Cancel", "refund", "avbestill", "endres", "gratis"]) {
      expect(rendered).not.toContain(word);
    }
  });

  it("is empty for a day that holds nothing, so the caller can skip the section entirely", () => {
    expect(renderDayBookings([])).toBe("");
  });
});

describe("the honesty rules", () => {
  it("give the required answer for a silent confirmation, in the words that must be used", () => {
    expect(BOOKING_HONESTY_RULES).toContain("står ikke i bekreftelsen");
  });

  it("forbid an unsupported reassurance and forbid acting", () => {
    expect(BOOKING_HONESTY_RULES).toContain("Aldri påstå at noe er refunderbart");
    expect(BOOKING_HONESTY_RULES).toContain("Aldri endre eller avbestill en booking");
    expect(BOOKING_HONESTY_RULES).toContain("Bendik bestemmer");
  });

  it("ride along with every set of booking text handed to the model", () => {
    const instruction = weatherAdviceInstruction("2026-08-26", renderDayBookings(bookingsForDate(ALL, "2026-08-26")));
    expect(instruction).toContain(BOOKING_HONESTY_RULES);
    expect(instruction).toContain("Outdoor Tavern Dining");
  });

  it("tell the model to stay quiet when the weather threatens nothing", () => {
    const instruction = weatherAdviceInstruction("2026-08-26", "whatever");
    expect(instruction).toContain("ikke finn på et råd");
  });
});

// ORB-204 — the checkout post names the recorded check-out time when trip.md has one, so
// the reminder says when, not just "today".
describe("composePrompt — the checkout post", () => {
  it("names the recorded check-out time", () => {
    const prompt = composePrompt("checkout", TRIP, { checkoutDate: "2026-07-25", checkoutTime: "11:00" });
    expect(prompt).toContain("11:00");
  });

  it("says nothing about a time when none is recorded", () => {
    const prompt = composePrompt("checkout", TRIP, { checkoutDate: "2026-07-25" });
    expect(prompt).not.toMatch(/kl\./);
    expect(prompt).toContain("utsjekk");
  });
});

describe("composePrompt — the evening post", () => {
  it("carries tomorrow's bookings and the rules when tomorrow holds something", () => {
    const prompt = composePrompt("evening", TRIP, {
      tomorrow: "2026-08-26",
      tomorrowBookings: renderDayBookings(bookingsForDate(ALL, "2026-08-26")),
    });
    expect(prompt).toContain("Bookinger for 2026-08-26");
    expect(prompt).toContain("Outdoor Tavern Dining");
    expect(prompt).toContain("Cancellations at least 3 hours in advance");
    expect(prompt).toContain("står ikke i bekreftelsen");
  });

  it("says nothing about bookings at all when tomorrow holds none", () => {
    const prompt = composePrompt("evening", TRIP, {});
    expect(prompt).not.toContain("Bookinger for");
    expect(prompt).not.toContain("står ikke i bekreftelsen");
    // Still an ordinary evening post.
    expect(prompt).toContain("kveldspost");
  });

  it("keeps the sitat behaviour it already had", () => {
    const prompt = composePrompt("evening", TRIP, { sitat: "«god morgen!» — Kari" });
    expect(prompt).toContain("«god morgen!» — Kari");
  });

  it("puts the rules on the packing post too — it already talks about what is unconfirmed", () => {
    expect(composePrompt("packing", TRIP, { countdownDays: "3", arrival: "2026-08-26" })).toContain(
      "Aldri endre eller avbestill en booking",
    );
  });

  it("never instructs a change or a cancellation on any post kind", () => {
    const kinds = ["evening", "packing", "departure", "arrival", "finale", "checkout", "reminder", "weatherwarn"] as const;
    for (const kind of kinds) {
      const prompt = composePrompt(kind, TRIP, { tomorrow: "2026-08-26", tomorrowBookings: renderDayBookings(bookingsForDate(ALL, "2026-08-26")) });
      expect(prompt).not.toMatch(/\b(avbestill|endre) bookingen\b/i);
      expect(prompt).not.toMatch(/\bflytt bookingen\b/i);
    }
  });
});
