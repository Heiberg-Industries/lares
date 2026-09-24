// ORB-109 — a booked venue needs coordinates before it can be geofenced, and a WRONG coordinate
// is worse than none: it would put "du er 200 m unna" on the wrong building. So the taste store
// (free, exact, already Bendik's own pins) comes first, and the Places fallback accepts only an
// exact name match — the rule services/console/lib/geocode.ts learned the expensive way.
import { describe, it, expect } from "vitest";
import type { PlaceEntry } from "@lares/taste";

import { bookingHeaders } from "../lib/booking-header.js";
import { bookingBlock } from "../lib/bookings.js";
import { bookedVenueCandidates, composeProximityMessage, dedupeCandidates } from "../lib/geofence.js";
import { resolveVenueCoords } from "../lib/venue-coords.js";

const saved: PlaceEntry[] = [
  { type: "place", name: "Katz's Delicatessen", lat: 40.7223, lon: -73.9874, sourceList: "NYC" },
  { type: "place", name: "Uten koordinater", sourceList: "NYC" },
];

describe("resolveVenueCoords", () => {
  it("uses the taste store first — free, and already Bendik's own pin", async () => {
    const hit = await resolveVenueCoords("Katz's Delicatessen", {
      saved: () => saved,
      searchText: async () => {
        throw new Error("must not be called when the store already knows");
      },
    });

    expect(hit).toEqual({ lat: 40.7223, lon: -73.9874, source: "taste" });
  });

  it("falls back to Places only when the store has nothing, and accepts an EXACT name match", async () => {
    const hit = await resolveVenueCoords("Cosme", {
      saved: () => saved,
      searchText: async () => [{ name: "Cosme", lat: 40.7395, lon: -73.9884 }],
    });

    expect(hit).toEqual({ lat: 40.7395, lon: -73.9884, source: "places" });
  });

  it("ignores punctuation and case when comparing, but nothing else", async () => {
    const hit = await resolveVenueCoords("the golden swan", {
      saved: () => [],
      searchText: async () => [{ name: "The Golden Swan", lat: 40.7, lon: -74 }],
    });

    expect(hit?.source).toBe("places");
  });

  it("REFUSES a near miss — a wrong pin is worse than no pin", async () => {
    const hit = await resolveVenueCoords("Cosme", {
      saved: () => [],
      searchText: async () => [{ name: "Cosme Bakery & Cafe", lat: 1, lon: 2 }],
    });

    expect(hit).toBeUndefined();
  });

  it("returns nothing rather than failing when Places is down — a filing must not depend on it", async () => {
    const hit = await resolveVenueCoords("Cosme", {
      saved: () => [],
      searchText: async () => {
        throw new Error("places 503");
      },
    });

    expect(hit).toBeUndefined();
  });

  it("returns nothing for a saved place that has no coordinates, and for a blank venue", async () => {
    expect(await resolveVenueCoords("Uten koordinater", { saved: () => saved })).toBeUndefined();
    expect(await resolveVenueCoords("  ", { saved: () => saved })).toBeUndefined();
    expect(await resolveVenueCoords(undefined, { saved: () => saved })).toBeUndefined();
  });
});

describe("the block header carries the coordinates", () => {
  it("round-trips lat/lon through bookingBlock and bookingHeaders", () => {
    const block = bookingBlock("g1", "restaurant", "2026-08-29", undefined, "20:00", "Middag", "Cosme", {
      lat: 40.7395, lon: -73.9884,
    });

    expect(block).toContain("at:40.73950,-73.98840");
    const [h] = bookingHeaders(block);
    expect(h!.lat).toBeCloseTo(40.7395, 4);
    expect(h!.lon).toBeCloseTo(-73.9884, 4);
  });

  it("writes no coordinates when there are none, and such a block still parses", () => {
    const block = bookingBlock("g2", "restaurant", "2026-08-29", undefined, "20:00", "Middag", "Cosme");

    expect(block).not.toContain("at:");
    expect(bookingHeaders(block)[0]!.lat).toBeUndefined();
  });

  it("a legacy block from before this field still parses, with no coordinates", () => {
    const legacy = "<!-- booking id:old kind:stay start:2026-08-26 end:2026-08-30 time:- -->\n- x\n<!-- /booking -->";

    expect(bookingHeaders(legacy)[0]!.lat).toBeUndefined();
  });
});

describe("booked venues as geofence candidates", () => {
  const bookings = [
    bookingBlock("g1", "restaurant", "2026-08-29", undefined, "20:00", "Middag", "Cosme", { lat: 40.7395, lon: -73.9884 }),
    bookingBlock("g2", "stay", "2026-08-26", "2026-08-30", undefined, "Hotell", "PUBLIC Hotel"),
  ].join("\n");

  it("takes only the blocks that actually have coordinates", () => {
    const candidates = bookedVenueCandidates(bookingHeaders(bookings));

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.name).toBe("cosme");
    expect(candidates[0]!.booking).toEqual({ kind: "restaurant", startISO: "2026-08-29", startTime: "20:00" });
  });

  it("folds a place that is both saved and booked into one, keeping the booking", () => {
    const merged = dedupeCandidates([
      { name: "Cosme", lat: 40.7395, lon: -73.9884, sourceList: "NYC" },
      { name: "cosme", lat: 40.7395, lon: -73.9884, booking: { kind: "restaurant", startISO: "2026-08-29" } },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.booking).toBeDefined();
  });

  it("says which is which — a saved place and a reservation are different facts", () => {
    const msg = composeProximityMessage([
      { name: "Cosme", lat: 0, lon: 0, distanceM: 120, booking: { kind: "restaurant", startISO: "2026-08-29", startTime: "20:00" } },
      { name: "Katz's", lat: 0, lon: 0, distanceM: 200, sourceList: "NYC" },
    ]);

    expect(msg).toContain("du har booket her (2026-08-29 kl. 20:00)");
    expect(msg).toContain("lagret i «NYC»");
  });
});

// ── Backfilling blocks that were filed before coordinates existed ─────────────────────────
//
// Coordinates are captured at filing time, which does nothing for bookings already in the file
// — including every dinner of the NYC trip this feature was built for. Without this the
// geofence would have been correct and useless.
describe("backfillVenueCoords", () => {
  it("adds at: to a filed block with a resolvable venue, leaving the rest byte-identical", async () => {
    const { TripStore } = await import("../lib/trip-store.js");
    const { BookingPipeline } = await import("../lib/bookings.js");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-backfill-"));
    const store = new TripStore(root);
    store.saveConfig({ adminId: "1", killSwitch: false, dailyTokenBudget: 1_000_000, trips: [] });
    const trip = store.createTrip({
      slug: "nyc", name: "NYC", start: "2026-08-25", end: "2026-08-31",
      timezone: "America/New_York", destination: { name: "New York", lat: 40.7, lon: -74 },
    });
    store.write(trip, "bookings.md", [
      bookingBlock("g1", "restaurant", "2026-08-29", undefined, "20:00", "Middag på Cosme", "Cosme"),
      bookingBlock("g2", "restaurant", "2026-08-28", undefined, "20:00", "Middag et sted", "Ukjent Sted"),
    ].join("\n") + "\n");

    const pipeline = new BookingPipeline({
      extract: async () => null,
      store,
      tg: { send: async () => "1" },
      adminId: "1",
      now: () => 1_786_970_000,
      // The header keeps a normalized provider slug, so that is what the backfill passes when
      // there is no cached extraction to prefer.
      venueCoords: async (b) => (b.provider === "cosme" ? { lat: 40.7395, lon: -73.9884 } : undefined),
    });

    expect(await pipeline.backfillVenueCoords()).toBe(1);

    const after = store.read(trip, "bookings.md");
    expect(after).toContain("at:40.73950,-73.98840");
    expect(after).toContain("Middag på Cosme");
    // The unresolvable one is untouched, and simply retried next sweep.
    expect(after).toContain("provider:ukjentsted -->");

    // Idempotent: a second pass has nothing left to do for the resolved block.
    expect(await pipeline.backfillVenueCoords()).toBe(0);

    fs.rmSync(root, { recursive: true, force: true });
  });
});

// The trip this feature was built for was filed BEFORE `provider:` existed, so keying the
// backfill on the header's provider skipped every one of its blocks. The block id is the gmail
// message id, so the extraction cache is the source that can still answer for them.
describe("backfillVenueCoords on legacy blocks (no provider: in the header)", () => {
  it("resolves them from the cached extraction instead of skipping them", async () => {
    const { TripStore } = await import("../lib/trip-store.js");
    const { BookingPipeline } = await import("../lib/bookings.js");
    const { fileExtractionCache } = await import("../lib/extraction-cache.js");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-legacy-"));
    const store = new TripStore(root);
    store.saveConfig({ adminId: "1", killSwitch: false, dailyTokenBudget: 1_000_000, trips: [] });
    const trip = store.createTrip({
      slug: "nyc", name: "NYC", start: "2026-08-25", end: "2026-08-31",
      timezone: "America/New_York", destination: { name: "New York", lat: 40.7, lon: -74 },
    });
    // Exactly the shape on the box: no provider:, no at:.
    store.write(trip, "bookings.md",
      "<!-- booking id:19fd345d kind:restaurant start:2026-08-28 end:- time:20:00 -->\n- Middag\n<!-- /booking -->\n");

    const cache = fileExtractionCache(root);
    cache.put("19fd345d", {
      outcome: "filed",
      booking: { id: "19fd345d", kind: "restaurant", provider: "Cosme", startISO: "2026-08-28", details: "Middag" },
      subject: "Your reservation at Cosme is confirmed",
      extractedAt: "2026-08-17T11:00:00.000Z",
    });

    const seen: string[] = [];
    const pipeline = new BookingPipeline({
      extract: async () => null,
      store,
      tg: { send: async () => "1" },
      adminId: "1",
      now: () => 1_786_970_000,
      cache,
      venueCoords: async (b) => {
        seen.push(b.provider);
        return b.provider === "Cosme" ? { lat: 40.7395, lon: -73.9884 } : undefined;
      },
    });

    expect(await pipeline.backfillVenueCoords()).toBe(1);
    // The REAL name reached the resolver, not a slug — that is what makes a Places query usable.
    expect(seen).toEqual(["Cosme"]);
    expect(store.read(trip, "bookings.md")).toContain("at:40.73950,-73.98840");

    fs.rmSync(root, { recursive: true, force: true });
  });
});
