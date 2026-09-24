// ORB-100 acceptance tests — Marcel consuming the fleet taste store end to end.
//
// tests/taste.test.ts covers the pieces (store reader, matching, rendering). This file covers
// the thing the ticket actually promises: a fixture store plus The Big Apple trip produces the
// right injected context, and an ABSENT store produces exactly what Marcel produced before the
// taste layer existed.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SessionAuth } from "eve/context";

import { serializeEntry, type ListEntry, type PlaceEntry } from "@lares/taste";

import { TripStore, type Trip } from "../lib/trip-store.js";
import { resolveTripContextMarkdown } from "../agent/instructions/trip-context.js";
import {
  composeSavedPlacesMessage,
  createPredeparturePackTool,
  type PredeparturePackDeps,
} from "../catalogue/predeparture_pack.js";

const ADMIN_ID = "123456789";
const CHAT_ID = "-100123";
const NOW = Date.parse("2026-08-29T12:00:00Z");

const NYC_PLACES: PlaceEntry[] = [
  { type: "place", name: "Lucali", lat: 40.681, lon: -73.9985, sourceList: "NYC 2026", note: "Kontant" },
  { type: "place", name: "Katz's Delicatessen", lat: 40.7223, lon: -73.9874, sourceList: "NYC 2026" },
  { type: "place", name: "Tips fra Ida", city: "New York", sourceList: "Fra Ida" },
];
const ELSEWHERE_PLACES: PlaceEntry[] = [
  { type: "place", name: "Maaemo", lat: 59.9075, lon: 10.7529, sourceList: "Oslo" },
  { type: "place", name: "Chez Bruno", lat: 43.4901, lon: 6.3648, sourceList: "Provence" },
  { type: "place", name: "Oslo-tips", city: "Oslo" },
];
const LISTS: ListEntry[] = [
  { type: "playlist", name: "Sommer 2026", items: ["Pink Moon", "Turiya"] },
  { type: "dish", name: "Å lage", items: ["cacio e pepe"] },
];

let dataRoot: string;
let tasteRootDir: string;

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-taste-consume-data-"));
  tasteRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-taste-consume-store-"));
  process.env["MARCEL_DATA_ROOT"] = dataRoot;
  process.env["TASTE_ROOT"] = tasteRootDir;
  process.env["MARCEL_ADMIN_TELEGRAM_ID"] = ADMIN_ID;
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(tasteRootDir, { recursive: true, force: true });
  delete process.env["MARCEL_DATA_ROOT"];
  delete process.env["TASTE_ROOT"];
  delete process.env["MARCEL_ADMIN_TELEGRAM_ID"];
});

function seedTaste(places: PlaceEntry[] = [], lists: ListEntry[] = []): void {
  fs.mkdirSync(path.join(tasteRootDir, "places"), { recursive: true });
  places.forEach((p, i) =>
    fs.writeFileSync(path.join(tasteRootDir, "places", `p${i}.md`), serializeEntry(p)),
  );
  fs.mkdirSync(path.join(tasteRootDir, "music"), { recursive: true });
  fs.mkdirSync(path.join(tasteRootDir, "food"), { recursive: true });
  lists.forEach((l, i) =>
    fs.writeFileSync(
      path.join(tasteRootDir, l.type === "dish" ? "food" : "music", `l${i}.md`),
      serializeEntry(l),
    ),
  );
}

function seedTrip(): { store: TripStore; trip: Trip } {
  const store = new TripStore(dataRoot);
  store.saveConfig({ adminId: ADMIN_ID, killSwitch: false, dailyTokenBudget: 1_000_000, trips: [] });
  const trip = store.createTrip({
    slug: "the-big-apple",
    name: "The Big Apple",
    start: "2026-08-28",
    end: "2026-09-04",
    timezone: "America/New_York",
    destination: { name: "New York", lat: 40.7128, lon: -74.006 },
  });
  store.linkChat(trip.slug, CHAT_ID);
  return { store, trip: { ...trip, chatId: CHAT_ID } };
}

// ── the ticket's first acceptance criterion ──────────────────────────────────────────────

describe("fixture store + The Big Apple", () => {
  it("injects the NYC entries and leaves Oslo and Provence out", () => {
    seedTaste([...NYC_PLACES, ...ELSEWHERE_PLACES]);
    const { store, trip } = seedTrip();

    const md = resolveTripContextMarkdown(store, trip, NOW);

    expect(md).toContain("## Dine lagrede steder nær turen");
    expect(md).toContain("Lucali");
    expect(md).toContain("Katz's Delicatessen");
    expect(md).not.toContain("Maaemo");
    expect(md).not.toContain("Chez Bruno");
  });

  it("matches a coordinate-less entry on city:\"New York\"", () => {
    seedTaste([...NYC_PLACES, ...ELSEWHERE_PLACES]);
    const { store, trip } = seedTrip();

    const md = resolveTripContextMarkdown(store, trip, NOW);

    expect(md).toContain("Tips fra Ida");
    expect(md).not.toContain("Oslo-tips");
  });

  it("labels them as Bendik's own saved data, not Marcel's knowledge of the city", () => {
    seedTaste(NYC_PLACES);
    const { store, trip } = seedTrip();

    const md = resolveTripContextMarkdown(store, trip, NOW);

    expect(md).toContain("du har lagret");
    expect(md).toContain("sjekker du med verktøy");
  });

  it("carries the source list and note, but never the whole file", () => {
    seedTaste(NYC_PLACES);
    const { store, trip } = seedTrip();

    const md = resolveTripContextMarkdown(store, trip, NOW);

    expect(md).toContain("- Lucali (NYC 2026) — Kontant");
    expect(md).not.toContain("type: place");
    expect(md).not.toContain("source_list:");
  });

  it("puts the non-place half in the taste-profile section as a compact digest", () => {
    seedTaste(NYC_PLACES, LISTS);
    const { store, trip } = seedTrip();

    const md = resolveTripContextMarkdown(store, trip, NOW);

    expect(md).toContain("## Din smak");
    expect(md).toContain("Sommer 2026 (playlist): Pink Moon, Turiya");
    expect(md).toContain("Å lage (dish): cacio e pepe");
  });

  it("keeps Marcel's OWN learned taste separate from Bendik's saved store", () => {
    seedTaste(NYC_PLACES, LISTS);
    const { store, trip } = seedTrip();
    fs.mkdirSync(path.join(dataRoot, "taste"), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, "taste", "preferences.md"), "Liker små steder, hater kø.");

    const md = resolveTripContextMarkdown(store, trip, NOW);

    expect(md).toContain("Liker små steder, hater kø.");
    expect(md).toContain("Sommer 2026");
  });
});

// ── the ticket's second acceptance criterion: the mount is never load-bearing ────────────

describe("an empty or missing store degrades to exactly today's behaviour", () => {
  function contextWithout(): string {
    const { store, trip } = seedTrip();
    return resolveTripContextMarkdown(store, trip, NOW);
  }

  const EXPECTED = [
    "## Tur: The Big Apple",
    "2026-08-28 – 2026-09-04 · New York",
    "",
    "## I dag",
    "2026-08-29",
  ].join("\n");

  it("renders no taste sections at all when /srv/taste does not exist", () => {
    process.env["TASTE_ROOT"] = path.join(tasteRootDir, "not-mounted");
    expect(contextWithout()).toBe(EXPECTED);
  });

  it("renders no taste sections when the store is mounted but empty", () => {
    seedTaste([], []);
    expect(contextWithout()).toBe(EXPECTED);
  });

  it("renders no taste sections when nothing in the store is near this trip", () => {
    seedTaste(ELSEWHERE_PLACES);
    expect(contextWithout()).toBe(EXPECTED);
  });

  it("survives a store full of files it cannot parse", () => {
    fs.mkdirSync(path.join(tasteRootDir, "places"), { recursive: true });
    fs.writeFileSync(path.join(tasteRootDir, "places", "junk.md"), "not a taste file at all\n");
    expect(contextWithout()).toBe(EXPECTED);
  });
});

// ── the cross-feature ────────────────────────────────────────────────────────────────────

describe("predeparture_pack's saved-places section", () => {
  it("renders the saved places as Bendik's own, with their source lists", () => {
    const msg = composeSavedPlacesMessage("New York", NYC_PLACES);
    expect(msg).toContain("Dine lagrede steder — New York");
    expect(msg).toContain("Lucali <i>(NYC 2026)</i> — Kontant");
  });

  it("renders nothing when there is nothing saved nearby", () => {
    expect(composeSavedPlacesMessage("New York", [])).toBe("");
  });

  it("escapes HTML in a name so a saved place cannot break the message", () => {
    expect(composeSavedPlacesMessage("X", [{ type: "place", name: "A & <b>B</b>" }])).toContain("A &amp; &lt;b&gt;");
  });

  it("caps the list and says how many it left out", () => {
    const many: PlaceEntry[] = Array.from({ length: 20 }, (_, i) => ({ type: "place", name: `Sted ${i}` }));
    expect(composeSavedPlacesMessage("X", many)).toContain("… og 5 til i listene dine.");
  });

  function auth(): SessionAuth {
    const a = {
      authenticator: "telegram-webhook",
      principalId: `telegram:${ADMIN_ID}`,
      principalType: "user",
      attributes: { chat_id: ADMIN_ID, chat_type: "private", user_id: ADMIN_ID },
    } as never;
    return { current: a, initiator: a } as SessionAuth;
  }

  function packDeps(over: Partial<PredeparturePackDeps> = {}): { deps: PredeparturePackDeps; sent: string[] } {
    const { store } = seedTrip();
    const sent: string[] = [];
    return {
      sent,
      deps: {
        store: () => store,
        savedNearby: () => NYC_PLACES,
        searchStop: async () => ({ hits: [], kilde: "Google" as const }),
        send: async (_chatId: string, text: string) => {
          sent.push(text);
        },
        ...over,
      },
    };
  }

  const INPUT = { tripSlug: "the-big-apple", stops: [{ name: "Hotellet", lat: 40.75, lon: -73.98 }], category: "restaurant" as const };

  it("sends the saved-places section FIRST, before the discovery shortlists", async () => {
    const { deps, sent } = packDeps();
    await createPredeparturePackTool(deps).execute!(INPUT, { session: { id: "wrun", auth: auth() } } as never);

    expect(sent[0]).toContain("Dine lagrede steder");
    expect(sent[1]).toContain("Hotellet");
  });

  it("skips the section entirely when nothing is saved nearby", async () => {
    const { deps, sent } = packDeps({ savedNearby: () => [] });
    await createPredeparturePackTool(deps).execute!(INPUT, { session: { id: "wrun", auth: auth() } } as never);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Hotellet");
  });

  it("still sends the pack when the taste store throws — best-effort, like the photo garnish", async () => {
    const { deps, sent } = packDeps({
      savedNearby: () => {
        throw new Error("/srv/taste exploded");
      },
    });

    const result = await createPredeparturePackTool(deps).execute!(INPUT, {
      session: { id: "wrun", auth: auth() },
    } as never);

    expect(result).toMatchObject({ ok: true, sent: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Hotellet");
  });
});
