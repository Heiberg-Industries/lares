import { describe, expect, it } from "vitest";

import { cellIdToLatLon, featureIdToLatLon, metresBetween } from "../src/s2.js";

// Every pair below is a REAL row from Bendik's store: the feature id out of the saved Google Maps
// URL, and the pin a browser resolved for that same URL. They are the decode's specification — if
// a refactor moves any of these, the maths is wrong, not the fixture.
//
// `within` is deliberately per-place rather than one global bound, because the two things it
// measures are different. Balthazar and Mezzrow pin the ARITHMETIC: their cells were stamped at
// the pin they still carry, so any drift there is a bug. Katz's pins the CONTRACT: its cell is
// 680 m from its current pin and always will be, because Google never moved the cell when the pin
// was refined. A test that demanded 100 m of Katz's would be asserting something false about the
// world.
const KNOWN: Array<{ name: string; featureId: string; lat: number; lon: number; within: number }> = [
  { name: "Balthazar (NYC)", featureId: "0x89c259892cccb7b7", lat: 40.7227, lon: -73.9982, within: 30 },
  { name: "Mezzrow (NYC)", featureId: "0x89c259943f298ccd", lat: 40.7346, lon: -74.0019, within: 30 },
  { name: "Merkur Bar (Oslo)", featureId: "0x46416e7a628fd183", lat: 59.9235, lon: 10.7416, within: 30 },
  { name: "Aux Bons Enfants (Côte d'Azur)", featureId: "0x12ce818953ad58ff", lat: 43.5516, lon: 7.012, within: 30 },
  { name: "Katz's Delicatessen (NYC) — stale cell", featureId: "0x89c2598f7ff4aa09", lat: 40.7222, lon: -73.9874, within: 800 },
];

describe("cellIdToLatLon", () => {
  it("decodes the S2 cell in a real feature id back to the saved pin", () => {
    for (const place of KNOWN) {
      const point = featureIdToLatLon(place.featureId);
      expect(point, place.name).toBeDefined();
      expect(metresBetween(point!, { lat: place.lat, lon: place.lon }), place.name).toBeLessThan(
        place.within,
      );
    }
  });

  it("puts each cube face on the right part of the globe", () => {
    // The face is the top 3 bits of the id, so a face-table typo shows up as a point on the wrong
    // side of the planet rather than as a near miss. These three ids cover faces 4, 2 and 0 —
    // every face Bendik's store actually exercises.
    const faces: Array<[string, number, number]> = [
      ["0x89c259892cccb7b7", 40.7, -74.0], // face 4 — New York
      ["0x47a852033dde0883", 52.5, 13.4], //  face 2 — Berlin
      ["0x12ce818953ad58ff", 43.6, 7.0], //   face 0 — Côte d'Azur
    ];
    for (const [id, lat, lon] of faces) {
      const point = featureIdToLatLon(id)!;
      expect(Math.abs(point.lat - lat), id).toBeLessThan(1);
      expect(Math.abs(point.lon - lon), id).toBeLessThan(1);
    }
  });

  it("takes the full Takeout pair and ignores the CID half", () => {
    const half = featureIdToLatLon("0x89c259892cccb7b7");
    const pair = featureIdToLatLon("0x89c259892cccb7b7:0xbf4202b1312b5cf1");
    expect(pair).toEqual(half);
    expect(half).toBeDefined();
  });

  it("is case-insensitive, as Takeout URLs are not consistent about it", () => {
    expect(featureIdToLatLon("0X89C259892CCCB7B7")).toEqual(featureIdToLatLon("0x89c259892cccb7b7"));
  });

  it("declines anything that is not a cell id rather than inventing a point", () => {
    for (const bad of [undefined, "", "not-hex", "0x", "ChIJ0X89C25", "0x89c259892cccb7b700"]) {
      expect(featureIdToLatLon(bad), String(bad)).toBeUndefined();
    }
    expect(cellIdToLatLon(0n)).toBeUndefined();
    // The marker bit must sit on an even index, so an id whose lowest set bit is odd is malformed.
    expect(cellIdToLatLon((0x89c259892cccb7b7n >> 2n) << 2n | 0b10n)).toBeUndefined();
  });

  it("stays on the globe for every face, at every level", () => {
    for (let face = 0; face < 6; face++) {
      for (let level = 0; level <= 30; level++) {
        const id = (BigInt(face) << 61n) | (1n << BigInt(2 * (30 - level)));
        const point = cellIdToLatLon(id);
        expect(point, `face ${face} level ${level}`).toBeDefined();
        expect(Math.abs(point!.lat)).toBeLessThanOrEqual(90);
        expect(Math.abs(point!.lon)).toBeLessThanOrEqual(180);
      }
    }
  });
});

describe("metresBetween", () => {
  it("is zero for a point against itself", () => {
    expect(metresBetween({ lat: 59.91, lon: 10.75 }, { lat: 59.91, lon: 10.75 })).toBe(0);
  });

  it("measures a known city hop", () => {
    // Oslo → Copenhagen, ~483 km great-circle.
    const d = metresBetween({ lat: 59.9139, lon: 10.7522 }, { lat: 55.6761, lon: 12.5683 });
    expect(d).toBeGreaterThan(475_000);
    expect(d).toBeLessThan(490_000);
  });
});
