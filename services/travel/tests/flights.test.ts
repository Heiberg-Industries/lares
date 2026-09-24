// Ported from services/marcel/tests/flights.test.ts (review fix, finding 10). lib/flights.ts
// was copied UNCHANGED into eve-marcel (Task 6) but its test suite was never re-ported. Import
// path is the only change — the logic under test is byte-identical. Fixture copied verbatim
// from services/marcel/tests/fixtures/avinor-osl-d.xml (a real Avinor OSL departures snapshot).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { extractFlightRefs, parseAvinorXml, NORWEGIAN_AIRPORTS } from "../lib/flights.js";

const AVINOR_XML = fs.readFileSync(path.join(__dirname, "fixtures", "avinor-osl-d.xml"), "utf8");

// Real Soltur bookings.md lines (from the box).
const BOOKINGS_MD = [
  "<!-- booking id:19da6d6bd544a9fe kind:flight start:2026-07-29 end:- time:18:05 -->",
  "- SK 4706 Nice - Oslo Gardermoen (Terminal 2), departure 18:05 arrival 21:00. Passenger: X. Ticket 117-2545691950. Class W.",
  "<!-- /booking -->",
  "<!-- booking id:img-716 kind:flight start:2026-07-22 end:2026-07-29 time:14:15 -->",
  "- Outbound OSL-NCE Wed 22 Jul, SK4705 14:15-17:15 (Terminal 2 NCE). Return NCE-OSL Wed 29 Jul, SK4706 18:05-21:00. Booking ref YYB2DJ.",
  "<!-- /booking -->",
].join("\n");

describe("extractFlightRefs", () => {
  it("finds flight numbers with and without spaces, keyed to the booking's start date", () => {
    const refs = extractFlightRefs(BOOKINGS_MD);
    // Booking 1: SK 4706 → SK4706 on 2026-07-29 18:05.
    expect(refs).toContainEqual({ flightNo: "SK4706", dateISO: "2026-07-29", time: "18:05" });
    // Booking 2 mentions both flights; the one matching the header start date is SK4705.
    expect(refs).toContainEqual({ flightNo: "SK4705", dateISO: "2026-07-22", time: "14:15" });
  });
  it("dedupes the same flight+date across bookings", () => {
    const refs = extractFlightRefs(BOOKINGS_MD);
    expect(refs.filter((r) => r.flightNo === "SK4706" && r.dateISO === "2026-07-29").length).toBe(1);
  });
  it("does not match ticket numbers or booking refs as flights", () => {
    const refs = extractFlightRefs(BOOKINGS_MD);
    const nos = refs.map((r) => r.flightNo);
    expect(nos).not.toContain("W117");     // class + ticket digits
    expect(nos.every((n) => /^[A-Z]{2}\d{2,4}$/.test(n))).toBe(true);
  });
  it("filters multi-leg bookings using primary-mention rule: keeps only primary mentions (first in booking), or all if no primary", () => {
    const refs = extractFlightRefs(BOOKINGS_MD);
    expect(refs).toHaveLength(2);
    expect(refs).toContainEqual({ flightNo: "SK4705", dateISO: "2026-07-22", time: "14:15" });
    expect(refs).toContainEqual({ flightNo: "SK4706", dateISO: "2026-07-29", time: "18:05" });
  });
  it("handles multiple primary mentions of same flight on different dates (e.g., outbound + return legs)", () => {
    const bookingsWithReturn = [
      "<!-- booking id:19da6d6bd544a9fe kind:flight start:2026-07-29 end:- time:18:05 -->",
      "- SK 4706 Nice - Oslo Gardermoen (Terminal 2), departure 18:05 arrival 21:00. Passenger: X. Ticket 117-2545691950. Class W.",
      "<!-- /booking -->",
      "<!-- booking id:img-716 kind:flight start:2026-07-22 end:2026-07-29 time:14:15 -->",
      "- Outbound OSL-NCE Wed 22 Jul, SK4705 14:15-17:15 (Terminal 2 NCE). Return NCE-OSL Wed 29 Jul, SK4706 18:05-21:00. Booking ref YYB2DJ.",
      "<!-- /booking -->",
      "<!-- booking id:extra-hop kind:flight start:2026-07-25 end:- time:09:00 -->",
      "- SK4705 ekstra hopp 09:00.",
      "<!-- /booking -->",
    ].join("\n");
    const refs = extractFlightRefs(bookingsWithReturn);
    expect(refs).toHaveLength(3);
    expect(refs).toContainEqual({ flightNo: "SK4705", dateISO: "2026-07-22", time: "14:15" });
    expect(refs).toContainEqual({ flightNo: "SK4705", dateISO: "2026-07-25", time: "09:00" });
    expect(refs).toContainEqual({ flightNo: "SK4706", dateISO: "2026-07-29", time: "18:05" });
  });
});

describe("parseAvinorXml", () => {
  it("parses a real feed entry: times, status, gate, check-in, delayed", () => {
    // The fixture is a live OSL departures snapshot; pick a flight present in it.
    const m = AVINOR_XML.match(/<flight_id>([A-Z]{2}\d+)<\/flight_id>/);
    expect(m).not.toBeNull();
    const st = parseAvinorXml(AVINOR_XML, m![1]!);
    expect(st).not.toBeNull();
    expect(st!.source).toBe("avinor");
    expect(st!.scheduled).toMatch(/^\d{2}:\d{2}$/);      // converted UTC→Oslo wall clock
    expect(st!.gate === undefined || typeof st!.gate === "string").toBe(true);
  });
  it("returns null for a flight not in the feed", () => {
    expect(parseAvinorXml(AVINOR_XML, "ZZ9999")).toBeNull();
  });
  it("maps status code E (new time) to an estimated wall-clock time", () => {
    const xml = `<airport name="OSL"><flights><flight uniqueID="1"><airline>DY</airline><flight_id>DY1872</flight_id><schedule_time>2026-07-20T14:45:00Z</schedule_time><arr_dep>D</arr_dep><airport>FCO</airport><check_in>1-3</check_in><gate>D2</gate><status code="E" time="2026-07-20T15:30:00Z"/><delayed>Y</delayed></flight></flights></airport>`;
    const st = parseAvinorXml(xml, "DY1872")!;
    expect(st.scheduled).toBe("16:45");   // 14:45Z in Europe/Oslo (CEST +2)
    expect(st.estimated).toBe("17:30");   // 15:30Z → 17:30 local
    expect(st.statusCode).toBe("E");
    expect(st.gate).toBe("D2");
    expect(st.checkIn).toBe("1-3");
    expect(st.cancelled).toBe(false);
  });
  it("maps status code C to cancelled", () => {
    const xml = `<airport name="OSL"><flights><flight uniqueID="1"><flight_id>SK123</flight_id><schedule_time>2026-07-20T10:00:00Z</schedule_time><arr_dep>D</arr_dep><airport>TOS</airport><status code="C" time="2026-07-20T10:00:00Z"/></flight></flights></airport>`;
    expect(parseAvinorXml(xml, "SK123")!.cancelled).toBe(true);
  });
  it("maps status code D (departed) to actual time as estimated when different from schedule", () => {
    const xml = `<airport name="OSL"><flights><flight uniqueID="1"><flight_id>DY456</flight_id><schedule_time>2026-07-20T14:00:00Z</schedule_time><arr_dep>D</arr_dep><airport>BGO</airport><status code="D" time="2026-07-20T14:46:00Z"/></flight></flights></airport>`;
    const st = parseAvinorXml(xml, "DY456")!;
    expect(st.scheduled).toBe("16:00");   // 14:00Z in Europe/Oslo (CEST +2)
    expect(st.estimated).toBe("16:46");   // 14:46Z → 16:46 local
    expect(st.statusCode).toBe("D");
    expect(st.cancelled).toBe(false);
  });
});

describe("NORWEGIAN_AIRPORTS", () => {
  it("contains the majors", () => {
    for (const a of ["OSL", "BGO", "TRD", "SVG", "TOS"]) expect(NORWEGIAN_AIRPORTS.has(a)).toBe(true);
    expect(NORWEGIAN_AIRPORTS.has("NCE")).toBe(false);
  });
});
