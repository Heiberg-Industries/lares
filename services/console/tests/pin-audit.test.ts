import { describe, expect, it } from "vitest";

import { CONTRADICTION_M, contradictedPins, decodedPinFor } from "../lib/pin-audit";
import type { StoredEntry } from "../lib/taste-store";

// Invented feature ids (encoded from invented points). `BERLIN_URL` is the saved link of an entry
// that is pinned on another continent — the defect this whole module exists for.
const BERLIN_URL = "https://www.google.com/maps/place/Place+E/data=!4m2!3m1!1s0x47a84e3b6d4b45af:0x6c2e8f1a3d5b7094";
const NYC_URL = "https://www.google.com/maps/place/Place C/data=!4m2!3m1!1s0x89c2593f8bd29745:0x5a1c3e7d9b2f4608";

const stored = (entry: Record<string, unknown>): StoredEntry =>
  ({ file: "x.md", entry: { type: "place", name: "X", ...entry } } as unknown as StoredEntry);

describe("decodedPinFor", () => {
  it("reads the point out of a saved Google Maps URL", () => {
    const point = decodedPinFor({ type: "place", name: "Place C", url: NYC_URL });
    expect(point!.lat).toBeCloseTo(40.7319, 2);
    expect(point!.lon).toBeCloseTo(-73.9577, 2);
  });

  it("has no opinion about a URL with no feature id in it", () => {
    expect(decodedPinFor({ type: "place", name: "X", url: "https://maps.app.goo.gl/abc" })).toBeUndefined();
    expect(decodedPinFor({ type: "place", name: "X" })).toBeUndefined();
  });
});

describe("contradictedPins", () => {
  it("catches a pin on the wrong continent", () => {
    // A place saved in one city's list, pinned on another continent.
    const found = contradictedPins([
      stored({ name: "Place E", url: BERLIN_URL, lat: 37.7655, lon: -122.4210, sourceList: "List C" }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]!.metres).toBeGreaterThan(9_000_000);
    expect(found[0]!.decoded.lat).toBeCloseTo(52.5, 1); // where the link says it is
  });

  it("leaves a merely imprecise pin alone", () => {
    // A cell is stamped at feature creation and never moved, so kilometres of drift are normal and
    // mean nothing. Calling those wrong would replace good pins with worse ones.
    const drifted = contradictedPins([stored({ url: NYC_URL, lat: 40.7604, lon: -73.9801 })]);
    expect(drifted).toEqual([]);
  });

  it("draws the line at CONTRADICTION_M", () => {
    // ~0.9° of latitude is ~100 km — comfortably over the threshold; a tenth of that is under it.
    const far = contradictedPins([stored({ url: NYC_URL, lat: 40.7319 + 0.9, lon: -73.9577 })]);
    const near = contradictedPins([stored({ url: NYC_URL, lat: 40.7319 + 0.09, lon: -73.9577 })]);
    expect(far).toHaveLength(1);
    expect(far[0]!.metres).toBeGreaterThan(CONTRADICTION_M);
    expect(near).toEqual([]);
  });

  it("has nothing to say about entries it cannot second-guess", () => {
    expect(
      contradictedPins([
        stored({ url: NYC_URL }), //                                    no pin to check
        stored({ lat: 1, lon: 2 }), //                                  no URL to check it against
        stored({ url: "https://maps.app.goo.gl/abc", lat: 1, lon: 2 }), // no feature id in the URL
        // Already flagged approx: its pin IS the decoded cell, so it cannot contradict itself —
        // and it is already labelled unconfirmed, which is the outcome a repair would reach anyway.
        stored({ url: NYC_URL, lat: 1, lon: 2, approx: true }),
      ]),
    ).toEqual([]);
  });

  it("ignores a file that would not parse rather than crashing the audit", () => {
    expect(contradictedPins([{ file: "broken.md", entry: null } as unknown as StoredEntry])).toEqual([]);
  });
});
