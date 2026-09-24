// Tests for lib/trip-context.ts's buildTripContextMarkdown — the pure section-assembly logic
// behind Fix Wave B, Finding 1's dynamic instructions. Cases ported from old Marcel's
// tests/brain.test.ts `buildSystemPrompt` describe block (services/marcel/tests/brain.test.ts,
// lines 69-173), minus the persona/automatic-behaviors assertions — those two sections are
// deliberately NOT part of this function (they're already static in agent/instructions.md).
import { describe, it, expect } from "vitest";
import { buildTripContextMarkdown, overlayFlag, type TripContextArgs } from "../lib/trip-context.js";

const trip: TripContextArgs["trip"] = {
  name: "Côte d'Azur",
  start: "2026-07-21",
  end: "2026-07-28",
  destination: { name: "Sainte-Maxime" },
};

function baseArgs(overrides: Partial<TripContextArgs> = {}): TripContextArgs {
  return {
    trip,
    tripMd: "",
    itinerary: "",
    bookings: "",
    shopping: "",
    learned: "",
    tasteProfile: "",
    tasteGeoHits: "",
    todayISO: "2026-07-22",
    ...overrides,
  };
}

describe("buildTripContextMarkdown", () => {
  it("always includes the trip header with dates and destination", () => {
    const md = buildTripContextMarkdown(baseArgs());
    expect(md).toContain("## Tur: Côte d'Azur");
    expect(md).toContain("2026-07-21 – 2026-07-28 · Sainte-Maxime");
  });

  it("includes the trip.md body under the trip header when non-empty", () => {
    const md = buildTripContextMarkdown(baseArgs({ tripMd: "## Notert\n- Emma er allergisk mot nøtter" }));
    expect(md).toContain("Emma er allergisk mot nøtter");
  });

  it("includes itinerary, bookings, shopping, learned content and taste geo-hits, each under its own heading", () => {
    const md = buildTripContextMarkdown(
      baseArgs({
        itinerary: "- 22/07: Marché de Sainte-Maxime",
        bookings: "<!-- booking id:b1 --> SK4705 <!-- /booking -->",
        shopping: "- solkrem\n- myggspray",
        learned: "Pappa hater sopp.",
        tasteGeoHits: "- Chez Bruno (Restaurants)",
      }),
    );

    expect(md).toContain("## Reiseplan\n- 22/07: Marché de Sainte-Maxime");
    expect(md).toContain("## Bookinger");
    expect(md).toContain("SK4705");
    expect(md).toContain("## Handleliste\n- solkrem\n- myggspray");
    expect(md).toContain("## Lært om gruppen\nPappa hater sopp.");
    expect(md).toContain("Chez Bruno (Restaurants)");
    expect(md).toContain("## I dag\n2026-07-22");
  });

  it("omits empty sections entirely — a fresh trip's context stays short", () => {
    const md = buildTripContextMarkdown(baseArgs());

    expect(md).not.toContain("## Reiseplan");
    expect(md).not.toContain("## Bookinger");
    expect(md).not.toContain("## Handleliste");
    expect(md).not.toContain("## Lært om gruppen");
    expect(md).not.toContain("## Din smak");
    expect(md).not.toContain("## Dine lagrede steder nær turen");
    expect(md).not.toContain("## Samtalen nylig");
    expect(md).not.toContain("## Reise-e-poster");
    // The trip header and the date are the only things guaranteed present.
    expect(md).toContain("## Tur:");
    expect(md).toContain("## I dag");
  });

  it("omits the transcript section when no transcript is given, includes it when given", () => {
    expect(buildTripContextMarkdown(baseArgs())).not.toContain("## Samtalen nylig");
    expect(buildTripContextMarkdown(baseArgs({ transcript: "Bendik: Hei Marcel!" }))).toContain(
      "## Samtalen nylig\nBendik: Hei Marcel!",
    );
  });

  it("includes the reise-log section when given, omits it when empty", () => {
    expect(buildTripContextMarkdown(baseArgs())).not.toContain("## Reise-e-poster");
    const md = buildTripContextMarkdown(
      baseArgs({ reiseLog: "- 2026-07-21 12:06 «Snart starter din leie med Avis» → allerede registrert" }),
    );
    expect(md).toContain("## Reise-e-poster nylig lest");
    expect(md).toContain("«Snart starter din leie med Avis» → allerede registrert");
  });

  it("renders sections in the documented order: Tur, Lokal farge, Reiseplan, Bookinger, Handleliste, Lært, Smak, Geo-hits, Reise-e-post, Samtalen, I dag", () => {
    const md = buildTripContextMarkdown(
      baseArgs({
        itinerary: "itinerary-body",
        bookings: "bookings-body",
        shopping: "shopping-body",
        learned: "learned-body",
        personaOverlay: "overlay-body",
        tasteProfile: "taste-body",
        tasteGeoHits: "geo-body",
        reiseLog: "reise-body",
        transcript: "transcript-body",
      }),
    );

    const order = [
      "## Tur:",
      "## Lokal farge (denne turen)",
      "## Reiseplan",
      "## Bookinger",
      "## Handleliste",
      "## Lært om gruppen",
      "## Din smak",
      "## Dine lagrede steder nær turen",
      "## Reise-e-poster",
      "## Samtalen nylig",
      "## I dag",
    ];
    const indices = order.map((heading) => md.indexOf(heading));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(indices.every((i) => i >= 0)).toBe(true);
  });

  it("never renders the persona or the static automatic-behaviors block — those live in agent/instructions.md", () => {
    const md = buildTripContextMarkdown(baseArgs());
    expect(md).not.toContain("Marcel — Concierge officiel");
    expect(md).not.toContain("Dette gjør du automatisk");
  });
});

// ─── ORB-130 — the trip's own flag, not the French one ─────────────────────────────────────

describe("the signature section", () => {
  const OVERLAY_WITH_FLAG = "**INSTINKTER**\n\nNew York jager.\n\n**FLAGG**\n\n🇺🇸\n";

  it("reads a flag out of the overlay however the heading was formatted", () => {
    expect(overlayFlag(OVERLAY_WITH_FLAG)).toBe("🇺🇸");
    expect(overlayFlag("FLAGG: 🇯🇵")).toBe("🇯🇵");
    expect(overlayFlag("no flag here at all")).toBeUndefined();
  });

  it("names the trip's flag AND the one to stop using", () => {
    const md = buildTripContextMarkdown(baseArgs({ personaOverlay: OVERLAY_WITH_FLAG }));
    expect(md).toContain("## Signatur");
    expect(md).toContain("🇺🇸");
    expect(md).toContain("🇫🇷 skal ikke stå i noen melding");
  });

  it("renders no signature section when the overlay carries no flag", () => {
    const md = buildTripContextMarkdown(baseArgs({ personaOverlay: "**INSTINKTER**\n\nIngen flagg her." }));
    expect(md).not.toContain("## Signatur");
  });

  it("renders nothing when there is no overlay at all", () => {
    expect(buildTripContextMarkdown(baseArgs())).not.toContain("## Signatur");
  });
});
