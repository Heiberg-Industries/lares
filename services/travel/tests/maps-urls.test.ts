// ORB-131 — maps links must survive markdown link parsing.
//
// `encodeURIComponent` deliberately leaves `(` and `)` alone; they are legal in a URL but
// fatal inside a markdown link, because `toTelegramHtml`'s link regex
// (`agent/schedules/trip-lifecycle.ts`) ends the URL at the FIRST literal `)`. Every maps
// URL builder must therefore percent-encode parentheses itself. The acceptance test runs
// each built URL back through that exact regex, per the ticket.
import { describe, expect, it } from "vitest";

import { mapsDirectionsUrl, mapsPlaceUrl, mapsSearchUrl } from "../lib/places.js";
import { venueMapsUrl } from "../lib/booking-venue.js";

// The exact link shape `toTelegramHtml` matches (trip-lifecycle.ts) — a URL survives iff
// the whole URL is captured, i.e. it contains no literal `)`.
const MARKDOWN_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/;

function capturedUrl(url: string): string | undefined {
  const match = MARKDOWN_LINK.exec(`[x](${url})`);
  return match?.[2];
}

const PARENS_QUERY = "il Buco, 47 Bond St (Between Bowery and Lafayette St)";

describe("maps URL builders encode parentheses (ORB-131)", () => {
  it("mapsSearchUrl survives the markdown link parser", () => {
    const url = mapsSearchUrl(PARENS_QUERY);
    expect(url).not.toContain("(");
    expect(url).not.toContain(")");
    expect(capturedUrl(url)).toBe(url);
  });

  it("mapsPlaceUrl survives the markdown link parser", () => {
    const url = mapsPlaceUrl("Cafe (Old Town)", "ChIJabc123");
    expect(url).not.toContain("(");
    expect(url).not.toContain(")");
    expect(capturedUrl(url)).toBe(url);
  });

  it("mapsDirectionsUrl with a parenthesized label survives the markdown link parser", () => {
    const url = mapsDirectionsUrl(
      { lat: 40.7264, lon: -73.9926 },
      { label: "il Buco", nearLabel: "47 Bond St (Between Bowery and Lafayette St)" },
    );
    expect(url).not.toContain("(");
    expect(url).not.toContain(")");
    expect(capturedUrl(url)).toBe(url);
  });

  it("venueMapsUrl still encodes parentheses after delegating to the shared builders", () => {
    const url = venueMapsUrl({ name: "Museum of X (Annex)", address: "1 Main St (rear entrance)" });
    expect(url).toBeDefined();
    expect(url).not.toContain("(");
    expect(url).not.toContain(")");
    expect(capturedUrl(url!)).toBe(url);
  });
});
