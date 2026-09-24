import { describe, it, expect } from "vitest";

import { CAPABILITY_DOCS, adapterRegion, coversCountry } from "../src/persona/capability-docs.js";

// ORB-184 — an adapter declares the region it answers for, and fails closed outside it.
// The scar: Entur's geocoder answered FOREIGN queries with fuzzy Norwegian places carrying
// `country_a: "NOR"` (live during the New York trip, four fix rounds, every leak found by a
// live call and never by 288 green tests). A German installation needs DB, a UK one National
// Rail — so the region is a DECLARATION on the adapter, not a string buried in one tool.
describe("adapter regions (ORB-184)", () => {
  it("every adapter declares a region — countries or 'global' — and no core capability does", () => {
    for (const doc of Object.values(CAPABILITY_DOCS)) {
      if (doc.kind === "adapter") expect(doc.region, `${doc.capability} must declare a region`).toBeDefined();
      else expect(doc.region, `${doc.capability} is core and carries no region`).toBeUndefined();
    }
  });

  it("transit (Entur) and orakel (Brønnøysund) are Norway-only; the Google/Notion/Twenty/Strava adapters are global", () => {
    expect(adapterRegion("transit")).toMatchObject({ countries: ["NOR"] });
    expect(adapterRegion("orakel")).toMatchObject({ countries: ["NOR"] });
    for (const c of ["calendar", "gmail", "notion", "twenty", "places", "strava", "markets"]) {
      expect(adapterRegion(c), c).toBe("global");
    }
  });

  it("coversCountry fails closed: outside the region, an unknown country, and an unknown capability all read as not covered", () => {
    expect(coversCountry("transit", "NOR")).toBe(true);
    expect(coversCountry("transit", "SWE")).toBe(false);
    expect(coversCountry("transit", "SJM")).toBe(false); // Svalbard: Entur plans nothing there
    expect(coversCountry("transit", null)).toBe(false); // unknown is foreign — the ORB-174 reading
    expect(coversCountry("places", "SWE")).toBe(true); // global
    expect(coversCountry("places", null)).toBe(true); // global covers an unlabelled place too
    expect(coversCountry("no_such_capability", "NOR")).toBe(false);
  });

  it("a regional declaration carries the reason a human can read", () => {
    const r = adapterRegion("transit");
    expect(r).not.toBe("global");
    if (r !== undefined && r !== "global") expect(r.reason.length).toBeGreaterThan(20);
  });
});
