import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NoteNotFoundError,
  NotePathEscapesStoreError,
  resolveInStore,
  StorePathNotConfiguredError,
  StoreUnhealthyError,
  areaForStore,
  findBacklinks,
  listNotes,
  noteScope,
  readNote,
  searchNotes,
  storeForArea,
  storeRoot,
  storeRootForArea,
} from "../src/notes-store.js";

/**
 * The engine behind the Brain and Atlas hands. Both stores are the same thing — a directory
 * of markdown — so they share one implementation and differ only in which env var names
 * their root.
 *
 * Ported from the vault_search tests (Task 3) when the second store arrived, keeping every
 * case: the ORB-51 posture is the reason this file is long.
 */

let dir: string;

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env["VAULT_PATH"];
  delete process.env["ATLAS_PATH"];
});

function fixture(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), "eve-notes-"));
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

describe("storeRoot", () => {
  it("reads the env var that names the store", () => {
    dir = mkdtempSync(join(tmpdir(), "eve-notes-"));
    process.env["VAULT_PATH"] = dir;
    process.env["ATLAS_PATH"] = dir;
    expect(storeRoot("brain")).toBe(dir);
    expect(storeRoot("atlas")).toBe(dir);
  });

  it("throws a typed error naming the store when the env var is unset", () => {
    dir = mkdtempSync(join(tmpdir(), "eve-notes-"));
    // Distinct from StoreUnhealthyError on purpose: "you gave me no store" and "the store
    // you gave me is sick" need different fixes, and an LLM cannot guess which from a bare
    // Error.
    expect(() => storeRoot("brain")).toThrow(StorePathNotConfiguredError);
    expect(() => storeRoot("atlas")).toThrow(/ATLAS_PATH/);
  });
});

// W5C-s2 — the Vault's areas resolve to the two file stores that exist today (ADR-0017 rule 1,
// Owner decisions C1/C2/C4). `VAULT_PATH`/`ATLAS_PATH` keep their names; only what an agent is
// GRANTED changes.
describe("storeForArea / areaForStore / storeRootForArea", () => {
  it("maps the two areas that are file stores, and only those", () => {
    expect(storeForArea("private")).toBe("brain");
    expect(storeForArea("shared")).toBe("atlas");
    expect(storeForArea("taste")).toBeUndefined();
    expect(storeForArea("facts")).toBeUndefined();
    expect(areaForStore("brain")).toBe("private");
    expect(areaForStore("atlas")).toBe("shared");
  });

  it("reads the same env vars it always has", () => {
    process.env["VAULT_PATH"] = "/tmp/a";
    process.env["ATLAS_PATH"] = "/tmp/b";
    expect(storeRootForArea("private")).toBe("/tmp/a");
    expect(storeRootForArea("shared")).toBe("/tmp/b");
  });

  it("refuses an area with no store rather than guessing the personal one", () => {
    expect(() => storeRootForArea("facts")).toThrow(/facts/);
    expect(() => storeRootForArea("taste")).toThrow(/taste/);
  });
});

describe("listNotes", () => {
  it("walks nested directories and excludes .git/.obsidian and friends", () => {
    const root = fixture({
      "ventures/soma.md": "# SOMA\n\nHospitality venture, no repo.",
      ".git/decoy.md": "# must be excluded",
      ".obsidian/config.md": "# also excluded",
      "notes.txt": "not markdown",
    });
    expect(listNotes(root)).toEqual(["ventures/soma.md"]);
  });

  it("throws StoreUnhealthyError when the root holds no markdown anywhere", () => {
    // The ORB-51 posture. A store with no notes is a misconfigured mount, an empty clone or
    // a wrong path — never a legitimate answer. Returning [] here would make every query
    // look like a polite "nothing found".
    const root = fixture({ "notes.txt": "not markdown" });
    expect(() => listNotes(root)).toThrow(StoreUnhealthyError);
  });

  it("throws StoreUnhealthyError when the root does not exist at all", () => {
    const root = fixture({ "a.md": "x" });
    expect(() => listNotes(join(root, "does-not-exist"))).toThrow(StoreUnhealthyError);
  });
});

describe("searchNotes", () => {
  it("returns files matching every token", () => {
    const root = fixture({
      "vol-de-nuit-positioning.md": "# Vol de Nuit\n\nHospitality positioning notes.",
      "unrelated.md": "# Unrelated\n\nSomething else entirely.",
    });
    expect(searchNotes("Vol de Nuit positioning", root)).toEqual({
      hits: ["vol-de-nuit-positioning.md"],
      files: 2,
    });
  });

  it("falls back to any-token hits, ranked, when nothing matches every token", () => {
    const root = fixture({
      "a.md": "mentions vol only",
      "b.md": "mentions nuit only",
      "c.md": "mentions neither term",
    });
    const result = searchNotes("vol nuit", root);
    expect(result.hits.sort()).toEqual(["a.md", "b.md"]);
    expect(result.files).toBe(3);
  });

  it("distinguishes no-match from sick: empty hits, non-zero file count", () => {
    const root = fixture({ "a.md": "# something" });
    expect(searchNotes("zzzznonexistentquery", root)).toEqual({ hits: [], files: 1 });
  });

  it("matches Norwegian characters", () => {
    const root = fixture({ "møte.md": "# Møte med Ørjan\n\nkjøkken" });
    expect(searchNotes("møte kjøkken", root).hits).toEqual(["møte.md"]);
  });
});

describe("readNote", () => {
  it("returns the content of a note by its store-relative path", () => {
    const root = fixture({ "ventures/soma.md": "# SOMA\n\nHospitality.\n" });
    expect(readNote("ventures/soma.md", root)).toEqual({
      path: "ventures/soma.md",
      content: "# SOMA\n\nHospitality.\n",
      lines: 3,
    });
  });

  it("throws NoteNotFoundError for a path that is not there", () => {
    const root = fixture({ "a.md": "x" });
    // Not StoreUnhealthy: the store is fine, this note simply is not in it. She should
    // search again, not report the vault as broken.
    expect(() => readNote("nope.md", root)).toThrow(NoteNotFoundError);
  });

  it("still reports an unhealthy store rather than a missing note", () => {
    const root = fixture({ "notes.txt": "not markdown" });
    expect(() => readNote("a.md", root)).toThrow(StoreUnhealthyError);
  });

  it.each([
    ["traversal", "../../etc/passwd"],
    ["absolute", "/run/secrets/gateway-key"],
    ["sneaky traversal", "notes/../../../run/secrets/gateway-key"],
  ])("refuses a %s path", (_label, path) => {
    const root = fixture({ "a.md": "x" });
    expect(() => readNote(path, root)).toThrow(NotePathEscapesStoreError);
  });

  it("refuses a symlink that leaves the store", () => {
    // The store lives one level down so the "outside" file is still inside the temp tree
    // this test cleans up.
    const outer = fixture({ "outside.md": "secrets", "store/a.md": "x" });
    const root = join(outer, "store");
    symlinkSync(join(outer, "outside.md"), join(root, "link.md"));
    expect(() => readNote("link.md", root)).toThrow(NotePathEscapesStoreError);
  });
});

describe("findBacklinks", () => {
  it("finds notes that wikilink to the note, and excludes the note itself", () => {
    const root = fixture({
      "frameworks.md": "# Frameworks\n\nsee [[frameworks]] self-reference",
      "writing/craft.md": "Builds on [[frameworks]].",
      "ventures/soma.md": "Unrelated.",
    });
    expect(findBacklinks("frameworks.md", root)).toEqual({
      path: "frameworks.md",
      backlinks: ["writing/craft.md"],
      files: 3,
    });
  });

  it("matches aliased and heading-anchored wikilinks", () => {
    const root = fixture({
      "frameworks.md": "# Frameworks",
      "a.md": "[[frameworks|the frameworks note]]",
      "b.md": "[[frameworks#Section]]",
      "c.md": "[[frameworks-extended]] — a DIFFERENT note",
    });
    // c.md must not match: Obsidian treats [[frameworks-extended]] as another note, and a
    // naive substring check would report it as a backlink.
    expect(findBacklinks("frameworks.md", root).backlinks.sort()).toEqual(["a.md", "b.md"]);
  });

  it("treats a note name with regex metacharacters literally", () => {
    const root = fixture({
      "c++ (notes).md": "# C++",
      "a.md": "[[c++ (notes)]]",
      "b.md": "[[cxx notes]]",
    });
    // Unescaped, `c++ (notes)` is a regex that either throws or matches the wrong thing.
    expect(findBacklinks("c++ (notes).md", root).backlinks).toEqual(["a.md"]);
  });

  it("is case-insensitive, as Obsidian's links are", () => {
    const root = fixture({ "frameworks.md": "# F", "a.md": "[[Frameworks]]" });
    expect(findBacklinks("frameworks.md", root).backlinks).toEqual(["a.md"]);
  });

  it("returns an empty list for a note nothing links to, on a healthy store", () => {
    const root = fixture({ "lonely.md": "# Lonely", "a.md": "no links here" });
    expect(findBacklinks("lonely.md", root)).toEqual({
      path: "lonely.md",
      backlinks: [],
      files: 2,
    });
  });

  it("refuses a path that escapes the store", () => {
    const root = fixture({ "a.md": "x" });
    expect(() => findBacklinks("../../etc/passwd", root)).toThrow(NotePathEscapesStoreError);
  });
});

// ─── ORB-171 — _meta exclusion, the anchored fallback, and the content cache ───────────────
import { _contentCacheReadsForTests } from "../src/notes-store.js";
import { mkdtempSync as mkdtemp171, writeFileSync as write171, mkdirSync as mkdir171, utimesSync as utimes171 } from "node:fs";
import { tmpdir as tmpdir171 } from "node:os";
import { join as join171 } from "node:path";

function store171(files: Record<string, string>): string {
  const root = mkdtemp171(join171(tmpdir171(), "kit-notes-171-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join171(root, rel);
    mkdir171(join171(abs, ".."), { recursive: true });
    write171(abs, content);
  }
  return root;
}

describe("notes-store — _meta is not knowledge (ORB-171)", () => {
  it("listNotes and searchNotes never surface _meta/ — an agent's own transcripts are not the store", () => {
    const root = store171({
      "projects/zero7.md": "Zero7 positioning notes",
      "_meta/conversations/2026-08-30/x-telegram.md": "Bendik: tell me about Cyrus",
    });
    expect(listNotes(root)).toEqual(["projects/zero7.md"]);
    // The founding case: the only file containing the query is a conversation log. The honest
    // answer is nothing — not a citation of Saga's own transcript as Brain knowledge.
    expect(searchNotes("Cyrus", root).hits).toEqual([]);
  });
});

describe("notes-store — the anchored fallback (ORB-171)", () => {
  it("THE REGRESSION: 'atcyrus.com' returns NOTHING when the distinctive token is absent — never the `com` junk", () => {
    const root = store171({
      "_entities.md": "companies list — example.com and others",
      "_portfolio.md": "see also example.com",
      "icp/zero7.md": "icp notes mention .com domains",
    });
    // Old behaviour: all three hit on `com` alone. Anchor = `atcyrus` (df 0) → empty.
    expect(searchNotes("atcyrus.com", root).hits).toEqual([]);
  });

  it("the fallback still works when the distinctive token IS present somewhere", () => {
    const root = store171({
      "notes/positioning.md": "Vol positioning draft",
      "notes/junk.md": "de de de common words only",
    });
    // Both tokens present somewhere (df 1 each) → both are anchors; only files carrying at
    // least one anchor come back, ranked. The junk file carrying neither never appears.
    expect(searchNotes("vol positioning", root).hits).toEqual(["notes/positioning.md"]);
  });

  it("all-tokens matches are unaffected by the anchor rule", () => {
    const root = store171({ "a.md": "vol de nuit positioning complete" });
    expect(searchNotes("vol de nuit positioning", root).hits).toEqual(["a.md"]);
  });
});

describe("notes-store — the content cache (ORB-171)", () => {
  it("a repeat search does not re-read unchanged files; a touched file is re-read", () => {
    const root = store171({ "a.md": "alpha content", "b.md": "beta content" });
    searchNotes("alpha", root);
    const afterFirst = _contentCacheReadsForTests();
    searchNotes("beta", root); // same files, warm cache
    expect(_contentCacheReadsForTests()).toBe(afterFirst);

    // modify a file with a NEWER mtime → exactly one re-read
    const abs = join171(root, "a.md");
    write171(abs, "alpha content v2");
    utimes171(abs, new Date(), new Date(Date.now() + 5000));
    searchNotes("alpha", root);
    expect(_contentCacheReadsForTests()).toBe(afterFirst + 1);
    expect(searchNotes("v2", root).hits).toEqual(["a.md"]);
  });
});

// ORB-153 (3) — in-store dotfile directories are not notes. `resolveInStore` refused absolute
// paths, `..` traversal and symlink escape, but not `.git/` or `.locks/` INSIDE the store. No
// live exposure today (no tool takes a model-supplied write path; drop/file route through
// `git rm`/`git mv`, which refuse `.git/`), so this is defence in depth against a future tool —
// closed while it is cheap, and written down so nobody has to re-derive why it was safe.
describe("resolveInStore refuses in-store dotfile paths (ORB-153)", () => {
  const root = mkdtempSync(join(tmpdir(), "notes-store-dotfiles-"));

  it("rejects every path with a segment that starts with a dot", () => {
    for (const p of [".git/config", ".git/hooks/pre-commit", ".locks/inbox.lock", "notes/.hidden.md", "_inbox/.DS_Store", "."]) {
      expect(() => resolveInStore(p, root), p).toThrow(NotePathEscapesStoreError);
    }
  });

  it("still resolves ordinary note paths, including underscore folders and dots inside a name", () => {
    expect(resolveInStore("_inbox/2026-09-03-kenneth.md", root)).toBe(join(root, "_inbox", "2026-09-03-kenneth.md"));
    expect(resolveInStore("ventures/zero7.v2.md", root)).toBe(join(root, "ventures", "zero7.v2.md"));
  });
});

describe("noteScope and CRLF", () => {
  const body = "---\nscope: private\nowner: fixture-owner\nparticipants: [a, b]\n---\n\nbody\n";

  it("reads a declared scope out of an LF note (unchanged)", () => {
    expect(noteScope(body, "atlas")).toEqual({ scope: "private", participants: ["a", "b"], owner: "fixture-owner" });
  });

  it("no longer widens a CRLF-saved private note to the atlas default", () => {
    const crlf = body.replace(/\n/g, "\r\n");
    expect(noteScope(crlf, "atlas")).toEqual({ scope: "private", participants: ["a", "b"], owner: "fixture-owner" });
  });

  it("still falls back to the store default when the value is absent or unknown", () => {
    expect(noteScope("---\r\ntitle: x\r\n---\r\n", "atlas").scope).toBe("org");
    expect(noteScope("---\r\nscope: everyone\r\n---\r\n", "brain").scope).toBe("private");
  });

  it("still falls back when there is no frontmatter at all", () => {
    expect(noteScope("no frontmatter", "atlas").scope).toBe("org");
  });
});
