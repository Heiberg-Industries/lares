import { describe, expect, it } from "vitest";

import { cellIdToLatLon, featureIdToLatLon, metresBetween } from "../src/s2.js";

// Every pair below is an invented row: a feature id whose cell was encoded from the pin beside it
// (with the same S2 maths run forward), and the pin itself. They are the decode's specification: if
// a refactor moves any of these, the maths is wrong, not the fixture.
//
// `within` is deliberately per-place rather than one global bound, because the two things it
// measures are different. Places A to D pin the ARITHMETIC: their cells were stamped at
// the pin they still carry, so any drift there is a bug. Place E pins the CONTRACT: its cell is
// 680 m from its current pin and always will be, because Google never moved the cell when the pin
// was refined. A test that demanded 100 m of Place E would be asserting something false about the
// world.
const KNOWN: Array<{ name: string; featureId: string; lat: number; lon: number; within: number }> = [
  { name: "Place A (Example City)", featureId: "0x89e626c76f520daf", lat: 41.2503, lon: -72.4417, within: 30 },
  { name: "Place B (Example City)", featureId: "0x89e626ba684fa457", lat: 41.2571, lon: -72.439, within: 30 },
  { name: "Place C (Example Town)", featureId: "0x4704b3564ee72a15", lat: 52.4104, lon: 18.2231, within: 30 },
  { name: "Place D (Example Coast)", featureId: "0x12ce92930a0dd381", lat: 43.3012, lon: 6.9021, within: 30 },
  { name: "Place E (Example City) — stale cell", featureId: "0x89e626c29c931be5", lat: 41.2502, lon: -72.4492, within: 800 },
];

describe("cellIdToLatLon", () => {
  it("decodes the S2 cell in a feature id back to the saved pin", () => {
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
    // every face the fixtures exercise.
    const faces: Array<[string, number, number]> = [
      ["0x89e626c76f520daf", 41.3, -72.4], // face 4 — Example City
      ["0x4704b3564ee72a15", 52.4, 18.2], //  face 2 — Example Town
      ["0x128efadce8639531", 36.4, 3.2], //   face 0 — Example Coast
    ];
    for (const [id, lat, lon] of faces) {
      const point = featureIdToLatLon(id)!;
      expect(Math.abs(point.lat - lat), id).toBeLessThan(1);
      expect(Math.abs(point.lon - lon), id).toBeLessThan(1);
    }
  });

  it("takes the full Takeout pair and ignores the CID half", () => {
    const half = featureIdToLatLon("0x89e626c76f520daf");
    const pair = featureIdToLatLon("0x89e626c76f520daf:0x0123456789abcdef");
    expect(pair).toEqual(half);
    expect(half).toBeDefined();
  });

  it("is case-insensitive, as Takeout URLs are not consistent about it", () => {
    expect(featureIdToLatLon("0X89E626C76F520DAF")).toEqual(featureIdToLatLon("0x89e626c76f520daf"));
  });

  it("declines anything that is not a cell id rather than inventing a point", () => {
    for (const bad of [undefined, "", "not-hex", "0x", "ChIJ0X89C25", "0x89e626c76f520daf00"]) {
      expect(featureIdToLatLon(bad), String(bad)).toBeUndefined();
    }
    expect(cellIdToLatLon(0n)).toBeUndefined();
    // The marker bit must sit on an even index, so an id whose lowest set bit is odd is malformed.
    expect(cellIdToLatLon((0x89e626c76f520dafn >> 2n) << 2n | 0b10n)).toBeUndefined();
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
    expect(metresBetween({ lat: 10.5, lon: 20.5 }, { lat: 10.5, lon: 20.5 })).toBe(0);
  });

  it("measures a known city hop", () => {
    // Two invented points, ~453 km apart great-circle.
    const d = metresBetween({ lat: 50.1, lon: 8.2 }, { lat: 46.3, lon: 10.4 });
    expect(d).toBeGreaterThan(445_000);
    expect(d).toBeLessThan(460_000);
  });
});
