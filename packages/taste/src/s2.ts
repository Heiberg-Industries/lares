// packages/taste/src/s2.ts — the saved URL's feature id, decoded to a point, offline.
//
// WHY THIS EXISTS (ORB-117). Google's current Takeout export carries no lat/lon: every saved row
// has only a feature id in its URL — `!1s0x89c259892cccb7b7:0xbf4202b1312b5cf1`. That id is not a
// Places `place_id`, so no supported API will take it (verified against the live key: Places (New)
// answers "is not valid", Geocoding rejects it). Until now the only way to a pin was loading each
// URL in a browser by hand.
//
// But the id is not opaque. Its FIRST half is an S2 cell id — the same 64-bit cell id Google's own
// open-source S2 library produces — so it decodes to a point with pure arithmetic, no key, no
// network, no dependency. Verified two ways against Bendik's real store (711 places with exact
// browser-resolved pins, 2026-08-17):
//
//   * encoding a known pin reproduces the feature id's leading bits — Balthazar's pin encodes to
//     0x89c2598ed32ffd15 against the stored id 0x89c259892cccb7b7, agreeing to 28 bits;
//   * decoding the id back lands a median 721 m from the stored pin, 43% of entries within 100 m,
//     79% within 5 km.
//
// So the decode is EXACT MATHS on an APPROXIMATE INPUT. The cell is stamped when the feature is
// created and is not moved when the pin is later refined, which is where the spread comes from —
// not from this file. That makes the decoded point exactly the right thing for two jobs and the
// wrong thing for a third:
//
//   ✅ biasing a Places Text Search, turning a fuzzy name lookup into a local one
//   ✅ a coordinate-less place's fallback pin, flagged `approx` (a city-accurate pin beats none)
//   ❌ a proximity alert on its own — 250 m radii need the real pin, which rung 2 supplies
//
// Vendored rather than depended on: the whole decode is ~60 lines of integer maths, and the taste
// package's no-dependency property is worth more than the lines saved.

/** Hilbert-curve position → (i,j) quadrant, per orientation. Straight from the S2 reference. */
const POS_TO_IJ: readonly (readonly number[])[] = [
  [0, 1, 3, 2],
  [0, 2, 3, 1],
  [3, 2, 0, 1],
  [3, 1, 0, 2],
];

/** How each step's position flips the orientation for the step below it. */
const POS_TO_ORIENTATION: readonly number[] = [1, 0, 0, 3];

const MAX_LEVEL = 30;
const U64 = (1n << 64n) - 1n;

/** A point on the sphere. Degrees, WGS84 — the same convention as `PlaceEntry.lat`/`lon`. */
export interface LatLon {
  readonly lat: number;
  readonly lon: number;
}

/** S2's quadratic ST→UV projection. The quadratic variant is the one S2 ships by default, and
 *  the one that reproduces Google's cell ids — the linear/tangent variants do not. */
function stToUv(s: number): number {
  return s >= 0.5 ? (1 / 3) * (4 * s * s - 1) : (1 / 3) * (1 - 4 * (1 - s) * (1 - s));
}

/** Which cube face's plane a (u,v) belongs on, back to a direction vector. */
function faceUvToXyz(face: number, u: number, v: number): [number, number, number] {
  switch (face) {
    case 0: return [1, u, v];
    case 1: return [-u, 1, v];
    case 2: return [-u, -v, 1];
    case 3: return [-1, -v, -u];
    case 4: return [v, -1, -u];
    default: return [v, u, -1];
  }
}

/** Index of the lowest set bit, or -1 for zero. */
function lowestSetBit(value: bigint): number {
  if (value === 0n) return -1;
  let index = 0;
  let v = value;
  while ((v & 1n) === 0n) {
    v >>= 1n;
    index++;
  }
  return index;
}

/**
 * An S2 cell id → the centre of that cell.
 *
 * Returns undefined for anything that is not a well-formed cell id (zero, or a trailing-bit
 * position that implies no valid level). A caller that gets undefined has been handed something
 * that is not a cell id at all, which is a real possibility for a hand-pasted URL — so this
 * declines rather than inventing a point.
 */
export function cellIdToLatLon(cellId: bigint): LatLon | undefined {
  const id = cellId & U64;
  if (id === 0n) return undefined;

  const lsb = lowestSetBit(id & ((~id + 1n) & U64));
  if (lsb % 2 !== 0 || lsb > 2 * MAX_LEVEL) return undefined;
  const level = MAX_LEVEL - lsb / 2;

  const face = Number(id >> 61n);
  let orientation = face & 1;
  let i = 0;
  let j = 0;
  for (let k = 0; k < level; k++) {
    // Position bits run from bit 59 downward: the id is (face << 61) | (positions << 1) | marker.
    const pos = Number((id >> BigInt(59 - 2 * k)) & 3n);
    const ij = POS_TO_IJ[orientation]![pos]!;
    i = (i << 1) | (ij >> 1);
    j = (j << 1) | (ij & 1);
    orientation ^= POS_TO_ORIENTATION[pos]!;
  }

  const n = 2 ** level;
  const [x, y, z] = faceUvToXyz(face, stToUv((i + 0.5) / n), stToUv((j + 0.5) / n));
  return {
    lat: (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI,
    lon: (Math.atan2(y, x) * 180) / Math.PI,
  };
}

/**
 * The saved URL's feature id → an approximate point for that place.
 *
 * Accepts either half-form (`0x89c259892cccb7b7`) or the full pair Takeout writes
 * (`0x89c259892cccb7b7:0xbf4202b1312b5cf1`); only the first half carries position — the second is
 * the CID, an opaque feature identity with no geometry in it.
 */
export function featureIdToLatLon(featureId: string | undefined): LatLon | undefined {
  if (!featureId) return undefined;
  const first = featureId.trim().split(":")[0] ?? "";
  if (!/^0x[0-9a-f]{1,16}$/i.test(first)) return undefined;
  return cellIdToLatLon(BigInt(first));
}

/** Metres between two points, on a sphere. Good to a few parts in a thousand at city scale,
 *  which is far finer than anything here is deciding. */
export function metresBetween(a: LatLon, b: LatLon): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
