import { describe, expect, it } from "vitest";

import {
  TASTE_TYPES,
  TASTE_DOMAINS,
  domainFor,
  entryFilename,
  parseEntry,
  serializeEntry,
  slugify,
  type ListEntry,
  type PlaceEntry,
  type TasteEntry,
} from "../src/index.js";

const PLACE_A: PlaceEntry = {
  type: "place",
  name: "Place A",
  lat: 41.2503,
  lon: -72.4417,
  city: "Example City",
  url: "https://maps.google.com/?cid=123",
  sourceList: "List A",
  note: "Best pizza in the district.\nCash only, no reservations.",
};

const PLAYLIST: ListEntry = {
  type: "playlist",
  name: "Playlist A",
  sourceList: "pasted",
  items: ["Artist One — Album One", "Artist Two — Album Two"],
};

describe("the entry shape", () => {
  it("names every OKF type the taste store may use", () => {
    // Extends the Atlas vocabulary (ADR-0010 §9), never forks it — `note` is shared.
    expect([...TASTE_TYPES]).toEqual(["place", "track", "playlist", "dish", "note"]);
    expect([...TASTE_DOMAINS]).toEqual(["places", "music", "food", "notes"]);
  });

  it("maps each type to the folder it lives in", () => {
    expect(domainFor("place")).toBe("places");
    expect(domainFor("track")).toBe("music");
    expect(domainFor("playlist")).toBe("music");
    expect(domainFor("dish")).toBe("food");
    expect(domainFor("note")).toBe("notes");
  });
});

describe("round trip", () => {
  it("parse ∘ serialize is identity for a fully-populated place", () => {
    expect(parseEntry(serializeEntry(PLACE_A))).toEqual(PLACE_A);
  });

  it("parse ∘ serialize is identity for a bare place (name only)", () => {
    const bare: PlaceEntry = { type: "place", name: "Place Roaster" };
    expect(parseEntry(serializeEntry(bare))).toEqual(bare);
  });

  it("parse ∘ serialize is identity for a list entry", () => {
    expect(parseEntry(serializeEntry(PLAYLIST))).toEqual(PLAYLIST);
  });

  it("parse ∘ serialize is identity for an empty list", () => {
    const empty: ListEntry = { type: "note", name: "Ting å prøve", items: [] };
    expect(parseEntry(serializeEntry(empty))).toEqual(empty);
  });

  it("survives values that would otherwise break a naive frontmatter parser", () => {
    const nasty: PlaceEntry = {
      type: "place",
      // colon, brackets, quotes, leading space, a non-ASCII name — all in one
      name: ' [Bar]: "Grønnøy" ',
      city: "Exampleville: centre",
      note: "line one\n\nline three",
      sourceList: "  padded  ",
    };
    expect(parseEntry(serializeEntry(nasty))).toEqual(nasty);
  });

  it("keeps coordinate precision exactly", () => {
    const p: PlaceEntry = { type: "place", name: "x", lat: -33.856159, lon: 151.215256 };
    const back = parseEntry(serializeEntry(p)) as PlaceEntry;
    expect(back.lat).toBe(-33.856159);
    expect(back.lon).toBe(151.215256);
  });

  it("serialises a place into readable, hand-editable markdown", () => {
    expect(serializeEntry({ type: "place", name: "Place A", city: "Example City", note: "Pizza." })).toBe(
      ["---", "type: place", "name: Place A", "city: Example City", "---", "", "Pizza.", ""].join("\n"),
    );
  });

  it("serialises a list as markdown list items under the frontmatter", () => {
    expect(serializeEntry(PLAYLIST)).toBe(
      [
        "---",
        "type: playlist",
        "name: Playlist A",
        "source_list: pasted",
        "---",
        "",
        "- Artist One — Album One",
        "- Artist Two — Album Two",
        "",
      ].join("\n"),
    );
  });
});

describe("validation — the store never holds an untyped file", () => {
  it("rejects a file with no frontmatter at all", () => {
    expect(() => parseEntry("Place A is great\n")).toThrow(/frontmatter/i);
  });

  it("rejects an unterminated frontmatter block", () => {
    expect(() => parseEntry("---\ntype: place\nname: x\n")).toThrow(/unterminated/i);
  });

  it("rejects a missing type:", () => {
    expect(() => parseEntry("---\nname: Place A\n---\n")).toThrow(/type/i);
  });

  it("rejects an empty type:", () => {
    expect(() => parseEntry("---\ntype:\nname: Place A\n---\n")).toThrow(/type/i);
  });

  it("rejects a type outside the vocabulary", () => {
    expect(() => parseEntry("---\ntype: venture\nname: Place A\n---\n")).toThrow(/venture/);
  });

  it("rejects a missing name", () => {
    expect(() => parseEntry("---\ntype: place\n---\n")).toThrow(/name/i);
  });

  it("rejects half a coordinate — a lat with no lon is unusable", () => {
    expect(() => parseEntry("---\ntype: place\nname: x\nlat: 41.2\n---\n")).toThrow(/lat.*lon|lon.*lat/i);
  });

  it("rejects an out-of-range coordinate", () => {
    expect(() => parseEntry("---\ntype: place\nname: x\nlat: 91\nlon: 0\n---\n")).toThrow(/range|lat/i);
  });

  it("rejects a non-numeric coordinate", () => {
    expect(() => parseEntry("---\ntype: place\nname: x\nlat: soon\nlon: 0\n---\n")).toThrow(/lat/i);
  });

  it("refuses to serialise an entry the parser would reject", () => {
    expect(() => serializeEntry({ type: "place", name: "  " } as TasteEntry)).toThrow(/name/i);
  });
});

describe("tolerating hand-editing", () => {
  it("ignores blank lines and comments in the frontmatter", () => {
    const raw = ["---", "# the owner's own note to self", "", "type: place", "name: Place A", "---", "", "Pizza.", ""].join("\n");
    expect(parseEntry(raw)).toEqual({ type: "place", name: "Place A", note: "Pizza." });
  });

  it("treats a whitespace-only body as no note", () => {
    const parsed = parseEntry("---\ntype: place\nname: Place A\n---\n\n   \n") as PlaceEntry;
    expect(parsed.note).toBeUndefined();
  });

  it("reads list items whether or not they are separated by blank lines", () => {
    const raw = "---\ntype: playlist\nname: L\n---\n\n- one\n\n- two\n";
    expect((parseEntry(raw) as ListEntry).items).toEqual(["one", "two"]);
  });

  it("accepts * as a list bullet too", () => {
    expect((parseEntry("---\ntype: dish\nname: D\n---\n\n* cacio e pepe\n") as ListEntry).items).toEqual([
      "cacio e pepe",
    ]);
  });

  it("keeps a non-bulleted line in a list file rather than dropping it", () => {
    expect((parseEntry("---\ntype: note\nname: N\n---\n\nbare line\n- bulleted\n") as ListEntry).items).toEqual([
      "bare line",
      "bulleted",
    ]);
  });
});

describe("country and the store's own stamps", () => {
  const STAMPED: PlaceEntry = {
    type: "place",
    name: "Place F",
    city: "Eksempelbyen",
    country: "Eksempelland",
    sourceList: "LIST-B",
    importedAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-01-01T12:30:00.000Z",
  };

  it("round-trips country and both stamps", () => {
    expect(parseEntry(serializeEntry(STAMPED))).toEqual(STAMPED);
  });

  it("writes them as their own frontmatter keys, stamps last", () => {
    const lines = serializeEntry(STAMPED).split("\n");
    expect(lines).toContain("country: Eksempelland");
    expect(lines.slice(-4, -2)).toEqual([
      "imported_at: 2026-01-01T10:00:00.000Z",
      "updated_at: 2026-01-01T12:30:00.000Z",
    ]);
  });

  it("reads a file that predates the fields — no migration required", () => {
    const legacy = "---\ntype: place\nname: Place A\ncity: Example City\n---\n";
    const parsed = parseEntry(legacy) as PlaceEntry;
    expect(parsed).toEqual({ type: "place", name: "Place A", city: "Example City" });
    expect(parsed.country).toBeUndefined();
    expect(parsed.importedAt).toBeUndefined();
  });

  it("carries country and stamps on a list entry too", () => {
    const list: ListEntry = { ...PLAYLIST, importedAt: "2026-01-01T10:00:00.000Z" };
    expect(parseEntry(serializeEntry(list))).toEqual(list);
  });

  it("DROPS a hand-typed stamp it cannot read rather than losing the whole entry", () => {
    // The asymmetry with lat/lon is deliberate: a bad coordinate would misdirect the trip planner, a bad
    // date costs a badge. Throwing here would delete the PLACE from his recommendations.
    const raw = "---\ntype: place\nname: Place A\nimported_at: i går\n---\n";
    expect(parseEntry(raw)).toEqual({ type: "place", name: "Place A" });
  });

  it("refuses to WRITE a stamp it could not read back", () => {
    expect(() => serializeEntry({ ...STAMPED, updatedAt: "i går" })).toThrow(/readable timestamp/);
  });
});

describe("filenames — the upsert key", () => {
  it("is stable for the same (name, sourceList) pair, so re-import overwrites", () => {
    expect(entryFilename(PLACE_A)).toBe("list-a--place-a.md");
    expect(entryFilename({ ...PLACE_A, note: "changed" })).toBe(entryFilename(PLACE_A));
  });

  it("separates the same name saved from two different lists", () => {
    expect(entryFilename({ ...PLACE_A, sourceList: "Pizza" })).not.toBe(entryFilename(PLACE_A));
  });

  it("drops the prefix when there is no source list", () => {
    expect(entryFilename({ type: "place", name: "Place A" })).toBe("place-a.md");
  });

  it("folds Norwegian letters rather than stripping them to nothing", () => {
    expect(slugify("Grønnøy Æ Å")).toBe("gronnoy-ae-aa");
  });

  it("refuses a name that slugifies to nothing — an unaddressable file", () => {
    expect(() => entryFilename({ type: "place", name: "、。" })).toThrow(/slug/i);
  });
});
