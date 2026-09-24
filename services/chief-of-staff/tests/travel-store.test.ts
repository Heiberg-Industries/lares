/**
 * ORB-169 — Saga's read-only window onto Marcel's trip store.
 *
 * The fixture tree below MIRRORS the real `/srv/eve-marcel` as inspected on 2026-08-25,
 * deliberately including the files Saga must never read (`learned.md`, `shopping.md`,
 * `persona-overlay.md`, `chatlog/`, `extractions.json`). A fixture holding only the three
 * allowlisted files would let a denylist — or no list at all — pass every test here.
 *
 * `itinerary.md` is EMPTY in the fixture because it is empty on the box and has been since
 * 2026-08-17. An empty allowlisted file is a normal read, never a failure.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NotePathEscapesStoreError } from "@lares/agent-kit/notes-store";

import {
  BOOKING_BLOCK_RE,
  DEFAULT_HORIZON_DAYS,
  LODGING_KINDS,
  READABLE_TRIP_FILES,
  TRANSPORT_KINDS,
  TravelFileNotAllowedError,
  TravelPathNotConfiguredError,
  currentTravel,
  currentTrips,
  loadTrips,
  readTripFile,
  travelRoot,
} from "../lib/travel-store.js";

// ---------------------------------------------------------------------------------------
// The fixture — Marcel's layout, as it actually is on the box.
// ---------------------------------------------------------------------------------------

/** The live trip, verbatim from the box's config.json (coordinates rounded). */
const BIG_APPLE = {
  slug: "the-big-apple",
  name: "The Big Apple",
  start: "2026-08-25",
  end: "2026-08-31",
  timezone: "America/New_York",
  destination: { name: "New York, USA", lat: 40.7128, lon: -74.006 },
};

/** A finished trip, so "which trip covers today" has something to reject. */
const ALPS = {
  slug: "vinterferie",
  name: "Vinterferie",
  start: "2026-02-14",
  end: "2026-02-21",
  timezone: "Europe/Zurich",
  destination: { name: "Zermatt, Switzerland", lat: 46.0207, lon: 7.7491 },
};

/** Written by `bookingBlock()` in services/travel/lib/bookings.ts — header fields in a
 *  fixed order, `-` for "not recorded", details on the first body line. */
const BOOKINGS_MD = [
  "<!-- booking id:gmail-hotel-1 kind:stay start:2026-08-24 end:2026-08-25 time:15:00 provider:scandic-oslo-airport -->",
  "- Scandic Oslo Airport, 1 natt, innsjekk 15:00",
  "- Scandic Oslo Airport, Ravineveien 15, Gardermoen",
  "<!-- /booking -->",
  "<!-- booking id:gmail-flight-1 kind:flight start:2026-08-26 end:- time:09:00 provider:sas -->",
  "- SK4705 OSL → EWR 09:00, ref XY12ZZ",
  "<!-- /booking -->",
  "<!-- booking id:gmail-hotel-2 kind:stay start:2026-08-26 end:2026-08-30 time:- provider:public-hotel -->",
  "- PUBLIC Hotel New York, 4 netter",
  "<!-- /booking -->",
  "<!-- booking id:gmail-dinner-1 kind:restaurant start:2026-08-27 end:- time:19:30 provider:balthazar -->",
  "- Balthazar, bord for 4 kl 19:30",
  "<!-- /booking -->",
  // A real train, filed the only way Marcel's classifier CAN file one today: his enum has no
  // `train`, so it lands in `other`. This block is the regression guard for a brief that says
  // "hotel in Bergen" and nothing about getting there.
  "<!-- booking id:gmail-train-1 kind:other start:2026-08-30 end:- time:08:00 provider:vy -->",
  "- Vy 601 Oslo S → Bergen 08:00, plass 42",
  "<!-- /booking -->",
].join("\n");

const TRIP_MD = "# The Big Apple\n\nSeks netter i New York med familien.\n";

/** Family-private. Saga must never reach these; they exist in the fixture so the allowlist
 *  is actually exercised rather than assumed. */
const LEARNED_MD = "- Barna orker ikke mer enn ett museum per dag.\n";
const SHOPPING_MD = "";
const PERSONA_OVERLAY_MD = "Snakk som en newyorker.\n";
const CHATLOG_MD = "Bendik: husk paraply\n";

const roots: string[] = [];

function buildFixture(opts: { config?: unknown } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-saga-travel-"));
  roots.push(root);

  const config = opts.config ?? {
    adminId: "123456789",
    killSwitch: false,
    dailyTokenBudget: 400_000,
    homeTimezone: "Europe/Oslo",
    trips: [ALPS, BIG_APPLE],
  };
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(config, null, 2));

  // Root-level files that are NOT trip files and must stay unreachable.
  fs.writeFileSync(path.join(root, "reise-log.md"), "- 2026-08-20 09:00 filed hotel\n");
  fs.writeFileSync(path.join(root, "budget.json"), JSON.stringify({ spent: 0 }));
  fs.writeFileSync(path.join(root, "extractions.json"), JSON.stringify({ "gmail-hotel-1": "filed" }));

  const dir = path.join(root, "trips", BIG_APPLE.slug);
  fs.mkdirSync(path.join(dir, "chatlog"), { recursive: true });
  fs.writeFileSync(path.join(dir, "trip.md"), TRIP_MD);
  fs.writeFileSync(path.join(dir, "itinerary.md"), ""); // EMPTY on the box, and that is normal
  fs.writeFileSync(path.join(dir, "bookings.md"), BOOKINGS_MD);
  fs.writeFileSync(path.join(dir, "shopping.md"), SHOPPING_MD);
  fs.writeFileSync(path.join(dir, "learned.md"), LEARNED_MD);
  fs.writeFileSync(path.join(dir, "persona-overlay.md"), PERSONA_OVERLAY_MD);
  fs.writeFileSync(path.join(dir, "chatlog", "2026-08-24.md"), CHATLOG_MD);
  fs.writeFileSync(path.join(dir, "sent.json"), "[]");

  const old = path.join(root, "trips", ALPS.slug);
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, "trip.md"), "# Vinterferie\n");
  fs.writeFileSync(path.join(old, "itinerary.md"), "");
  fs.writeFileSync(path.join(old, "bookings.md"), "");

  return root;
}

const env = (root: string | undefined): NodeJS.ProcessEnv =>
  root === undefined ? {} : { TRAVEL_PATH: root };

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------

describe("travel-store — configuration", () => {
  it("throws the typed not-configured error when TRAVEL_PATH is unset", () => {
    expect(() => travelRoot({})).toThrow(TravelPathNotConfiguredError);
    expect(() => travelRoot({ TRAVEL_PATH: "   " })).toThrow(TravelPathNotConfiguredError);
    expect(() => currentTrips("2026-08-25", { env: {} })).toThrow(TravelPathNotConfiguredError);
  });

  it("distinguishes 'not configured' from 'configured but holding no trip'", () => {
    const root = buildFixture({ config: { adminId: "1", killSwitch: false, dailyTokenBudget: 1, trips: [] } });
    expect(loadTrips(env(root))).toEqual({ trips: [] });
    expect(currentTrips("2026-08-25", { env: env(root) })).toEqual({ trips: [] });
  });
});

describe("travel-store — which trip covers today", () => {
  it("returns nothing, and does not throw, on a day with no trip", () => {
    const root = buildFixture();
    expect(currentTrips("2026-09-15", { env: env(root) })).toEqual({ trips: [] });
    expect(currentTravel("2026-09-15", { env: env(root) })).toEqual({ trips: [] });
  });

  it("returns the trip covering today with its dates and destination", () => {
    const root = buildFixture();
    const { trips } = currentTrips("2026-08-27", { env: env(root) });
    expect(trips).toEqual([
      {
        slug: "the-big-apple",
        name: "The Big Apple",
        start: "2026-08-25",
        end: "2026-08-31",
        timezone: "America/New_York",
        destination: "New York, USA",
      },
    ]);
  });

  it("treats both ends of the range as inclusive", () => {
    const root = buildFixture();
    const slugs = (today: string) =>
      currentTrips(today, { horizonDays: 0, env: env(root) }).trips.map((t) => t.slug);
    expect(slugs("2026-08-25")).toEqual(["the-big-apple"]);
    expect(slugs("2026-08-31")).toEqual(["the-big-apple"]);
    expect(slugs("2026-09-01")).toEqual([]);
  });

  it("reaches forward by the requested horizon, and no further", () => {
    const root = buildFixture();
    const slugs = (opts: { horizonDays?: number }) =>
      currentTrips("2026-08-20", { ...opts, env: env(root) }).trips.map((t) => t.slug);
    expect(slugs({ horizonDays: 7 })).toEqual(["the-big-apple"]);
    expect(slugs({ horizonDays: 3 })).toEqual([]);
    expect(slugs({ horizonDays: 0 })).toEqual([]);
  });

  it("DEFAULTS to a week ahead — the night-before hotel is the whole point of the ticket", () => {
    // The regression this pins: on 2026-08-24, the Scandic Oslo Airport stay belongs to a trip
    // that has not started. A today-only default hides it, the brief says nothing about
    // tonight's hotel, and ORB-169 reopens with a green suite. `horizonDays: 0` must be the
    // choice a caller makes deliberately, never the one they get by omission.
    const root = buildFixture();
    expect(DEFAULT_HORIZON_DAYS).toBe(7);
    expect(currentTrips("2026-08-24", { env: env(root) }).trips.map((t) => t.slug)).toEqual([
      "the-big-apple",
    ]);
    expect(currentTravel("2026-08-24", { env: env(root) }).trips).toHaveLength(1);
    // ...and the hotel he actually sleeps in that night is IN the answer.
    expect(JSON.stringify(currentTravel("2026-08-24", { env: env(root) }))).toContain(
      "Scandic Oslo Airport",
    );
  });

  it("never loses `unavailable` through the convenient-looking function", () => {
    // A caller destructuring `.trips` off a broken store would otherwise render an outage as
    // "no travel" — the one shape this whole module is written to prevent.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const root = buildFixture();
    fs.rmSync(path.join(root, "config.json"));
    expect(currentTrips("2026-08-25", { env: env(root) }).unavailable).toBeTruthy();
  });
});

describe("travel-store — lodging and legs", () => {
  it("splits the trip's bookings into lodging and transport", () => {
    const root = buildFixture();
    const { trips } = currentTravel("2026-08-25", { env: env(root) });
    expect(trips).toHaveLength(1);
    const [today] = trips;

    expect(today!.trip.slug).toBe("the-big-apple");
    expect(today!.lodging).toEqual([
      {
        kind: "stay",
        start: "2026-08-24",
        end: "2026-08-25",
        time: "15:00",
        provider: "scandic-oslo-airport",
        summary: "Scandic Oslo Airport, 1 natt, innsjekk 15:00",
      },
      {
        kind: "stay",
        start: "2026-08-26",
        end: "2026-08-30",
        provider: "public-hotel",
        summary: "PUBLIC Hotel New York, 4 netter",
      },
    ]);
    expect(today!.transport).toEqual([
      {
        kind: "flight",
        start: "2026-08-26",
        time: "09:00",
        provider: "sas",
        summary: "SK4705 OSL → EWR 09:00, ref XY12ZZ",
      },
    ]);
  });

  it("keeps a dinner out of lodging and transport, but does not throw it away", () => {
    const root = buildFixture();
    const { trips } = currentTravel("2026-08-25", { env: env(root) });
    expect(JSON.stringify([trips[0]!.lodging, trips[0]!.transport])).not.toContain("Balthazar");
    expect(trips[0]!.other.map((b) => b.provider)).toContain("balthazar");
  });

  it("SURFACES a train Marcel could only file as `other` — it is not a leg, but it is not lost", () => {
    // The failure this pins: Marcel files "Vy 601 Oslo S → Bergen 08:00" as kind:other, because
    // his extractor enum has no train. If this reader dropped it, travel_current would return a
    // Bergen hotel with `transport: []` and the brief would report a bed and no movement — the
    // same "based there all day" shape ORB-169 exists to kill, for rail instead of hotels.
    const root = buildFixture();
    const { trips } = currentTravel("2026-08-25", { env: env(root) });
    const train = trips[0]!.other.find((b) => b.provider === "vy");
    expect(train).toBeDefined();
    expect(train!.summary).toContain("Vy 601 Oslo S → Bergen 08:00");
    expect(train!.time).toBe("08:00");
    // It must NOT be promoted to a confirmed leg — the caller has to say what it actually is.
    expect(trips[0]!.transport.map((b) => b.provider)).not.toContain("vy");
  });

  it("puts every booking in exactly one bucket — nothing is dropped and nothing is counted twice", () => {
    const root = buildFixture();
    const [today] = currentTravel("2026-08-25", { env: env(root) }).trips;
    const all = [...today!.lodging, ...today!.transport, ...today!.other];
    expect(all).toHaveLength(5); // every block in the fixture's bookings.md
    expect(new Set(all.map((b) => b.summary)).size).toBe(5);
  });

  it("carries the trip's own notes, and an EMPTY itinerary.md is not a failure", () => {
    const root = buildFixture();
    const { trips } = currentTravel("2026-08-25", { env: env(root) });
    expect(trips[0]!.notes).toContain("Seks netter i New York");
    expect(trips[0]!.itinerary).toBe("");
  });

  it("reads nothing family-private into the trip view, including the `other` bucket", () => {
    const root = buildFixture();
    const rendered = JSON.stringify(currentTravel("2026-08-25", { env: env(root) }));
    expect(rendered).not.toContain("museum");
    expect(rendered).not.toContain("newyorker");
    expect(rendered).not.toContain("paraply");
  });
});

describe("travel-store — the allowlist", () => {
  it("reads each of the three allowlisted files", () => {
    const root = buildFixture();
    expect(READABLE_TRIP_FILES).toEqual(["trip.md", "itinerary.md", "bookings.md"]);
    for (const file of READABLE_TRIP_FILES) {
      expect(() => readTripFile("the-big-apple", file, env(root))).not.toThrow();
    }
    expect(readTripFile("the-big-apple", "trip.md", env(root)).content).toContain("Seks netter");
    expect(readTripFile("the-big-apple", "itinerary.md", env(root)).content).toBe("");
  });

  it("refuses learned.md, shopping.md and persona-overlay.md", () => {
    const root = buildFixture();
    for (const file of ["learned.md", "shopping.md", "persona-overlay.md", "sent.json"]) {
      expect(() => readTripFile("the-big-apple", file, env(root))).toThrow(TravelFileNotAllowedError);
    }
  });

  it("refuses the chat log, whatever shape the request takes", () => {
    const root = buildFixture();
    expect(() => readTripFile("the-big-apple", "chatlog/2026-08-24.md", env(root))).toThrow(
      TravelFileNotAllowedError,
    );
    expect(() => readTripFile("the-big-apple/chatlog", "trip.md", env(root))).toThrow(Error);
  });

  it("refuses a traversal in the file name and in the slug", () => {
    const root = buildFixture();
    expect(() => readTripFile("the-big-apple", "../../reise-log.md", env(root))).toThrow(
      TravelFileNotAllowedError,
    );
    expect(() => readTripFile("the-big-apple", "/etc/passwd", env(root))).toThrow(TravelFileNotAllowedError);
    expect(() => readTripFile("../../..", "trip.md", env(root))).toThrow(NotePathEscapesStoreError);
    expect(() => readTripFile("../..", "trip.md", env(root))).toThrow(NotePathEscapesStoreError);
  });

  it("reports an unknown trip as unknown, not as a refusal", () => {
    const root = buildFixture();
    expect(() => readTripFile("no-such-trip", "trip.md", env(root))).toThrow(/no-such-trip/u);
    expect(() => readTripFile("no-such-trip", "trip.md", env(root))).not.toThrow(TravelFileNotAllowedError);
  });

  it("throws the typed not-configured error rather than reading a relative path", () => {
    expect(() => readTripFile("the-big-apple", "trip.md", {})).toThrow(TravelPathNotConfiguredError);
  });

  it("refuses an ALLOWLISTED NAME that is a symlink to a private file", () => {
    // The one thing the name check and the containment check are both blind to: the name is
    // allowed and the target is inside the store, so only the resolved BASENAME catches it.
    // Nothing Marcel runs plants symlinks — this is the privacy boundary holding against a
    // store whose contents we do not control.
    const root = buildFixture();
    const dir = path.join(root, "trips", BIG_APPLE.slug);
    fs.rmSync(path.join(dir, "itinerary.md"));
    fs.symlinkSync(path.join(dir, "learned.md"), path.join(dir, "itinerary.md"));

    expect(() => readTripFile("the-big-apple", "itinerary.md", env(root))).toThrow(
      TravelFileNotAllowedError,
    );
    // And the structured view refuses it too, without taking the turn down with it.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { trips } = currentTravel("2026-08-25", { env: env(root) });
    expect(JSON.stringify(trips)).not.toContain("museum");
  });

  it("refuses a trip DIRECTORY symlinked out of the store — the kit's check, unmodified", () => {
    // The other half of the symlink story, and the kit's job rather than the allowlist's:
    // `resolveInStore` follows links before comparing, so a trip directory pointing at another
    // volume is outside the store and is refused. Pinned because it is the fail-closed
    // direction — if this ever starts passing, the containment primitive has been weakened.
    const root = buildFixture();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "eve-saga-travel-vol-"));
    roots.push(elsewhere);
    fs.mkdirSync(path.join(elsewhere, "the-big-apple"));
    fs.writeFileSync(path.join(elsewhere, "the-big-apple", "trip.md"), "# flyttet\n");
    fs.rmSync(path.join(root, "trips", BIG_APPLE.slug), { recursive: true });
    fs.symlinkSync(path.join(elsewhere, "the-big-apple"), path.join(root, "trips", BIG_APPLE.slug));

    expect(() => readTripFile("the-big-apple", "trip.md", env(root))).toThrow(NotePathEscapesStoreError);
    // ...and the structured view degrades to an empty trip instead of taking the turn down.
    let view: ReturnType<typeof currentTravel> | undefined;
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => (view = currentTravel("2026-08-25", { env: env(root) }))).not.toThrow();
    expect(view!.trips[0]!.notes).toBe("");
    expect(view!.trips[0]!.lodging).toEqual([]);
  });
});

describe("travel-store — degrading instead of throwing into a turn", () => {
  it("yields no trip and logs when config.json is missing", () => {
    const root = buildFixture();
    fs.rmSync(path.join(root, "config.json"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = loadTrips(env(root));
    expect(result.trips).toEqual([]);
    expect(result.unavailable).toBeTruthy();
    expect(currentTrips("2026-08-25", { env: env(root) }).trips).toEqual([]);
    expect(logged).toHaveBeenCalled();
  });

  it("yields no trip and logs when config.json has drifted out of shape", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const config of [
      { adminId: "1", killSwitch: false, dailyTokenBudget: 1 }, // no `trips` at all
      { trips: "the-big-apple" }, // `trips` is no longer a list
      { trips: [{ slug: "x" }] }, // a trip with no dates
      { trips: [{ slug: "x", name: "X", start: "yesterday", end: "tomorrow" }] }, // not ISO dates
    ]) {
      const root = buildFixture({ config });
      expect(() => currentTrips("2026-08-25", { env: env(root) })).not.toThrow();
      expect(currentTrips("2026-08-25", { env: env(root) }).trips).toEqual([]);
    }
    expect(logged).toHaveBeenCalled();
  });

  it("yields no trip and logs when config.json is not JSON at all", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = buildFixture();
    fs.writeFileSync(path.join(root, "config.json"), "{ not json");

    expect(currentTravel("2026-08-25", { env: env(root) }).trips).toEqual([]);
    expect(currentTravel("2026-08-25", { env: env(root) }).unavailable).toBeTruthy();
    expect(logged).toHaveBeenCalled();
  });

  it("keeps the trips it can parse when one entry has drifted", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = buildFixture({ config: { trips: [{ slug: "broken" }, BIG_APPLE] } });
    expect(currentTrips("2026-08-25", { env: env(root) }).trips.map((t) => t.slug)).toEqual([
      "the-big-apple",
    ]);
    expect(logged).toHaveBeenCalled();
  });

  it("yields an empty trip view, not a throw, when the trip's directory is gone", () => {
    const root = buildFixture();
    fs.rmSync(path.join(root, "trips", BIG_APPLE.slug), { recursive: true });
    const { trips } = currentTravel("2026-08-25", { env: env(root) });
    expect(trips).toHaveLength(1);
    expect(trips[0]!.lodging).toEqual([]);
    expect(trips[0]!.transport).toEqual([]);
    expect(trips[0]!.notes).toBe("");
  });
});

describe("travel-store — the drift alarm against Marcel's own schema", () => {
  // Ruling 5. This reader mirrors `services/travel/lib/trip-store.ts` and deliberately
  // does NOT import it (separate service, separate build), so nothing but this test would
  // notice the day Marcel renames a field. It reads his source as TEXT for the same reason.
  const source = fs.readFileSync(
    path.join(import.meta.dirname, "..", "..", "travel", "lib", "trip-store.ts"),
    "utf8",
  );

  const fieldsOf = (name: string): { required: string[]; all: string[] } => {
    const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`, "u").exec(source)?.[1];
    expect(body, `interface ${name} not found in trip-store.ts`).toBeDefined();
    const all: string[] = [];
    const required: string[] = [];
    for (const line of body!.split("\n")) {
      const m = /^\s{2}(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)(\??):/u.exec(line);
      if (!m) continue;
      all.push(m[1]!);
      if (m[2] !== "?") required.push(m[1]!);
    }
    expect(all.length).toBeGreaterThan(0);
    return { required, all };
  };

  it("writes every field Marcel's `Trip` requires, and invents none", () => {
    const { required, all } = fieldsOf("Trip");
    // `dir` is derived by Marcel at read time (`trips/<slug>`), never stored in config.json.
    const stored = all.filter((f) => f !== "dir");
    expect(required.filter((f) => f !== "dir").every((f) => f in BIG_APPLE)).toBe(true);
    expect(Object.keys(BIG_APPLE).every((k) => stored.includes(k))).toBe(true);
  });

  it("writes every field Marcel's `MarcelConfig` requires", () => {
    const { required } = fieldsOf("MarcelConfig");
    const config = JSON.parse(
      fs.readFileSync(path.join(buildFixture(), "config.json"), "utf8"),
    ) as Record<string, unknown>;
    for (const field of required) expect(config).toHaveProperty(field);
  });

  it("keeps the excluded trip files excluded — a rename there must go red here", () => {
    // TRIP_FILES is Marcel's full set; the allowlist is the subset Saga may read. If a name
    // on either side changes, this stops matching and the allowlist gets re-decided by a
    // human rather than silently widening or silently reading nothing.
    const tripFiles = /const TRIP_FILES = \[([\s\S]*?)\] as const;/u
      .exec(source)?.[1]
      ?.match(/"([^"]+)"/gu)
      ?.map((s) => s.replaceAll('"', ""));
    expect(tripFiles).toEqual([
      "trip.md",
      "itinerary.md",
      "bookings.md",
      "shopping.md",
      "learned.md",
      "persona-overlay.md",
    ]);
    for (const allowed of READABLE_TRIP_FILES) expect(tripFiles).toContain(allowed);
    for (const excluded of ["shopping.md", "learned.md", "persona-overlay.md"]) {
      expect(READABLE_TRIP_FILES as readonly string[]).not.toContain(excluded);
    }
  });

  it("parses the exact block grammar Marcel writes — BOTH directions", () => {
    // The header grammar is duplicated (services/travel/lib/booking-header.ts owns the
    // original). Comparing our regex's SOURCE against his makes the pin bite in both
    // directions: his change goes red here, and so does an edit to ours alone. Ours is his
    // header plus the block tail, so it must start with his, character for character.
    const marcel = fs.readFileSync(
      path.join(import.meta.dirname, "..", "..", "travel", "lib", "booking-header.ts"),
      "utf8",
    );
    const literal = /export const HEADER_RE =\s*(\/.*\/g);/u.exec(marcel)?.[1];
    expect(literal, "HEADER_RE literal not found in booking-header.ts").toBeDefined();
    const headerSource = literal!.slice(1, -2);

    expect(headerSource).toContain("kind:(\\S+) start:(\\S+) end:(\\S+) time:(\\S+)");
    expect(BOOKING_BLOCK_RE.source.startsWith(headerSource)).toBe(true);
  });

  it("pins Marcel's `kind` enum — the trigger the `other` bucket depends on", () => {
    // TRANSPORT_KINDS carries `train`/`ferry`/`bus` "for the day his enum grows". Without this
    // assertion that day has NO trigger: the enum could gain `train` and this reader would go
    // on filing trains into `other` while nothing went red. His extraction prompt already says
    // "ferge", so the growth is plausible, not hypothetical.
    const bookings = fs.readFileSync(
      path.join(import.meta.dirname, "..", "..", "travel", "lib", "bookings.ts"),
      "utf8",
    );
    const kinds = /kind: z\.enum\(\[([^\]]*)\]\)/u
      .exec(bookings)?.[1]
      ?.match(/"([^"]+)"/gu)
      ?.map((k) => k.replaceAll('"', ""));
    // ORB-173: `train` and `ferry` joined the enum — the exact growth this alarm existed to
    // catch fired, and TRANSPORT_KINDS absorbed both without a Saga change, as designed.
    expect(kinds).toEqual(["flight", "stay", "car", "train", "ferry", "restaurant", "other"]);

    // Every kind he can file must land in exactly one of the three buckets, and `other` is a
    // real destination, not a leak: `restaurant` and `other` belong to neither set.
    for (const kind of kinds!) {
      expect(LODGING_KINDS.has(kind) && TRANSPORT_KINDS.has(kind)).toBe(false);
    }
    expect(kinds!.filter((k) => !LODGING_KINDS.has(k) && !TRANSPORT_KINDS.has(k))).toEqual([
      "restaurant",
      "other",
    ]);
  });
});

// ─── ORB-174 #1 — an unreadable bookings.md is a dropped source, not an empty trip ─────────
describe("travel-store — a file that exists but cannot be read is DISCLOSED (ORB-174)", () => {
  it("an unreadable bookings.md reaches currentTravel's unavailable channel, and the trip still renders", () => {
    const root = buildFixture();
    const bookingsPath = path.join(root, "trips", BIG_APPLE.slug, "bookings.md");
    // A DIRECTORY where a file should be: deterministic EISDIR on every platform, no chmod
    // games that root (CI) would ignore. existsSync says true, readFileSync throws.
    fs.rmSync(bookingsPath);
    fs.mkdirSync(bookingsPath);

    const result = currentTravel("2026-08-26", { env: env(root) });

    expect(result.unavailable).toBeDefined();
    expect(result.unavailable).toContain(`${BIG_APPLE.slug}/bookings.md`);
    expect(result.unavailable).toContain("could not be read");
    // The trip itself survives — its OTHER files were readable; only the failed file is empty.
    const trip = result.trips.find((t) => t.trip.slug === BIG_APPLE.slug);
    expect(trip).toBeDefined();
    expect(trip!.lodging).toEqual([]);
    expect(trip!.notes).not.toBe("");
    // No container path leaks into a string that can reach a Slack brief.
    expect(result.unavailable).not.toContain(root);
  });

  it("an ABSENT bookings.md stays a normal read — no unavailable, no failure", () => {
    const root = buildFixture();
    fs.rmSync(path.join(root, "trips", BIG_APPLE.slug, "bookings.md"));

    const result = currentTravel("2026-08-26", { env: env(root) });

    expect(result.unavailable).toBeUndefined();
    expect(result.trips.find((t) => t.trip.slug === BIG_APPLE.slug)!.lodging).toEqual([]);
  });
});
