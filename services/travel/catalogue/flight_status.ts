/**
 * agent/tools/flight_status.ts — live flight status for the trip's flights, ported from old
 * Marcel's `tools.flight_status` (`services/marcel/lib/brain.ts:228-249`). Thin wrapper
 * only: all Avinor/AeroDataBox source-routing lives in `lib/flights-io.ts` (Task 6 port,
 * unchanged) and the bookings.md flight-ref extraction lives in `lib/flights.ts` (also Task
 * 6, unchanged).
 *
 * Boundary: the model must NEVER invent a delay, gate, check-in desk, or status — only what
 * this tool returns is real.
 *
 * Source routing (faithful port, including old Marcel's own simplification): Norwegian
 * airports go through Avinor first (free, authoritative, no key) — every call here hardcodes
 * `avinorAirport: "OSL"` because Marcel's family trips always depart Oslo, exactly matching
 * `services/marcel/lib/brain.ts:244`'s own hardcoded value; `lib/flights-io.ts`'s
 * `NORWEGIAN_AIRPORTS` set is what actually decides Avinor-vs-AeroDataBox routing per call.
 * AeroDataBox (`AERODATABOX_API_KEY_FILE`, OPTIONAL — absent key means Avinor-only) is the
 * fallback for non-Norwegian legs or when Avinor has no data, budgeted at
 * `ADB_DAILY_BUDGET=150`/day inside `lib/flights-io.ts`.
 */
import { readFileSync } from "node:fs";
import { defineTool } from "eve/tools";
import type { SessionAuth } from "eve/context";
import { z } from "zod";

import { telegramFetch } from "@lares/agent-kit/telegram-fetch";
import { TripStore, type Trip } from "../lib/trip-store.js";
import { resolveCurrentTrip, type TripResolution } from "../lib/current-trip.js";
import { extractFlightRefs, type FlightRef } from "../lib/flights.js";
import { makeFlights, type FlightsDeps } from "../lib/flights-io.js";

function dataRoot(): string {
  return process.env["MARCEL_DATA_ROOT"] ?? "/data/marcel";
}

// ORB-157: shared resolver — see lib/current-trip.ts for the contract.
async function currentTrip(auth: SessionAuth | undefined, slug?: string): Promise<TripResolution> {
  return resolveCurrentTrip(new TripStore(dataRoot()), auth, { slug });
}

function optionalSecret(envVar: string, fallbackPath: string): string | undefined {
  const path = process.env[envVar] ?? fallbackPath;
  try {
    const value = readFileSync(path, "utf8").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

type Flights = ReturnType<typeof makeFlights>;
let cachedFlights: Flights | undefined;

function realFlights(): Flights {
  if (!cachedFlights) {
    const aeroDataBoxKey = optionalSecret("AERODATABOX_API_KEY_FILE", "/run/secrets/aerodatabox-api-key");
    const deps: FlightsDeps = {
      fetch: telegramFetch,
      now: () => Math.floor(Date.now() / 1000),
      log: (msg: string) => console.error("eve-marcel:", msg),
      ...(aeroDataBoxKey ? { aeroDataBoxKey } : {}),
    };
    cachedFlights = makeFlights(deps);
  }
  return cachedFlights;
}

export interface FlightStatusDeps {
  flights(): Flights;
  currentTrip(auth: SessionAuth | undefined, slug?: string): Promise<TripResolution>;
  /** Re-reads bookings.md fresh per call — mid-trip Reise-sveip can add flights the model
   *  hasn't seen yet. Separate seam from `currentTrip` purely for test injection. */
  readBookings(trip: Trip): string;
}

export const defaultFlightStatusDeps: FlightStatusDeps = {
  flights: realFlights,
  currentTrip,
  readBookings: (trip) => new TripStore(dataRoot()).read(trip, "bookings.md"),
};

const inputSchema = z.object({
  flightNo: z.string().optional().describe("e.g. SK4705 — omit to use the trip's own bookings"),
  dateISO: z.string().optional(),
  slug: z
    .string()
    .optional()
    .describe(
      "trip slug — only meaningful in the admin DM, and only when several trips are active or " +
        "upcoming; a group always uses its own linked trip",
    ),
});

export function createFlightStatusTool(deps: FlightStatusDeps) {
  return defineTool({
    description:
      "Live flight status (delay, new time, gate, check-in) for the trip's flights. Norwegian " +
      "airports (Avinor) are the authoritative primary source; AeroDataBox is the fallback for " +
      "non-Norwegian airports or when Avinor has no data. The model must NEVER invent a delay, " +
      "gate, or status — only what this tool returns. Flight number and date are read from the " +
      "trip's own bookings when not given explicitly.",
    inputSchema,
    async execute({ flightNo, dateISO, slug }, ctx) {
      const flights = deps.flights();
      let refs: FlightRef[];
      if (flightNo && dateISO) {
        refs = [{ flightNo: flightNo.replace(/\s+/g, "").toUpperCase(), dateISO }];
      } else {
        const res = await deps.currentTrip(ctx.session.auth, slug);
        if (!res.ok) return { error: res.error };
        refs = extractFlightRefs(deps.readBookings(res.trip));
      }

      const out: unknown[] = [];
      for (const ref of refs.slice(0, 4)) {
        const st = await flights.status(ref, { avinorAirport: "OSL", direction: "D" }).catch(() => null);
        out.push(st ?? { flightNo: ref.flightNo, dateISO: ref.dateISO, note: "no live data right now" });
      }
      return { flights: out, kilde: "Avinor / AeroDataBox flight data" };
    },
  });
}

export default createFlightStatusTool(defaultFlightStatusDeps);
