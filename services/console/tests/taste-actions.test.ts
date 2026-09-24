// Tests for the Taste page's server actions (ORB-99, incl. the re-upload amendment).
//
// The amendment is what most of this file is about: a re-upload is a DIFF of that list — add,
// update, remove — keyed on the saved URL's feature id, and it must never wipe coordinates the
// store already holds or touch a list that is not in the batch.
//
// Auth/cookies/revalidate are mocked as tests/voice-actions.test.ts mocks them; the store itself
// is a real temp directory, because what lands on disk IS the thing worth testing.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const { verifyMock } = vi.hoisted(() => ({ verifyMock: vi.fn(async () => "owner@owner.example" as string | null) }));
vi.mock("../lib/auth", () => ({ verify: verifyMock }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => ({ value: "c" }) })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { commitPaste, commitTakeout, deriveMissingPlaceNames, previewTakeout, removeEntry, repairContradictedPins, setListCountry } from "../app/actions/taste";
import { listDomain } from "../lib/taste-store";

/** Raw Takeout: a feature id in the URL, no coordinates — what Google exports today. */
const raw = (rows: Array<[string, string, string]>) =>
  ["Title,Note,URL", ...rows.map(([t, n, u]) => `"${t}","${n}","${u}"`), ""].join("\n");

/** Browser-resolved: the same rows, with the pins Google's own redirect gave back. */
const resolved = (rows: Array<[string, string, string, string, string]>) =>
  ["Title,Note,Latitude,Longitude,URL", ...rows.map((r) => r.map((c) => `"${c}"`).join(",")), ""].join("\n");

// REAL feature ids, from Bendik's store. Since ORB-117 the id is not just an opaque identity
// key — it decodes to a point, and half these tests turn on where that point lands. A made-up
// `0xAAA` would decode to nothing (or, worse, to somewhere arbitrary) and the ladder would go
// untested. Both of these are Manhattan, ~4 km apart.
const LUCALI_URL = "https://www.google.com/maps/place/Lucali/data=!4m2!3m1!1s0x89c259892cccb7b7:0xbf4202b1312b5cf1";
const KATZ_URL = "https://www.google.com/maps/place/Katz/data=!4m2!3m1!1s0x89c2598f7ff4aa09:0x313547e757cb8cea";
/** A hand-pasted entry: a real saved place, but no feature id anywhere in the URL — so no rung 1,
 *  and the only way to a pin is an accepted match. */
const NO_FEATURE_URL = "https://maps.app.goo.gl/x7Qw2";
/** A feature id that decodes to central Paris (48.859, 2.347). The Paris fixtures need to be in
 *  Paris now that city and country are derived from the pin (ORB-116) — reusing a New York id here
 *  made the suite quietly assert that Paris is in the United States. */
const PARIS_URL = "https://www.google.com/maps/place/Chez+Bruno/data=!4m2!3m1!1s0x47e66e1f06e2b70f:0x40b82c3688c9460";
const SUP1_URL = "https://www.google.com/maps/place/Supreme/data=!4m2!3m1!1s0xE1:0xF1";
const SUP2_URL = "https://www.google.com/maps/place/Supreme/data=!4m2!3m1!1s0xE2:0xF2";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "console-taste-actions-"));
  process.env.TASTE_ROOT = root;
  delete process.env.GOOGLE_PLACES_API_KEY;
  delete process.env.GOOGLE_PLACES_API_KEY_FILE;
  verifyMock.mockResolvedValue("owner@owner.example");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.TASTE_ROOT;
});

const nycPlaces = () => listDomain("places").filter((s) => s.entry?.sourceList === "NYC");
const byName = (name: string) => nycPlaces().find((s) => s.entry?.name === name)?.entry as
  | {
      name: string; lat?: number; lon?: number; note?: string; city?: string;
      country?: string; importedAt?: string; updatedAt?: string;
      placeId?: string; approx?: boolean; address?: string;
    }
  | undefined;

async function upload(csvText: string, listName = "NYC", city?: string, country?: string) {
  return commitTakeout({
    lists: [{ listName, csvText, ...(city ? { city } : {}), ...(country ? { country } : {}) }],
  });
}


describe("a first upload", () => {
  it("adds every row", async () => {
    const [r] = await upload(raw([["Lucali", "", LUCALI_URL], ["Katz's", "", KATZ_URL]]));
    expect(r).toMatchObject({ listName: "NYC", added: 2, updated: 0, removed: 0 });
    expect(nycPlaces()).toHaveLength(2);
  });

  it("takes the coordinates from a browser-resolved export", async () => {
    await upload(resolved([["Lucali", "", "40.681", "-73.9985", LUCALI_URL]]));
    expect(byName("Lucali")).toMatchObject({ lat: 40.681, lon: -73.9985 });
  });

  it("keeps two outlets of one name apart", async () => {
    await upload(resolved([
      ["Supreme", "", "40.7211", "-73.9940", SUP1_URL],
      ["Supreme", "", "40.7145", "-73.9621", SUP2_URL],
    ]));
    expect(nycPlaces()).toHaveLength(2);
  });
});

describe("re-uploading the same list", () => {
  const first = raw([["Lucali", "", LUCALI_URL], ["Katz's", "", KATZ_URL]]);

  it("adds what is new, updates what changed, removes what is gone", async () => {
    await upload(first);
    const [r] = await upload(raw([["Lucali", "kontant", LUCALI_URL], ["Balthazar", "", SUP1_URL]]));

    expect(r).toMatchObject({ added: 1, updated: 1, removed: 1 });
    expect(nycPlaces().map((s) => s.entry?.name).sort()).toEqual(["Balthazar", "Lucali"]);
    expect(byName("Lucali")?.note).toBe("kontant");
  });

  it("PRESERVES coordinates a browser-resolved upload established", async () => {
    await upload(resolved([["Lucali", "", "40.681", "-73.9985", LUCALI_URL]]));
    const [r] = await upload(raw([["Lucali", "ny note", LUCALI_URL]]));

    expect(byName("Lucali")).toMatchObject({ lat: 40.681, lon: -73.9985, note: "ny note" });
    expect(r.keptCoordinates).toBe(1);
  });

  it("follows a rename through the feature id, leaving no ghost behind", async () => {
    await upload(raw([["Lucali", "", LUCALI_URL]]));
    const [r] = await upload(raw([["Lucali Pizza", "", LUCALI_URL]]));

    expect(r).toMatchObject({ added: 0, updated: 1, removed: 0 });
    expect(nycPlaces().map((s) => s.entry?.name)).toEqual(["Lucali Pizza"]);
  });

  it("removes one outlet without disturbing the other", async () => {
    await upload(resolved([
      ["Supreme", "", "40.7211", "-73.9940", SUP1_URL],
      ["Supreme", "", "40.7145", "-73.9621", SUP2_URL],
    ]));
    const [r] = await upload(resolved([["Supreme", "", "40.7211", "-73.9940", SUP1_URL]]));

    expect(r).toMatchObject({ removed: 1 });
    expect(nycPlaces()).toHaveLength(1);
    expect(byName("Supreme")).toMatchObject({ lat: 40.7211 });
  });

  it("an unchanged re-upload changes nothing", async () => {
    await upload(first);
    const before = nycPlaces().map((s) => s.file).sort();
    const [r] = await upload(first);

    expect(r).toMatchObject({ added: 0, updated: 2, removed: 0 });
    expect(nycPlaces().map((s) => s.file).sort()).toEqual(before);
  });
});

describe("freshness stamps (ORB-110)", () => {
  const one = raw([["Lucali", "", LUCALI_URL]]);

  it("stamps a newly imported entry, and nothing else", async () => {
    await upload(one);
    const lucali = byName("Lucali")!;
    expect(Date.parse(lucali.importedAt!)).toBeGreaterThan(0);
    expect(lucali.updatedAt).toBeUndefined();
  });

  it("an unchanged re-upload leaves the stamps exactly as they were", async () => {
    // The whole point of the badge: re-uploading a 126-place list must not flag 126 entries as
    // "endret". `diffList` calls them all `updated` — only the CONTENT decides the stamp.
    await upload(one);
    const first = byName("Lucali")!.importedAt;

    const [r] = await upload(one);

    expect(r).toMatchObject({ updated: 1, changed: 0 });
    expect(byName("Lucali")!.importedAt).toBe(first);
    expect(byName("Lucali")!.updatedAt).toBeUndefined();
  });

  it("a real change stamps updatedAt and KEEPS the original importedAt", async () => {
    await upload(one);
    const first = byName("Lucali")!.importedAt;

    const [r] = await upload(raw([["Lucali", "kontant", LUCALI_URL]]));

    expect(r.changed).toBe(1);
    expect(byName("Lucali")!.importedAt).toBe(first);
    expect(Date.parse(byName("Lucali")!.updatedAt!)).toBeGreaterThanOrEqual(Date.parse(first!));
  });

  it("counts a coordinate found at import time as a change", async () => {
    // Geocoding runs AFTER the diff classifies, so a stamp decided inside diffList would miss it.
    // The row deliberately carries no feature id: with one, rung 3 would have pinned it on the
    // first upload and there would be nothing left for the match to find.
    const noFeature = raw([["Lucali", "", NO_FEATURE_URL]]);
    await upload(noFeature);
    expect(byName("Lucali")?.lat).toBeUndefined();

    process.env.GOOGLE_PLACES_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ places: [{ id: "ChIJLucali", displayName: { text: "Lucali" }, location: { latitude: 40.681, longitude: -73.9985 } }] }), { status: 200 }),
    ));

    const [r] = await upload(noFeature, "NYC", "New York");

    expect(r).toMatchObject({ geocoded: 1, changed: 1 });
    expect(byName("Lucali")!.updatedAt).toBeDefined();
    vi.unstubAllGlobals();
  });

  it("counts the offline pin an OLD coordinate-less entry gains as a change", async () => {
    // The store holds entries imported before any of this existed. A re-upload now backfills them
    // from their own saved URL — which is a real change to the file and must be badged as one.
    fs.mkdirSync(path.join(root, "places"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "places", "nyc--lucali.md"),
      `---\ntype: place\nname: Lucali\nurl: ${LUCALI_URL}\nsource_list: NYC\n---\n`,
    );

    const [r] = await upload(one);

    expect(r).toMatchObject({ updated: 1, changed: 1 });
    expect(byName("Lucali")).toMatchObject({ approx: true });
    expect(byName("Lucali")!.updatedAt).toBeDefined();
  });

  it("does not invent an importedAt for an entry that predates the field", async () => {
    // Stamp-free, already pinned AND already named, so the re-upload genuinely changes nothing.
    // An entry still missing any of the three would be changed by a backfill and would prove
    // nothing about stamps.
    fs.mkdirSync(path.join(root, "places"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "places", "nyc--lucali.md"),
      `---\ntype: place\nname: Lucali\ncity: New York City\ncountry: United States\nlat: 40.7227\nlon: -73.9982\nurl: ${LUCALI_URL}\nsource_list: NYC\n---\n`,
    );

    const [r] = await upload(one);

    expect(r).toMatchObject({ added: 0, updated: 1, changed: 0 });
    expect(byName("Lucali")!.importedAt).toBeUndefined();
    expect(byName("Lucali")!.updatedAt).toBeUndefined();
  });

  it("stamps a pasted list, and re-pasting marks it updated", async () => {
    await commitPaste({ domain: "music", name: "Sommer", text: "a" });
    const first = listDomain("music")[0]!.entry!;
    expect(first.importedAt).toBeDefined();
    expect(first.updatedAt).toBeUndefined();

    await commitPaste({ domain: "music", name: "Sommer", text: "a\nb" });
    const second = listDomain("music")[0]!.entry!;
    expect(second.importedAt).toBe(first.importedAt);
    expect(second.updatedAt).toBeDefined();
  });
});

describe("country (ORB-110)", () => {
  it("flows from the upload form onto every entry of that list", async () => {
    await upload(raw([["Lucali", "", LUCALI_URL]]), "NYC", "New York", "USA");
    expect(byName("Lucali")).toMatchObject({ city: "New York", country: "USA" });
  });

  it("flows from the paste form too", async () => {
    await commitPaste({ domain: "places", name: "Ida", city: "Lisboa", country: "Portugal", text: "Cervejaria" });
    const entry = listDomain("places")[0]!.entry as { country?: string };
    expect(entry.country).toBe("Portugal");
  });

  it("backfills a list that predates the field, without re-uploading anything", async () => {
    await upload(raw([["Lucali", "", LUCALI_URL], ["Katz's", "", KATZ_URL]]));
    const filesBefore = nycPlaces().map((s) => s.file).sort();

    const r = await setListCountry({ listName: "NYC", country: "USA" });

    expect(r).toMatchObject({ listName: "NYC", changed: 2, alreadySet: 0 });
    expect(nycPlaces().every((s) => (s.entry as { country?: string }).country === "USA")).toBe(true);
    // A metadata fix must not move a file — the filename is the upsert key.
    expect(nycPlaces().map((s) => s.file).sort()).toEqual(filesBefore);
  });

  it("says so when there was nothing left to do, rather than reporting a silent success", async () => {
    await upload(raw([["Lucali", "", LUCALI_URL]]));
    await setListCountry({ listName: "NYC", country: "USA" });

    expect(await setListCountry({ listName: "NYC", country: "USA" }))
      .toMatchObject({ changed: 0, alreadySet: 1 });
  });

  it("leaves the freshness stamps alone — attaching a country is not a change to the place", async () => {
    await upload(raw([["Lucali", "", LUCALI_URL]]));
    const before = byName("Lucali")!;

    await setListCountry({ listName: "NYC", country: "USA" });

    expect(byName("Lucali")!.importedAt).toBe(before.importedAt);
    expect(byName("Lucali")!.updatedAt).toBeUndefined();
  });

  it("touches only the list it was given", async () => {
    await upload(raw([["Lucali", "", LUCALI_URL]]), "NYC");
    await upload(raw([["Chez Bruno", "", PARIS_URL]]), "Paris");

    await setListCountry({ listName: "NYC", country: "USA" });

    const paris = listDomain("places").find((s) => s.entry?.sourceList === "Paris")!;
    // Derived at import, and NOT overwritten by a country set on a different list.
    expect((paris.entry as { country?: string }).country).toBe("France");
  });

  it("insists on a country", async () => {
    await expect(setListCountry({ listName: "NYC", country: "  " })).rejects.toThrow(/land/);
  });
});

describe("a list not in the batch", () => {
  it("is never touched", async () => {
    await upload(raw([["Lucali", "", LUCALI_URL]]), "NYC");
    await upload(raw([["Chez Bruno", "", KATZ_URL]]), "Paris");

    // re-uploading NYC alone, now empty of Chez Bruno, must not disturb Paris
    await upload(raw([["Lucali", "", LUCALI_URL]]), "NYC");

    expect(listDomain("places").filter((s) => s.entry?.sourceList === "Paris")).toHaveLength(1);
  });
});

describe("the preview", () => {
  it("shows +/~/- per list before anything is written", async () => {
    await upload(raw([["Lucali", "", LUCALI_URL], ["Katz's", "", KATZ_URL]]));

    const [p] = await previewTakeout({
      lists: [{ listName: "NYC", csvText: raw([["Lucali", "", LUCALI_URL], ["Balthazar", "", SUP1_URL]]) }],
    });

    expect(p).toMatchObject({ listName: "NYC", added: 1, updated: 1, removed: 1 });
    expect(p.removedNames).toEqual(["Katz's"]);
  });

  it("writes nothing", async () => {
    await previewTakeout({ lists: [{ listName: "NYC", csvText: raw([["Lucali", "", LUCALI_URL]]) }] });
    expect(fs.existsSync(path.join(root, "places"))).toBe(false);
  });

  it("reports where coordinates would come from", async () => {
    await upload(resolved([["Lucali", "", "40.681", "-73.9985", LUCALI_URL]]));

    const [p] = await previewTakeout({
      lists: [{ listName: "NYC", csvText: raw([["Lucali", "", LUCALI_URL], ["Katz's", "", KATZ_URL]]) }],
    });

    expect(p.withCoords).toBe(0);   // the raw upload carries none
    expect(p.keepsCoords).toBe(1);  // Lucali keeps the pin already stored
    expect(p.needsLookup).toBe(1);  // Katz's has none from either side
  });

  it("covers several lists in one batch", async () => {
    const previews = await previewTakeout({
      lists: [
        { listName: "NYC", csvText: raw([["Lucali", "", LUCALI_URL]]) },
        { listName: "Paris", csvText: raw([["Chez Bruno", "", KATZ_URL]]) },
      ],
    });
    expect(previews.map((p) => p.listName)).toEqual(["NYC", "Paris"]);
  });

  it("insists on a list name — it is what ties an upload to what is already stored", async () => {
    await expect(previewTakeout({ lists: [{ listName: " ", csvText: raw([]) }] })).rejects.toThrow(/navn/);
  });
});

describe("import-time coordinate resolution — the ORB-117 ladder", () => {
  /** A Places Text Search answer, in the shape the New API returns it. */
  const hit = (name: string, lat: number, lon: number, id = "ChIJtest") =>
    ({ id, displayName: { text: name }, location: { latitude: lat, longitude: lon }, formattedAddress: `${name}, New York, NY, USA` });
  const answer = (...places: unknown[]) =>
    vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ places }), { status: 200 }));

  it("still pins from the saved URL alone when no Places key is configured", async () => {
    // Before ORB-117 this stored nothing at all. Rungs 1 and 3 need no key, so "no key" must mean
    // "no exact matches", not "no pins".
    const [r] = await upload(raw([["Lucali", "", LUCALI_URL]]));

    expect(r.geocoded).toBe(0);
    expect(r.approximate[0]).toMatchObject({ name: "Lucali" });
    expect(byName("Lucali")).toMatchObject({ approx: true });
    expect(byName("Lucali")!.lat).toBeCloseTo(40.7227, 2);
  });

  it("accepts an exact-name hit near the decoded cell, and keeps the place id", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "k";
    const fetchMock = answer(hit("Lucali", 40.681, -73.9985, "ChIJLucali"));
    vi.stubGlobal("fetch", fetchMock);

    const [r] = await upload(raw([["Lucali", "", LUCALI_URL]]), "NYC", "New York");

    expect(r.geocoded).toBe(1);
    expect(byName("Lucali")).toMatchObject({
      lat: 40.681,
      placeId: "ChIJLucali",
      address: "Lucali, New York, NY, USA",
    });
    // The place id is the durable half of the prize: it must survive the round trip to disk.
    expect(byName("Lucali")!.approx).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("biases the search by the decoded cell rather than by the operator's city string", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "k";
    const fetchMock = answer(hit("Lucali", 40.681, -73.9985));
    vi.stubGlobal("fetch", fetchMock);

    await upload(raw([["Lucali", "", LUCALI_URL]]), "NYC", "New York");

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body.textQuery).toBe("Lucali");               // no ", New York" appended
    expect(body.locationBias.circle.center.latitude).toBeCloseTo(40.7227, 2);
    vi.unstubAllGlobals();
  });

  it("falls back to the city string when the URL carries no feature id", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "k";
    const fetchMock = answer(hit("Lucali", 40.681, -73.9985));
    vi.stubGlobal("fetch", fetchMock);

    await upload(raw([["Lucali", "", NO_FEATURE_URL]]), "NYC", "New York");

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body.textQuery).toBe("Lucali, New York");
    expect(body.locationBias).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("REFUSES a near-name-match rather than storing a wrong pin", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "k";
    vi.stubGlobal("fetch", answer(hit("Lucali Pizzeria Napoletana", 40.68, -73.99)));

    const [r] = await upload(raw([["Lucali", "", LUCALI_URL]]), "NYC", "New York");

    expect(r.geocoded).toBe(0);
    expect(r.approximate[0]!.reason).toContain("ikke samme navn");
    expect(byName("Lucali")).toMatchObject({ approx: true });   // rung 3 still gives it a pin
    vi.unstubAllGlobals();
  });

  it("REFUSES an exactly-named match in the wrong part of the world", async () => {
    // THE defect this rule exists for: on 2026-08-17, 51 of 928 stored pins were a same-named
    // place on another continent — "The Bird" saved in Berlin, pinned in San Francisco. The name
    // matches perfectly; only the distance from the decoded cell gives it away.
    process.env.GOOGLE_PLACES_API_KEY = "k";
    vi.stubGlobal("fetch", answer(hit("Lucali", 37.7872, -122.4001)));

    const [r] = await upload(raw([["Lucali", "", LUCALI_URL]]), "NYC", "New York");

    expect(r.geocoded).toBe(0);
    expect(r.approximate[0]!.reason).toMatch(/km unna/);
    expect(byName("Lucali")!.lat).toBeCloseTo(40.7227, 2);      // the NEW YORK cell, not SF
    expect(byName("Lucali")!.placeId).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("prefers the nearest exact-name match when a chain returns several", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "k";
    vi.stubGlobal("fetch", answer(
      hit("Lucali", 34.05, -118.24, "ChIJfar"),        // same name, Los Angeles — ranked first
      hit("Lucali", 40.6809, -73.9985, "ChIJnear"),    // same name, four blocks from the cell
    ));

    const [r] = await upload(raw([["Lucali", "", LUCALI_URL]]), "NYC", "New York");

    expect(r.geocoded).toBe(1);
    expect(byName("Lucali")).toMatchObject({ placeId: "ChIJnear" });
    vi.unstubAllGlobals();
  });

  it("leaves a place with neither a match nor a feature id genuinely unresolved", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "k";
    vi.stubGlobal("fetch", answer());

    const [r] = await upload(raw([["Lucali", "", NO_FEATURE_URL]]), "NYC", "New York");

    expect(r.unresolved[0]).toMatchObject({ name: "Lucali", reason: "ingen treff" });
    expect(byName("Lucali")?.lat).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("survives a failing lookup — one bad row must not sink the import", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    const [r] = await upload(raw([["Lucali", "", LUCALI_URL]]), "NYC", "New York");

    expect(r.added).toBe(1);
    expect(r.approximate[0]!.reason).toContain("500");
    expect(byName("Lucali")).toMatchObject({ approx: true });
    vi.unstubAllGlobals();
  });

  it("never looks up a row that already has coordinates", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "k";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await upload(resolved([["Lucali", "", "40.681", "-73.9985", LUCALI_URL]]), "NYC", "New York");

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("repairContradictedPins — the ORB-117 pin audit", () => {
  /** A stored place whose pin is on the wrong continent: saved in Berlin, pinned in SF. */
  const wronglyPinned = () => {
    fs.mkdirSync(path.join(root, "places"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "places", "berlin--the-bird.md"),
      `---\ntype: place\nname: The Bird\nlat: 37.7872\nlon: -122.4001\nurl: https://www.google.com/maps/place/The+Bird/data=!4m2!3m1!1s0x47a852033dde0883:0x610e3ff7febdebc6\nsource_list: Berlin\n---\n`,
    );
  };
  const theBird = () =>
    listDomain("places").find((s) => s.entry?.name === "The Bird")?.entry as
      | { lat?: number; lon?: number; approx?: boolean; placeId?: string }
      | undefined;

  it("reports without writing anything by default", async () => {
    wronglyPinned();

    const r = await repairContradictedPins();

    expect(r.found).toBe(1);
    expect(r.rows[0]).toMatchObject({ name: "The Bird", sourceList: "Berlin" });
    expect(r.rows[0]!.wrongBy).toBeGreaterThan(9_000_000);
    expect(theBird()!.lat).toBe(37.7872);   // untouched — a dry run must not rewrite the store
  });

  it("replaces a contradicted pin with a confirmed match, and keeps the place id", async () => {
    wronglyPinned();
    process.env.GOOGLE_PLACES_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ places: [{ id: "ChIJbird", displayName: { text: "The Bird" }, location: { latitude: 52.5467, longitude: 13.4058 } }] }), { status: 200 }),
    ));

    const r = await repairContradictedPins({ dryRun: false });

    expect(r).toMatchObject({ found: 1, exact: 1, kept: 0, searches: 1 });
    expect(theBird()).toMatchObject({ lat: 52.5467, placeId: "ChIJbird" });
    expect(theBird()!.approx).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("LEAVES THE PIN ALONE when nothing confirms a better answer", async () => {
    // The audit finds a disagreement; it does not know which side is wrong. Usually the pin is —
    // but on the real store 4 of 59 flagged entries have a good pin and a feature id whose cell is
    // in the wrong country. Writing the decoded cell for those would replace a correct pin with a
    // wrong one, turning an audit into a corruption. Only a confirmed match may overwrite.
    wronglyPinned();
    process.env.GOOGLE_PLACES_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ places: [] }), { status: 200 })));

    const r = await repairContradictedPins({ dryRun: false });

    expect(r).toMatchObject({ found: 1, exact: 0, kept: 1 });
    expect(r.rows[0]).toMatchObject({ outcome: "kept" });
    expect(theBird()!.lat).toBe(37.7872);        // exactly as it was — not the decoded Berlin cell
    expect(theBird()!.approx).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("REFUSES a confirmed match that sits further from the list than the pin already there", async () => {
    // The residual hole the two earlier guards leave: when the LINK is the wrong side, rung 2 is
    // biased at the wrong place, and a genuine same-named place near that bias passes both the
    // name and the distance test. Real case — "Le Panier" is correctly pinned in Marseille, its
    // link decodes 159 km away, and a real Le Panier sits near the decode.
    //
    // Here: a Berlin list whose other places are in Berlin, holding a correctly-pinned entry whose
    // link decodes to San Francisco, and a search that confirms a real San Francisco namesake.
    fs.mkdirSync(path.join(root, "places"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "places", "berlin--sibling.md"),
      `---\ntype: place\nname: Nabo\nlat: 52.5200\nlon: 13.4050\nsource_list: Berlin\n---\n`,
    );
    fs.writeFileSync(
      path.join(root, "places", "berlin--the-bird.md"),
      `---\ntype: place\nname: The Bird\nlat: 52.5300\nlon: 13.4100\nurl: https://www.google.com/maps/place/The+Bird/data=!4m2!3m1!1s0x8085808c0d0d0d0d:0x1\nsource_list: Berlin\n---\n`,
    );
    process.env.GOOGLE_PLACES_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ places: [{ id: "ChIJsf", displayName: { text: "The Bird" }, location: { latitude: 37.7872, longitude: -122.4001 } }] }), { status: 200 }),
    ));

    const r = await repairContradictedPins({ dryRun: false });

    expect(r).toMatchObject({ exact: 0, kept: 1 });
    expect(r.rows[0]!.reason).toContain("lenger fra resten av lista");
    expect(theBird()!.lat).toBe(52.53);          // the Berlin pin it already had
    expect(theBird()!.placeId).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("changes nothing at all when no Places key is configured — it cannot confirm anything", async () => {
    wronglyPinned();

    const r = await repairContradictedPins({ dryRun: false });

    expect(r).toMatchObject({ found: 1, exact: 0, kept: 1, searches: 0 });
    expect(theBird()!.lat).toBe(37.7872);
  });

  it("finds nothing to do in a store whose pins agree with their links", async () => {
    await upload(resolved([["Lucali", "", "40.7227", "-73.9982", LUCALI_URL]]), "NYC", "New York");

    expect(await repairContradictedPins()).toMatchObject({ found: 0, rows: [] });
  });
});

describe("city and country, derived (ORB-116)", () => {
  it("names a place from its pin, so neither field has to be typed", async () => {
    await upload(raw([["Lucali", "", LUCALI_URL]]), "NYC");

    expect(byName("Lucali")).toMatchObject({ city: "New York City", country: "United States" });
  });

  it("treats what the operator typed as an override, not a default", async () => {
    await upload(raw([["Lucali", "", LUCALI_URL]]), "NYC", "Brooklyn", "USA");

    expect(byName("Lucali")).toMatchObject({ city: "Brooklyn", country: "USA" });
  });

  it("fills only the half that is missing", async () => {
    await upload(raw([["Lucali", "", LUCALI_URL]]), "NYC", "", "USA");

    expect(byName("Lucali")).toMatchObject({ city: "New York City", country: "USA" });
  });

  it("says nothing about a place it could not pin", async () => {
    await upload(raw([["Lucali", "", NO_FEATURE_URL]]), "NYC");

    expect(byName("Lucali")!.city).toBeUndefined();
  });

  it("backfills what is already stored, without stamping it as changed", async () => {
    fs.mkdirSync(path.join(root, "places"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "places", "nyc--lucali.md"),
      `---\ntype: place\nname: Lucali\nlat: 40.7227\nlon: -73.9982\nsource_list: NYC\n---\n`,
    );

    const r = await deriveMissingPlaceNames();

    expect(r).toMatchObject({ named: 1 });
    expect(byName("Lucali")).toMatchObject({ city: "New York City", country: "United States" });
    // Bookkeeping about where a place already was is not a change to the place — badging it
    // "endret" would drown the signal the badge exists for.
    expect(byName("Lucali")!.updatedAt).toBeUndefined();
  });

  it("counts what it left alone, so 'already done' is not silence", async () => {
    // One upload, two rows: a second upload of the same list is a DIFF, so it would have removed
    // the first row rather than adding to it.
    await upload(raw([["Lucali", "", LUCALI_URL], ["Ukjent", "", NO_FEATURE_URL]]), "NYC");

    expect(await deriveMissingPlaceNames()).toMatchObject({ named: 0, alreadyNamed: 1, noPin: 1 });
  });
});

describe("search bias for a place that cannot locate itself (ORB-116)", () => {
  it("biases by the list's own centroid when the URL carries no feature id", async () => {
    await upload(resolved([["Katz's", "", "40.7222", "-73.9874", KATZ_URL]]), "NYC");

    process.env.GOOGLE_PLACES_API_KEY = "k";
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ places: [{ id: "ChIJx", displayName: { text: "Lucali" }, location: { latitude: 40.681, longitude: -73.9985 } }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await upload(raw([["Katz's", "", KATZ_URL], ["Lucali", "", NO_FEATURE_URL]]), "NYC");

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body.locationBias.circle.center.latitude).toBeCloseTo(40.72, 1);
    vi.unstubAllGlobals();
  });

  it("never lets a centroid become a PIN — it is where the others are, not where this one is", async () => {
    await upload(resolved([["Katz's", "", "40.7222", "-73.9874", KATZ_URL]]), "NYC");

    process.env.GOOGLE_PLACES_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ places: [] }), { status: 200 })));

    const [r] = await upload(raw([["Katz's", "", KATZ_URL], ["Lucali", "", NO_FEATURE_URL]]), "NYC");

    expect(byName("Lucali")?.lat).toBeUndefined();
    expect(r.unresolved.map((u) => u.name)).toContain("Lucali");
    vi.unstubAllGlobals();
  });
});

describe("commitPaste", () => {
  it("puts a pasted playlist in music/ as ONE file with the lines as items", async () => {
    await commitPaste({ domain: "music", name: "Sommer 2026", text: "- Pink Moon\n- Turiya\n" });
    const [stored] = listDomain("music");
    expect(stored.file).toBe("sommer-2026.md");
    expect(stored.entry && "items" in stored.entry ? stored.entry.items : []).toEqual(["Pink Moon", "Turiya"]);
  });

  it("splits a pasted PLACES list into one entry per line", async () => {
    await commitPaste({ domain: "places", name: "Anbefalt av Ida", city: "New York", text: "Lucali\nKatz's\n" });
    const places = listDomain("places");
    expect(places.map((p) => p.entry?.name).sort()).toEqual(["Katz's", "Lucali"]);
    expect(places.every((p) => p.entry && "city" in p.entry && p.entry.city === "New York")).toBe(true);
  });

  it("refuses a domain that is not one of the four", async () => {
    await expect(commitPaste({ domain: "../etc", name: "x", text: "y" })).rejects.toThrow(/unknown domain/i);
  });

  it("says so when there is nothing to save", async () => {
    await expect(commitPaste({ domain: "music", name: "x", text: "   " })).rejects.toThrow(/ingen linjer/);
  });
});

describe("removeEntry", () => {
  it("deletes the file", async () => {
    await commitPaste({ domain: "music", name: "Sommer", text: "a" });
    await removeEntry({ domain: "music", file: "sommer.md" });
    expect(listDomain("music")).toEqual([]);
  });

  it("refuses a filename that would escape the store", async () => {
    await expect(removeEntry({ domain: "music", file: "../../../etc/passwd" })).rejects.toThrow(/unsafe/i);
  });
});

describe("every action is its own auth boundary", () => {
  it("refuses when there is no valid session, even though middleware gates the page", async () => {
    verifyMock.mockResolvedValue(null);
    const lists = [{ listName: "NYC", csvText: raw([["Lucali", "", LUCALI_URL]]) }];
    await expect(previewTakeout({ lists })).rejects.toThrow(/unauthenticated/);
    await expect(commitTakeout({ lists })).rejects.toThrow(/unauthenticated/);
    await expect(commitPaste({ domain: "music", name: "L", text: "a" })).rejects.toThrow(/unauthenticated/);
    await expect(removeEntry({ domain: "music", file: "a.md" })).rejects.toThrow(/unauthenticated/);
  });

  it("writes nothing when unauthenticated", async () => {
    verifyMock.mockResolvedValue(null);
    await upload(raw([["Lucali", "", LUCALI_URL]])).catch(() => {});
    expect(fs.existsSync(path.join(root, "places"))).toBe(false);
  });
});
