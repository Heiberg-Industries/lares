// Ported from services/marcel/tests/nearby.test.ts (review fix, finding 10). lib/nearby.ts was
// copied UNCHANGED into eve-marcel (Task 6) but its test suite was never re-ported. Import path
// is the only change — the logic under test is byte-identical. (Distinct from
// tests/tools-nearby.test.ts, which exercises the agent/tools/nearby_places.ts TOOL wrapper,
// not this lib file directly.)
import { describe, it, expect, vi } from "vitest";
import { makeNearby } from "../lib/nearby.js";

const POINT = { lat: 59.25146, lon: 10.42135 }; // Nøtterøy-ish

// Fixture ordered OUT of distance order to prove the code sorts, not just parses in order:
// - "Fjern Bakeri" (node, ~7km away) listed first
// - an unnamed node (must be skipped)
// - "Sentrum Bakeri" (a WAY — coords only via `center`, ~470m away, no opening_hours/cuisine)
// - "Nær Bakeri" (node, ~70m away, has opening_hours)
// - "Bakeriet i Byen" (node, ~1.2km away, has cuisine)
const FIXTURE = {
  elements: [
    { type: "node", lat: 59.3, lon: 10.5, tags: { name: "Fjern Bakeri" } },
    { type: "node", lat: 59.2521, lon: 10.4221, tags: {} }, // unnamed — must be skipped
    { type: "way", center: { lat: 59.255, lon: 10.426 }, tags: { name: "Sentrum Bakeri" } },
    { type: "node", lat: 59.252, lon: 10.422, tags: { name: "Nær Bakeri", opening_hours: "07:00-16:00" } },
    { type: "node", lat: 59.26, lon: 10.435, tags: { name: "Bakeriet i Byen", cuisine: "bakery" } },
  ],
};

function fakeFetch(body: unknown, ok = true) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok, json: async () => body };
  }) as unknown as typeof globalThis.fetch;
  return { fetchFn, calls };
}

describe("makeNearby — Overpass discovery", () => {
  it("builds an Overpass QL body with the category's tag selector, around:<radius> and [out:json]", async () => {
    const { fetchFn, calls } = fakeFetch({ elements: [] });
    const nearby = makeNearby({ userAgent: "test-agent", fetch: fetchFn });

    await nearby.search(POINT, "bakery");

    const rawBody = String(calls[0].init.body);
    const query = decodeURIComponent(rawBody.replace(/^data=/, ""));
    expect(query).toContain('["shop"~"bakery"]');
    expect(query).toContain(`around:1500,${POINT.lat},${POINT.lon}`);
    expect(query).toContain("[out:json]");
    expect(query).toContain("node");
    expect(query).toContain("way");
  });

  it("sends the given User-Agent header", async () => {
    const { fetchFn, calls } = fakeFetch({ elements: [] });
    const nearby = makeNearby({ userAgent: "lares-marcel/1.0 owner@owner.example", fetch: fetchFn });

    await nearby.search(POINT, "cafe");

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("lares-marcel/1.0 owner@owner.example");
  });

  it("parses nodes AND ways (way → center.lat/lon), skips unnamed, sorts by distance ascending, caps at 8", async () => {
    const { fetchFn } = fakeFetch(FIXTURE);
    const nearby = makeNearby({ userAgent: "test-agent", fetch: fetchFn });

    const hits = await nearby.search(POINT, "bakery");

    expect(hits).toHaveLength(4); // the unnamed node is excluded
    expect(hits.map((h) => h.name)).toEqual(["Nær Bakeri", "Sentrum Bakeri", "Bakeriet i Byen", "Fjern Bakeri"]);
    for (let i = 1; i < hits.length; i++) expect(hits[i].distanceM).toBeGreaterThanOrEqual(hits[i - 1].distanceM);
    const way = hits.find((h) => h.name === "Sentrum Bakeri");
    expect(way).toMatchObject({ lat: 59.255, lon: 10.426 }); // came from `center`, not lat/lon
  });

  it("carries openingHours/cuisine from tags when present, omits the field entirely otherwise", async () => {
    const { fetchFn } = fakeFetch(FIXTURE);
    const nearby = makeNearby({ userAgent: "test-agent", fetch: fetchFn });

    const hits = await nearby.search(POINT, "bakery");

    const near = hits.find((h) => h.name === "Nær Bakeri")!;
    expect(near.openingHours).toBe("07:00-16:00");
    expect(near).not.toHaveProperty("cuisine");

    const byen = hits.find((h) => h.name === "Bakeriet i Byen")!;
    expect(byen.cuisine).toBe("bakery");
    expect(byen).not.toHaveProperty("openingHours");

    const sentrum = hits.find((h) => h.name === "Sentrum Bakeri")!;
    expect(sentrum).not.toHaveProperty("openingHours");
    expect(sentrum).not.toHaveProperty("cuisine");
  });

  it("clamps radius into [100, 10000] and defaults to 1500 when omitted", async () => {
    const { fetchFn, calls } = fakeFetch({ elements: [] });
    const nearby = makeNearby({ userAgent: "test-agent", fetch: fetchFn });

    await nearby.search(POINT, "cafe", 99999);
    await nearby.search(POINT, "cafe", 1);
    await nearby.search(POINT, "cafe");

    const bodies = calls.map((c) => decodeURIComponent(String(c.init.body).replace(/^data=/, "")));
    expect(bodies[0]).toContain("around:10000,");
    expect(bodies[1]).toContain("around:100,");
    expect(bodies[2]).toContain("around:1500,");
  });

  it("returns [] on a non-ok response — never throws", async () => {
    const { fetchFn } = fakeFetch({ elements: [] }, false);
    const nearby = makeNearby({ userAgent: "test-agent", fetch: fetchFn });

    expect(await nearby.search(POINT, "cafe")).toEqual([]);
  });

  it("returns [] when fetch throws — never throws", async () => {
    const fetchFn = (async () => {
      throw new Error("network down");
    }) as unknown as typeof globalThis.fetch;
    const nearby = makeNearby({ userAgent: "test-agent", fetch: fetchFn });

    expect(await nearby.search(POINT, "cafe")).toEqual([]);
  });
});
