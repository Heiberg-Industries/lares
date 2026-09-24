// ORB-113 — Marcel offered to fill "de siste kveldene" with dinners for The Big Apple, when the
// flight home leaves EWR 17:20 on 30.8 and lands Oslo 14:20 on 31.8. There are no last evenings:
// 29.8 is the last dinner night, 30.8 is a departure day, 31.8 is a morning arrival. Every fact
// was in his own bookings file; he just had to count across two bookings, and models do not
// reliably count dates in prose. So the counting happens deterministically — and these pin it.
import { describe, it, expect } from "vitest";

import { bookingHeaders } from "../lib/booking-header.js";
import { daySkeletonMarkdown, deriveDaySkeleton, shortNo } from "../lib/day-skeleton.js";

/** The live Big Apple file, headers only — the exact shape that produced the miss. */
const BIG_APPLE = [
  "<!-- booking id:a kind:stay start:2026-08-25 end:2026-08-26 time:- provider:scandicosloairport -->",
  "- Standard room, Gardermoen",
  "<!-- /booking -->",
  "<!-- booking id:b kind:stay start:2026-08-26 end:2026-08-30 time:- provider:publichotelnewyork -->",
  "- QUEEN GREAT VIEW room",
  "<!-- /booking -->",
  "<!-- booking id:c kind:flight start:2026-08-26 end:2026-08-31 time:09:00 provider:sas -->",
  "- Utreise 26 Aug, hjemreise 30 Aug EWR 17:20 → Oslo 14:20 (+1dag)",
  "<!-- /booking -->",
  "<!-- booking id:d kind:restaurant start:2026-08-29 end:- time:20:00 provider:cosme -->",
  "- Middag",
  "<!-- /booking -->",
].join("\n");

const TRIP = { tripStart: "2026-08-25", tripEnd: "2026-08-31" };

describe("the live Big Apple case", () => {
  it("puts arrival, the full days, departure and the +1 home arrival on the right dates", () => {
    const s = deriveDaySkeleton({ ...TRIP, bookings: bookingHeaders(BIG_APPLE) });

    expect(s).toBeDefined();
    expect(s!.preNight).toBe("2026-08-25");
    expect(s!.arrival).toBe("2026-08-26");
    expect(s!.fullDays).toEqual(["2026-08-27", "2026-08-28", "2026-08-29"]);
    expect(s!.departure).toBe("2026-08-30");
    expect(s!.homeArrival).toBe("2026-08-31");
  });

  it("names 29.8 as the last dinner night — the sentence Marcel got wrong", () => {
    const md = daySkeletonMarkdown({ ...TRIP, bookings: bookingHeaders(BIG_APPLE) });

    expect(md).toContain("siste middagskveld: 29.8");
    expect(md).toContain("30.8: avreisedag");
    expect(md).toContain("ingen middagsbooking her");
    expect(md).toContain("31.8: hjemme");
  });

  it("picks the four-night stay as the trip, not the one-night airport hotel that comes first", () => {
    const s = deriveDaySkeleton({ ...TRIP, bookings: bookingHeaders(BIG_APPLE) });

    expect(s!.arrival).not.toBe("2026-08-25");
  });
});

describe("shapes that are not the Big Apple", () => {
  it("omits the home-arrival line when the flight lands on the departure day itself", () => {
    const md = daySkeletonMarkdown({
      tripStart: "2026-09-01",
      tripEnd: "2026-09-04",
      bookings: bookingHeaders(
        "<!-- booking id:a kind:stay start:2026-09-01 end:2026-09-04 time:- provider:hotel -->\n- x\n<!-- /booking -->\n" +
          "<!-- booking id:b kind:flight start:2026-09-01 end:2026-09-04 time:07:00 provider:sas -->\n- y\n<!-- /booking -->",
      ),
    });

    expect(md).toContain("4.9: avreisedag");
    expect(md).not.toContain("hjemme");
  });

  it("says 'hel dag' in the singular when there is exactly one, and names no dinner range", () => {
    const md = daySkeletonMarkdown({
      tripStart: "2026-09-01",
      tripEnd: "2026-09-03",
      bookings: bookingHeaders(
        "<!-- booking id:a kind:stay start:2026-09-01 end:2026-09-03 time:- provider:hotel -->\n- x\n<!-- /booking -->",
      ),
    });

    expect(md).toContain("2.9: hel dag");
  });

  it("omits the skeleton entirely when nothing is booked — a shape it cannot prove is not invented", () => {
    expect(daySkeletonMarkdown({ ...TRIP, bookings: [] })).toBe("");
  });

  it("omits it when the only bookings are dinners — a restaurant proves no arrival or departure", () => {
    const dinnersOnly =
      "<!-- booking id:d kind:restaurant start:2026-08-29 end:- time:20:00 provider:cosme -->\n- Middag\n<!-- /booking -->";

    expect(daySkeletonMarkdown({ ...TRIP, bookings: bookingHeaders(dinnersOnly) })).toBe("");
  });

  it("omits it for a same-day stay, which has no days to describe", () => {
    const sameDay =
      "<!-- booking id:a kind:stay start:2026-08-26 end:2026-08-26 time:- provider:hotel -->\n- x\n<!-- /booking -->";

    expect(daySkeletonMarkdown({ ...TRIP, bookings: bookingHeaders(sameDay) })).toBe("");
  });

  it("still parses a legacy block that has no provider field at all", () => {
    const legacy =
      "<!-- booking id:a kind:stay start:2026-08-26 end:2026-08-30 time:- -->\n- x\n<!-- /booking -->";
    const headers = bookingHeaders(legacy);

    expect(headers[0]!.provider).toBeUndefined();
    expect(deriveDaySkeleton({ ...TRIP, bookings: headers })!.departure).toBe("2026-08-30");
  });
});

describe("shortNo", () => {
  it("writes dates the way a Norwegian says them", () => {
    expect(shortNo("2026-08-05")).toBe("5.8");
    expect(shortNo("2026-12-31")).toBe("31.12");
  });
});
