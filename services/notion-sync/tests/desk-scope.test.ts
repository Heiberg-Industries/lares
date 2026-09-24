// The exclusion itself (Phase 4, `deskDirs[].exclude`): the predicate every
// scope boundary shares, and the push side end to end — a real vault tree, the
// real adapter, the real engine — because that side is HOW the transcripts became
// Docs pages in the first place. The pull side's proof lives with the pull engine
// it protects (pull-sync.test.ts).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUnderDir, makeDeskExclusion, makeCreateScope, withoutExcluded } from "../lib/desk-scope.js";
import { makeVaultFiles } from "../lib/adapters/vault-files.js";
import { runWikiSync, type WikiSyncDeps, type WikiDocProps } from "../lib/wiki-sync.js";
import { parseNotionSyncConfig } from "../lib/config.js";
import type { DesksConfig } from "../lib/types.js";
import type { DocRow, DocSyncedInput } from "../lib/store.js";

const DESKS: DesksConfig = {
  deskDirs: [
    { dir: "desk-a", project: "A", exclude: ["transcripts"] },
    { dir: "desk-b", project: "B" },
  ],
  twoWayDirs: [],
  mirrorFilePrefixes: [],
};

// Where a CREATE may land (Phase 4, T3b fix round 1). Shape is not scope: T6 reads
// the folder half of a create's path from a Notion `Folder` property, so without
// this a well-formed `personal/x.md` would be created and tracked in a folder no
// pass was ever configured to sync.
describe("makeCreateScope", () => {
  const inScope = makeCreateScope({ desks: DESKS });

  it("accepts a path inside a configured desk dir", () => {
    expect(inScope("desk-a/note.md")).toBe(true);
    expect(inScope("desk-b/deep/nested/note.md")).toBe(true);
  });

  it("refuses a path under no desk dir at all", () => {
    expect(inScope("personal/secrets.md")).toBe(false);
    expect(inScope("note.md")).toBe(false);
  });

  // Segment matching, inherited from isUnderDir — the same trap the exclusion has.
  it("refuses a folder that merely starts with a desk dir's name", () => {
    expect(inScope("desk-a-drafts/note.md")).toBe(false);
    expect(inScope("desk-abc/note.md")).toBe(false);
  });

  it("refuses a carved-out sub-path when no transcripts pass is configured", () => {
    expect(inScope("desk-a/transcripts/2026-08-01-foo.md")).toBe(false);
  });

  // THE exception, and it is not an afterthought: T4's transcripts live at exactly
  // the sub-path T2 carved out of the DESK passes, so that the transcript pass can
  // own it one-way. Applying the exclusion here without this would refuse every
  // transcript this whole mechanism was built to create.
  it("accepts the transcripts folder once the transcripts pass IS configured", () => {
    const withTranscripts = makeCreateScope({
      desks: DESKS,
      transcripts: { dir: "transcripts", projects: [] },
    });
    expect(withTranscripts("desk-a/transcripts/2026-08-01-foo.md")).toBe(true);
    // …and only that carve-out. Another excluded folder stays refused.
    const twoExcludes = makeCreateScope({
      desks: {
        ...DESKS,
        deskDirs: [{ dir: "desk-a", project: "A", exclude: ["transcripts", "scratch"] }],
      },
      transcripts: { dir: "transcripts", projects: [] },
    });
    expect(twoExcludes("desk-a/transcripts/x.md")).toBe(true);
    expect(twoExcludes("desk-a/scratch/x.md")).toBe(false);
  });

  it("refuses everything when no desk folders are configured — deploy-ahead-of-env", () => {
    const none = makeCreateScope({});
    expect(none("desk-a/note.md")).toBe(false);
    expect(none("anything.md")).toBe(false);
  });
});

describe("makeDeskExclusion", () => {
  const isExcluded = makeDeskExclusion(DESKS);

  it("excludes a file inside the carved-out folder", () => {
    expect(isExcluded("desk-a/transcripts/2026-08-01-foo.md")).toBe(true);
    expect(isExcluded("desk-a/transcripts/deeper/foo.md")).toBe(true);
  });

  it("excludes the carved-out folder path itself — what a directory walk tests", () => {
    expect(isExcluded("desk-a/transcripts")).toBe(true);
  });

  it("does NOT exclude a file merely NAMED like the folder", () => {
    // The trap a naked startsWith() falls into: this is a note ABOUT transcripts
    // sitting in the desk root, and it is still the desk's.
    expect(isExcluded("desk-a/transcripts.md")).toBe(false);
  });

  it("does NOT exclude a sibling folder whose name merely starts with it", () => {
    expect(isExcluded("desk-a/transcriptsfoo/a.md")).toBe(false);
  });

  it("does NOT exclude the same folder name nested deeper — the entry is anchored", () => {
    // An exclude entry is a path relative to its desk dir's ROOT (types.ts), so it
    // names one branch. A floating match would mean a folder name silently changes
    // what syncs wherever it appears, which is neither configurable nor guessable
    // from reading the config file.
    expect(isExcluded("desk-a/a/transcripts/b.md")).toBe(false);
  });

  it("carves nothing out of a desk dir that lists no exclusions", () => {
    // Same sub-path, different dir: it is the CONFIG that excludes a path, never
    // the folder's name.
    expect(isExcluded("desk-b/transcripts/2026-08-01-foo.md")).toBe(false);
  });

  it("answers false for a path under no desk dir at all", () => {
    // Not "in scope" — this predicate only ever reports what config carved OUT.
    // Wiki mirror rows live outside every desk dir and must keep syncing, so the
    // honest answer for anything the exclude lists do not name is false.
    expect(isExcluded("wiki/alpha.md")).toBe(false);
    expect(isExcluded("transcripts/loose.md")).toBe(false);
  });

  it("excludes nothing when no desk folders are configured", () => {
    const none = makeDeskExclusion(undefined);
    expect(none("desk-a/transcripts/2026-08-01-foo.md")).toBe(false);
  });

  it("takes a nested entry, and covers only that branch", () => {
    const nested = makeDeskExclusion({
      deskDirs: [{ dir: "desk-a", project: "A", exclude: ["notes/transcripts"] }],
      twoWayDirs: [], mirrorFilePrefixes: [],
    });
    expect(nested("desk-a/notes/transcripts/b.md")).toBe(true);
    expect(nested("desk-a/notes/other.md")).toBe(false);
    expect(nested("desk-a/transcripts/b.md")).toBe(false);
  });

  it("reads the exclusion straight off a parsed config file", () => {
    // The whole chain in one assertion: raw config → parser (T1) → predicate.
    const cfg = parseNotionSyncConfig({
      notionVersion: "2026-03-11",
      meetingsDataSourceId: "27fcc987-b457-8092-830c-000b13ab5b0b",
      vaultPath: "/srv/vault",
      selfEmail: "owner@example.com",
      projects: [{ notionProject: "A", vaultFolder: "desk-a" }],
      docsDataSourceId: "ds-docs",
      wikiProject: "Portfolio",
      deskDirs: [{ dir: "desk-a", project: "A", exclude: ["transcripts"] }],
    });
    const isExcludedFromFile = makeDeskExclusion(cfg.desks);
    expect(isExcludedFromFile("desk-a/transcripts/2026-08-01-foo.md")).toBe(true);
    expect(isExcludedFromFile("desk-a/note.md")).toBe(false);
  });
});

describe("isUnderDir", () => {
  it("matches by path segment, in both the equal and the descendant case", () => {
    expect(isUnderDir("a", "a")).toBe(true);
    expect(isUnderDir("a/b.md", "a")).toBe(true);
    expect(isUnderDir("ab/c.md", "a")).toBe(false);
    expect(isUnderDir("a.md", "a")).toBe(false);
    expect(isUnderDir("a", "a/b")).toBe(false);
  });
});

describe("withoutExcluded", () => {
  it("drops the excluded keys, keeps the rest, and leaves the caller's map alone", () => {
    const rows = new Map([
      ["desk-a/note.md", 1],
      ["desk-a/transcripts/foo.md", 2],
      ["wiki/alpha.md", 3],
    ]);
    const kept = withoutExcluded(rows, makeDeskExclusion(DESKS));

    expect([...kept.keys()]).toEqual(["desk-a/note.md", "wiki/alpha.md"]);
    expect(rows.size).toBe(3);
  });
});

// ── The push side, end to end ────────────────────────────────────────────────

/**
 * How the 32 transcripts became Docs rows in Phase 3: the desk push runs the wiki
 * engine once per desk folder, and the adapter's walk recurses the WHOLE subtree —
 * so `transcripts/…md` arrived in the listing and got a page like any other note.
 * This drives the real adapter and the real engine over a real vault tree, because
 * a fake listing would prove nothing about the walk that caused it.
 */
describe("the desk push with an exclusion (real vault, real adapter, real engine)", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "notion-sync-desk-scope-"));
    await mkdir(join(root, "desk-a", "transcripts"), { recursive: true });
    await writeFile(join(root, "desk-a", "note.md"), "# Note\n\nbody\n");
    await writeFile(join(root, "desk-a", "transcripts", "2026-08-01-foo.md"), "# Foo\n\ntranscript\n");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function makeDeps(rows: Array<[string, DocRow]> = []) {
    const created: Array<{ props: WikiDocProps; markdown: string }> = [];
    const propUpdates: Array<{ pageId: string; props: Partial<WikiDocProps> }> = [];
    const upserts: DocSyncedInput[] = [];
    const orphaned: string[] = [];
    const vault = makeVaultFiles({ vaultPath: root, wikiDir: "desk-a", exclude: ["transcripts"] });
    let nextId = 1;
    const impl: WikiSyncDeps = {
      listWikiFiles: vault.listWikiFiles,
      readWikiFile: vault.readWikiFile,
      getDocRows: async () => new Map(rows),
      queryDocs: async () => [],
      createDocPage: async (props, markdown) => {
        created.push({ props, markdown });
        return { pageId: `page-${nextId++}` };
      },
      patchPageMarkdown: async () => {},
      updateDocProps: async (pageId, props) => { propUpdates.push({ pageId, props }); },
      getPageMarkdown: async (pageId) => `notion:${pageId}`,
      upsertDocSynced: async (doc) => { upserts.push(doc); },
      recordDocError: async () => {},
      markDocOrphaned: async (vaultPath) => { orphaned.push(vaultPath); },
    };
    return { impl, created, propUpdates, upserts, orphaned };
  }

  const OPTS = {
    wikiDir: "desk-a",
    project: "A",
    dryRun: false,
    isExcluded: makeDeskExclusion(DESKS),
  };

  it("creates a page for the desk note and NOTHING for the excluded transcript", async () => {
    const d = makeDeps();
    const res = await runWikiSync(OPTS, d.impl);

    expect(d.created.map((c) => c.props.vaultPath)).toEqual(["desk-a/note.md"]);
    expect(d.upserts.map((u) => u.vaultPath)).toEqual(["desk-a/note.md"]);
    expect(res).toMatchObject({ scanned: 1, created: 1, errored: 0 });
  });

  it("creates the transcript's page when nothing is excluded — the control", async () => {
    // Exactly the Phase 3 behaviour that produced the 32 rows. Without this the
    // test above would also pass for a vault the walk simply could not read.
    const vault = makeVaultFiles({ vaultPath: root, wikiDir: "desk-a" });
    const d = makeDeps();
    const res = await runWikiSync(
      { wikiDir: "desk-a", project: "A", dryRun: false },
      { ...d.impl, listWikiFiles: vault.listWikiFiles, readWikiFile: vault.readWikiFile },
    );

    expect(d.created.map((c) => c.props.vaultPath).sort())
      .toEqual(["desk-a/note.md", "desk-a/transcripts/2026-08-01-foo.md"]);
    expect(res.created).toBe(2);
  });

  it("leaves an already-synced excluded row exactly as it found it", async () => {
    // The state this ships into: the excluded rows already exist, synced, from the
    // passes that created them by mistake. The exclusion must make the desk push
    // blind to them — NOT read their absence from the pruned listing as a deletion
    // and retire the pages (which is what the row-side half prevents). Removing
    // those rows is a separate, deliberate act.
    const d = makeDeps([
      ["desk-a/transcripts/2026-08-01-foo.md", { pageId: "p-transcript", mdHash: "h", state: "synced" }],
    ]);
    const res = await runWikiSync(OPTS, d.impl);

    expect(d.propUpdates).toEqual([]);
    expect(d.orphaned).toEqual([]);
    expect(res.archived).toBe(0);
    // …while the note beside it still syncs normally.
    expect(res.created).toBe(1);
  });
});
