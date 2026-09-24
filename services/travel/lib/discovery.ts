// lib/discovery.ts — hybrid place discovery. Google Places primary (ratings, exact ids,
// photos — "beste" is answerable), Overpass fallback (keyless), and Bendik's saved lists
// cross-referenced onto every hit (kickoff: "beste" = rating × taste, ⭐ på Bendiks liste).
// Ported verbatim from services/marcel/lib/discovery.ts (Task 6) — no logic changes.
import type { LatLon, ReverseGeocode } from "./geo.js";
import { haversineM, type NearbyCategory, type makeNearby } from "./nearby.js";
import { CATEGORY_TYPES, type GooglePlaces, type GPlaceHit } from "./google-places.js";
import { mapsPlaceUrl } from "./places.js";
import { findSavedMatch } from "./taste.js";
import type { PlaceEntry } from "@lares/taste";

export interface DiscoveryHit {
  name: string;
  lat: number;
  lon: number;
  distanceM: number;
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  openNow?: boolean;
  openingHours?: string; // Overpass only
  cuisine?: string; // Overpass only
  placeId?: string; // Google only — exact-place links
  mapsUrl?: string; // Google only — name+place_id link, never coordinates
  photoRef?: string; // Google only — feed to send_place_photo
  paaBendiksListe?: { liste: string; notat?: string };
}

export interface DiscoveryDeps {
  google?: GooglePlaces;
  overpass: ReturnType<typeof makeNearby>;
  // Re-read per call: cheap, and the console can write the store mid-trip.
  saved(): PlaceEntry[];
  /** Locality anchor for free-text queries (Nominatim reverse, best-effort). Google treats
   *  locationBias as a SUGGESTION, not a boundary — a Norwegian query like «bakeri»
   *  text-matches Nordic business NAMES globally and outranks a 1.5 km bias circle (live
   *  incident 2026-07-21: «beste bakeri» from La Ciotat returned Tønsberg and Brooklyn).
   *  Anchoring the query with the locality («beste bakeri, La Ciotat») localizes Google's
   *  relevance at the source; the distance guard below is the net behind it. */
  reverse?: ReverseGeocode;
}

function star(name: string, saved: PlaceEntry[]): { paaBendiksListe?: { liste: string; notat?: string } } {
  const hit = findSavedMatch(name, saved);
  // `sourceList` is optional in the store (a hand-written entry may have none), so the ⭐
  // still fires — it just says "lagret" instead of naming a list.
  return hit
    ? { paaBendiksListe: { liste: hit.sourceList ?? "lagret", ...(hit.note ? { notat: hit.note } : {}) } }
    : {};
}

function fromGoogle(h: GPlaceHit, point: LatLon, saved: PlaceEntry[]): DiscoveryHit {
  return {
    name: h.name, lat: h.lat, lon: h.lon,
    distanceM: haversineM(point, { lat: h.lat, lon: h.lon }),
    ...(h.rating !== undefined ? { rating: h.rating } : {}),
    ...(h.userRatingCount !== undefined ? { userRatingCount: h.userRatingCount } : {}),
    ...(h.priceLevel ? { priceLevel: h.priceLevel } : {}),
    ...(h.openNow !== undefined ? { openNow: h.openNow } : {}),
    placeId: h.id,
    mapsUrl: mapsPlaceUrl(h.name, h.id),
    ...(h.photoRef ? { photoRef: h.photoRef } : {}),
    ...star(h.name, saved),
  };
}

export function makeDiscovery(deps: DiscoveryDeps) {
  return {
    async search(args: { point: LatLon; category: NearbyCategory; query?: string; radiusM?: number }): Promise<{ hits: DiscoveryHit[]; kilde: "Google" | "OpenStreetMap" }> {
      const radiusM = Math.min(Math.max(Math.trunc(args.radiusM ?? 1500), 100), 10000);
      const saved = deps.saved();

      if (deps.google) {
        let raw: GPlaceHit[];
        if (args.query) {
          const locality = deps.reverse ? await deps.reverse(args.point) : null;
          const anchored = locality ? `${args.query}, ${locality}` : args.query;
          raw = (await deps.google.searchText(anchored, { near: args.point, radiusM }))
            // Distance guard: rating-sorted ranking must never surface a 4,9★ hit in another
            // country. 3× the asked radius keeps "worth the short drive" picks; anything
            // beyond is bias-escape noise. All-dropped → the OSM fallback below fires.
            .filter((h) => haversineM(args.point, h) <= 3 * radiusM);
        } else {
          // searchNearby uses locationRestriction — a hard circle — so no guard is needed.
          raw = await deps.google.searchNearby(CATEGORY_TYPES[args.category], args.point, radiusM);
        }
        if (raw.length > 0) {
          const hits = raw.map((h) => fromGoogle(h, args.point, saved));
          // "Beste" = Bendiks liste først, så vurdering, så antall vurderinger.
          hits.sort(
            (a, b) =>
              Number(!!b.paaBendiksListe) - Number(!!a.paaBendiksListe) ||
              (b.rating ?? 0) - (a.rating ?? 0) ||
              (b.userRatingCount ?? 0) - (a.userRatingCount ?? 0),
          );
          return { hits: hits.slice(0, 8), kilde: "Google" };
        }
      }

      // GooglePlaces methods never throw (best-effort contract in google-places.ts), so no
      // try/catch is needed around the primary path for "discovery never throws" to hold.
      const osm = await deps.overpass.search(args.point, args.category, radiusM);
      const hits = osm.map((h) => ({ ...h, ...star(h.name, saved) }));
      // ⭐ leads on the fallback path too (sort is stable — distance order preserved within
      // groups). Documented residual: nearby.ts caps to the 8 closest BEFORE this star pass,
      // so a saved place farther out than 8 nearer hits can't surface via OSM — acceptable
      // for a fallback engine; the system prompt's taste-geo section still carries saved
      // places near the trip independently of discovery.
      hits.sort((a, b) => Number(!!b.paaBendiksListe) - Number(!!a.paaBendiksListe));
      return { hits, kilde: "OpenStreetMap" };
    },
  };
}

export type Discovery = ReturnType<typeof makeDiscovery>;
