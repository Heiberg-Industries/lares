/**
 * agent/tools/transit_directions.ts — real public-transit directions (NEW, 2026-08-16
 * approved improvement, Tier 2 #5 — no old-Marcel equivalent). Thin wrapper only: the Google
 * Maps Directions API (transit mode) client lives in `lib/transit.ts`, and the Entur client
 * lives once in `@lares/agent-kit/entur-client` — this file writes neither.
 *
 * TWO PROVIDERS, ONE TOOL (ORB-168). Google Directions does not know Vy: no Norwegian
 * real-time, no platform, and a rail answer weak enough that the brief used to hedge
 * ("roughly hourly, about 1h40"). Entur — the national journey planner — knows all of it, and
 * only inside Norway. So a journey whose BOTH endpoints resolve to Norway is planned by Entur;
 * everything else stays on the unchanged Google path, which abroad is the only option there is.
 *
 * THE DECISION IS THE RESOLVED COUNTRY, NEVER THE QUERY TEXT. Both endpoints go through
 * Entur's geocoder first and the routing keys off `countryA === "NOR"` (ISO-3166 alpha-3).
 * String-matching the query would call a French "Bergen" Norwegian and a Norwegian
 * "Storgaten 32" foreign — and, worse, it would send an out-of-coverage place (a Swedish stop
 * that resolves perfectly well) to Entur, which answers it with `tripPatterns: []` at HTTP 200.
 * That empty list is contractually "a real answer", so the model would read an unreachable
 * country as "there are no trains". Country detection is where that is caught.
 *
 * WHAT FALLS BACK AND WHAT DOES NOT — the asymmetry is deliberate:
 *   • the geocoder unreachable, stalled, or simply unaware of the place → Google. Detection
 *     failing tells us nothing about the journey, abroad is the common case, and Google is the
 *     only provider that covers it.
 *   • Entur unreachable on a pair already PROVEN Norwegian → the typed `EnturUnavailableError`
 *     propagates, exactly as `currency_convert`'s ORB-51 posture does and as
 *     `agent-kit__transit_plan` does on the same failure. It must NOT fall back to Google: a
 *     Norwegian train answered by Google Directions is precisely the weak answer this ticket
 *     exists to remove, and it would look like a success in every log.
 *
 * Boundary: the model must NEVER invent a bus/train line, a departure time, a platform, or a
 * duration — only what this tool returns is real.
 *
 * Reuses the SAME `GOOGLE_PLACES_API_KEY_FILE` secret `place_link.ts`/`nearby_places.ts`
 * already read (default `/run/secrets/google-places-api-key`, mirroring
 * `lib/google-places.ts`'s `makeGooglePlaces({ apiKey })` construction — same key, one more
 * Google API enabled on the same GCP project, per the brief: "one GCP project, one more API
 * enabled on it — no new secret file"). Absent key disables only the GOOGLE half
 * (`{ error: "transit directions unavailable — no Google Places key configured" }`) rather
 * than failing loudly — matches `strava_routes.ts`'s "optional dependency absent" posture,
 * not `currency_convert.ts`'s ORB-51 posture: a missing transit route is "try again"
 * territory (`lib/transit.ts`'s own best-effort contract), not a real-money mistake. Entur
 * needs no key at all, so a Norwegian journey is still answered without one.
 */
import { readFileSync } from "node:fs";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { telegramFetch } from "@lares/agent-kit/telegram-fetch";
import { makeEntur, EnturPlaceNotFoundError } from "@lares/agent-kit/entur-client";
import type {
  EnturCallOptions,
  PlaceInput,
  PlanArgs,
  ResolvedPlace,
  TripPattern,
} from "@lares/agent-kit/entur-client";
import { makeTransit, type Transit } from "../lib/transit.js";

function optionalSecret(envVar: string, fallbackPath: string): string | undefined {
  const path = process.env[envVar] ?? fallbackPath;
  try {
    const value = readFileSync(path, "utf8").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

let cachedTransit: Transit | null | undefined; // undefined = not yet resolved; null = confirmed unconfigured

function realTransit(): Transit | undefined {
  if (cachedTransit === undefined) {
    const apiKey = optionalSecret("GOOGLE_PLACES_API_KEY_FILE", "/run/secrets/google-places-api-key");
    cachedTransit = apiKey ? makeTransit({ apiKey, fetch: telegramFetch }) : null;
  }
  return cachedTransit ?? undefined;
}

/** Just the two functions this tool uses, so a test supplies a fake without an HTTP layer —
 *  the same narrow seam `packages/agent-kit/extension/tools/transit_plan.ts` declares. */
export interface EnturClient {
  resolvePlace(text: string, opts?: EnturCallOptions): Promise<ResolvedPlace>;
  plan(args: PlanArgs): Promise<TripPattern[]>;
}

let cachedEntur: EnturClient | undefined;

/** Built on first call, never at module scope. Entur needs no credential, so the only thing
 *  deferred here is the construction itself — but `telegramFetch` is not optional: Marcel is
 *  network-SEALED and reaches `api.entur.io` only through the shared squid container, where it
 *  is allowed BY DOMAIN. Node's built-in `fetch` ignores proxy env vars outright (the lesson
 *  `@lares/agent-kit/telegram-fetch`'s header records in full), so the routing has to be
 *  explicit — the same `createTelegramFetch()`-bound seam this file's Google client uses. A
 *  plain `fetch` here compiles, passes the suite, and then fails on the box as "unreachable". */
function realEntur(): EnturClient {
  if (!cachedEntur) cachedEntur = makeEntur({ fetch: telegramFetch });
  return cachedEntur;
}

export interface TransitDirectionsDeps {
  transit(): Transit | undefined;
  entur(): EnturClient;
}

export const defaultTransitDirectionsDeps: TransitDirectionsDeps = {
  transit: realTransit,
  entur: realEntur,
};

/** How long country detection may take IN TOTAL — both geocoder lookups together, not each.
 *  Per-lookup it would let an Oslo → Paris question spend the budget twice before Google's own
 *  8 s even started, ~20 s on a live turn. Guards DETECTION only; the Entur plan carries its own
 *  per-request bound inside the kit client and must surface its own failure, never fall back. */
const COUNTRY_DETECTION_BUDGET_MS = 6000;

/** One deadline shared by every request in a pair. It both REJECTS the wait and ABORTS the
 *  request: the rejection is what stops the turn waiting, the abort is what stops a stalled
 *  socket lingering in a long-lived container after nobody is listening any more. */
function pairBudget(ms: number) {
  const controller = new AbortController();
  let fire: (reason: Error) => void = () => {};
  const expired = new Promise<never>((_resolve, reject) => {
    fire = reject;
  });
  expired.catch(() => {}); // the race below handles it; this keeps an unraced expiry quiet
  const timer = setTimeout(() => {
    const reason = new Error("Entur geocoder budget exhausted");
    controller.abort(reason);
    fire(reason);
  }, ms);
  return {
    signal: controller.signal,
    /** `work`, or a rejection the moment the shared deadline passes — whichever comes first. */
    race: <T>(work: Promise<T>): Promise<T> => Promise.race([work, expired]),
    done: () => clearTimeout(timer),
  };
}

/** An `NSR:` stop goes to the planner by id; anything else (`id === null`, most often a street
 *  address) by coordinates — `PlaceInput`'s id branch takes a plain `string` precisely so a null
 *  id is a compile error here rather than another silent empty-200. */
function locationFor(place: ResolvedPlace): PlaceInput {
  return place.id !== null ? { id: place.id } : { lat: place.lat, lon: place.lon };
}

/** What the model is shown about each endpoint — enough to notice a wrong town, no more. */
function describePlace(place: ResolvedPlace) {
  return { name: place.name, locality: place.locality, county: place.county, country: place.countryA };
}

/** Both endpoints resolved AND both in Norway, or `null` meaning "use Google". Every failure
 *  in here — unreachable, unknown place, stalled — is a `null`, on purpose: a detection that
 *  could not run is not evidence the journey is Norwegian. Deliberately does NOT wrap the
 *  planner call; see this file's header for why that asymmetry is the whole ticket. */
async function norwegianPair(
  entur: EnturClient,
  origin: string,
  destination: string,
): Promise<{ from: ResolvedPlace; to: ResolvedPlace } | null> {
  const budget = pairBudget(COUNTRY_DETECTION_BUDGET_MS);
  try {
    // Sequential, and short-circuiting: a foreign origin means the second lookup is wasted.
    const from = await budget.race(entur.resolvePlace(origin, { signal: budget.signal }));
    if (from.countryA !== "NOR") return null;
    const to = await budget.race(entur.resolvePlace(destination, { signal: budget.signal }));
    if (to.countryA !== "NOR") return null;
    return { from, to };
  } catch (err) {
    // THE ONLY PLACE THIS IS OBSERVABLE. Every failure in here becomes `null`, i.e. "use Google",
    // and from outside that is indistinguishable from a foreign journey answered correctly. Four
    // very different things arrive here — the geocoder was unreachable, the pair budget expired,
    // the place genuinely does not exist, or the Norway-bias guard discarded a candidate — and
    // the guard has now misfired three times. Unlogged, the next misfire is findable only by
    // running a sweep from a laptop; logged, it is one `docker logs` away.
    if (err instanceof EnturPlaceNotFoundError) {
      console.warn(
        `eve-marcel: transit_directions — Entur did not resolve ${JSON.stringify(err.query)}` +
          (err.rejected !== undefined
            ? `; discarded ${JSON.stringify(err.rejected)} as unrelated (Norway-bias guard)`
            : " (no candidates)") +
          " — routing to Google",
      );
    } else {
      console.warn(
        `eve-marcel: transit_directions — country detection failed for ${JSON.stringify(origin)} → ` +
          `${JSON.stringify(destination)}: ${(err as Error).name}: ${(err as Error).message} — routing to Google`,
      );
    }
    return null;
  } finally {
    budget.done();
  }
}

const inputSchema = z.object({
  origin: z.string().min(1).describe("start address or place name"),
  destination: z.string().min(1).describe("end address or place name"),
  departAt: z.number().optional().describe("unix seconds — omit for the next available departure"),
});

export function createTransitDirectionsTool(deps: TransitDirectionsDeps) {
  return defineTool({
    description:
      "Real public-transit directions between two places, ANYWHERE — this is the one that still " +
      "works outside Norway. Inside Norway it is answered by Entur, the national journey planner " +
      "(Vy, Ruter, every Norwegian operator), with real departure and arrival times, line codes, " +
      "platform when one is assigned, and the real-time delay; outside Norway by the Google Maps " +
      "Directions API in transit mode, with duration, transfers, line names, and fare when " +
      "Google reports one. It picks between them itself, from the resolved country of both " +
      "endpoints — you do not choose, and you must not say which one answered unless asked. " +
      "It always plans FORWARD, from `departAt` or from now. The one thing it cannot express is " +
      "arrive-by: for 'be in Tønsberg by 17:00' inside Norway, use agent-kit__transit_plan, " +
      "which also lets you ask for more or fewer than three itineraries. In every other respect " +
      "the two are the same Entur data inside Norway — same platform, same real-time delay, " +
      "three itineraries either way — so a plain 'when is the next train' is answered " +
      "identically by both. " +
      "The model must NEVER invent a bus/train line, a departure time, a platform, or a " +
      "duration — only what this tool returns is real, and if it returns nothing there is " +
      "nothing to say about transport: do not estimate, do not say 'roughly hourly'. Reuses " +
      "the same Google project as place_link/nearby_places, no separate key; Entur needs none, " +
      "so a Norwegian journey is answered even when the Google key is absent. Returns an " +
      "explicit not-found/unavailable result rather than a guess when there is no route or the " +
      "key isn't configured, and raises EnturUnavailableError — meaning Entur was unreachable, " +
      "NOT that there are no departures — rather than downgrading a Norwegian journey to Google.",
    inputSchema,
    async execute({ origin, destination, departAt }) {
      const entur = deps.entur();
      const norwegian = await norwegianPair(entur, origin, destination);
      if (norwegian) {
        const itineraries = await entur.plan({
          from: locationFor(norwegian.from),
          to: locationFor(norwegian.to),
          dateTime:
            departAt !== undefined
              ? new Date(Math.trunc(departAt) * 1000).toISOString()
              : new Date().toISOString(),
        });
        return {
          provider: "entur",
          from: describePlace(norwegian.from),
          to: describePlace(norwegian.to),
          itineraries,
        };
      }

      const transit = deps.transit();
      if (!transit) return { error: "transit directions unavailable — no Google Places key configured" };
      const route = await transit.route(origin, destination, departAt);
      return route ?? { notFound: { origin, destination } };
    },
  });
}

export default createTransitDirectionsTool(defaultTransitDirectionsDeps);
