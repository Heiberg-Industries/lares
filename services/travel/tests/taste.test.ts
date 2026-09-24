// Tests for lib/taste.ts and lib/taste-store.ts after ORB-100 moved Marcel's saved places from
// his own Takeout CSVs to the fleet store at /srv/taste.
//
// The CSV parsing these tests used to cover now lives in @lares/taste (packages/taste/tests/
// takeout.test.ts) — it moved to where the console imports it, and Marcel no longer reads CSVs
// at all. What is left here is what this file was actually FOR: deciding which saved places
// belong to a trip, and rendering them small enough to sit in a prompt.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { serializeEntry, type ListEntry, type PlaceEntry } from "@lares/taste";

import { TasteStore } from "../lib/taste-store.js";
import {
  TRIP_RADIUS_KM,
  findSavedMatch,
  haversineKm,
  nearTrip,
  normalizePlaceName,
  savedSummary,
  tasteDigest,
} from "../lib/taste.js";

const NYC = { name: "New York", lat: 40.7128, lon: -74.006 };
const SAINTE_MAXIME = { name: "Sainte-Maxime", lat: 43.309, lon: 6.637 };

function place(over: Partial<PlaceEntry> & { name: string }): PlaceEntry {
  return { type: "place", ...over };
}

// ── the store reader ─────────────────────────────────────────────────────────────────────

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-taste-store-"));
  process.env["TASTE_ROOT"] = root;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env["TASTE_ROOT"];
});

function seed(domain: string, file: string, entry: PlaceEntry | ListEntry): void {
  const dir = path.join(root, domain);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), serializeEntry(entry));
}

describe("TasteStore — the read-only view of /srv/taste", () => {
  it("reads places written by the console, through the shared package", () => {
    seed("places", "nyc--lucali.md", place({ name: "Lucali", lat: 40.681, lon: -73.9985, sourceList: "NYC 2026" }));
    expect(new TasteStore().places()).toEqual([
      { type: "place", name: "Lucali", lat: 40.681, lon: -73.9985, sourceList: "NYC 2026" },
    ]);
  });

  it("gathers the non-place domains into one list view", () => {
    seed("music", "sommer.md", { type: "playlist", name: "Sommer", items: ["Pink Moon"] });
    seed("food", "pasta.md", { type: "dish", name: "Pasta", items: ["cacio e pepe"] });
    seed("notes", "div.md", { type: "note", name: "Div", items: ["noe"] });
    expect(new TasteStore().lists().map((l) => l.name).sort()).toEqual(["Div", "Pasta", "Sommer"]);
  });

  // THE degradation rule (ORB-100): the mount must never be load-bearing.
  it("answers empty for a store that is not mounted at all", () => {
    process.env["TASTE_ROOT"] = path.join(root, "nowhere");
    expect(new TasteStore().places()).toEqual([]);
    expect(new TasteStore().lists()).toEqual([]);
  });

  it("answers empty for a mounted but empty store", () => {
    expect(new TasteStore().places()).toEqual([]);
    expect(new TasteStore().lists()).toEqual([]);
  });

  it("skips one unreadable file rather than losing the rest", () => {
    seed("places", "good.md", place({ name: "Lucali" }));
    fs.writeFileSync(path.join(root, "places", "bad.md"), "not a taste file\n");
    expect(new TasteStore().places().map((p) => p.name)).toEqual(["Lucali"]);
  });

  it("ignores non-markdown files in the folder", () => {
    seed("places", "good.md", place({ name: "Lucali" }));
    fs.writeFileSync(path.join(root, "places", "notes.txt"), "hei");
    expect(new TasteStore().places()).toHaveLength(1);
  });
});

// ── which places belong to a trip ────────────────────────────────────────────────────────

describe("nearTrip", () => {
  const saved = [
    place({ name: "Lucali", lat: 40.681, lon: -73.9985, sourceList: "NYC 2026" }),      // Brooklyn
    place({ name: "Katz's", lat: 40.7223, lon: -73.9874 }),                              // Manhattan
    place({ name: "Maaemo", lat: 59.9075, lon: 10.7529, sourceList: "Oslo" }),           // Oslo
    place({ name: "Chez Bruno", lat: 43.4901, lon: 6.3648, sourceList: "Provence" }),    // Provence
    place({ name: "Uten koordinater", city: "New York", sourceList: "Fra Ida" }),
    place({ name: "Oslo-tips uten koordinater", city: "Oslo" }),
    place({ name: "Verken eller" }),
  ];

  it("takes the NYC entries and leaves Oslo and Provence behind", () => {
    const names = nearTrip(saved, NYC).map((p) => p.name);
    expect(names).toContain("Lucali");
    expect(names).toContain("Katz's");
    expect(names).not.toContain("Maaemo");
    expect(names).not.toContain("Chez Bruno");
  });

  it("matches a coordinate-less entry on its city, so pasted lists still land", () => {
    expect(nearTrip(saved, NYC).map((p) => p.name)).toContain("Uten koordinater");
  });

  it("does not match a coordinate-less entry whose city is a different city", () => {
    expect(nearTrip(saved, NYC).map((p) => p.name)).not.toContain("Oslo-tips uten koordinater");
  });

  it("never guesses at an entry with neither coordinates nor a city", () => {
    expect(nearTrip(saved, NYC).map((p) => p.name)).not.toContain("Verken eller");
    expect(nearTrip(saved, SAINTE_MAXIME).map((p) => p.name)).not.toContain("Verken eller");
  });

  it("folds Norwegian letters when matching a city", () => {
    const p = [place({ name: "Bakeri", city: "Nøtterøy" })];
    expect(nearTrip(p, { name: "Notteroy", lat: 59.2, lon: 10.4 })).toHaveLength(1);
  });

  it("uses ~30 km, not the 60 km of the CSV era", () => {
    expect(TRIP_RADIUS_KM).toBe(30);
    // Katz's is ~4 km from the NYC anchor; a point 50 km out is not.
    const far = place({ name: "Langt unna", lat: 41.16, lon: -74.006 }); // ~50 km north
    expect(nearTrip([far], NYC).map((p) => p.name)).toEqual([]);
    expect(nearTrip([far], NYC, 60).map((p) => p.name)).toEqual(["Langt unna"]);
  });

  it("finds nothing in an empty store, which is how a missing mount reaches this function", () => {
    expect(nearTrip([], NYC)).toEqual([]);
  });
});

describe("haversineKm", () => {
  it("computes Oslo–Paris to within 5% of the known ~1337 km", () => {
    const d = haversineKm({ lat: 59.9139, lon: 10.7522 }, { lat: 48.8566, lon: 2.3522 });
    expect(d).toBeGreaterThan(1337 * 0.95);
    expect(d).toBeLessThan(1337 * 1.05);
  });
});

// ── rendering ────────────────────────────────────────────────────────────────────────────

describe("savedSummary", () => {
  it("gives one line per place: name, source list, note", () => {
    expect(
      savedSummary([
        place({ name: "Lucali", sourceList: "NYC 2026", note: "Kontant" }),
        place({ name: "Katz's", sourceList: "NYC 2026" }),
        place({ name: "Uten liste" }),
      ]),
    ).toBe("- Lucali (NYC 2026) — Kontant\n- Katz's (NYC 2026)\n- Uten liste");
  });

  it("flattens a multi-line note so one entry stays one line", () => {
    expect(savedSummary([place({ name: "X", note: "linje en\n\nlinje to" })])).toBe("- X — linje en linje to");
  });

  it("caps the list and SAYS how many it left out — never silently truncates", () => {
    const many = Array.from({ length: 95 }, (_, i) => place({ name: `Sted ${i}` }));
    const lines = savedSummary(many).split("\n");
    expect(lines).toHaveLength(81);
    expect(lines[80]).toBe("… og 15 til");
  });

  it("adds no note when everything fits", () => {
    expect(savedSummary([place({ name: "X" })])).toBe("- X");
  });

  it("renders empty for no places, so the section is omitted entirely", () => {
    expect(savedSummary([])).toBe("");
  });
});

describe("tasteDigest", () => {
  const lists: ListEntry[] = [
    { type: "playlist", name: "Sommer", items: ["Pink Moon", "Turiya"] },
    { type: "dish", name: "Å lage", items: ["cacio e pepe"] },
  ];

  it("summarises each list in one line", () => {
    expect(tasteDigest(lists)).toBe("- Sommer (playlist): Pink Moon, Turiya\n- Å lage (dish): cacio e pepe");
  });

  it("caps the items inside a long list and counts the rest", () => {
    const long: ListEntry[] = [{ type: "playlist", name: "Lang", items: Array.from({ length: 12 }, (_, i) => `s${i}`) }];
    expect(tasteDigest(long)).toContain("… (+4)");
  });

  it("caps the number of lists and counts the rest", () => {
    const many: ListEntry[] = Array.from({ length: 15 }, (_, i) => ({ type: "note", name: `L${i}`, items: ["x"] }));
    expect(tasteDigest(many).split("\n")).toHaveLength(13);
    expect(tasteDigest(many)).toContain("… og 3 lister til");
  });

  it("renders empty for no lists", () => {
    expect(tasteDigest([])).toBe("");
  });
});

// ── the ⭐ cross-reference (unchanged behaviour, new entry shape) ─────────────────────────

describe("findSavedMatch", () => {
  const saved = [
    place({ name: "Chez Fonfon", sourceList: "Côte d_Azur" }),
    place({ name: "Le Petit Nice — Passédat", note: "3 stjerner", sourceList: "Côte d_Azur" }),
    place({ name: "Bar", sourceList: "junk" }),
  ];

  it("matches on normalised equality (case, diacritics, punctuation)", () => {
    expect(findSavedMatch("chez fonfon", saved)?.sourceList).toBe("Côte d_Azur");
    expect(findSavedMatch("CHEZ FONFON", saved)?.name).toBe("Chez Fonfon");
  });

  it("matches on containment of ≥4 characters in either direction", () => {
    expect(findSavedMatch("Restaurant Chez Fonfon Marseille", saved)?.name).toBe("Chez Fonfon");
    expect(findSavedMatch("Le Petit Nice", saved)?.note).toBe("3 stjerner");
  });

  it("never lets a short name containment-match — no ⭐ on 'Barcelona Tapas' from 'Bar'", () => {
    expect(findSavedMatch("Barcelona Tapas", saved)).toBeUndefined();
  });

  it("folds the letters that do not decompose — ø/æ/œ transliterations match", () => {
    expect(findSavedMatch("Notteroy Bakeri", [place({ name: "Nøtterøy Bakeri", sourceList: "Vestfold" })])?.sourceList)
      .toBe("Vestfold");
    expect(findSavedMatch("Le Boeuf", [place({ name: "Le Bœuf", sourceList: "CdA" })])?.sourceList).toBe("CdA");
  });

  it("finds nothing in an empty store", () => {
    expect(findSavedMatch("Lucali", [])).toBeUndefined();
  });
});

describe("normalizePlaceName", () => {
  it("folds case, diacritics and punctuation to a comparable form", () => {
    expect(normalizePlaceName("Le Petit Nice — Passédat")).toBe("le petit nice passedat");
  });
});
