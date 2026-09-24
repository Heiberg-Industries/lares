// lib/flights.ts — flight-status types, bookings.md flight extraction, and Avinor XML
// parsing. Ported verbatim from services/marcel/lib/flights.ts (Task 6) — no logic changes.
// Pure module: no I/O here (fetching lives in flights-io.ts).
export interface FlightStatus {
  flightNo: string;
  dateISO: string;
  from?: string;
  to?: string;
  scheduled?: string;
  estimated?: string;
  statusCode?: string;
  statusText?: string;
  gate?: string;
  checkIn?: string;
  belt?: string;
  terminal?: string;
  arrivalTerminal?: string;
  cancelled: boolean;
  source: "avinor" | "aerodatabox" | "merged";
}

export interface FlightRef { flightNo: string; dateISO: string; time?: string }

// Avinor status codes → short Norwegian text (subset that matters for a family group).
const AVINOR_STATUS_TEXT: Record<string, string> = {
  N: "Ny info", E: "Ny tid", D: "Avgått", A: "Landet", C: "Kansellert", B: "Ombordstigning", G: "Gå til gate",
};

// IATA codes of Avinor airports (majors + typical charter/regional). Used for source routing.
export const NORWEGIAN_AIRPORTS = new Set([
  "OSL", "BGO", "TRD", "SVG", "TOS", "BOO", "KRS", "AES", "HAU", "MOL", "KSU", "EVE", "ALF", "KKN", "LKL", "BDU", "FRO", "FDE", "SOG", "SDN", "HOV", "RRS", "MJF", "MQN", "SSJ", "BNN", "OLA", "RVK", "NVK", "SKN", "SVJ", "LYR", "ANX", "LKN", "OSY", "HFT", "HVG", "MEH", "BJF", "BVG", "VDS", "VAW", "SOJ", "DLD",
]);

const FLIGHT_NO_RE = /\b([A-Z]{2})\s?(\d{2,4})\b/g;
const BOOKING_HEADER_RE = /<!-- booking id:(\S+) kind:flight start:(\S+) end:\S+ time:(\S+) -->([\s\S]*?)<!-- \/booking -->/g;

/** Flight refs from bookings.md: canonical flight numbers from kind:flight blocks,
 *  keyed to booking's start date/time. Uses primary-mention rule: the first flight
 *  number in a booking block is primary (the booking is "about" that flight);
 *  secondary mentions (e.g., return legs in combined itineraries) are secondary.
 *  For each flight: if ANY mention is primary, keep only the primary mentions;
 *  else keep all. This allows same-day connections (each leg primary in its own
 *  block) and handles multi-leg bookings (return preview → secondary → dropped if
 *  the flight has a primary mention elsewhere). Order-independent: decoupled from
 *  file order or other bookings. Dedupe on flightNo:dateISO. */
export function extractFlightRefs(bookingsMd: string): FlightRef[] {
  // Pass 1: collect candidates with isPrimary flag (true if first in its booking)
  interface Candidate extends FlightRef {
    isPrimary: boolean;
  }
  const candidates: Candidate[] = [];

  for (const b of bookingsMd.matchAll(BOOKING_HEADER_RE)) {
    const [, , startISO, time, body] = b;
    let posInBooking = 0;
    const seenInBooking = new Set<string>();

    for (const m of body!.matchAll(FLIGHT_NO_RE)) {
      const flightNo = `${m[1]}${m[2]}`;
      // Skip duplicates within same booking
      if (seenInBooking.has(flightNo)) continue;
      seenInBooking.add(flightNo);

      candidates.push({
        flightNo,
        dateISO: startISO!,
        ...(time && time !== "-" ? { time } : {}),
        isPrimary: posInBooking === 0,
      });
      posInBooking++;
    }
  }

  // Pass 2: group by flightNo, determine which candidates to keep
  const byFlight = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (!byFlight.has(c.flightNo)) {
      byFlight.set(c.flightNo, []);
    }
    byFlight.get(c.flightNo)!.push(c);
  }

  // Pass 3: dedupe and filter in stable scan order
  const seen = new Set<string>();
  const out: FlightRef[] = [];

  for (const c of candidates) {
    const key = `${c.flightNo}:${c.dateISO}`;
    if (seen.has(key)) continue;

    const allCandidatesForFlight = byFlight.get(c.flightNo)!;
    const hasPrimary = allCandidatesForFlight.some((cand) => cand.isPrimary);

    // Keep this candidate if: no primary exists (keep all), or this IS primary
    if (!hasPrimary || c.isPrimary) {
      seen.add(key);
      const { isPrimary, ...rest } = c;
      out.push(rest);
    }
  }

  return out;
}

function utcToOsloHhmm(isoUtc: string): string {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(isoUtc));
  const [h, m] = formatted.split(":");
  return `${String(Number(h) % 24).padStart(2, "0")}:${m}`;
}

function tag(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`<${name}>([^<]*)</${name}>`));
  return m?.[1] || undefined;
}

/** Find one flight in an Avinor XmlFeed response. Null when absent. */
export function parseAvinorXml(xml: string, flightNo: string): Partial<FlightStatus> | null {
  const canonical = flightNo.replace(/\s+/g, "");
  for (const m of xml.matchAll(/<flight uniqueID="[^"]*">([\s\S]*?)<\/flight>/g)) {
    const block = m[1]!;
    if (tag(block, "flight_id")?.replace(/\s+/g, "") !== canonical) continue;
    const scheduleUtc = tag(block, "schedule_time");
    const statusM = block.match(/<status code="([A-Z])"(?: time="([^"]*)")?\s*\/>/);
    const code = statusM?.[1];
    const statusTimeUtc = statusM?.[2];
    const scheduled = scheduleUtc ? utcToOsloHhmm(scheduleUtc) : undefined;
    // "E", "N" carry new estimated times; "D"/"A" carry the actual time — show as estimated
    // only when it differs from schedule.
    const revised = statusTimeUtc ? utcToOsloHhmm(statusTimeUtc) : undefined;
    const estimated = revised && revised !== scheduled && (code === "E" || code === "N" || code === "D" || code === "A") ? revised : undefined;
    return {
      flightNo: canonical,
      scheduled,
      estimated,
      statusCode: code,
      statusText: code ? AVINOR_STATUS_TEXT[code] ?? code : undefined,
      gate: tag(block, "gate"),
      checkIn: tag(block, "check_in"),
      belt: tag(block, "belt_number"),
      to: tag(block, "airport"),
      cancelled: code === "C",
      source: "avinor",
    };
  }
  return null;
}
