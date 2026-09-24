import { describe, it, expect, vi } from "vitest";
import {
  runWikiSync, sha256, wikiRenderHash, notionPageUrl,
  type WikiSyncDeps, type WikiSyncOptions, type WikiDocProps, type RemoteDocRow,
} from "../lib/wiki-sync.js";
import { makeDeskExclusion } from "../lib/desk-scope.js";
import type { DocRow, DocSyncedInput } from "../lib/store.js";

const OPTS: WikiSyncOptions = { wikiDir: "wiki", project: "Portfolio", dryRun: false };

// Renders to itself: one H1, one blank, one body line — no wikilinks, no callouts.
const ALPHA_SRC = "# Alpha\n\nbody";
const ALPHA_MD = "# Alpha\n\nbody";
// The stored change-detection hash covers the prop-bearing outputs too, not just
// the markdown — a title/frontmatter-only edit must not skip (see wikiRenderHash).
const ALPHA_HASH = wikiRenderHash({ markdown: ALPHA_MD, title: "Alpha", frontmatter: "" });

function makeDeps(cfg: {
  files: string[];
  sources: Record<string, string>;
  rows?: Array<[string, DocRow]>;
  remote?: RemoteDocRow[];
}) {
  const calls: string[] = [];
  const created: Array<{ props: WikiDocProps; markdown: string }> = [];
  const patchedPages: Array<{ pageId: string; markdown: string }> = [];
  const propUpdates: Array<{ pageId: string; props: Partial<WikiDocProps> }> = [];
  const upserts: DocSyncedInput[] = [];
  const errors: Array<{ vaultPath: string; message: string }> = [];
  const orphaned: Array<{ vaultPath: string; reason: string }> = [];
  let nextId = 1;
  const impl: WikiSyncDeps = {
    listWikiFiles: async () => cfg.files,
    readWikiFile: async (relPath) => {
      const source = cfg.sources[relPath];
      if (source === undefined) throw new Error(`ENOENT: ${relPath}`);
      return source;
    },
    getDocRows: async () => new Map(cfg.rows ?? []),
    queryDocs: async () => {
      calls.push("queryDocs");
      return cfg.remote ?? [];
    },
    createDocPage: async (props, markdown) => {
      calls.push(`create:${props.vaultPath}`);
      created.push({ props, markdown });
      return { pageId: `page-${nextId++}` };
    },
    patchPageMarkdown: async (pageId, markdown) => {
      calls.push(`patch:${pageId}`);
      patchedPages.push({ pageId, markdown });
    },
    updateDocProps: async (pageId, props) => {
      calls.push(`props:${pageId}`);
      propUpdates.push({ pageId, props });
    },
    // Deliberately NOT what was pushed: proves notionHash hashes the read-back,
    // never the outbound body (spec §3 — Notion normalises what it stores).
    getPageMarkdown: async (pageId) => {
      calls.push(`read:${pageId}`);
      return `notion:${pageId}`;
    },
    upsertDocSynced: async (doc) => {
      calls.push(`upsert:${doc.vaultPath}`);
      upserts.push(doc);
    },
    recordDocError: async (vaultPath, message) => {
      calls.push(`error:${vaultPath}`);
      errors.push({ vaultPath, message });
    },
    markDocOrphaned: async (vaultPath, reason) => {
      calls.push(`orphan:${vaultPath}`);
      orphaned.push({ vaultPath, reason });
    },
  };
  return { impl, calls, created, patchedPages, propUpdates, upserts, errors, orphaned };
}

describe("runWikiSync — adoption / reconciliation guard", () => {
  it("adopts remote rows by Vault Path when the store is empty: patches, never duplicates", async () => {
    const d = makeDeps({
      files: ["alpha.md"],
      sources: { "alpha.md": ALPHA_SRC },
      remote: [{ pageId: "adopt-1", vaultPath: "wiki/alpha.md", lastEditedTime: "2026-08-01T00:00:00.000Z" }],
    });
    const res = await runWikiSync(OPTS, d.impl);

    expect(d.created).toEqual([]);
    expect(d.patchedPages).toEqual([{ pageId: "adopt-1", markdown: ALPHA_MD }]);
    expect(d.upserts[0]).toMatchObject({ vaultPath: "wiki/alpha.md", pageId: "adopt-1" });
    expect(res).toMatchObject({ created: 0, patched: 1, errored: 0 });
  });

  it("ignores remote rows without a Vault Path and rows outside wikiDir", async () => {
    const d = makeDeps({
      files: ["alpha.md"],
      sources: { "alpha.md": ALPHA_SRC },
      remote: [
        { pageId: "hand-made", vaultPath: "", lastEditedTime: "2026-08-01T00:00:00.000Z" },
        { pageId: "not-ours", vaultPath: "other/alpha.md", lastEditedTime: "2026-08-01T00:00:00.000Z" },
      ],
    });
    const res = await runWikiSync(OPTS, d.impl);

    expect(d.created).toHaveLength(1);
    expect(d.patchedPages).toEqual([]);
    expect(res.created).toBe(1);
  });

  it("does not query Notion at all when the store already has rows", async () => {
    const d = makeDeps({
      files: ["alpha.md"],
      sources: { "alpha.md": ALPHA_SRC },
      rows: [["wiki/alpha.md", { pageId: "p1", mdHash: ALPHA_HASH, state: "synced" }]],
    });
    await runWikiSync(OPTS, d.impl);

    expect(d.calls).not.toContain("queryDocs");
  });

  it("archives an adopted remote row whose file does not exist", async () => {
    const d = makeDeps({
      files: ["alpha.md"],
      sources: { "alpha.md": ALPHA_SRC },
      remote: [
        { pageId: "adopt-1", vaultPath: "wiki/alpha.md", lastEditedTime: "2026-08-01T00:00:00.000Z" },
        { pageId: "adopt-gone", vaultPath: "wiki/gone.md", lastEditedTime: "2026-08-01T00:00:00.000Z" },
      ],
    });
    const res = await runWikiSync(OPTS, d.impl);

    expect(d.propUpdates).toContainEqual({ pageId: "adopt-gone", props: { archived: true } });
    expect(d.orphaned).toEqual([{ vaultPath: "wiki/gone.md", reason: "file missing from vault" }]);
    expect(res.archived).toBe(1);
  });

  it("persists adopted rows before flagging them — UPDATE-only store bookkeeping must still land", async () => {
    // The real recordDocError/markDocOrphaned are UPDATEs (see store.ts): against
    // a row that exists only in this run's memory they match zero rows and the
    // flag silently vanishes. This fake mimics that — nothing is recorded for a
    // vault path unless an upsert for it landed first — so the test fails unless
    // the engine pins every adopted row into the store up front.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const d = makeDeps({
        files: ["alpha.md"],
        sources: { "alpha.md": ALPHA_SRC },
        remote: [
          { pageId: "adopt-1", vaultPath: "wiki/alpha.md", lastEditedTime: "2026-08-01T00:00:00.000Z" },
          { pageId: "adopt-gone", vaultPath: "wiki/gone.md", lastEditedTime: "2026-08-01T00:00:00.000Z" },
        ],
      });
      const persisted = new Set<string>();
      const innerUpsert = d.impl.upsertDocSynced;
      d.impl.upsertDocSynced = async (doc) => {
        persisted.add(doc.vaultPath);
        await innerUpsert(doc);
      };
      const innerError = d.impl.recordDocError;
      d.impl.recordDocError = async (vaultPath, message) => {
        if (!persisted.has(vaultPath)) return; // UPDATE matched zero rows
        await innerError(vaultPath, message);
      };
      const innerOrphan = d.impl.markDocOrphaned;
      d.impl.markDocOrphaned = async (vaultPath, reason) => {
        if (!persisted.has(vaultPath)) return; // UPDATE matched zero rows
        await innerOrphan(vaultPath, reason);
      };
      d.impl.patchPageMarkdown = async (pageId) => {
        d.calls.push(`patch:${pageId}`);
        throw new Error("notion 500");
      };
      const res = await runWikiSync(OPTS, d.impl);

      // Both adopted rows were pinned (empty hashes — the post-create pin's
      // sentinel) before any Notion write, so the patch failure's 3-strike and
      // the vanished file's orphan flag both hit a real row.
      expect(d.upserts.slice(0, 2)).toEqual([
        { vaultPath: "wiki/alpha.md", pageId: "adopt-1", mdHash: "", notionHash: "", notionLastEdited: null },
        { vaultPath: "wiki/gone.md", pageId: "adopt-gone", mdHash: "", notionHash: "", notionLastEdited: null },
      ]);
      expect(d.calls.indexOf("upsert:wiki/gone.md")).toBeLessThan(d.calls.indexOf("patch:adopt-1"));
      expect(d.errors).toEqual([{ vaultPath: "wiki/alpha.md", message: "notion 500" }]);
      expect(d.orphaned).toEqual([{ vaultPath: "wiki/gone.md", reason: "file missing from vault" }]);
      expect(res).toMatchObject({ patched: 0, archived: 1, errored: 1, bookkeepingFailed: 0 });
    } finally {
      spy.mockRestore();
    }
  });

  it("counts a failed adoption pin as bookkeepingFailed — a memory-only row is the duplicate-maker", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const d = makeDeps({
        files: ["alpha.md"],
        sources: { "alpha.md": ALPHA_SRC },
        remote: [{ pageId: "adopt-1", vaultPath: "wiki/alpha.md", lastEditedTime: "2026-08-01T00:00:00.000Z" }],
      });
      const inner = d.impl.upsertDocSynced;
      let pinned = false;
      d.impl.upsertDocSynced = async (doc) => {
        if (!pinned) { pinned = true; throw new Error("store unreachable"); }
        await inner(doc);
      };
      const res = await runWikiSync(OPTS, d.impl);

      // The run continues — and the ordinary post-patch upsert may even heal the
      // row — but the store was unreachable mid-recovery, which must fail the
      // command loudly rather than pass as a clean tick.
      expect(res.bookkeepingFailed).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("dry-run adoption plans against the adopted rows but persists nothing", async () => {
    const d = makeDeps({
      files: ["alpha.md"],
      sources: { "alpha.md": ALPHA_SRC },
      remote: [
        { pageId: "adopt-1", vaultPath: "wiki/alpha.md", lastEditedTime: "2026-08-01T00:00:00.000Z" },
        { pageId: "adopt-gone", vaultPath: "wiki/gone.md", lastEditedTime: "2026-08-01T00:00:00.000Z" },
      ],
    });
    const res = await runWikiSync({ ...OPTS, dryRun: true }, d.impl);

    expect(d.calls).toEqual(["queryDocs"]);
    expect(d.upserts).toEqual([]);
    expect(res).toMatchObject({ created: 0, patched: 1, archived: 1 });
  });

  it("adopts the most recently edited page when two claim the same Vault Path, regardless of order", async () => {
    const older = { pageId: "adopt-old", vaultPath: "wiki/alpha.md", lastEditedTime: "2026-08-01T00:00:00.000Z" };
    const newer = { pageId: "adopt-new", vaultPath: "wiki/alpha.md", lastEditedTime: "2026-08-02T00:00:00.000Z" };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const remote of [[older, newer], [newer, older]]) {
        const d = makeDeps({ files: ["alpha.md"], sources: { "alpha.md": ALPHA_SRC }, remote });
        await runWikiSync(OPTS, d.impl);
        expect(d.patchedPages.map((p) => p.pageId)).toEqual(["adopt-new"]);
      }
    } finally {
      spy.mockRestore();
    }
  });
});

describe("runWikiSync — hash-after-write ordering", () => {
  it("create: reads the page back AFTER the write and BEFORE the upsert, hashing the read-back", async () => {
    const d = makeDeps({ files: ["alpha.md"], sources: { "alpha.md": ALPHA_SRC } });
    const res = await runWikiSync(OPTS, d.impl);

    expect(d.calls).toEqual(["queryDocs", "create:wiki/alpha.md", "read:page-1", "upsert:wiki/alpha.md"]);
    expect(d.upserts).toEqual([{
      vaultPath: "wiki/alpha.md", pageId: "page-1",
      mdHash: ALPHA_HASH, notionHash: sha256("notion:page-1"), notionLastEdited: null,
    }]);
    expect(res).toMatchObject({ scanned: 1, created: 1, patched: 0, skipped: 0, errored: 0, bookkeepingFailed: 0 });
  });

  it("patch: content, then props, then read-back, then upsert — in that order", async () => {
    const d = makeDeps({
      files: ["alpha.md"],
      sources: { "alpha.md": ALPHA_SRC },
      rows: [["wiki/alpha.md", { pageId: "p1", mdHash: "stale", state: "synced" }]],
    });
    const res = await runWikiSync(OPTS, d.impl);

    expect(d.calls).toEqual(["patch:p1", "props:p1", "read:p1", "upsert:wiki/alpha.md"]);
    expect(d.upserts[0]).toMatchObject({ pageId: "p1", mdHash: ALPHA_HASH, notionHash: sha256("notion:p1") });
    expect(res).toMatchObject({ patched: 1, created: 0 });
  });

  it("pins the page id with empty hashes when the read-back fails after a CREATE — a lost id would duplicate the page next tick", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const d = makeDeps({ files: ["alpha.md"], sources: { "alpha.md": ALPHA_SRC } });
      d.impl.getPageMarkdown = async () => { throw new Error("read-back 500"); };
      const res = await runWikiSync(OPTS, d.impl);

      // The empty md_hash can never match a real render, so the next tick re-patches
      // this same page (no duplicate create) and re-attempts the verification read.
      expect(d.upserts).toEqual([{
        vaultPath: "wiki/alpha.md", pageId: "page-1", mdHash: "", notionHash: "", notionLastEdited: null,
      }]);
      expect(d.errors).toEqual([{ vaultPath: "wiki/alpha.md", message: "read-back 500" }]);
      expect(res).toMatchObject({ created: 1, errored: 1, bookkeepingFailed: 0 });
    } finally {
      spy.mockRestore();
    }
  });

  it("records the error and does NOT upsert when the read-back fails after a PATCH — the stale hash forces a clean retry", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const d = makeDeps({
        files: ["alpha.md"],
        sources: { "alpha.md": ALPHA_SRC },
        rows: [["wiki/alpha.md", { pageId: "p1", mdHash: "stale", state: "synced" }]],
      });
      d.impl.getPageMarkdown = async () => { throw new Error("read-back 500"); };
      const res = await runWikiSync(OPTS, d.impl);

      expect(d.upserts).toEqual([]);
      expect(d.errors).toEqual([{ vaultPath: "wiki/alpha.md", message: "read-back 500" }]);
      expect(res).toMatchObject({ patched: 1, errored: 1, bookkeepingFailed: 0 });
    } finally {
      spy.mockRestore();
    }
  });

  it("counts a failed post-create upsert as bookkeepingFailed and keeps going", async () => {
    const d = makeDeps({
      files: ["alpha.md", "beta.md"],
      sources: { "alpha.md": ALPHA_SRC, "beta.md": "# Beta\n\nbody" },
    });
    const inner = d.impl.upsertDocSynced;
    d.impl.upsertDocSynced = async (doc) => {
      if (doc.vaultPath === "wiki/alpha.md") throw new Error("store unreachable");
      await inner(doc);
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await runWikiSync(OPTS, d.impl);
      expect(res).toMatchObject({ created: 2, bookkeepingFailed: 1, errored: 0 });
    } finally {
      spy.mockRestore();
    }
    expect(d.upserts.map((u) => u.vaultPath)).toEqual(["wiki/beta.md"]);
  });

  it("counts bookkeepingFailed when both the read-back and the pin upsert fail after a create", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    try {
      const d = makeDeps({ files: ["alpha.md"], sources: { "alpha.md": ALPHA_SRC } });
      d.impl.getPageMarkdown = async () => { throw new Error("read-back 500"); };
      d.impl.upsertDocSynced = async () => { throw new Error("store unreachable"); };
      const res = await runWikiSync(OPTS, d.impl);

      expect(res).toMatchObject({ created: 1, errored: 1, bookkeepingFailed: 1 });
      // The one drift that cannot self-heal must name the page loudly.
      expect(logged.join("\n")).toContain("page-1");
      expect(logged.join("\n")).toContain("duplicate");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("runWikiSync — core flow", () => {
  it("creates a nested file with the folder, title, frontmatter and project properties", async () => {
    const d = makeDeps({
      files: ["people/jane.md"],
      sources: { "people/jane.md": "---\ntitle: Jane Doe\nrole: advisor\n---\n# Jane\n\nhi" },
    });
    await runWikiSync(OPTS, d.impl);

    expect(d.created[0].props).toEqual({
      name: "Jane Doe",
      project: "Portfolio",
      folder: "wiki/people",
      vaultPath: "wiki/people/jane.md",
      frontmatter: "title: Jane Doe\nrole: advisor",
      archived: false,
    });
  });

  it("skips a synced row whose rendered hash is unchanged, with zero writes", async () => {
    const d = makeDeps({
      files: ["alpha.md"],
      sources: { "alpha.md": ALPHA_SRC },
      rows: [["wiki/alpha.md", { pageId: "p1", mdHash: ALPHA_HASH, state: "synced" }]],
    });
    const res = await runWikiSync(OPTS, d.impl);

    expect(d.calls).toEqual([]);
    expect(res).toMatchObject({ scanned: 1, skipped: 1, created: 0, patched: 0 });
  });

  it("patches on a frontmatter-only title edit — prop drift must not be a permanent silent drop", async () => {
    // translate.ts strips frontmatter from the rendered markdown, so a `title:`
    // edit leaves the body byte-identical. Hashing the markdown alone would skip
    // this forever ("heals on the next body change" never comes for a page that
    // only got retitled) — the change hash must cover the prop-bearing outputs.
    const files = ["alpha.md"];
    const d1 = makeDeps({ files, sources: { "alpha.md": "---\ntitle: Old Name\n---\n\nbody" } });
    const r1 = await runWikiSync(OPTS, d1.impl);
    expect(r1).toMatchObject({ created: 1 });

    const rowsAfter = (upserts: DocSyncedInput[]): Array<[string, DocRow]> =>
      upserts.map((u) => [u.vaultPath, { pageId: u.pageId, mdHash: u.mdHash, state: "synced" as const }]);

    const d2 = makeDeps({
      files, sources: { "alpha.md": "---\ntitle: New Name\n---\n\nbody" }, rows: rowsAfter(d1.upserts),
    });
    const r2 = await runWikiSync(OPTS, d2.impl);
    expect(r2).toMatchObject({ patched: 1, skipped: 0 });
    expect(d2.propUpdates[0].props).toMatchObject({ name: "New Name", frontmatter: "title: New Name" });

    // Unchanged source still skips — the sharpened hash keeps idempotence.
    const d3 = makeDeps({
      files, sources: { "alpha.md": "---\ntitle: New Name\n---\n\nbody" }, rows: rowsAfter(d2.upserts),
    });
    const r3 = await runWikiSync(OPTS, d3.impl);
    expect(d3.calls).toEqual([]);
    expect(r3).toMatchObject({ patched: 0, skipped: 1 });
  });

  it("re-pushes an 'unmatched' row even when the hash matches, clearing Archived — the revive path", async () => {
    const d = makeDeps({
      files: ["alpha.md"],
      sources: { "alpha.md": ALPHA_SRC },
      rows: [["wiki/alpha.md", { pageId: "p1", mdHash: ALPHA_HASH, state: "unmatched" }]],
    });
    const res = await runWikiSync(OPTS, d.impl);

    expect(d.patchedPages).toEqual([{ pageId: "p1", markdown: ALPHA_MD }]);
    expect(d.propUpdates[0].props).toMatchObject({ archived: false });
    expect(d.upserts[0]).toMatchObject({ vaultPath: "wiki/alpha.md", pageId: "p1" });
    expect(res).toMatchObject({ patched: 1, skipped: 0 });
  });

  it("re-pushes an 'error' row even when the hash matches", async () => {
    const d = makeDeps({
      files: ["alpha.md"],
      sources: { "alpha.md": ALPHA_SRC },
      rows: [["wiki/alpha.md", { pageId: "p1", mdHash: ALPHA_HASH, state: "error" }]],
    });
    const res = await runWikiSync(OPTS, d.impl);

    expect(d.patchedPages).toHaveLength(1);
    expect(res).toMatchObject({ patched: 1, skipped: 0 });
  });

  it("contains a push-safety violation per doc: no write, error recorded on an existing row, others proceed", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const d = makeDeps({
        files: ["alpha.md", "fenced.md"],
        sources: {
          "alpha.md": ALPHA_SRC,
          "fenced.md": '# F\n\n```\n<page url="x">\n```',
        },
        rows: [["wiki/fenced.md", { pageId: "pf", mdHash: "stale", state: "synced" }]],
      });
      const res = await runWikiSync(OPTS, d.impl);

      expect(d.patchedPages).toEqual([]);
      expect(d.errors).toHaveLength(1);
      expect(d.errors[0].vaultPath).toBe("wiki/fenced.md");
      expect(d.errors[0].message).toContain("page");
      expect(d.created.map((c) => c.props.vaultPath)).toEqual(["wiki/alpha.md"]);
      expect(res).toMatchObject({ created: 1, errored: 1 });
    } finally {
      spy.mockRestore();
    }
  });

  it("counts a pre-create failure into the summary without any store write", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const d = makeDeps({ files: ["alpha.md"], sources: { "alpha.md": ALPHA_SRC } });
      d.impl.createDocPage = async () => { throw new Error("notion 500"); };
      const res = await runWikiSync(OPTS, d.impl);

      expect(d.errors).toEqual([]);
      expect(d.upserts).toEqual([]);
      expect(res).toMatchObject({ created: 0, errored: 1, bookkeepingFailed: 0 });
    } finally {
      spy.mockRestore();
    }
  });

  it("contains a failed read: errored, recorded on the existing row, never archived, others proceed", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const d = makeDeps({
        files: ["alpha.md", "broken.md"],
        sources: { "alpha.md": ALPHA_SRC },
        rows: [["wiki/broken.md", { pageId: "pb", mdHash: "h", state: "synced" }]],
      });
      const res = await runWikiSync(OPTS, d.impl);

      expect(d.errors[0]).toMatchObject({ vaultPath: "wiki/broken.md" });
      // A listed-but-unreadable file is ambiguous (spec §7) — it must not archive.
      expect(d.orphaned).toEqual([]);
      expect(d.created).toHaveLength(1);
      expect(res).toMatchObject({ created: 1, errored: 1, archived: 0 });
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps going when a patch failure's own error bookkeeping throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const d = makeDeps({
        files: ["alpha.md", "beta.md"],
        sources: { "alpha.md": ALPHA_SRC, "beta.md": "# Beta\n\nbody" },
        rows: [["wiki/alpha.md", { pageId: "p1", mdHash: "stale", state: "synced" }]],
      });
      d.impl.patchPageMarkdown = async () => { throw new Error("notion 500"); };
      d.impl.recordDocError = async () => { throw new Error("store unreachable"); };
      const res = await runWikiSync(OPTS, d.impl);

      expect(res).toMatchObject({ created: 1, patched: 0, errored: 1, bookkeepingFailed: 1 });
    } finally {
      spy.mockRestore();
    }
  });

  it("processes files in sorted order regardless of listing order", async () => {
    const d = makeDeps({
      files: ["beta.md", "alpha.md"],
      sources: { "alpha.md": ALPHA_SRC, "beta.md": "# Beta\n\nbody" },
    });
    await runWikiSync(OPTS, d.impl);

    expect(d.created.map((c) => c.props.vaultPath)).toEqual(["wiki/alpha.md", "wiki/beta.md"]);
  });
});

describe("runWikiSync — wikilink resolution and convergence", () => {
  it("resolves links to already-synced pages as mentions; unsynced targets stay escaped literals", async () => {
    const d = makeDeps({
      files: ["a.md", "b.md"],
      sources: { "a.md": "# A\n\nsee [[b#intro|Buzz]] and [[nope]]", "b.md": "# Bee\n\nhi" },
      rows: [["wiki/b.md", { pageId: "1234-abcd", mdHash: "stale", state: "synced" }]],
    });
    await runWikiSync(OPTS, d.impl);

    expect(notionPageUrl("1234-abcd")).toBe("https://www.notion.so/1234abcd");
    expect(d.created[0].markdown).toBe(
      '# A\n\nsee <mention-page url="https://www.notion.so/1234abcd">Buzz</mention-page> and \\[\\[nope\\]\\]',
    );
  });

  it("converges over ticks: pass 1 escapes, pass 2 linkifies, pass 3 is a no-op", async () => {
    const files = ["a.md", "b.md"];
    const sources = { "a.md": "# A\n\nsee [[b]]", "b.md": "# Bee\n\nhi" };

    // Pass 1: cold store — b has no page yet when a renders, so the link escapes.
    const d1 = makeDeps({ files, sources });
    const r1 = await runWikiSync(OPTS, d1.impl);
    expect(r1).toMatchObject({ created: 2, patched: 0, skipped: 0 });
    expect(d1.created[0].markdown).toContain("\\[\\[b\\]\\]");

    const rowsAfter = (upserts: DocSyncedInput[]): Array<[string, DocRow]> =>
      upserts.map((u) => [u.vaultPath, { pageId: u.pageId, mdHash: u.mdHash, state: "synced" as const }]);

    // Pass 2: b now has a page — a's render differs, so exactly a patches.
    const d2 = makeDeps({ files, sources, rows: rowsAfter(d1.upserts) });
    const r2 = await runWikiSync(OPTS, d2.impl);
    expect(r2).toMatchObject({ created: 0, patched: 1, skipped: 1 });
    expect(d2.patchedPages[0].markdown).toContain('<mention-page url="');
    expect(d2.patchedPages[0].markdown).toContain(">Bee</mention-page>");

    // Pass 3: steady state — the standing idempotence regression (spec §9).
    const d3 = makeDeps({ files, sources, rows: rowsAfter([...d1.upserts.slice(1), ...d2.upserts]) });
    const r3 = await runWikiSync(OPTS, d3.impl);
    expect(d3.calls).toEqual([]);
    expect(r3).toMatchObject({ created: 0, patched: 0, skipped: 2 });
  });
});

describe("runWikiSync — frozen rows are written to on neither side (Phase 3, spec §6)", () => {
  it("skips a frozen row wholesale: no patch, no props, no error — it is a human's to resolve", async () => {
    // The row's stored hash deliberately does NOT match the file: this is the
    // shape a conflict freeze has by definition (pull-sync.ts proposeDesk), and
    // it is exactly the shape the revival path re-pushes wholesale. A frozen row
    // must not take that path — pushing here would overwrite the very Notion
    // content the human is being asked to judge.
    const d = makeDeps({
      files: ["alpha.md"],
      sources: { "alpha.md": ALPHA_SRC },
      rows: [["wiki/alpha.md", { pageId: "p1", mdHash: "stale-hash", state: "frozen" }]],
    });
    const res = await runWikiSync(OPTS, d.impl);

    expect(d.calls).toEqual([]);
    expect(res).toMatchObject({ frozen: 1, patched: 0, created: 0, skipped: 0, errored: 0 });
    expect(res.summary).toContain("1 frozen");
  });

  it("does not archive a frozen row whose file vanished — the freeze outranks the archive", async () => {
    const d = makeDeps({
      files: ["alpha.md"],
      sources: { "alpha.md": ALPHA_SRC },
      rows: [
        ["wiki/alpha.md", { pageId: "p1", mdHash: ALPHA_HASH, state: "synced" }],
        ["wiki/frozen-gone.md", { pageId: "p2", mdHash: "h", state: "frozen" }],
      ],
    });
    const res = await runWikiSync(OPTS, d.impl);

    expect(d.calls).toEqual([]);
    expect(res).toMatchObject({ archived: 0, skipped: 1 });
  });
});

describe("runWikiSync — skipVaultPaths: push never races an open decision (spec §18.4)", () => {
  // The generalisation of the frozen skip (final review, round 3). A vault edit
  // made while a proposal waits would otherwise be pushed straight over the exact
  // Notion content that proposal references — this engine is proposal-blind, and
  // pull cannot catch it because `resolve` leaves the row's hashes true.
  it("skips a path with an open proposal: no read, no render, no Notion call", async () => {
    const d = makeDeps({
      files: ["alpha.md", "beta.md"],
      sources: { "alpha.md": "# Alpha\n\nedited in the vault while a proposal waits", "beta.md": ALPHA_SRC },
      rows: [
        ["wiki/alpha.md", { pageId: "p1", mdHash: "hash-from-before-the-vault-edit", state: "synced" }],
        ["wiki/beta.md", { pageId: "p2", mdHash: ALPHA_HASH, state: "synced" }],
      ],
    });
    const res = await runWikiSync(
      { ...OPTS, skipVaultPaths: new Set(["wiki/alpha.md"]) }, d.impl,
    );

    expect(d.calls).toEqual([]);        // beta is in step, alpha was never touched
    expect(res).toMatchObject({
      awaitingApproval: 1, patched: 0, created: 0, errored: 0, frozen: 0, skipped: 1,
    });
    expect(res.summary).toContain("1 awaiting approval");
  });

  it("does not archive a path with an open proposal whose file vanished", async () => {
    const d = makeDeps({
      files: ["alpha.md"],
      sources: { "alpha.md": ALPHA_SRC },
      rows: [
        ["wiki/alpha.md", { pageId: "p1", mdHash: ALPHA_HASH, state: "synced" }],
        ["wiki/proposed-gone.md", { pageId: "p2", mdHash: "h", state: "synced" }],
      ],
    });
    const res = await runWikiSync(
      { ...OPTS, skipVaultPaths: new Set(["wiki/proposed-gone.md"]) }, d.impl,
    );

    expect(d.calls).toEqual([]);
    expect(res).toMatchObject({ archived: 0, awaitingApproval: 1, skipped: 1 });
  });

  it("holds nothing back when the option is absent — the wiki mirror's case", async () => {
    const d = makeDeps({
      files: ["alpha.md"],
      sources: { "alpha.md": ALPHA_SRC },
      rows: [["wiki/alpha.md", { pageId: "p1", mdHash: "stale", state: "synced" }]],
    });
    const res = await runWikiSync(OPTS, d.impl);
    expect(res).toMatchObject({ awaitingApproval: 0, patched: 1 });
  });
});

describe("runWikiSync — readOnlyVaultPaths: Notion owns the document (Phase 4)", () => {
  // The load-bearing half of `notion_to_md` on the push side. This engine is
  // direction-blind — it re-patches anything whose render no longer matches the
  // stored hash — so without the hold-back a local edit to a Notion-authored file
  // is pushed straight over its own source: a silent md→Notion write for a
  // document declared one-way the other way.
  it("never pushes a Notion-owned path, however far the vault has drifted", async () => {
    const d = makeDeps({
      files: ["alpha.md", "beta.md"],
      sources: { "alpha.md": "# Alpha\n\nedited locally, on the phone", "beta.md": ALPHA_SRC },
      rows: [
        ["wiki/alpha.md", { pageId: "p1", mdHash: "hash-from-before-the-local-edit", state: "synced" }],
        ["wiki/beta.md", { pageId: "p2", mdHash: ALPHA_HASH, state: "synced" }],
      ],
    });
    const res = await runWikiSync(
      { ...OPTS, readOnlyVaultPaths: new Set(["wiki/alpha.md"]) }, d.impl,
    );

    expect(d.calls).toEqual([]);        // no read, no render, no Notion call
    expect(res).toMatchObject({
      notionOwned: 1, patched: 0, created: 0, errored: 0, awaitingApproval: 0, skipped: 1,
    });
    expect(res.summary).toContain("1 notion-owned");
  });

  // THE ADOPTION half (review round 1). The hold-back was only ever tested for a
  // path that HAS a row; the destructive case is the opposite one — a file this
  // engine can see no row for, which it therefore adopts by creating a page. A
  // transcript is exactly that shape: its state row is `target='meetings'`, which
  // `getDocRows` does not return.
  it("never CREATES a page for a held-back path it has no row for", async () => {
    const d = makeDeps({
      files: ["alpha.md", "held.md"],
      sources: { "alpha.md": ALPHA_SRC, "held.md": "# Held\n\nsome transcript body" },
      rows: [["wiki/alpha.md", { pageId: "p1", mdHash: ALPHA_HASH, state: "synced" }]],
    });
    const res = await runWikiSync(
      { ...OPTS, readOnlyVaultPaths: new Set(["wiki/held.md"]) }, d.impl,
    );

    expect(res.created).toBe(0);
    expect(res.notionOwned).toBe(1);
    expect(d.calls).toEqual([]);        // not read, not rendered, not created
    expect(d.upserts).toEqual([]);      // and no row was written for it
  });

  // The SOURCE-side lint, wired (review round 1). Rendered for push, a transcript's
  // block escapes to an inert `\<transcript>` and passes assertPushSafe — so the only
  // check that can answer "may this FILE be pushed at all" reads the raw bytes. This
  // is the last rail: the hold-back above and config's carve-out both stop the file
  // earlier, and this is what holds when neither did.
  it("refuses to push a file whose SOURCE carries a live <transcript> block", async () => {
    const d = makeDeps({
      files: ["alpha.md", "meeting.md"],
      sources: {
        "alpha.md": ALPHA_SRC,
        "meeting.md": "# Ukesmøte\n\n<transcript>\nBendik: ja\n</transcript>",
      },
      rows: [["wiki/alpha.md", { pageId: "p1", mdHash: ALPHA_HASH, state: "synced" }]],
    });
    const res = await runWikiSync(OPTS, d.impl);

    expect(res.created).toBe(0);          // no page invented for it
    expect(res.errored).toBe(1);
    expect(d.upserts).toEqual([]);        // and no row claimed for it either
    // The ordinary file beside it is unaffected — the rail refuses one thing.
    expect(res.patched + res.skipped).toBe(1);
  });

  // Archived=true is a Notion write, and a projection going missing says nothing
  // about whether its source should be retired. Pull owns the real direction of
  // that question (page trashed ⇒ the vault file moves to _archive/).
  it("never sets Archived on a Notion-owned page whose vault file vanished", async () => {
    const d = makeDeps({
      files: ["alpha.md"],
      sources: { "alpha.md": ALPHA_SRC },
      rows: [
        ["wiki/alpha.md", { pageId: "p1", mdHash: ALPHA_HASH, state: "synced" }],
        ["wiki/notion-owned-gone.md", { pageId: "p2", mdHash: "h", state: "synced" }],
      ],
    });
    const res = await runWikiSync(
      { ...OPTS, readOnlyVaultPaths: new Set(["wiki/notion-owned-gone.md"]) }, d.impl,
    );

    expect(d.calls).toEqual([]);
    expect(d.orphaned).toEqual([]);
    expect(res).toMatchObject({ archived: 0, notionOwned: 1, awaitingApproval: 0, skipped: 1 });
  });

  it("holds nothing back when the option is absent — the wiki mirror's case", async () => {
    const d = makeDeps({
      files: ["alpha.md"],
      sources: { "alpha.md": ALPHA_SRC },
      rows: [["wiki/alpha.md", { pageId: "p1", mdHash: "stale", state: "synced" }]],
    });
    const res = await runWikiSync(OPTS, d.impl);
    expect(res).toMatchObject({ notionOwned: 0, patched: 1 });
  });
});

describe("runWikiSync — the Sync stamp (Phase 3, spec §18.1)", () => {
  const syncProp = (vaultPath: string): string =>
    vaultPath === "wiki/alpha.md" ? "✍️ Desk" : "🔒 Mirror";

  it("carries the injected stamp on a create", async () => {
    const d = makeDeps({ files: ["alpha.md"], sources: { "alpha.md": ALPHA_SRC } });
    await runWikiSync({ ...OPTS, syncProp }, d.impl);
    expect(d.created[0].props.sync).toBe("✍️ Desk");
  });

  it("re-asserts the stamp on every patch — a patched row must never lose it", async () => {
    const d = makeDeps({
      files: ["alpha.md", "beta.md"],
      sources: { "alpha.md": ALPHA_SRC, "beta.md": "# Beta\n\nbody" },
      rows: [
        ["wiki/alpha.md", { pageId: "p1", mdHash: "stale", state: "synced" }],
        ["wiki/beta.md", { pageId: "p2", mdHash: "stale", state: "synced" }],
      ],
    });
    await runWikiSync({ ...OPTS, syncProp }, d.impl);
    expect(d.propUpdates.map((u) => [u.pageId, u.props.sync]))
      .toEqual([["p1", "✍️ Desk"], ["p2", "🔒 Mirror"]]);
  });

  it("omits the property entirely when no stamp function is injected (Phase 2 behaviour)", async () => {
    const d = makeDeps({ files: ["alpha.md"], sources: { "alpha.md": ALPHA_SRC } });
    await runWikiSync(OPTS, d.impl);
    expect(d.created[0].props.sync).toBeUndefined();
  });
});

describe("runWikiSync — archiving and guards", () => {
  it("archives a row whose file vanished: Archived=true on Notion, then the orphan flag", async () => {
    const d = makeDeps({
      files: ["alpha.md"],
      sources: { "alpha.md": ALPHA_SRC },
      rows: [
        ["wiki/alpha.md", { pageId: "p1", mdHash: ALPHA_HASH, state: "synced" }],
        ["wiki/gone.md", { pageId: "p2", mdHash: "h", state: "synced" }],
      ],
    });
    const res = await runWikiSync(OPTS, d.impl);

    expect(d.calls).toEqual(["props:p2", "orphan:wiki/gone.md"]);
    expect(d.propUpdates).toEqual([{ pageId: "p2", props: { archived: true } }]);
    expect(d.orphaned).toEqual([{ vaultPath: "wiki/gone.md", reason: "file missing from vault" }]);
    expect(res).toMatchObject({ archived: 1, skipped: 1 });
  });

  it("flags an orphan once: an already-unmatched row is left alone", async () => {
    const d = makeDeps({
      files: ["alpha.md"],
      sources: { "alpha.md": ALPHA_SRC },
      rows: [
        ["wiki/alpha.md", { pageId: "p1", mdHash: ALPHA_HASH, state: "synced" }],
        ["wiki/gone.md", { pageId: "p2", mdHash: "h", state: "unmatched" }],
      ],
    });
    const res = await runWikiSync(OPTS, d.impl);

    expect(d.calls).toEqual([]);
    expect(res.archived).toBe(0);
  });

  it("never touches docs rows outside wikiDir — they belong to other passes", async () => {
    const d = makeDeps({
      files: ["alpha.md"],
      sources: { "alpha.md": ALPHA_SRC },
      rows: [
        ["wiki/alpha.md", { pageId: "p1", mdHash: ALPHA_HASH, state: "synced" }],
        ["other/doc.md", { pageId: "p9", mdHash: "h", state: "synced" }],
      ],
    });
    const res = await runWikiSync(OPTS, d.impl);

    expect(d.calls).toEqual([]);
    expect(res.archived).toBe(0);
  });

  it("records an archive-write failure per doc without flagging the orphan", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const d = makeDeps({
        files: ["alpha.md"],
        sources: { "alpha.md": ALPHA_SRC },
        rows: [
          ["wiki/alpha.md", { pageId: "p1", mdHash: ALPHA_HASH, state: "synced" }],
          ["wiki/gone.md", { pageId: "p2", mdHash: "h", state: "synced" }],
        ],
      });
      d.impl.updateDocProps = async () => { throw new Error("notion 500"); };
      const res = await runWikiSync(OPTS, d.impl);

      expect(d.orphaned).toEqual([]);
      expect(d.errors[0]).toMatchObject({ vaultPath: "wiki/gone.md" });
      expect(res).toMatchObject({ archived: 0, errored: 1 });
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses to run when the listing is empty but the store has rows — a bad mount must not archive everything", async () => {
    const d = makeDeps({
      files: [],
      sources: {},
      rows: [["wiki/alpha.md", { pageId: "p1", mdHash: "h", state: "synced" }]],
    });

    await expect(runWikiSync(OPTS, d.impl)).rejects.toThrow(/0 files/);
    expect(d.calls).toEqual([]);
  });

  it("refuses to run when the listing is empty and adoption finds remote rows", async () => {
    const d = makeDeps({
      files: [],
      sources: {},
      remote: [{ pageId: "adopt-1", vaultPath: "wiki/alpha.md", lastEditedTime: "2026-08-01T00:00:00.000Z" }],
    });

    await expect(runWikiSync(OPTS, d.impl)).rejects.toThrow(/0 files/);
    expect(d.calls).toEqual(["queryDocs"]);
  });

  it("is a clean no-op when both sides are empty", async () => {
    const d = makeDeps({ files: [], sources: {} });
    const res = await runWikiSync(OPTS, d.impl);
    expect(res).toMatchObject({ scanned: 0, created: 0, archived: 0 });
  });

  // Phase 3 runs this engine once per desk folder over ONE shared docs table
  // (cli.ts syncDeskPushOnce), so both recovery guards have to reason about the
  // dir they were given, never about the table as a whole.
  it("adopts for a cold dir even when ANOTHER dir already has rows — no duplicate pages", async () => {
    const d = makeDeps({
      files: ["alpha.md"],
      sources: { "alpha.md": ALPHA_SRC },
      // A populated neighbouring folder — the wiki mirror, in production.
      rows: [["wiki/other.md", { pageId: "pw", mdHash: "h", state: "synced" }]],
      remote: [{ pageId: "adopt-1", vaultPath: "desks/x/alpha.md", lastEditedTime: "2026-08-01T00:00:00.000Z" }],
    });
    const res = await runWikiSync({ wikiDir: "desks/x", project: "X", dryRun: false }, d.impl);

    // Adopted and patched, NOT created a second time.
    expect(d.created).toEqual([]);
    expect(d.patchedPages).toEqual([{ pageId: "adopt-1", markdown: ALPHA_MD }]);
    expect(res).toMatchObject({ created: 0, patched: 1 });
  });

  it("an empty listing is not a failure when every row belongs to another dir", async () => {
    const d = makeDeps({
      files: [],
      sources: {},
      rows: [["wiki/other.md", { pageId: "pw", mdHash: "h", state: "synced" }]],
    });
    const res = await runWikiSync({ wikiDir: "desks/x", project: "X", dryRun: false }, d.impl);
    expect(res).toMatchObject({ scanned: 0, created: 0, archived: 0 });
  });

  it("limit: processes only the first N sorted files and skips archiving entirely", async () => {
    const d = makeDeps({
      files: ["c.md", "a.md", "b.md"],
      sources: { "a.md": "# A\n\n1", "b.md": "# B\n\n2", "c.md": "# C\n\n3" },
      rows: [["wiki/gone.md", { pageId: "p2", mdHash: "h", state: "synced" }]],
    });
    const res = await runWikiSync({ ...OPTS, limit: 2 }, d.impl);

    expect(d.created.map((c) => c.props.vaultPath)).toEqual(["wiki/a.md", "wiki/b.md"]);
    // A truncated listing cannot prove absence, so nothing may archive under --limit.
    expect(d.orphaned).toEqual([]);
    expect(res).toMatchObject({ scanned: 2, created: 2, archived: 0 });
  });
});

describe("runWikiSync — isExcluded: rows this dir no longer owns (Phase 4)", () => {
  const EXCLUDED = "wiki/transcripts/2026-08-01-foo.md";
  const isExcluded = makeDeskExclusion({
    deskDirs: [{ dir: "wiki", project: "Portfolio", exclude: ["transcripts"] }],
    twoWayDirs: [],
    mirrorFilePrefixes: [],
  });

  it("archives an excluded row when it is NOT told about the exclusion — the control", async () => {
    // The listing no longer carries the file (the adapter prunes it), so without
    // the row-side half the archive step reads "file missing from vault" and
    // retires a page nobody deleted. This is the behaviour the next test removes.
    const d = makeDeps({
      files: ["alpha.md"],
      sources: { "alpha.md": ALPHA_SRC },
      rows: [
        ["wiki/alpha.md", { pageId: "p1", mdHash: ALPHA_HASH, state: "synced" }],
        [EXCLUDED, { pageId: "p2", mdHash: "h", state: "synced" }],
      ],
    });
    const res = await runWikiSync(OPTS, d.impl);

    expect(d.propUpdates).toEqual([{ pageId: "p2", props: { archived: true } }]);
    expect(res.archived).toBe(1);
  });

  it("never archives or flags a row whose path config carved out of this dir", async () => {
    const d = makeDeps({
      files: ["alpha.md"],
      sources: { "alpha.md": ALPHA_SRC },
      rows: [
        ["wiki/alpha.md", { pageId: "p1", mdHash: ALPHA_HASH, state: "synced" }],
        [EXCLUDED, { pageId: "p2", mdHash: "h", state: "synced" }],
      ],
    });
    const res = await runWikiSync({ ...OPTS, isExcluded }, d.impl);

    expect(d.calls).toEqual([]);
    expect(d.propUpdates).toEqual([]);
    expect(d.orphaned).toEqual([]);
    expect(res.archived).toBe(0);
  });

  it("does not adopt an excluded remote page", async () => {
    // The adoption guard reads NOTION, not the listing, so pruning the walk does
    // not reach it: adopting a disowned page would pin a store row for a path
    // this pass has been told to ignore — recreating exactly what the carve-out
    // exists to stop, from the other direction.
    const d = makeDeps({
      files: ["alpha.md"],
      sources: { "alpha.md": ALPHA_SRC },
      rows: [[EXCLUDED, { pageId: "p2", mdHash: "h", state: "synced" }]],
      remote: [{ pageId: "p2", vaultPath: EXCLUDED, lastEditedTime: "2026-08-01T00:00:00.000Z" }],
    });
    const res = await runWikiSync({ ...OPTS, isExcluded }, d.impl);

    expect(d.upserts.map((u) => u.vaultPath)).toEqual(["wiki/alpha.md"]);
    expect(d.propUpdates).toEqual([]);
    expect(res).toMatchObject({ created: 1, patched: 0, archived: 0 });
  });

  it("an excluded row is not this dir's row: the dir is still cold, so adoption runs", async () => {
    // The `rowsInDir` half, which the two tests above cannot discriminate. This
    // dir's ONLY store row is an excluded one, so the dir has no rows this pass
    // owns — it is a cold start, and the adoption guard must run and claim the
    // live page for alpha.md.
    //
    // Count the excluded row as this dir's and rowsInDir is 1: adoption is
    // skipped, alpha.md is found row-less, and createDocPage makes a SECOND
    // Notion page for a file that already has one — the duplicate the adoption
    // guard exists to prevent, reintroduced by the carve-out.
    const d = makeDeps({
      files: ["alpha.md"],
      sources: { "alpha.md": ALPHA_SRC },
      rows: [[EXCLUDED, { pageId: "p2", mdHash: "h", state: "synced" }]],
      remote: [{ pageId: "adopt-1", vaultPath: "wiki/alpha.md", lastEditedTime: "2026-08-01T00:00:00.000Z" }],
    });
    const res = await runWikiSync({ ...OPTS, isExcluded }, d.impl);

    expect(d.created).toEqual([]);
    expect(d.patchedPages).toEqual([{ pageId: "adopt-1", markdown: ALPHA_MD }]);
    expect(res).toMatchObject({ created: 0, patched: 1 });
  });
});

describe("runWikiSync — dry-run", () => {
  it("reports the full plan with zero writes of any kind", async () => {
    const d = makeDeps({
      files: ["new.md", "changed.md", "same.md"],
      sources: { "new.md": "# N\n\n1", "changed.md": "# C\n\n2", "same.md": "# S\n\n3" },
      rows: [
        ["wiki/changed.md", { pageId: "p1", mdHash: "stale", state: "synced" }],
        ["wiki/same.md", { pageId: "p2", mdHash: wikiRenderHash({ markdown: "# S\n\n3", title: "S", frontmatter: "" }), state: "synced" }],
        ["wiki/gone.md", { pageId: "p3", mdHash: "h", state: "synced" }],
      ],
    });
    const res = await runWikiSync({ ...OPTS, dryRun: true }, d.impl);

    expect(d.calls).toEqual([]);
    expect(res).toMatchObject({ scanned: 3, created: 1, patched: 1, skipped: 1, archived: 1, errored: 0 });
    expect(res.summary).toContain("(dry-run)");
  });

  it("counts errors in the plan without recording them", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const d = makeDeps({
        files: ["fenced.md"],
        sources: { "fenced.md": '# F\n\n```\n<page url="x">\n```' },
        rows: [["wiki/fenced.md", { pageId: "pf", mdHash: "stale", state: "synced" }]],
      });
      const res = await runWikiSync({ ...OPTS, dryRun: true }, d.impl);

      expect(d.calls).toEqual([]);
      expect(res).toMatchObject({ errored: 1 });
    } finally {
      spy.mockRestore();
    }
  });
});
