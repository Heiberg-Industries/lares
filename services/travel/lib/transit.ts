// lib/transit.ts — Google Maps Directions API, transit mode (new, 2026-08-16 approved
// improvement, Tier 2 #5). Reuses the SAME Google Places API key/project as
// lib/google-places.ts (one GCP project, one more API enabled on it — no new secret; see
// agent/tools/transit_directions.ts for how the key file is read, mirroring
// google-places.ts's `makeGooglePlaces({ apiKey })` construction pattern exactly).
//
// Best-effort in the SAME sense as this codebase's other place/route lookups (places.ts,
// nearby.ts, google-places.ts): a failed or zero-route request resolves to `null`, never a
// throw — a missing transit option must not sink the model's whole answer. Unlike
// currency.ts's ORB-51 posture (a wrong number is worse than none), a missing transit route
// is just "try again" territory, matching `makeEta`'s own `undefined`-on-failure contract in
// places.ts.
import type { LatLon } from "./geo.js";

export interface TransitStep {
  mode: string; // "WALKING" | "TRANSIT" | ... (Google's travel_mode, upper-cased)
  instruction: string; // HTML stripped to plain text
  durationText: string;
  line?: string; // transit line short/long name, e.g. "T3" or "Ligne 3"
  vehicleType?: string; // e.g. "BUS", "SUBWAY", "TRAM"
}

export interface TransitRoute {
  durationText: string;
  durationSeconds: number;
  distanceText: string;
  departureTime?: string; // local, as Google reports it
  arrivalTime?: string;
  fareText?: string;
  steps: TransitStep[];
}

const BASE = "https://maps.googleapis.com/maps/api/directions/json";

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "").trim();
}

interface RawStep {
  travel_mode?: string;
  html_instructions?: string;
  duration?: { text?: string };
  transit_details?: {
    line?: { short_name?: string; name?: string; vehicle?: { type?: string } };
  };
}

interface RawLeg {
  duration?: { text?: string; value?: number };
  distance?: { text?: string };
  departure_time?: { text?: string };
  arrival_time?: { text?: string };
  steps?: RawStep[];
}

interface RawRoute {
  legs?: RawLeg[];
  fare?: { text?: string };
}

interface DirectionsResponse {
  status?: string;
  routes?: RawRoute[];
}

function toStep(s: RawStep): TransitStep {
  const line = s.transit_details?.line;
  return {
    mode: (s.travel_mode ?? "").toUpperCase(),
    instruction: stripHtml(s.html_instructions ?? ""),
    durationText: s.duration?.text ?? "",
    ...(line?.short_name || line?.name ? { line: line.short_name ?? line.name } : {}),
    ...(line?.vehicle?.type ? { vehicleType: line.vehicle.type } : {}),
  };
}

export interface TransitDeps {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}

export function makeTransit(deps: TransitDeps) {
  const fetchFn = deps.fetch ?? globalThis.fetch;

  return {
    /** The first (best) transit route Google returns for origin→destination, or `null` on
     *  any failure/no-route — never a throw, matching this file's own best-effort contract.
     *  `origin`/`destination` may be a free-text place/address or coordinates; `departAt`,
     *  when given, is a unix-seconds timestamp (Google's `departure_time` param). */
    async route(
      origin: string | LatLon,
      destination: string | LatLon,
      departAt?: number,
    ): Promise<TransitRoute | null> {
      const fmt = (p: string | LatLon) => (typeof p === "string" ? p : `${p.lat},${p.lon}`);
      const params = [
        `origin=${encodeURIComponent(fmt(origin))}`,
        `destination=${encodeURIComponent(fmt(destination))}`,
        "mode=transit",
        `key=${deps.apiKey}`,
        ...(departAt !== undefined ? [`departure_time=${Math.trunc(departAt)}`] : []),
      ];
      try {
        const res = await fetchFn(`${BASE}?${params.join("&")}`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return null;
        const data = (await res.json()) as DirectionsResponse;
        if (data.status !== "OK") return null;
        const route = data.routes?.[0];
        const leg = route?.legs?.[0];
        if (!route || !leg) return null;
        return {
          durationText: leg.duration?.text ?? "",
          durationSeconds: leg.duration?.value ?? 0,
          distanceText: leg.distance?.text ?? "",
          ...(leg.departure_time?.text ? { departureTime: leg.departure_time.text } : {}),
          ...(leg.arrival_time?.text ? { arrivalTime: leg.arrival_time.text } : {}),
          ...(route.fare?.text ? { fareText: route.fare.text } : {}),
          steps: (leg.steps ?? []).map(toStep),
        };
      } catch {
        return null;
      }
    },
  };
}

export type Transit = ReturnType<typeof makeTransit>;
