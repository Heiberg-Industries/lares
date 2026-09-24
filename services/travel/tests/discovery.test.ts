// Ported from services/marcel/tests/discovery.test.ts (review fix, finding 10). lib/discovery.ts
// was copied UNCHANGED into eve-marcel (Task 6) but its test suite was never re-ported. Import
// path is the only change — the logic under test is byte-identical.
import { describe, it, expect, vi } from "vitest";
import { makeDiscovery } from "../lib/discovery.js";
import type { PlaceEntry } from "@lares/taste";

const point = { lat: 59.25, lon: 10.41 };
const gHit = (over: Record<string, unknown> = {}) => ({
  id: "ChIJx", name: "Herr & Fru", lat: 59.2525, lon: 10.4186, rating: 4.5, userRatingCount: 194, ...over,
});
// ORB-100: saved places are @lares/taste PlaceEntry now (sourceList, not list) — the store
// is /srv/taste, not Marcel's own CSVs.
const savedFonfon: PlaceEntry = { type: "place", name: "Herr & Fru", note: "faste plassen", sourceList: "Vestfold" };
const overpassEmpty = { search: vi.fn(async () => []) };

describe("makeDiscovery", () => {
  it("google primary: hits get distanceM, exact mapsUrl, and ⭐ from saved lists; kilde=Google", async () => {
    const google = { searchText: vi.fn(async () => [gHit()]), searchNearby: vi.fn(), photo: vi.fn() };
    const d = makeDiscovery({ google: google as never, overpass: overpassEmpty as never, saved: () => [savedFonfon] });
    const { hits, kilde } = await d.search({ point, category: "restaurant", query: "lunsj" });
    expect(kilde).toBe("Google");
    expect(google.searchText).toHaveBeenCalledWith("lunsj", { near: point, radiusM: 1500 });
    expect(hits[0].mapsUrl).toBe("https://www.google.com/maps/search/?api=1&query=Herr%20%26%20Fru&query_place_id=ChIJx");
    expect(hits[0].placeId).toBe("ChIJx");
    expect(hits[0].distanceM).toBeGreaterThan(0);
    expect(hits[0].paaBendiksListe).toEqual({ liste: "Vestfold", notat: "faste plassen" });
  });

  it("category-only → searchNearby with mapped types", async () => {
    const google = { searchText: vi.fn(), searchNearby: vi.fn(async () => [gHit()]), photo: vi.fn() };
    const d = makeDiscovery({ google: google as never, overpass: overpassEmpty as never, saved: () => [] });
    await d.search({ point, category: "grocery", radiusM: 900 });
    expect(google.searchNearby).toHaveBeenCalledWith(["supermarket", "grocery_store", "convenience_store"], point, 900);
  });

  it("ranking: ⭐ first, then rating desc, then userRatingCount desc", async () => {
    const google = {
      searchText: vi.fn(async () => [
        gHit({ id: "a", name: "A", rating: 4.8, userRatingCount: 10 }),
        gHit({ id: "b", name: "B", rating: 4.2, userRatingCount: 500 }),
        gHit({ id: "c", name: "Herr & Fru", rating: 4.0 }),
        gHit({ id: "d", name: "D", rating: 4.8, userRatingCount: 90 }),
      ]),
      searchNearby: vi.fn(), photo: vi.fn(),
    };
    const d = makeDiscovery({ google: google as never, overpass: overpassEmpty as never, saved: () => [savedFonfon] });
    const { hits } = await d.search({ point, category: "restaurant", query: "middag" });
    expect(hits.map((h) => h.name)).toEqual(["Herr & Fru", "D", "A", "B"]);
    // ⭐ match leads despite lowest rating; equal 4.8s tie-break on review count (D=90 > A=10 → D before A)
  });

  it("google empty → Overpass fallback, kilde=OpenStreetMap, ⭐ still applied", async () => {
    const google = { searchText: vi.fn(async () => []), searchNearby: vi.fn(async () => []), photo: vi.fn() };
    const overpass = { search: vi.fn(async () => [{ name: "Herr & Fru", lat: 59.2525, lon: 10.4186, distanceM: 120 }]) };
    const d = makeDiscovery({ google: google as never, overpass: overpass as never, saved: () => [savedFonfon] });
    const { hits, kilde } = await d.search({ point, category: "restaurant" });
    expect(kilde).toBe("OpenStreetMap");
    expect(overpass.search).toHaveBeenCalledWith(point, "restaurant", 1500);
    expect(hits[0].paaBendiksListe?.liste).toBe("Vestfold");
  });

  it("free-text queries are anchored with the reverse-geocoded locality", async () => {
    const google = { searchText: vi.fn(async () => [gHit()]), searchNearby: vi.fn(), photo: vi.fn() };
    const reverse = vi.fn(async () => "La Ciotat");
    const d = makeDiscovery({ google: google as never, overpass: overpassEmpty as never, saved: () => [], reverse });
    await d.search({ point, category: "bakery", query: "beste bakeri" });
    expect(reverse).toHaveBeenCalledWith(point);
    expect(google.searchText).toHaveBeenCalledWith("beste bakeri, La Ciotat", { near: point, radiusM: 1500 });
  });

  it("reverse absent or failing → raw query still sent (best-effort)", async () => {
    const googleA = { searchText: vi.fn(async () => [gHit()]), searchNearby: vi.fn(), photo: vi.fn() };
    const dA = makeDiscovery({ google: googleA as never, overpass: overpassEmpty as never, saved: () => [] });
    await dA.search({ point, category: "bakery", query: "beste bakeri" });
    expect(googleA.searchText).toHaveBeenCalledWith("beste bakeri", { near: point, radiusM: 1500 });

    const googleB = { searchText: vi.fn(async () => [gHit()]), searchNearby: vi.fn(), photo: vi.fn() };
    const dB = makeDiscovery({ google: googleB as never, overpass: overpassEmpty as never, saved: () => [], reverse: vi.fn(async () => null) });
    await dB.search({ point, category: "bakery", query: "beste bakeri" });
    expect(googleB.searchText).toHaveBeenCalledWith("beste bakeri", { near: point, radiusM: 1500 });
  });

  it("distance guard: text-search hits far beyond the radius are dropped before ranking", async () => {
    const google = {
      searchText: vi.fn(async () => [
        gHit({ id: "far", name: "Bakeri Brooklyn", lat: 40.7, lon: -73.9, rating: 4.9, userRatingCount: 900 }),
        gHit({ id: "near", name: "Lokal Bakeri", rating: 4.2 }),
      ]),
      searchNearby: vi.fn(), photo: vi.fn(),
    };
    const d = makeDiscovery({ google: google as never, overpass: overpassEmpty as never, saved: () => [] });
    const { hits, kilde } = await d.search({ point, category: "bakery", query: "bakeri" });
    expect(kilde).toBe("Google");
    expect(hits.map((h) => h.name)).toEqual(["Lokal Bakeri"]); // 4.9★ Brooklyn outranks on rating but is 6000 km away
  });

  it("all text hits beyond the guard → OSM fallback fires", async () => {
    const google = { searchText: vi.fn(async () => [gHit({ id: "far", name: "Fjern", lat: 40.7, lon: -73.9 })]), searchNearby: vi.fn(async () => []), photo: vi.fn() };
    const overpass = { search: vi.fn(async () => [{ name: "OSM Bakeri", lat: 59.2525, lon: 10.4186, distanceM: 200 }]) };
    const d = makeDiscovery({ google: google as never, overpass: overpass as never, saved: () => [] });
    const { hits, kilde } = await d.search({ point, category: "bakery", query: "bakeri" });
    expect(kilde).toBe("OpenStreetMap");
    expect(hits[0].name).toBe("OSM Bakeri");
  });

  it("no google dep at all → Overpass only (key-absent parity)", async () => {
    const overpass = { search: vi.fn(async () => []) };
    const d = makeDiscovery({ overpass: overpass as never, saved: () => [] });
    const { kilde } = await d.search({ point, category: "cafe" });
    expect(kilde).toBe("OpenStreetMap");
  });

  it("OSM fallback: ⭐ match leads even when not nearest (stable within groups)", async () => {
    const overpass = { search: vi.fn(async () => [
      { name: "Nearest Kebab", lat: 1, lon: 2, distanceM: 100 },
      { name: "Herr & Fru", lat: 1, lon: 2, distanceM: 900 },
      { name: "Middle Cafe", lat: 1, lon: 2, distanceM: 500 },
    ]) };
    const google = { searchText: vi.fn(async () => []), searchNearby: vi.fn(async () => []), photo: vi.fn() };
    const d = makeDiscovery({ google: google as never, overpass: overpass as never, saved: () => [savedFonfon] });
    const { hits } = await d.search({ point, category: "restaurant" });
    expect(hits.map((h) => h.name)).toEqual(["Herr & Fru", "Nearest Kebab", "Middle Cafe"]);
  });
});
