// Ported from services/marcel/tests/places-strava.test.ts (review fix, finding 10).
// lib/places.ts, lib/geo.ts, and lib/strava.ts were all copied UNCHANGED into eve-marcel
// (Task 6) but this test suite was never re-ported. Import paths are the only change — the
// logic under test is byte-identical.
import { describe, it, expect, vi } from "vitest";
import { makePlaces, makeEta, mapsDirectionsUrl, mapsSearchUrl, mapsPlaceUrl } from "../lib/places.js";
import { makeReverseGeocode } from "../lib/geo.js";
import { makeStrava, boundsAround, type StravaTokens } from "../lib/strava.js";

const HOUSE = { lat: 43.1748, lon: 5.6045 }; // La Ciotat

describe("places — deterministic map links", () => {
  it("defaults to a plain place link (no origin) so Google routes from the phone", async () => {
    const geocode = vi.fn(async () => ({ lat: 43.2138, lon: 5.3524 }));
    const places = makePlaces({ geocode, eta: async () => 34 });

    const hit = await places.lookup("Chez Fonfon", { near: "La Ciotat" });

    expect(geocode).toHaveBeenCalledWith("Chez Fonfon, La Ciotat");
    expect(hit!.mapsUrl).toContain("Chez%20Fonfon");
    expect(hit!.directionsUrl).not.toContain("origin="); // Google uses current location
    expect(hit!.etaMinutes).toBeUndefined(); // no origin → no fabricated ETA
  });

  it("adds a real ETA and an origin-bearing link when the group says where they are and how", async () => {
    const geocode = vi.fn(async () => ({ lat: 43.2138, lon: 5.3524 }));
    const eta = vi.fn(async () => 18);
    const places = makePlaces({ geocode, eta });

    const hit = await places.lookup("Calanque de Figuerolles", {
      near: "La Ciotat",
      origin: HOUSE,
      mode: "walking",
    });

    expect(eta).toHaveBeenCalledWith(HOUSE, { lat: 43.2138, lon: 5.3524 }, "walking");
    expect(hit).toMatchObject({ etaMinutes: 18, mode: "walking" });
    expect(hit!.directionsUrl).toContain("origin=43.1748,5.6045");
    expect(hit!.directionsUrl).toContain("travelmode=walking");
  });

  it("survives a routing outage — link still works, ETA simply omitted", async () => {
    const places = makePlaces({ geocode: async () => ({ lat: 43.21, lon: 5.46 }), eta: async () => undefined });
    const hit = await places.lookup("Calanque de Sugiton", { origin: HOUSE, mode: "bicycling" });
    expect(hit!.etaMinutes).toBeUndefined();
    expect(hit!.directionsUrl).toContain("travelmode=bicycling");
  });

  it("returns null when the place cannot be resolved (no hallucinated link)", async () => {
    const places = makePlaces({ geocode: async () => null });
    expect(await places.lookup("Atlantis")).toBeNull();
  });

  it("ETA maps travel modes to Valhalla costings and degrades on error", async () => {
    const calls: string[] = [];
    const ok = makeEta((async (url: string) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ trip: { summary: { time: 1080 } } }) };
    }) as never);
    expect(await ok(HOUSE, { lat: 43.2, lon: 5.4 }, "walking")).toBe(18);
    expect(decodeURIComponent(calls[0])).toContain('"costing":"pedestrian"');

    const broken = makeEta((async () => {
      throw new Error("network");
    }) as never);
    expect(await broken(HOUSE, { lat: 43.2, lon: 5.4 }, "driving")).toBeUndefined();
  });

  it("url builders are stable", () => {
    expect(mapsSearchUrl("Le Panier, Marseille")).toBe(
      "https://www.google.com/maps/search/?api=1&query=Le%20Panier%2C%20Marseille",
    );
    expect(mapsDirectionsUrl({ lat: 43.2, lon: 5.4 }, { origin: HOUSE, mode: "bicycling" })).toContain("travelmode=bicycling");
  });

  it("directions destination is name-based (label + nearLabel) so Google resolves the business page — not raw coordinates", () => {
    const url = mapsDirectionsUrl({ lat: 59.2, lon: 10.4 }, { label: "Kiwi", nearLabel: "Nøtterøy" });
    expect(url).toContain("Kiwi%2C%20N%C3%B8tter%C3%B8y");
    expect(url).not.toMatch(/destination=59\.2/);
  });

  it("directions destination is label-only when no nearLabel is known", () => {
    const url = mapsDirectionsUrl({ lat: 59.2, lon: 10.4 }, { label: "Kiwi" });
    expect(url).toContain("destination=Kiwi");
    expect(url).not.toMatch(/destination=59\.2/);
  });

  it("directions destination falls back to raw coordinates only when no label is available at all", () => {
    const url = mapsDirectionsUrl({ lat: 59.2, lon: 10.4 });
    expect(url).toContain("destination=59.2%2C10.4");
  });

  it("mapsPlaceUrl builds the exact-place link (name + place_id)", () => {
    expect(mapsPlaceUrl("Herr & Fru", "ChIJx")).toBe(
      "https://www.google.com/maps/search/?api=1&query=Herr%20%26%20Fru&query_place_id=ChIJx",
    );
  });

  it("mapsDirectionsUrl carries destination_place_id when placeId is known", () => {
    expect(mapsDirectionsUrl({ lat: 1, lon: 2 }, { label: "Kiwi", nearLabel: "Nøtterøy", placeId: "ChIJk", mode: "walking" })).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=Kiwi%2C%20N%C3%B8tter%C3%B8y&destination_place_id=ChIJk&travelmode=walking",
    );
  });

  it("places.lookup threads nearLabel into the directions link — never a bare-coordinate destination when a name is known", async () => {
    const geocode = vi.fn(async () => ({ lat: 59.2, lon: 10.4 }));
    const places = makePlaces({ geocode, eta: async () => undefined });

    const hit = await places.lookup("Kiwi", { near: "Nøtterøy" });

    expect(hit!.directionsUrl).toContain("Kiwi%2C%20N%C3%B8tter%C3%B8y");
    expect(hit!.directionsUrl).not.toMatch(/destination=59\.2/);
  });

  it("nearPoint re-scopes the search to the pin's locality (reverse-geocoded)", async () => {
    const reverse = vi.fn(async () => "Aix-en-Provence");
    const geocode = vi.fn(async () => ({ lat: 43.53, lon: 5.44 }));
    const places = makePlaces({ geocode, eta: async () => undefined, reverse });

    const hit = await places.lookup("boulangerie", { near: "La Ciotat", nearPoint: { lat: 43.53, lon: 5.44 } });

    expect(reverse).toHaveBeenCalledWith({ lat: 43.53, lon: 5.44 });
    expect(geocode).toHaveBeenNthCalledWith(1, "boulangerie, Aix-en-Provence");
    expect(hit!.mapsUrl).toContain("Aix-en-Provence");
  });

  it("falls back to the trip-destination bias when reverse geocoding fails", async () => {
    const reverse = vi.fn(async () => null);
    const geocode = vi.fn(async () => ({ lat: 43.17, lon: 5.6 }));
    const places = makePlaces({ geocode, eta: async () => undefined, reverse });

    await places.lookup("boulangerie", { near: "La Ciotat", nearPoint: { lat: 43.53, lon: 5.44 } });

    expect(geocode).toHaveBeenNthCalledWith(1, "boulangerie, La Ciotat");
  });

  it("without nearPoint behavior is unchanged", async () => {
    const reverse = vi.fn(async () => "Aix-en-Provence");
    const geocode = vi.fn(async () => ({ lat: 43.17, lon: 5.6 }));
    const places = makePlaces({ geocode, eta: async () => undefined, reverse });

    await places.lookup("boulangerie", { near: "La Ciotat" });

    expect(reverse).not.toHaveBeenCalled();
    expect(geocode).toHaveBeenNthCalledWith(1, "boulangerie, La Ciotat");
  });

  it("makeReverseGeocode extracts city/town/village and returns null on failure", async () => {
    const fetchOk = vi.fn(async () => ({ ok: true, json: async () => ({ address: { town: "Aix-en-Provence" } }) })) as never;
    const reverse = makeReverseGeocode({ userAgent: "test-agent", fetch: fetchOk });
    expect(await reverse({ lat: 43.53, lon: 5.44 })).toBe("Aix-en-Provence");

    const fetchNotOk = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as never;
    expect(await makeReverseGeocode({ userAgent: "test-agent", fetch: fetchNotOk })({ lat: 0, lon: 0 })).toBeNull();

    const fetchThrows = vi.fn(async () => {
      throw new Error("network");
    }) as never;
    expect(await makeReverseGeocode({ userAgent: "test-agent", fetch: fetchThrows })({ lat: 0, lon: 0 })).toBeNull();
  });
});

describe("places.lookup with google", () => {
  const gHit = { id: "ChIJk", name: "Kiwi Teie", lat: 59.25, lon: 10.41, rating: 4.1, userRatingCount: 30, photoRef: "places/ChIJk/photos/p" };

  it("google-first: canonical name, place-id links, rating carried; geocode untouched", async () => {
    const geocode = vi.fn(async () => ({ lat: 1, lon: 2 }));
    const google = { searchText: vi.fn(async () => [gHit]), searchNearby: vi.fn(), photo: vi.fn() };
    const places = makePlaces({ geocode, google: google as never });
    const link = await places.lookup("kiwi", { near: "Nøtterøy" });
    expect(google.searchText).toHaveBeenCalledWith("kiwi, Nøtterøy", { near: undefined, radiusM: 30000 });
    expect(geocode).not.toHaveBeenCalled();
    expect(link).toMatchObject({
      name: "Kiwi Teie", lat: 59.25, lon: 10.41, placeId: "ChIJk", rating: 4.1, userRatingCount: 30,
      photoRef: "places/ChIJk/photos/p",
      mapsUrl: "https://www.google.com/maps/search/?api=1&query=Kiwi%20Teie&query_place_id=ChIJk",
    });
    expect(link!.directionsUrl).toContain("destination_place_id=ChIJk");
    expect(link!.directionsUrl).toContain(`destination=${encodeURIComponent("Kiwi Teie, Nøtterøy")}`);
  });

  it("google present but empty → falls through to the geocode path with the OLD link shapes", async () => {
    const geocode = vi.fn(async () => ({ lat: 1, lon: 2 }));
    const google = { searchText: vi.fn(async () => []), searchNearby: vi.fn(), photo: vi.fn() };
    const places = makePlaces({ geocode, google: google as never });
    const link = await places.lookup("kiwi", { near: "Nøtterøy" });
    expect(link).toMatchObject({ name: "kiwi", lat: 1, lon: 2 });
    expect(link!.mapsUrl).toBe("https://www.google.com/maps/search/?api=1&query=kiwi%2C%20N%C3%B8tter%C3%B8y");
    expect(link!.placeId).toBeUndefined();
  });

  it("nearPoint feeds locationBias AND still reverse-scopes the text query", async () => {
    const geocode = vi.fn(async () => null);
    const reverse = vi.fn(async () => "Teie");
    const google = { searchText: vi.fn(async () => []), searchNearby: vi.fn(), photo: vi.fn() };
    await makePlaces({ geocode, reverse, google: google as never }).lookup("bakeri", { nearPoint: { lat: 59.2, lon: 10.4 } });
    expect(google.searchText).toHaveBeenCalledWith("bakeri, Teie", { near: { lat: 59.2, lon: 10.4 }, radiusM: 30000 });
  });
});

describe("strava", () => {
  const tokens = (expiresAt: number): StravaTokens => ({ accessToken: "at-1", refreshToken: "rt-1", expiresAt });

  it("bounding box brackets the centre point", () => {
    const b = boundsAround(43.1748, 5.6045, 15).split(",").map(Number);
    expect(b[0]).toBeLessThan(43.1748);
    expect(b[2]).toBeGreaterThan(43.1748);
    expect(b[1]).toBeLessThan(5.6045);
    expect(b[3]).toBeGreaterThan(5.6045);
  });

  it("refreshes an expired token and PERSISTS the rotated refresh token", async () => {
    const saved: StravaTokens[] = [];
    const calls: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).includes("oauth/token")) {
        return {
          ok: true,
          json: async () => ({ access_token: "at-2", refresh_token: "rt-2-ROTATED", expires_at: 2_000_000 }),
        };
      }
      return { ok: true, json: async () => ({ segments: [] }) };
    }) as unknown as typeof globalThis.fetch;

    const strava = makeStrava({
      clientId: "cid",
      clientSecret: "csec",
      loadTokens: () => tokens(1_000), // long expired
      saveTokens: (t) => saved.push(t),
      now: () => 1_000_000,
      fetch: fetchFn,
    });

    await strava.segmentsNear(43.17, 5.6, 15, "running");

    expect(saved).toHaveLength(1);
    expect(saved[0].refreshToken).toBe("rt-2-ROTATED"); // else access is lost at next restart
    expect(calls[1]).toContain("Bearer".length ? "/segments/explore" : "");
  });

  it("does not refresh while the token is still valid", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ segments: [] }) })) as never;
    const strava = makeStrava({
      clientId: "cid",
      clientSecret: "csec",
      loadTokens: () => tokens(9_999_999),
      saveTokens: () => {
        throw new Error("must not save");
      },
      now: () => 1_000_000,
      fetch: fetchFn,
    });

    await strava.segmentsNear(43.17, 5.6, 15, "running");
    expect((fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1); // no token call
  });

  it("maps segments to Norwegian-friendly fields with a strava link", async () => {
    const fetchFn = (async () => ({
      ok: true,
      json: async () => ({
        segments: [
          { id: 12345, name: "Bord de mer", distance: 3200, avg_grade: 1.4, elev_difference: 44, climb_category: 0, start_latlng: [43.17, 5.61] },
        ],
      }),
    })) as unknown as typeof globalThis.fetch;

    const strava = makeStrava({
      clientId: "c", clientSecret: "s", loadTokens: () => tokens(9_999_999), saveTokens: () => {}, now: () => 1_000_000, fetch: fetchFn,
    });

    const segs = await strava.segmentsNear(43.17, 5.6, 15, "running");
    expect(segs[0]).toMatchObject({ name: "Bord de mer", distanceKm: 3.2, elevationGainM: 44, stravaUrl: "https://www.strava.com/segments/12345" });
  });

  it("derives pace from the athlete's own activities (taste signal)", async () => {
    const fetchFn = (async () => ({
      ok: true,
      json: async () => [{ name: "Morgentur", type: "Run", distance: 10000, moving_time: 3000, start_date_local: "2026-07-10T07:12:00Z" }],
    })) as unknown as typeof globalThis.fetch;

    const strava = makeStrava({
      clientId: "c", clientSecret: "s", loadTokens: () => tokens(9_999_999), saveTokens: () => {}, now: () => 1_000_000, fetch: fetchFn,
    });

    const acts = await strava.recentActivities(5);
    expect(acts[0]).toMatchObject({ distanceKm: 10, movingMinutes: 50, paceMinPerKm: 5, startDate: "2026-07-10" });
  });
});
