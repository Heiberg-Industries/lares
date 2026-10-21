// Unit coverage for ../extension/tools/transit_plan.ts — a tool the kit contributes.
//
// `../src/entur-client.ts`'s own HTTP behaviour is covered by tests/entur-client.test.ts; this
// file covers only what the TOOL adds on top of it, which is exactly the part that can go wrong
// silently:
//
//   1. It resolves BOTH endpoints through the geocoder before planning — `plan()` never sees raw
//      user text, because a guessed place id comes back as `tripPatterns: []` at HTTP 200 and
//      reads to a model as "there are no trains".
//   2. It picks the `{ id }` branch only for an `NSR:` place, and falls back to `{ lat, lon }`
//      for an address (`ResolvedPlace.id === null`). Getting this wrong is the same empty-200
//      trap wearing a different hat.
//   3. `departAfter` and `arriveBy` are mutually exclusive, refused before any network call.
//   4. An outage propagates as `EnturUnavailableError`; a geocoder miss is a distinct, explicit
//      `notFound` result. "Unavailable" must never be reported as "none".
//   5. The DEFAULT export routes through the egress proxy, not Node's built-in `fetch` — the
//      single most likely way this ships broken (agents are network-sealed; Node's fetch
//      ignores proxy env vars, see ../src/telegram-fetch.ts's header).
import { describe, it, expect, vi } from "vitest";

import transitPlan, { createTransitPlanTool, type EnturClient } from "../extension/tools/transit_plan.js";
import { clearTurn, currentTaint } from "../src/origin-taint.js";
import { makeEntur, EnturPlaceNotFoundError, EnturUnavailableError } from "../src/entur-client.js";
import type { PlanArgs, ResolvedPlace, TripPattern } from "../src/entur-client.js";

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────

const OSLO_S: ResolvedPlace = {
  id: "NSR:StopPlace:59872",
  name: "Oslo S",
  locality: "Oslo",
  county: "Oslo",
  countryA: "NOR",
  lat: 59.911275,
  lon: 10.750947,
};

const BJORNVIK: ResolvedPlace = {
  id: "NSR:StopPlace:58876",
  name: "Bjørnvik stasjon",
  locality: "Bjørnvik",
  county: "Example County",
  countryA: "NOR",
  lat: 59.266,
  lon: 10.4076,
};

/** A street address: the geocoder answers, but with a non-`NSR:` id, so `id` is null and the
 *  planner has to be given coordinates instead. */
const PARKGATEN: ResolvedPlace = {
  id: null,
  name: "Parkgaten 7",
  locality: "Bjørnvik",
  county: "Example County",
  countryA: "NOR",
  lat: 59.2673,
  lon: 10.4078,
};

const RX11: TripPattern = {
  expectedStartTime: "2026-08-26T14:05:00+02:00",
  expectedEndTime: "2026-08-26T15:19:00+02:00",
  duration: 4440,
  legs: [
    {
      mode: "rail",
      linePublicCode: "RX11",
      lineName: "Skien - Oslo S - Lillehammer",
      fromPlaceName: "Oslo S",
      toPlaceName: "Bjørnvik stasjon",
      platform: "3",
      aimedDepartureTime: "2026-08-26T14:05:00+02:00",
      expectedDepartureTime: "2026-08-26T14:05:00+02:00",
      delaySeconds: 0,
    },
  ],
};

/** A fake Entur bound to a script of resolutions, recording every call it receives. */
function fakeEntur(
  places: Record<string, ResolvedPlace | Error>,
  patterns: TripPattern[] | Error = [RX11],
): EnturClient & { calls: { resolved: string[]; planned: PlanArgs[] } } {
  const calls = { resolved: [] as string[], planned: [] as PlanArgs[] };
  return {
    calls,
    async resolvePlace(text: string) {
      calls.resolved.push(text);
      const hit = places[text];
      if (hit === undefined) throw new EnturPlaceNotFoundError(text);
      if (hit instanceof Error) throw hit;
      return hit;
    },
    async plan(args: PlanArgs) {
      calls.planned.push(args);
      if (patterns instanceof Error) throw patterns;
      return patterns;
    },
  };
}

function toolFor(entur: EnturClient) {
  return createTransitPlanTool({ entur: () => entur });
}

/** The tool reads nothing off the context; eve's `execute` signature just wants one. */
const CTX = {} as never;

// ── the tool ─────────────────────────────────────────────────────────────────────────────────

describe("transit_plan", () => {
  it("resolves both endpoints before planning, and plans by NSR id", async () => {
    const entur = fakeEntur({ "Oslo S": OSLO_S, Bjørnvik: BJORNVIK });
    const result = (await toolFor(entur).execute(
      { from: "Oslo S", to: "Bjørnvik", departAfter: "2026-08-26T14:00:00+02:00" },
      CTX,
    )) as { itineraries: TripPattern[]; from: { name: string }; to: { name: string } };

    // Both endpoints geocoded — this is the guard against handing `plan` raw text.
    expect(entur.calls.resolved).toEqual(["Oslo S", "Bjørnvik"]);
    expect(entur.calls.planned).toHaveLength(1);
    expect(entur.calls.planned[0]!.from).toEqual({ id: "NSR:StopPlace:59872" });
    expect(entur.calls.planned[0]!.to).toEqual({ id: "NSR:StopPlace:58876" });
    expect(entur.calls.planned[0]!.dateTime).toBe("2026-08-26T14:00:00+02:00");
    expect(entur.calls.planned[0]!.arriveBy).toBe(false);

    expect(result.from.name).toBe("Oslo S");
    expect(result.to.name).toBe("Bjørnvik stasjon");
    expect(result.itineraries).toEqual([RX11]);
  });

  it("plans an address by coordinates — a non-NSR id would be an empty 200", async () => {
    const entur = fakeEntur({ "Oslo S": OSLO_S, "Parkgaten 7, Bjørnvik": PARKGATEN });
    await toolFor(entur).execute({ from: "Oslo S", to: "Parkgaten 7, Bjørnvik" }, CTX);

    expect(entur.calls.planned[0]!.to).toEqual({ lat: 59.2673, lon: 10.4078 });
  });

  it("passes arriveBy through as the planner's arrive-by flag", async () => {
    const entur = fakeEntur({ "Oslo S": OSLO_S, Bjørnvik: BJORNVIK });
    await toolFor(entur).execute(
      { from: "Oslo S", to: "Bjørnvik", arriveBy: "2026-08-26T17:00:00+02:00", count: 4 },
      CTX,
    );

    expect(entur.calls.planned[0]!.dateTime).toBe("2026-08-26T17:00:00+02:00");
    expect(entur.calls.planned[0]!.arriveBy).toBe(true);
    expect(entur.calls.planned[0]!.numTripPatterns).toBe(4);
  });

  it("refuses departAfter AND arriveBy together, before any network call", async () => {
    const entur = fakeEntur({ "Oslo S": OSLO_S, Bjørnvik: BJORNVIK });
    const result = (await toolFor(entur).execute(
      {
        from: "Oslo S",
        to: "Bjørnvik",
        departAfter: "2026-08-26T14:00:00+02:00",
        arriveBy: "2026-08-26T17:00:00+02:00",
      },
      CTX,
    )) as { error: string };

    expect(result.error).toMatch(/departAfter/u);
    expect(entur.calls.resolved).toEqual([]);
    expect(entur.calls.planned).toEqual([]);
  });

  it("reports a geocoder miss as an explicit notFound, naming which endpoint", async () => {
    const entur = fakeEntur({ "Oslo S": OSLO_S });
    const result = (await toolFor(entur).execute({ from: "Oslo S", to: "Nowhereville" }, CTX)) as {
      notFound: { query: string };
    };

    expect(result.notFound.query).toBe("Nowhereville");
    // Never planned — "I couldn't find that place" must not become "there are no trains".
    expect(entur.calls.planned).toEqual([]);
  });

  it("lets an outage propagate as EnturUnavailableError rather than an empty itinerary list", async () => {
    const outage = new EnturUnavailableError("Entur was unreachable: journey planner → 503");
    const entur = fakeEntur({ "Oslo S": OSLO_S, Bjørnvik: BJORNVIK }, outage);

    await expect(toolFor(entur).execute({ from: "Oslo S", to: "Bjørnvik" }, CTX)).rejects.toBeInstanceOf(
      EnturUnavailableError,
    );
  });

  it("returns an empty itinerary list as a real answer once both places resolved", async () => {
    const entur = fakeEntur({ "Oslo S": OSLO_S, Bjørnvik: BJORNVIK }, []);
    const result = (await toolFor(entur).execute({ from: "Oslo S", to: "Bjørnvik" }, CTX)) as {
      itineraries: TripPattern[];
    };

    expect(result.itineraries).toEqual([]);
  });

  it("tells the model it may not invent a line, a time, a platform or a duration", () => {
    // The description is the only
    // place that boundary is stated to the model, so it is asserted rather than trusted.
    const description = (transitPlan as { description?: string }).description ?? "";
    expect(description).toMatch(/never invent/iu);
    expect(description).toMatch(/platform/iu);
  });

  it("divides the labour by CAPABILITY, never by a tool name, and never sends a Norwegian journey elsewhere", () => {
    // THE REGRESSION THIS PINS. The description used to read: "Norway only;
    // for journeys outside Norway use transit_directions (Google), which is also the simpler
    // choice for a plain point-to-point question." Two defects, both invisible to every other
    // test in the repo:
    //   1. it steered "when is the next train from Oslo S to Example City?" — a plain point-to-point
    // question INSIDE Norway, the exact case this tool exists for — onto Google;
    //   2. it named a tool. The same tool is mounted for several agents and not all of them have
    //      `transit_directions`, so for those it pointed at a tool they cannot call.
    // Reintroducing either half left all four suites green, which is why it is asserted here.
    const description = (transitPlan as { description?: string }).description ?? "";

    expect(description).not.toMatch(/transit_directions/u);
    expect(description).not.toMatch(/simpler choice/iu);
    expect(description).toMatch(/capability/iu); // the cross-reference is a capability, not a name
    expect(description).toMatch(/arrive-by/iu); // the one thing that genuinely differs
  });
});

describe("transit_plan's default wiring", () => {
  it("routes through the egress proxy, not Node's built-in fetch", async () => {
    // THE failure this test exists for: a plain `fetch` compiles, passes every test above (they
    // inject a fake client), and then fails on the box as "unreachable", because both agents are
    // network-sealed and Node's built-in fetch ignores proxy env vars.
    //
    // Proven behaviourally, with no live Entur call: point the proxy at a closed local port and
    // assert the failure is a refused connection TO THAT PORT. A default export that called
    // api.entur.io directly would either succeed or fail with a different cause — either way,
    // not ECONNREFUSED on 127.0.0.1:9. `resetModules` is what makes this observable: the default
    // deps cache their client on first use, so the env var has to be set before the module that
    // reads it is instantiated.
    vi.resetModules();
    const previous = process.env["TELEGRAM_PROXY_URL"];
    process.env["TELEGRAM_PROXY_URL"] = "http://127.0.0.1:9";
    try {
      const fresh = (await import("../extension/tools/transit_plan.js")).default;
      // The error class has to come from the SAME fresh module graph: `resetModules` gives the
      // re-imported entur-client its own `EnturUnavailableError`, a different prototype than the
      // one this file imported at the top, so an `instanceof` against that one never matches.
      const { EnturUnavailableError: FreshUnavailable } = await import("../src/entur-client.js");
      let err: unknown = null;
      try {
        await fresh.execute({ from: "Oslo S", to: "Bjørnvik" }, CTX);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(FreshUnavailable);
      // undici nests it two deep: EnturUnavailableError → TypeError("fetch failed") → the real
      // socket error. Walk the chain rather than pinning a depth.
      const chain: string[] = [];
      for (let e: unknown = err, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) {
        chain.push(e.message);
      }
      expect(chain.join(" | ")).toMatch(/ECONNREFUSED 127\.0\.0\.1:9/u);
    } finally {
      if (previous === undefined) delete process.env["TELEGRAM_PROXY_URL"];
      else process.env["TELEGRAM_PROXY_URL"] = previous;
      vi.resetModules();
    }
  }, 30_000);
});

// ── the chief of staff side of the Norway-bias fix follow-up) ─────────────────────────────────
//
// Every test above injects a fake `EnturClient`, so none of them can see what the geocoder
// actually answers. Entur's geocoder is Norway-biased: asked for "Gare du Nord, Paris" it does
// not answer "no match" — it answers the Norwegian street "Olav Duuns gate" with
// `country_a: "NOR"` (measured live). An agent with
// no Google fallback depends entirely on this tool saying `notFound` — the
// outcome the persona's silence rule already covers — instead of planning a nonsense Norwegian
// journey and presenting it as the answer to a Paris question.
describe("transit_plan over the REAL kit client", () => {
  it("answers a Paris question with notFound, not a nonsense Norwegian itinerary", async () => {
    const planner: string[] = [];
    const http = (async (url: string | URL) => {
      const href = String(url);
      if (href.startsWith("https://api.entur.io/journey-planner/")) {
        planner.push(href);
        return new Response(JSON.stringify({ data: { trip: { tripPatterns: [] } } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
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
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = (await createTransitPlanTool({ entur: () => makeEntur({ fetch: http }) }).execute(
      { from: "Gare du Nord, Paris", to: "Eiffel Tower, Paris" },
      CTX,
    )) as { notFound: { query: string } };

    expect(result.notFound.query).toBe("Gare du Nord, Paris");
    expect(planner).toEqual([]);
  });
});

// ── outside Entur's coverage ─────────────────────────────────────────────
//
// Entur's stop register really does hold foreign stations, with real `NSR:` ids — measured live
// Measured live: "Göteborg C" → NSR:StopPlace:374 [SWE], "Stockholm Central" → NSR:StopPlace:58635
// [SWE], "København H" → NSR:StopPlace:63172 [DNK]. Those ids resolve, and they plan: the journey
// planner answers `tripPatterns: []` at HTTP 200, which this tool's contract calls "a real
// answer, nothing runs". A model reads that as "there are no trains to Stockholm".
//
// A routing layer that keys on the resolved country catches this; an agent with no Google
// fallback has nothing to catch it, so this tool keys on the country itself. These tests close
// that gap.

const STOCKHOLM: ResolvedPlace = {
  id: "NSR:StopPlace:58635",
  name: "Stockholm Centralstation",
  locality: "Stockholm",
  county: null,
  countryA: "SWE",
  lat: 59.33,
  lon: 18.058,
};

describe("transit_plan — an endpoint outside Norway", () => {
  it("returns an explicit outsideCoverage result and never plans", async () => {
    const entur = fakeEntur({ "Oslo S": OSLO_S, "Stockholm Central": STOCKHOLM });

    const result = (await toolFor(entur).execute({ from: "Oslo S", to: "Stockholm Central" }, CTX)) as {
      outsideCoverage: { endpoint: string; query: string; place: { country: string | null } };
    };

    expect(result.outsideCoverage.endpoint).toBe("to");
    expect(result.outsideCoverage.query).toBe("Stockholm Central");
    expect(result.outsideCoverage.place.country).toBe("SWE");
    // The whole point: an empty itinerary list here would read as "there are no trains".
    expect(entur.calls.planned).toEqual([]);
  });

  it("catches a foreign ORIGIN too, and names it as the origin", async () => {
    const entur = fakeEntur({ "Stockholm Central": STOCKHOLM, "Oslo S": OSLO_S });

    const result = (await toolFor(entur).execute({ from: "Stockholm Central", to: "Oslo S" }, CTX)) as {
      outsideCoverage: { endpoint: string };
    };

    expect(result.outsideCoverage.endpoint).toBe("from");
    expect(entur.calls.planned).toEqual([]);
  });

  it("treats a missing country as OUTSIDE coverage", async () => {
    // This test used to assert the opposite ("absence of a country is not evidence of one").
    // Two readers of `null` once disagreed while describing themselves as identical inside
    // Norway, so ONE reading is now used everywhere: unknown is foreign. The safe direction — refusing a mislabelled Norwegian
    // journey costs an honest "cannot answer"; planning a foreign one invents an empty
    // timetable the model reads as "there are no trains".
    const unlabelled: ResolvedPlace = { ...BJORNVIK, countryA: null };
    const entur = fakeEntur({ "Oslo S": OSLO_S, Bjørnvik: unlabelled });

    const result = (await toolFor(entur).execute({ from: "Oslo S", to: "Bjørnvik" }, CTX)) as {
      outsideCoverage: { endpoint: string };
    };

    expect(result.outsideCoverage.endpoint).toBe("to");
    expect(entur.calls.planned).toEqual([]);
  });

  it("tells the model that outsideCoverage is not 'no departures'", () => {
    const description = (transitPlan as { description?: string }).description ?? "";
    expect(description).toMatch(/outsideCoverage/u);
    expect(description).toMatch(/not 'there are no departures'/iu);
  });
});

// ── the diagnostic ─────────────────────────────────────────────────────────
//
// The Norway-bias guard has misfired before, and nothing it discarded
// was observable in production: `EnturPlaceNotFoundError.rejected` existed and no code path read
// it. "the agent said notFound" looked identical whether the place does not exist, Entur was down, or
// the guard threw away the right answer. Carrying the candidate out to the model puts it in the
// turn's trace, which is where the next misfire has to be findable from.
describe("transit_plan — notFound names the discarded candidate", () => {
  it("carries `rejected` through when the guard threw a candidate away", async () => {
    const discarded = new EnturPlaceNotFoundError("Gare du Nord, Paris", "Olav Duuns gate");
    const entur = fakeEntur({ "Gare du Nord, Paris": discarded });

    const result = (await toolFor(entur).execute({ from: "Gare du Nord, Paris", to: "Oslo S" }, CTX)) as {
      notFound: { query: string; rejected?: string };
    };

    expect(result.notFound).toEqual({ query: "Gare du Nord, Paris", rejected: "Olav Duuns gate" });
  });

  it("omits `rejected` entirely when the geocoder simply returned nothing", async () => {
    // The two cases must stay distinguishable: "no such place" and "I threw away the answer".
    const entur = fakeEntur({ "Oslo S": OSLO_S });

    const result = (await toolFor(entur).execute({ from: "Oslo S", to: "Nowhereville" }, CTX)) as {
      notFound: { query: string; rejected?: string };
    };

    expect(result.notFound).toEqual({ query: "Nowhereville" });
  });
});

// ── the shared deadline ──────────────────────────────────────────────────────────────────────

describe("transit_plan — ONE deadline over all three requests", () => {
  /** Same fake, but recording the `opts` each call was handed. */
  function signalRecordingEntur(): EnturClient & { signals: (AbortSignal | undefined)[] } {
    const signals: (AbortSignal | undefined)[] = [];
    return {
      signals,
      async resolvePlace(text: string, opts?: { signal?: AbortSignal }) {
        signals.push(opts?.signal);
        return text === "Oslo S" ? OSLO_S : BJORNVIK;
      },
      async plan(_args: PlanArgs, opts?: { signal?: AbortSignal }) {
        signals.push(opts?.signal);
        return [RX11];
      },
    };
  }

  it("hands the SAME signal to both lookups and the plan", async () => {
    // Three requests, each with its own 8 s bound inside the client, is 24 s worst case
    // inside a live turn, so one shared deadline covers both lookups and the plan. That the
    // signal is the SAME object across all three is the whole assertion: three separate
    // signals would be three separate budgets again.
    const entur = signalRecordingEntur();
    await toolFor(entur).execute({ from: "Oslo S", to: "Bjørnvik" }, CTX);

    expect(entur.signals).toHaveLength(3);
    expect(entur.signals[0]).toBeInstanceOf(AbortSignal);
    expect(entur.signals[1]).toBe(entur.signals[0]);
    expect(entur.signals[2]).toBe(entur.signals[0]);
    // And it is not already aborted on a healthy call.
    expect(entur.signals[0]!.aborted).toBe(false);
  });

  it("clears its timer, so a call cannot keep the process alive", async () => {
    // A `setTimeout` left running in a long-lived container is not a leak in the heap sense but
    // it is one in the "nobody is listening any more" sense, which is the reason the shape being
    // copied has a `done()` at all.
    const entur = signalRecordingEntur();
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    await toolFor(entur).execute({ from: "Oslo S", to: "Bjørnvik" }, CTX);
    expect(process.getActiveResourcesInfo().filter((r) => r === "Timeout").length).toBe(before);
  });
});

it("taints journey metadata and actual provider error text but not validation or private refusals", async () => {
  const key={sessionId:"transit-taint",turnId:"one"};
  const ctx={session:{id:key.sessionId,turn:{id:key.turnId}}} as never;
  const entur=fakeEntur({"Oslo S":OSLO_S,Bjørnvik:BJORNVIK});const tool=toolFor(entur);
  clearTurn(key);await tool.execute({from:"Oslo S",to:"Bjørnvik"},ctx);expect(currentTaint(key)).toBe("third_party");
  clearTurn(key);await tool.execute({from:"Oslo S",to:"Bjørnvik",departAfter:"one",arriveBy:"two"},ctx);expect(currentTaint(key)).toBeUndefined();
  const canary="PROVIDER_ERROR_TEXT_CANARY";
  const broken=toolFor(makeEntur({fetch:async()=>new Response(canary,{status:503})}));
  await expect(broken.execute({from:"Oslo S",to:"Bjørnvik"},ctx)).rejects.toThrow(canary);expect(currentTaint(key)).toBe("third_party");
  clearTurn(key);
  const deps={entur:vi.fn(()=>entur)};
  await expect(createTransitPlanTool(deps).execute({from:"Oslo S",to:"Bjørnvik"},{session:{auth:{current:{attributes:{lares_member_id:"member"}}}}} as never)).rejects.toThrow("Conversation authority");
  expect(deps.entur).not.toHaveBeenCalled();expect(currentTaint(key)).toBeUndefined();
});
