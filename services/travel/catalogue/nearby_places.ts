/**
 * agent/tools/nearby_places.ts — "what's nearby?" search, ported from old Marcel's
 * `tools.nearby_places` (`services/marcel/lib/brain.ts:177-198`). Thin wrapper only: all
 * Google-Places/Overpass/taste-cross-ref logic lives in `lib/discovery.ts` (Task 6 port,
 * unchanged), which itself composes `lib/nearby.ts` (Overpass fallback) and
 * `lib/taste.ts` (⭐ Bendiks-liste cross-reference).
 *
 * Boundary (Wave-1 lesson): the model must NEVER invent a place, a rating, or a maps URL —
 * only what this tool returns is real. Discovery's own contract already guarantees this: the
 * OSM fallback path simply omits `mapsUrl` rather than ever fabricating one (see
 * `lib/discovery.ts`'s `fromGoogle` vs. the raw-Overpass-hit branch).
 *
 * Unlike `place_link`/`weather_forecast`/`strava_routes`/`flight_status`/`remember`, this
 * tool needs NO trip-chat resolution for `TripStore.taste()`, which is data-root-level, not
 * per-trip (see `lib/trip-store.ts`'s own layout comment — taste files live under
 * `<root>/taste/`, siblings of `trips/`, not inside any one trip's dir).
 *
 * `lat`/`lon` (Task 11): now OPTIONAL. When the model supplies them explicitly, they always
 * win — even over a live location that's still valid — matching this tool's own "the model
 * must never invent a place" spirit: an explicit coordinate pair is a deliberate model
 * decision (e.g. from a place it just geocoded) and must not be silently overridden by
 * whatever the chat happened to share earlier. When omitted, `resolvePoint` falls back to
 * `lib/live-location.ts`'s `getLiveLocation(chatId)` — the position `agent/channels/
 * telegram.ts`'s `onMessage` recorded from the chat's most recent Telegram location share, if
 * any and if still within its TTL. With neither an explicit pair nor a live location on file,
 * this throws `NoLocationAvailableError` — a clear, typed failure rather than a search
 * silently centered on `(0, 0)`.
 *
 * All outbound HTTP is routed through the box's squid proxy via `lib/telegram-fetch.ts`'s
 * `telegramFetch` — same sealed-egress reasoning as `place_link.ts`.
 */
import { readFileSync } from "node:fs";
import { defineTool } from "eve/tools";
import type { SessionAuth } from "eve/context";
import { z } from "zod";

import { telegramFetch } from "@lares/agent-kit/telegram-fetch";
import { TripStore } from "../lib/trip-store.js";
import { makeReverseGeocode, type LatLon } from "../lib/geo.js";
import { makeNearby, type NearbyCategory } from "../lib/nearby.js";
import { makeGooglePlaces } from "../lib/google-places.js";
import { makeDiscovery, type Discovery } from "../lib/discovery.js";
import { TasteStore } from "../lib/taste-store.js";
import { getLiveLocation } from "../lib/live-location.js";

const USER_AGENT = process.env.LARES_HTTP_USER_AGENT?.trim() || "Lares/0.1 (+https://github.com/Heiberg-Industries/lares)";

function dataRoot(): string {
  return process.env["MARCEL_DATA_ROOT"] ?? "/data/marcel";
}

/** Reads an OPTIONAL secret, lazily — see `place_link.ts`'s identical helper for the
 *  build-safety reasoning; duplicated here rather than shared, matching this codebase's own
 *  per-tool-file self-containment (e.g. `dataRoot()` is duplicated the same way across
 *  `agent/tools/sveip.ts` and this file). */
function optionalSecret(envVar: string, fallbackPath: string): string | undefined {
  const path = process.env[envVar] ?? fallbackPath;
  try {
    const value = readFileSync(path, "utf8").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

let cachedDiscovery: Discovery | undefined;

function realDiscovery(): Discovery {
  if (!cachedDiscovery) {
    const apiKey = optionalSecret("GOOGLE_PLACES_API_KEY_FILE", "/run/secrets/google-places-api-key");
    cachedDiscovery = makeDiscovery({
      overpass: makeNearby({ userAgent: USER_AGENT, fetch: telegramFetch }),
      reverse: makeReverseGeocode({ userAgent: USER_AGENT, fetch: telegramFetch }),
      // Re-read per call: cheap, and the console can write the store mid-trip — same reasoning
      // as lib/discovery.ts's own DiscoveryDeps.saved() doc comment. Reads the FLEET store
      // (/srv/taste, read-only mount) as of ORB-100, not Marcel's old per-data-root CSVs.
      saved: () => new TasteStore().places(),
      ...(apiKey ? { google: makeGooglePlaces({ apiKey, fetch: telegramFetch }) } : {}),
    });
  }
  return cachedDiscovery;
}

export interface NearbyPlacesDeps {
  discovery(): Discovery;
}

export const defaultNearbyPlacesDeps: NearbyPlacesDeps = { discovery: realDiscovery };

/** Thrown when the model omitted `lat`/`lon` and there's nothing to fall back to — neither a
 *  live location on file for this chat nor (a fortiori) an explicit override. A clear, typed
 *  failure rather than silently searching around `(0, 0)`. */
export class NoLocationAvailableError extends Error {
  constructor() {
    super(
      "nearby_places: no lat/lon given and no live location on file for this chat — ask for a " +
        "place name to geocode, or have the user share their Telegram location first",
    );
    this.name = "NoLocationAvailableError";
  }
}

function callerChatId(auth: SessionAuth | undefined): string | undefined {
  const caller = auth?.current ?? auth?.initiator ?? null;
  const chatId = caller?.attributes?.["chat_id"];
  return typeof chatId === "string" ? chatId : undefined;
}

/** Explicit `lat`/`lon` always win (see this file's own top-of-file doc comment for why) —
 *  falls back to the calling chat's live location only when BOTH are omitted. */
function resolvePoint(lat: number | undefined, lon: number | undefined, auth: SessionAuth | undefined): LatLon {
  if (lat !== undefined && lon !== undefined) return { lat, lon };
  const chatId = callerChatId(auth);
  const live = chatId ? getLiveLocation(chatId) : null;
  if (!live) throw new NoLocationAvailableError();
  return live;
}

const inputSchema = z
  .object({
    category: z.enum([
      "restaurant", "cafe", "bakery", "grocery", "bar", "ice_cream", "pharmacy", "beach", "fuel", "atm", "playground",
    ]),
    query: z.string().optional().describe("free-text search, e.g. 'best lunch' — omit for a pure category search; category always rides along as the fallback"),
    lat: z.number().optional().describe("explicit latitude — omit to fall back to the chat's most recently shared live location, when one is on file; an explicit value always wins over the fallback"),
    lon: z.number().optional().describe("explicit longitude — see `lat`"),
    radiusM: z.number().min(100).max(10000).default(1500).describe("search radius in meters — 1500 is roughly a 15-minute walk"),
  })
  .refine((v) => (v.lat === undefined) === (v.lon === undefined), {
    message: "lat and lon must both be given, or both omitted",
  });

export function createNearbyPlacesTool(deps: NearbyPlacesDeps) {
  return defineTool({
    description:
      "Find REAL named places near a given position, with Google ratings when available: each " +
      "hit may carry a rating (stars), review count, price level, open-now status, a real " +
      "deterministic maps link (mapsUrl), and a ⭐ paaBendiksListe marker when the place is " +
      "on Bendik's saved Google Maps lists. The model must NEVER invent a place, a rating, or " +
      "a maps URL — only what this tool returns is real. \"Best X\" = ⭐ hits first, then " +
      "highest rating. Falls through to a keyless OpenStreetMap search (Overpass) when no " +
      "Google Places key is configured — hits are still real and distance-sorted, just " +
      "without ratings or a maps link (never a fabricated URL in either path). `lat`/`lon` are " +
      "OPTIONAL: omit them to search around the chat's most recently shared live Telegram " +
      "location, when one is on file — supply them explicitly (e.g. after geocoding a named " +
      "place) to search somewhere else instead; an explicit pair always overrides the chat's " +
      "live location, even a still-valid one.",
    inputSchema,
    async execute({ category, query, lat, lon, radiusM }, ctx) {
      const point = resolvePoint(lat, lon, ctx.session.auth);
      return deps.discovery().search({ point, category: category as NearbyCategory, query, radiusM });
    },
  });
}

export default createNearbyPlacesTool(defaultNearbyPlacesDeps);
