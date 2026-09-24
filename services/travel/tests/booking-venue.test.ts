// ORB-129 — the venue identity line: the name and address the extractor always produced and
// bookingBlock used to discard, plus the maps link built from them.
import { describe, it, expect } from "vitest";

import { venueLine, venueMapsUrl, withVenueLines } from "../lib/booking-venue.js";

// The real extractions from /srv/eve-marcel/extractions.json, and the real filed blocks they
// belong to — which carried neither the name nor the address.
const REAL = {
  "19fd153c173592fe": { name: "The Tavern at Gramercy Tavern", address: "42 East 20th Street, New York, NY 10003", kind: "restaurant" },
  "19fd1989c05bddd1": { name: "The Golden Swan", address: "314 W 11th St, New York, NY 10014-2369", kind: "restaurant" },
  "19fcbf629643c74b": { name: "PUBLIC Hotels", address: "215 Chrystie Street, New York, NY 10002", kind: "stay" },
  "19ccd80c14716be7": { name: "SAS", address: "Oslo Gardermoen", kind: "flight" },
} as const;

const FILED =
  "<!-- booking id:19fd153c173592fe kind:restaurant start:2026-08-26 end:- time:20:00 at:40.73846,-73.98851 -->\n" +
  "- Outdoor Tavern Dining, table for 2 guests. Cancellations at least 3 hours in advance.\n" +
  "<!-- /booking -->\n" +
  "<!-- booking id:19ccd80c14716be7 kind:flight start:2026-08-26 end:2026-08-31 time:09:00 -->\n" +
  "- SAS flight, SK455 Oslo Gardermoen-Copenhagen Kastrup 26AUG 09:00-10:10.\n" +
  "<!-- /booking -->\n";

describe("venueMapsUrl", () => {
  it("percent-encodes parentheses, or the markdown link truncates at the first one", () => {
    // il Buco's real address. toTelegramHtml matches [^)\s]+ inside (...), so a literal ")"
    // ends the link — this exact URL would have shipped cut off at "(Between%20Bowery".
    const url = venueMapsUrl({ name: "il Buco", address: "47 Bond St (Between Bowery and Lafayette St), New York, NY 10012", kind: "restaurant" })!;
    expect(url).not.toMatch(/[()]/);
    expect(url).toContain("%28");
    expect(url).toContain("%29");
    const captured = `[il Buco](${url})`.match(/\[([^\]]+)\]\(([^)\s]+)\)/)?.[2];
    expect(captured).toBe(url); // the whole URL survives the link parser
  });

  it("prefers the exact place link when a Places id is known", () => {
    const url = venueMapsUrl({ name: "Cosme", address: "35 E 21st St", placeId: "ChIJabc123", kind: "restaurant" });
    expect(url).toContain("query_place_id=ChIJabc123");
    expect(url).toContain("query=Cosme");
  });

  it("falls back to a name+address search, which is what lib/places.ts itself does", () => {
    const url = venueMapsUrl(REAL["19fd1989c05bddd1"]);
    expect(url).toBe(
      "https://www.google.com/maps/search/?api=1&query=" +
        encodeURIComponent("The Golden Swan, 314 W 11th St, New York, NY 10014-2369"),
    );
  });

  it("never builds a link for a FLIGHT — the provider there is an airline, not a place", () => {
    expect(venueMapsUrl(REAL["19ccd80c14716be7"])).toBeUndefined();
  });

  it("never builds a link from a bare name, however confident it looks", () => {
    // "Onepark / Avinor" resolves to nothing trustworthy, and instructions.md forbids falling
    // back to a coordinate link.
    expect(venueMapsUrl({ name: "Onepark / Avinor", kind: "car" })).toBeUndefined();
    expect(venueMapsUrl({ name: "SAS", kind: "other" })).toBeUndefined();
  });

  it("is undefined when there is no name at all", () => {
    expect(venueMapsUrl({ address: "42 East 20th Street", kind: "restaurant" })).toBeUndefined();
    expect(venueMapsUrl({})).toBeUndefined();
  });
});

describe("venueLine", () => {
  it("renders the name as a markdown link followed by the address", () => {
    expect(venueLine(REAL["19fd153c173592fe"])).toBe(
      "- [The Tavern at Gramercy Tavern](https://www.google.com/maps/search/?api=1&query=" +
        encodeURIComponent("The Tavern at Gramercy Tavern, 42 East 20th Street, New York, NY 10003") +
        ") — 42 East 20th Street, New York, NY 10003",
    );
  });

  it("is empty whenever there is nothing navigable, so a block gains no empty heading", () => {
    expect(venueLine({})).toBe("");
    expect(venueLine(REAL["19ccd80c14716be7"])).toBe(""); // flight
    expect(venueLine({ name: "Onepark / Avinor", kind: "car" })).toBe("");
  });
});

describe("withVenueLines — repairing already-filed blocks", () => {
  const lookup = (id: string) => (REAL as Record<string, { name: string; address: string; kind: string }>)[id];

  it("adds the identity line to a block that can be named, and leaves the flight alone", () => {
    const repaired = withVenueLines(FILED, lookup);
    expect(repaired).toContain("- [The Tavern at Gramercy Tavern](");
    expect(repaired).toContain("42 East 20th Street");
    expect(repaired).not.toContain("[SAS]");
  });

  it("keeps the summary as the FIRST body line — detailsLineFor reads exactly that", () => {
    const repaired = withVenueLines(FILED, lookup);
    const firstBodyLine = repaired.split("\n")[1];
    expect(firstBodyLine).toBe("- Outdoor Tavern Dining, table for 2 guests. Cancellations at least 3 hours in advance.");
  });

  it("leaves every header byte-identical", () => {
    const headers = (md: string) => md.match(/<!-- booking [^\n]*-->/g);
    expect(headers(withVenueLines(FILED, lookup))).toEqual(headers(FILED));
  });

  it("changes nothing for an id it cannot name — a repair writes only on a confirmed match", () => {
    expect(withVenueLines(FILED, () => undefined)).toBe(FILED);
  });

  it("is idempotent: running it twice adds nothing the second time", () => {
    const once = withVenueLines(FILED, lookup);
    expect(withVenueLines(once, lookup)).toBe(once);
  });

  it("preserves the original block text verbatim, which ORB-126 quotes policies from", () => {
    expect(withVenueLines(FILED, lookup)).toContain("Cancellations at least 3 hours in advance.");
    expect(withVenueLines(FILED, lookup)).toContain("SK455 Oslo Gardermoen-Copenhagen Kastrup 26AUG 09:00-10:10.");
  });
});
