// Tests for the console's read/write layer over /srv/taste (ORB-99).
// Hermetic: a real temp directory stands in for the mount, so nothing here touches the box.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { parseTakeoutCsv } from "@lares/taste/takeout";
import type { PlaceEntry } from "@lares/taste";

import {
  assertDomain,
  assertSafeFilename,
  deleteEntry,
  listAll,
  listDomain,
  parsePastedLines,
  tasteRoot,
  writeEntries,
} from "../lib/taste-store";

const CSV = [
  "Tittel,Notat,URL",
  '"Lucali","Cash only","https://maps.google.com/?@40.6810,-73.9985"',
  '"Katz\'s Delicatessen",,"https://maps.google.com/?q=40.7223,-73.9874"',
  "",
].join("\n");

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "console-taste-"));
  process.env.TASTE_ROOT = root;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.TASTE_ROOT;
});

describe("where the store lives", () => {
  it("reads TASTE_ROOT, and falls back to the mount path the compose block sets", () => {
    expect(tasteRoot()).toBe(root);
    delete process.env.TASTE_ROOT;
    expect(tasteRoot()).toBe("/srv/taste");
  });
});

describe("writing entries", () => {
  it("puts each type in the folder its domain names", () => {
    writeEntries([
      { type: "place", name: "Lucali", sourceList: "NYC 2026" },
      { type: "playlist", name: "Sommer", items: ["a", "b"] },
      { type: "dish", name: "Cacio e pepe", items: ["pasta"] },
      { type: "note", name: "Ting", items: ["x"] },
    ]);
    expect(fs.readdirSync(path.join(root, "places"))).toEqual(["nyc-2026--lucali.md"]);
    expect(fs.readdirSync(path.join(root, "music"))).toEqual(["sommer.md"]);
    expect(fs.readdirSync(path.join(root, "food"))).toEqual(["cacio-e-pepe.md"]);
    expect(fs.readdirSync(path.join(root, "notes"))).toEqual(["ting.md"]);
  });

  it("creates the domain folder when the store is bare", () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root);
    expect(writeEntries([{ type: "place", name: "Lucali" }]).added).toBe(1);
  });

  it("counts a re-write of the same entry as replaced, not added", () => {
    const entry: PlaceEntry = { type: "place", name: "Lucali", sourceList: "NYC 2026" };
    expect(writeEntries([entry])).toMatchObject({ added: 1, replaced: 0 });
    expect(writeEntries([{ ...entry, note: "endret" }])).toMatchObject({ added: 0, replaced: 1 });
    expect(fs.readdirSync(path.join(root, "places"))).toHaveLength(1);
  });

  it("reports an entry it cannot name instead of failing the whole import", () => {
    const result = writeEntries([
      { type: "place", name: "、。" },
      { type: "place", name: "Lucali" },
    ]);
    expect(result.added).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].name).toBe("、。");
  });
});

describe("re-importing a real Takeout list", () => {
  it("creates no duplicates the second time", () => {
    const first = writeEntries(parseTakeoutCsv(CSV, "NYC 2026"));
    expect(first).toMatchObject({ added: 2, replaced: 0 });

    const second = writeEntries(parseTakeoutCsv(CSV, "NYC 2026"));
    expect(second).toMatchObject({ added: 0, replaced: 2 });
    expect(fs.readdirSync(path.join(root, "places"))).toHaveLength(2);
  });

  it("keeps the same place saved under two different list names as two entries", () => {
    writeEntries(parseTakeoutCsv(CSV, "NYC 2026"));
    writeEntries(parseTakeoutCsv(CSV, "Pizza"));
    expect(fs.readdirSync(path.join(root, "places"))).toHaveLength(4);
  });

  it("round-trips coordinates through the store", () => {
    writeEntries(parseTakeoutCsv(CSV, "NYC 2026"));
    const stored = listDomain("places").find((e) => e.entry?.name === "Lucali");
    expect(stored!.entry).toMatchObject({ lat: 40.681, lon: -73.9985, sourceList: "NYC 2026" });
  });
});

describe("reading the store", () => {
  it("answers empty for a store that is not mounted yet", () => {
    process.env.TASTE_ROOT = path.join(root, "nope");
    expect(listDomain("places")).toEqual([]);
    expect(listAll().music).toEqual([]);
  });

  it("surfaces an unparseable file rather than hiding or throwing on it", () => {
    fs.mkdirSync(path.join(root, "places"), { recursive: true });
    fs.writeFileSync(path.join(root, "places", "broken.md"), "no frontmatter here\n");
    const [stored] = listDomain("places");
    expect(stored.entry).toBeNull();
    expect(stored.error).toMatch(/frontmatter/i);
  });

  it("ignores non-markdown files sitting in the folder", () => {
    fs.mkdirSync(path.join(root, "places"), { recursive: true });
    fs.writeFileSync(path.join(root, "places", "notes.txt"), "hei");
    expect(listDomain("places")).toEqual([]);
  });
});

describe("deleting", () => {
  it("removes the file", () => {
    writeEntries([{ type: "place", name: "Lucali" }]);
    expect(deleteEntry("places", "lucali.md")).toBe(true);
    expect(listDomain("places")).toEqual([]);
  });

  it("answers false for a file that is already gone", () => {
    expect(deleteEntry("places", "lucali.md")).toBe(false);
  });

  it("refuses a path that would escape the store", () => {
    for (const bad of ["../../etc/passwd", "../secret.md", "a/b.md", "/etc/passwd", ".md", "x.txt"]) {
      expect(() => assertSafeFilename(bad)).toThrow(/unsafe/i);
    }
    expect(() => assertSafeFilename("nyc-2026--lucali.md")).not.toThrow();
  });

  it("refuses an unknown domain", () => {
    expect(() => assertDomain("../..")).toThrow(/unknown domain/i);
    expect(() => assertDomain("secrets")).toThrow(/unknown domain/i);
    expect(assertDomain("places")).toBe("places");
  });
});

describe("pasted text", () => {
  it("reads bulleted, numbered and bare lines as the same list", () => {
    expect(parsePastedLines("- one\n* two\n3. three\n• four\nfive\n")).toEqual([
      "one", "two", "three", "four", "five",
    ]);
  });

  it("drops blank lines and surrounding whitespace", () => {
    expect(parsePastedLines("\n  one  \n\n\n  two\n  \n")).toEqual(["one", "two"]);
  });

  it("finds nothing in empty or whitespace-only text", () => {
    expect(parsePastedLines("")).toEqual([]);
    expect(parsePastedLines("   \n\n  ")).toEqual([]);
  });

  it("keeps a bullet that is part of the text rather than the list marker", () => {
    expect(parsePastedLines("Nick Drake — Pink Moon")).toEqual(["Nick Drake — Pink Moon"]);
  });
});
