/**
 * Real Norwegian public-transport journeys, from Entur (ORB-168). The kit's ELEVENTH
 * contributed tool, and the first one Marcel resolves LIVE rather than into a sentinel.
 *
 * The HTTP mechanics, the typed errors and the normalisation all live once in
 * `../../src/entur-client.ts`. This file adds only the three things a tool has to add: an input
 * schema the model can fill in, the geocode-then-plan ordering, and the choice between the
 * planner's two location branches.
 *
 * A RELATIVE import into `../../src/`, not the package specifier — see `vault_search.ts`'s
 * header: eve's extension bundler refuses a self-referencing package import from within the
 * package's own extension source.
 *
 * WHY BOTH ENDPOINTS ARE GEOCODED FIRST. `plan()` deliberately refuses raw text. A guessed or
 * wrong place id makes the journey planner return `{"tripPatterns":[]}` at HTTP 200 —
 * indistinguishable from a real "nothing runs today" by status code, and it reads to a model as
 * "there are no trains". Resolving first means an empty list out of this tool is always a real
 * answer, and "I could not find that place" is a separate, explicit result.
 *
 * WHY THE `{lat,lon}` BRANCH IS NOT OPTIONAL POLISH. `ResolvedPlace.id` is `string | null` on
 * purpose: null whenever the geocoder returned something that is not an `NSR:` stop (a street
 * address, most often). `PlaceInput`'s id branch takes a plain `string`, so passing a null id is
 * a compile error rather than another silent empty-200. Addresses go by coordinates.
 *
 * WHY THE PROXY FETCH. Both agents that grant `transit` (eve-saga, eve-marcel) are network-
 * SEALED and reach the internet only through the shared `slack-proxy` squid container, where
 * `api.entur.io` is allowed BY DOMAIN (it is fronted by a Google Cloud load balancer, so its
 * IPs rotate). Node's built-in `fetch` ignores proxy environment variables outright — a lesson
 * `../../src/telegram-fetch.ts`'s header records in full — so the routing has to be explicit at
 * the construction site. `services/travel/agent/tools/transit_directions.ts` binds its
 * Google client through the same seam. A plain `fetch` here compiles, passes the suite, and
 * then fails on the box as "unreachable".
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { makeEntur, EnturPlaceNotFoundError, EnturUnavailableError } from "../../src/entur-client.js";
import { coversCountry } from "../../src/persona/capability-docs.js";
import type {
  EnturCallOptions,
  PlaceInput,
  PlanArgs,
  ResolvedPlace,
  TripPattern,
} from "../../src/entur-client.js";
import { createTelegramFetch } from "../../src/telegram-fetch.js";
import extension from "../extension.js";

/** Just the two functions this tool uses, so a test can supply a fake without an HTTP layer.
 *  `opts` is optional in TypeScript's own sense — a fake that ignores it stays assignable — but
 *  the real client honours it, which is what gives {@link callBudget} its teeth. */
export interface EnturClient {
  resolvePlace(text: string, opts?: EnturCallOptions): Promise<ResolvedPlace>;
  plan(args: PlanArgs, opts?: EnturCallOptions): Promise<TripPattern[]>;
}

export interface TransitPlanDeps {
  entur(): EnturClient;
}

let cached: EnturClient | undefined;

/** Built on first call, never at module scope: `eve build` evaluates this file with no config
 *  scope bound and no secrets present, and `extension.config` must not be read until a real
 *  call is in flight (the reasoning `../lib/orakel-client.ts` records for its own lazy
 *  resolver). Entur needs no credential, so the only thing being deferred here is the config
 *  read itself — and the `clientName` override with it. */
function realEntur(): EnturClient {
  if (!cached) {
    // The DEFAULT ("lares") deliberately is not repeated here: it lives in exactly one
    // place, `../../src/entur-client.ts`'s `DEFAULT_CLIENT_NAME`. This key is an override, so
    // it is `undefined` unless a mount site actually sets it.
    const clientName = extension.config.transit?.clientName;
    const timeoutMs = extension.config.transit?.timeoutMs;
    cached = makeEntur({
      ...(clientName !== undefined ? { clientName } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      fetch: createTelegramFetch(),
    });
  }
  return cached;
}

export const defaultTransitPlanDeps: TransitPlanDeps = { entur: realEntur };

/**
 * How long ONE call to this tool may take IN TOTAL — both geocoder lookups AND the plan.
 *
 * REVIEW MINOR 5. Each Entur request carries its own 8 s bound inside the client, and this tool
 * makes three of them in sequence: 24 s worst case, inside a live Telegram or Slack turn, with
 * nothing anywhere saying stop. `services/travel/agent/tools/transit_directions.ts` already
 * solved exactly this for its own pair of lookups; this is the same shape, widened to cover the
 * planner too, because the planner is the third request and not a separate budget.
 *
 * 12 s is deliberately more than one healthy round trip (~1 s for all three, measured) and much
 * less than the sum of the per-request bounds. Expiry is reported as unavailable, never as an
 * empty itinerary list — the distinction the whole client exists to protect.
 */
const JOURNEY_BUDGET_MS = 12_000;

/** One deadline shared by every request in a call. It both REJECTS the wait and ABORTS the
 *  requests: the rejection is what stops the turn waiting, the abort is what stops a stalled
 *  socket lingering in a long-lived container after nobody is listening any more. Copied in
 *  shape from `transit_directions.ts`'s `pairBudget`; the reason to duplicate rather than share
 *  is that the kit's extension source may not import from a service. */
function callBudget(ms: number) {
  const controller = new AbortController();
  let fire: (reason: Error) => void = () => {};
  const expired = new Promise<never>((_resolve, reject) => {
    fire = reject;
  });
  expired.catch(() => {}); // the race below handles it; this keeps an unraced expiry quiet
  const timer = setTimeout(() => {
    // An EnturUnavailableError on purpose: an exhausted budget is "Entur did not answer in
    // time", which is the same thing to a caller as a refused connection — and emphatically not
    // "there are no departures".
    const reason = new EnturUnavailableError(
      `Entur did not answer within ${ms}ms — treat this as unreachable, not as no departures`,
    );
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

/** An `NSR:` stop goes to the planner by id; anything else (`id === null`) by coordinates. */
function locationFor(place: ResolvedPlace): PlaceInput {
  return place.id !== null ? { id: place.id } : { lat: place.lat, lon: place.lon };
}

/** What the model is shown about each endpoint — enough to notice a wrong town, no more. */
function describePlace(place: ResolvedPlace) {
  return { name: place.name, locality: place.locality, county: place.county, country: place.countryA };
}

const inputSchema = z.object({
  from: z.string().min(1).describe("where the journey starts — a station, a place name, or a street address"),
  to: z.string().min(1).describe("where the journey ends — a station, a place name, or a street address"),
  departAfter: z
    .string()
    .optional()
    .describe(
      "ISO-8601 WITH offset, e.g. 2026-08-26T14:00:00+02:00 — the earliest departure. " +
        "Mutually exclusive with arriveBy; supplying both is refused. Omit both for 'leave now'.",
    ),
  arriveBy: z
    .string()
    .optional()
    .describe(
      "ISO-8601 WITH offset — arrive at the destination no later than this. " +
        "Mutually exclusive with departAfter; supplying both is refused.",
    ),
  count: z.number().int().min(1).max(6).optional().describe("how many itineraries to return (default 3)"),
});

export function createTransitPlanTool(deps: TransitPlanDeps) {
  return defineTool({
    description:
      "Real Norwegian public-transport journeys from Entur (the national journey planner — Vy, " +
      "Ruter, Vestfold, every operator in Norway), covering train, bus, tram, metro and ferry. " +
      "Returns up to `count` itineraries, each with its real departure and arrival times, " +
      "duration, line code and name, platform when the operator has assigned one, and the " +
      "real-time delay in seconds. Supports arrive-by as well as depart-after. " +
      "The model must NEVER invent a line, a departure time, a platform, or a duration: a " +
      "returned itinerary is the only real one, and if this tool returns nothing there is " +
      "nothing to say about transport — do not estimate, do not say 'roughly hourly'. " +
      "Norway only: Entur has no coverage beyond it, so a journey that starts or ends abroad " +
      "needs a Google-backed directions capability instead, if you have one. An endpoint that " +
      "resolves to another country — or to no stated country at all, which is read as foreign " +
      "(ORB-174) — comes back as an explicit `outsideCoverage` result naming " +
      "which endpoint it was — that is NOT 'there are no departures', it means this tool cannot " +
      "answer the question at all and you must say so rather than presenting anything as a " +
      "journey. Inside Norway, what " +
      "this tool ADDS over a general directions capability is arrive-by ('be in Tønsberg by " +
      "17:00') and control over how many itineraries come back — on a plain depart-after " +
      "question the two answer identically, because inside Norway both are this same Entur data. " +
      "Never send a Norwegian journey somewhere else for being 'simple'; an estimate is not an " +
      "answer. An empty `itineraries` list is a " +
      "real answer (both places resolved, both in Norway, nothing runs); a `notFound` result means the place " +
      "name did not resolve — and when it carries a `rejected` field, that names a candidate the " +
      "geocoder offered which was discarded as unrelated to what was asked, which is worth " +
      "repeating to the user if they might have meant it; and a genuine transport or HTTP failure raises " +
      "EnturUnavailableError — which means Entur was unreachable, NOT that there are no " +
      "departures.",
    inputSchema,
    async execute({ from, to, departAfter, arriveBy, count }) {
      if (departAfter !== undefined && arriveBy !== undefined) {
        return {
          error:
            "departAfter and arriveBy are mutually exclusive — supply one or neither (neither means 'leave now')",
        };
      }
      const entur = deps.entur();
      // REVIEW MINOR 5 — ONE deadline over all three requests, not three independent 8 s bounds.
      // `done()` in the outermost `finally` so the timer never outlives the call.
      const budget = callBudget(JOURNEY_BUDGET_MS);
      try {
        return await planJourney(entur, budget, { from, to, departAfter, arriveBy, count });
      } finally {
        budget.done();
      }
    },
  });
}

/** The body of `execute`, lifted out only so the budget's `finally` has nothing else in it. */
async function planJourney(
  entur: EnturClient,
  budget: ReturnType<typeof callBudget>,
  {
    from,
    to,
    departAfter,
    arriveBy,
    count,
  }: { from: string; to: string; departAfter?: string; arriveBy?: string; count?: number },
) {
  let origin: ResolvedPlace;
  let destination: ResolvedPlace;
  try {
    // Sequential, not Promise.all: the first miss short-circuits, and the model gets told
    // WHICH of the two names it got wrong rather than a merged failure.
    origin = await budget.race(entur.resolvePlace(from, { signal: budget.signal }));
    destination = await budget.race(entur.resolvePlace(to, { signal: budget.signal }));
  } catch (err) {
    if (err instanceof EnturPlaceNotFoundError) {
      // `rejected` names the candidate the Norway-bias guard threw away, when that is why
      // this was raised. It is carried out to the model — and so into the turn's trace —
      // because without it "notFound" is indistinguishable from a genuine miss, and the one
      // thing this guard has proven is that it can misfire. See the same reasoning in
      // eve-marcel's transit_directions.ts, which logs it.
      return {
        notFound: { query: err.query, ...(err.rejected !== undefined ? { rejected: err.rejected } : {}) },
      };
    }
    throw err;
  }

  // OUTSIDE ENTUR'S COVERAGE — an explicit outcome, never an empty itinerary list (ORB-168
  // follow-up). Entur's stop register really does hold foreign stations, with real `NSR:`
  // ids: live, "Göteborg C" → NSR:StopPlace:374 [SWE], "Stockholm Central" →
  // NSR:StopPlace:58635 [SWE], "København H" → NSR:StopPlace:63172 [DNK]. Those ids resolve
  // and plan perfectly happily, and the planner answers `tripPatterns: []` at HTTP 200 —
  // which this tool's own contract calls "a real answer, nothing runs". A model reading that
  // reports "there are no trains to Stockholm". eve-marcel has guarded the country since
  // ORB-168 and this tool did not; that asymmetry is the gap being closed here.
  //
  // A null `countryA` IS treated as foreign — REVERSED by ORB-174, which found this tool and
  // eve-marcel's `transit_directions` reading null in OPPOSITE directions while their
  // descriptions claimed they agree. One reading now holds in both, and unknown-is-foreign is
  // the safe one: refusing a mislabelled Norwegian journey costs an honest "cannot answer",
  // while planning a foreign one invents an empty timetable the model reads as "no departures".
  // Latent, not observed: 32 live geocoder queries produced no null (the sweep,
  // tests/live/entur.live.mts). Note Svalbard comes back as "SJM" and is caught by this too —
  // correctly, since Entur plans no journeys there.
  for (const endpoint of [
    { role: "from" as const, query: from, place: origin },
    { role: "to" as const, query: to, place: destination },
  ]) {
    // ORB-184 — the region is DECLARED on the adapter (`capability-docs.ts`, transit → NOR), and
    // `coversCountry` is the one reading of it: outside, unknown, or unlabelled all fail closed.
    if (!coversCountry("transit", endpoint.place.countryA)) {
      return {
        outsideCoverage: {
          endpoint: endpoint.role,
          query: endpoint.query,
          place: describePlace(endpoint.place),
        },
      };
    }
  }

  const itineraries = await budget.race(
    entur.plan(
      {
        from: locationFor(origin),
        to: locationFor(destination),
        dateTime: departAfter ?? arriveBy ?? new Date().toISOString(),
        arriveBy: arriveBy !== undefined,
        ...(count !== undefined ? { numTripPatterns: count } : {}),
      },
      { signal: budget.signal },
    ),
  );

  return { from: describePlace(origin), to: describePlace(destination), itineraries };
}

export default createTransitPlanTool(defaultTransitPlanDeps);
