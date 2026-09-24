import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { makeVaultFiles, makeVaultWalk } from "../lib/adapters/vault-files.js";

/**
 * Is the filesystem the temp directory lives on case-SENSITIVE? Probed once, at load,
 * with real syscalls — there is no portable way to ask, and guessing from `platform`
 * is wrong on both sides (a Mac can mount a case-sensitive APFS volume; a Linux box
 * can mount a case-insensitive one).
 *
 * It gates ONE test, whose premise — two directories differing only in case — the
 * filesystem itself has to be able to represent. `it.skipIf` rather than an early
 * `return`, so the reporter says "skipped" instead of claiming a pass for coverage
 * that did not run.
 */
const TMPDIR_IS_CASE_SENSITIVE = (() => {
  const probe = mkdtempSync(join(tmpdir(), "notion-sync-case-probe-"));
  try {
    mkdirSync(join(probe, "Aa"));
    mkdirSync(join(probe, "aa"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();


// A real (temporary) directory tree, not a stubbed fs: the adapter IS the fs
// boundary, so the walk's conventions — dotfiles skipped, .md only, relative
// "/"-joined paths — are exactly what these tests must pin against reality.
let vaultPath: string;

beforeAll(async () => {
  vaultPath = await mkdtemp(join(tmpdir(), "notion-sync-vault-"));
  const wiki = join(vaultPath, "wiki");
  await mkdir(join(wiki, "people"), { recursive: true });
  await mkdir(join(wiki, "companies", ".cache"), { recursive: true });
  await mkdir(join(wiki, ".obsidian"), { recursive: true });
  await writeFile(join(wiki, "README.md"), "# Wiki\n");
  await writeFile(join(wiki, "people", "jane.md"), "# Jane\n\nhi");
  await writeFile(join(wiki, "companies", "acme.MD"), "# Acme\n");
  await writeFile(join(wiki, "notes.txt"), "not markdown");
  await writeFile(join(wiki, ".hidden.md"), "dotfile");
  await writeFile(join(wiki, ".obsidian", "workspace.md"), "editor state");
  await writeFile(join(wiki, "companies", ".cache", "x.md"), "tool droppings");
  // Outside wikiDir — must never be listed.
  await writeFile(join(vaultPath, "outside.md"), "# outside\n");
});

afterAll(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

describe("makeVaultFiles", () => {
  it("lists only .md files under wikiDir, as relative '/'-joined paths, skipping dotfiles and dot-directories", async () => {
    const vault = makeVaultFiles({ vaultPath, wikiDir: "wiki" });
    const files = await vault.listWikiFiles();
    expect([...files].sort()).toEqual(["README.md", "companies/acme.MD", "people/jane.md"]);
  });

  it("reads a file utf8 by its wikiDir-relative path", async () => {
    const vault = makeVaultFiles({ vaultPath, wikiDir: "wiki" });
    expect(await vault.readWikiFile("people/jane.md")).toBe("# Jane\n\nhi");
  });

  it("rejects when the wiki directory does not exist — a missing mount must be loud, not an empty listing", async () => {
    const vault = makeVaultFiles({ vaultPath, wikiDir: "no-such-dir" });
    await expect(vault.listWikiFiles()).rejects.toThrow(/ENOENT/);
  });
});

describe("makeVaultFiles — exclude (Phase 4 deskDirs[].exclude)", () => {
  let root: string;

  beforeAll(async () => {
    // Every trap the exclusion has to survive, as real files: a folder that IS
    // excluded, a note merely NAMED like it, a sibling folder whose name merely
    // STARTS with it, and the same name nested one level down.
    root = await mkdtemp(join(tmpdir(), "notion-sync-exclude-vault-"));
    const desk = join(root, "desk");
    await mkdir(join(desk, "transcripts"), { recursive: true });
    await mkdir(join(desk, "transcriptsfoo"), { recursive: true });
    await mkdir(join(desk, "notes", "transcripts"), { recursive: true });
    await mkdir(join(desk, "raw", "scratch"), { recursive: true });
    await writeFile(join(desk, "note.md"), "# Note\n");
    await writeFile(join(desk, "transcripts.md"), "# A note about transcripts\n");
    await writeFile(join(desk, "transcripts", "2026-08-01-foo.md"), "# Foo\n");
    await writeFile(join(desk, "transcriptsfoo", "a.md"), "# A\n");
    await writeFile(join(desk, "notes", "transcripts", "b.md"), "# B\n");
    await writeFile(join(desk, "raw", "scratch", "c.md"), "# C\n");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists everything when no exclusion is configured — today's behaviour, unchanged", async () => {
    const vault = makeVaultFiles({ vaultPath: root, wikiDir: "desk" });
    expect([...await vault.listWikiFiles()].sort()).toEqual([
      "note.md",
      "notes/transcripts/b.md",
      "raw/scratch/c.md",
      "transcripts.md",
      "transcripts/2026-08-01-foo.md",
      "transcriptsfoo/a.md",
    ]);
  });

  it("prunes the excluded sub-tree and nothing that merely looks like it", async () => {
    const vault = makeVaultFiles({ vaultPath: root, wikiDir: "desk", exclude: ["transcripts"] });
    const files = [...await vault.listWikiFiles()].sort();

    expect(files).not.toContain("transcripts/2026-08-01-foo.md");
    // A file NAMED like the folder, a folder whose name starts with it, and the
    // same name one level down are all still the desk's — an exclude entry is a
    // path anchored at the desk root, not a substring and not a floating match.
    expect(files).toEqual([
      "note.md",
      "notes/transcripts/b.md",
      "raw/scratch/c.md",
      "transcripts.md",
      "transcriptsfoo/a.md",
    ]);
  });

  it("takes a nested entry, and excludes only that branch", async () => {
    const vault = makeVaultFiles({ vaultPath: root, wikiDir: "desk", exclude: ["notes/transcripts"] });
    const files = [...await vault.listWikiFiles()].sort();

    expect(files).not.toContain("notes/transcripts/b.md");
    expect(files).toContain("transcripts/2026-08-01-foo.md");
  });

  it("takes several entries at once", async () => {
    const vault = makeVaultFiles({
      vaultPath: root, wikiDir: "desk", exclude: ["transcripts", "raw"],
    });
    expect([...await vault.listWikiFiles()].sort()).toEqual([
      "note.md",
      "notes/transcripts/b.md",
      "transcripts.md",
      "transcriptsfoo/a.md",
    ]);
  });
});

describe("makeVaultWalk — the fidelity gate's whole-vault walk", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "notion-sync-fidelity-vault-"));
    await mkdir(join(root, "wiki", "people"), { recursive: true });
    await mkdir(join(root, "desks", "orakel"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, ".locks"), { recursive: true });
    await mkdir(join(root, ".trash"), { recursive: true });
    await mkdir(join(root, ".obsidian"), { recursive: true });
    await mkdir(join(root, ".claude"), { recursive: true });
    await mkdir(join(root, "node_modules"), { recursive: true });
    await mkdir(join(root, "_archive"), { recursive: true });
    await writeFile(join(root, "wiki", "README.md"), "# Wiki\n");
    await writeFile(join(root, "wiki", "people", "jane.md"), "# Jane\n");
    await writeFile(join(root, "desks", "orakel", "note.md"), "# Note\n");
    await writeFile(join(root, ".git", "excluded.md"), "must not appear");
    await writeFile(join(root, ".locks", "excluded.md"), "must not appear");
    await writeFile(join(root, ".trash", "excluded.md"), "must not appear");
    await writeFile(join(root, ".obsidian", "excluded.md"), "must not appear");
    await writeFile(join(root, ".claude", "excluded.md"), "must not appear");
    await writeFile(join(root, "node_modules", "excluded.md"), "must not appear");
    await writeFile(join(root, "_archive", "excluded.md"), "must not appear");
    await writeFile(join(root, "not-markdown.txt"), "ignored, wrong extension");
    // A single dotfile that is NOT one of the excluded directory names — the
    // fidelity walk mirrors brain-source.ts's walkMd (exclude by directory name),
    // not makeVaultFiles's blanket "skip every dotfile" rule.
    await writeFile(join(root, ".hidden.md"), "a visible-to-the-walk dotfile");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists .md files across the whole vault root, not scoped to one dir", async () => {
    const vault = makeVaultWalk({ vaultPath: root });
    const files = await vault.listAllFiles();
    expect([...files].sort()).toEqual([
      ".hidden.md",
      "desks/orakel/note.md",
      "wiki/README.md",
      "wiki/people/jane.md",
    ]);
  });

  // Guard 3b's input (T6 review rounds 2–3). Deliberately NOT the whole-vault walk:
  // it runs per approved create, so it resolves the target's ancestry and lists that,
  // which is O(depth) readdirs rather than a walk.
  describe("listCollisionCandidates", () => {
    it("returns vault-relative PATHS of every entry beside the target — directories and non-markdown too", async () => {
      const vault = makeVaultWalk({ vaultPath: root });
      const paths = await vault.listCollisionCandidates("wiki/README.md");
      // Paths, not basenames, so the engine compares whole paths exactly as the
      // propose side does. And a DIRECTORY called `People.md` would collide with a
      // file `people.md` on APFS, so nothing is filtered by kind or extension.
      expect([...paths].sort()).toEqual(["wiki/README.md", "wiki/people"]);
    });

    it("is [] when the ancestry exists in NO spelling — the ordinary create-into-a-new-folder case", async () => {
      const vault = makeVaultWalk({ vaultPath: root });
      expect(await vault.listCollisionCandidates("brand/new/folder/note.md")).toEqual([]);
    });

    it("does not walk: a file nested deeper is not a candidate", async () => {
      const vault = makeVaultWalk({ vaultPath: root });
      expect(await vault.listCollisionCandidates("wiki/README.md")).not.toContain("wiki/people/jane.md");
    });

    // ROUND 3's Important 1, at the adapter. Round 2 read the LITERAL parent, so a
    // target under `wiki/People/` found nothing beside `wiki/people/` and the create
    // landed — two directories on the box, one on the Mac.
    it("resolves an ancestor directory that differs only by CASE", async () => {
      const vault = makeVaultWalk({ vaultPath: root });
      const paths = await vault.listCollisionCandidates("WIKI/PEOPLE/jane.md");
      expect(paths).toContain("wiki/people/jane.md");
    });

    // A case-sensitive filesystem can hold both spellings, and only one of them may
    // hold the colliding file — so picking the first would be a coin flip on a
    // security guard.
    //
    // EXPLICITLY skipped where the filesystem cannot represent the premise (round 4,
    // Minor), rather than `return`ing mid-body and reporting as a pass. On a
    // case-insensitive Mac the old shape claimed coverage it did not have: it stayed
    // green under the literal-parent mutation, which is precisely the mutation it
    // exists to kill. `TMPDIR` on a case-sensitive volume runs it for real; the box
    // is Linux and always does.
    it.skipIf(!TMPDIR_IS_CASE_SENSITIVE)(
      "follows EVERY colliding spelling of an ancestor, not just the first",
      async () => {
        const both = await mkdtemp(join(tmpdir(), "notion-sync-both-"));
        try {
          await mkdir(join(both, "Prosjekt"), { recursive: true });
          await mkdir(join(both, "prosjekt"));
          await writeFile(join(both, "Prosjekt", "notat.md"), "his\n");
          const vault = makeVaultWalk({ vaultPath: both });
          expect(await vault.listCollisionCandidates("prosjekt/notat.md"))
            .toContain("Prosjekt/notat.md");
        } finally {
          await rm(both, { recursive: true, force: true });
        }
      },
    );
  });

  it("excludes .git .locks .trash .obsidian .claude node_modules _archive", async () => {
    const vault = makeVaultWalk({ vaultPath: root });
    const files = await vault.listAllFiles();
    for (const excluded of [".git", ".locks", ".trash", ".obsidian", ".claude", "node_modules", "_archive"]) {
      expect(files.some((f) => f.startsWith(`${excluded}/`))).toBe(false);
    }
  });

  it("reads a file utf8 by its vault-root-relative path", async () => {
    const vault = makeVaultWalk({ vaultPath: root });
    expect(await vault.readVaultFile("desks/orakel/note.md")).toBe("# Note\n");
  });
});
