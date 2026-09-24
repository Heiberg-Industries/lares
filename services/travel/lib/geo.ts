// lib/geo.ts — place name → coordinates (Nominatim/OpenStreetMap, keyless).
// Ported verbatim from services/marcel/lib/geo.ts (Task 6) — no logic changes.
// Shared by place_link (destination bias) and discovery (locality anchoring for free-text
// queries). MET-style terms: identify yourself with a real User-Agent.

export interface LatLon {
  lat: number;
  lon: number;
}

export type Geocode = (query: string) => Promise<LatLon | null>;

export function makeGeocode(opts: { userAgent: string; fetch?: typeof globalThis.fetch }): Geocode {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  return async (query: string) => {
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
      // Timeout matches the service's other external calls — a hung Nominatim must not
      // stall the brain's tool loop (there is no outer per-answer timeout).
      const res = await fetchFn(url, { headers: { "User-Agent": opts.userAgent }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const hits = (await res.json()) as Array<{ lat: string; lon: string }>;
      const hit = hits[0];
      if (!hit) return null;
      const lat = Number(hit.lat);
      const lon = Number(hit.lon);
      return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
    } catch {
      return null;
    }
  };
}

export type ReverseGeocode = (p: LatLon) => Promise<string | null>;

/** Coordinates → locality name ("Aix-en-Provence"), for re-anchoring place searches
 *  to wherever someone dropped a pin. Best-effort: any failure → null. */
export function makeReverseGeocode(opts: { userAgent: string; fetch?: typeof globalThis.fetch }): ReverseGeocode {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  return async (p: LatLon) => {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?lat=${p.lat}&lon=${p.lon}&format=json&zoom=14`;
      const res = await fetchFn(url, { headers: { "User-Agent": opts.userAgent }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        address?: { city?: string; town?: string; village?: string; municipality?: string };
      };
      return data.address?.city ?? data.address?.town ?? data.address?.village ?? data.address?.municipality ?? null;
    } catch {
      return null;
    }
  };
}
