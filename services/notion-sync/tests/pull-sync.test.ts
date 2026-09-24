import { describe, it, expect } from "vitest";
import {
  runPullSync, docRenderHash, diffPreview,
  type PullSyncDeps, type PullSyncOptions, type PullDocProps, type RenderedDoc,
} from "../lib/pull-sync.js";
import { sha256, type RemoteDocRow } from "../lib/wiki-sync.js";
import { makeDeskExclusion } from "../lib/desk-scope.js";
import type { DesksConfig } from "../lib/types.js";
import type {
  DeskRow, DocSyncedInput, FrozenDocRow, ProposalInput, ProposalRow, ProposalState,
  StaleProposalRow,
} from "../lib/store.js";

const NOW = new Date("2026-08-04T12:00:00.000Z");
// Built from an ABSENT desks config rather than a hand-written `() => false`, so
// every test in this file runs the same derivation the composition root does —
// with the "no desk folders configured, nothing carved out" answer.
const OPTS: PullSyncOptions = { dryRun: false, now: NOW, isExcluded: makeDeskExclusion(undefined) };

const ALPHA_PATH = "wiki/alpha.md";
const ALPHA_MD = "# Alpha\n\nbody";

function makeProps(vaultPath: string, name = "Alpha", frontmatter = ""): PullDocProps {
  return {
    name, project: "Portfolio", folder: "wiki", vaultPath, frontmatter,
    archived: false, sync: "🔒 Mirror",
  };
}

function makeRendered(vaultPath: string, markdown = ALPHA_MD, name = "Alpha", frontmatter = ""): RenderedDoc {
  return { markdown, props: makeProps(vaultPath, name, frontmatter) };
}

const ALPHA_RENDERED = makeRendered(ALPHA_PATH);
const ALPHA_RENDER_HASH = docRenderHash(ALPHA_RENDERED);

function makeRow(over: Partial<DeskRow> & { pageId: string }): DeskRow {
  return {
    mdHash: ALPHA_RENDER_HASH,
    notionHash: "stored-notion-hash",
    notionLastEdited: "2026-08-01T00:00:00.000Z",
    state: "synced",
    direction: "md_to_notion",
    ...over,
  };
}

interface Scenario {
  rows?: Array<[string, DeskRow]>;
  remote?: RemoteDocRow[];
  /** pageId → what GET /markdown currently returns. */
  notion?: Record<string, string>;
  /** vaultPath → the push render (the composition root's job on the real path). */
  rendered?: Record<string, RenderedDoc>;
  /** vaultPath → raw vault file text (frontmatter + body). */
  sources?: Record<string, string>;
  proposals?: ProposalRow[];
  /** Rejected proposals whose Notion revert has not run yet (apply's queue). */
  rejected?: ProposalRow[];
  frozen?: FrozenDocRow[];
  staleProposals?: StaleProposalRow[];
  /** Thrown by patchPageMarkdown for the given page id. */
  patchError?: Record<string, Error>;
  createError?: Error;
  notifyThrows?: boolean;
}

function makeDeps(cfg: Scenario) {
  const calls: string[] = [];
  const notified: string[] = [];
  const patched: Array<{ pageId: string; markdown: string }> = [];
  const propUpdates: Array<{ pageId: string; props: Partial<PullDocProps> }> = [];
  const created: Array<{ props: PullDocProps; markdown: string }> = [];
  const upserts: DocSyncedInput[] = [];
  const watermarks: Array<{ vaultPath: string; notionHash: string; notionLastEdited: string | null }> = [];
  const frozenCalls: Array<{ vaultPath: string; reason: string }> = [];
  const orphaned: Array<{ vaultPath: string; reason: string }> = [];
  const errors: Array<{ vaultPath: string; message: string }> = [];
  const archivedFiles: string[] = [];
  const inserted: ProposalInput[] = [];
  const proposalStates: Array<{ id: number; state: ProposalState }> = [];
  const notion: Record<string, string> = { ...(cfg.notion ?? {}) };
  let nextPageId = 100;

  const impl: PullSyncDeps = {
    queryDocs: async () => {
      calls.push("queryDocs");
      return cfg.remote ?? [];
    },
    getDeskRows: async () => new Map(cfg.rows ?? []),
    getFrozenDocs: async () => cfg.frozen ?? [],
    getStaleProposals: async () => cfg.staleProposals ?? [],
    getOpenProposals: async () => cfg.proposals ?? [],
    getRejectedUnexecuted: async () => cfg.rejected ?? [],
    getPageMarkdown: async (pageId) => {
      calls.push(`read:${pageId}`);
      const md = notion[pageId];
      if (md === undefined) throw new Error(`no such page ${pageId}`);
      return md;
    },
    patchPageMarkdown: async (pageId, markdown) => {
      calls.push(`patch:${pageId}`);
      const err = cfg.patchError?.[pageId];
      if (err !== undefined) throw err;
      patched.push({ pageId, markdown });
      // Notion normalises what it stores — the read-back is never byte-identical
      // to what was pushed, which is exactly why hash-after-write exists.
      notion[pageId] = `stored:${markdown}`;
    },
    updateDocProps: async (pageId, props) => {
      calls.push(`props:${pageId}`);
      propUpdates.push({ pageId, props });
    },
    createDocPage: async (props, markdown) => {
      calls.push(`create:${props.vaultPath}`);
      if (cfg.createError !== undefined) throw cfg.createError;
      created.push({ props, markdown });
      const pageId = `page-new-${nextPageId++}`;
      notion[pageId] = `stored:${markdown}`;
      return { pageId };
    },
    renderDoc: async (vaultPath) => {
      const doc = cfg.rendered?.[vaultPath];
      if (doc === undefined) throw new Error(`ENOENT: ${vaultPath}`);
      return doc;
    },
    readVaultFile: async (vaultPath) => {
      const source = cfg.sources?.[vaultPath];
      if (source === undefined) throw new Error(`ENOENT: ${vaultPath}`);
      return source;
    },
    archiveVaultFile: async (vaultPath) => {
      calls.push(`archiveFile:${vaultPath}`);
      archivedFiles.push(vaultPath);
    },
    insertProposal: async (input) => {
      calls.push(`propose:${input.vaultPath}`);
      inserted.push(input);
      return 900 + inserted.length;
    },
    setProposalState: async (id, state) => {
      calls.push(`proposal:${id}:${state}`);
      proposalStates.push({ id, state });
    },
    upsertDocSynced: async (doc) => {
      calls.push(`upsert:${doc.vaultPath}`);
      upserts.push(doc);
    },
    updateNotionWatermark: async (vaultPath, notionHash, notionLastEdited) => {
      calls.push(`watermark:${vaultPath}`);
      watermarks.push({ vaultPath, notionHash, notionLastEdited });
    },
    freezeDoc: async (vaultPath, reason) => {
      calls.push(`freeze:${vaultPath}`);
      frozenCalls.push({ vaultPath, reason });
    },
    markDocOrphaned: async (vaultPath, reason) => {
      calls.push(`orphan:${vaultPath}`);
      orphaned.push({ vaultPath, reason });
    },
    recordDocError: async (vaultPath, message) => {
      calls.push(`error:${vaultPath}`);
      errors.push({ vaultPath, message });
    },
    notify: async (message) => {
      calls.push("notify");
      if (cfg.notifyThrows === true) throw new Error("signal-spine unreachable");
      notified.push(message);
    },
  };

  return {
    impl, calls, notified, patched, propUpdates, created, upserts, watermarks,
    frozenCalls: frozenCalls, orphaned, errors, archivedFiles, inserted, proposalStates, notion,
  };
}

// ── Pre-filters: what pull refuses to look at ────────────────────────────────

describe("runPullSync — pre-filters", () => {
  it("re-reads on an EQUAL timestamp (Notion stamps are minute-granular)", async () => {
    const stored = "stored:# Alpha\n\nbody";
    const d = makeDeps({
      rows: [[ALPHA_PATH, makeRow({
        pageId: "p1", notionLastEdited: "2026-08-01T00:00:00.000Z", notionHash: sha256(stored),
      })]],
      remote: [{ pageId: "p1", vaultPath: ALPHA_PATH, lastEditedTime: "2026-08-01T00:00:00.000Z" }],
      notion: { p1: stored },
    });
    await runPullSync(OPTS, d.impl);
    expect(d.calls).toContain("read:p1");
  });

  it("skips a row whose page has not been touched since the watermark", async () => {
    const d = makeDeps({
      rows: [[ALPHA_PATH, makeRow({ pageId: "p1", notionLastEdited: "2026-08-03T00:00:00.000Z" })]],
      remote: [{ pageId: "p1", vaultPath: ALPHA_PATH, lastEditedTime: "2026-08-02T00:00:00.000Z" }],
      notion: { p1: "anything" },
    });
    const result = await runPullSync(OPTS, d.impl);
    expect(d.calls).not.toContain("read:p1");
    expect(result.skipped).toBe(1);
  });

  it("skips a row whose state is not 'synced' — push heals it first (§18.4)", async () => {
    const d = makeDeps({
      rows: [
        ["wiki/e.md", makeRow({ pageId: "pe", state: "error" })],
        ["wiki/f.md", makeRow({ pageId: "pf", state: "frozen" })],
        ["wiki/u.md", makeRow({ pageId: "pu", state: "unmatched" })],
      ],
      remote: [
        { pageId: "pe", vaultPath: "wiki/e.md", lastEditedTime: "2026-08-03T00:00:00.000Z" },
        { pageId: "pf", vaultPath: "wiki/f.md", lastEditedTime: "2026-08-03T00:00:00.000Z" },
        { pageId: "pu", vaultPath: "wiki/u.md", lastEditedTime: "2026-08-03T00:00:00.000Z" },
      ],
      notion: { pe: "changed", pf: "changed", pu: "changed" },
    });
    const result = await runPullSync(OPTS, d.impl);
    expect(d.calls.filter((c) => c.startsWith("read:"))).toEqual([]);
    expect(result.skipped).toBe(3);
  });

  // F1 (T7 review): every page created after go-live has a real notion_hash and a
  // NULL watermark, because the push pass never reads a timestamp back. Skipping
  // that shape would leave every newly added file outside auto-revert and
  // proposals forever — silently, counted as `skipped`.
  it("reads a row with a real hash but no watermark, and baselines it from the OBSERVED timestamp", async () => {
    const stored = "stored:# Alpha\n\nbody";
    const d = makeDeps({
      rows: [[ALPHA_PATH, makeRow({
        pageId: "p1", notionLastEdited: null, notionHash: sha256(stored),
      })]],
      remote: [{ pageId: "p1", vaultPath: ALPHA_PATH, lastEditedTime: "2026-08-03T00:00:00.000Z" }],
      notion: { p1: stored },
    });
    const result = await runPullSync(OPTS, d.impl);

    expect(d.calls).toContain("read:p1");
    // The hash matches (push's own hash-after-write reading), so this is the
    // `unchanged` branch: one GET, then a watermark taken from what was observed.
    expect(result.unchanged).toBe(1);
    expect(d.watermarks).toEqual([{
      vaultPath: ALPHA_PATH, notionHash: sha256(stored), notionLastEdited: "2026-08-03T00:00:00.000Z",
    }]);
  });

  it("still skips an unbaselined row whose hash is the empty pin — nothing truthful to compare", async () => {
    const d = makeDeps({
      // The shape adoptRemoteRows and the mid-failure pins write (wiki-sync.ts).
      rows: [[ALPHA_PATH, makeRow({ pageId: "p1", notionLastEdited: null, notionHash: "" })]],
      remote: [{ pageId: "p1", vaultPath: ALPHA_PATH, lastEditedTime: "2026-08-03T00:00:00.000Z" }],
      notion: { p1: "changed" },
    });
    const result = await runPullSync(OPTS, d.impl);
    expect(d.calls).not.toContain("read:p1");
    expect(result.skipped).toBe(1);
  });

  it("readAllRows (reconcile, §18.5) reads BOTH pre-filtered shapes — unbaselined and not-touched-since", async () => {
    const d = makeDeps({
      rows: [
        ["wiki/unbaselined.md", makeRow({ pageId: "p1", notionLastEdited: null })],
        ["wiki/quiet.md", makeRow({ pageId: "p2", notionLastEdited: "2026-08-03T00:00:00.000Z" })],
      ],
      remote: [
        { pageId: "p1", vaultPath: "wiki/unbaselined.md", lastEditedTime: "2026-08-03T00:00:00.000Z" },
        { pageId: "p2", vaultPath: "wiki/quiet.md", lastEditedTime: "2026-08-02T00:00:00.000Z" },
      ],
      // Both hash-equal to their stored value, so the read is all this asserts.
      notion: { p1: "same", p2: "same" },
    });
    const result = await runPullSync({ ...OPTS, readAllRows: true }, d.impl);
    // Sorted by vault path, as every pass in this service is: quiet before unbaselined.
    expect(d.calls.filter((c) => c.startsWith("read:"))).toEqual(["read:p2", "read:p1"]);
    expect(result.read).toBe(2);
    expect(result.skipped).toBe(0);
  });

  it("readAllRows still skips rows whose state is not 'synced' — reconcile does not thaw a freeze", async () => {
    const d = makeDeps({
      rows: [["wiki/f.md", makeRow({ pageId: "pf", state: "frozen", notionLastEdited: null })]],
      remote: [{ pageId: "pf", vaultPath: "wiki/f.md", lastEditedTime: "2026-08-03T00:00:00.000Z" }],
      notion: { pf: "changed" },
    });
    const result = await runPullSync({ ...OPTS, readAllRows: true }, d.impl);
    expect(d.calls.filter((c) => c.startsWith("read:"))).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it("refuses to run when the Docs query comes back empty but rows exist", async () => {
    const d = makeDeps({
      rows: [[ALPHA_PATH, makeRow({ pageId: "p1" })]],
      remote: [],
    });
    await expect(runPullSync(OPTS, d.impl)).rejects.toThrow(/returned 0 rows/i);
  });
});

// ── The own-write no-op ──────────────────────────────────────────────────────

describe("runPullSync — own-write no-op", () => {
  it("moves the watermark and nothing else when the page hash still matches", async () => {
    const current = "# Alpha\n\nbody as Notion stores it";
    const d = makeDeps({
      rows: [[ALPHA_PATH, makeRow({ pageId: "p1", notionHash: sha256(current) })]],
      remote: [{ pageId: "p1", vaultPath: ALPHA_PATH, lastEditedTime: "2026-08-02T09:00:00.000Z" }],
      notion: { p1: current },
    });
    const result = await runPullSync(OPTS, d.impl);

    expect(d.watermarks).toEqual([
      { vaultPath: ALPHA_PATH, notionHash: sha256(current), notionLastEdited: "2026-08-02T09:00:00.000Z" },
    ]);
    expect(d.patched).toEqual([]);
    expect(d.inserted).toEqual([]);
    expect(d.notified).toEqual([]);
    expect(result.unchanged).toBe(1);
  });

  it("still sees a row the push pass just wrote — the baseline survives a push", async () => {
    // A push write passes notionLastEdited: null ("no reading taken") and the store
    // COALESCEs it, so the row keeps its older baseline while Notion's own stamp
    // moves ahead. Pull must therefore still consider the row (>= pre-filter),
    // find the push's own hash-after-write value, and advance the watermark.
    // Before the COALESCE fix the row's watermark was NULL here and pull skipped
    // it forever — every file went dark on its first vault-side edit.
    const afterPush = "stored:# Alpha\n\nbody";
    const d = makeDeps({
      rows: [[ALPHA_PATH, makeRow({
        pageId: "p1",
        notionHash: sha256(afterPush),
        notionLastEdited: "2026-08-01T00:00:00.000Z",   // preserved, not nulled
      })]],
      remote: [{ pageId: "p1", vaultPath: ALPHA_PATH, lastEditedTime: "2026-08-04T08:00:00.000Z" }],
      notion: { p1: afterPush },
    });
    const result = await runPullSync(OPTS, d.impl);

    expect(d.calls).toContain("read:p1");
    expect(result.skipped).toBe(0);
    expect(result.unchanged).toBe(1);
    expect(d.watermarks).toEqual([
      { vaultPath: ALPHA_PATH, notionHash: sha256(afterPush), notionLastEdited: "2026-08-04T08:00:00.000Z" },
    ]);
  });
});

// ── Mirror rows ──────────────────────────────────────────────────────────────

describe("runPullSync — mirror rows", () => {
  it("reverts the page from the vault, hashes the read-back, and pings", async () => {
    const d = makeDeps({
      rows: [[ALPHA_PATH, makeRow({ pageId: "p1" })]],
      remote: [{ pageId: "p1", vaultPath: ALPHA_PATH, lastEditedTime: "2026-08-02T09:00:00.000Z" }],
      notion: { p1: "# Alpha\n\nsomeone typed this in Notion" },
      rendered: { [ALPHA_PATH]: ALPHA_RENDERED },
    });
    const result = await runPullSync(OPTS, d.impl);

    expect(d.patched).toEqual([{ pageId: "p1", markdown: ALPHA_MD }]);
    expect(d.propUpdates).toEqual([{ pageId: "p1", props: ALPHA_RENDERED.props }]);
    // write → read-back → upsert, in that order (spec §3).
    expect(d.calls).toEqual([
      "queryDocs", "read:p1", "patch:p1", "props:p1", "read:p1", `upsert:${ALPHA_PATH}`, "notify",
    ]);
    expect(d.upserts).toEqual([{
      vaultPath: ALPHA_PATH,
      pageId: "p1",
      mdHash: ALPHA_RENDER_HASH,
      notionHash: sha256(`stored:${ALPHA_MD}`),
      notionLastEdited: "2026-08-02T09:00:00.000Z",
      direction: "md_to_notion",
    }]);
    expect(d.notified[0]).toContain("mirror page wiki/alpha.md — edit reverted");
    expect(result.reverted).toBe(1);
  });

  it("freezes with the move-it-out message when a sub-page blocks the revert", async () => {
    const d = makeDeps({
      rows: [[ALPHA_PATH, makeRow({ pageId: "p1" })]],
      remote: [{ pageId: "p1", vaultPath: ALPHA_PATH, lastEditedTime: "2026-08-02T09:00:00.000Z" }],
      notion: { p1: "# Alpha\n\nedited" },
      rendered: { [ALPHA_PATH]: ALPHA_RENDERED },
      patchError: {
        p1: new Error(
          "notion PATCH /v1/pages/p1/markdown failed: 400 " +
          '{"code":"validation_error","message":"Cannot delete child page blocks when allow_deleting_content is false"}',
        ),
      },
    });
    const result = await runPullSync(OPTS, d.impl);

    expect(d.frozenCalls).toEqual([
      { vaultPath: ALPHA_PATH, reason: "sub-page added under a mirror row — move it out, then resolve" },
    ]);
    expect(d.errors).toEqual([]); // never the 3-strike path
    expect(d.notified[0]).toContain("sub-page added under a mirror row");
    expect(result.frozen).toBe(1);
    expect(result.errored).toBe(0);
  });

  it("takes the ordinary 3-strike path for an unrelated patch failure", async () => {
    const d = makeDeps({
      rows: [[ALPHA_PATH, makeRow({ pageId: "p1" })]],
      remote: [{ pageId: "p1", vaultPath: ALPHA_PATH, lastEditedTime: "2026-08-02T09:00:00.000Z" }],
      notion: { p1: "# Alpha\n\nedited" },
      rendered: { [ALPHA_PATH]: ALPHA_RENDERED },
      patchError: { p1: new Error("notion PATCH failed: 502 bad gateway") },
    });
    const result = await runPullSync(OPTS, d.impl);

    expect(d.frozenCalls).toEqual([]);
    expect(d.errors).toHaveLength(1);
    expect(result.errored).toBe(1);
  });
});

// ── Desk rows ────────────────────────────────────────────────────────────────

const DESK_PATH = "desks/orakel/note.md";
const DESK_BODY = "# Note\n\noriginal body";
const DESK_SOURCE = `---\ntitle: Note\n---\n\n${DESK_BODY}\n`;
const DESK_RENDERED = makeRendered(DESK_PATH, DESK_BODY, "Note", "title: Note");
const DESK_RENDER_HASH = docRenderHash(DESK_RENDERED);

function deskScenario(over: Partial<Scenario> = {}): Scenario {
  return {
    rows: [[DESK_PATH, makeRow({ pageId: "d1", direction: "two_way", mdHash: DESK_RENDER_HASH })]],
    remote: [{ pageId: "d1", vaultPath: DESK_PATH, lastEditedTime: "2026-08-02T09:00:00.000Z" }],
    notion: { d1: "# Note\n\nedited in Notion" },
    rendered: { [DESK_PATH]: DESK_RENDERED },
    sources: { [DESK_PATH]: DESK_SOURCE },
    ...over,
  };
}

describe("runPullSync — desk rows", () => {
  it("proposes the reverse-translated body with the vault render-hash as the base", async () => {
    const d = makeDeps(deskScenario());
    const result = await runPullSync(OPTS, d.impl);

    // The stored diff_preview (T6 review, F2) is the SAME text that travels
    // with the ping below — one computation, not two that could disagree.
    // No phantom trailing "- " (M4): the vault file's own closing newline is a
    // terminator, not a removed blank line.
    const expectedPreview = "- original body\n+ edited in Notion";
    expect(d.inserted).toEqual([{
      vaultPath: DESK_PATH,
      notionPageId: "d1",
      proposedBody: "# Note\n\nedited in Notion",
      baseMdHash: DESK_RENDER_HASH,
      notionHash: sha256("# Note\n\nedited in Notion"),
      diffPreview: expectedPreview,
    }]);
    expect(d.patched).toEqual([]);          // pull never writes Notion for a desk row
    expect(d.watermarks).toEqual([]);       // the watermark stays put until the proposal lands
    expect(result.proposed).toBe(1);
    // NO PING (spec §20.4, ORB-38): proposing is a DECISION request, and decisions now
    // go to Saga's DM, not #lares-alerts. The diff preview is persisted on the row (see
    // diffPreview above) — that is what her DM and the console card both render. Telling
    // him on two surfaces at once is what makes an alert channel unreadable.
    expect(d.notified).toEqual([]);
  });

  // A pulled body always comes back in the canonical block shape, so diffing it
  // against the vault file AS WRITTEN reports every re-spaced line as a change:
  // on a real vault file that turned a one-line edit into a 1549-line preview,
  // which no human can approve. Both sides of the preview therefore go through
  // the same push→pull canonicalisation, leaving only the human's own edit.
  it("previews only the Notion edit, not the block re-spacing, for a non-canonical vault file", async () => {
    const path = "desks/orakel/wrapped.md";
    // Hard-wrapped and tight — neither line is separated the way a pulled body is.
    const body = "# Note\nfirst line\nsecond line";
    const rendered = makeRendered(path, body, "Note", "title: Note");
    const d = makeDeps({
      rows: [[path, makeRow({ pageId: "w1", direction: "two_way", mdHash: docRenderHash(rendered) })]],
      remote: [{ pageId: "w1", vaultPath: path, lastEditedTime: "2026-08-02T09:00:00.000Z" }],
      notion: { w1: "# Note\nfirst line\nsecond line EDITED" },
      rendered: { [path]: rendered },
      sources: { [path]: `---\ntitle: Note\n---\n\n${body}\n` },
    });
    await runPullSync(OPTS, d.impl);

    expect(d.inserted).toHaveLength(1);
    expect(d.inserted[0].proposedBody).toBe("# Note\n\nfirst line\n\nsecond line EDITED");
    expect(d.inserted[0].diffPreview).toBe("- second line\n+ second line EDITED");
  });

  it("freezes instead of proposing when the vault moved too", async () => {
    const d = makeDeps(deskScenario({
      rows: [[DESK_PATH, makeRow({ pageId: "d1", direction: "two_way", mdHash: "hash-from-an-older-render" })]],
    }));
    const result = await runPullSync(OPTS, d.impl);

    expect(d.inserted).toEqual([]);
    expect(d.frozenCalls).toEqual([{ vaultPath: DESK_PATH, reason: "changed in both Notion and the vault" }]);
    expect(d.notified[0]).toContain("changed in both Notion and the vault");
    expect(result.frozen).toBe(1);
  });

  it("freezes when the Notion content refuses to come back (expiring URL)", async () => {
    const d = makeDeps(deskScenario({
      notion: { d1: "# Note\n\n![shot](https://file.notion.so/f/abc?X-Amz-Signature=deadbeef)" },
    }));
    const result = await runPullSync(OPTS, d.impl);

    expect(d.inserted).toEqual([]);
    expect(d.frozenCalls).toHaveLength(1);
    expect(d.frozenCalls[0].reason).toMatch(/expiring URL/i);
    expect(result.frozen).toBe(1);
  });

  it("supersedes an open proposal only when the Notion content actually changed", async () => {
    const sameHashProposal: ProposalRow = {
      id: 7, vaultPath: DESK_PATH, notionPageId: "d1",
      proposedBody: "# Note\n\nedited in Notion",
      baseMdHash: DESK_RENDER_HASH,
      notionHash: sha256("# Note\n\nedited in Notion"),
      diffPreview: "- original body\n+ edited in Notion",
      kind: "update", notionOwned: false, state: "pending", createdAt: new Date("2026-08-03T00:00:00.000Z"),
    };

    const quiet = makeDeps(deskScenario({ proposals: [sameHashProposal] }));
    const quietResult = await runPullSync(OPTS, quiet.impl);
    expect(quiet.inserted).toEqual([]);
    expect(quiet.proposalStates).toEqual([]);
    expect(quiet.notified).toEqual([]);
    expect(quietResult.awaitingApproval).toBe(1);

    const moved = makeDeps(deskScenario({
      proposals: [{ ...sameHashProposal, notionHash: "hash-of-an-earlier-notion-edit" }],
    }));
    const movedResult = await runPullSync(OPTS, moved.impl);
    expect(moved.proposalStates).toEqual([{ id: 7, state: "superseded" }]);
    expect(moved.inserted).toHaveLength(1);
    expect(movedResult.superseded).toBe(1);
    expect(movedResult.proposed).toBe(1);
  });

  // C1 (final review): the state `resolve --keep notion` leaves behind is a row
  // whose vault render does NOT match the stored md_hash (that mismatch is what
  // froze it) plus an open proposal carrying exactly the Notion content that was
  // forced. With the conflict check first, the very next pull tick re-froze the
  // row — and since apply skips non-'synced' rows, the approved proposal could
  // never land: the resolve loop had no way to converge. The open proposal is
  // therefore the FIRST question asked, before the conflict test.
  it("leaves a row alone when an open proposal already covers this Notion content, even mid-conflict", async () => {
    const notionMarkdown = "# Note\n\nedited in Notion";
    const d = makeDeps(deskScenario({
      rows: [[DESK_PATH, makeRow({
        pageId: "d1", direction: "two_way", mdHash: "hash-from-before-the-vault-was-edited",
      })]],
      proposals: [{
        id: 9, vaultPath: DESK_PATH, notionPageId: "d1",
        proposedBody: notionMarkdown,
        // A forced proposal's base is a FRESH render (cli.ts resolveFrozenDoc) —
        // deliberately not the row's stale md_hash.
        baseMdHash: DESK_RENDER_HASH,
        notionHash: sha256(notionMarkdown),
        diffPreview: "- original body\n+ edited in Notion",
        kind: "update", notionOwned: false, state: "approved", createdAt: new Date("2026-08-03T00:00:00.000Z"),
      }],
    }));
    const result = await runPullSync(OPTS, d.impl);

    expect(result.awaitingApproval).toBe(1);
    expect(result.frozen).toBe(0);
    expect(d.frozenCalls).toEqual([]);
    expect(d.inserted).toEqual([]);
    expect(d.proposalStates).toEqual([]);
    expect(d.watermarks).toEqual([]);   // the apply, not the watermark, closes this out
    expect(d.notified).toEqual([]);
  });

  // The narrowing (C1 re-review): only an APPROVED proposal earns the early
  // exit. Apply consumes an approved one earlier in the same tick; nothing
  // consumes a pending one, so leaving the row 'synced' with a stale md_hash
  // would hand the same tick's push a licence to overwrite the very Notion edit
  // the human is still judging.
  it("freezes a two-sided conflict when the proposal for this content is only PENDING", async () => {
    const notionMarkdown = "# Note\n\nedited in Notion";
    const d = makeDeps(deskScenario({
      rows: [[DESK_PATH, makeRow({
        pageId: "d1", direction: "two_way", mdHash: "hash-from-before-the-vault-was-edited",
      })]],
      proposals: [{
        id: 9, vaultPath: DESK_PATH, notionPageId: "d1",
        proposedBody: notionMarkdown,
        baseMdHash: DESK_RENDER_HASH,
        notionHash: sha256(notionMarkdown),
        diffPreview: "", kind: "update", notionOwned: false, state: "pending", createdAt: new Date("2026-08-03T00:00:00.000Z"),
      }],
    }));
    const result = await runPullSync(OPTS, d.impl);

    expect(result.frozen).toBe(1);
    expect(result.awaitingApproval).toBe(0);
    expect(d.frozenCalls).toEqual([{ vaultPath: DESK_PATH, reason: "changed in both Notion and the vault" }]);
    expect(d.inserted).toEqual([]);         // and it still never stacks
    expect(d.proposalStates).toEqual([]);
  });

  it("still freezes a two-sided conflict when the open proposal is about OTHER Notion content", async () => {
    const d = makeDeps(deskScenario({
      rows: [[DESK_PATH, makeRow({
        pageId: "d1", direction: "two_way", mdHash: "hash-from-before-the-vault-was-edited",
      })]],
      proposals: [{
        id: 9, vaultPath: DESK_PATH, notionPageId: "d1",
        proposedBody: "# Note\n\nan older Notion edit",
        baseMdHash: DESK_RENDER_HASH,
        notionHash: sha256("# Note\n\nan older Notion edit"),
        diffPreview: "", kind: "update", notionOwned: false, state: "pending", createdAt: new Date("2026-08-03T00:00:00.000Z"),
      }],
    }));
    const result = await runPullSync(OPTS, d.impl);

    expect(result.frozen).toBe(1);
    expect(d.frozenCalls).toEqual([{ vaultPath: DESK_PATH, reason: "changed in both Notion and the vault" }]);
    expect(d.inserted).toEqual([]);
  });

  it("never re-proposes content a human already rejected (the revert is still queued)", async () => {
    const notionMarkdown = "# Note\n\nedited in Notion";
    const d = makeDeps(deskScenario({
      rejected: [{
        id: 12, vaultPath: DESK_PATH, notionPageId: "d1",
        proposedBody: notionMarkdown,
        baseMdHash: DESK_RENDER_HASH,
        notionHash: sha256(notionMarkdown),
        diffPreview: "- original body\n+ edited in Notion",
        kind: "update", notionOwned: false, state: "rejected", createdAt: new Date("2026-08-03T00:00:00.000Z"),
      }],
    }));
    const result = await runPullSync(OPTS, d.impl);

    expect(d.inserted).toEqual([]);
    expect(d.notified).toEqual([]);
    expect(d.watermarks).toEqual([]);   // the revert, not the watermark, closes this out
    expect(d.frozenCalls).toEqual([]);
    expect(result.awaitingRevert).toBe(1);
    expect(result.proposed).toBe(0);
  });

  it("proposes again when the human edited the page AFTER rejecting", async () => {
    const d = makeDeps(deskScenario({
      notion: { d1: "# Note\n\na second, different edit" },
      rejected: [{
        id: 12, vaultPath: DESK_PATH, notionPageId: "d1",
        proposedBody: "# Note\n\nedited in Notion",
        baseMdHash: DESK_RENDER_HASH,
        notionHash: sha256("# Note\n\nedited in Notion"),
        diffPreview: "- original body\n+ edited in Notion",
        kind: "update", notionOwned: false, state: "rejected", createdAt: new Date("2026-08-03T00:00:00.000Z"),
      }],
    }));
    const result = await runPullSync(OPTS, d.impl);

    expect(d.inserted).toHaveLength(1);
    expect(d.inserted[0].proposedBody).toBe("# Note\n\na second, different edit");
    expect(result.proposed).toBe(1);
    expect(result.awaitingRevert).toBe(0);
  });

  it("rebuilds a wikilink from a mention: bare stem when unique, full path when not", async () => {
    const jane = "wiki/people/jane.md";
    const janeDup = "wiki/companies/jane.md";
    const unique = "wiki/people/erik.md";
    const notionBody =
      "# Note\n\nsee <mention-page url=\"https://www.notion.so/11111111111111111111111111111111\">Erik</mention-page> " +
      "and <mention-page url=\"https://www.notion.so/22222222222222222222222222222222\">Jane</mention-page>";
    const d = makeDeps(deskScenario({
      rows: [
        [DESK_PATH, makeRow({ pageId: "d1", direction: "two_way", mdHash: DESK_RENDER_HASH })],
        [unique, makeRow({ pageId: "11111111-1111-1111-1111-111111111111" })],
        [jane, makeRow({ pageId: "22222222-2222-2222-2222-222222222222" })],
        [janeDup, makeRow({ pageId: "33333333-3333-3333-3333-333333333333" })],
      ],
      remote: [
        { pageId: "d1", vaultPath: DESK_PATH, lastEditedTime: "2026-08-02T09:00:00.000Z" },
        { pageId: "11111111-1111-1111-1111-111111111111", vaultPath: unique, lastEditedTime: "2026-07-01T00:00:00.000Z" },
        { pageId: "22222222-2222-2222-2222-222222222222", vaultPath: jane, lastEditedTime: "2026-07-01T00:00:00.000Z" },
        { pageId: "33333333-3333-3333-3333-333333333333", vaultPath: janeDup, lastEditedTime: "2026-07-01T00:00:00.000Z" },
      ],
      notion: { d1: notionBody },
    }));
    await runPullSync(OPTS, d.impl);

    expect(d.inserted[0].proposedBody).toContain("[[erik]]");
    expect(d.inserted[0].proposedBody).toContain("[[wiki/people/jane]]");
  });
});

// ── Pages that vanished from Notion ──────────────────────────────────────────

describe("runPullSync — page absent from the Docs query", () => {
  it("recreates a mirror page from the vault and adopts the new page id", async () => {
    const d = makeDeps({
      rows: [
        [ALPHA_PATH, makeRow({ pageId: "gone-1" })],
        ["wiki/other.md", makeRow({ pageId: "still-here" })],
      ],
      remote: [{ pageId: "still-here", vaultPath: "wiki/other.md", lastEditedTime: "2026-07-01T00:00:00.000Z" }],
      rendered: { [ALPHA_PATH]: ALPHA_RENDERED },
      notion: { "still-here": "unchanged" },
    });
    const result = await runPullSync(OPTS, d.impl);

    expect(d.created).toEqual([{ props: ALPHA_RENDERED.props, markdown: ALPHA_MD }]);
    expect(d.upserts).toHaveLength(1);
    expect(d.upserts[0].pageId).toBe("page-new-100");
    expect(d.upserts[0].notionHash).toBe(sha256(`stored:${ALPHA_MD}`));
    expect(d.upserts[0].notionLastEdited).toBeNull();
    expect(d.archivedFiles).toEqual([]);
    expect(d.notified[0]).toContain("recreated");
    expect(result.recreated).toBe(1);
  });

  it("archives the vault file for a desk row and flags it orphaned", async () => {
    const d = makeDeps({
      rows: [
        [DESK_PATH, makeRow({ pageId: "gone-2", direction: "two_way", mdHash: DESK_RENDER_HASH })],
        ["wiki/other.md", makeRow({ pageId: "still-here" })],
      ],
      remote: [{ pageId: "still-here", vaultPath: "wiki/other.md", lastEditedTime: "2026-07-01T00:00:00.000Z" }],
      notion: { "still-here": "unchanged" },
      proposals: [{
        id: 11, vaultPath: DESK_PATH, notionPageId: "gone-2", proposedBody: "x",
        baseMdHash: DESK_RENDER_HASH, notionHash: "n", diffPreview: "", kind: "update", notionOwned: false, state: "pending",
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
      }],
    });
    const result = await runPullSync(OPTS, d.impl);

    expect(d.archivedFiles).toEqual([DESK_PATH]);
    expect(d.orphaned).toEqual([{ vaultPath: DESK_PATH, reason: "page removed in Notion — file moved to _archive/" }]);
    expect(d.created).toEqual([]);
    // The open proposal cannot outlive the file it would write.
    expect(d.proposalStates).toEqual([{ id: 11, state: "superseded" }]);
    expect(result.archived).toBe(1);
  });

  it("also retires a queued rejection for an archived desk row — no revert is owed", async () => {
    const d = makeDeps({
      rows: [
        [DESK_PATH, makeRow({ pageId: "gone-2", direction: "two_way", mdHash: DESK_RENDER_HASH })],
        ["wiki/other.md", makeRow({ pageId: "still-here" })],
      ],
      remote: [{ pageId: "still-here", vaultPath: "wiki/other.md", lastEditedTime: "2026-07-01T00:00:00.000Z" }],
      notion: { "still-here": "unchanged" },
      rejected: [{
        id: 21, vaultPath: DESK_PATH, notionPageId: "gone-2", proposedBody: "x",
        baseMdHash: DESK_RENDER_HASH, notionHash: "n", diffPreview: "", kind: "update", notionOwned: false, state: "rejected",
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
      }],
    });
    const result = await runPullSync(OPTS, d.impl);

    expect(d.archivedFiles).toEqual([DESK_PATH]);
    // A file that left the desk owes nobody a revert — the page is gone anyway.
    expect(d.proposalStates).toEqual([{ id: 21, state: "superseded" }]);
    expect(result.archived).toBe(1);
    expect(result.superseded).toBe(1);
  });
});

// ── Phase 4: notion_to_md — Notion owns the document, the vault projects it ───
//
// The direction the schema always allowed and nothing implemented. Every branch
// point tested `=== "two_way"` and treated the else as "mirror", so a Notion-owned
// row was byte-for-byte a mirror: the human's edit at the SOURCE reverted from the
// projection, hourly, with no 👍. These pin the three pull-side behaviours.

describe("runPullSync — notion_to_md rows (Notion is the source)", () => {
  function sourceScenario(over: Partial<Scenario> = {}): Scenario {
    return deskScenario({
      rows: [[DESK_PATH, makeRow({
        pageId: "d1", direction: "notion_to_md", mdHash: DESK_RENDER_HASH,
      })]],
      ...over,
    });
  }

  it("PROPOSES a Notion edit instead of reverting it — the source is not overwritten", async () => {
    const d = makeDeps(sourceScenario());
    const result = await runPullSync(OPTS, d.impl);

    // The bug this replaces: revertMirror PATCHed the page with the vault copy.
    expect(d.patched).toEqual([]);
    expect(d.upserts).toEqual([]);
    expect(result.reverted).toBe(0);

    expect(d.inserted).toEqual([{
      vaultPath: DESK_PATH,
      notionPageId: "d1",
      proposedBody: "# Note\n\nedited in Notion",
      baseMdHash: DESK_RENDER_HASH,
      notionHash: sha256("# Note\n\nedited in Notion"),
      diffPreview: "- original body\n+ edited in Notion",
    }]);
    expect(result.proposed).toBe(1);
    // No "source is the vault" ping — that sentence was the mirror's, and it was
    // the opposite of the truth here.
    expect(d.notified).toEqual([]);
  });

  it("freezes rather than merging when the vault file ALSO moved — the house rule", async () => {
    // Notion owns the document, but a local edit is still someone's work and this
    // engine has no business choosing a winner (spec §6).
    const d = makeDeps(sourceScenario({
      rows: [[DESK_PATH, makeRow({
        pageId: "d1", direction: "notion_to_md", mdHash: "hash-from-before-the-vault-was-edited",
      })]],
    }));
    const result = await runPullSync(OPTS, d.impl);

    expect(d.patched).toEqual([]);
    expect(d.inserted).toEqual([]);
    expect(d.frozenCalls).toEqual([{ vaultPath: DESK_PATH, reason: "changed in both Notion and the vault" }]);
    expect(result.frozen).toBe(1);
  });

  it("retires the vault file when the page is trashed — never recreates the page from it", async () => {
    const d = makeDeps({
      rows: [
        [DESK_PATH, makeRow({ pageId: "gone-3", direction: "notion_to_md", mdHash: DESK_RENDER_HASH })],
        ["wiki/other.md", makeRow({ pageId: "still-here" })],
      ],
      remote: [{ pageId: "still-here", vaultPath: "wiki/other.md", lastEditedTime: "2026-07-01T00:00:00.000Z" }],
      notion: { "still-here": "unchanged" },
      rendered: { [DESK_PATH]: DESK_RENDERED },
    });
    const result = await runPullSync(OPTS, d.impl);

    // The bug this replaces: `direction !== "two_way"` re-uploaded the document
    // Bendik had just deleted at its source, then pinned the row to the new page
    // so the deletion could never take.
    expect(d.created).toEqual([]);
    expect(result.recreated).toBe(0);

    expect(d.archivedFiles).toEqual([DESK_PATH]);
    expect(d.orphaned).toEqual([{
      vaultPath: DESK_PATH, reason: "page removed in Notion — file moved to _archive/",
    }]);
    expect(result.archived).toBe(1);
  });

  it("still recreates a MIRROR page — the change is scoped to the new direction", async () => {
    const d = makeDeps({
      rows: [
        [ALPHA_PATH, makeRow({ pageId: "gone-1" })],           // md_to_notion default
        ["wiki/other.md", makeRow({ pageId: "still-here" })],
      ],
      remote: [{ pageId: "still-here", vaultPath: "wiki/other.md", lastEditedTime: "2026-07-01T00:00:00.000Z" }],
      rendered: { [ALPHA_PATH]: ALPHA_RENDERED },
      notion: { "still-here": "unchanged" },
    });
    const result = await runPullSync(OPTS, d.impl);

    expect(d.created).toHaveLength(1);
    expect(result.recreated).toBe(1);
    expect(d.archivedFiles).toEqual([]);
  });
});

// ── Phase 4: paths config carved out of the desk scope ───────────────────────

/**
 * THE test ORB-39 decision 5 exists for. All 32 transcripts Phase 3 swept into
 * Docs are MIRROR rows (direction 'md_to_notion', state 'synced'), and
 * handleMissingPage recreates a mirror row's page FROM THE VAULT. So if the
 * exclusion were not honoured on this side, archiving those pages would
 * resurrect all 32 on the very next tick — which is why the exclusion ships and
 * deploys BEFORE the archival, and why this test is the phase's load-bearing one.
 */
describe("runPullSync — vault paths carved out of the desk scope (Phase 4, decision 5)", () => {
  const DESKS: DesksConfig = {
    // One dir with a carve-out and one without, so the same `transcripts/` sub-path
    // proves it is the CONFIG that excludes a path, not the folder name.
    deskDirs: [
      { dir: "desk-a", project: "A", exclude: ["transcripts"] },
      { dir: "desk-b", project: "B" },
    ],
    twoWayDirs: [],
    mirrorFilePrefixes: [],
  };
  const SCOPED: PullSyncOptions = { ...OPTS, isExcluded: makeDeskExclusion(DESKS) };

  const EXCLUDED_PATH = "desk-a/transcripts/2026-08-01-foo.md";
  const INCLUDED_PATH = "desk-b/transcripts/2026-08-01-foo.md";

  /**
   * The gone-page scenario for `path`, plus one healthy in-scope row so the pass
   * has real work to do — without it a zero-create result would also be what a
   * pass that silently did nothing at all produces.
   */
  function goneScenario(path: string): Scenario {
    return {
      rows: [
        [path, makeRow({ pageId: "gone-1" })],
        [ALPHA_PATH, makeRow({ pageId: "still-here", notionHash: sha256("unchanged") })],
      ],
      remote: [{ pageId: "still-here", vaultPath: ALPHA_PATH, lastEditedTime: "2026-08-02T00:00:00.000Z" }],
      // A render IS available for the gone path: a zero-create outcome therefore
      // cannot be blamed on an unreadable file — the exclusion is the only reason.
      rendered: { [path]: makeRendered(path) },
      notion: { "still-here": "unchanged" },
    };
  }

  it("never recreates the page of an EXCLUDED mirror row, however gone the page is", async () => {
    const d = makeDeps(goneScenario(EXCLUDED_PATH));
    const result = await runPullSync(SCOPED, d.impl);

    expect(d.created).toEqual([]);
    expect(result.recreated).toBe(0);
    // Nor any other trace: no error strike, no orphan flag, no pin, no ping.
    // An excluded row is not "handled quietly" — it is never looked at.
    expect(d.errors).toEqual([]);
    expect(d.orphaned).toEqual([]);
    expect(d.upserts).toEqual([]);
    expect(d.notified).toEqual([]);
    expect(d.calls.filter((call) => call.includes(EXCLUDED_PATH))).toEqual([]);
    // …and the pass really did run: the in-scope row was read as usual.
    expect(d.calls).toContain("read:still-here");
    // Dropped before the loop, not skipped inside it, so `scanned` reports the
    // desk scope rather than the raw table.
    expect(result.scanned).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("recreates the identical row in a dir with NO exclusion — the control", async () => {
    const d = makeDeps(goneScenario(INCLUDED_PATH));
    const result = await runPullSync(SCOPED, d.impl);

    expect(d.created).toHaveLength(1);
    expect(d.created[0].props.vaultPath).toBe(INCLUDED_PATH);
    expect(result.recreated).toBe(1);
    expect(result.scanned).toBe(2);
  });

  it("is not a mention target: an excluded page comes back as a link, not a wikilink", async () => {
    // Scoping the snapshot also scopes buildPageResolver, and that is deliberate,
    // not a side effect: the PUSH resolver is built over the pruned listing, so a
    // link to a carved-out page is an escaped literal in the vault file. If this
    // side rebuilt it as `[[…]]`, the applied body and the pushed render would
    // disagree for ever. `resolveFrozenDoc` and `enable-two-way` build the same
    // resolver from the same scoped snapshot, for the same reason (cli.ts).
    const excludedPage = "11111111-1111-1111-1111-111111111111";
    const notionBody =
      "# Note\n\nsee <mention-page url=\"https://www.notion.so/11111111111111111111111111111111\">Foo</mention-page>";
    const scenario = () => deskScenario({
      rows: [
        [DESK_PATH, makeRow({ pageId: "d1", direction: "two_way", mdHash: DESK_RENDER_HASH })],
        [EXCLUDED_PATH, makeRow({ pageId: excludedPage })],
      ],
      remote: [
        { pageId: "d1", vaultPath: DESK_PATH, lastEditedTime: "2026-08-02T09:00:00.000Z" },
        { pageId: excludedPage, vaultPath: EXCLUDED_PATH, lastEditedTime: "2026-07-01T00:00:00.000Z" },
      ],
      notion: { d1: notionBody },
    });

    const scoped = makeDeps(scenario());
    await runPullSync(SCOPED, scoped.impl);
    // Unresolved, so translate-pull keeps the label as plain text (and warns).
    expect(scoped.inserted[0].proposedBody).not.toContain("[[");
    expect(scoped.inserted[0].proposedBody).toContain("see Foo");

    // The control: the SAME mention against an unscoped pass does rebuild the
    // wikilink, so the assertion above is about the scoping and nothing else.
    const raw = makeDeps(scenario());
    await runPullSync(OPTS, raw.impl);
    expect(raw.inserted[0].proposedBody).toContain("[[2026-08-01-foo]]");
  });

  it("leaves an excluded row alone even when Notion still has the page and edited it", async () => {
    // The other half of the carve-out: not just "never recreated" but never
    // read, never reverted, never proposed on — the pass has no business here.
    const d = makeDeps({
      rows: [[EXCLUDED_PATH, makeRow({ pageId: "p-excluded" })]],
      remote: [{ pageId: "p-excluded", vaultPath: EXCLUDED_PATH, lastEditedTime: "2026-08-03T00:00:00.000Z" }],
      notion: { "p-excluded": "hand-edited in Notion" },
      rendered: { [EXCLUDED_PATH]: makeRendered(EXCLUDED_PATH) },
    });
    const result = await runPullSync(SCOPED, d.impl);

    expect(d.calls).toEqual(["queryDocs"]);
    expect(result).toMatchObject({ scanned: 0, read: 0, reverted: 0, proposed: 0, errored: 0 });
  });
});

// ── Stale freezes ────────────────────────────────────────────────────────────

describe("runPullSync — stale-freeze re-ping", () => {
  it("pings once per tick for a row frozen more than 7 days, and stays quiet for a fresh one", async () => {
    const d = makeDeps({
      rows: [[ALPHA_PATH, makeRow({ pageId: "p1", state: "frozen" })]],
      remote: [{ pageId: "p1", vaultPath: ALPHA_PATH, lastEditedTime: "2026-08-02T00:00:00.000Z" }],
      frozen: [
        { vaultPath: ALPHA_PATH, reason: "changed in both", frozenAt: new Date("2026-07-20T00:00:00.000Z") },
        { vaultPath: "wiki/fresh.md", reason: "changed in both", frozenAt: new Date("2026-08-03T00:00:00.000Z") },
      ],
    });
    const result = await runPullSync(OPTS, d.impl);

    expect(d.notified).toHaveLength(1);
    expect(d.notified[0]).toContain("still frozen: wiki/alpha.md");
    expect(result.stalePinged).toBe(1);
  });
});

// ── Stale proposals (spec §20.4) ─────────────────────────────────────────────
// This is what REPLACED the retired per-proposal ping. The rule the tests pin:
// the spine hears about a proposal only when the conversational surface has
// already asked and got no answer — never as routine traffic.

describe("runPullSync — stale-proposal escalation", () => {
  function staleProposal(over: Partial<StaleProposalRow> = {}): StaleProposalRow {
    return {
      id: 1, vaultPath: "cratedigger/brand/brand-personality.md", notionPageId: "p9",
      proposedBody: "body", baseMdHash: "base", notionHash: "notion", diffPreview: "- a\n+ b",
      kind: "update", notionOwned: false, state: "pending", createdAt: new Date("2026-08-01T09:00:00.000Z"),
      announcedAt: new Date("2026-08-01T09:05:00.000Z"),
      ...over,
    };
  }

  it("escalates a proposal Saga announced but nobody decided, naming every surface he can use", async () => {
    const d = makeDeps({ staleProposals: [staleProposal()] });
    const result = await runPullSync(OPTS, d.impl);

    expect(result.staleProposalsPinged).toBe(1);
    expect(d.notified).toHaveLength(1);
    expect(d.notified[0]).toContain("still awaiting your decision: cratedigger/brand/brand-personality.md");
    // Naming all three matters: the likeliest reason it went unanswered is that Saga's
    // DM never landed, so the message must not point only at her.
    expect(d.notified[0]).toContain("console");
    expect(d.notified[0]).toContain("notion-sync approve|reject");
  });

  it("words a NEVER-announced proposal differently — that is a broken notification path, not a slow human", async () => {
    const d = makeDeps({ staleProposals: [staleProposal({ announcedAt: null })] });
    const result = await runPullSync(OPTS, d.impl);

    expect(result.staleProposalsPinged).toBe(1);
    expect(d.notified[0]).toContain("never announced: cratedigger/brand/brand-personality.md");
    expect(d.notified[0]).toContain("NOBODY has been told");
    // Names the two things an operator must actually check.
    expect(d.notified[0]).toContain("sql/017");
    expect(d.notified[0]).toContain("notion hand");
  });

  it("survives an unmigrated database instead of aborting the whole tick", async () => {
    // announced_at does not exist until 017 is applied BY HAND on the box, so this WILL be
    // the live state for a window after the image ships. Throwing here would kill the tick
    // after all its real work, losing the pull summary and painting every cycle red.
    const d = makeDeps({});
    d.impl.getStaleProposals = async () => { throw new Error('column "announced_at" does not exist'); };
    const result = await runPullSync(OPTS, d.impl);
    expect(result.staleProposalsPinged).toBe(0);
    expect(result.summary).toContain("stale-proposal pinged");
  });

  it("stays silent when nothing is stale — a fresh proposal is routine, not an alert", async () => {
    const d = makeDeps({ staleProposals: [] });
    const result = await runPullSync(OPTS, d.impl);
    expect(result.staleProposalsPinged).toBe(0);
    expect(d.notified).toEqual([]);
  });

  it("passes the configured threshold through to the query", async () => {
    let asked: number | undefined;
    const d = makeDeps({});
    d.impl.getStaleProposals = async (hours) => { asked = hours; return []; };
    await runPullSync({ ...OPTS, staleProposalHours: 6 }, d.impl);
    expect(asked).toBe(6);

    await runPullSync(OPTS, d.impl);
    expect(asked).toBe(24);            // the default: a day
  });

  it("sends identical text every tick so the spine's fingerprint gate collapses the repeats", async () => {
    // Same trick the stale-freeze re-ping relies on. A message carrying a changing
    // "N hours ago" would defeat the dedupe and post to #lares-alerts every hour.
    const d = makeDeps({ staleProposals: [staleProposal()] });
    await runPullSync(OPTS, d.impl);
    await runPullSync({ ...OPTS, now: new Date("2026-08-04T18:00:00.000Z") }, d.impl);
    expect(d.notified[0]).toEqual(d.notified[1]);
  });

  it("is silent in dry-run — a rehearsal has no business messaging a human", async () => {
    const d = makeDeps({ staleProposals: [staleProposal()] });
    const result = await runPullSync({ ...OPTS, dryRun: true }, d.impl);
    expect(d.notified).toEqual([]);
    // Still counted, so a dry run reports what a real one would do.
    expect(result.staleProposalsPinged).toBe(1);
  });
});

// ── Containment and dry-run ──────────────────────────────────────────────────

describe("runPullSync — containment and dry-run", () => {
  it("contains a notify failure: the write still counts, the run still completes", async () => {
    const d = makeDeps({
      rows: [[ALPHA_PATH, makeRow({ pageId: "p1" })]],
      remote: [{ pageId: "p1", vaultPath: ALPHA_PATH, lastEditedTime: "2026-08-02T09:00:00.000Z" }],
      notion: { p1: "# Alpha\n\nedited" },
      rendered: { [ALPHA_PATH]: ALPHA_RENDERED },
      notifyThrows: true,
    });
    const result = await runPullSync(OPTS, d.impl);

    expect(result.reverted).toBe(1);
    expect(d.upserts).toHaveLength(1);
    expect(result.bookkeepingFailed).toBe(0); // a ping is not bookkeeping
  });

  it("counts a bookkeeping failure without aborting the run", async () => {
    const d = makeDeps({
      rows: [[ALPHA_PATH, makeRow({ pageId: "p1" })]],
      remote: [{ pageId: "p1", vaultPath: ALPHA_PATH, lastEditedTime: "2026-08-02T09:00:00.000Z" }],
      notion: { p1: "# Alpha\n\nedited" },
      rendered: { [ALPHA_PATH]: ALPHA_RENDERED },
    });
    d.impl.upsertDocSynced = async () => { throw new Error("db down"); };
    const result = await runPullSync(OPTS, d.impl);

    expect(result.reverted).toBe(1);
    expect(result.bookkeepingFailed).toBe(1);
  });

  it("dry-run plans everything and writes nothing at all", async () => {
    const d = makeDeps({
      rows: [
        [ALPHA_PATH, makeRow({ pageId: "p1" })],
        [DESK_PATH, makeRow({ pageId: "d1", direction: "two_way", mdHash: DESK_RENDER_HASH })],
        ["wiki/gone.md", makeRow({ pageId: "gone-3" })],
      ],
      remote: [
        { pageId: "p1", vaultPath: ALPHA_PATH, lastEditedTime: "2026-08-02T09:00:00.000Z" },
        { pageId: "d1", vaultPath: DESK_PATH, lastEditedTime: "2026-08-02T09:00:00.000Z" },
      ],
      notion: { p1: "# Alpha\n\nedited", d1: "# Note\n\nedited in Notion" },
      rendered: { [ALPHA_PATH]: ALPHA_RENDERED, [DESK_PATH]: DESK_RENDERED, "wiki/gone.md": makeRendered("wiki/gone.md") },
      sources: { [DESK_PATH]: DESK_SOURCE },
      frozen: [{ vaultPath: "wiki/old.md", reason: "changed in both", frozenAt: new Date("2026-07-01T00:00:00.000Z") }],
    });
    const result = await runPullSync({ ...OPTS, dryRun: true }, d.impl);

    expect(d.patched).toEqual([]);
    expect(d.propUpdates).toEqual([]);
    expect(d.created).toEqual([]);
    expect(d.inserted).toEqual([]);
    expect(d.upserts).toEqual([]);
    expect(d.watermarks).toEqual([]);
    expect(d.frozenCalls).toEqual([]);
    expect(d.orphaned).toEqual([]);
    expect(d.archivedFiles).toEqual([]);
    expect(d.proposalStates).toEqual([]);
    expect(d.notified).toEqual([]);

    expect(result.reverted).toBe(1);
    expect(result.proposed).toBe(1);
    expect(result.recreated).toBe(1);
    expect(result.stalePinged).toBe(1);
    expect(result.summary).toContain("(dry-run)");
  });
});

// ── The preview itself ───────────────────────────────────────────────────────

describe("diffPreview — a trailing newline is a terminator, not a line (M4)", () => {
  it("does not invent an empty removal line for a file's trailing newline", () => {
    // The "before" side is a vault body read off disk, so it ends in the file's
    // own newline; the "after" side is Notion's markdown, which does not. Split
    // naively, the before side grows a phantom "" line that no edit produced —
    // and every single preview in the system carried it as a spurious "- ".
    expect(diffPreview("original body\n", "edited in Notion")).toBe("- original body\n+ edited in Notion");
    expect(diffPreview("original body", "edited in Notion\n")).toBe("- original body\n+ edited in Notion");
    expect(diffPreview("a\nb\n", "a\nc\n")).toBe("- b\n+ c");
  });

  it("still reports a genuine blank-line change", () => {
    // The fix must not swallow real empty lines: only the ONE terminator newline
    // is dropped, so a paragraph break that was actually removed still shows —
    // here as the single "- " that IS the removed blank line.
    expect(diffPreview("one\n\ntwo\n", "one\ntwo\n")).toBe("- ");
  });

  it("treats an unreadable (empty) before side as zero lines, not one blank one", () => {
    expect(diffPreview("", "new line")).toBe("+ new line");
    expect(diffPreview("gone line\n", "")).toBe("- gone line");
  });

  it("keeps saying so when nothing changed", () => {
    expect(diffPreview("same\n", "same")).toBe("(no line-level changes)");
  });
});
