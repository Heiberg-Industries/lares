// The seam the two engines share: one rejected proposal, seen by BOTH passes
// across consecutive ticks. Neither engine's own unit tests can catch what goes
// wrong here — pull re-proposing what a human just rejected (because a rejection
// is invisible to getOpenProposals), or apply reverting a page that has moved on
// since — so this file drives the real runPullSync and runApplySync over one
// shared in-memory world that behaves like the store, Notion and the vault do.
import { describe, it, expect } from "vitest";
import { makeCollisionLookup } from "./helpers/collision-world.js";
import { runPullSync, docRenderHash, type PullSyncDeps, type RenderedDoc } from "../lib/pull-sync.js";
import { runApplySync, type ApplySyncDeps } from "../lib/apply-sync.js";
import { sha256 } from "../lib/wiki-sync.js";
import { makeDeskExclusion, makeCreateScope } from "../lib/desk-scope.js";
import type { DeskRow, ProposalRow, ProposalState } from "../lib/store.js";

// This world configures no desk folders, so nothing is carved out of the desk
// scope — built through the real derivation rather than a hand-written `() =>
// false` so the seam runs what the composition root runs (desk-scope.ts).
const PULL_OPTS = {
  dryRun: false,
  now: new Date("2026-08-04T12:00:00.000Z"),
  isExcluded: makeDeskExclusion(undefined),
};

const PATH = "desks/orakel/note.md";
const PAGE = "d1";
const VAULT_SOURCE = "---\ntitle: Note\n---\n\n# Note\n\nthe vault's version\n";
const VAULT_BODY = "# Note\n\nthe vault's version";
const HUMAN_EDIT = "# Note\n\nwhat a human typed in Notion";

function render(vaultPath: string, source: string): RenderedDoc {
  // Stands in for the composition root's push render: body after the frontmatter,
  // properties built from the same two fields the push pass hashes.
  const match = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(source);
  const frontmatter = match === null ? "" : match[1];
  const body = (match === null ? source : match[2]).replace(/\n+$/, "");
  return {
    markdown: body,
    props: {
      name: "Note", project: "Orakel", folder: "desks/orakel", vaultPath,
      frontmatter, archived: false, sync: "✍️ Desk",
    },
  };
}

interface StoredProposal extends ProposalRow {
  resolvedAt: Date | null;
}

/** Store + Notion + vault, small enough to reason about, faithful where it counts. */
function makeWorld() {
  const rows = new Map<string, DeskRow>();
  const frozenAt = new Map<string, Date>();
  const proposals: StoredProposal[] = [];
  const notion = new Map<string, { markdown: string; lastEditedTime: string }>();
  const vault = new Map<string, string>();
  const notifications: string[] = [];
  let nextProposalId = 1;
  let clock = 0;

  const stamp = (): string => {
    clock += 1;
    return `2026-08-04T1${clock}:00:00.000Z`;
  };

  const pageMarkdown = (pageId: string): string => {
    const page = notion.get(pageId);
    if (page === undefined) throw new Error(`no such page ${pageId}`);
    return page.markdown;
  };

  function writeNotion(pageId: string, markdown: string): void {
    // Notion normalises what it stores; the read-back is never the pushed bytes.
    notion.set(pageId, { markdown: `stored:${markdown}`, lastEditedTime: stamp() });
  }

  const shared = {
    getDeskRows: async () => new Map(rows),
    // Widened in Phase 4 to carry BOTH targets. Every row in this world is a desk
    // document, so the map is the same one with its target stated.
    getLinkedRows: async () =>
      new Map([...rows].map(([path, row]) => [path, { ...row, target: "docs" as const }])),
    getOpenProposals: async () =>
      proposals.filter((p) => p.state === "pending" || p.state === "approved").map((p) => ({ ...p })),
    getRejectedUnexecuted: async () =>
      proposals.filter((p) => p.state === "rejected" && p.resolvedAt === null).map((p) => ({ ...p })),
    setProposalState: async (id: number, state: ProposalState) => {
      const proposal = proposals.find((p) => p.id === id);
      if (proposal === undefined) throw new Error(`no proposal ${id}`);
      proposal.state = state;
      // Mirrors store.ts: 'rejected' is deliberately NOT stamped — the revert is.
      if (state === "applied" || state === "superseded") proposal.resolvedAt = new Date();
    },
    markProposalReverted: async (id: number) => {
      const proposal = proposals.find((p) => p.id === id);
      if (proposal === undefined) throw new Error(`no proposal ${id}`);
      if (proposal.state === "rejected" && proposal.resolvedAt === null) proposal.resolvedAt = new Date();
    },
    getPageMarkdown: async (pageId: string) => pageMarkdown(pageId),
    patchPageMarkdown: async (pageId: string, markdown: string) => writeNotion(pageId, markdown),
    updateDocProps: async () => {},
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
      notionHash: string; notionLastEdited: string | null;
    }) => {
      const existing = rows.get(doc.vaultPath);
      rows.set(doc.vaultPath, {
        pageId: doc.pageId,
        mdHash: doc.mdHash,
        notionHash: doc.notionHash,
        // The store COALESCEs: a null means "took no reading", never "erase".
        notionLastEdited: doc.notionLastEdited ?? existing?.notionLastEdited ?? null,
        state: existing?.state === "frozen" ? "frozen" : "synced",
        direction: existing?.direction ?? "md_to_notion",
      });
    },
    updateNotionWatermark: async (vaultPath: string, notionHash: string, notionLastEdited: string | null) => {
      const row = rows.get(vaultPath);
      if (row !== undefined) rows.set(vaultPath, { ...row, notionHash, notionLastEdited });
    },
    // Phase 4: the create branch and the Notion-owned hash refresh both go through
    // the PAGE-keyed upsert now. No row in this world is keyed any other way, so
    // this is the path-keyed body with the same effect.
    linkPageToVaultFile: async (doc: {
      vaultPath: string; pageId: string; mdHash: string;
      notionHash: string; notionLastEdited: string | null; writtenBodyHash: string;
    }) => {
      // Every row in this world is a DOCS row, so the store's md_hash CASE takes
      // the render hash and `writtenBodyHash` is carried but unused — asserted by
      // its absence below rather than silently dropped.
      void doc.writtenBodyHash;
      const existing = rows.get(doc.vaultPath);
      rows.set(doc.vaultPath, {
        pageId: doc.pageId,
        mdHash: doc.mdHash,
        notionHash: doc.notionHash,
        notionLastEdited: doc.notionLastEdited ?? existing?.notionLastEdited ?? null,
        state: existing?.state ?? "synced",
        direction: existing?.direction ?? "md_to_notion",
      });
    },
    recordNotionAccounted: async () => {},
    freezeDoc: async (vaultPath: string, _reason: string) => {
      const row = rows.get(vaultPath);
      if (row !== undefined) rows.set(vaultPath, { ...row, state: "frozen" });
      if (!frozenAt.has(vaultPath)) frozenAt.set(vaultPath, new Date());
    },
    recordDocError: async () => {},
    notify: async (message: string) => { notifications.push(message); },
  };

  const pullDeps: PullSyncDeps = {
    ...shared,
    queryDocs: async () => [...notion].map(([pageId, page]) => ({
      pageId,
      vaultPath: [...rows].find(([, row]) => row.pageId === pageId)?.[0] ?? "",
      lastEditedTime: page.lastEditedTime,
    })),
    getStaleProposals: async () => [],
    getFrozenDocs: async () => [...frozenAt].map(([vaultPath, at]) => ({
      vaultPath, reason: null, frozenAt: at,
    })),
    createDocPage: async () => { throw new Error("not exercised here"); },
    archiveVaultFile: async (vaultPath: string) => { vault.delete(vaultPath); },
    insertProposal: async (input) => {
      const id = nextProposalId++;
      // Mirrors store.ts's own `?? ""` / `?? "update"` (the columns' 016/018 defaults).
      proposals.push({
        ...input, diffPreview: input.diffPreview ?? "", kind: input.kind ?? "update", notionOwned: false,
        id, state: "pending", createdAt: new Date(), resolvedAt: null,
      });
      return id;
    },
    updateNotionWatermark: async (vaultPath, notionHash, notionLastEdited) => {
      const row = rows.get(vaultPath);
      if (row !== undefined) rows.set(vaultPath, { ...row, notionHash, notionLastEdited });
    },
    markDocOrphaned: async () => {},
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
    // The adapter's O_EXCL, in miniature: a create that reaches an existing file
    // fails rather than replacing it.
    createVaultFile: async (vaultPath: string, content: string) => {
      if (vault.has(vaultPath)) throw new Error(`a file already exists at ${vaultPath}`);
      vault.set(vaultPath, content);
    },
    // Not this seam's concern — the forget-ledger gate is covered end to end in
    // tests/forget-ledger-gate.test.ts.
    pathWasForgotten: async () => null,
  };

  return { rows, proposals, notion, vault, notifications, pullDeps, applyDeps, stamp, writeNotion };
}

describe("a rejected proposal, across ticks, through both engines", () => {
  it("is proposed once, never re-proposed while queued, reverted by apply, then quiet", async () => {
    const w = makeWorld();
    w.vault.set(PATH, VAULT_SOURCE);
    const pushed = `stored:${VAULT_BODY}`;
    w.notion.set(PAGE, { markdown: pushed, lastEditedTime: "2026-08-04T09:00:00.000Z" });
    w.rows.set(PATH, {
      pageId: PAGE,
      mdHash: docRenderHash(render(PATH, VAULT_SOURCE)),
      notionHash: sha256(pushed),
      notionLastEdited: "2026-08-04T09:00:00.000Z",
      state: "synced",
      direction: "two_way",
    });

    // ── A human edits the page in Notion; tick 1's pull proposes it.
    w.notion.set(PAGE, { markdown: HUMAN_EDIT, lastEditedTime: w.stamp() });
    const tick1 = await runPullSync(PULL_OPTS, w.pullDeps);
    expect(tick1.proposed).toBe(1);
    expect(w.proposals).toHaveLength(1);
    expect(w.proposals[0].state).toBe("pending");

    // ── The human rejects it. The CLI only flips the state; the write is owed.
    await w.pullDeps.setProposalState(w.proposals[0].id, "rejected");
    expect(w.proposals[0].resolvedAt).toBeNull();

    // ── Tick 2, pull first: the rejected content must NOT come back as a new
    //    proposal, and the watermark must not move (the revert closes this out).
    const beforeWatermark = w.rows.get(PATH)?.notionLastEdited;
    const tick2Pull = await runPullSync(PULL_OPTS, w.pullDeps);
    expect(tick2Pull.proposed).toBe(0);
    expect(tick2Pull.awaitingRevert).toBe(1);
    expect(w.proposals).toHaveLength(1);
    expect(w.rows.get(PATH)?.notionLastEdited).toBe(beforeWatermark);
    expect(w.rows.get(PATH)?.state).toBe("synced");

    // ── Tick 2, apply: the page goes back to the vault's version and the
    //    rejection closes.
    const tick2Apply = await runApplySync({ dryRun: false, inCreateScope: makeCreateScope({}) }, w.applyDeps);
    expect(tick2Apply.reverted).toBe(1);
    expect(w.notion.get(PAGE)?.markdown).toBe(`stored:${VAULT_BODY}`);
    expect(w.proposals[0].resolvedAt).not.toBeNull();
    expect(w.vault.get(PATH)).toBe(VAULT_SOURCE);  // the vault was never touched
    // The baseline survived the revert — a null here would make pull go dark.
    expect(w.rows.get(PATH)?.notionLastEdited).toBe(beforeWatermark);

    // ── Tick 3: the page now holds what the vault holds. Nothing to propose,
    //    nothing to revert; the watermark simply catches up.
    const tick3 = await runPullSync(PULL_OPTS, w.pullDeps);
    expect(tick3.proposed).toBe(0);
    expect(tick3.awaitingRevert).toBe(0);
    expect(tick3.unchanged).toBe(1);
    expect(w.rows.get(PATH)?.notionLastEdited).toBe(w.notion.get(PAGE)?.lastEditedTime);
    expect(w.proposals).toHaveLength(1);
  });

  it("does not revert underneath a human: a frozen row's rejection waits, and a moved page is left alone", async () => {
    const w = makeWorld();
    w.vault.set(PATH, VAULT_SOURCE);
    const pushed = `stored:${VAULT_BODY}`;
    w.notion.set(PAGE, { markdown: HUMAN_EDIT, lastEditedTime: "2026-08-04T09:00:00.000Z" });
    w.rows.set(PATH, {
      pageId: PAGE,
      mdHash: docRenderHash(render(PATH, VAULT_SOURCE)),
      notionHash: sha256(pushed),
      notionLastEdited: "2026-08-04T09:00:00.000Z",
      state: "frozen",
      direction: "two_way",
    });
    w.proposals.push({
      id: 1, vaultPath: PATH, notionPageId: PAGE, proposedBody: HUMAN_EDIT,
      baseMdHash: docRenderHash(render(PATH, VAULT_SOURCE)),
      notionHash: sha256(HUMAN_EDIT),
      diffPreview: "",
      kind: "update", notionOwned: false, state: "rejected", createdAt: new Date(), resolvedAt: null,
    });

    const frozenRun = await runApplySync({ dryRun: false, inCreateScope: makeCreateScope({}) }, w.applyDeps);
    expect(frozenRun.skipped).toBe(1);
    expect(frozenRun.reverted).toBe(0);
    expect(w.notion.get(PAGE)?.markdown).toBe(HUMAN_EDIT);   // untouched
    expect(w.proposals[0].resolvedAt).toBeNull();            // still owed

    // Unfreeze, but meanwhile the human has typed something new in Notion.
    w.rows.set(PATH, { ...w.rows.get(PATH) as DeskRow, state: "synced" });
    w.notion.set(PAGE, { markdown: "# Note\n\na third version nobody has judged", lastEditedTime: w.stamp() });

    const movedRun = await runApplySync({ dryRun: false, inCreateScope: makeCreateScope({}) }, w.applyDeps);
    expect(movedRun.superseded).toBe(1);
    expect(movedRun.reverted).toBe(0);
    expect(w.notion.get(PAGE)?.markdown).toBe("# Note\n\na third version nobody has judged");
    expect(w.notifications).toHaveLength(1);
    expect(w.notifications[0]).toMatch(/changed after you rejected/i);
    // The rejection ruled on content that is gone: it is retired, not left to
    // re-detect and re-ping the same mismatch on every future tick.
    expect(w.proposals[0].state).toBe("superseded");

    // …and pull picks the new content up as its own proposal, on its own terms.
    const pull = await runPullSync(PULL_OPTS, w.pullDeps);
    expect(pull.proposed).toBe(1);
    expect(w.proposals.at(-1)?.proposedBody).toBe("# Note\n\na third version nobody has judged");

    // A second apply+pull round says nothing further about the retired rejection:
    // exactly one ping across both ticks, no revert ever attempted.
    const secondApply = await runApplySync({ dryRun: false, inCreateScope: makeCreateScope({}) }, w.applyDeps);
    expect(secondApply.superseded).toBe(0);
    expect(secondApply.scanned).toBe(0);
    await runPullSync(PULL_OPTS, w.pullDeps);
    expect(w.notifications.filter((m) => /changed after you rejected/i.test(m))).toHaveLength(1);
    expect(w.notion.get(PAGE)?.markdown).toBe("# Note\n\na third version nobody has judged");
  });
});
