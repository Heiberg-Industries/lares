/**
 * lib/venue-coords.ts — a coordinate for a booked venue, resolved ONCE, at filing time (ORB-109).
 *
 * ## Why at filing time and not at ping time
 *
 * The geofence tick runs every minute while a live location is fresh. Resolving a venue name
 * inside that tick would mean a Places call per tick per booking — slow, billable, and repeated
 * forever for an answer that never changes. A booking is filed once; that is when to look.
 *
 * ## Order of preference, and why
 *
 * 1. **The taste store, free.** A booked venue is very often a place Bendik already saved, and
 *    all ~856 saved places carry exact coordinates as of 2026-08-17. `findSavedMatch` is the
 *    same name matcher the ⭐ cross-reference already uses, so a hit here is both free and
 *    consistent with what the rest of Marcel calls "the same place".
 * 2. **Places Text Search, strictly.** Only when the store has nothing.
 *
 * ## The strict acceptance rule, lifted from services/console/lib/geocode.ts
 *
 * Text Search is FUZZY: it matches a name, not the pin. A wrong pin is worse than no pin — it
 * would put "du er 200 m unna" on the wrong building, which is precisely the kind of confident
 * error that makes a concierge untrustworthy. So the returned place's name must slug-match the
 * booking's venue name EXACTLY. Anything else resolves to nothing, and the booking is filed
 * without coordinates, exactly as it is today.
 *
 * A failure here NEVER fails a filing. Coordinates are an enhancement to a booking; a booking
 * is not an enhancement to coordinates.
 */
import type { PlaceEntry } from "@lares/taste";

import { findSavedMatch } from "./taste.js";

export interface LatLon {
  readonly lat: number;
  readonly lon: number;
}

/** Where a resolved coordinate came from — for the log line, and for the test. */
export type CoordSource = "taste" | "places";

export interface VenueCoordDeps {
  /** Bendik's saved places. Read once per resolution; an empty list simply means no free hit. */
  saved(): readonly PlaceEntry[];
  /** Places Text Search, already biased toward the trip. Returns candidates in relevance order.
   *  Omitted (or returning []) means "no fallback configured", which is a normal state — the
   *  Places key is optional. */
  searchText?(query: string): Promise<readonly { name: string; lat: number; lon: number; id?: string }[]>;
}

/** Same normalisation both sides of the comparison, so punctuation and case never decide. */
function slug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .replace(/[^a-z0-9]+/gu, "");
}

/**
 * Best-effort coordinates for a venue name. Returns `undefined` when nothing is confident
 * enough — never a guess.
 *
 * `near` biases the Places query toward the trip's destination so "Cosme" resolves in New York
 * rather than wherever else the name exists.
 */
export async function resolveVenueCoords(
  venue: string | undefined,
  deps: VenueCoordDeps,
): Promise<(LatLon & { source: CoordSource; placeId?: string }) | undefined> {
  const name = venue?.trim();
  if (!name) return undefined;

  const savedHit = findSavedMatch(name, deps.saved());
  if (savedHit?.lat !== undefined && savedHit.lon !== undefined) {
    return { lat: savedHit.lat, lon: savedHit.lon, source: "taste" };
  }

  if (!deps.searchText) return undefined;

  let hits: readonly { name: string; lat: number; lon: number; id?: string }[];
  try {
    hits = await deps.searchText(name);
  } catch {
    // A Places outage must not cost a filing. No coordinates is the correct degradation.
    return undefined;
  }

  const wanted = slug(name);
  // EXACT name agreement only. Not "the first hit", not "contains" — the console's own geocoder
  // learned this the expensive way, and a booked restaurant is exactly where a near-miss pin
  // would be most confidently wrong.
  const exact = hits.find((h) => slug(h.name) === wanted);
  // ORB-129 — the place id rides along when Places supplied it, so the booking block can link
  // to the exact business page rather than a name search that a same-name branch could win.
  return exact ? { lat: exact.lat, lon: exact.lon, source: "places", ...(exact.id ? { placeId: exact.id } : {}) } : undefined;
}
