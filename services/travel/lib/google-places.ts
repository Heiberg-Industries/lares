// lib/google-places.ts — Google Places API (New): Marcel's PRIMARY place engine when the
// key is present (kickoff decision 2026-07-20 — OSM coverage/ratings too thin for "beste"
// questions). Ported verbatim from services/marcel/lib/google-places.ts (Task 6) — no logic
// changes. Overpass (nearby.ts) and Nominatim (geo.ts) stay as the keyless fallbacks.
// The field mask is deliberately minimal and FROZEN — extra fields bump requests into
// pricier SKUs. Best-effort throughout: every failure → [] / null, never a throw.
import type { LatLon } from "./geo.js";
import type { NearbyCategory } from "./nearby.js";

export interface GPlaceHit {
  id: string;
  name: string;
  lat: number;
  lon: number;
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string; // mapped to "€".."€€€€"
  openNow?: boolean;
  photoRef?: string; // "places/<id>/photos/<ref>" — feed to photo()
}

const BASE = "https://places.googleapis.com/v1";
// FROZEN — do not add fields (billing tier reasons). See this file's top-of-file doc comment.
const FIELD_MASK =
  "places.id,places.displayName,places.location,places.rating,places.userRatingCount,places.currentOpeningHours,places.priceLevel,places.photos";

const PRICE: Record<string, string> = {
  PRICE_LEVEL_INEXPENSIVE: "€",
  PRICE_LEVEL_MODERATE: "€€",
  PRICE_LEVEL_EXPENSIVE: "€€€",
  PRICE_LEVEL_VERY_EXPENSIVE: "€€€€",
};

/** Overpass category → Places (New) includedTypes. Broader than 1:1 where OSM's single
 *  amenity hid whole classes (the Teie lunch bug: café/fast food invisible to "restaurant"). */
export const CATEGORY_TYPES: Record<NearbyCategory, string[]> = {
  restaurant: ["restaurant"],
  cafe: ["cafe", "coffee_shop"],
  bakery: ["bakery"],
  grocery: ["supermarket", "grocery_store", "convenience_store"],
  bar: ["bar", "pub"],
  ice_cream: ["ice_cream_shop"],
  pharmacy: ["pharmacy", "drugstore"],
  beach: ["beach"],
  fuel: ["gas_station"],
  atm: ["atm"],
  playground: ["playground"],
};

interface RawPlace {
  id?: string;
  displayName?: { text?: string };
  location?: { latitude?: number; longitude?: number };
  rating?: number;
  userRatingCount?: number;
  currentOpeningHours?: { openNow?: boolean };
  priceLevel?: string;
  photos?: { name?: string }[];
}

function normalize(p: RawPlace): GPlaceHit | null {
  const name = p.displayName?.text;
  const lat = p.location?.latitude;
  const lon = p.location?.longitude;
  if (!p.id || !name || lat === undefined || lon === undefined) return null;
  return {
    id: p.id, name, lat, lon,
    ...(p.rating !== undefined ? { rating: p.rating } : {}),
    ...(p.userRatingCount !== undefined ? { userRatingCount: p.userRatingCount } : {}),
    ...(p.priceLevel && PRICE[p.priceLevel] ? { priceLevel: PRICE[p.priceLevel] } : {}),
    ...(p.currentOpeningHours?.openNow !== undefined ? { openNow: p.currentOpeningHours.openNow } : {}),
    ...(p.photos?.[0]?.name ? { photoRef: p.photos[0].name } : {}),
  };
}

export function makeGooglePlaces(opts: { apiKey: string; fetch?: typeof globalThis.fetch }) {
  const fetchFn = opts.fetch ?? globalThis.fetch;

  async function post(path: string, body: unknown): Promise<GPlaceHit[]> {
    try {
      const res = await fetchFn(`${BASE}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": opts.apiKey, "X-Goog-FieldMask": FIELD_MASK },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { places?: RawPlace[] };
      return (data.places ?? []).map(normalize).filter((h): h is GPlaceHit => h !== null);
    } catch {
      return [];
    }
  }

  return {
    /** Free-text quality search ("beste lunsj", "naturvinbar") — Google's relevance engine
     *  handles category fuzz that a fixed type enum can't ("lunsj" ∋ café/bakeri/fast food). */
    async searchText(query: string, o: { near?: LatLon; radiusM?: number } = {}): Promise<GPlaceHit[]> {
      return post("places:searchText", {
        textQuery: query,
        pageSize: 8,
        languageCode: "no",
        ...(o.near
          ? { locationBias: { circle: { center: { latitude: o.near.lat, longitude: o.near.lon }, radius: Math.min(o.radiusM ?? 3000, 50000) } } }
          : {}),
      });
    },

    async searchNearby(types: string[], point: LatLon, radiusM: number): Promise<GPlaceHit[]> {
      return post("places:searchNearby", {
        includedTypes: types,
        maxResultCount: 8,
        languageCode: "no",
        locationRestriction: {
          circle: { center: { latitude: point.lat, longitude: point.lon }, radius: Math.min(Math.max(radiusM, 100), 50000) },
        },
      });
    },

    /** Photo bytes via the Places media endpoint (server-side; the keyed URL never leaves
     *  this process — Telegram gets a multipart upload). Redirects are followed by fetch. */
    async photo(photoRef: string, maxWidthPx = 800): Promise<Buffer | null> {
      try {
        const res = await fetchFn(`${BASE}/${photoRef}/media?maxWidthPx=${maxWidthPx}&key=${opts.apiKey}`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("image/")) return null;
        return Buffer.from(await res.arrayBuffer());
      } catch {
        return null;
      }
    },
  };
}

export type GooglePlaces = ReturnType<typeof makeGooglePlaces>;
