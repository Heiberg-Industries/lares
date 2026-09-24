// lib/places.ts — deterministic place links + multi-mode ETAs.
// Ported verbatim from services/marcel/lib/places.ts (Task 6) — no logic changes.
//
// Marcel must NEVER improvise a maps URL (models hallucinate place ids). Every link the
// group gets is built here from a real geocode hit.
//
// Link policy (Bendik, 2026-07-14): the DEFAULT is a plain place link — Google Maps then
// offers "Directions" from wherever the phone actually is. An origin is only used when
// someone says where they are (or shares a location), and then the ETA is a real routing
// query for the stated mode — walking, cycling, driving or transit.
import type { Geocode, LatLon, ReverseGeocode } from "./geo.js";
import type { GooglePlaces } from "./google-places.js";

export type TravelMode = "driving" | "walking" | "bicycling" | "transit";

export interface PlaceLink {
  name: string;
  lat: number;
  lon: number;
  mapsUrl: string; // opens the place — Google handles directions from the user's location
  directionsUrl: string; // navigation; carries an origin only when one is known
  etaMinutes?: number; // real routing duration; only when an origin + mode are known
  mode?: TravelMode;
  placeId?: string; // Google place id — exact-place links, disambiguates same-name branches
  rating?: number;
  userRatingCount?: number;
  photoRef?: string;
}

/** `encodeURIComponent` deliberately leaves `(`/`)` alone — legal in a URL, fatal in the
 *  markdown links Marcel's replies are made of: `toTelegramHtml`'s link regex
 *  (`agent/schedules/trip-lifecycle.ts`) ends the URL at the first literal `)`, truncating
 *  everything after it (ORB-131). Every query parameter in a maps URL goes through this
 *  instead. `lib/booking-venue.ts` used to carry its own copy of the parens step (ORB-129);
 *  it now relies on these builders. */
function encodeMapsParam(value: string): string {
  return encodeURIComponent(value).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** Google's universal Maps URLs — no API key, open the native app on every phone. */
export function mapsSearchUrl(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeMapsParam(query)}`;
}

/** Exact-place link (kickoff format): Google resolves the actual business page — hours,
 *  reviews, photos — never a naked coordinate pin. The id disambiguates same-name branches
 *  (the "Kiwi bug"). */
export function mapsPlaceUrl(name: string, placeId: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeMapsParam(name)}&query_place_id=${encodeMapsParam(placeId)}`;
}

/** Omitting `origin` is deliberate: Google then routes from the phone's current position.
 *  The destination is name-based whenever a label is known — `label, nearLabel` (or just
 *  `label`) — so Google resolves the actual business page (hours, reviews) instead of
 *  dropping a pin at bare coordinates. Coordinates are the destination ONLY as a last
 *  resort, when no label is available at all. `placeId`, when known, disambiguates
 *  same-name branches the same way `mapsPlaceUrl` does. */
export function mapsDirectionsUrl(
  destination: LatLon,
  opts: { label?: string; nearLabel?: string; origin?: LatLon; mode?: TravelMode; placeId?: string } = {},
): string {
  const dest = opts.label
    ? (opts.nearLabel ? `${opts.label}, ${opts.nearLabel}` : opts.label)
    : `${destination.lat},${destination.lon}`;
  const params = [
    "api=1",
    `destination=${encodeMapsParam(dest)}`,
    ...(opts.placeId ? [`destination_place_id=${encodeMapsParam(opts.placeId)}`] : []),
    `travelmode=${opts.mode ?? "driving"}`,
    ...(opts.origin ? [`origin=${opts.origin.lat},${opts.origin.lon}`] : []),
  ];
  return `https://www.google.com/maps/dir/?${params.join("&")}`;
}

export type Eta = (from: LatLon, to: LatLon, mode: TravelMode) => Promise<number | undefined>;

const VALHALLA_COSTING: Record<TravelMode, string> = {
  driving: "auto",
  walking: "pedestrian",
  bicycling: "bicycle",
  transit: "auto", // no public transit routing available keyless — car time is the honest proxy
};

/** Valhalla (OpenStreetMap's public instance, keyless) — the only free router that does
 *  foot/bike/car in one call. Failure → undefined: a missing ETA must never sink a
 *  recommendation, and Marcel just omits it. */
export function makeEta(fetchFn: typeof globalThis.fetch = globalThis.fetch): Eta {
  return async (from, to, mode) => {
    try {
      const body = {
        locations: [
          { lat: from.lat, lon: from.lon },
          { lat: to.lat, lon: to.lon },
        ],
        costing: VALHALLA_COSTING[mode],
        units: "kilometers",
      };
      const res = await fetchFn(`https://valhalla1.openstreetmap.de/route?json=${encodeURIComponent(JSON.stringify(body))}`);
      if (!res.ok) return undefined;
      const data = (await res.json()) as { trip?: { summary?: { time?: number } } };
      const seconds = data.trip?.summary?.time;
      return typeof seconds === "number" ? Math.round(seconds / 60) : undefined;
    } catch {
      return undefined;
    }
  };
}

export interface PlacesDeps {
  geocode: Geocode;
  eta?: Eta;
  reverse?: ReverseGeocode;
  google?: GooglePlaces;
}

export function makePlaces(deps: PlacesDeps) {
  return {
    /** Resolve a place name to a real location + links. `origin`/`mode` are optional —
     *  without an origin the link simply opens the place (Google routes from the phone).
     *  `nearPoint` (the pin/asker position) re-scopes the SEARCH itself: reverse-geocoded
     *  to a locality name and preferred over `near` (the trip destination) as the bias. */
    async lookup(
      query: string,
      opts: { near?: string; nearPoint?: LatLon; origin?: LatLon; mode?: TravelMode } = {},
    ): Promise<PlaceLink | null> {
      const pinLocality = opts.nearPoint && deps.reverse ? await deps.reverse(opts.nearPoint) : null;
      const nearLabel = pinLocality ?? opts.near;

      if (deps.google) {
        const [hit] = await deps.google.searchText(nearLabel ? `${query}, ${nearLabel}` : query, {
          near: opts.nearPoint, radiusM: 30000,
        });
        if (hit) {
          const mode = opts.mode ?? (opts.origin ? "driving" : undefined);
          const etaMinutes = opts.origin && deps.eta && mode ? await deps.eta(opts.origin, hit, mode) : undefined;
          return {
            name: hit.name, // Google's canonical name — better than echoing the raw query
            lat: hit.lat, lon: hit.lon, placeId: hit.id,
            mapsUrl: mapsPlaceUrl(hit.name, hit.id),
            directionsUrl: mapsDirectionsUrl(hit, { label: hit.name, nearLabel, placeId: hit.id, origin: opts.origin, mode }),
            etaMinutes, mode,
            ...(hit.rating !== undefined ? { rating: hit.rating } : {}),
            ...(hit.userRatingCount !== undefined ? { userRatingCount: hit.userRatingCount } : {}),
            ...(hit.photoRef ? { photoRef: hit.photoRef } : {}),
          };
        }
      }

      // Bias the geocoder toward the pin's locality, else the trip's region — "Chez Fonfon" alone is ambiguous.
      const biased = nearLabel ? await deps.geocode(`${query}, ${nearLabel}`) : null;
      const resolved = biased ?? (await deps.geocode(query));
      if (!resolved) return null;

      const mode = opts.mode ?? (opts.origin ? "driving" : undefined);
      const etaMinutes = opts.origin && deps.eta && mode ? await deps.eta(opts.origin, resolved, mode) : undefined;

      return {
        name: query,
        lat: resolved.lat,
        lon: resolved.lon,
        mapsUrl: mapsSearchUrl(nearLabel ? `${query}, ${nearLabel}` : query),
        directionsUrl: mapsDirectionsUrl(resolved, { label: query, nearLabel, origin: opts.origin, mode }),
        etaMinutes,
        mode,
      };
    },
  };
}

export type Places = ReturnType<typeof makePlaces>;
