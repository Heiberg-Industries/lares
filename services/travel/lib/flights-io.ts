// lib/flights-io.ts — I/O boundary for live flight data. Ported verbatim from
// services/marcel/lib/flights-io.ts (Task 6) — no logic changes.
// Source routing: Avinor (free, authoritative, no key) for any leg touching a Norwegian
// airport; AeroDataBox (RapidAPI, optional key, budgeted) otherwise or as fallback.
import { parseAvinorXml, NORWEGIAN_AIRPORTS, type FlightRef, type FlightStatus } from "./flights.js";

const AVINOR_BASE = "https://asrv.avinor.no/XmlFeed/v1.0";
const ADB_HOST = "aerodatabox.p.rapidapi.com";
const AVINOR_CACHE_SECONDS = 180; // Avinor's usage rule: ≥3 min between identical queries
const ADB_DAILY_BUDGET = 150; // free-tier protection

export interface FlightsDeps {
  fetch: typeof globalThis.fetch;
  now(): number;
  aeroDataBoxKey?: string;
  log?(msg: string): void;
}

interface AdbLeg {
  departure?: {
    airport?: { iata?: string };
    scheduledTime?: { local?: string };
    revisedTime?: { local?: string };
    terminal?: string;
    gate?: string;
    checkInDesk?: string;
  };
  arrival?: {
    airport?: { iata?: string };
    scheduledTime?: { local?: string };
    revisedTime?: { local?: string };
    predictedTime?: { local?: string };
    terminal?: string;
    gate?: string;
    baggageBelt?: string;
  };
  status?: string;
}

function localHhmm(adbLocal?: string): string | undefined {
  // ADB local format: "2026-07-22 14:15+02:00" → "14:15"
  const m = adbLocal?.match(/\d{4}-\d{2}-\d{2} (\d{2}:\d{2})/);
  return m?.[1];
}

export function makeFlights(deps: FlightsDeps) {
  const avinorCache = new Map<string, { at: number; xml: string }>();
  let adbCalls = 0;
  let adbDay = "";

  async function avinorFeed(airport: string, direction: "D" | "A"): Promise<string | null> {
    const key = `${airport}:${direction}`;
    const hit = avinorCache.get(key);
    if (hit && deps.now() - hit.at < AVINOR_CACHE_SECONDS) return hit.xml;
    try {
      const res = await deps.fetch(
        `${AVINOR_BASE}?TimeFrom=1&TimeTo=7&airport=${airport}&direction=${direction}`
      );
      if (!res.ok) return hit?.xml ?? null;
      const xml = await res.text();
      avinorCache.set(key, { at: deps.now(), xml });
      return xml;
    } catch {
      return hit?.xml ?? null; // stale beats nothing; poller retries next tick
    }
  }

  async function adbStatus(ref: FlightRef): Promise<FlightStatus | null> {
    if (!deps.aeroDataBoxKey) return null;
    const today = new Date(deps.now() * 1000).toISOString().slice(0, 10);
    if (adbDay !== today) {
      adbDay = today;
      adbCalls = 0;
    }
    if (adbCalls >= ADB_DAILY_BUDGET) {
      deps.log?.("flights: aerodatabox daily budget exhausted");
      return null;
    }
    adbCalls++;
    try {
      const res = await deps.fetch(
        `https://${ADB_HOST}/flights/number/${encodeURIComponent(ref.flightNo)}/${ref.dateISO}?withAircraftImage=false&withLocation=false`,
        {
          headers: {
            "X-RapidAPI-Key": deps.aeroDataBoxKey,
            "X-RapidAPI-Host": ADB_HOST,
          },
        }
      );
      if (!res.ok) return null;
      const legs = (await res.json()) as AdbLeg[];
      const leg = legs?.[0];
      if (!leg) return null;
      const scheduled = localHhmm(leg.departure?.scheduledTime?.local);
      const revised = localHhmm(leg.departure?.revisedTime?.local);
      return {
        flightNo: ref.flightNo,
        dateISO: ref.dateISO,
        from: leg.departure?.airport?.iata,
        to: leg.arrival?.airport?.iata,
        scheduled,
        estimated: revised && revised !== scheduled ? revised : undefined,
        statusCode: leg.status,
        statusText: leg.status,
        gate: leg.departure?.gate,
        checkIn: leg.departure?.checkInDesk,
        belt: leg.arrival?.baggageBelt,
        terminal: leg.departure?.terminal,
        arrivalTerminal: leg.arrival?.terminal,
        cancelled: /cancel/i.test(leg.status ?? ""),
        source: "aerodatabox",
      };
    } catch (err) {
      deps.log?.(
        `flights: aerodatabox failed — ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  return {
    async status(
      ref: FlightRef,
      opts?: { avinorAirport?: string; direction?: "D" | "A" }
    ): Promise<FlightStatus | null> {
      // Avinor first when a Norwegian airport is in play (authoritative + free).
      if (opts?.avinorAirport && NORWEGIAN_AIRPORTS.has(opts.avinorAirport)) {
        const xml = await avinorFeed(opts.avinorAirport, opts.direction ?? "D");
        if (xml) {
          const parsed = parseAvinorXml(xml, ref.flightNo);
          if (parsed) {
            const base = { dateISO: ref.dateISO, cancelled: false, ...parsed, flightNo: ref.flightNo } as FlightStatus;
            if (opts.direction === "A") {
              base.from = parsed.to;
              base.to = opts.avinorAirport;
            } else {
              base.from = base.from ?? opts.avinorAirport;
            }
            return base;
          }
        }
      }
      return adbStatus(ref);
    },
  };
}
