// Ported from services/marcel/tests/google-places.test.ts (review fix, finding 10).
// lib/google-places.ts was copied UNCHANGED into eve-marcel (Task 6) but its test suite was
// never re-ported. Import path is the only change — the logic under test is byte-identical.
import { describe, it, expect } from "vitest";
import { makeGooglePlaces, CATEGORY_TYPES } from "../lib/google-places.js";

const PLACE = {
  id: "ChIJx", displayName: { text: "Herr & Fru", languageCode: "no" },
  location: { latitude: 59.2525, longitude: 10.4186 },
  rating: 4.5, userRatingCount: 194, priceLevel: "PRICE_LEVEL_MODERATE",
  currentOpeningHours: { openNow: true }, photos: [{ name: "places/ChIJx/photos/p1" }],
};

function fakeFetch(responses: { status?: number; json?: unknown; contentType?: string; bytes?: Uint8Array }[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses.shift() ?? { json: {} };
    return {
      ok: (r.status ?? 200) < 400, status: r.status ?? 200,
      headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? r.contentType ?? "application/json" : null) },
      json: async () => r.json ?? {},
      arrayBuffer: async () => (r.bytes ?? new Uint8Array()).buffer,
    } as unknown as Response;
  }) as typeof fetch;
  return { f, calls };
}

describe("makeGooglePlaces", () => {
  it("searchText posts textQuery + locationBias and sends the EXACT field mask; hits normalized", async () => {
    const { f, calls } = fakeFetch([{ json: { places: [PLACE] } }]);
    const g = makeGooglePlaces({ apiKey: "K", fetch: f });
    const hits = await g.searchText("lunsj", { near: { lat: 59.25, lon: 10.41 }, radiusM: 1500 });
    expect(calls[0].url).toBe("https://places.googleapis.com/v1/places:searchText");
    const headers = calls[0].init!.headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe("K");
    expect(headers["X-Goog-FieldMask"]).toBe(
      "places.id,places.displayName,places.location,places.rating,places.userRatingCount,places.currentOpeningHours,places.priceLevel,places.photos",
    );
    const body = JSON.parse(String(calls[0].init!.body));
    expect(body).toMatchObject({ textQuery: "lunsj", pageSize: 8, languageCode: "no",
      locationBias: { circle: { center: { latitude: 59.25, longitude: 10.41 }, radius: 1500 } } });
    expect(hits[0]).toEqual({ id: "ChIJx", name: "Herr & Fru", lat: 59.2525, lon: 10.4186,
      rating: 4.5, userRatingCount: 194, priceLevel: "€€", openNow: true, photoRef: "places/ChIJx/photos/p1" });
  });

  it("searchNearby posts includedTypes + locationRestriction", async () => {
    const { f, calls } = fakeFetch([{ json: { places: [] } }]);
    const g = makeGooglePlaces({ apiKey: "K", fetch: f });
    await g.searchNearby(CATEGORY_TYPES.grocery, { lat: 59.25, lon: 10.41 }, 900);
    expect(calls[0].url).toBe("https://places.googleapis.com/v1/places:searchNearby");
    const body = JSON.parse(String(calls[0].init!.body));
    expect(body).toMatchObject({ includedTypes: ["supermarket", "grocery_store", "convenience_store"], maxResultCount: 8,
      locationRestriction: { circle: { center: { latitude: 59.25, longitude: 10.41 }, radius: 900 } } });
  });

  it("non-OK, malformed and thrown responses all → []", async () => {
    const g1 = makeGooglePlaces({ apiKey: "K", fetch: fakeFetch([{ status: 403, json: { error: {} } }]).f });
    expect(await g1.searchText("x")).toEqual([]);
    const g2 = makeGooglePlaces({ apiKey: "K", fetch: (async () => { throw new Error("boom"); }) as unknown as typeof fetch });
    expect(await g2.searchText("x")).toEqual([]);
    const g3 = makeGooglePlaces({ apiKey: "K", fetch: fakeFetch([{ json: { places: [{ id: "no-name" }] } }]).f });
    expect(await g3.searchText("x")).toEqual([]); // hit without displayName/location dropped
  });

  it("photo() fetches media bytes; non-image content-type → null", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { f, calls } = fakeFetch([{ contentType: "image/jpeg", bytes }]);
    const g = makeGooglePlaces({ apiKey: "K", fetch: f });
    const buf = await g.photo("places/ChIJx/photos/p1", 640);
    expect(calls[0].url).toBe("https://places.googleapis.com/v1/places/ChIJx/photos/p1/media?maxWidthPx=640&key=K");
    expect([...buf!]).toEqual([1, 2, 3]);
    const gHtml = makeGooglePlaces({ apiKey: "K", fetch: fakeFetch([{ contentType: "text/html" }]).f });
    expect(await gHtml.photo("p")).toBeNull();
  });
});
