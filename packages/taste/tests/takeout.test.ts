import { describe, expect, it } from "vitest";

import { assignFilenames, entryFilename, parseEntry, serializeEntry } from "../src/index.js";
import { extractCoords, parseResolvedTakeoutCsv, parseTakeoutCsv } from "../src/takeout.js";

// A real-shaped Takeout export: localised header, a quoted note containing a comma, an entry
// with no note, and one whose URL carries no coordinates at all.
const CSV = [
  "Tittel,Notat,URL",
  '"Lucali","Best pizza, cash only","https://www.google.com/maps/place/data=!4m2!3m1!1s0x0:0x0?@40.6810,-73.9985"',
  // the URL itself contains a comma, so Takeout quotes the field — exercise that path
  '"Katz\'s Delicatessen",,"https://www.google.com/maps/search/?api=1&q=40.7223,-73.9874"',
  '"Et sted uten koordinater","",https://maps.app.goo.gl/abc123',
  "",
].join("\n");

describe("parseTakeoutCsv", () => {
  const places = parseTakeoutCsv(CSV, "NYC 2026");

  it("skips the header row without depending on its localised text", () => {
    expect(places.map((p) => p.name)).toEqual(["Lucali", "Katz's Delicatessen", "Et sted uten koordinater"]);
  });

  it("pulls coordinates out of the @lat,lon URL shape", () => {
    expect(places[0]).toMatchObject({ lat: 40.681, lon: -73.9985 });
  });

  it("pulls coordinates out of the ?q=lat,lon URL shape", () => {
    expect(places[1]).toMatchObject({ lat: 40.7223, lon: -73.9874 });
  });

  it("keeps a place whose URL has no coordinates, rather than dropping it", () => {
    expect(places[2]!.lat).toBeUndefined();
    expect(places[2]!.lon).toBeUndefined();
    expect(places[2]!.name).toBe("Et sted uten koordinater");
  });

  it("reads a quoted note containing a comma as one field", () => {
    expect(places[0]!.note).toBe("Best pizza, cash only");
  });

  it("leaves an empty note off entirely", () => {
    expect(places[1]!.note).toBeUndefined();
  });

  it("tags every entry with the list it came from — half the upsert key", () => {
    expect(places.every((p) => p.sourceList === "NYC 2026")).toBe(true);
  });

  it("skips rows with no title", () => {
    expect(parseTakeoutCsv("Tittel,Notat,URL\n,note,https://x\n", "L")).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    expect(parseTakeoutCsv("Tittel,Notat,URL\r\nLucali,,https://x\r\n", "L").map((p) => p.name)).toEqual(["Lucali"]);
  });

  it("unescapes doubled quotes inside a field", () => {
    expect(parseTakeoutCsv('T,N,U\n"The ""Bar""",,https://x\n', "L")[0]!.name).toBe('The "Bar"');
  });

  it("returns nothing for an empty or header-only file", () => {
    expect(parseTakeoutCsv("", "L")).toEqual([]);
    expect(parseTakeoutCsv("Tittel,Notat,URL\n", "L")).toEqual([]);
  });
});

describe("re-importing the same list", () => {
  it("produces the same filenames, so entries are overwritten rather than duplicated", () => {
    const first = parseTakeoutCsv(CSV, "NYC 2026").map(entryFilename);
    const second = parseTakeoutCsv(CSV, "NYC 2026").map(entryFilename);
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
  });

  it("keeps both copies when the same place is imported under a different list name", () => {
    const a = entryFilename(parseTakeoutCsv(CSV, "NYC 2026")[0]!);
    const b = entryFilename(parseTakeoutCsv(CSV, "Pizza")[0]!);
    expect(a).not.toBe(b);
  });
});

describe("every parsed entry is a valid store entry", () => {
  it("round-trips through the serializer without loss", () => {
    for (const place of parseTakeoutCsv(CSV, "NYC 2026")) {
      expect(parseEntry(serializeEntry(place))).toEqual(place);
    }
  });
});

describe("extractCoords", () => {
  it("answers nothing for a URL with no coordinates in it", () => {
    expect(extractCoords("https://maps.app.goo.gl/abc")).toEqual({});
    expect(extractCoords("")).toEqual({});
  });

  it("reads negative coordinates in both hemispheres", () => {
    expect(extractCoords("https://x/@-33.8566,151.2153")).toEqual({ lat: -33.8566, lon: 151.2153 });
  });
});

// ── the browser-resolved export (the standard coordinate path) ────────────────────────────

const RESOLVED = [
  "Title,Note,Latitude,Longitude,URL",
  'Sip&Guzzle,,40.7314775,-74.0024921,https://www.google.com/maps/place/x/data=!1s0x1:0x2',
  'Supreme,,40.7211892,-73.9940677,https://www.google.com/maps/place/Supreme/data=!1s0xA:0xB',
  'Supreme,,40.7145524,-73.9621403,https://www.google.com/maps/place/Supreme/data=!1s0xC:0xD',
  'Uopploest,,,,https://maps.app.goo.gl/x',
  "",
].join("\n");

describe("parseResolvedTakeoutCsv", () => {
  const places = parseResolvedTakeoutCsv(RESOLVED, "NYC");

  it("reads the coordinates the browser resolved", () => {
    expect(places[0]).toMatchObject({ name: "Sip&Guzzle", lat: 40.7314775, lon: -74.0024921 });
  });

  it("keeps a row whose coordinates could not be resolved, rather than dropping it", () => {
    expect(places[3]!.lat).toBeUndefined();
    expect(places[3]!.name).toBe("Uopploest");
  });

  it("tags every row with its source list", () => {
    expect(places.every((p) => p.sourceList === "NYC")).toBe(true);
  });
});

describe("the same name at two locations", () => {
  it("keeps BOTH pins — one file each, not one overwriting the other", () => {
    const assigned = assignFilenames(parseResolvedTakeoutCsv(RESOLVED, "NYC"));
    const supremes = assigned.filter((a) => a.entry.name === "Supreme");
    expect(supremes).toHaveLength(2);
    expect(supremes[0]!.file).not.toBe(supremes[1]!.file);
    expect(new Set(assigned.map((a) => a.file)).size).toBe(assigned.length);
  });

  it("leaves a name that does not collide with its plain, readable filename", () => {
    const assigned = assignFilenames(parseResolvedTakeoutCsv(RESOLVED, "NYC"));
    expect(assigned.find((a) => a.entry.name === "Sip&Guzzle")!.file).toBe("nyc--sip-guzzle.md");
  });

  it("is stable across a re-import, so upsert still overwrites rather than duplicating", () => {
    const once = assignFilenames(parseResolvedTakeoutCsv(RESOLVED, "NYC")).map((a) => a.file);
    const twice = assignFilenames(parseResolvedTakeoutCsv(RESOLVED, "NYC")).map((a) => a.file);
    expect(twice).toEqual(once);
  });

  it("collapses a genuine duplicate — same name AND same place listed twice", () => {
    const dupe = [
      "Title,Note,Latitude,Longitude,URL",
      "Lucali,,40.681,-73.9985,https://maps.google.com/?x=1",
      "Lucali,,40.681,-73.9985,https://maps.google.com/?x=1",
      "",
    ].join("\n");
    const assigned = assignFilenames(parseResolvedTakeoutCsv(dupe, "NYC"));
    expect(new Set(assigned.map((a) => a.file)).size).toBe(1);
  });

  it("keeps FOUR outlets of one chain apart — the group is not capped at two", () => {
    const chain = [
      "Title,Note,Latitude,Longitude,URL",
      "Joe's Pizza,,40.7305,-74.0021,https://maps.google.com/?x=1",
      "Joe's Pizza,,40.7509,-73.9885,https://maps.google.com/?x=2",
      "Joe's Pizza,,40.7282,-73.9942,https://maps.google.com/?x=3",
      "Joe's Pizza,,40.6892,-73.9905,https://maps.google.com/?x=4",
      "",
    ].join("\n");
    const assigned = assignFilenames(parseResolvedTakeoutCsv(chain, "NYC"));
    expect(assigned).toHaveLength(4);
    expect(new Set(assigned.map((a) => a.file)).size).toBe(4);
    // every outlet keeps its own pin
    expect(new Set(assigned.map((a) => (a.entry as { lat?: number }).lat)).size).toBe(4);
  });

  it("disambiguates by coordinates when the entries carry no URL", () => {
    const assigned = assignFilenames([
      { type: "place", name: "Supreme", lat: 40.72, lon: -73.99, sourceList: "NYC" },
      { type: "place", name: "Supreme", lat: 40.71, lon: -73.96, sourceList: "NYC" },
    ]);
    expect(assigned[0]!.file).not.toBe(assigned[1]!.file);
  });
});
