// Ported from services/marcel/tests/flights-io.test.ts (review fix, finding 10). lib/flights-io.ts
// was copied UNCHANGED into eve-marcel (Task 6) but its test suite was never re-ported. Import
// path is the only change — the logic under test is byte-identical. Fixture copied verbatim
// from services/marcel/tests/fixtures/adb-sk4705.json.
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeFlights } from "../lib/flights-io.js";

const ADB_JSON = fs.readFileSync(path.join(__dirname, "fixtures", "adb-sk4705.json"), "utf8");
const AVINOR_XML = `<airport name="OSL"><flights><flight uniqueID="1"><flight_id>SK4705</flight_id><schedule_time>2026-07-22T12:15:00Z</schedule_time><arr_dep>D</arr_dep><airport>NCE</airport><check_in>4-6</check_in><gate>E7</gate><status code="E" time="2026-07-22T12:55:00Z"/></flight></flights></airport>`;
const AVINOR_XML_ARRIVAL = `<airport name="OSL"><flights><flight uniqueID="1"><flight_id>SK4705</flight_id><schedule_time>2026-07-22T15:15:00Z</schedule_time><arr_dep>A</arr_dep><airport>NCE</airport><belt_number>12A</belt_number><status code="A" time="2026-07-22T15:18:00Z"/></flight></flights></airport>`;

function fakeFetch(routes: Record<string, { body: string; status?: number }>) {
  return vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    for (const [substr, r] of Object.entries(routes)) {
      if (u.includes(substr)) return new Response(r.body, { status: r.status ?? 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

const REF = { flightNo: "SK4705", dateISO: "2026-07-22", time: "14:15" };

describe("makeFlights.status", () => {
  it("uses Avinor for a Norwegian departure and parses gate + estimated", async () => {
    const f = fakeFetch({ "asrv.avinor.no": { body: AVINOR_XML } });
    const flights = makeFlights({ fetch: f, now: () => 1_784_000_000 });
    const st = await flights.status(REF, { avinorAirport: "OSL", direction: "D" });
    expect(st!.source).toBe("avinor");
    expect(st!.gate).toBe("E7");
    expect(st!.estimated).toBe("14:55");
  });

  it("uses Avinor for a Norwegian arrival and merges airports with belt", async () => {
    const f = fakeFetch({ "asrv.avinor.no": { body: AVINOR_XML_ARRIVAL } });
    const flights = makeFlights({ fetch: f, now: () => 1_784_000_000 });
    const st = await flights.status(REF, { avinorAirport: "OSL", direction: "A" });
    expect(st!.source).toBe("avinor");
    expect(st!.from).toBe("NCE");
    expect(st!.to).toBe("OSL");
    expect(st!.belt).toBe("12A");
  });

  it("caches the Avinor airport feed for 3 minutes (second call = no fetch)", async () => {
    const f = fakeFetch({ "asrv.avinor.no": { body: AVINOR_XML } });
    let t = 1_784_000_000;
    const flights = makeFlights({ fetch: f, now: () => t });
    await flights.status(REF, { avinorAirport: "OSL", direction: "D" });
    t += 60; // +1 min — inside cache window
    await flights.status(REF, { avinorAirport: "OSL", direction: "D" });
    expect((f as any).mock.calls.length).toBe(1);
    t += 180; // past 3 min — refetches
    await flights.status(REF, { avinorAirport: "OSL", direction: "D" });
    expect((f as any).mock.calls.length).toBe(2);
  });

  it("falls back to AeroDataBox with airports, times, and arrival terminal", async () => {
    const f = fakeFetch({
      "asrv.avinor.no": { body: `<airport name="OSL"><flights></flights></airport>` },
      "aerodatabox.p.rapidapi.com": { body: ADB_JSON },
    });
    const flights = makeFlights({ fetch: f, now: () => 1_784_000_000, aeroDataBoxKey: "k" });
    const st = await flights.status(REF, { avinorAirport: "OSL", direction: "D" });
    expect(st!.source).toBe("aerodatabox");
    expect(st!.from).toBe("OSL");
    expect(st!.to).toBe("NCE");
    expect(st!.scheduled).toBe("14:15"); // departure local time from fixture
    expect(st!.arrivalTerminal).toBe("2");
  });

  it("returns null (not throw) when no source has the flight and logs nothing to the group", async () => {
    const f = fakeFetch({ "asrv.avinor.no": { body: `<airport name="OSL"><flights></flights></airport>` } });
    const flights = makeFlights({ fetch: f, now: () => 1_784_000_000 }); // no ADB key
    expect(await flights.status(REF, { avinorAirport: "OSL", direction: "D" })).toBeNull();
  });

  it("stops calling AeroDataBox after the daily budget (150) is exhausted", async () => {
    const f = fakeFetch({ "aerodatabox.p.rapidapi.com": { body: ADB_JSON } });
    const flights = makeFlights({ fetch: f, now: () => 1_784_000_000, aeroDataBoxKey: "k" });
    for (let i = 0; i < 155; i++) {
      await flights.status({ flightNo: "AF1234", dateISO: "2026-07-22" }); // no avinorAirport → ADB only
    }
    expect((f as any).mock.calls.length).toBeLessThanOrEqual(150);
  });
});
