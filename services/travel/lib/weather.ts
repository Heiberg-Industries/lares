// lib/weather.ts — Yr/MET Norway day forecast + sunset + marine (with Open-Meteo fallback).
// Ported verbatim from services/marcel/lib/weather.ts (Task 6) — no logic changes.
// All network calls go through the injected `fetch` (default globalThis.fetch) so tests run
// with no network. MET terms require a User-Agent identifying the app on every api.met.no
// call — metGet() below sends it on locationforecast, sunrise, and oceanforecast requests.
// Only the locationforecast call can fail the whole forecast(); sunset and marine are
// best-effort and simply come back undefined on any error.
export interface DayForecast {
  dateISO: string;
  summary: string;
  maxC: number;
  minC: number;
  uvMax?: number;
  sunset?: string; // "21:34" local
  seaTempC?: number;
  waveM?: number;
  extreme?: string; // set when heat >= 36C, wind >= 20 m/s, or heavy rain — Norwegian one-liner
}

export interface WeatherDeps {
  fetch?: typeof globalThis.fetch;
  userAgent: string;
}

export interface Weather {
  forecast(lat: number, lon: number, dateISO: string, tz: string): Promise<DayForecast>;
}

// MET symbol_code -> short Norwegian summary. Unknown codes pass through unchanged.
const SYMBOL_NO: Record<string, string> = {
  clearsky_day: "sol",
  clearsky_night: "klarvær",
  fair_day: "lettskyet",
  fair_night: "lettskyet",
  partlycloudy_day: "delvis skyet",
  cloudy: "skyet",
  rain: "regn",
  lightrain: "lett regn",
  heavyrain: "kraftig regn",
  rainshowers_day: "regnbyger",
  thunderstorm: "tordenvær",
  fog: "tåke",
};

interface LocationforecastEntry {
  time: string;
  data: {
    instant: { details: { air_temperature?: number; wind_speed?: number; ultraviolet_index_clear_sky?: number } };
    next_6_hours?: { summary?: { symbol_code?: string } };
  };
}

interface MarineResult {
  seaTempC?: number;
  waveM?: number;
}

function localDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

function localTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

function mostCommon(codes: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const c of codes) counts.set(c, (counts.get(c) ?? 0) + 1);
  let best: string | undefined;
  let bestCount = -1;
  for (const [code, count] of counts) {
    if (count > bestCount) {
      best = code;
      bestCount = count;
    }
  }
  return best;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function makeWeather(opts: WeatherDeps): Weather {
  const _fetch = opts.fetch ?? globalThis.fetch;
  const userAgent = opts.userAgent;

  function metGet(url: string): Promise<Response> {
    return _fetch(url, { headers: { "User-Agent": userAgent } });
  }

  async function fetchDayEntries(lat: number, lon: number, dateISO: string, tz: string): Promise<LocationforecastEntry[]> {
    // Must be the `complete` variant: `compact` omits ultraviolet_index_clear_sky
    // (live-verified 2026-07-14).
    const res = await metGet(`https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${lat}&lon=${lon}`);
    if (!res.ok) throw new Error(`locationforecast: HTTP ${res.status}`);
    const json = (await res.json()) as { properties?: { timeseries?: LocationforecastEntry[] } };
    const all = json.properties?.timeseries ?? [];
    const entries = all.filter((e) => localDate(e.time, tz) === dateISO);
    // A 200 whose timeseries doesn't cover the requested date (beyond MET's ~9-10-day
    // horizon) is still locationforecast failing — throw rather than fabricate a 0° day.
    if (entries.length === 0) throw new Error(`no forecast data for ${dateISO}`);
    return entries;
  }

  async function fetchSunset(lat: number, lon: number, dateISO: string, tz: string): Promise<string | undefined> {
    try {
      const res = await metGet(`https://api.met.no/weatherapi/sunrise/3.0/sun?lat=${lat}&lon=${lon}&date=${dateISO}&offset=+02:00`);
      if (!res.ok) return undefined;
      const json = (await res.json()) as { properties?: { sunset?: { time?: string } } };
      const time = json.properties?.sunset?.time;
      return time ? localTime(time, tz) : undefined;
    } catch {
      return undefined;
    }
  }

  async function fetchMarineFromMet(lat: number, lon: number, dateISO: string, tz: string): Promise<MarineResult | undefined> {
    const res = await metGet(`https://api.met.no/weatherapi/oceanforecast/2.0/complete?lat=${lat}&lon=${lon}`);
    // Any non-ok status falls through to Open-Meteo — live API returns 422 (not 404)
    // for uncovered waters like the Mediterranean.
    if (!res.ok) return undefined;
    const json = (await res.json()) as {
      properties?: {
        timeseries?: Array<{ time: string; data: { instant: { details: { sea_water_temperature?: number; sea_surface_wave_height?: number } } } }>;
      };
    };
    const entries = (json.properties?.timeseries ?? []).filter((e) => localDate(e.time, tz) === dateISO);
    const temps = entries.map((e) => e.data.instant.details.sea_water_temperature).filter((v): v is number => v !== undefined);
    if (temps.length === 0) return undefined;
    const waves = entries.map((e) => e.data.instant.details.sea_surface_wave_height).filter((v): v is number => v !== undefined);
    return { seaTempC: round1(Math.max(...temps)), waveM: waves.length ? round1(Math.max(...waves)) : undefined };
  }

  async function fetchMarineFromOpenMeteo(lat: number, lon: number, dateISO: string, tz: string): Promise<MarineResult | undefined> {
    const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&hourly=sea_surface_temperature,wave_height&timezone=${encodeURIComponent(tz)}`;
    const res = await _fetch(url);
    if (!res.ok) return undefined;
    const json = (await res.json()) as { hourly?: { time?: string[]; sea_surface_temperature?: number[]; wave_height?: number[] } };
    const times = json.hourly?.time ?? [];
    const temps = json.hourly?.sea_surface_temperature ?? [];
    const waves = json.hourly?.wave_height ?? [];
    const dayTemps: number[] = [];
    const dayWaves: number[] = [];
    times.forEach((t, i) => {
      if (!t.startsWith(dateISO)) return;
      if (typeof temps[i] === "number") dayTemps.push(temps[i]);
      if (typeof waves[i] === "number") dayWaves.push(waves[i]);
    });
    if (dayTemps.length === 0) return undefined;
    return { seaTempC: round1(Math.max(...dayTemps)), waveM: dayWaves.length ? round1(Math.max(...dayWaves)) : undefined };
  }

  async function fetchMarine(lat: number, lon: number, dateISO: string, tz: string): Promise<MarineResult> {
    try {
      const fromMet = await fetchMarineFromMet(lat, lon, dateISO, tz);
      if (fromMet) return fromMet;
    } catch {
      // MET oceanforecast unavailable (e.g. no Mediterranean coverage) — fall through.
    }
    try {
      const fromOpenMeteo = await fetchMarineFromOpenMeteo(lat, lon, dateISO, tz);
      if (fromOpenMeteo) return fromOpenMeteo;
    } catch {
      // Both marine sources unavailable — leave fields undefined.
    }
    return {};
  }

  function extremeFor(maxC: number, windMax: number | undefined, rawSummary: string | undefined): string | undefined {
    if (maxC >= 36) return `hetebølge: opptil ${maxC}°`;
    if (windMax !== undefined && windMax >= 20) return `kraftig vind: ${Math.round(windMax)} m/s`;
    if (rawSummary === "heavyrain" || rawSummary === "thunderstorm") return "uvær i vente";
    return undefined;
  }

  return {
    async forecast(lat, lon, dateISO, tz) {
      const entries = await fetchDayEntries(lat, lon, dateISO, tz);

      const temps = entries.map((e) => e.data.instant.details.air_temperature).filter((v): v is number => v !== undefined);
      const uvs = entries.map((e) => e.data.instant.details.ultraviolet_index_clear_sky).filter((v): v is number => v !== undefined);
      const winds = entries.map((e) => e.data.instant.details.wind_speed).filter((v): v is number => v !== undefined);
      const codes = entries.map((e) => e.data.next_6_hours?.summary?.symbol_code).filter((v): v is string => v !== undefined);

      const maxC = temps.length ? Math.round(Math.max(...temps)) : 0;
      const minC = temps.length ? Math.round(Math.min(...temps)) : 0;
      const uvMax = uvs.length ? Math.max(...uvs) : undefined;
      const windMax = winds.length ? Math.max(...winds) : undefined;
      const rawSummary = mostCommon(codes);
      const summary = rawSummary ? (SYMBOL_NO[rawSummary] ?? rawSummary) : "";

      const [sunset, marine] = await Promise.all([fetchSunset(lat, lon, dateISO, tz), fetchMarine(lat, lon, dateISO, tz)]);

      const extreme = extremeFor(maxC, windMax, rawSummary);

      return {
        dateISO,
        summary,
        maxC,
        minC,
        ...(uvMax !== undefined ? { uvMax } : {}),
        ...(sunset !== undefined ? { sunset } : {}),
        ...(marine.seaTempC !== undefined ? { seaTempC: marine.seaTempC } : {}),
        ...(marine.waveM !== undefined ? { waveM: marine.waveM } : {}),
        ...(extreme !== undefined ? { extreme } : {}),
      };
    },
  };
}
