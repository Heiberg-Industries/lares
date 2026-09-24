// T6 (Phase 4, ORB-39) — a Notion-born page across CONSECUTIVE TICKS.
//
// Its own file, and non-negotiable, because the failure mode this phase keeps
// producing is a change that is correct for ONE tick and broken on the next: T3b
// froze every approved document a tick later, T4 permanently retired a transcript
// after a decline, and both were caught only by running several ticks in sequence.
// A create is the worst place for that class of bug — it is the one write that
// makes a file where nothing was, and a churning create would either re-ask Bendik
// hourly or leave the row frozen with a `resolve` that pushes the vault back over
// the Notion page it came from.
//
// So: the real passes, in tickPasses order, over a world that models the store's
// real KEYING — rows keyed by page (`notion_page_id` is UNIQUE table-wide),
// `vault_path` unique across targets, and the path-keyed readers derived from that
// rather than kept as a second map that could disagree.
//
// The push pass is not driven. It provably does nothing for these rows, and that is
// proven directly rather than assumed: `pushHoldBack` is asserted over the very
// snapshot these ticks produce, and wiki-sync.test.ts already proves such a path is
// never patched, never created and never Archived.
import { describe, it, expect } from "vitest";
import { makeCollisionLookup } from "./helpers/collision-world.js";
import {
  runNotionBornSync, notionBornFile, type NotionBornSyncDeps, type NotionBornSyncOptions,
} from "../lib/notion-born-sync.js";
import { runPullSync, type PullSyncDeps, type RenderedDoc } from "../lib/pull-sync.js";
import { runApplySync, type ApplySyncDeps } from "../lib/apply-sync.js";
import { renderWikiPage } from "../lib/translate.js";
import { sha256 } from "../lib/wiki-sync.js";
import { makeDeskExclusion, makeCreateScope } from "../lib/desk-scope.js";
import { pushHoldBack } from "../lib/direction.js";
import type {
  DeskRow, DocState, LinkedRow, PageStateRow, ProposalRow, ProposalState,
} from "../lib/store.js";

const CONFIG = {
  desks: {
    deskDirs: [{ dir: "alpha", project: "Alpha", exclude: ["transcripts"] }],
    twoWayDirs: [],
    mirrorFilePrefixes: [],
  },
};
const BORN_OPTS: NotionBornSyncOptions = {
  dryRun: false,
  projects: [{ notionProject: "Alpha", vaultFolder: "alpha" }],
  inCreateScope: makeCreateScope(CONFIG),
  isExcluded: makeDeskExclusion(CONFIG.desks),
};
const PULL_OPTS = {
  dryRun: false,
  now: new Date("2026-08-05T12:00:00.000Z"),
  isExcluded: makeDeskExclusion(CONFIG.desks),
};
const APPLY_OPTS = { dryRun: false, inCreateScope: makeCreateScope(CONFIG) };

const PAGE = "born-1";
const TITLE = "Løpende notater";
const PATH = "alpha/loepende-notater.md";
/** What Notion's GET /markdown returns: no H1 — the title is the `Name` property. */
const NOTION_BODY = "## Første avsnitt\n\nnoe innhold";
const NOTION_EDIT = "## Første avsnitt\n\nnoe HELT annet innhold";

/**
 * The REAL renderer, not a hand-rolled stand-in: this test's whole subject is
 * whether the hashes the three passes compute agree with each other tick after
 * tick, and a simplified render would prove that about the simplification.
 */
function render(vaultPath: string, source: string): RenderedDoc {
  const rendered = renderWikiPage(source, {
    path: vaultPath.split("/").slice(1).join("/"),
    resolve: () => null,
  });
  return {
    markdown: rendered.markdown,
    props: {
      name: rendered.title,
      project: "Alpha",
      folder: vaultPath.split("/").slice(0, -1).join("/"),
      vaultPath,
      frontmatter: rendered.frontmatter,
      archived: false,
      sync: "📥 Notion source",
    },
  };
}

interface StoredProposal extends ProposalRow {
  resolvedAt: Date | null;
}

/** One state row, keyed the way the real table is: by page. */
interface StoredRow {
  pageId: string;
  target: "docs" | "meetings";
  vaultPath: string | null;
  mdHash: string | null;
  notionHash: string | null;
  notionLastEdited: string | null;
  state: DocState;
  direction: string;
}

/**
 * `folder` is the Notion `Folder` property — empty in every scenario but the
 * ancestor-directory one, where the target has to sit inside a sub-folder for an
 * ancestor to exist at all.
 */
function makeWorld(folder = "") {
  const rowsByPage = new Map<string, StoredRow>();
  const proposals: StoredProposal[] = [];
  const notion = new Map<string, { markdown: string; lastEditedTime: string }>();
  const vault = new Map<string, string>();
  const notifications: string[] = [];
  const frozen: Array<{ vaultPath: string; reason: string }> = [];
  /** Every request that would MUTATE Notion. Must stay empty for this direction. */
  const notionWrites: string[] = [];
  let nextProposalId = 1;
  let clock = 0;

  const stamp = (): string => {
    clock += 1;
    return `2026-08-05T1${clock}:00:00.000Z`;
  };

  notion.set(PAGE, { markdown: NOTION_BODY, lastEditedTime: "2026-08-05T10:00:00.000Z" });

  /** The path-keyed views, DERIVED — never a second map that could disagree. */
  const linked = (): Map<string, LinkedRow> => {
    const out = new Map<string, LinkedRow>();
    for (const row of rowsByPage.values()) {
      if (row.vaultPath === null) continue;
      out.set(row.vaultPath, {
        pageId: row.pageId, mdHash: row.mdHash, notionHash: row.notionHash,
        notionLastEdited: row.notionLastEdited, state: row.state,
        direction: row.direction, target: row.target,
      });
    }
    return out;
  };
  const desk = (): Map<string, DeskRow> => {
    const out = new Map<string, DeskRow>();
    for (const [path, row] of linked()) {
      if (row.target !== "docs") continue;
      const { target: _target, ...deskRow } = row;
      out.set(path, deskRow);
    }
    return out;
  };
  const pageRows = (): Map<string, PageStateRow> => {
    const out = new Map<string, PageStateRow>();
    for (const row of rowsByPage.values()) {
      out.set(row.pageId, {
        pageId: row.pageId, target: row.target,
        vaultPath: row.vaultPath, notionHash: row.notionHash,
      });
    }
    return out;
  };

  const shared = {
    getDeskRows: async () => desk(),
    getLinkedRows: async () => linked(),
    getOpenProposals: async () =>
      proposals.filter((p) => p.state === "pending" || p.state === "approved").map((p) => ({ ...p })),
    getRejectedUnexecuted: async () =>
      proposals.filter((p) => p.state === "rejected" && p.resolvedAt === null).map((p) => ({ ...p })),
    setProposalState: async (id: number, state: ProposalState) => {
      const proposal = proposals.find((p) => p.id === id);
      if (proposal === undefined) throw new Error(`no proposal ${id}`);
      proposal.state = state;
      if (state === "applied" || state === "superseded") proposal.resolvedAt = new Date();
    },
    markProposalReverted: async (id: number) => {
      const proposal = proposals.find((p) => p.id === id);
      if (proposal === undefined) throw new Error(`no proposal ${id}`);
      if (proposal.state === "rejected" && proposal.resolvedAt === null) proposal.resolvedAt = new Date();
    },
    getPageMarkdown: async (pageId: string) => {
      const page = notion.get(pageId);
      if (page === undefined) throw new Error(`no such page ${pageId}`);
      return page.markdown;
    },
    patchPageMarkdown: async (pageId: string, markdown: string) => {
      notionWrites.push(`PATCH markdown ${pageId}`);
      notion.set(pageId, { markdown: `stored:${markdown}`, lastEditedTime: stamp() });
    },
    updateDocProps: async (pageId: string) => { notionWrites.push(`PATCH props ${pageId}`); },
    renderDoc: async (vaultPath: string) => {
      const source = vault.get(vaultPath);
      if (source === undefined) throw new Error(`ENOENT: ${vaultPath}`);
      return render(vaultPath, source);
    },
    readVaultFile: async (vaultPath: string) => {
      const source = vault.get(vaultPath);
      if (source === undefined) throw new Error(`ENOENT: ${vaultPath}`);
      return source;
    },
    upsertDocSynced: async (doc: {
      vaultPath: string; pageId: string; mdHash: string;
      notionHash: string; notionLastEdited: string | null; direction?: string;
    }) => {
      const existing = rowsByPage.get(doc.pageId);
      rowsByPage.set(doc.pageId, {
        pageId: doc.pageId,
        target: existing?.target ?? "docs",
        vaultPath: doc.vaultPath,
        mdHash: doc.mdHash,
        notionHash: doc.notionHash,
        notionLastEdited: doc.notionLastEdited ?? existing?.notionLastEdited ?? null,
        state: existing?.state === "frozen" ? "frozen" : "synced",
        // Ignored on conflict, exactly like the store's ON CONFLICT branch.
        direction: existing?.direction ?? doc.direction ?? "md_to_notion",
      });
    },
    // Keyed on the PAGE, like the real statement — which is the whole reason a
    // create can land on a row that already exists with a NULL vault_path.
    linkPageToVaultFile: async (doc: {
      vaultPath: string; pageId: string; mdHash: string; notionHash: string;
      notionLastEdited: string | null; direction?: string; writtenBodyHash: string;
    }) => {
      const existing = rowsByPage.get(doc.pageId);
      rowsByPage.set(doc.pageId, {
        pageId: doc.pageId,
        target: existing?.target ?? "docs",
        vaultPath: doc.vaultPath,
        // A DOCS row keeps the push render hash; only a meetings row takes the
        // written-body hash (the store's CASE). Every row here is a docs row.
        mdHash: existing?.target === "meetings" ? doc.writtenBodyHash : doc.mdHash,
        notionHash: doc.notionHash,
        notionLastEdited: doc.notionLastEdited ?? existing?.notionLastEdited ?? null,
        state: existing?.state ?? "synced",
        direction: existing?.direction ?? doc.direction ?? "md_to_notion",
      });
    },
    updateNotionWatermark: async (vaultPath: string, notionHash: string, notionLastEdited: string | null) => {
      for (const row of rowsByPage.values()) {
        if (row.vaultPath === vaultPath) {
          row.notionHash = notionHash;
          row.notionLastEdited = notionLastEdited;
        }
      }
    },
    // The real one THROWS on a zero-row match — that throw is the whole enforcement
    // of "a create proposer must ensure a state row exists BEFORE proposing", so a
    // forgiving stand-in here would test a contract nobody has to keep.
    recordNotionAccounted: async (pageId: string, notionHash: string) => {
      const row = rowsByPage.get(pageId);
      if (row === undefined) throw new Error(`notion-sync: no state row for ${pageId}`);
      row.notionHash = notionHash;
    },
    freezeDoc: async (vaultPath: string, reason: string) => {
      for (const row of rowsByPage.values()) {
        if (row.vaultPath === vaultPath) row.state = "frozen";
      }
      frozen.push({ vaultPath, reason });
    },
    recordDocError: async () => {},
    notify: async (message: string) => { notifications.push(message); },
  };

  const remoteRows = (): Array<{
    pageId: string; vaultPath: string; lastEditedTime: string;
    title: string; project: string | null; folder: string;
  }> => [...notion].map(([pageId, page]) => {
    const row = rowsByPage.get(pageId);
    return {
      pageId,
      // Notion's own `Vault Path` property: written by the push pass once a file
      // exists, empty for a page a human made. Modelled off the store's linkage,
      // which is what the real push writes it from.
      vaultPath: row?.vaultPath ?? "",
      lastEditedTime: page.lastEditedTime,
      title: TITLE,
      project: "Alpha",
      folder,
    };
  });

  const bornDeps: NotionBornSyncDeps = {
    queryDocs: async () => remoteRows(),
    getPageRows: async () => pageRows(),
    getDeskRows: shared.getDeskRows,
    getOpenProposals: shared.getOpenProposals,
    getRejectedUnexecuted: shared.getRejectedUnexecuted,
    getPageMarkdown: shared.getPageMarkdown,
    vaultFileExists: async (vaultPath: string) => vault.has(vaultPath),
    listVaultFiles: async () => [...vault.keys()],
    ensureDocsRow: async (pageId: string) => {
      if (rowsByPage.has(pageId)) return;
      rowsByPage.set(pageId, {
        pageId, target: "docs", vaultPath: null, mdHash: null, notionHash: null,
        notionLastEdited: null, state: "synced", direction: "notion_to_md",
      });
    },
    insertProposal: async (input) => {
      const id = nextProposalId++;
      const boundRow = [...rowsByPage.values()].find((r) => r.vaultPath === input.vaultPath);
      proposals.push({
        ...input,
        diffPreview: input.diffPreview ?? "",
        kind: input.kind ?? "update",
        // The LEFT JOIN's own semantics: a create has no path-bearing row yet.
        notionOwned: boundRow?.direction === "notion_to_md",
        id, state: "pending", createdAt: new Date(), resolvedAt: null,
      });
      return id;
    },
    setProposalState: shared.setProposalState,
  };

  const pullDeps: PullSyncDeps = {
    ...shared,
    queryDocs: async () => remoteRows(),
    getStaleProposals: async () => [],
    getFrozenDocs: async () => [],
    createDocPage: async () => {
      notionWrites.push("POST /v1/pages");
      return { pageId: "should-never-happen" };
    },
    archiveVaultFile: async (vaultPath: string) => { vault.delete(vaultPath); },
    insertProposal: bornDeps.insertProposal,
    // Faithful to the real statement, and the fidelity is the point of the Important
    // B scenario below: `markDocOrphaned` sets the state and KEEPS `vault_path`. The
    // row goes on owning a path whose file has been retired to `_archive/`.
    markDocOrphaned: async (vaultPath: string) => {
      for (const r of rowsByPage.values()) {
        if (r.vaultPath === vaultPath) r.state = "unmatched";
      }
    },
  };

  const applyDeps: ApplySyncDeps = {
    ...shared,
    writeVaultFile: async (vaultPath: string, content: string) => { vault.set(vaultPath, content); },
    vaultFileExists: async (vaultPath: string) => vault.has(vaultPath),
    // Guard 3b's input, from the SAME world `vaultFileExists` answers for — two
    // different worlds here would let the two halves of one guard agree by accident.
    // One shared model (tests/helpers/collision-world.ts); see its header for what it
    // does and does not model.
    listCollisionCandidates: makeCollisionLookup(() => vault.keys()),
    createVaultFile: async (vaultPath: string, content: string) => {
      // O_EXCL, modelled: the adapter refuses outright rather than overwriting.
      if (vault.has(vaultPath)) throw new Error(`a file already exists at ${vaultPath}`);
      vault.set(vaultPath, content);
    },
    // Not this seam's concern — the forget-ledger gate is covered end to end in
    // tests/forget-ledger-gate.test.ts.
    pathWasForgotten: async () => null,
  };

  /** One tick, in tickPasses order minus the push that holds these rows back. */
  async function tick(): Promise<void> {
    await runNotionBornSync(BORN_OPTS, bornDeps);
    await runPullSync(PULL_OPTS, pullDeps);
    await runApplySync(APPLY_OPTS, applyDeps);
  }

  return {
    rowsByPage, proposals, notion, vault, notifications, frozen, notionWrites,
    tick, stamp, linked, desk,
    // Exposed so a scenario can run ONE pass and read its result (the skip reasons),
    // which `tick()` deliberately discards.
    bornDeps,
  };
}

const EXPECTED_FILE = notionBornFile({ title: TITLE, body: NOTION_BODY, pageId: PAGE });

describe("a Notion-born page, approved, across five ticks", () => {
  it("is created once and then goes quiet — no repeat proposal, no freeze, no churn, no Notion write", async () => {
    const w = makeWorld();

    // ── TICK 1 — proposed. Nothing is written anywhere. ──────────────────────
    await w.tick();
    expect(w.proposals).toHaveLength(1);
    expect(w.proposals[0].kind).toBe("create");
    expect(w.proposals[0].vaultPath).toBe(PATH);
    expect(w.proposals[0].baseMdHash).toBe("");
    expect(w.proposals[0].state).toBe("pending");
    expect([...w.vault.keys()]).toEqual([]);
    expect(w.frozen).toEqual([]);
    // The state row exists (the decision has somewhere to live) and carries no file.
    expect(w.rowsByPage.get(PAGE)?.vaultPath).toBeNull();

    // A second tick BEFORE he decides must not stack a duplicate.
    await w.tick();
    expect(w.proposals).toHaveLength(1);
    expect([...w.vault.keys()]).toEqual([]);

    // Bendik taps 👍.
    w.proposals[0].state = "approved";

    // ── TICK 2 — apply creates the file. ─────────────────────────────────────
    await w.tick();
    expect(w.vault.get(PATH)).toBe(`${EXPECTED_FILE}\n`);
    expect(w.proposals[0].state).toBe("applied");
    expect(w.frozen).toEqual([]);
    // …bound to the page it came from, Notion-owned, on ONE row.
    expect(w.rowsByPage.size).toBe(1);
    const row = w.rowsByPage.get(PAGE);
    expect(row?.vaultPath).toBe(PATH);
    expect(row?.direction).toBe("notion_to_md");
    expect(row?.target).toBe("docs");
    expect(row?.state).toBe("synced");

    // ── TICK 3 — THE TEST. Nothing changed on either side, so this must be a
    // no-op: no second create (the page now has a file), no phantom update from
    // pull (the stored hash is the one pull computes), no freeze.
    await w.tick();
    expect(w.proposals).toHaveLength(1);
    expect(w.frozen).toEqual([]);
    expect(w.rowsByPage.get(PAGE)?.state).toBe("synced");
    expect(w.vault.get(PATH)).toBe(`${EXPECTED_FILE}\n`);

    // ── TICKS 4 and 5 — because a two-tick oscillation still passes three. ───
    const hashesAfterThree = { ...w.rowsByPage.get(PAGE) };
    await w.tick();
    await w.tick();
    expect(w.proposals).toHaveLength(1);
    expect(w.frozen).toEqual([]);
    expect(w.vault.get(PATH)).toBe(`${EXPECTED_FILE}\n`);
    // The hashes converged and STOPPED: identical after tick 5 and after tick 3.
    expect({ ...w.rowsByPage.get(PAGE) }).toEqual(hashesAfterThree);

    // Nothing was ever written to Notion, on any tick.
    expect(w.notionWrites).toEqual([]);
    expect(w.notion.get(PAGE)?.markdown).toBe(NOTION_BODY);
    // …and the push pass, which this world does not drive, structurally cannot:
    // the path is in the hold-back set derived from the very snapshot above.
    expect(pushHoldBack(w.linked()).has(PATH)).toBe(true);

    // No freeze ping, and above all no "resolve with:" — that command's `--keep md`
    // is the one thing that would push this vault file over its own Notion source.
    expect(w.notifications.filter((n) => /frozen|resolve with/i.test(n))).toEqual([]);
  });

  it("the created file's title survives the round trip through extractTitle", async () => {
    const w = makeWorld();
    await w.tick();
    w.proposals[0].state = "approved";
    await w.tick();

    // At rest: `extractTitle` reads frontmatter `title:` first, and it says exactly
    // what Notion's `Name` property says. The H1 says the same thing.
    expect(render(PATH, w.vault.get(PATH) as string).props.name).toBe(TITLE);
    expect(w.vault.get(PATH)).toContain(`# ${TITLE}`);

    // Now Bendik edits the page in Notion, and approves what comes back.
    w.notion.set(PAGE, { markdown: NOTION_EDIT, lastEditedTime: w.stamp() });
    await w.tick();
    expect(w.proposals).toHaveLength(2);
    expect(w.proposals[1].kind).toBe("update");
    w.proposals[1].state = "approved";
    await w.tick();

    expect(w.vault.get(PATH)).toContain("HELT annet");
    // THE NAMED COST, pinned rather than left to be discovered: the desk pull writes
    // `frontmatter-from-disk + Notion's body`, and Notion's body has no H1 — it
    // cannot have one, the API drops it. So the visible heading goes…
    expect(w.vault.get(PATH)).not.toContain(`# ${TITLE}`);
    // …and the title does NOT, because frontmatter is the half an update cannot
    // reach. Without the `title:` key this would now read "loepende-notater".
    expect(render(PATH, w.vault.get(PATH) as string).props.name).toBe(TITLE);

    // …and it settles again: two more quiet ticks, no freeze, no third proposal.
    await w.tick();
    await w.tick();
    expect(w.proposals).toHaveLength(2);
    expect(w.frozen).toEqual([]);
    expect(w.notionWrites).toEqual([]);
  });
});

describe("a Notion-born page, rejected", () => {
  it("is not created, is not asked about again, and a later edit still asks — over seven ticks", async () => {
    const w = makeWorld();

    await w.tick();
    expect(w.proposals).toHaveLength(1);
    w.proposals[0].state = "rejected";                    // 👎

    // TICK 2 — the tick that carries the rejection out. The proposer runs BEFORE
    // apply, so without `getRejectedUnexecuted` it would re-ask here, in the same
    // tick the decline is being recorded.
    await w.tick();
    expect(w.proposals).toHaveLength(1);
    expect(w.proposals[0].resolvedAt).not.toBeNull();
    expect([...w.vault.keys()]).toEqual([]);
    // The decline is REMEMBERED on the state row, keyed by page — the only key a
    // rejected create has, since no vault file and so no path-bearing row exists.
    expect(w.rowsByPage.get(PAGE)?.notionHash).toBe(sha256(NOTION_BODY));

    // TICKS 3, 4, 5 — silent. This is the loop T3b could not close from where it
    // stood and T4 settled: "reject means not this content", remembered durably.
    await w.tick();
    await w.tick();
    await w.tick();
    expect(w.proposals).toHaveLength(1);
    expect([...w.vault.keys()]).toEqual([]);
    expect(w.frozen).toEqual([]);

    // TICK 6 — a LATER edit to the same page IS a fresh question.
    w.notion.set(PAGE, { markdown: NOTION_EDIT, lastEditedTime: w.stamp() });
    await w.tick();
    expect(w.proposals).toHaveLength(2);
    expect(w.proposals[1].state).toBe("pending");
    expect(w.proposals[1].kind).toBe("create");

    // TICK 7 — and a second rejection settles the same way.
    w.proposals[1].state = "rejected";
    await w.tick();
    await w.tick();
    expect(w.proposals).toHaveLength(2);
    expect([...w.vault.keys()]).toEqual([]);
    expect(w.notionWrites).toEqual([]);
  });
});

describe("a Notion-born page whose slug collides with a hand-written note", () => {
  it("never overwrites it, on any tick, and keeps saying why", async () => {
    const w = makeWorld();
    w.vault.set(PATH, "# My own note\n\nhand-written, hours of work\n");

    for (let i = 0; i < 4; i += 1) await w.tick();

    expect(w.proposals).toEqual([]);
    expect(w.vault.get(PATH)).toBe("# My own note\n\nhand-written, hours of work\n");
    expect(w.rowsByPage.size).toBe(0);            // no row was even created for it
    expect(w.notionWrites).toEqual([]);
  });

  // Review round 2. The seam's vault is a JS Map — case-SENSITIVE, exactly like the
  // box's ext4 — so `vaultFileExists` genuinely cannot see this collision and guard
  // 3b is the only thing standing between the approval and a shadowed note. That is
  // what makes this the realistic end-to-end shape rather than a unit case.
  it("refuses at APPLY time when a CASE-VARIANT file appears between propose and approve", async () => {
    const w = makeWorld();
    await w.tick();
    expect(w.proposals).toHaveLength(1);

    // He reads the DM naming `alpha/loepende-notater.md` — and goes and writes his
    // own note about it, capitalised the way he types.
    const handWritten = "alpha/Loepende-Notater.md";
    w.vault.set(handWritten, "# Mine egne notater\n");
    w.proposals[0].state = "approved";

    await w.tick();

    // Nothing was created, his file is byte-identical, and the tap is closed with a
    // reason rather than left to retry forever.
    expect([...w.vault.keys()]).toEqual([handWritten]);
    expect(w.vault.get(handWritten)).toBe("# Mine egne notater\n");
    expect(w.proposals[0].state).toBe("superseded");
    expect(w.rowsByPage.get(PAGE)?.vaultPath).toBeNull();
    expect(w.notifications.some((n) => /SAME FILE as that path on macOS/.test(n))).toBe(true);

    // …and the next tick does not quietly try again behind his back: the propose-side
    // half now sees the file too and says so.
    const after = await runNotionBornSync(BORN_OPTS, w.bornDeps);
    expect(after.proposed).toBe(0);
    expect(after.skipped[0].reason).toMatch(/SAME FILE as that path on macOS/);
    expect(w.notionWrites).toEqual([]);
  });

  // ROUND 3's Important 1, end to end. The seam's vault is a JS Map — case-SENSITIVE
  // exactly like the box's ext4 — and the variant is in an ancestor DIRECTORY, which
  // is the shape round 2's apply-side predicate could not see at all.
  it("refuses at APPLY time when a CASE-VARIANT ANCESTOR DIRECTORY appears between propose and approve", async () => {
    const w = makeWorld("alpha/prosjekt");
    await w.tick();
    expect(w.proposals).toHaveLength(1);
    expect(w.proposals[0].vaultPath).toBe("alpha/prosjekt/loepende-notater.md");

    // He reads the DM naming `alpha/prosjekt/…` and makes the folder himself, typed
    // the way he types — which is the ordinary way to file a new page.
    const his = "alpha/Prosjekt/Loepende-Notater.md";
    w.vault.set(his, "# Mine egne notater\n");
    w.proposals[0].state = "approved";

    await w.tick();

    expect([...w.vault.keys()]).toEqual([his]);
    expect(w.vault.get(his)).toBe("# Mine egne notater\n");
    expect(w.proposals[0].state).toBe("superseded");
    expect(w.rowsByPage.get(PAGE)?.vaultPath).toBeNull();
    expect(w.notifications.some((n) => /SAME FILE as that path on macOS/.test(n))).toBe(true);
    expect(w.notionWrites).toEqual([]);
  });

  it("refuses at APPLY time too, when the file appears between propose and approve", async () => {
    // The TOCTOU shape, driven through T6's own proposal rather than a hand-made
    // one: valid when proposed, occupied by the time Bendik taps Approve.
    const w = makeWorld();
    await w.tick();
    expect(w.proposals).toHaveLength(1);

    w.vault.set(PATH, "# Written by hand while the DM sat unread\n");
    w.proposals[0].state = "approved";

    await w.tick();
    expect(w.vault.get(PATH)).toBe("# Written by hand while the DM sat unread\n");
    expect(w.proposals[0].state).toBe("superseded");
    expect(w.rowsByPage.get(PAGE)?.vaultPath).toBeNull();
    expect(w.notifications.some((n) => /already exists/i.test(n))).toBe(true);
  });
});

// ── Round 1, Important B ─────────────────────────────────────────────────────
describe("a Notion-born page whose derived path a RETIRED row still owns", () => {
  it("is refused with a visible skip instead of being re-proposed every tick", async () => {
    // The shape, and it is ordinary rather than contrived: a page is created, Bendik
    // trashes it in Notion, pull retires the file to `_archive/` and leaves the row
    // at the old path — then he makes a NEW page with the same title. Nothing is on
    // disk at that path, so the overwrite guard says "go ahead"; only the ROW knows.
    //
    // Before the fix this ran forever: propose → approve → apply's guard 0
    // supersedes → propose again, next tick, with `skipped: []` — neither proposed
    // successfully nor reported, which breaks both "never re-propose" and "every
    // skip is visible".
    const w = makeWorld();

    // Ticks 1–2: the first page lands.
    await w.tick();
    w.proposals[0].state = "approved";
    await w.tick();
    expect(w.vault.has(PATH)).toBe(true);

    // He makes a NEW page with the same title, and trashes the old one. (Both in one
    // step because pull refuses to treat an EMPTY Docs query as "everything was
    // deleted" — its own guard, and a faithful world has to satisfy it.)
    w.notion.set("born-2", { markdown: NOTION_BODY, lastEditedTime: w.stamp() });
    w.notion.delete(PAGE);

    // Pull retires the file to `_archive/` and orphans the row — which KEEPS its
    // vault_path. That is the whole premise: nothing is on disk at PATH any more.
    await w.tick();
    expect(w.vault.has(PATH)).toBe(false);
    expect(w.rowsByPage.get(PAGE)?.vaultPath).toBe(PATH);   // the row still owns it

    // Four ticks. Nothing is proposed, and every one of them SAYS WHY.
    const reasons: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const result = await runNotionBornSync(BORN_OPTS, w.bornDeps);
      await w.tick();
      expect(result.proposed).toBe(0);
      expect(result.skipped).toHaveLength(1);
      reasons.push(result.skipped[0].reason);
    }
    expect(reasons.every((r) => /still tracks that path/.test(r))).toBe(true);
    // One proposal in the whole run — the original create. No loop.
    expect(w.proposals).toHaveLength(1);
    expect(w.notionWrites).toEqual([]);
  });
});

// ── Round 1, Important A ─────────────────────────────────────────────────────
describe("a Notion-born page whose slug collides only by CASE with a hand-written note", () => {
  it("is refused on every tick, so the box never commits two files that are one on APFS", async () => {
    const w = makeWorld();
    // What the box's own `lstat` cannot see: `Løpende Notater.md` does not answer to
    // `loepende-notater.md` on ext4.
    w.vault.set("alpha/Loepende-Notater.md", "# Mine egne notater\n");

    const reasons: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const result = await runNotionBornSync(BORN_OPTS, w.bornDeps);
      await w.tick();
      reasons.push(...result.skipped.map((s) => s.reason));
    }

    expect(w.proposals).toEqual([]);
    // Only the human's file exists — the commit the box would push holds ONE of them.
    expect([...w.vault.keys()]).toEqual(["alpha/Loepende-Notater.md"]);
    expect(reasons).toHaveLength(4);
    expect(reasons.every((r) => /SAME FILE as that path on macOS/.test(r))).toBe(true);
  });
});
