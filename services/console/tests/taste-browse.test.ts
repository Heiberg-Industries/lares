// Tests for what the Taste browse view shows (ORB-110): filtering, sorting, freshness badges.
//
// Pure — these take already-read entries, so no temp store is needed here. The point of pulling
// them out of the page component is exactly this: "the filter works" is a claim that gets
// verified rather than eyeballed once and assumed forever.
import { describe, it, expect } from "vitest";

import type { PlaceEntry, TasteEntry } from "@lares/taste";

import {
  FRESH_DAYS,
  badgeFor,
  detailFor,
  isFiltered,
  matches,
  optionsFor,
  readFilters,
  sortRows,
  touchedAt,
  type Filters,
} from "../lib/taste-browse";
import type { StoredEntry } from "../lib/taste-store";

const NOW = Date.parse("2026-08-17T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function stored(entry: TasteEntry | null, file = `${entry?.name ?? "broken"}.md`): StoredEntry {
  return { domain: "places", file, entry };
}

const place = (p: Partial<PlaceEntry> & { name: string }): PlaceEntry => ({ type: "place", ...p });

const LUCALI = stored(place({ name: "Lucali", city: "New York", country: "USA", sourceList: "NYC", lat: 40.681, lon: -73.9985 }));
const NOMA = stored(place({ name: "Noma", city: "København", country: "Danmark", sourceList: "CPH" }));
const KADEAU = stored(place({ name: "Kadeau", city: "København", country: "Danmark", sourceList: "CPH" }));
const PLAYLIST = stored({ type: "playlist", name: "Sommer", sourceList: "pastet", items: ["a"] });
const ALL = [LUCALI, NOMA, KADEAU, PLAYLIST];

const filters = (patch: Partial<Filters> = {}): Filters =>
  ({ list: "", city: "", country: "", q: "", sort: "navn", ...patch });

describe("reading the filter off the query string", () => {
  it("defaults to everything, sorted by name", () => {
    expect(readFilters({})).toEqual(filters());
    expect(isFiltered(readFilters({}))).toBe(false);
  });

  it("reads each facet, trimming what the browser sends", () => {
    const f = readFilters({ list: " NYC ", city: "New York", country: "USA", q: " luc ", sort: "nyeste" });
    expect(f).toEqual({ list: "NYC", city: "New York", country: "USA", q: "luc", sort: "nyeste" });
    expect(isFiltered(f)).toBe(true);
  });

  it("falls back to the default sort rather than erroring on a hand-edited URL", () => {
    expect(readFilters({ sort: "; drop table" }).sort).toBe("navn");
  });

  it("takes the first value when a key repeats", () => {
    expect(readFilters({ city: ["Oslo", "Bergen"] }).city).toBe("Oslo");
  });

  it("does not count sorting as filtering — sorting hides nothing", () => {
    expect(isFiltered(readFilters({ sort: "nyeste" }))).toBe(false);
  });
});

describe("filtering", () => {
  it("narrows by list, city and country", () => {
    expect(ALL.filter((s) => matches(s, filters({ list: "CPH" })))).toEqual([NOMA, KADEAU]);
    expect(ALL.filter((s) => matches(s, filters({ city: "New York" })))).toEqual([LUCALI]);
    expect(ALL.filter((s) => matches(s, filters({ country: "Danmark" })))).toEqual([NOMA, KADEAU]);
  });

  it("combines facets — every one set must hold", () => {
    expect(ALL.filter((s) => matches(s, filters({ country: "Danmark", q: "noma" })))).toEqual([NOMA]);
    expect(ALL.filter((s) => matches(s, filters({ country: "Danmark", city: "New York" })))).toEqual([]);
  });

  it("matches a name substring, ignoring case", () => {
    expect(ALL.filter((s) => matches(s, filters({ q: "KA" })))).toEqual([KADEAU]);
  });

  it("hides an entry that has no such field at all — a playlist is not in New York", () => {
    expect(matches(PLAYLIST, filters({ city: "New York" }))).toBe(false);
    expect(matches(PLAYLIST, filters({ country: "Danmark" }))).toBe(false);
    // ...but it does have a source list, so that facet still reaches it.
    expect(matches(PLAYLIST, filters({ list: "pastet" }))).toBe(true);
  });

  it("keeps an UNPARSEABLE file findable by its filename — the browse view is where it is deleted", () => {
    const broken = stored(null, "cph--noma.md");
    expect(matches(broken, filters({ q: "noma" }))).toBe(true);
    expect(matches(broken, filters())).toBe(true);
  });
});

describe("the facet dropdowns", () => {
  it("offer each distinct value once, alphabetically", () => {
    expect(optionsFor(ALL, "city")).toEqual(["København", "New York"]);
    expect(optionsFor(ALL, "country")).toEqual(["Danmark", "USA"]);
    expect(optionsFor(ALL, "list")).toEqual(["CPH", "NYC", "pastet"]);
  });

  it("skip entries that have nothing to offer", () => {
    expect(optionsFor([stored(place({ name: "Bare" })), stored(null)], "city")).toEqual([]);
  });
});

describe("freshness badges", () => {
  const imported = (at: string) => stored(place({ name: "P", importedAt: at }));
  const changed = (at: string) => stored(place({ name: "P", importedAt: daysAgo(90), updatedAt: at }));

  it("badges a just-imported entry ny, with the exact date to hover", () => {
    expect(badgeFor(imported(daysAgo(1)).entry, NOW)).toMatchObject({
      text: "ny",
      title: `Lagt inn ${daysAgo(1).slice(0, 10)}`,
    });
  });

  it("badges a changed entry endret, dated by the change and not the import", () => {
    expect(badgeFor(changed(daysAgo(2)).entry, NOW)).toMatchObject({
      text: "endret",
      title: `Endret ${daysAgo(2).slice(0, 10)}`,
    });
  });

  it("stops badging once the entry is older than the window", () => {
    expect(badgeFor(imported(daysAgo(FRESH_DAYS - 1)).entry, NOW)).toBeDefined();
    expect(badgeFor(imported(daysAgo(FRESH_DAYS + 1)).entry, NOW)).toBeUndefined();
    expect(badgeFor(changed(daysAgo(FRESH_DAYS + 1)).entry, NOW)).toBeUndefined();
  });

  it("badges nothing for the entries that predate stamps entirely", () => {
    // 862 places were imported before anything recorded a date. "We never knew" must read as
    // no badge, not as fresh and not as an invented date.
    expect(badgeFor(LUCALI.entry, NOW)).toBeUndefined();
    expect(badgeFor(null, NOW)).toBeUndefined();
  });
});

describe("sorting", () => {
  it("by name, Norwegian collation", () => {
    const rows = [stored(place({ name: "Åpent" })), stored(place({ name: "Bakeri" })), stored(place({ name: "Alfa" }))];
    expect(sortRows(rows, "navn").map((s) => s.entry?.name)).toEqual(["Alfa", "Bakeri", "Åpent"]);
  });

  it("by recency, newest first", () => {
    const old = stored(place({ name: "Gammel", importedAt: daysAgo(30) }));
    const mid = stored(place({ name: "Midt", importedAt: daysAgo(10) }));
    const fresh = stored(place({ name: "Fersk", importedAt: daysAgo(30), updatedAt: daysAgo(1) }));
    expect(sortRows([old, mid, fresh], "nyeste").map((s) => s.entry?.name)).toEqual(["Fersk", "Midt", "Gammel"]);
  });

  it("sinks the undated to the bottom rather than treating them as oldest-known", () => {
    const undated = stored(place({ name: "Ukjent" }));
    const dated = stored(place({ name: "Datert", importedAt: daysAgo(400) }));
    expect(sortRows([undated, dated], "nyeste").map((s) => s.entry?.name)).toEqual(["Datert", "Ukjent"]);
  });

  it("falls back to name when two entries are equally recent", () => {
    const a = stored(place({ name: "B", importedAt: daysAgo(1) }));
    const b = stored(place({ name: "A", importedAt: daysAgo(1) }));
    expect(sortRows([a, b], "nyeste").map((s) => s.entry?.name)).toEqual(["A", "B"]);
  });

  it("does not mutate the array it was given", () => {
    const rows = [stored(place({ name: "B" })), stored(place({ name: "A" }))];
    sortRows(rows, "navn");
    expect(rows.map((s) => s.entry?.name)).toEqual(["B", "A"]);
  });
});

describe("touchedAt", () => {
  it("takes the later of the two stamps", () => {
    expect(touchedAt(place({ name: "P", importedAt: daysAgo(9), updatedAt: daysAgo(2) }))).toBe(daysAgo(2));
    expect(touchedAt(place({ name: "P", importedAt: daysAgo(9) }))).toBe(daysAgo(9));
    expect(touchedAt(place({ name: "P" }))).toBeUndefined();
  });
});

describe("the detail line", () => {
  it("shows city, country, coordinates and the source list", () => {
    expect(detailFor(LUCALI)).toBe("New York, USA · 40.6810, -73.9985 · fra «NYC»");
  });

  it("says outright when a place has no pin", () => {
    expect(detailFor(NOMA)).toBe("København, Danmark · uten koordinater · fra «CPH»");
  });

  it("counts the lines of a list entry", () => {
    expect(detailFor(PLAYLIST)).toBe("playlist · 1 linjer");
  });

  it("is empty for a file that could not be read", () => {
    expect(detailFor(stored(null))).toBe("");
  });
});
