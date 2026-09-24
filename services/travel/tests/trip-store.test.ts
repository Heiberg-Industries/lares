// Ported from services/marcel/tests/trips.test.ts (Task 5) — chatId/adminId cases adapted to
// eve-marcel's string-id convention (see lib/trip-store.ts's own doc comment).
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TripStore, type Trip } from "../lib/trip-store.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-"));
});

function baseTrip(overrides: Partial<Omit<Trip, "dir" | "chatId">> = {}): Omit<Trip, "dir" | "chatId"> {
  return {
    slug: "paris-2026",
    name: "Paris",
    start: "2026-07-21",
    end: "2026-07-28",
    timezone: "Europe/Paris",
    destination: { name: "Paris", lat: 48.8566, lon: 2.3522 },
    ...overrides,
  };
}

describe("TripStore.config", () => {
  it("throws a clear error when config.json is missing", () => {
    const store = new TripStore(root);
    expect(() => store.config()).toThrow(/config\.json/i);
  });
});

describe("TripStore.createTrip", () => {
  it("seeds the trip dir and five empty files, and persists to config.json", () => {
    const store = new TripStore(root);
    store.saveConfig({ adminId: "1", killSwitch: false, dailyTokenBudget: 1000, trips: [] });

    const trip = store.createTrip(baseTrip());

    expect(trip.dir).toBe(path.join(root, "trips", "paris-2026"));
    expect(fs.existsSync(trip.dir)).toBe(true);
    for (const file of ["trip.md", "itinerary.md", "bookings.md", "shopping.md", "learned.md"]) {
      const full = path.join(trip.dir, file);
      expect(fs.existsSync(full)).toBe(true);
      expect(fs.readFileSync(full, "utf8")).toBe("");
    }

    const cfg = store.config();
    expect(cfg.trips).toHaveLength(1);
    expect(cfg.trips[0].slug).toBe("paris-2026");
  });
});

describe("TripStore.linkChat / tripForChat", () => {
  it("persists a chatId onto the trip and tripForChat finds it", () => {
    const store = new TripStore(root);
    store.saveConfig({ adminId: "1", killSwitch: false, dailyTokenBudget: 1000, trips: [] });
    store.createTrip(baseTrip());

    store.linkChat("paris-2026", "42");

    const found = store.tripForChat("42");
    expect(found).toBeDefined();
    expect(found?.slug).toBe("paris-2026");
    expect(found?.chatId).toBe("42");

    // persisted — a fresh store reading the same root sees it too
    const store2 = new TripStore(root);
    expect(store2.tripForChat("42")?.slug).toBe("paris-2026");
  });

  it("tripForChat returns undefined when no trip matches", () => {
    const store = new TripStore(root);
    store.saveConfig({ adminId: "1", killSwitch: false, dailyTokenBudget: 1000, trips: [] });
    expect(store.tripForChat("999")).toBeUndefined();
  });
});

describe("TripStore.activeTrips", () => {
  it("includes a trip when today falls within its start/end window", () => {
    const store = new TripStore(root);
    store.saveConfig({ adminId: "1", killSwitch: false, dailyTokenBudget: 1000, trips: [] });
    store.createTrip(baseTrip({ start: "2026-07-21", end: "2026-07-28" }));

    const active = store.activeTrips("2026-07-22");
    expect(active.map((t) => t.slug)).toEqual(["paris-2026"]);
  });

  it("excludes a trip when today falls outside its start/end window", () => {
    const store = new TripStore(root);
    store.saveConfig({ adminId: "1", killSwitch: false, dailyTokenBudget: 1000, trips: [] });
    store.createTrip(baseTrip({ start: "2026-07-21", end: "2026-07-28" }));

    const active = store.activeTrips("2026-07-29");
    expect(active).toHaveLength(0);
  });
});

describe("TripStore.append / read", () => {
  it("round-trips content through append then read", () => {
    const store = new TripStore(root);
    store.saveConfig({ adminId: "1", killSwitch: false, dailyTokenBudget: 1000, trips: [] });
    const trip = store.createTrip(baseTrip());

    store.append(trip, "itinerary.md", "Day 1: arrive");
    store.append(trip, "itinerary.md", "Day 2: Louvre");

    expect(store.read(trip, "itinerary.md")).toBe("Day 1: arrive\nDay 2: Louvre\n");
  });

  it("read returns empty string for a missing file", () => {
    const store = new TripStore(root);
    store.saveConfig({ adminId: "1", killSwitch: false, dailyTokenBudget: 1000, trips: [] });
    const trip = store.createTrip(baseTrip());
    fs.rmSync(path.join(trip.dir, "bookings.md"));

    expect(store.read(trip, "bookings.md")).toBe("");
  });
});

describe("TripStore.tasteProfile", () => {
  // ORB-100 split the two things this used to return. What stays here is Marcel's OWN learned
  // taste (preferences.md, written by his dream/promote schedules). Bendik's SAVED places moved
  // to the fleet store at /srv/taste, read through lib/taste-store.ts and covered by
  // tests/taste.test.ts — TripStore no longer knows anything about them.
  it("returns empty when the agent has learned nothing yet", () => {
    expect(new TripStore(root).tasteProfile()).toBe("");
  });

  it("returns preferences.md, which the promote schedule appends to", () => {
    fs.mkdirSync(path.join(root, "taste"), { recursive: true });
    fs.writeFileSync(path.join(root, "taste", "preferences.md"), "Loves museums, hates crowds.");
    expect(new TripStore(root).tasteProfile()).toBe("Loves museums, hates crowds.");
  });

  it("does not read the retired Takeout CSV folder even if one is left on disk", () => {
    const listsDir = path.join(root, "taste", "google-maps-lists");
    fs.mkdirSync(listsDir, { recursive: true });
    fs.writeFileSync(path.join(listsDir, "Restaurants.csv"), "name,address\nLe Chat,1 Rue X");
    expect(new TripStore(root).tasteProfile()).toBe("");
  });
});

describe("TripStore reise-log", () => {
  it("returns empty string when no log exists", () => {
    const store = new TripStore(root);
    expect(store.reiseLog()).toBe("");
  });

  it("keeps lines sorted newest-first regardless of append order", () => {
    const store = new TripStore(root);
    store.appendReiseLog("- 2026-07-21 12:06 «Snart starter din leie med Avis» → allerede registrert");
    store.appendReiseLog("- 2026-07-19 09:00 «Gammel kvittering» → ikke en booking");
    store.appendReiseLog("- 2026-07-21 13:15 «Reservation reminder» → arkivert");
    const log = store.reiseLog();
    expect(log).toBe(
      "- 2026-07-21 13:15 «Reservation reminder» → arkivert\n" +
        "- 2026-07-21 12:06 «Snart starter din leie med Avis» → allerede registrert\n" +
        "- 2026-07-19 09:00 «Gammel kvittering» → ikke en booking\n"
    );
  });

  // A year-long sweep processes newest mail FIRST — append-order capping evicted today's
  // mails in favor of year-old ones (old Marcel live bug 2026-07-21). Cap must keep the newest
  // BY RECEIVED TIMESTAMP, not the last-appended. This is the round-2 fix this port must not
  // regress.
  it("caps at 40 lines keeping the newest by timestamp even when appended newest-first", () => {
    const store = new TripStore(root);
    for (let i = 45; i >= 1; i--) {
      const minute = String(i).padStart(2, "0");
      store.appendReiseLog(`- 2026-06-01 10:${minute} «mail ${i}» → arkivert`);
    }
    const lines = store.reiseLog().trim().split("\n");
    expect(lines).toHaveLength(40);
    expect(lines[0]).toContain("«mail 45»"); // newest kept
    expect(lines[39]).toContain("«mail 6»"); // oldest 5 evicted
  });
});
