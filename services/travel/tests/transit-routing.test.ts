// ORB-168 — which provider answers a `transit_directions` question, and why.
//
// Google Directions does not know Vy: no real-time, no platform, no Norwegian rail worth the
// name. Entur does, and only inside Norway. So the tool now routes by the RESOLVED COUNTRY of
// both endpoints (`countryA === "NOR"` from Entur's own geocoder) — never by string-matching
// the query text, which would call a French "Bergen" Norwegian and a Norwegian "Storgaten 32"
// foreign.
//
// The four failure modes below are the point of the ticket, and the last one is the one that
// would be invisible if it regressed: a Norwegian pair whose Entur call FAILS must surface the
// typed unavailable error, never quietly hand the question to Google. A Norwegian train
// answered by Google Directions is exactly the weak answer ORB-168 exists to remove, and it
// would look like a success in every log.
import { describe, it, expect, vi } from "vitest";
import type { SessionAuth } from "eve/context";

import {
  makeEntur,
  EnturUnavailableError,
  EnturPlaceNotFoundError,
  type PlanArgs,
  type ResolvedPlace,
  type TripPattern,
} from "@lares/agent-kit/entur-client";
import { makeTransit } from "../lib/transit.js";
import {
  createTransitDirectionsTool,
  type EnturClient,
  type TransitDirectionsDeps,
} from "../catalogue/transit_directions.js";

function ctx() {
  return { session: { id: "wrun_test", auth: { current: null, initiator: null } as SessionAuth } } as never;
}

function place(over: Partial<ResolvedPlace> & { name: string }): ResolvedPlace {
  return {
    id: null,
    locality: null,
    county: null,
    countryA: "NOR",
    lat: 59.911,
    lon: 10.75,
    ...over,
  };
}

const OSLO_S = place({ id: "NSR:StopPlace:59872", name: "Oslo S", locality: "Oslo", countryA: "NOR" });
const TONSBERG = place({
  id: "NSR:StopPlace:58876",
  name: "Tønsberg stasjon",
  locality: "Tønsberg",
  countryA: "NOR",
  lat: 59.266,
  lon: 10.409,
});
// A foreign place as Entur's geocoder ACTUALLY returns one, measured live 2026-08-25:
// "Berlin Hauptbahnhof" → name "Berlin", country_a "DEU". A foreign hit is never an `NSR:` stop
// (that register is Norwegian), so `id` is null and the planner would only ever get coordinates.
//
// This fixture replaced a `{ name: "Gare du Nord", countryA: "FRA" }` one. That fixture was a
// FICTION and it is what let this bug ship: asked for "Gare du Nord, Paris", Entur does not
// answer FRA and does not answer empty — it answers the Norwegian street "Olav Duuns gate" with
// `country_a: "NOR"`. The real Paris case is now exercised end-to-end, through the real kit
// client, at the bottom of this file.
const BERLIN_HBF = place({ id: null, name: "Berlin", locality: null, countryA: "DEU", lat: 52.5163, lon: 13.3777 });

// A Swedish stop, with a REAL `NSR:` id — measured live 2026-08-25: "Göteborg C" →
// "Göteborg Centralstation" NSR:StopPlace:374 [SWE]. Entur's stop register covers international
// rail and coach, so foreign stops genuinely do carry NSR ids ("Stockholm Central" →
// NSR:StopPlace:58635, "København H" → NSR:StopPlace:63172).
//
// An earlier revision of this file replaced the id with null and asserted in a comment that a
// foreign result "comes from the geocoder's foreign layers, not the Norwegian stop-place
// register". That was wrong, and worse than wrong: it wrote a false premise into a test file as
// documentation. Routing is unaffected either way — it keys off `countryA`, never the id — but
// the id being real is precisely WHY the country gate matters: an NSR id plans happily and
// answers `tripPatterns: []` at HTTP 200.
const GOTEBORG = place({
  id: "NSR:StopPlace:374",
  name: "Göteborg Centralstation",
  locality: "Göteborg",
  countryA: "SWE",
  lat: 57.708,
  lon: 11.973,
});

const ONE_PATTERN: TripPattern[] = [
  {
    expectedStartTime: "2026-08-26T14:05:00+02:00",
    expectedEndTime: "2026-08-26T15:19:00+02:00",
    duration: 4440,
    legs: [
      {
        mode: "rail",
        linePublicCode: "RX11",
        lineName: "Skien - Oslo S - Lillehammer",
        fromPlaceName: "Oslo S",
        toPlaceName: "Tønsberg stasjon",
        platform: "3",
        aimedDepartureTime: "2026-08-26T14:05:00+02:00",
        expectedDepartureTime: "2026-08-26T14:05:00+02:00",
        delaySeconds: 0,
      },
    ],
  },
];

/** Entur stub: `resolvePlace` answers from a text→place table (or throws what the table holds),
 *  `plan` returns/throws whatever the test wants. Both are spies, because "was this provider
 *  called at all" is the actual assertion in every test here. */
function stubEntur(
  places: Record<string, ResolvedPlace | Error>,
  planResult: TripPattern[] | Error = ONE_PATTERN,
): { entur: EnturClient; resolvePlace: ReturnType<typeof vi.fn>; plan: ReturnType<typeof vi.fn> } {
  const resolvePlace = vi.fn(async (text: string) => {
    const hit = places[text];
    if (hit === undefined) throw new EnturPlaceNotFoundError(text);
    if (hit instanceof Error) throw hit;
    return hit;
  });
  const plan = vi.fn(async (_args: PlanArgs) => {
    if (planResult instanceof Error) throw planResult;
    return planResult;
  });
  return { entur: { resolvePlace, plan } as EnturClient, resolvePlace, plan };
}

/** A Google transit client over a spy `fetch` — the real `lib/transit.ts` port, no network. */
function stubGoogle() {
  const fetchSpy = vi.fn(async () => {
    return new Response(
      JSON.stringify({
        status: "OK",
        routes: [
          {
            legs: [
              {
                duration: { text: "25 mins", value: 1500 },
                distance: { text: "6.2 km" },
                steps: [{ travel_mode: "TRANSIT", html_instructions: "Take the <b>metro</b>", duration: { text: "18 mins" } }],
              },
            ],
          },
        ],
      }),
    );
  });
  return { transit: makeTransit({ apiKey: "k", fetch: fetchSpy as unknown as typeof fetch }), fetchSpy };
}

function toolFor(entur: EnturClient, transit: TransitDirectionsDeps["transit"]) {
  return createTransitDirectionsTool({ transit, entur: () => entur });
}

describe("transit_directions — provider routing by resolved country (ORB-168)", () => {
  it("plans a Norwegian pair with Entur and never touches Google", async () => {
    const { entur, plan } = stubEntur({ "Oslo S": OSLO_S, "Tønsberg": TONSBERG });
    const { transit, fetchSpy } = stubGoogle();

    const result = (await toolFor(entur, () => transit).execute(
      { origin: "Oslo S", destination: "Tønsberg" },
      ctx(),
    )) as { provider: string; itineraries: TripPattern[] };

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(plan).toHaveBeenCalledTimes(1);
    expect(result.provider).toBe("entur");
    expect(result.itineraries[0]?.legs[0]?.platform).toBe("3");
  });

  it("passes an NSR stop by id and a non-NSR address by coordinates — the mixed case is real", async () => {
    const address = place({ id: null, name: "Storgaten 32", locality: "Tønsberg", lat: 59.267, lon: 10.407 });
    const { entur, plan } = stubEntur({ "Oslo S": OSLO_S, "Storgaten 32, Tønsberg": address });

    await toolFor(entur, () => stubGoogle().transit).execute(
      { origin: "Oslo S", destination: "Storgaten 32, Tønsberg" },
      ctx(),
    );

    expect(plan.mock.calls[0]![0]).toMatchObject({
      from: { id: "NSR:StopPlace:59872" },
      to: { lat: 59.267, lon: 10.407 },
    });
  });

  it("hands a journey with one endpoint abroad to Google, and never plans it with Entur", async () => {
    const { entur, plan } = stubEntur({ "Oslo S": OSLO_S, "Berlin Hauptbahnhof": BERLIN_HBF });
    const { transit, fetchSpy } = stubGoogle();

    const result = (await toolFor(entur, () => transit).execute(
      { origin: "Oslo S", destination: "Berlin Hauptbahnhof" },
      ctx(),
    )) as { durationText: string };

    expect(plan).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.durationText).toBe("25 mins");
  });

  it("hands a place that resolves but sits OUTSIDE Entur's coverage to Google, rather than planning it empty", async () => {
    // The deferred minor from Task 2: a Swedish stop resolves fine, and asking Entur to plan it
    // returns `tripPatterns: []` at HTTP 200 — which the model is told is a real answer, i.e.
    // "there are no trains to Göteborg". Country detection is where that gets caught.
    const { entur, plan } = stubEntur({ "Oslo S": OSLO_S, "Göteborg C": GOTEBORG });
    const { transit, fetchSpy } = stubGoogle();

    await toolFor(entur, () => transit).execute({ origin: "Oslo S", destination: "Göteborg C" }, ctx());

    expect(plan).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("falls through to Google when the geocoder is unreachable — abroad is the common case and Google is the only option there", async () => {
    const { entur, plan } = stubEntur({
      "Oslo S": new EnturUnavailableError("Entur was unreachable: geocoder request failed"),
    });
    const { transit, fetchSpy } = stubGoogle();

    const result = (await toolFor(entur, () => transit).execute(
      { origin: "Oslo S", destination: "Tønsberg" },
      ctx(),
    )) as { durationText: string };

    expect(plan).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.durationText).toBe("25 mins");
  });

  it("falls through to Google when Entur's geocoder has never heard of the place", async () => {
    const { entur, plan } = stubEntur({}); // every lookup → EnturPlaceNotFoundError
    const { transit, fetchSpy } = stubGoogle();

    await toolFor(entur, () => transit).execute({ origin: "Shibuya", destination: "Shinjuku" }, ctx());

    expect(plan).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("surfaces the typed unavailable error on a Norwegian pair — NOT a silent Google fallback", async () => {
    const { entur } = stubEntur(
      { "Oslo S": OSLO_S, "Tønsberg": TONSBERG },
      new EnturUnavailableError("Entur was unreachable: journey planner → 503"),
    );
    const { transit, fetchSpy } = stubGoogle();

    await expect(
      toolFor(entur, () => transit).execute({ origin: "Oslo S", destination: "Tønsberg" }, ctx()),
    ).rejects.toBeInstanceOf(EnturUnavailableError);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers a Norwegian pair from Entur even with no Google key configured", async () => {
    const { entur, plan } = stubEntur({ "Oslo S": OSLO_S, "Tønsberg": TONSBERG });

    const result = (await toolFor(entur, () => undefined).execute(
      { origin: "Oslo S", destination: "Tønsberg" },
      ctx(),
    )) as { provider: string };

    expect(plan).toHaveBeenCalledTimes(1);
    expect(result.provider).toBe("entur");
  });

  it("still reports the missing Google key when the journey routes to Google", async () => {
    const { entur } = stubEntur({ "Berlin Hauptbahnhof": BERLIN_HBF });

    const result = await toolFor(entur, () => undefined).execute(
      { origin: "Berlin Hauptbahnhof", destination: "Alexanderplatz" },
      ctx(),
    );

    expect(result).toEqual({ error: "transit directions unavailable — no Google Places key configured" });
  });

  it("turns `departAt` unix seconds into the ISO instant Entur's planner takes", async () => {
    const { entur, plan } = stubEntur({ "Oslo S": OSLO_S, "Tønsberg": TONSBERG });

    await toolFor(entur, () => stubGoogle().transit).execute(
      { origin: "Oslo S", destination: "Tønsberg", departAt: 1787832300 },
      ctx(),
    );

    expect(plan.mock.calls[0]![0].dateTime).toBe(new Date(1787832300 * 1000).toISOString());
  });

  it("gives up on country detection rather than hanging a turn on a stalled geocoder — and ABORTS it", async () => {
    vi.useFakeTimers();
    try {
      let handed: AbortSignal | undefined;
      const entur = {
        resolvePlace: vi.fn((_text: string, opts?: { signal?: AbortSignal }) => {
          handed = opts?.signal;
          return new Promise<ResolvedPlace>(() => {}); // never settles
        }),
        plan: vi.fn(async () => ONE_PATTERN),
      } as unknown as EnturClient;
      const { transit, fetchSpy } = stubGoogle();

      const pending = toolFor(entur, () => transit).execute(
        { origin: "Oslo S", destination: "Tønsberg" },
        ctx(),
      );
      await vi.advanceTimersByTimeAsync(10_000);
      const result = (await pending) as { durationText: string };

      expect(result.durationText).toBe("25 mins");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      // Not merely "stopped waiting": the request itself is cancelled, so a long-lived container
      // does not accumulate a hanging socket per stalled turn.
      expect(handed?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("spends ONE detection budget on the pair, not one per endpoint", async () => {
    // Two lookups at 5s each pass a 6s PER-ENDPOINT budget comfortably and blow a 6s PER-PAIR
    // one — which is the whole point: per-endpoint, an Oslo → Paris question could burn 12s of
    // geocoding before Google's own 8s even started.
    vi.useFakeTimers();
    try {
      const slow = (place: ResolvedPlace) =>
        new Promise<ResolvedPlace>((resolve) => setTimeout(() => resolve(place), 5_000));
      const entur = {
        resolvePlace: vi.fn((text: string) => slow(text === "Oslo S" ? OSLO_S : TONSBERG)),
        plan: vi.fn(async () => ONE_PATTERN),
      } as unknown as EnturClient;
      const { transit, fetchSpy } = stubGoogle();

      const pending = toolFor(entur, () => transit).execute(
        { origin: "Oslo S", destination: "Tønsberg" },
        ctx(),
      );
      await vi.advanceTimersByTimeAsync(12_000);
      const result = (await pending) as { durationText: string };

      expect(result.durationText).toBe("25 mins");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names arrive-by as the ONE real reason to prefer agent-kit__transit_plan", () => {
    // The plan's mandated wording also claimed "a platform you can rely on" and "several options
    // to choose between" — neither of which is true: both tools call the same entur.plan, the
    // same platform field comes back, and this tool takes the client's default of three
    // itineraries. A description that offers reasons which are not real sends the model to the
    // other tool for nothing.
    const description = (createTransitDirectionsTool({
      transit: () => undefined,
      entur: () => stubEntur({}).entur,
    }) as { description?: string }).description ?? "";

    expect(description).toMatch(/agent-kit__transit_plan/u);
    expect(description).toMatch(/arrive-by/iu);
    expect(description).not.toMatch(/platform you can rely on/iu);
    expect(description).not.toMatch(/several options to choose between/iu);
  });
});


// ── end to end, over the REAL kit client (ORB-168 follow-up fix) ─────────────────────────────
//
// Every test above stubs `EnturClient`, so none of them can see what the geocoder actually
// answers — which is exactly how the bug shipped. This block wires the REAL
// `makeEntur({ fetch })` into the real tool and drives it with the geocoder response measured
// live on 2026-08-25 from inside agent-box-eve-marcel-1:
//
//   "Gare du Nord, Paris" → name "Olav Duuns gate", layer=address, country_a=NOR,
//                           id="KVE:TopographicPlace:1820-Olav Duuns gate"
//
// `country_a: "NOR"` is what `norwegianPair` keys off, so before the fix a PARIS journey was
// planned by Entur — defeating the one constraint ORB-168 was given ("do not remove Google
// Directions from Marcel — abroad it is the only option"). The assertion that matters is not
// which object comes back; it is that the journey planner URL is never requested at all.

/** The two live Entur URLs, keyed by the geocoder's `text=` so a pair can answer differently. */
function enturFetch(byQuery: Record<string, unknown>) {
  const hits: string[] = [];
  const fn = (async (url: string | URL) => {
    const href = String(url);
    hits.push(href);
    if (href.startsWith("https://api.entur.io/geocoder/")) {
      const text = new URL(href).searchParams.get("text") ?? "";
      const body = byQuery[text] ?? { type: "FeatureCollection", features: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (href.startsWith("https://api.entur.io/journey-planner/")) {
      // Reaching here IS the bug. Answer plausibly so a regression fails on the assertion
      // below rather than on an unrelated throw.
      return new Response(JSON.stringify({ data: { trip: { tripPatterns: [] } } }), { status: 200 });
    }
    throw new Error(`unexpected URL: ${href}`);
  }) as unknown as typeof fetch;
  return { fetch: fn, hits };
}

/** One geocoder feature — these sets are big enough that spelling out the GeoJSON each time
 *  would bury what the case is about. */
function f(
  id: string,
  layer: string,
  name: string,
  locality: string | null,
  coordinates: [number, number],
  countryA = "NOR",
) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates },
    properties: { id, layer, name, locality, county: null, country_a: countryA },
  };
}

const PARIS_FUZZY = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [12.6333, 66.0217] },
      properties: {
        id: "KVE:TopographicPlace:1820-Olav Duuns gate",
        layer: "address",
        name: "Olav Duuns gate",
        locality: "Sandnessjøen",
        county: "Nordland",
        country_a: "NOR",
      },
    },
  ],
};

const OSLO_S_FEATURES = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [10.750947, 59.911275] },
      properties: {
        id: "NSR:StopPlace:59872",
        layer: "venue",
        name: "Oslo S",
        locality: "Oslo",
        county: "Oslo",
        country_a: "NOR",
      },
    },
  ],
};

describe("transit_directions — a Paris journey reaches GOOGLE, over the real Entur client", () => {
  it("does not plan 'Gare du Nord, Paris' with Entur just because the geocoder guessed a Norwegian street", async () => {
    const { fetch: enturHttp, hits } = enturFetch({
      "Gare du Nord, Paris": PARIS_FUZZY,
      "Eiffel Tower, Paris": { type: "FeatureCollection", features: [] }, // measured: zero features
    });
    const entur = makeEntur({ fetch: enturHttp });
    const { transit, fetchSpy } = stubGoogle();

    const result = (await createTransitDirectionsTool({
      transit: () => transit,
      entur: () => entur,
    }).execute({ origin: "Gare du Nord, Paris", destination: "Eiffel Tower, Paris" }, ctx())) as {
      durationText: string;
    };

    // Google answered — the only provider that covers Paris.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.durationText).toBe("25 mins");
    // And Entur's PLANNER was never asked.
    expect(hits.some((h) => h.startsWith("https://api.entur.io/journey-planner/"))).toBe(false);
    // THE assertion that actually pins the bug. "Eiffel Tower" happens to be a query Entur gets
    // RIGHT (zero features), so on this particular pair the destination lookup would have
    // rescued the journey anyway — which is exactly how a broken origin stayed invisible. The
    // origin is now rejected outright, so the second lookup is never even made: ONE geocoder
    // request, not two. Before the fix this list held both lookups and the pair read Norwegian.
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("text=Gare%20du%20Nord%2C%20Paris");
  });

  it("routes to Google when only the DESTINATION is the Norway-biased guess", async () => {
    // The origin really is Norwegian, so the short-circuit does not save us here: the guard has
    // to reject on the second lookup.
    const { fetch: enturHttp, hits } = enturFetch({
      "Oslo S": OSLO_S_FEATURES,
      "Gare du Nord, Paris": PARIS_FUZZY,
    });
    const entur = makeEntur({ fetch: enturHttp });
    const { transit, fetchSpy } = stubGoogle();

    await createTransitDirectionsTool({ transit: () => transit, entur: () => entur }).execute(
      { origin: "Oslo S", destination: "Gare du Nord, Paris" },
      ctx(),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(hits.some((h) => h.startsWith("https://api.entur.io/journey-planner/"))).toBe(false);
  });

  it("still plans a genuinely Norwegian pair with Entur when driven by the real client", async () => {
    // The guard's other half: proof the fix did not simply send everything to Google.
    const { fetch: enturHttp, hits } = enturFetch({
      "Oslo S": OSLO_S_FEATURES,
      "Tønsberg": {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [10.407, 59.267] },
            properties: {
              id: "NSR:StopPlace:58876",
              layer: "venue",
              name: "Tønsberg stasjon",
              locality: "Tønsberg",
              county: "Vestfold",
              country_a: "NOR",
            },
          },
        ],
      },
    });
    const entur = makeEntur({ fetch: enturHttp });
    const { transit, fetchSpy } = stubGoogle();

    const result = (await createTransitDirectionsTool({
      transit: () => transit,
      entur: () => entur,
    }).execute({ origin: "Oslo S", destination: "Tønsberg" }, ctx())) as { provider: string };

    expect(result.provider).toBe("entur");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(hits.some((h) => h.startsWith("https://api.entur.io/journey-planner/"))).toBe(true);
  });

  it("routes a BARE 'Paris' to Google — the case that leaked NOR through the first fix", async () => {
    // Live 2026-08-25: "Paris" returns five Norwegian features and no Paris —
    // "Parisbudalsveien" (Åmot), "Parisdalen" (Ullensvang), "Bella Paris" (Bergen),
    // "Vestre Parisbudalsvei" (Åmot), "Pars" (Bergen). Every one is country_a NOR, so a rule
    // that tolerated "paris" matching "parisbudalsveien" planned a PARIS journey with Entur.
    const parisNoise = {
      type: "FeatureCollection",
      features: [
        f("KVE:TopographicPlace:3422-Parisbudalsveien", "address", "Parisbudalsveien", "Åmot", [11.3, 61.1]),
        f("KVE:TopographicPlace:4618-Parisdalen", "address", "Parisdalen", "Ullensvang", [6.6, 60.3]),
        f("OSM:TopographicPlace:3946005913", "address", "Bella Paris", "Bergen", [5.32, 60.39]),
        f("KVE:TopographicPlace:3422-Vestre Parisbudalsvei", "address", "Vestre Parisbudalsvei", "Åmot", [11.29, 61.1]),
        f("OSM:TopographicPlace:2840313666", "address", "Pars", "Bergen", [5.33, 60.38]),
      ],
    };
    const { fetch: enturHttp, hits } = enturFetch({ Paris: parisNoise });
    const entur = makeEntur({ fetch: enturHttp });
    const { transit, fetchSpy } = stubGoogle();

    await createTransitDirectionsTool({ transit: () => transit, entur: () => entur }).execute(
      { origin: "Paris", destination: "Gare de Lyon, Paris" },
      ctx(),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(hits.some((h) => h.startsWith("https://api.entur.io/journey-planner/"))).toBe(false);
  });

  it("still plans a Norwegian ALIAS pair with Entur: Gardermoen is Oslo lufthavn", async () => {
    // The over-rejection half. Entur's #1 answer for "Gardermoen" shares no word with the
    // question — it is the airport's official name — and five siblings in the same locality say
    // the geocoder understood. Bendik flies from here; this must not fall through to Google.
    const gardermoen = {
      type: "FeatureCollection",
      features: [
        f("NSR:StopPlace:58211", "venue", "Oslo lufthavn", "Ullensaker", [11.0991, 60.1939]),
        f("NSR:StopPlace:5334", "venue", "Gardermoen næringspark", "Ullensaker", [11.06, 60.2]),
        f("NSR:StopPlace:59354", "venue", "Gardermoen Parkering", "Ullensaker", [11.1, 60.19]),
      ],
    };
    const { fetch: enturHttp, hits } = enturFetch({ Gardermoen: gardermoen, "Oslo S": OSLO_S_FEATURES });
    const entur = makeEntur({ fetch: enturHttp });
    const { transit, fetchSpy } = stubGoogle();

    const result = (await createTransitDirectionsTool({
      transit: () => transit,
      entur: () => entur,
    }).execute({ origin: "Oslo S", destination: "Gardermoen" }, ctx())) as {
      provider: string;
      to: { name: string };
    };

    expect(result.provider).toBe("entur");
    expect(result.to.name).toBe("Oslo lufthavn");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(hits.some((h) => h.startsWith("https://api.entur.io/journey-planner/"))).toBe(true);
  });

  it("LOGS why country detection gave up, so the next misfire is findable from the box", async () => {
    // Until this round, every failure in `norwegianPair` became a silent `null` — and "Marcel
    // used Google" is what an unreachable geocoder, an expired budget, a genuine miss AND a
    // guard misfire all look like from outside. The guard has misfired three times; the next one
    // must be one `docker logs` away rather than a laptop sweep away.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { fetch: enturHttp } = enturFetch({ "Gare du Nord, Paris": PARIS_FUZZY });
      const entur = makeEntur({ fetch: enturHttp });
      const { transit } = stubGoogle();

      await createTransitDirectionsTool({ transit: () => transit, entur: () => entur }).execute(
        { origin: "Gare du Nord, Paris", destination: "Eiffel Tower, Paris" },
        ctx(),
      );

      const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("Gare du Nord, Paris");
      expect(logged).toContain("Olav Duuns gate"); // the candidate the guard discarded
      expect(logged).toContain("Google");
    } finally {
      warn.mockRestore();
    }
  });

  it("logs an OUTAGE differently from a discarded candidate", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { entur } = stubEntur({
        "Oslo S": new EnturUnavailableError("Entur was unreachable: geocoder request failed"),
      });
      const { transit } = stubGoogle();

      await toolFor(entur, () => transit).execute({ origin: "Oslo S", destination: "Tønsberg" }, ctx());

      const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("EnturUnavailableError");
      expect(logged).toContain("country detection failed");
    } finally {
      warn.mockRestore();
    }
  });
});

// ─── ORB-174 #2 — `null` countryA reads the same in BOTH transit tools ─────────────────────
describe("transit_directions — a place with no stated country (ORB-174)", () => {
  it("routes to Google, matching transit_plan's outsideCoverage over the same fixture shape", async () => {
    // The divergence this closes: transit_plan used to PLAN a null-country endpoint while this
    // tool routed it to Google — two tools describing themselves as identical inside Norway,
    // reading the same field in opposite directions. The ruling (safe direction): unknown is
    // foreign. Here that means Google, which answers anywhere; in transit_plan (Entur-only) it
    // means an explicit outsideCoverage. The sibling test lives in
    // packages/agent-kit/tests/transit-plan.test.ts over the same `countryA: null` shape.
    const unlabelled = place({ id: "NSR:StopPlace:59999", name: "Mystery St", locality: "Somewhere", countryA: null });
    const { entur, plan } = stubEntur({ "Oslo S": OSLO_S, "Mystery St": unlabelled });
    const { transit, fetchSpy } = stubGoogle();

    await toolFor(entur, () => transit).execute({ origin: "Oslo S", destination: "Mystery St" }, ctx());

    expect(plan).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
