// Tests for the Taste page's server actions (incl. the re-upload amendment).
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

// Feature ids that decode to real points (invented ones, encoded with the same S2 maths). Since the id is not just an opaque identity
// key — it decodes to a point, and half these tests turn on where that point lands. A made-up
// `0xAAA` would decode to nothing (or, worse, to somewhere arbitrary) and the ladder would go
// untested. Both of these are in the same large city, a few km apart.
const PLACE_A_URL = "https://www.google.com/maps/place/Place+A/data=!4m2!3m1!1s0x89c2593f8bd29745:0x5a1c3e7d9b2f4608";
const PLACE_B_URL = "https://www.google.com/maps/place/Place+B/data=!4m2!3m1!1s0x89c259002b50de93:0x7e4d1b8a2c6f3095";
/** A hand-pasted entry: a saved place, but no feature id anywhere in the URL — so no rung 1,
 *  and the only way to a pin is an accepted match. */
const NO_FEATURE_URL = "https://maps.app.goo.gl/x7Qw2";
/** A feature id that decodes to central Paris (48.859, 2.347). The Paris fixtures need to be in
 *  Paris now that city and country are derived from the pin — reusing a New York id here
 *  made the suite quietly assert that Paris is in the United States. */
const PARIS_URL = "https://www.google.com/maps/place/Place+D/data=!4m2!3m1!1s0x47e66e24ca4bd111:0x3b9a5d7e1c2f4086";
const SUP1_URL = "https://www.google.com/maps/place/Shop+One/data=!4m2!3m1!1s0xE1:0xF1";
const SUP2_URL = "https://www.google.com/maps/place/Shop+One/data=!4m2!3m1!1s0xE2:0xF2";

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

const listAPlaces = () => listDomain("places").filter((s) => s.entry?.sourceList === "List A");
const byName = (name: string) => listAPlaces().find((s) => s.entry?.name === name)?.entry as
  | {
      name: string; lat?: number; lon?: number; note?: string; city?: string;
      country?: string; importedAt?: string; updatedAt?: string;
      placeId?: string; approx?: boolean; address?: string;
    }
  | undefined;

async function upload(csvText: string, listName = "List A", city?: string, country?: string) {
  return commitTakeout({
    lists: [{ listName, csvText, ...(city ? { city } : {}), ...(country ? { country } : {}) }],
  });
}


describe("a first upload", () => {
  it("adds every row", async () => {
    const [r] = await upload(raw([["Place A", "", PLACE_A_URL], ["Place B", "", PLACE_B_URL]]));
    expect(r).toMatchObject({ listName: "List A", added: 2, updated: 0, removed: 0 });
    expect(listAPlaces()).toHaveLength(2);
  });

  it("takes the coordinates from a browser-resolved export", async () => {
    await upload(resolved([["Place A", "", "40.6908", "-73.9618", PLACE_A_URL]]));
    expect(byName("Place A")).toMatchObject({ lat: 40.6908, lon: -73.9618 });
  });

  it("keeps two outlets of one name apart", async () => {
    await upload(resolved([
      ["Shop One", "", "40.7011", "-73.9340", SUP1_URL],
      ["Shop One", "", "40.6945", "-73.9121", SUP2_URL],
    ]));
    expect(listAPlaces()).toHaveLength(2);
  });
});

describe("re-uploading the same list", () => {
  const first = raw([["Place A", "", PLACE_A_URL], ["Place B", "", PLACE_B_URL]]);

  it("adds what is new, updates what changed, removes what is gone", async () => {
    await upload(first);
    const [r] = await upload(raw([["Place A", "kontant", PLACE_A_URL], ["Place C", "", SUP1_URL]]));

    expect(r).toMatchObject({ added: 1, updated: 1, removed: 1 });
    expect(listAPlaces().map((s) => s.entry?.name).sort()).toEqual(["Place A", "Place C"]);
    expect(byName("Place A")?.note).toBe("kontant");
  });

  it("PRESERVES coordinates a browser-resolved upload established", async () => {
    await upload(resolved([["Place A", "", "40.6908", "-73.9618", PLACE_A_URL]]));
    const [r] = await upload(raw([["Place A", "ny note", PLACE_A_URL]]));

    expect(byName("Place A")).toMatchObject({ lat: 40.6908, lon: -73.9618, note: "ny note" });
    expect(r.keptCoordinates).toBe(1);
  });

  it("follows a rename through the feature id, leaving no ghost behind", async () => {
    await upload(raw([["Place A", "", PLACE_A_URL]]));
    const [r] = await upload(raw([["Place A Pizza", "", PLACE_A_URL]]));

    expect(r).toMatchObject({ added: 0, updated: 1, removed: 0 });
    expect(listAPlaces().map((s) => s.entry?.name)).toEqual(["Place A Pizza"]);
  });

  it("removes one outlet without disturbing the other", async () => {
    await upload(resolved([
      ["Shop One", "", "40.7011", "-73.9340", SUP1_URL],
      ["Shop One", "", "40.6945", "-73.9121", SUP2_URL],
    ]));
    const [r] = await upload(resolved([["Shop One", "", "40.7011", "-73.9340", SUP1_URL]]));

    expect(r).toMatchObject({ removed: 1 });
    expect(listAPlaces()).toHaveLength(1);
    expect(byName("Shop One")).toMatchObject({ lat: 40.7011 });
  });

  it("an unchanged re-upload changes nothing", async () => {
    await upload(first);
    const before = listAPlaces().map((s) => s.file).sort();
    const [r] = await upload(first);

    expect(r).toMatchObject({ added: 0, updated: 2, removed: 0 });
    expect(listAPlaces().map((s) => s.file).sort()).toEqual(before);
  });
});

describe("freshness stamps", () => {
  const one = raw([["Place A", "", PLACE_A_URL]]);

  it("stamps a newly imported entry, and nothing else", async () => {
    await upload(one);
    const placeA = byName("Place A")!;
    expect(Date.parse(placeA.importedAt!)).toBeGreaterThan(0);
    expect(placeA.updatedAt).toBeUndefined();
  });

  it("an unchanged re-upload leaves the stamps exactly as they were", async () => {
    // The whole point of the badge: re-uploading a 126-place list must not flag 126 entries as
    // "endret". `diffList` calls them all `updated` — only the CONTENT decides the stamp.
    await upload(one);
    const first = byName("Place A")!.importedAt;

    const [r] = await upload(one);

    expect(r).toMatchObject({ updated: 1, changed: 0 });
    expect(byName("Place A")!.importedAt).toBe(first);
    expect(byName("Place A")!.updatedAt).toBeUndefined();
  });

  it("a real change stamps updatedAt and KEEPS the original importedAt", async () => {
    await upload(one);
    const first = byName("Place A")!.importedAt;

    const [r] = await upload(raw([["Place A", "kontant", PLACE_A_URL]]));

    expect(r.changed).toBe(1);
    expect(byName("Place A")!.importedAt).toBe(first);
    expect(Date.parse(byName("Place A")!.updatedAt!)).toBeGreaterThanOrEqual(Date.parse(first!));
  });

  it("counts a coordinate found at import time as a change", async () => {
    // Geocoding runs AFTER the diff classifies, so a stamp decided inside diffList would miss it.
    // The row deliberately carries no feature id: with one, rung 3 would have pinned it on the
    // first upload and there would be nothing left for the match to find.
    const noFeature = raw([["Place A", "", NO_FEATURE_URL]]);
    await upload(noFeature);
    expect(byName("Place A")?.lat).toBeUndefined();

    process.env.GOOGLE_PLACES_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ places: [{ id: "ChIJplaceA", displayName: { text: "Place A" }, location: { latitude: 40.6908, longitude: -73.9618 } }] }), { status: 200 }),
    ));

    const [r] = await upload(noFeature, "List A", "Example City");

    expect(r).toMatchObject({ geocoded: 1, changed: 1 });
    expect(byName("Place A")!.updatedAt).toBeDefined();
    vi.unstubAllGlobals();
  });

  it("counts the offline pin an OLD coordinate-less entry gains as a change", async () => {
    // The store holds entries imported before any of this existed. A re-upload now backfills them
    // from their own saved URL — which is a real change to the file and must be badged as one.
    fs.mkdirSync(path.join(root, "places"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "places", "list-a--place-a.md"),
      `---\ntype: place\nname: Place A\nurl: ${PLACE_A_URL}\nsource_list: List A\n---\n`,
    );

    const [r] = await upload(one);

    expect(r).toMatchObject({ updated: 1, changed: 1 });
    expect(byName("Place A")).toMatchObject({ approx: true });
    expect(byName("Place A")!.updatedAt).toBeDefined();
  });

  it("does not invent an importedAt for an entry that predates the field", async () => {
    // Stamp-free, already pinned AND already named, so the re-upload genuinely changes nothing.
    // An entry still missing any of the three would be changed by a backfill and would prove
    // nothing about stamps.
    fs.mkdirSync(path.join(root, "places"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "places", "list-a--place-a.md"),
      `---\ntype: place\nname: Place A\ncity: New York City\ncountry: United States\nlat: 40.7319\nlon: -73.9577\nurl: ${PLACE_A_URL}\nsource_list: List A\n---\n`,
    );

    const [r] = await upload(one);

    expect(r).toMatchObject({ added: 0, updated: 1, changed: 0 });
    expect(byName("Place A")!.importedAt).toBeUndefined();
    expect(byName("Place A")!.updatedAt).toBeUndefined();
  });

  it("stamps a pasted list, and re-pasting marks it updated", async () => {
    await commitPaste({ domain: "music", name: "Playlist B", text: "a" });
    const first = listDomain("music")[0]!.entry!;
    expect(first.importedAt).toBeDefined();
    expect(first.updatedAt).toBeUndefined();

    await commitPaste({ domain: "music", name: "Playlist B", text: "a\nb" });
    const second = listDomain("music")[0]!.entry!;
    expect(second.importedAt).toBe(first.importedAt);
    expect(second.updatedAt).toBeDefined();
  });
});

describe("country", () => {
  it("flows from the upload form onto every entry of that list", async () => {
    await upload(raw([["Place A", "", PLACE_A_URL]]), "List A", "Example City", "USA");
    expect(byName("Place A")).toMatchObject({ city: "Example City", country: "USA" });
  });

  it("flows from the paste form too", async () => {
    await commitPaste({ domain: "places", name: "Vera", city: "Lisboa", country: "Portugal", text: "Cervejaria" });
    const entry = listDomain("places")[0]!.entry as { country?: string };
    expect(entry.country).toBe("Portugal");
  });

  it("backfills a list that predates the field, without re-uploading anything", async () => {
    await upload(raw([["Place A", "", PLACE_A_URL], ["Place B", "", PLACE_B_URL]]));
    const filesBefore = listAPlaces().map((s) => s.file).sort();

    const r = await setListCountry({ listName: "List A", country: "USA" });

    expect(r).toMatchObject({ listName: "List A", changed: 2, alreadySet: 0 });
    expect(listAPlaces().every((s) => (s.entry as { country?: string }).country === "USA")).toBe(true);
    // A metadata fix must not move a file — the filename is the upsert key.
    expect(listAPlaces().map((s) => s.file).sort()).toEqual(filesBefore);
  });

  it("says so when there was nothing left to do, rather than reporting a silent success", async () => {
    await upload(raw([["Place A", "", PLACE_A_URL]]));
    await setListCountry({ listName: "List A", country: "USA" });

    expect(await setListCountry({ listName: "List A", country: "USA" }))
      .toMatchObject({ changed: 0, alreadySet: 1 });
  });

  it("leaves the freshness stamps alone — attaching a country is not a change to the place", async () => {
    await upload(raw([["Place A", "", PLACE_A_URL]]));
    const before = byName("Place A")!;

    await setListCountry({ listName: "List A", country: "USA" });

    expect(byName("Place A")!.importedAt).toBe(before.importedAt);
    expect(byName("Place A")!.updatedAt).toBeUndefined();
  });

  it("touches only the list it was given", async () => {
    await upload(raw([["Place A", "", PLACE_A_URL]]), "List A");
    await upload(raw([["Place D", "", PARIS_URL]]), "List B");

    await setListCountry({ listName: "List A", country: "USA" });

    const paris = listDomain("places").find((s) => s.entry?.sourceList === "List B")!;
    // Derived at import, and NOT overwritten by a country set on a different list.
    expect((paris.entry as { country?: string }).country).toBe("France");
  });

  it("insists on a country", async () => {
    await expect(setListCountry({ listName: "List A", country: "  " })).rejects.toThrow(/land/);
  });
});

describe("a list not in the batch", () => {
  it("is never touched", async () => {
    await upload(raw([["Place A", "", PLACE_A_URL]]), "List A");
    await upload(raw([["Place D", "", PLACE_B_URL]]), "List B");

    // re-uploading List A alone, now empty of Place D, must not disturb List B
    await upload(raw([["Place A", "", PLACE_A_URL]]), "List A");

    expect(listDomain("places").filter((s) => s.entry?.sourceList === "List B")).toHaveLength(1);
  });
});

describe("the preview", () => {
  it("shows +/~/- per list before anything is written", async () => {
    await upload(raw([["Place A", "", PLACE_A_URL], ["Place B", "", PLACE_B_URL]]));

    const [p] = await previewTakeout({
      lists: [{ listName: "List A", csvText: raw([["Place A", "", PLACE_A_URL], ["Place C", "", SUP1_URL]]) }],
    });

    expect(p).toMatchObject({ listName: "List A", added: 1, updated: 1, removed: 1 });
    expect(p.removedNames).toEqual(["Place B"]);
  });

  it("writes nothing", async () => {
    await previewTakeout({ lists: [{ listName: "List A", csvText: raw([["Place A", "", PLACE_A_URL]]) }] });
    expect(fs.existsSync(path.join(root, "places"))).toBe(false);
  });

  it("reports where coordinates would come from", async () => {
    await upload(resolved([["Place A", "", "40.6908", "-73.9618", PLACE_A_URL]]));

    const [p] = await previewTakeout({
      lists: [{ listName: "List A", csvText: raw([["Place A", "", PLACE_A_URL], ["Place B", "", PLACE_B_URL]]) }],
    });

    expect(p.withCoords).toBe(0);   // the raw upload carries none
    expect(p.keepsCoords).toBe(1);  // Place A keeps the pin already stored
    expect(p.needsLookup).toBe(1);  // Place B has none from either side
  });

  it("covers several lists in one batch", async () => {
    const previews = await previewTakeout({
      lists: [
        { listName: "List A", csvText: raw([["Place A", "", PLACE_A_URL]]) },
        { listName: "List B", csvText: raw([["Place D", "", PLACE_B_URL]]) },
      ],
    });
    expect(previews.map((p) => p.listName)).toEqual(["List A", "List B"]);
  });

  it("insists on a list name — it is what ties an upload to what is already stored", async () => {
    await expect(previewTakeout({ lists: [{ listName: " ", csvText: raw([]) }] })).rejects.toThrow(/navn/);
  });
});

describe("import-time coordinate resolution — the ladder", () => {
  /** A Places Text Search answer, in the shape the New API returns it. */
  const hit = (name: string, lat: number, lon: number, id = "ChIJtest") =>
    ({ id, displayName: { text: name }, location: { latitude: lat, longitude: lon }, formattedAddress: `${name}, Example City, EC, USA` });
  const answer = (...places: unknown[]) =>
    vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ places }), { status: 200 }));

  it("still pins from the saved URL alone when no Places key is configured", async () => {
    // Before this stored nothing at all. Rungs 1 and 3 need no key, so "no key" must mean
    // "no exact matches", not "no pins".
    const [r] = await upload(raw([["Place A", "", PLACE_A_URL]]));

    expect(r.geocoded).toBe(0);
    expect(r.approximate[0]).toMatchObject({ name: "Place A" });
    expect(byName("Place A")).toMatchObject({ approx: true });
    expect(byName("Place A")!.lat).toBeCloseTo(40.7319, 2);
  });

  it("accepts an exact-name hit near the decoded cell, and keeps the place id", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "k";
    const fetchMock = answer(hit("Place A", 40.6908, -73.9618, "ChIJplaceA"));
    vi.stubGlobal("fetch", fetchMock);

    const [r] = await upload(raw([["Place A", "", PLACE_A_URL]]), "List A", "Example City");

    expect(r.geocoded).toBe(1);
    expect(byName("Place A")).toMatchObject({
      lat: 40.6908,
      placeId: "ChIJplaceA",
      address: "Place A, Example City, EC, USA",
    });
    // The place id is the durable half of the prize: it must survive the round trip to disk.
    expect(byName("Place A")!.approx).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("biases the search by the decoded cell rather than by the operator's city string", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "k";
    const fetchMock = answer(hit("Place A", 40.6908, -73.9618));
    vi.stubGlobal("fetch", fetchMock);

    await upload(raw([["Place A", "", PLACE_A_URL]]), "List A", "Example City");

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body.textQuery).toBe("Place A");               // no ", Example City" appended
    expect(body.locationBias.circle.center.latitude).toBeCloseTo(40.7319, 2);
    vi.unstubAllGlobals();
  });

  it("falls back to the city string when the URL carries no feature id", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "k";
    const fetchMock = answer(hit("Place A", 40.6908, -73.9618));
    vi.stubGlobal("fetch", fetchMock);

    await upload(raw([["Place A", "", NO_FEATURE_URL]]), "List A", "Example City");

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body.textQuery).toBe("Place A, Example City");
    expect(body.locationBias).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("REFUSES a near-name-match rather than storing a wrong pin", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "k";
    vi.stubGlobal("fetch", answer(hit("Place A Pizzeria Napoletana", 40.69, -73.96)));

    const [r] = await upload(raw([["Place A", "", PLACE_A_URL]]), "List A", "Example City");

    expect(r.geocoded).toBe(0);
    expect(r.approximate[0]!.reason).toContain("ikke samme navn");
    expect(byName("Place A")).toMatchObject({ approx: true });   // rung 3 still gives it a pin
    vi.unstubAllGlobals();
  });

  it("REFUSES an exactly-named match in the wrong part of the world", async () => {
    // THE defect this rule exists for: in a first audit, 51 of 928 stored pins were a same-named
    // place on another continent — a place saved in one city's list, pinned in another continent. The name
    // matches perfectly; only the distance from the decoded cell gives it away.
    process.env.GOOGLE_PLACES_API_KEY = "k";
    vi.stubGlobal("fetch", answer(hit("Place A", 37.7655, -122.4210)));

    const [r] = await upload(raw([["Place A", "", PLACE_A_URL]]), "List A", "Example City");

    expect(r.geocoded).toBe(0);
    expect(r.approximate[0]!.reason).toMatch(/km unna/);
    expect(byName("Place A")!.lat).toBeCloseTo(40.7319, 2);      // the decoded cell, not the far-away hit
    expect(byName("Place A")!.placeId).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("prefers the nearest exact-name match when a chain returns several", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "k";
    vi.stubGlobal("fetch", answer(
      hit("Place A", 34.05, -118.24, "ChIJfar"),        // same name, Los Angeles — ranked first
      hit("Place A", 40.6907, -73.9618, "ChIJnear"),    // same name, four blocks from the cell
    ));

    const [r] = await upload(raw([["Place A", "", PLACE_A_URL]]), "List A", "Example City");

    expect(r.geocoded).toBe(1);
    expect(byName("Place A")).toMatchObject({ placeId: "ChIJnear" });
    vi.unstubAllGlobals();
  });

  it("leaves a place with neither a match nor a feature id genuinely unresolved", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "k";
    vi.stubGlobal("fetch", answer());

    const [r] = await upload(raw([["Place A", "", NO_FEATURE_URL]]), "List A", "Example City");

    expect(r.unresolved[0]).toMatchObject({ name: "Place A", reason: "ingen treff" });
    expect(byName("Place A")?.lat).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("survives a failing lookup — one bad row must not sink the import", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    const [r] = await upload(raw([["Place A", "", PLACE_A_URL]]), "List A", "Example City");

    expect(r.added).toBe(1);
    expect(r.approximate[0]!.reason).toContain("500");
    expect(byName("Place A")).toMatchObject({ approx: true });
    vi.unstubAllGlobals();
  });

  it("never looks up a row that already has coordinates", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "k";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await upload(resolved([["Place A", "", "40.6908", "-73.9618", PLACE_A_URL]]), "List A", "Example City");

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("repairContradictedPins — the pin audit", () => {
  /** A stored place whose pin is on the wrong continent: saved in one city's list, pinned on another continent. */
  const wronglyPinned = () => {
    fs.mkdirSync(path.join(root, "places"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "places", "list-c--place-e.md"),
      `---\ntype: place\nname: Place E\nlat: 37.7655\nlon: -122.4210\nurl: https://www.google.com/maps/place/Place+E/data=!4m2!3m1!1s0x47a84e3b6d4b45af:0x6c2e8f1a3d5b7094\nsource_list: List C\n---\n`,
    );
  };
  const placeE = () =>
    listDomain("places").find((s) => s.entry?.name === "Place E")?.entry as
      | { lat?: number; lon?: number; approx?: boolean; placeId?: string }
      | undefined;

  it("reports without writing anything by default", async () => {
    wronglyPinned();

    const r = await repairContradictedPins();

    expect(r.found).toBe(1);
    expect(r.rows[0]).toMatchObject({ name: "Place E", sourceList: "List C" });
    expect(r.rows[0]!.wrongBy).toBeGreaterThan(9_000_000);
    expect(placeE()!.lat).toBe(37.7655);   // untouched — a dry run must not rewrite the store
  });

  it("replaces a contradicted pin with a confirmed match, and keeps the place id", async () => {
    wronglyPinned();
    process.env.GOOGLE_PLACES_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ places: [{ id: "ChIJplaceE", displayName: { text: "Place E" }, location: { latitude: 52.5391, longitude: 13.4392 } }] }), { status: 200 }),
    ));

    const r = await repairContradictedPins({ dryRun: false });

    expect(r).toMatchObject({ found: 1, exact: 1, kept: 0, searches: 1 });
    expect(placeE()).toMatchObject({ lat: 52.5391, placeId: "ChIJplaceE" });
    expect(placeE()!.approx).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("LEAVES THE PIN ALONE when nothing confirms a better answer", async () => {
    // The audit finds a disagreement; it does not know which side is wrong. Usually the pin is —
    // but in a real store 4 of 59 flagged entries have a good pin and a feature id whose cell is
    // in the wrong country. Writing the decoded cell for those would replace a correct pin with a
    // wrong one, turning an audit into a corruption. Only a confirmed match may overwrite.
    wronglyPinned();
    process.env.GOOGLE_PLACES_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ places: [] }), { status: 200 })));

    const r = await repairContradictedPins({ dryRun: false });

    expect(r).toMatchObject({ found: 1, exact: 0, kept: 1 });
    expect(r.rows[0]).toMatchObject({ outcome: "kept" });
    expect(placeE()!.lat).toBe(37.7655);        // exactly as it was — not the decoded cell
    expect(placeE()!.approx).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("REFUSES a confirmed match that sits further from the list than the pin already there", async () => {
    // The residual hole the two earlier guards leave: when the LINK is the wrong side, rung 2 is
    // biased at the wrong place, and a genuine same-named place near that bias passes both the
    // name and the distance test. Real case — a place is correctly pinned in its own city, its
    // link decodes 159 km away, and a real namesake sits near the decode.
    //
    // Here: a list whose other places are all in one city, holding a correctly-pinned entry whose
    // link decodes to another continent, and a search that confirms a real namesake there.
    fs.mkdirSync(path.join(root, "places"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "places", "list-c--sibling.md"),
      `---\ntype: place\nname: Nabo\nlat: 52.5081\nlon: 13.4373\nsource_list: List C\n---\n`,
    );
    fs.writeFileSync(
      path.join(root, "places", "list-c--place-e.md"),
      `---\ntype: place\nname: Place E\nlat: 52.5176\nlon: 13.4432\nurl: https://www.google.com/maps/place/Place+E/data=!4m2!3m1!1s0x8085808c0d0d0d0d:0x1\nsource_list: List C\n---\n`,
    );
    process.env.GOOGLE_PLACES_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ places: [{ id: "ChIJsf", displayName: { text: "Place E" }, location: { latitude: 37.7655, longitude: -122.4210 } }] }), { status: 200 }),
    ));

    const r = await repairContradictedPins({ dryRun: false });

    expect(r).toMatchObject({ exact: 0, kept: 1 });
    expect(r.rows[0]!.reason).toContain("lenger fra resten av lista");
    expect(placeE()!.lat).toBe(52.5176);          // the pin it already had
    expect(placeE()!.placeId).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("changes nothing at all when no Places key is configured — it cannot confirm anything", async () => {
    wronglyPinned();

    const r = await repairContradictedPins({ dryRun: false });

    expect(r).toMatchObject({ found: 1, exact: 0, kept: 1, searches: 0 });
    expect(placeE()!.lat).toBe(37.7655);
  });

  it("finds nothing to do in a store whose pins agree with their links", async () => {
    await upload(resolved([["Place A", "", "40.7319", "-73.9577", PLACE_A_URL]]), "List A", "Example City");

    expect(await repairContradictedPins()).toMatchObject({ found: 0, rows: [] });
  });
});

describe("city and country, derived", () => {
  it("names a place from its pin, so neither field has to be typed", async () => {
    await upload(raw([["Place A", "", PLACE_A_URL]]), "List A");

    expect(byName("Place A")).toMatchObject({ city: "New York City", country: "United States" });
  });

  it("treats what the operator typed as an override, not a default", async () => {
    await upload(raw([["Place A", "", PLACE_A_URL]]), "List A", "Example Borough", "USA");

    expect(byName("Place A")).toMatchObject({ city: "Example Borough", country: "USA" });
  });

  it("fills only the half that is missing", async () => {
    await upload(raw([["Place A", "", PLACE_A_URL]]), "List A", "", "USA");

    expect(byName("Place A")).toMatchObject({ city: "New York City", country: "USA" });
  });

  it("says nothing about a place it could not pin", async () => {
    await upload(raw([["Place A", "", NO_FEATURE_URL]]), "List A");

    expect(byName("Place A")!.city).toBeUndefined();
  });

  it("backfills what is already stored, without stamping it as changed", async () => {
    fs.mkdirSync(path.join(root, "places"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "places", "list-a--place-a.md"),
      `---\ntype: place\nname: Place A\nlat: 40.7319\nlon: -73.9577\nsource_list: List A\n---\n`,
    );

    const r = await deriveMissingPlaceNames();

    expect(r).toMatchObject({ named: 1 });
    expect(byName("Place A")).toMatchObject({ city: "New York City", country: "United States" });
    // Bookkeeping about where a place already was is not a change to the place — badging it
    // "endret" would drown the signal the badge exists for.
    expect(byName("Place A")!.updatedAt).toBeUndefined();
  });

  it("counts what it left alone, so 'already done' is not silence", async () => {
    // One upload, two rows: a second upload of the same list is a DIFF, so it would have removed
    // the first row rather than adding to it.
    await upload(raw([["Place A", "", PLACE_A_URL], ["Ukjent", "", NO_FEATURE_URL]]), "List A");

    expect(await deriveMissingPlaceNames()).toMatchObject({ named: 0, alreadyNamed: 1, noPin: 1 });
  });
});

describe("search bias for a place that cannot locate itself", () => {
  it("biases by the list's own centroid when the URL carries no feature id", async () => {
    await upload(resolved([["Place B", "", "40.7604", "-73.9801", PLACE_B_URL]]), "List A");

    process.env.GOOGLE_PLACES_API_KEY = "k";
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ places: [{ id: "ChIJx", displayName: { text: "Place A" }, location: { latitude: 40.6908, longitude: -73.9618 } }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await upload(raw([["Place B", "", PLACE_B_URL], ["Place A", "", NO_FEATURE_URL]]), "List A");

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body.locationBias.circle.center.latitude).toBeCloseTo(40.76, 1);
    vi.unstubAllGlobals();
  });

  it("never lets a centroid become a PIN — it is where the others are, not where this one is", async () => {
    await upload(resolved([["Place B", "", "40.7604", "-73.9801", PLACE_B_URL]]), "List A");

    process.env.GOOGLE_PLACES_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ places: [] }), { status: 200 })));

    const [r] = await upload(raw([["Place B", "", PLACE_B_URL], ["Place A", "", NO_FEATURE_URL]]), "List A");

    expect(byName("Place A")?.lat).toBeUndefined();
    expect(r.unresolved.map((u) => u.name)).toContain("Place A");
    vi.unstubAllGlobals();
  });
});

describe("commitPaste", () => {
  it("puts a pasted playlist in music/ as ONE file with the lines as items", async () => {
    await commitPaste({ domain: "music", name: "Playlist A", text: "- Album One\n- Album Two\n" });
    const [stored] = listDomain("music");
    expect(stored.file).toBe("playlist-a.md");
    expect(stored.entry && "items" in stored.entry ? stored.entry.items : []).toEqual(["Album One", "Album Two"]);
  });

  it("splits a pasted PLACES list into one entry per line", async () => {
    await commitPaste({ domain: "places", name: "Anbefalt av Vera", city: "Example City", text: "Place A\nPlace B\n" });
    const places = listDomain("places");
    expect(places.map((p) => p.entry?.name).sort()).toEqual(["Place A", "Place B"]);
    expect(places.every((p) => p.entry && "city" in p.entry && p.entry.city === "Example City")).toBe(true);
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
    await commitPaste({ domain: "music", name: "Playlist B", text: "a" });
    await removeEntry({ domain: "music", file: "playlist-b.md" });
    expect(listDomain("music")).toEqual([]);
  });

  it("refuses a filename that would escape the store", async () => {
    await expect(removeEntry({ domain: "music", file: "../../../etc/passwd" })).rejects.toThrow(/unsafe/i);
  });
});

describe("every action is its own auth boundary", () => {
  it("refuses when there is no valid session, even though middleware gates the page", async () => {
    verifyMock.mockResolvedValue(null);
    const lists = [{ listName: "List A", csvText: raw([["Place A", "", PLACE_A_URL]]) }];
    await expect(previewTakeout({ lists })).rejects.toThrow(/unauthenticated/);
    await expect(commitTakeout({ lists })).rejects.toThrow(/unauthenticated/);
    await expect(commitPaste({ domain: "music", name: "L", text: "a" })).rejects.toThrow(/unauthenticated/);
    await expect(removeEntry({ domain: "music", file: "a.md" })).rejects.toThrow(/unauthenticated/);
  });

  it("writes nothing when unauthenticated", async () => {
    verifyMock.mockResolvedValue(null);
    await upload(raw([["Place A", "", PLACE_A_URL]])).catch(() => {});
    expect(fs.existsSync(path.join(root, "places"))).toBe(false);
  });
});
