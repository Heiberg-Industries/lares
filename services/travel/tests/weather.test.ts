// Ported from services/marcel/tests/weather.test.ts (review fix, finding 10). lib/weather.ts
// was copied UNCHANGED into eve-marcel (Task 6) but its test suite was never re-ported. Import
// path is the only change — the logic under test is byte-identical.
import { describe, it, expect } from "vitest";
import { makeWeather } from "../lib/weather.js";

const USER_AGENT = "marcel/1.0 test@owner.example";
const LAT = 43.31; // Sainte-Maxime-ish
const LON = 6.64;
const TZ = "Europe/Paris";
const DATE = "2026-07-20";

// 6 hourly points for the target date (plus one just before and one just after the local
// day boundary, to prove tz-based filtering rather than naive UTC-date filtering) —
// Paris is UTC+2 in July, so 2026-07-19T23:00Z (01:00 local) is the day's first included
// point and 2026-07-20T22:30Z (00:30 local the next day) is excluded.
const LOCATIONFORECAST_FIXTURE = {
  properties: {
    timeseries: [
      { time: "2026-07-19T20:00:00Z", data: { instant: { details: { air_temperature: -99 } } } }, // excluded: prior local day
      { time: "2026-07-19T23:00:00Z", data: { instant: { details: { air_temperature: 22 } } } },
      { time: "2026-07-20T02:00:00Z", data: { instant: { details: { air_temperature: 19 } } } }, // min
      { time: "2026-07-20T08:00:00Z", data: { instant: { details: { air_temperature: 27, ultraviolet_index_clear_sky: 6.2 } } } },
      {
        time: "2026-07-20T11:00:00Z",
        data: {
          instant: { details: { air_temperature: 31, ultraviolet_index_clear_sky: 7.8, wind_speed: 5.4 } }, // max
          next_6_hours: { summary: { symbol_code: "clearsky_day" } },
        },
      },
      { time: "2026-07-20T14:00:00Z", data: { instant: { details: { air_temperature: 29 } }, next_6_hours: { summary: { symbol_code: "clearsky_day" } } } },
      { time: "2026-07-20T19:00:00Z", data: { instant: { details: { air_temperature: 24 } }, next_6_hours: { summary: { symbol_code: "fair_day" } } } },
      { time: "2026-07-20T22:30:00Z", data: { instant: { details: { air_temperature: 99 } } } }, // excluded: next local day
    ],
  },
};

// 21:34 local Paris time (CEST = UTC+2), matching the "21:34" example in the DayForecast doc comment.
const SUNRISE_FIXTURE = { properties: { sunset: { time: "2026-07-20T21:34:00+02:00" } } };

const OCEANFORECAST_FIXTURE = {
  properties: {
    timeseries: [
      { time: "2026-07-20T08:00:00Z", data: { instant: { details: { sea_water_temperature: 22.9, sea_surface_wave_height: 0.3 } } } },
      { time: "2026-07-20T11:00:00Z", data: { instant: { details: { sea_water_temperature: 23.1, sea_surface_wave_height: 0.4 } } } },
      { time: "2026-07-20T14:00:00Z", data: { instant: { details: { sea_water_temperature: 23.6, sea_surface_wave_height: 0.6 } } } },
    ],
  },
};

const OPEN_METEO_MARINE_FIXTURE = {
  hourly: {
    time: ["2026-07-19T22:00", "2026-07-20T00:00", "2026-07-20T06:00", "2026-07-20T12:00", "2026-07-20T18:00", "2026-07-21T00:00"],
    sea_surface_temperature: [21.0, 22.5, 23.0, 24.3, 23.8, 20.0],
    wave_height: [0.3, 0.3, 0.4, 0.5, 0.4, 0.3],
  },
};

type ScriptEntry = { status?: number; body?: unknown; error?: boolean };
type Script = {
  locationforecast?: ScriptEntry;
  sunrise?: ScriptEntry;
  oceanforecast?: ScriptEntry;
  openMeteoMarine?: ScriptEntry;
};

function scriptedFetch(script: Script) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) headers[k] = v;
    }
    calls.push({ url: u, headers });

    let entry: ScriptEntry | undefined;
    if (u.includes("locationforecast")) entry = script.locationforecast;
    else if (u.includes("sunrise")) entry = script.sunrise;
    else if (u.includes("oceanforecast")) entry = script.oceanforecast;
    else if (u.includes("marine-api.open-meteo.com")) entry = script.openMeteoMarine;

    if (!entry || entry.error) throw new Error(`scriptedFetch: no route / forced error for ${u}`);
    const status = entry.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => entry!.body ?? {} } as Response;
  }) as typeof fetch;
  return { f, calls };
}

describe("makeWeather().forecast", () => {
  it("(a) extracts max/min/uv/summary/sunset for the requested date in tz", async () => {
    const { f } = scriptedFetch({
      locationforecast: { body: LOCATIONFORECAST_FIXTURE },
      sunrise: { body: SUNRISE_FIXTURE },
      oceanforecast: { body: OCEANFORECAST_FIXTURE },
    });
    const weather = makeWeather({ fetch: f, userAgent: USER_AGENT });

    const result = await weather.forecast(LAT, LON, DATE, TZ);

    expect(result.dateISO).toBe(DATE);
    expect(result.maxC).toBe(31);
    expect(result.minC).toBe(19);
    expect(result.uvMax).toBe(7.8);
    expect(result.summary).toBe("sol");
    expect(result.sunset).toBe("21:34");
    expect(result.seaTempC).toBe(23.6);
    expect(result.waveM).toBe(0.6);
    expect(result.extreme).toBeUndefined();
  });

  // The live API returns 422 (not 404) for uncovered waters like the Mediterranean;
  // 404 is kept as a second case to prove the fallback triggers on ANY non-ok status.
  for (const status of [422, 404]) {
    it(`(b) falls back to Open-Meteo marine when MET oceanforecast returns ${status}`, async () => {
      const { f } = scriptedFetch({
        locationforecast: { body: LOCATIONFORECAST_FIXTURE },
        sunrise: { body: SUNRISE_FIXTURE },
        oceanforecast: { status, body: {} },
        openMeteoMarine: { body: OPEN_METEO_MARINE_FIXTURE },
      });
      const weather = makeWeather({ fetch: f, userAgent: USER_AGENT });

      const result = await weather.forecast(LAT, LON, DATE, TZ);

      expect(result.seaTempC).toBe(24.3);
      expect(result.waveM).toBe(0.5);
    });
  }

  it("(c) sets a heatwave extreme one-liner when max temp is 37C", async () => {
    const fixture = {
      properties: {
        timeseries: [
          {
            time: "2026-07-20T11:00:00Z",
            data: { instant: { details: { air_temperature: 37, wind_speed: 3.0 } }, next_6_hours: { summary: { symbol_code: "clearsky_day" } } },
          },
          { time: "2026-07-20T14:00:00Z", data: { instant: { details: { air_temperature: 34 } } } },
        ],
      },
    };
    const { f } = scriptedFetch({
      locationforecast: { body: fixture },
      sunrise: { body: SUNRISE_FIXTURE },
      oceanforecast: { body: OCEANFORECAST_FIXTURE },
    });
    const weather = makeWeather({ fetch: f, userAgent: USER_AGENT });

    const result = await weather.forecast(LAT, LON, DATE, TZ);

    expect(result.maxC).toBe(37);
    expect(result.extreme).toBe("hetebølge: opptil 37°");
  });

  it("(d) sends the required User-Agent header on every api.met.no call", async () => {
    const { f, calls } = scriptedFetch({
      locationforecast: { body: LOCATIONFORECAST_FIXTURE },
      sunrise: { body: SUNRISE_FIXTURE },
      oceanforecast: { body: OCEANFORECAST_FIXTURE },
    });
    const weather = makeWeather({ fetch: f, userAgent: USER_AGENT });

    await weather.forecast(LAT, LON, DATE, TZ);

    const metCalls = calls.filter((c) => c.url.includes("api.met.no"));
    expect(metCalls.length).toBe(3); // locationforecast, sunrise, oceanforecast
    for (const c of metCalls) {
      expect(c.headers["User-Agent"]).toBe(USER_AGENT);
    }
    // `complete` variant required — `compact` lacks ultraviolet_index_clear_sky (live-verified).
    expect(calls.some((c) => c.url.includes("locationforecast/2.0/complete"))).toBe(true);
  });

  it("(e) sunset and marine failures leave those fields undefined without failing the forecast", async () => {
    const { f } = scriptedFetch({
      locationforecast: { body: LOCATIONFORECAST_FIXTURE },
      sunrise: { error: true },
      oceanforecast: { error: true },
      openMeteoMarine: { error: true },
    });
    const weather = makeWeather({ fetch: f, userAgent: USER_AGENT });

    const result = await weather.forecast(LAT, LON, DATE, TZ);

    expect(result.maxC).toBe(31);
    expect(result.minC).toBe(19);
    expect(result.sunset).toBeUndefined();
    expect(result.seaTempC).toBeUndefined();
    expect(result.waveM).toBeUndefined();
  });

  it("(f) rejects when locationforecast itself fails", async () => {
    const { f } = scriptedFetch({ locationforecast: { error: true } });
    const weather = makeWeather({ fetch: f, userAgent: USER_AGENT });

    await expect(weather.forecast(LAT, LON, DATE, TZ)).rejects.toThrow();
  });

  it("(f2) rejects when a 200 timeseries has no entries for the requested date (beyond MET horizon)", async () => {
    // All entries on other dates — e.g. asking for a day past MET's ~9-10-day hourly horizon.
    const fixture = {
      properties: {
        timeseries: [
          { time: "2026-07-18T11:00:00Z", data: { instant: { details: { air_temperature: 28 } } } },
          { time: "2026-07-19T11:00:00Z", data: { instant: { details: { air_temperature: 27 } } } },
        ],
      },
    };
    const { f } = scriptedFetch({
      locationforecast: { body: fixture },
      sunrise: { body: SUNRISE_FIXTURE },
      oceanforecast: { body: OCEANFORECAST_FIXTURE },
    });
    const weather = makeWeather({ fetch: f, userAgent: USER_AGENT });

    await expect(weather.forecast(LAT, LON, DATE, TZ)).rejects.toThrow(`no forecast data for ${DATE}`);
  });

  it("(g) sets a wind extreme one-liner at >= 20 m/s", async () => {
    const fixture = {
      properties: {
        timeseries: [
          {
            time: "2026-07-20T11:00:00Z",
            data: { instant: { details: { air_temperature: 24, wind_speed: 21.5 } }, next_6_hours: { summary: { symbol_code: "clearsky_day" } } },
          },
        ],
      },
    };
    const { f } = scriptedFetch({
      locationforecast: { body: fixture },
      sunrise: { body: SUNRISE_FIXTURE },
      oceanforecast: { body: OCEANFORECAST_FIXTURE },
    });
    const weather = makeWeather({ fetch: f, userAgent: USER_AGENT });

    const result = await weather.forecast(LAT, LON, DATE, TZ);

    expect(result.extreme).toBe("kraftig vind: 22 m/s");
  });

  it("(h) sets an uvær extreme one-liner and translates heavyrain", async () => {
    const fixture = {
      properties: {
        timeseries: [
          {
            time: "2026-07-20T11:00:00Z",
            data: { instant: { details: { air_temperature: 18, wind_speed: 5 } }, next_6_hours: { summary: { symbol_code: "heavyrain" } } },
          },
        ],
      },
    };
    const { f } = scriptedFetch({
      locationforecast: { body: fixture },
      sunrise: { body: SUNRISE_FIXTURE },
      oceanforecast: { body: OCEANFORECAST_FIXTURE },
    });
    const weather = makeWeather({ fetch: f, userAgent: USER_AGENT });

    const result = await weather.forecast(LAT, LON, DATE, TZ);

    expect(result.summary).toBe("kraftig regn");
    expect(result.extreme).toBe("uvær i vente");
  });
});
