// Tests for Task 6's 8 conversational tool wrappers. Each tool is exercised via its exported
// `createXTool(deps)` factory with stubbed lib-client instances (built from the real
// `lib/*.ts` port, but with a fake `fetch` — never a real network call) — never the real
// `defaultXDeps`, which reads secret files / does real I/O.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SessionAuth } from "eve/context";

import { TripStore, type Trip } from "../lib/trip-store.js";
import { makePlaces, mapsSearchUrl, mapsPlaceUrl } from "../lib/places.js";
import { makeGooglePlaces } from "../lib/google-places.js";
import { makeDiscovery } from "../lib/discovery.js";
import { makeNearby } from "../lib/nearby.js";
import { makeStrava, type StravaTokens } from "../lib/strava.js";
import { makeFlights } from "../lib/flights-io.js";
import { makeCurrency, CurrencyUnavailableError } from "../lib/currency.js";
import { makeTransit } from "../lib/transit.js";

import { createPlaceLinkTool, type PlaceLinkDeps } from "../catalogue/place_link.js";
import { createNearbyPlacesTool, type NearbyPlacesDeps } from "../catalogue/nearby_places.js";
import { createWeatherForecastTool, type WeatherForecastDeps } from "../catalogue/weather_forecast.js";
import { createStravaRoutesTool, type StravaRoutesDeps } from "../catalogue/strava_routes.js";
import { createFlightStatusTool, type FlightStatusDeps } from "../catalogue/flight_status.js";
import { createRememberTool, type RememberDeps } from "../catalogue/remember.js";
import { createShoppingAddTool, type ShoppingAddDeps } from "../catalogue/shopping_add.js";
import { createShoppingRemoveTool, removeShoppingLine, type ShoppingRemoveDeps } from "../catalogue/shopping_remove.js";
import { createCurrencyConvertTool, type CurrencyConvertDeps } from "../catalogue/currency_convert.js";
import {
  createTransitDirectionsTool,
  type EnturClient,
  type TransitDirectionsDeps,
} from "../catalogue/transit_directions.js";

const CHAT_ID = "-100123";
const ADMIN_ID = "123456789";

function auth(chatId: string | null): SessionAuth {
  const a = chatId
    ? ({
        authenticator: "telegram-webhook",
        principalId: `telegram:${chatId}:1`,
        principalType: "user",
        attributes: { chat_id: chatId, chat_type: "group", user_id: "1" },
      } as never)
    : null;
  return { current: a, initiator: a } as SessionAuth;
}

function ctx(chatId: string | null) {
  return { session: { id: "wrun_test", auth: auth(chatId) } } as never;
}

/** Admin-DM auth — for the personal-data-gated paths (`strava_routes`'s `mine=true`,
 *  matching `calendar_list_events`'s own gate). Requires `MARCEL_ADMIN_TELEGRAM_ID` set to
 *  `ADMIN_ID` in the test's own `beforeEach`. */
function adminAuth(): SessionAuth {
  const a = {
    authenticator: "telegram-webhook",
    principalId: `telegram:${ADMIN_ID}`,
    principalType: "user",
    attributes: { chat_id: ADMIN_ID, chat_type: "private", user_id: ADMIN_ID },
  } as never;
  return { current: a, initiator: a } as SessionAuth;
}

function adminCtx() {
  return { session: { id: "wrun_test", auth: adminAuth() } } as never;
}

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-tools-"));
});

function baseTrip(overrides: Partial<Omit<Trip, "dir" | "chatId">> = {}): Omit<Trip, "dir" | "chatId"> {
  return {
    slug: "paris-2026",
    name: "Paris",
    start: "2026-07-21",
    end: "2026-07-28",
    timezone: "Europe/Paris",
    destination: { name: "Paris", lat: 48.8566, lon: 2.3522 },
    ...overrides,
  };
}

function seedTripStore(): { store: TripStore; trip: Trip } {
  const store = new TripStore(root);
  store.saveConfig({ adminId: "1", killSwitch: false, dailyTokenBudget: 1_000_000, trips: [] });
  const trip = store.createTrip(baseTrip());
  store.linkChat(trip.slug, CHAT_ID);
  return { store, trip: { ...trip, chatId: CHAT_ID } };
}

// ---------------------------------------------------------------------------------------
// place_link
// ---------------------------------------------------------------------------------------
describe("place_link", () => {
  it("falls through to the keyless Nominatim path and returns a real deterministic mapsUrl when no Google client is configured", async () => {
    const places = makePlaces({
      geocode: async (q) => (q.includes("Figuerolles") ? { lat: 43.17, lon: 5.6 } : null),
    });
    const deps: PlaceLinkDeps = { places: () => places, tripDestinationBias: async () => undefined };
    const tool = createPlaceLinkTool(deps);

    const result = (await tool.execute({ query: "Calanque de Figuerolles" }, ctx(null))) as Record<string, unknown>;

    expect(result["mapsUrl"]).toBe(mapsSearchUrl("Calanque de Figuerolles"));
    expect(result["placeId"]).toBeUndefined(); // never fabricated — no Google hit, no place id
    expect(result["lat"]).toBe(43.17);
  });

  it("uses the Google Places hit (exact place-id link) when a Google client is configured", async () => {
    const google = makeGooglePlaces({
      apiKey: "test-key",
      fetch: (async () =>
        new Response(
          JSON.stringify({
            places: [{ id: "ChIJabc", displayName: { text: "Chez Fonfon" }, location: { latitude: 43.28, longitude: 5.35 } }],
          }),
        )) as unknown as typeof fetch,
    });
    const places = makePlaces({ geocode: async () => null, google });
    const deps: PlaceLinkDeps = { places: () => places, tripDestinationBias: async () => "Marseille" };
    const tool = createPlaceLinkTool(deps);

    const result = (await tool.execute({ query: "Chez Fonfon" }, ctx(CHAT_ID))) as Record<string, unknown>;

    expect(result["mapsUrl"]).toBe(mapsPlaceUrl("Chez Fonfon", "ChIJabc"));
    expect(result["placeId"]).toBe("ChIJabc");
  });

  it("returns notFound rather than fabricating a link when nothing resolves", async () => {
    const places = makePlaces({ geocode: async () => null });
    const deps: PlaceLinkDeps = { places: () => places, tripDestinationBias: async () => undefined };
    const tool = createPlaceLinkTool(deps);

    const result = (await tool.execute({ query: "nowhere" }, ctx(null))) as Record<string, unknown>;
    expect(result).toEqual({ notFound: "nowhere" });
  });
});

// ---------------------------------------------------------------------------------------
// nearby_places
// ---------------------------------------------------------------------------------------
describe("nearby_places", () => {
  it("falls through to the keyless Overpass path with no mapsUrl fabricated when no Google client is configured", async () => {
    const overpass = makeNearby({
      userAgent: "test",
      fetch: (async () =>
        new Response(
          JSON.stringify({
            elements: [{ type: "node", lat: 48.86, lon: 2.35, tags: { name: "Le Petit Café" } }],
          }),
        )) as unknown as typeof fetch,
    });
    const discovery = makeDiscovery({ overpass, saved: () => [] });
    const deps: NearbyPlacesDeps = { discovery: () => discovery };
    const tool = createNearbyPlacesTool(deps);

    const result = (await tool.execute(
      { category: "cafe", lat: 48.86, lon: 2.35, radiusM: 1500 },
      ctx(null),
    )) as { hits: Array<Record<string, unknown>>; kilde: string };

    expect(result.kilde).toBe("OpenStreetMap");
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.["name"]).toBe("Le Petit Café");
    expect(result.hits[0]?.["mapsUrl"]).toBeUndefined(); // never fabricated on the OSM path
  });

  it("uses the Google Places hit (with mapsUrl + rating) when a Google client is configured", async () => {
    const google = makeGooglePlaces({
      apiKey: "test-key",
      fetch: (async () =>
        new Response(
          JSON.stringify({
            places: [
              {
                id: "ChIJxyz",
                displayName: { text: "Café des Arts" },
                location: { latitude: 48.86, longitude: 2.35 },
                rating: 4.6,
                userRatingCount: 210,
              },
            ],
          }),
        )) as unknown as typeof fetch,
    });
    const overpass = makeNearby({ userAgent: "test" });
    const discovery = makeDiscovery({ overpass, saved: () => [], google });
    const deps: NearbyPlacesDeps = { discovery: () => discovery };
    const tool = createNearbyPlacesTool(deps);

    const result = (await tool.execute(
      { category: "cafe", lat: 48.86, lon: 2.35, radiusM: 1500 },
      ctx(null),
    )) as { hits: Array<Record<string, unknown>>; kilde: string };

    expect(result.kilde).toBe("Google");
    expect(result.hits[0]?.["mapsUrl"]).toBe(mapsPlaceUrl("Café des Arts", "ChIJxyz"));
    expect(result.hits[0]?.["rating"]).toBe(4.6);
  });
});

// ---------------------------------------------------------------------------------------
// weather_forecast
// ---------------------------------------------------------------------------------------
describe("weather_forecast", () => {
  it("forecasts using the linked trip's destination + timezone", async () => {
    const { trip } = seedTripStore();
    const forecastFn = vi.fn(async () => ({ dateISO: "2026-07-22", summary: "sol", maxC: 28, minC: 18 }));
    const deps: WeatherForecastDeps = {
      weather: () => ({ forecast: forecastFn }),
      currentTrip: async () => ({ ok: true, trip }) as const,
    };
    const tool = createWeatherForecastTool(deps);

    const result = await tool.execute({ dateISO: "2026-07-22" }, ctx(CHAT_ID));

    expect(forecastFn).toHaveBeenCalledWith(48.8566, 2.3522, "2026-07-22", "Europe/Paris");
    expect(result).toEqual({ dateISO: "2026-07-22", summary: "sol", maxC: 28, minC: 18 });
  });

  it("errors rather than inventing a forecast when no trip is linked to the chat", async () => {
    const forecastFn = vi.fn();
    const deps: WeatherForecastDeps = { weather: () => ({ forecast: forecastFn }), currentTrip: async () => ({ ok: false, error: "no trip linked to this chat" }) as const };
    const tool = createWeatherForecastTool(deps);

    const result = await tool.execute({ dateISO: "2026-07-22" }, ctx(null));

    expect(result).toEqual({ error: "no trip linked to this chat" });
    expect(forecastFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------
// strava_routes — the mandatory refresh-token rotation gotcha
// ---------------------------------------------------------------------------------------
describe("strava_routes", () => {
  beforeEach(() => {
    process.env["MARCEL_ADMIN_TELEGRAM_ID"] = ADMIN_ID;
  });
  afterEach(() => {
    delete process.env["MARCEL_ADMIN_TELEGRAM_ID"];
  });

  it("persists a ROTATED refresh token via the injected save callback on every refresh", async () => {
    const { trip } = seedTripStore();
    let saved: StravaTokens | undefined;
    const stravaFetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "ROTATED-refresh", expires_at: 9_999_999_999 }));
      }
      if (u.includes("/segments/explore")) {
        return new Response(
          JSON.stringify({
            segments: [
              { id: 1, name: "Bois de Boulogne loop", distance: 5000, avg_grade: 1.2, elev_difference: 40, climb_category: 0, start_latlng: [48.86, 2.25] },
            ],
          }),
        );
      }
      throw new Error(`unexpected strava url: ${u}`);
    });

    const strava = makeStrava({
      clientId: "id",
      clientSecret: "secret",
      loadTokens: () => ({ accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 0 }), // already expired
      saveTokens: (t) => {
        saved = t;
      },
      now: () => 1_000_000,
      fetch: stravaFetch as unknown as typeof fetch,
    });

    const deps: StravaRoutesDeps = { strava: () => strava, currentTrip: async () => ({ ok: true, trip }) as const };
    const tool = createStravaRoutesTool(deps);

    const result = await tool.execute({ activity: "running", radiusKm: 15, mine: false }, ctx(CHAT_ID));

    expect(saved).toEqual({ accessToken: "new-access", refreshToken: "ROTATED-refresh", expiresAt: 9_999_999_999 });
    expect(Array.isArray(result)).toBe(true);
    expect((result as Array<{ name: string }>)[0]?.name).toBe("Bois de Boulogne loop");
  });

  it("returns Bendik's own recent activities when mine=true from the admin DM, without needing a linked trip", async () => {
    const stravaFetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/athlete/activities")) {
        return new Response(JSON.stringify([{ name: "Morning run", type: "Run", distance: 8000, moving_time: 2400, start_date_local: "2026-07-20T07:00:00Z" }]));
      }
      throw new Error(`unexpected strava url: ${u}`);
    });
    const strava = makeStrava({
      clientId: "id",
      clientSecret: "secret",
      loadTokens: () => ({ accessToken: "valid", refreshToken: "r", expiresAt: 9_999_999_999 }),
      saveTokens: () => {},
      now: () => 1_000_000,
      fetch: stravaFetch as unknown as typeof fetch,
    });
    const currentTrip = vi.fn();
    const deps: StravaRoutesDeps = { strava: () => strava, currentTrip };
    const tool = createStravaRoutesTool(deps);

    const result = (await tool.execute({ activity: "running", radiusKm: 15, mine: true }, adminCtx())) as Array<{ name: string }>;

    expect(result[0]?.name).toBe("Morning run");
    expect(currentTrip).not.toHaveBeenCalled();
  });

  it("rejects mine=true from a non-admin/group caller — personal Strava data is admin-DM only (review fix)", async () => {
    const strava = makeStrava({
      clientId: "id",
      clientSecret: "secret",
      loadTokens: () => ({ accessToken: "valid", refreshToken: "r", expiresAt: 9_999_999_999 }),
      saveTokens: () => {},
      now: () => 1_000_000,
      fetch: (async () => {
        throw new Error("must not reach Strava — the admin gate should reject first");
      }) as unknown as typeof fetch,
    });
    const deps: StravaRoutesDeps = { strava: () => strava, currentTrip: async () => ({ ok: false, error: "no trip linked to this chat" }) as const };
    const tool = createStravaRoutesTool(deps);

    // A group-chat caller (matches this file's default ctx()) must never see Bendik's own
    // activity data, mirroring calendar_list_events.ts's assertAdminDm gate exactly.
    await expect(tool.execute({ activity: "running", radiusKm: 15, mine: true }, ctx(CHAT_ID))).rejects.toThrow(/admin-DM only/);
    // No auth at all (e.g. a schedule-driven call) must fail closed too, not default-admit.
    await expect(tool.execute({ activity: "running", radiusKm: 15, mine: true }, ctx(null))).rejects.toThrow(/admin-DM only/);
  });

  it("does NOT gate the trip-scoped route lookup (mine=false) — that's public place data, not personal data", async () => {
    const { trip } = seedTripStore();
    const stravaFetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/segments/explore")) {
        return new Response(JSON.stringify({ segments: [] }));
      }
      throw new Error(`unexpected strava url: ${u}`);
    });
    const strava = makeStrava({
      clientId: "id", clientSecret: "secret",
      loadTokens: () => ({ accessToken: "valid", refreshToken: "r", expiresAt: 9_999_999_999 }),
      saveTokens: () => {}, now: () => 1_000_000, fetch: stravaFetch as unknown as typeof fetch,
    });
    const deps: StravaRoutesDeps = { strava: () => strava, currentTrip: async () => ({ ok: true, trip }) as const };
    const tool = createStravaRoutesTool(deps);

    // ctx(CHAT_ID) is a group caller with no admin id configured to match — must still succeed.
    await expect(tool.execute({ activity: "running", radiusKm: 15, mine: false }, ctx(CHAT_ID))).resolves.toEqual([]);
  });

  it("returns an error, not a throw, when Strava isn't connected", async () => {
    const deps: StravaRoutesDeps = { strava: () => undefined, currentTrip: async () => ({ ok: false, error: "no trip linked to this chat" }) as const };
    const tool = createStravaRoutesTool(deps);

    const result = await tool.execute({ activity: "running", radiusKm: 15, mine: false }, ctx(null));
    expect(result).toEqual({ error: "strava not connected" });
  });
});

// ---------------------------------------------------------------------------------------
// flight_status — Avinor-primary / AeroDataBox-fallback routing
// ---------------------------------------------------------------------------------------
describe("flight_status", () => {
  const AVINOR_XML_HIT = `<?xml version="1.0"?><flights>
    <flight uniqueID="1"><flight_id>SK4600</flight_id><airline>SK</airline>
      <schedule_time>2026-07-22T10:00:00Z</schedule_time>
      <status code="N"/></flight>
  </flights>`;
  const AVINOR_XML_MISS = `<?xml version="1.0"?><flights></flights>`;

  it("routes to Avinor first and reports source: avinor when the flight is found there", async () => {
    const { trip } = seedTripStore();
    const flightsFetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("asrv.avinor.no")) return new Response(AVINOR_XML_HIT);
      throw new Error(`should not reach AeroDataBox: ${u}`);
    });
    const flights = makeFlights({ fetch: flightsFetch as unknown as typeof fetch, now: () => 1_000_000 });
    const deps: FlightStatusDeps = {
      flights: () => flights,
      currentTrip: async () => ({ ok: true, trip }) as const,
      readBookings: () => "",
    };
    const tool = createFlightStatusTool(deps);

    const result = (await tool.execute({ flightNo: "SK4600", dateISO: "2026-07-22" }, ctx(CHAT_ID))) as {
      flights: Array<{ source?: string; flightNo?: string }>;
    };

    expect(result.flights[0]?.source).toBe("avinor");
    expect(flightsFetch).toHaveBeenCalledTimes(1); // never fell through to AeroDataBox
  });

  it("falls back to AeroDataBox when Avinor has no data for the flight", async () => {
    const { trip } = seedTripStore();
    const flightsFetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("asrv.avinor.no")) return new Response(AVINOR_XML_MISS);
      if (u.includes("aerodatabox")) {
        return new Response(
          JSON.stringify([{ departure: { airport: { iata: "OSL" }, scheduledTime: { local: "2026-07-22 10:00+02:00" } }, arrival: { airport: { iata: "CDG" } }, status: "Scheduled" }]),
        );
      }
      throw new Error(`unexpected url: ${u}`);
    });
    const flights = makeFlights({ fetch: flightsFetch as unknown as typeof fetch, now: () => 1_000_000, aeroDataBoxKey: "adb-key" });
    const deps: FlightStatusDeps = { flights: () => flights, currentTrip: async () => ({ ok: true, trip }) as const, readBookings: () => "" };
    const tool = createFlightStatusTool(deps);

    const result = (await tool.execute({ flightNo: "SK4601", dateISO: "2026-07-22" }, ctx(CHAT_ID))) as {
      flights: Array<{ source?: string }>;
    };

    expect(result.flights[0]?.source).toBe("aerodatabox");
  });

  it("extracts flight refs from the trip's bookings.md when no flightNo/dateISO is given", async () => {
    const { trip } = seedTripStore();
    const bookingsMd = `<!-- booking id:b1 kind:flight start:2026-07-22 end:2026-07-22 time:10:00 -->SK4600<!-- /booking -->`;
    const flightsFetch = vi.fn(async () => new Response(AVINOR_XML_HIT));
    const flights = makeFlights({ fetch: flightsFetch as unknown as typeof fetch, now: () => 1_000_000 });
    const deps: FlightStatusDeps = { flights: () => flights, currentTrip: async () => ({ ok: true, trip }) as const, readBookings: () => bookingsMd };
    const tool = createFlightStatusTool(deps);

    const result = (await tool.execute({}, ctx(CHAT_ID))) as { flights: Array<{ flightNo?: string }> };
    expect(result.flights[0]?.flightNo).toBe("SK4600");
  });

  it("errors rather than guessing when no trip is linked and no explicit flightNo/dateISO is given", async () => {
    const flights = makeFlights({ fetch: vi.fn() as unknown as typeof fetch, now: () => 1_000_000 });
    const deps: FlightStatusDeps = { flights: () => flights, currentTrip: async () => ({ ok: false, error: "no trip linked to this chat" }) as const, readBookings: () => "" };
    const tool = createFlightStatusTool(deps);

    const result = await tool.execute({}, ctx(null));
    expect(result).toEqual({ error: "no trip linked to this chat" });
  });
});

// ---------------------------------------------------------------------------------------
// remember — writes directly into TripStore's trip.md "## Notert" section
// ---------------------------------------------------------------------------------------
describe("remember", () => {
  it("creates the ## Notert section when trip.md has none yet", async () => {
    const { store, trip } = seedTripStore();
    const deps: RememberDeps = { store: () => store, currentTrip: async () => ({ ok: true, trip }) as const };
    const tool = createRememberTool(deps);

    const result = await tool.execute({ fact: "Anna er allergisk mot skalldyr" }, ctx(CHAT_ID));

    expect(result).toEqual({ ok: true });
    expect(store.read(trip, "trip.md")).toBe("## Notert\n- Anna er allergisk mot skalldyr\n");
  });

  it("appends under an existing ## Notert section, before the next heading", async () => {
    const { store, trip } = seedTripStore();
    store.write(trip, "trip.md", "## Notert\n- Første fakta\n\n## Annet\nnoe annet");
    const deps: RememberDeps = { store: () => store, currentTrip: async () => ({ ok: true, trip }) as const };
    const tool = createRememberTool(deps);

    await tool.execute({ fact: "Andre fakta" }, ctx(CHAT_ID));

    // appendNotert splices immediately before the next "## " line — a blank separator line
    // already present before that heading stays where it was (ported verbatim from old
    // Marcel's appendNotert, bin/marcel.ts:199-218).
    const content = store.read(trip, "trip.md");
    expect(content).toBe("## Notert\n- Første fakta\n\n- Andre fakta\n## Annet\nnoe annet");
  });

  it("errors rather than writing anywhere when no trip is linked to the chat", async () => {
    const { store } = seedTripStore();
    const deps: RememberDeps = { store: () => store, currentTrip: async () => ({ ok: false, error: "no trip linked to this chat" }) as const };
    const tool = createRememberTool(deps);

    const result = await tool.execute({ fact: "should not be written" }, ctx(null));
    expect(result).toEqual({ error: "no trip linked to this chat" });
  });
});

// ---------------------------------------------------------------------------------------
// shopping_add / shopping_remove (Fix Wave B, Finding 4) — write directly into shopping.md,
// the file Finding 1's dynamic trip-context instructions render under "## Handleliste".
// ---------------------------------------------------------------------------------------
describe("shopping_add", () => {
  it("appends a '- item' line to shopping.md", async () => {
    const { store, trip } = seedTripStore();
    const deps: ShoppingAddDeps = { store: () => store, currentTrip: async () => ({ ok: true, trip }) as const };
    const tool = createShoppingAddTool(deps);

    const result = await tool.execute({ item: "solkrem" }, ctx(CHAT_ID));

    expect(result).toEqual({ ok: true });
    expect(store.read(trip, "shopping.md")).toBe("- solkrem\n");
  });

  it("appends to existing content rather than overwriting it", async () => {
    const { store, trip } = seedTripStore();
    store.write(trip, "shopping.md", "- melk\n");
    const deps: ShoppingAddDeps = { store: () => store, currentTrip: async () => ({ ok: true, trip }) as const };
    const tool = createShoppingAddTool(deps);

    await tool.execute({ item: "brød" }, ctx(CHAT_ID));

    expect(store.read(trip, "shopping.md")).toBe("- melk\n- brød\n");
  });

  it("errors rather than writing anywhere when no trip is linked to the chat", async () => {
    const { store } = seedTripStore();
    const deps: ShoppingAddDeps = { store: () => store, currentTrip: async () => ({ ok: false, error: "no trip linked to this chat" }) as const };
    const tool = createShoppingAddTool(deps);

    const result = await tool.execute({ item: "should not be written" }, ctx(null));
    expect(result).toEqual({ error: "no trip linked to this chat" });
  });
});

describe("shopping_remove", () => {
  it("removeShoppingLine drops any line containing the item, case-insensitively", () => {
    expect(removeShoppingLine("- Solkrem\n- Melk\n- Brød", "solkrem")).toBe("- Melk\n- Brød");
    expect(removeShoppingLine("- Melk\n- Brød", "ost")).toBe("- Melk\n- Brød");
  });

  it("rewrites shopping.md with the matching line removed", async () => {
    const { store, trip } = seedTripStore();
    store.write(trip, "shopping.md", "- solkrem\n- melk\n- brød");
    const deps: ShoppingRemoveDeps = { store: () => store, currentTrip: async () => ({ ok: true, trip }) as const };
    const tool = createShoppingRemoveTool(deps);

    const result = await tool.execute({ item: "melk" }, ctx(CHAT_ID));

    expect(result).toEqual({ ok: true });
    expect(store.read(trip, "shopping.md")).toBe("- solkrem\n- brød");
  });

  it("errors rather than writing anywhere when no trip is linked to the chat", async () => {
    const { store } = seedTripStore();
    const deps: ShoppingRemoveDeps = { store: () => store, currentTrip: async () => ({ ok: false, error: "no trip linked to this chat" }) as const };
    const tool = createShoppingRemoveTool(deps);

    const result = await tool.execute({ item: "solkrem" }, ctx(null));
    expect(result).toEqual({ error: "no trip linked to this chat" });
  });
});

// ---------------------------------------------------------------------------------------
// currency_convert — ORB-51 posture: throw, never a silent wrong number
// ---------------------------------------------------------------------------------------
describe("currency_convert", () => {
  it("parses a stubbed Frankfurter response and returns the converted amount", async () => {
    const currency = makeCurrency({
      fetch: (async () => new Response(JSON.stringify({ amount: 1, base: "EUR", date: "2026-08-16", rates: { NOK: 11.5 } }))) as unknown as typeof fetch,
    });
    const deps: CurrencyConvertDeps = { currency: () => currency };
    const tool = createCurrencyConvertTool(deps);

    const result = await tool.execute({ amount: 100, from: "eur", to: "nok" }, ctx(null));

    expect(result).toEqual({ amount: 100, from: "EUR", to: "NOK", rate: 11.5, converted: 1150, date: "2026-08-16" });
  });

  it("throws a typed CurrencyUnavailableError on a stub 500, never returning a number", async () => {
    const currency = makeCurrency({ fetch: (async () => new Response("", { status: 500 })) as unknown as typeof fetch });
    const deps: CurrencyConvertDeps = { currency: () => currency };
    const tool = createCurrencyConvertTool(deps);

    await expect(tool.execute({ amount: 100, from: "EUR", to: "NOK" }, ctx(null))).rejects.toBeInstanceOf(CurrencyUnavailableError);
  });
});

// ---------------------------------------------------------------------------------------
// transit_directions — mode=transit marshalling
// ---------------------------------------------------------------------------------------
/** ORB-168 gave `transit_directions` two providers, chosen by the RESOLVED COUNTRY of both
 *  endpoints. These two tests are about the GOOGLE half — the marshalling and the absent-key
 *  posture — so their Entur stub resolves everything outside Norway, which is what sends the
 *  journey down the Google path. The routing decision itself has its own file:
 *  `tests/transit-routing.test.ts`. */
function foreignEntur(): EnturClient {
  return {
    resolvePlace: async (text: string) => ({
      id: null,
      name: text,
      locality: null,
      county: null,
      countryA: "FRA",
      lat: 48.88,
      lon: 2.355,
    }),
    plan: async () => {
      throw new Error("transit_directions must not plan a foreign journey with Entur");
    },
  };
}

describe("transit_directions", () => {
  it("requests mode=transit and returns the parsed route", async () => {
    let requestedUrl = "";
    const transit = makeTransit({
      apiKey: "test-key",
      fetch: (async (url: string | URL) => {
        requestedUrl = String(url);
        return new Response(
          JSON.stringify({
            status: "OK",
            routes: [
              {
                legs: [
                  {
                    duration: { text: "25 mins", value: 1500 },
                    distance: { text: "6.2 km" },
                    departure_time: { text: "10:05am" },
                    arrival_time: { text: "10:30am" },
                    steps: [
                      { travel_mode: "WALKING", html_instructions: "Walk to <b>station</b>", duration: { text: "3 mins" } },
                      { travel_mode: "TRANSIT", html_instructions: "Take the <b>metro</b>", duration: { text: "18 mins" }, transit_details: { line: { short_name: "M1", vehicle: { type: "SUBWAY" } } } },
                    ],
                  },
                ],
              },
            ],
          }),
        );
      }) as unknown as typeof fetch,
    });
    const deps: TransitDirectionsDeps = { transit: () => transit, entur: () => foreignEntur() };
    const tool = createTransitDirectionsTool(deps);

    const result = (await tool.execute({ origin: "Gare du Nord", destination: "Eiffel Tower" }, ctx(null))) as {
      durationText: string;
      steps: Array<{ mode: string; line?: string }>;
    };

    expect(requestedUrl).toContain("mode=transit");
    expect(requestedUrl).toContain("origin=Gare%20du%20Nord");
    expect(result.durationText).toBe("25 mins");
    expect(result.steps[1]?.mode).toBe("TRANSIT");
    expect(result.steps[1]?.line).toBe("M1");
  });

  it("returns an explicit unavailable result, not a throw, when no key is configured", async () => {
    const deps: TransitDirectionsDeps = { transit: () => undefined, entur: () => foreignEntur() };
    const tool = createTransitDirectionsTool(deps);

    const result = await tool.execute({ origin: "A", destination: "B" }, ctx(null));
    expect(result).toEqual({ error: "transit directions unavailable — no Google Places key configured" });
  });
});
