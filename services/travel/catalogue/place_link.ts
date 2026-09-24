/**
 * agent/tools/place_link.ts — deterministic Google Maps links, ported from old Marcel's
 * `tools.place_link` (`services/marcel/lib/brain.ts:155-175`). Thin wrapper only: all
 * geocode/ETA/Google-Places logic lives in `lib/places.ts` (Task 6 port, unchanged).
 *
 * Boundary (Wave-1 lesson — a path-free description is a boundary the model can't apply):
 * the model must NEVER invent, guess, or hand-construct a maps URL itself. Every place link
 * the group sees must come from this tool's output, verbatim.
 *
 * Google Places (New) is OPTIONAL — `GOOGLE_PLACES_API_KEY_FILE` (default
 * `/run/secrets/google-places-api-key`, matching the `google-places-api-key` Docker secret
 * mounted for eve-marcel in `services/box/compose.yaml`). Absent key means the keyless
 * Nominatim geocode fallback in `lib/places.ts` resolves the link instead — still a REAL,
 * deterministic link, never a fabricated one; it just lacks Google ratings/exact place ids.
 *
 * All outbound HTTP (Nominatim, Valhalla, Google Places) is routed through the box's squid
 * proxy via `lib/telegram-fetch.ts`'s `telegramFetch` — eve-marcel is sealed (Task 1) and can
 * only reach the gateway, db, and that proxy; `services/box/proxy/squid.conf`'s
 * `marcel_travel` ACL allow-lists these domains there, not for a direct route out.
 */
import { readFileSync } from "node:fs";
import { defineTool } from "eve/tools";
import type { SessionAuth } from "eve/context";
import { z } from "zod";

import { telegramFetch } from "@lares/agent-kit/telegram-fetch";
import { TripStore } from "../lib/trip-store.js";
import { resolveCurrentTrip } from "../lib/current-trip.js";
import { makeGeocode, makeReverseGeocode, type LatLon } from "../lib/geo.js";
import { makeGooglePlaces } from "../lib/google-places.js";
import { makeEta, makePlaces, type Places, type TravelMode } from "../lib/places.js";

const USER_AGENT = process.env.LARES_HTTP_USER_AGENT?.trim() || "Lares/0.1 (+https://github.com/Heiberg-Industries/lares)";

/** `services/box/compose.yaml`'s `eve-marcel:` block sets `MARCEL_DATA_ROOT=/srv/eve-marcel`
 *  and bind-mounts it (review fix, finding 1) — the fallback below is a safe non-production
 *  default only (local dev/tests), never the real deployed path. */
function dataRoot(): string {
  return process.env["MARCEL_DATA_ROOT"] ?? "/data/marcel";
}

/** Reads an OPTIONAL secret, lazily, on every call — never at module scope (`eve build` has
 *  no secrets to read). Returns undefined (not throw) when absent: Google Places is an
 *  optional upgrade over the keyless fallback, matching old Marcel's own
 *  `optionalSecretFile` (`services/marcel/bin/marcel.ts:744-747`). */
function optionalSecret(envVar: string, fallbackPath: string): string | undefined {
  const path = process.env[envVar] ?? fallbackPath;
  try {
    const value = readFileSync(path, "utf8").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

let cachedPlaces: Places | undefined;

/** Built once per process, lazily — matches `lib/gateway-provider.ts`'s
 *  construct-once/read-key-lazily discipline. */
function realPlaces(): Places {
  if (!cachedPlaces) {
    const apiKey = optionalSecret("GOOGLE_PLACES_API_KEY_FILE", "/run/secrets/google-places-api-key");
    cachedPlaces = makePlaces({
      geocode: makeGeocode({ userAgent: USER_AGENT, fetch: telegramFetch }),
      reverse: makeReverseGeocode({ userAgent: USER_AGENT, fetch: telegramFetch }),
      eta: makeEta(telegramFetch),
      ...(apiKey ? { google: makeGooglePlaces({ apiKey, fetch: telegramFetch }) } : {}),
    });
  }
  return cachedPlaces;
}

/** The current trip's destination name, used ONLY as a search-locality bias — never a hard
 *  requirement. A lookup with no resolvable trip still resolves a real link, just without
 *  the extra disambiguation a same-named place elsewhere would need. ORB-157: goes through
 *  the shared resolver, so the admin DM now gets the bias too (single active/upcoming trip)
 *  instead of only linked groups; a resolver miss simply means no bias, never an error. */
async function tripDestinationBias(auth: SessionAuth | undefined): Promise<string | undefined> {
  const res = resolveCurrentTrip(new TripStore(dataRoot()), auth);
  return res.ok ? res.trip.destination.name : undefined;
}

export interface PlaceLinkDeps {
  places(): Places;
  tripDestinationBias(auth: SessionAuth | undefined): Promise<string | undefined>;
}

export const defaultPlaceLinkDeps: PlaceLinkDeps = {
  places: realPlaces,
  tripDestinationBias,
};

const inputSchema = z.object({
  query: z.string().min(1).describe("place name, e.g. 'Calanque de Figuerolles'"),
  mode: z.enum(["driving", "walking", "bicycling", "transit"]).optional(),
  originLat: z.number().optional(),
  originLon: z.number().optional(),
});

export function createPlaceLinkTool(deps: PlaceLinkDeps) {
  return defineTool({
    description:
      "Look up a named place (beach, restaurant, cafe, climbing spot, shop, ...) and return a " +
      "REAL, deterministic Google Maps link built from a geocoded hit — mapsUrl, " +
      "directionsUrl, and (when origin+mode are given) a real routing etaMinutes. The model " +
      "must NEVER invent, guess, or hand-construct a maps URL itself — every place link the " +
      "group sees must come from this tool's output, verbatim. Leave origin/mode empty for a " +
      "plain place link (Google Maps then offers directions from wherever the phone actually " +
      "is). Only pass originLat/originLon + mode once someone has said where they are and how " +
      "they're travelling — that produces a real ETA. Falls through to a keyless OpenStreetMap " +
      "geocode (Nominatim) when no Google Places key is configured — the link is still real " +
      "and deterministic either way, never fabricated; it just won't carry a rating or exact " +
      "place id.",
    inputSchema,
    async execute({ query, mode, originLat, originLon }, ctx) {
      const origin: LatLon | undefined =
        originLat !== undefined && originLon !== undefined ? { lat: originLat, lon: originLon } : undefined;
      const near = await deps.tripDestinationBias(ctx.session.auth);
      const hit = await deps.places().lookup(query, {
        near,
        nearPoint: origin,
        origin,
        mode: mode as TravelMode | undefined,
      });
      return hit ?? { notFound: query };
    },
  });
}

export default createPlaceLinkTool(defaultPlaceLinkDeps);
