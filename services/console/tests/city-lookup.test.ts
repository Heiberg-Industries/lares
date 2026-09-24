import { describe, expect, it } from "vitest";

import { cityFor, derivePlaceName } from "../lib/city-lookup";

describe("cityFor", () => {
  it("names the CITY that contains a point, not the neighbourhood nearest it", () => {
    // Each of these is a real saved place from the store, and each has a neighbourhood entry in
    // the tables closer to it than the city does. A naive nearest-match returns the left-hand
    // name in the comment, which is what this rule exists to avoid.
    const cases: Array<[string, number, number, string, string]> = [
      ["Balthazar",        40.7227, -73.9982, "New York City", "United States"], // vs West Village
      ["Norse Store",      55.6810,  12.5750, "Copenhagen",    "Denmark"],       // vs Indre By
      ["A.P.C. (Paris)",   48.8620,   2.3610, "Paris",         "France"],        // vs Folie Méricourt
      ["manteca (London)", 51.5260,  -0.0800, "London",        "United Kingdom"],// vs Islington
      ["Shiso Burger",     52.5250,  13.4000, "Berlin",        "Germany"],       // vs Mitte
    ];
    for (const [what, lat, lon, city, country] of cases) {
      expect(cityFor(lat, lon), what).toEqual({ city, country });
    }
  });

  it("still names a small town when no city is near enough to contain it", () => {
    // The fallback earns its place on Bendik's alpine lists: neither of these is within 50 km of
    // anywhere with 100k people, and "the nearest big city" would be an hour's drive away.
    expect(cityFor(45.9237, 6.8694)).toMatchObject({ city: "Chamonix-Mont-Blanc", country: "France" });
    expect(cityFor(46.0207, 7.7491)).toMatchObject({ city: "Zermatt", country: "Switzerland" });
  });

  it("answers for every continent Bendik's store touches", () => {
    expect(cityFor(31.6295, -7.9811)).toMatchObject({ country: "Morocco" });   // Marrakesh
    expect(cityFor(41.6938, 44.8015)).toMatchObject({ country: "Georgia" });   // Tbilisi
    expect(cityFor(35.6655, 139.7707)).toMatchObject({ country: "Japan" });    // Tokyo
    expect(cityFor(59.9235, 10.7416)).toMatchObject({ city: "Oslo", country: "Norway" });
  });
});

describe("derivePlaceName", () => {
  it("answers from the tables, so one city has exactly one name", () => {
    // An accepted Places match would call this "New York, USA"; the tables call it "New York
    // City, United States". Using both would put two entries for one city in the browse filter,
    // which defeats the point of deriving the field at all.
    expect(derivePlaceName({ lat: 40.7227, lon: -73.9982 })).toEqual({
      city: "New York City",
      country: "United States",
    });
    expect(derivePlaceName({ lat: 59.9235, lon: 10.7416 })).toMatchObject({ city: "Oslo" });
  });

  it("has nothing to say about an entry with no pin", () => {
    expect(derivePlaceName({})).toBeUndefined();
    expect(derivePlaceName({ lat: 59.9 })).toBeUndefined();
  });
});
