// lib/nearby.ts — "hva er i nærheten?" over OpenStreetMap Overpass (keyless, EU-hosted).
// Ported verbatim from services/marcel/lib/nearby.ts (Task 6) — no logic changes.
// Discovery counterpart to places.ts (which resolves KNOWN names): given coordinates and a
// category, return real named places sorted by distance. Best-effort: failures → [].
export type NearbyCategory = "restaurant" | "cafe" | "bakery" | "grocery" | "bar" | "ice_cream" | "pharmacy" | "beach" | "fuel" | "atm" | "playground";

export interface NearbyHit { name: string; lat: number; lon: number; distanceM: number; openingHours?: string; cuisine?: string }

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const CATEGORY_SELECTORS: Record<NearbyCategory, string> = {
  restaurant: `["amenity"~"restaurant"]`,
  cafe: `["amenity"~"cafe"]`,
  bakery: `["shop"~"bakery"]`,
  grocery: `["shop"~"supermarket|convenience"]`,
  bar: `["amenity"~"bar|pub"]`,
  ice_cream: `["amenity"~"ice_cream"]`,
  pharmacy: `["amenity"~"pharmacy"]`,
  beach: `["natural"~"beach"]`,
  fuel: `["amenity"~"fuel"]`,
  atm: `["amenity"~"atm"]`,
  playground: `["leisure"~"playground"]`,
};

export function haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

interface OverpassElement { type: string; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }

export function makeNearby(opts: { userAgent: string; fetch?: typeof globalThis.fetch }) {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  return {
    async search(point: { lat: number; lon: number }, category: NearbyCategory, radiusM = 1500): Promise<NearbyHit[]> {
      const r = Math.min(Math.max(Math.trunc(radiusM), 100), 10000);
      const sel = CATEGORY_SELECTORS[category];
      const around = `(around:${r},${point.lat},${point.lon})`;
      const query = `[out:json][timeout:8];(node${sel}${around};way${sel}${around};);out center 30;`;
      try {
        const res = await fetchFn(OVERPASS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": opts.userAgent },
          body: `data=${encodeURIComponent(query)}`,
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return [];
        const data = (await res.json()) as { elements?: OverpassElement[] };
        const hits: NearbyHit[] = [];
        for (const el of data.elements ?? []) {
          const name = el.tags?.["name"];
          const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
          if (!name || lat === undefined || lon === undefined) continue;
          hits.push({
            name, lat, lon,
            distanceM: haversineM(point, { lat, lon }),
            ...(el.tags?.["opening_hours"] ? { openingHours: el.tags["opening_hours"] } : {}),
            ...(el.tags?.["cuisine"] ? { cuisine: el.tags["cuisine"] } : {}),
          });
        }
        return hits.sort((a, b) => a.distanceM - b.distanceM).slice(0, 8);
      } catch {
        return [];
      }
    },
  };
}
