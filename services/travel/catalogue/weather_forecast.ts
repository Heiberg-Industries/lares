/**
 * agent/tools/weather_forecast.ts — day forecast for the trip's destination, ported from old
 * Marcel's `tools.weather` (`services/marcel/lib/brain.ts:146-153`, renamed from `weather` to
 * `weather_forecast` — the eve-native tool set uses full, self-describing slugs). Thin
 * wrapper only: all MET Norway / Open-Meteo logic lives in `lib/weather.ts` (Task 6 port,
 * unchanged).
 *
 * Boundary: the model must NEVER invent a forecast — not when this tool has no trip context,
 * and not when the requested date falls outside MET's ~9-10 day horizon (`lib/weather.ts`'s
 * `fetchDayEntries` throws rather than fabricating a 0° day; this tool lets that propagate as
 * a tool error rather than swallowing it into a synthetic result).
 *
 * Requires a trip linked to the calling chat (see `dataRoot()`/`currentTrip()` below — same
 * chat→TripStore resolution as `strava_routes.ts`/`flight_status.ts`/`remember.ts`; by the
 * time a GROUP chat turn reaches any tool at all, `agent/channels/telegram.ts`'s own
 * `tripForChat` gate has already required one, so this is a defensive re-check, not the
 * primary gate).
 */
import { defineTool } from "eve/tools";
import type { SessionAuth } from "eve/context";
import { z } from "zod";

import { telegramFetch } from "@lares/agent-kit/telegram-fetch";
import { TripStore } from "../lib/trip-store.js";
import { makeWeather, type Weather } from "../lib/weather.js";
import { resolveCurrentTrip, type TripResolution } from "../lib/current-trip.js";

const USER_AGENT = process.env.LARES_HTTP_USER_AGENT?.trim() || "Lares/0.1 (+https://github.com/Heiberg-Industries/lares)";

function dataRoot(): string {
  return process.env["MARCEL_DATA_ROOT"] ?? "/data/marcel";
}

// ORB-157: shared resolver — see lib/current-trip.ts for the contract.
async function currentTrip(auth: SessionAuth | undefined, slug?: string): Promise<TripResolution> {
  return resolveCurrentTrip(new TripStore(dataRoot()), auth, { slug });
}

let cachedWeather: Weather | undefined;

function realWeather(): Weather {
  cachedWeather ??= makeWeather({ userAgent: USER_AGENT, fetch: telegramFetch });
  return cachedWeather;
}

export interface WeatherForecastDeps {
  weather(): Weather;
  currentTrip(auth: SessionAuth | undefined, slug?: string): Promise<TripResolution>;
}

export const defaultWeatherForecastDeps: WeatherForecastDeps = {
  weather: realWeather,
  currentTrip,
};

const inputSchema = z.object({
  dateISO: z.string().describe("YYYY-MM-DD"),
  slug: z
    .string()
    .optional()
    .describe(
      "trip slug — only meaningful in the admin DM, and only when several trips are active or " +
        "upcoming; a group always uses its own linked trip",
    ),
});

export function createWeatherForecastTool(deps: WeatherForecastDeps) {
  return defineTool({
    description:
      "Get the REAL weather forecast for the trip's destination on a given date (YYYY-MM-DD) " +
      "— MET Norway primary, Open-Meteo marine fallback for sea temperature/wave height. The " +
      "model must NEVER invent a forecast: if this tool has no trip linked to the chat, or the " +
      "date is beyond the ~9-10 day forecast horizon, it fails rather than returning a made-up " +
      "day — say the forecast isn't available yet instead of guessing.",
    inputSchema,
    async execute({ dateISO, slug }, ctx) {
      const res = await deps.currentTrip(ctx.session.auth, slug);
      if (!res.ok) return { error: res.error };
      const trip = res.trip;
      return deps.weather().forecast(trip.destination.lat, trip.destination.lon, dateISO, trip.timezone);
    },
  });
}

export default createWeatherForecastTool(defaultWeatherForecastDeps);
