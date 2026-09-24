import { describe, it, expect } from "vitest";
import { makeCollisionLookup } from "./helpers/collision-world.js";
import { runApplySync, type ApplySyncDeps, type ApplySyncOptions } from "../lib/apply-sync.js";
import {
  docRenderHash, vaultBodyHash, type PullDocProps, type RenderedDoc,
} from "../lib/pull-sync.js";
import { sha256 } from "../lib/wiki-sync.js";
import { makeCreateScope } from "../lib/desk-scope.js";
import type { DocSyncedInput, LinkedRow, ProposalRow, ProposalState } from "../lib/store.js";

// The desk-scope check a create must pass (fix round 1), built through the REAL
// derivation rather than a hand-written `() => true` — the same posture
// reject-seam.test.ts takes for `isExcluded`, and now enforced: the engine probes
// the predicate with a sentinel and refuses to run creates against one that accepts
// everything (fix round 2), so a stub would fail here exactly as it would in
// production. `wikipedia` is a desk dir purely so the wiki/wikipedia counter-case
// below has somewhere legitimate to land.
const TEST_SCOPE = makeCreateScope({
  desks: {
    deskDirs: [
      { dir: "zero7", project: "Z", exclude: ["transcripts"] },
      { dir: "wikipedia", project: "W" },
    ],
    twoWayDirs: [],
    mirrorFilePrefixes: [],
  },
  transcripts: { dir: "transcripts", projects: [] },
});
const OPTS: ApplySyncOptions = { dryRun: false, inCreateScope: TEST_SCOPE };
const DRY: ApplySyncOptions = { dryRun: true, inCreateScope: TEST_SCOPE };

const PATH = "desks/orakel/note.md";
const VAULT_BODY = "# Note\n\noriginal body";
const VAULT_SOURCE = `---\ntitle: Note\n---\n\n${VAULT_BODY}\n`;
const PROPOSED_BODY = "# Note\n\nedited in Notion";

function makeProps(vaultPath: string): PullDocProps {
  return {
    name: "Note", project: "Orakel", folder: "desks/orakel", vaultPath,
    frontmatter: "title: Note", archived: false, sync: "✍️ Desk",
  };
}

const RENDERED: RenderedDoc = { markdown: VAULT_BODY, props: makeProps(PATH) };
const RENDER_HASH = docRenderHash(RENDERED);

function makeProposal(over: Partial<ProposalRow> = {}): ProposalRow {
  return {
    id: 1,
    vaultPath: PATH,
    notionPageId: "d1",
    proposedBody: PROPOSED_BODY,
    baseMdHash: RENDER_HASH,
    notionHash: sha256("# Note\n\nedited in Notion"),
    diffPreview: "- original body\n+ edited in Notion",
    kind: "update",
    notionOwned: false,
    state: "approved",
    createdAt: new Date("2026-08-03T00:00:00.000Z"),
    ...over,
  };
}

function makeRow(over: Partial<LinkedRow> = {}): LinkedRow {
  return {
    pageId: "d1",
    mdHash: RENDER_HASH,
    notionHash: "stored-notion-hash",
    notionLastEdited: "2026-08-02T09:00:00.000Z",
    state: "synced",
    direction: "two_way",
    // The apply pass reads rows across BOTH targets from Phase 4 on (a transcript's
    // state row is its Meetings row). Every row in this file is a desk document.
    target: "docs",
    ...over,
  };
}

interface Scenario {
  open?: ProposalRow[];
  rejected?: ProposalRow[];
  rows?: Array<[string, LinkedRow]>;
  rendered?: Record<string, RenderedDoc>;
  sources?: Record<string, string>;
  patchError?: Record<string, Error>;
  notifyThrows?: boolean;
  /** Vault paths that exist on disk at APPLY time (the create guard's world). */
  onDisk?: Set<string>;
  createError?: Error;
}

function makeDeps(cfg: Scenario) {
  const calls: string[] = [];
  const notified: string[] = [];
  const written: Array<{ vaultPath: string; content: string }> = [];
  const patched: Array<{ pageId: string; markdown: string }> = [];
  const propUpdates: Array<{ pageId: string; props: Partial<PullDocProps> }> = [];
  const upserts: Array<DocSyncedInput & { writtenBodyHash?: string }> = [];
  const accounted: Array<{ pageId: string; notionHash: string }> = [];
  const watermarks: Array<{ vaultPath: string; notionHash: string; notionLastEdited: string | null }> = [];
  const proposalStates: Array<{ id: number; state: ProposalState }> = [];
  const revertedIds: number[] = [];
  const frozenCalls: Array<{ vaultPath: string; reason: string }> = [];
  const errors: Array<{ vaultPath: string; message: string }> = [];
  const notion: Record<string, string> = { d1: "# Note\n\nedited in Notion" };
  const created: Array<{ vaultPath: string; content: string }> = [];
  const onDisk = cfg.onDisk ?? new Set<string>();

  const impl: ApplySyncDeps = {
    getOpenProposals: async () => cfg.open ?? [],
    getRejectedUnexecuted: async () => cfg.rejected ?? [],
    getLinkedRows: async () => {
      calls.push("getDeskRows");
      return new Map(cfg.rows ?? [[PATH, makeRow()]]);
    },
    renderDoc: async (vaultPath) => {
      const doc = (cfg.rendered ?? { [PATH]: RENDERED })[vaultPath];
      if (doc === undefined) throw new Error(`ENOENT: ${vaultPath}`);
      return doc;
    },
    readVaultFile: async (vaultPath) => {
      const source = (cfg.sources ?? { [PATH]: VAULT_SOURCE })[vaultPath];
      if (source === undefined) throw new Error(`ENOENT: ${vaultPath}`);
      return source;
    },
    writeVaultFile: async (vaultPath, content) => {
      calls.push(`write:${vaultPath}`);
      written.push({ vaultPath, content });
    },
    vaultFileExists: async (vaultPath) => {
      calls.push(`exists:${vaultPath}`);
      return onDisk.has(vaultPath);
    },
    // Guard 3b's input, from the SAME world `vaultFileExists` answers for — two
    // different worlds here would let the two halves of one guard agree by accident.
    // One shared model (tests/helpers/collision-world.ts); see its header for what it
    // does and does not model.
    listCollisionCandidates: makeCollisionLookup(() => onDisk),
    createVaultFile: async (vaultPath, content) => {
      calls.push(`create:${vaultPath}`);
      if (cfg.createError !== undefined) throw cfg.createError;
      // The real adapter is O_EXCL — a create that reaches an existing file fails.
      if (onDisk.has(vaultPath)) throw new Error("a file already exists there");
      onDisk.add(vaultPath);
      created.push({ vaultPath, content });
    },
    patchPageMarkdown: async (pageId, markdown) => {
      calls.push(`patch:${pageId}`);
      const err = cfg.patchError?.[pageId];
      if (err !== undefined) throw err;
      patched.push({ pageId, markdown });
      notion[pageId] = `stored:${markdown}`;
    },
    updateDocProps: async (pageId, props) => {
      calls.push(`props:${pageId}`);
      propUpdates.push({ pageId, props });
    },
    getPageMarkdown: async (pageId) => {
      calls.push(`read:${pageId}`);
      return notion[pageId];
    },
    upsertDocSynced: async (doc) => {
      calls.push(`upsert:${doc.vaultPath}`);
      upserts.push(doc);
    },
    linkPageToVaultFile: async (doc) => {
      calls.push(`upsert:${doc.vaultPath}`);
      upserts.push(doc);
    },
    recordNotionAccounted: async (pageId, notionHash) => {
      calls.push(`accounted:${pageId}`);
      accounted.push({ pageId, notionHash });
    },
    updateNotionWatermark: async (vaultPath, notionHash, notionLastEdited) => {
      calls.push(`watermark:${vaultPath}`);
      watermarks.push({ vaultPath, notionHash, notionLastEdited });
    },
    setProposalState: async (id, state) => {
      calls.push(`proposal:${id}:${state}`);
      proposalStates.push({ id, state });
    },
    markProposalReverted: async (id) => {
      calls.push(`reverted:${id}`);
      revertedIds.push(id);
    },
    freezeDoc: async (vaultPath, reason) => {
      calls.push(`freeze:${vaultPath}`);
      frozenCalls.push({ vaultPath, reason });
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
    // Never forgotten by default — every existing scenario in this file is about a
    // vault path nobody ever told the agent to forget. The forget-ledger guard
    // itself is covered end to end in tests/forget-ledger-gate.test.ts.
    pathWasForgotten: async () => null,
  };

  return {
    impl, calls, notified, written, created, onDisk, patched, propUpdates, upserts, watermarks,
    accounted, proposalStates, revertedIds, frozenCalls, errors,
  };
}

// The disk frontmatter is still lifted verbatim; the ONE key an approved pull adds is
// the origin stamp (W4D-s2, ADR-0017 rule 9), inserted at the top of the block because
// this file has no `type:` line to sit under. See the last describe in this file for
// what decides its value.
const STAMPED_SOURCE_BLOCK = "---\nlares_origin: synced\ntitle: Note\n---\n\n";

describe("runApplySync — approved proposals", () => {
  it("writes the vault file as verbatim frontmatter + proposed body, then marks it applied", async () => {
    const d = makeDeps({ open: [makeProposal()] });
    const result = await runApplySync(OPTS, d.impl);

    expect(d.written).toEqual([{
      vaultPath: PATH,
      content: `${STAMPED_SOURCE_BLOCK}${PROPOSED_BODY}\n`,
    }]);
    expect(d.patched).toEqual([]);   // applying a Notion edit never writes Notion
    expect(d.proposalStates).toEqual([{ id: 1, state: "applied" }]);
    expect(d.notified[0]).toContain(PATH);
    expect(result.applied).toBe(1);
  });

  it("gives a file with no frontmatter a block holding nothing but the stamp", async () => {
    const d = makeDeps({
      open: [makeProposal()],
      sources: { [PATH]: `${VAULT_BODY}\n` },
    });
    await runApplySync(OPTS, d.impl);
    expect(d.written).toEqual([{
      vaultPath: PATH,
      content: `---\nlares_origin: synced\n---\n\n${PROPOSED_BODY}\n`,
    }]);
  });

  it("leaves pending proposals alone — approval is a human act", async () => {
    const d = makeDeps({ open: [makeProposal({ state: "pending" })] });
    const result = await runApplySync(OPTS, d.impl);

    expect(d.written).toEqual([]);
    expect(d.proposalStates).toEqual([]);
    expect(result.applied).toBe(0);
    expect(result.scanned).toBe(0);
  });

  it("refuses a stale approve: supersedes and freezes instead of writing", async () => {
    const d = makeDeps({ open: [makeProposal({ baseMdHash: "hash-from-before-the-vault-moved" })] });
    const result = await runApplySync(OPTS, d.impl);

    expect(d.written).toEqual([]);
    expect(d.proposalStates).toEqual([{ id: 1, state: "superseded" }]);
    expect(d.frozenCalls).toHaveLength(1);
    expect(d.frozenCalls[0].vaultPath).toBe(PATH);
    expect(d.frozenCalls[0].reason).toMatch(/changed after/i);
    expect(d.notified[0]).toMatch(/not written|stale/i);
    expect(result.superseded).toBe(1);
    expect(result.applied).toBe(0);
  });

  it("contains a render failure without writing anything", async () => {
    const d = makeDeps({ open: [makeProposal()], rendered: {} });
    const result = await runApplySync(OPTS, d.impl);

    expect(d.written).toEqual([]);
    expect(d.errors).toHaveLength(1);
    expect(result.errored).toBe(1);
  });

  // I2 (final review): the freeze invariant has to hold in BOTH directions. The
  // rejected path has always been gated on state='synced'; the approved path was
  // not, so an approved proposal wrote the vault file of a frozen row — the one
  // thing "frozen means nothing is written on either side" promises cannot
  // happen (README/runbook both say so).
  it("leaves a frozen row alone — an approved proposal waits for the resolve, it does not write", async () => {
    const d = makeDeps({
      open: [makeProposal()],
      rows: [[PATH, makeRow({ state: "frozen" })]],
    });
    const result = await runApplySync(OPTS, d.impl);

    expect(d.written).toEqual([]);
    expect(d.proposalStates).toEqual([]);   // still approved, still queued
    expect(d.frozenCalls).toEqual([]);
    expect(d.errors).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(result.applied).toBe(0);
    // Logged, never pinged: this repeats on every tick until the human resolves
    // the row, and the pull pass's rate-limited stale-freeze ping is the one
    // thing allowed to nag them about it (same posture as the rejected loop).
    expect(d.notified).toEqual([]);
  });

  it("skips an approved proposal whose doc row has gone missing", async () => {
    const d = makeDeps({ open: [makeProposal()], rows: [] });
    const result = await runApplySync(OPTS, d.impl);

    expect(d.written).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(result.applied).toBe(0);
  });

  it("applies once the row is unfrozen — the queued approval was never lost", async () => {
    const frozen = makeDeps({ open: [makeProposal()], rows: [[PATH, makeRow({ state: "frozen" })]] });
    await runApplySync(OPTS, frozen.impl);
    expect(frozen.written).toEqual([]);

    // The same still-approved proposal, after `resolve --keep notion` returned
    // the row to 'synced'.
    const thawed = makeDeps({ open: [makeProposal()], rows: [[PATH, makeRow({ state: "synced" })]] });
    const result = await runApplySync(OPTS, thawed.impl);

    expect(thawed.written).toEqual([{
      vaultPath: PATH,
      content: `${STAMPED_SOURCE_BLOCK}${PROPOSED_BODY}\n`,
    }]);
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("does not write a frozen row's vault file even in dry-run's counters", async () => {
    const d = makeDeps({ open: [makeProposal()], rows: [[PATH, makeRow({ state: "frozen" })]] });
    const result = await runApplySync(DRY,d.impl);

    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(d.notified).toEqual([]);   // a rehearsal never pings
  });

  // A stale approval on a TRANSCRIPT (review round 1). Reachable exactly as designed:
  // Bendik edits the transcript in Obsidian while a proposal is pending, then taps
  // Approve. `freezeDoc` is `target='docs'`, so on a meetings row it updated nothing
  // and the ping told him to run `notion-sync resolve`, which answers "no doc row" —
  // and whose `--keep md` would be the md→Notion write §17.2 forbids outright.
  it("a stale approval on a MEETINGS row does not fake a freeze, and says something true", async () => {
    const d = makeDeps({
      open: [makeProposal({ baseMdHash: "the-hash-from-before-the-file-was-edited" })],
      rows: [[PATH, makeRow({ target: "meetings", direction: "notion_to_md" })]],
    });
    const result = await runApplySync(OPTS, d.impl);

    expect(result.superseded).toBe(1);
    expect(result.applied).toBe(0);
    expect(d.written).toEqual([]);
    // No freeze was attempted — the call would have updated zero rows.
    expect(d.frozenCalls).toEqual([]);
    expect(result.frozen).toBe(0);
    // …and the instruction is one that works.
    expect(d.notified[0]).not.toMatch(/notion-sync resolve/);
    expect(d.notified[0]).toMatch(/nothing to resolve/);
  });

  it("a stale approval on a DOCS row still freezes — and now COUNTS the freeze", async () => {
    const d = makeDeps({
      open: [makeProposal({ baseMdHash: "the-hash-from-before-the-file-was-edited" })],
    });
    const result = await runApplySync(OPTS, d.impl);

    expect(result.superseded).toBe(1);
    expect(d.frozenCalls).toHaveLength(1);
    expect(d.frozenCalls[0].reason).toMatch(/changed after this Notion edit was approved/);
    // The counter used to say 0 for a tick that froze a row.
    expect(result.frozen).toBe(1);
    expect(d.notified[0]).toMatch(/notion-sync resolve/);
  });
});

describe("runApplySync — rejected proposals", () => {
  it("reverts the Notion page from the vault, hashes the read-back, and closes the proposal", async () => {
    const d = makeDeps({ rejected: [makeProposal({ id: 5, state: "rejected" })] });
    const result = await runApplySync(OPTS, d.impl);

    expect(d.patched).toEqual([{ pageId: "d1", markdown: VAULT_BODY }]);
    expect(d.propUpdates).toEqual([{ pageId: "d1", props: RENDERED.props }]);
    // The first read is the "does Notion still hold what was rejected?" check;
    // the second is hash-after-write.
    expect(d.calls).toEqual([
      "getDeskRows", "read:d1", "patch:d1", "props:d1", "read:d1", `upsert:${PATH}`, "reverted:5", "notify",
    ]);
    expect(d.upserts).toEqual([{
      vaultPath: PATH,
      pageId: "d1",
      mdHash: RENDER_HASH,
      notionHash: sha256(`stored:${VAULT_BODY}`),
      // The watermark is carried through, never nulled — a null would make pull
      // skip the row as unbaselined until the next reconcile.
      notionLastEdited: "2026-08-02T09:00:00.000Z",
      direction: "two_way",
    }]);
    expect(d.written).toEqual([]);
    expect(result.reverted).toBe(1);
  });

  it("leaves a frozen row alone — a freeze outranks a queued revert", async () => {
    const d = makeDeps({
      rejected: [makeProposal({ id: 5, state: "rejected" })],
      rows: [[PATH, makeRow({ state: "frozen" })]],
    });
    const result = await runApplySync(OPTS, d.impl);

    expect(d.patched).toEqual([]);
    expect(d.revertedIds).toEqual([]);   // still owed once the human resolves
    expect(d.errors).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(result.reverted).toBe(0);
  });

  it("supersedes the rejection when the page has moved on since it was made", async () => {
    const d = makeDeps({
      rejected: [makeProposal({ id: 5, state: "rejected", notionHash: sha256("the content that was rejected") })],
    });
    const result = await runApplySync(OPTS, d.impl);

    expect(d.patched).toEqual([]);       // never overwrite content nobody has judged
    expect(d.revertedIds).toEqual([]);
    // The rejection ruled on content that is gone; the revert obligation dies with
    // it, and the newer content comes back through pull as its own proposal.
    expect(d.proposalStates).toEqual([{ id: 5, state: "superseded" }]);
    expect(d.notified).toHaveLength(1);
    expect(d.notified[0]).toMatch(/changed after you rejected/i);
    expect(result.superseded).toBe(1);
    expect(result.reverted).toBe(0);
  });

  it("freezes and closes when a sub-page blocks the revert", async () => {
    const d = makeDeps({
      rejected: [makeProposal({ id: 5, state: "rejected" })],
      patchError: { d1: new Error('400 {"code":"validation_error","message":"Cannot delete child page blocks"}') },
    });
    const result = await runApplySync(OPTS, d.impl);

    expect(d.frozenCalls).toHaveLength(1);
    expect(d.frozenCalls[0].reason).toContain("sub-page");
    expect(d.revertedIds).toEqual([5]);   // the freeze owns it now — no per-tick retry loop
    expect(d.errors).toEqual([]);
    expect(result.frozen).toBe(1);
  });

  it("keeps a rejected proposal queued when the revert fails for an ordinary reason", async () => {
    const d = makeDeps({
      rejected: [makeProposal({ id: 5, state: "rejected" })],
      patchError: { d1: new Error("notion PATCH failed: 502 bad gateway") },
    });
    const result = await runApplySync(OPTS, d.impl);

    expect(d.revertedIds).toEqual([]);    // still owed a revert — retried next tick
    expect(d.errors).toHaveLength(1);
    expect(result.errored).toBe(1);
  });
});

// ── Create proposals (Phase 4, T3b) ────────────────────────────────────────────────
// A create is the mechanism T4 (transcripts) and T6 (Notion-born pages) both need: a
// vault file that does not exist yet, brought into being through the SAME queue and
// the SAME 👍. Everything here is about what happens between the tap and the write.

const NEW_PATH = "zero7/transcripts/2026-08-05-standup.md";
const NEW_BODY = "---\ntitle: Standup\n---\n\nnotes pulled from Notion";
const NEW_RENDERED: RenderedDoc = { markdown: "notes pulled from Notion", props: makeProps(NEW_PATH) };

function makeCreate(over: Partial<ProposalRow> = {}): ProposalRow {
  return makeProposal({
    id: 9,
    kind: "create",
    vaultPath: NEW_PATH,
    notionPageId: "n9",
    proposedBody: NEW_BODY,
    // A create has no "before": there is no vault file to have rendered.
    baseMdHash: "",
    notionHash: sha256("notes pulled from Notion"),
    diffPreview: "+ notes pulled from Notion",
    ...over,
  });
}

/** No doc row for the new path — the state a create requires. */
const NO_ROW: Array<[string, LinkedRow]> = [];

describe("runApplySync — approved create proposals", () => {
  it("creates the file, inserts a synced row for it, and marks the proposal applied", async () => {
    const d = makeDeps({
      open: [makeCreate()],
      rows: NO_ROW,
      rendered: { [NEW_PATH]: NEW_RENDERED },
    });
    const result = await runApplySync(OPTS, d.impl);

    // The proposed content IS the whole file — frontmatter included — because there
    // is no file on disk to lift a frontmatter block from. The one thing apply adds
    // is the origin stamp, re-asserted rather than taken on trust from the proposer
    // (W4D-s2); this fixture's proposer left it out, so it is inserted here.
    expect(d.created).toEqual([{
      vaultPath: NEW_PATH,
      content: `---\nlares_origin: synced\ntitle: Standup\n---\n\nnotes pulled from Notion\n`,
    }]);
    expect(d.written).toEqual([]);      // never the overwriting writer
    expect(d.patched).toEqual([]);      // a create never writes Notion
    expect(d.proposalStates).toEqual([{ id: 9, state: "applied" }]);
    expect(result.applied).toBe(1);

    // The new file joins the store as an ordinary participant, bound to the page it
    // came from — without this row the push pass would adopt the file and create a
    // SECOND Notion page for content Notion already holds.
    expect(d.upserts).toEqual([{
      vaultPath: NEW_PATH,
      pageId: "n9",
      mdHash: docRenderHash(NEW_RENDERED),
      notionHash: sha256("notes pulled from Notion"),
      notionLastEdited: null,
      direction: "notion_to_md",
      // The hash a MEETINGS row stores instead of the render hash above — computed
      // from the bytes just written, over the SAME split the transcript pass makes
      // on the file it reads back. The store's CASE decides which one lands; both
      // travel, because this branch cannot know which kind of row it is binding.
      writtenBodyHash: vaultBodyHash(`${NEW_BODY}\n`),
    }]);
    expect(d.notified[0]).toContain(NEW_PATH);
  });

  it("never renders, never reads and never hash-checks before the write — there is no file yet", async () => {
    const d = makeDeps({
      open: [makeCreate()],
      rows: NO_ROW,
      rendered: { [NEW_PATH]: NEW_RENDERED },
    });
    await runApplySync(OPTS, d.impl);

    // The one render is the hash-after-write reading, AFTER the create.
    expect(d.calls).toEqual([
      "getDeskRows", `exists:${NEW_PATH}`, `create:${NEW_PATH}`,
      `upsert:${NEW_PATH}`, "proposal:9:applied", "notify",
    ]);
  });

  it("dry-run plans the create and writes nothing at all", async () => {
    const d = makeDeps({ open: [makeCreate()], rows: NO_ROW });
    const result = await runApplySync(DRY,d.impl);

    expect(d.created).toEqual([]);
    expect(d.upserts).toEqual([]);
    expect(d.proposalStates).toEqual([]);
    expect(d.notified).toEqual([]);
    expect(result.applied).toBe(1);
  });

  // The row gate INVERTS for a create: the update path requires a synced row, a
  // create requires that no row exists at all. A row means the file is already a
  // tracked participant, so the create is asking for something that has happened.
  it("refuses when a doc row already exists for the path — superseded, never written", async () => {
    const d = makeDeps({
      open: [makeCreate()],
      rows: [[NEW_PATH, makeRow()]],
    });
    const result = await runApplySync(OPTS, d.impl);

    expect(d.created).toEqual([]);
    expect(d.written).toEqual([]);
    expect(d.proposalStates).toEqual([{ id: 9, state: "superseded" }]);
    // A healthy synced row is NOT frozen for this: the file is fine, the proposal is
    // the thing that is stale, and freezing would demand a `resolve` for nothing.
    expect(d.frozenCalls).toEqual([]);
    expect(result.superseded).toBe(1);
    expect(result.applied).toBe(0);
    expect(d.notified[0]).toMatch(/refused/i);
    expect(d.notified[0]).toContain(NEW_PATH);
  });

  // notion_page_id is UNIQUE in the store, so a create for a page some other vault
  // file already owns cannot record its row — and a created file with no row is an
  // orphan the push pass adopts, creating a SECOND Notion page for the same content.
  it("refuses when the Notion page already backs a different vault file", async () => {
    const d = makeDeps({
      open: [makeCreate()],
      rows: [["zero7/notes/already-here.md", makeRow({ pageId: "n9" })]],
    });
    const result = await runApplySync(OPTS, d.impl);

    expect(d.created).toEqual([]);
    expect(d.upserts).toEqual([]);
    expect(result.superseded).toBe(1);
    expect(d.notified[0]).toMatch(/refused/i);
    expect(d.notified[0]).toContain("zero7/notes/already-here.md");
  });

  // Two open creates for one page under two paths is possible — the open-proposal
  // unique index is per vault_path, not per page — so the page guard has to see the
  // row the FIRST one just made, not only the snapshot taken before either ran.
  it("refuses a second create for the same page in the same tick", async () => {
    const d = makeDeps({
      open: [makeCreate(), makeCreate({ id: 10, vaultPath: "zero7/transcripts/duplicate.md" })],
      rows: NO_ROW,
      rendered: {
        [NEW_PATH]: NEW_RENDERED,
        "zero7/transcripts/duplicate.md": { markdown: "x", props: makeProps("zero7/transcripts/duplicate.md") },
      },
    });
    const result = await runApplySync(OPTS, d.impl);

    expect(d.created.map((c) => c.vaultPath)).toEqual([NEW_PATH]);
    expect(d.upserts).toHaveLength(1);
    expect(result.applied).toBe(1);
    expect(result.superseded).toBe(1);
    expect(d.proposalStates).toEqual([{ id: 9, state: "applied" }, { id: 10, state: "superseded" }]);
  });

  it("refuses a create whose baseMdHash is not empty — it is not describing a create", async () => {
    const d = makeDeps({ open: [makeCreate({ baseMdHash: "some-hash" })], rows: NO_ROW });
    const result = await runApplySync(OPTS, d.impl);

    expect(d.created).toEqual([]);
    expect(d.proposalStates).toEqual([{ id: 9, state: "superseded" }]);
    expect(result.superseded).toBe(1);
    expect(d.notified[0]).toMatch(/refused/i);
  });
});

describe("runApplySync — the create guards, re-checked at apply time", () => {
  // THE test this whole task exists for. The guard cannot live only where the
  // proposal was made: minutes or days pass while the proposal waits for Bendik's
  // tap, and in that window a human can save a note at exactly that path. A
  // propose-time-only check would then overwrite hand-written work, silently.
  it("TOCTOU: the file appearing BETWEEN propose and apply is refused, not overwritten", async () => {
    // Propose time: nothing on disk, nothing in the store — the create is valid.
    const proposal = makeCreate();
    const validAtProposeTime = makeDeps({ open: [proposal], rows: NO_ROW, rendered: { [NEW_PATH]: NEW_RENDERED } });
    await runApplySync(DRY,validAtProposeTime.impl);
    expect(validAtProposeTime.created).toEqual([]);   // dry-run, but it planned to

    // …and then, while the proposal sat in the queue, Bendik wrote that file himself.
    const d = makeDeps({
      open: [proposal],
      rows: NO_ROW,
      onDisk: new Set([NEW_PATH]),
      rendered: { [NEW_PATH]: NEW_RENDERED },
    });
    const result = await runApplySync(OPTS, d.impl);

    expect(d.created).toEqual([]);
    expect(d.written).toEqual([]);
    expect(d.upserts).toEqual([]);
    expect(d.proposalStates).toEqual([{ id: 9, state: "superseded" }]);
    expect(result.superseded).toBe(1);
    expect(result.applied).toBe(0);
    // He has to be able to see WHY, or a refused create is indistinguishable from a
    // sync that quietly stopped working.
    expect(d.notified[0]).toMatch(/refused/i);
    expect(d.notified[0]).toMatch(/already exists/i);
    expect(d.notified[0]).toContain(NEW_PATH);
  });

  // GUARD 3b (review round 2) — the TOCTOU shape the KERNEL cannot see. The two
  // guards above both ask the filesystem this process is running on, and it is not
  // the filesystem Bendik reads the vault on: `Notater.md` and `notater.md` are two
  // inodes on the box's ext4 and one path on his APFS Mac. So `vaultFileExists` says
  // no, `O_EXCL` succeeds, and the commit the box pushes shadows his note the moment
  // it is pulled. Same window as the test above, and the same principle — the world
  // is re-checked as it is NOW, not as it was when the proposal was made.
  it("TOCTOU: a CASE-variant file appearing between propose and apply is refused, not shadowed", async () => {
    const handWritten = "zero7/transcripts/2026-08-05-STANDUP.md";
    const d = makeDeps({
      open: [makeCreate()],
      rows: NO_ROW,
      // NOT at NEW_PATH: on a case-sensitive filesystem the exact-match guard
      // genuinely cannot see this, which is the whole point.
      onDisk: new Set([handWritten]),
      rendered: { [NEW_PATH]: NEW_RENDERED },
    });
    const result = await runApplySync(OPTS, d.impl);

    expect(d.created).toEqual([]);
    expect(d.written).toEqual([]);
    expect(d.upserts).toEqual([]);
    expect(result.applied).toBe(0);
    expect(result.superseded).toBe(1);
    // …and the existing file is byte-identical: nothing was written near it at all.
    expect(d.onDisk.has(handWritten)).toBe(true);
    expect(d.onDisk.has(NEW_PATH)).toBe(false);
    // He can see WHY, and the reason NAMES the file it would have shadowed — he
    // cannot spot the collision by reading either name on its own.
    expect(d.notified[0]).toMatch(/refused/i);
    expect(d.notified[0]).toMatch(/SAME FILE as that path on macOS/);
    expect(d.notified[0]).toContain("2026-08-05-STANDUP.md");
  });

  it("TOCTOU: an NFC/NFD-variant file appearing between propose and apply is refused too", async () => {
    // `å` written decomposed (a + combining ring) is a different JS string and the
    // same filename on APFS. A create's folder half comes from a `Folder` property a
    // human types, so both spellings genuinely occur.
    const target = "zero7/ha\u030Andbok.md";     // a + combining ring above
    const composed = "zero7/håndbok.md";
    expect(target).not.toBe(composed);
    expect(target.normalize("NFC")).toBe(composed);

    const d = makeDeps({
      open: [makeCreate({ vaultPath: composed })],
      rows: NO_ROW,
      onDisk: new Set([target]),
      rendered: { [composed]: NEW_RENDERED },
    });
    const result = await runApplySync(OPTS, d.impl);

    expect(d.created).toEqual([]);
    expect(result.superseded).toBe(1);
    expect(d.notified[0]).toMatch(/unicode form/);
  });

  // ROUND 3's Important 1 — the shape round 2's guard was blind to. The variant is
  // in an ANCESTOR DIRECTORY, so the round-2 predicate (basenames inside the
  // literally-spelled parent) read an ENOENT, returned nothing, and the create
  // landed: two directories and two files on the box, one of each on the Mac.
  //
  // A `Folder` naming a directory that does not exist yet is the ORDINARY way to file
  // a new page, and he creates it himself after reading the DM — so the window guard
  // 3b exists to close is precisely where this lives.
  it("TOCTOU: a CASE-variant ANCESTOR DIRECTORY appearing between propose and apply is refused", async () => {
    const target = "zero7/prosjekt/loepende-notater.md";
    const his = "zero7/Prosjekt/Loepende-Notater.md";
    const d = makeDeps({
      open: [makeCreate({ vaultPath: target })],
      rows: NO_ROW,
      onDisk: new Set([his]),
      rendered: { [target]: NEW_RENDERED },
    });
    const result = await runApplySync(OPTS, d.impl);

    expect(d.created).toEqual([]);
    expect(result.applied).toBe(0);
    expect(result.superseded).toBe(1);
    expect(d.onDisk.has(his)).toBe(true);          // byte-identical, untouched
    expect(d.onDisk.has(target)).toBe(false);
    expect(d.notified[0]).toMatch(/SAME FILE as that path on macOS/);
    expect(d.notified[0]).toContain(his);
  });

  it("TOCTOU: an NFD-variant ANCESTOR DIRECTORY is refused too", async () => {
    // `å` decomposed in the folder Bendik typed, composed in the one Notion's Folder
    // property produced. Two directories on ext4; one on APFS.
    const target = "zero7/håndbok/notater.md";                        // NFC
    const his = "zero7/ha\u030Andbok/Notater.md";                      // NFD + capital
    expect(his).not.toBe("zero7/håndbok/Notater.md");
    expect(his.normalize("NFC")).toBe("zero7/håndbok/Notater.md");

    const d = makeDeps({
      open: [makeCreate({ vaultPath: target })],
      rows: NO_ROW,
      onDisk: new Set([his]),
      rendered: { [target]: NEW_RENDERED },
    });
    const result = await runApplySync(OPTS, d.impl);

    expect(d.created).toEqual([]);
    expect(result.superseded).toBe(1);
    expect(d.notified[0]).toMatch(/unicode form/);
  });

  // Important 2: `listCollisionCandidates` REQUIRED is a type-level guarantee, and a
  // type-level guarantee cannot catch a wrong-but-present value. Mutating the
  // composition root to `async () => []` compiled, ran, and left the whole package
  // green with guard 3b silently off. The probe is what makes that loud.
  // TWO probes with CONTRADICTORY correct answers (round 4). One probe was half a
  // guard: `async () => []` failed it, and `async () => [".git"]` — an equally
  // plausible stub — satisfied it while guard 3b was completely off. No constant can
  // pass both of these.
  it("refuses to run ANY create when the collision lookup answers nothing at the vault root", async () => {
    const d = makeDeps({ open: [makeCreate()], rows: NO_ROW, rendered: { [NEW_PATH]: NEW_RENDERED } });
    await expect(runApplySync(OPTS, { ...d.impl, listCollisionCandidates: async () => [] }))
      .rejects.toThrow(/found nothing beside a file at the vault root/);
    expect(d.created).toEqual([]);
  });

  it("refuses to run ANY create when the lookup answers the same thing whatever it is asked", async () => {
    // THE round-4 mutation, verbatim: a plausible constant stub that is not empty.
    const d = makeDeps({ open: [makeCreate()], rows: NO_ROW, rendered: { [NEW_PATH]: NEW_RENDERED } });
    await expect(runApplySync(OPTS, { ...d.impl, listCollisionCandidates: async () => [".git"] }))
      .rejects.toThrow(/does not exist.*not resolving the path it was given/s);
    expect(d.created).toEqual([]);
  });

  it("does not probe the collision lookup at all on a tick with no creates", async () => {
    // Same contract as the scope sentinel: a tick with nothing to protect pays
    // nothing, and a deployment that never creates cannot be stopped by this.
    const d = makeDeps({ open: [makeProposal()] });
    const result = await runApplySync(OPTS, {
      ...d.impl,
      listCollisionCandidates: async () => { throw new Error("must not be consulted"); },
    });
    expect(result.applied).toBe(1);
  });

  it("still creates when the folder merely holds a genuinely different name", async () => {
    // The guard must not pass by refusing everything.
    const neighbour = `${NEW_PATH.slice(0, NEW_PATH.lastIndexOf("/"))}/something-else.md`;
    const d = makeDeps({
      open: [makeCreate()],
      rows: NO_ROW,
      onDisk: new Set([neighbour]),
      rendered: { [NEW_PATH]: NEW_RENDERED },
    });
    const result = await runApplySync(OPTS, d.impl);

    expect(result.applied).toBe(1);
    expect(d.created.map((c) => c.vaultPath)).toEqual([NEW_PATH]);
  });

  it("a collision listing this adapter cannot read is an ERROR, never a green light", async () => {
    // Same posture as `vaultFileExists`'s non-ENOENT rule: an unreadable directory is
    // a question that could not be answered, and answering "no siblings" would turn a
    // broken mount into permission to create in it. The proposal stays queued.
    const d = makeDeps({ open: [makeCreate()], rows: NO_ROW, rendered: { [NEW_PATH]: NEW_RENDERED } });
    const result = await runApplySync(OPTS, {
      ...d.impl,
      listCollisionCandidates: async (vaultPath: string) => {
        // The two wiring probes must still answer correctly, or this test would be
        // measuring the sentinel rather than the per-create failure it is about.
        if (vaultPath.startsWith("___")) return d.impl.listCollisionCandidates(vaultPath);
        throw new Error("EACCES");
      },
    });

    expect(d.created).toEqual([]);
    expect(result.applied).toBe(0);
    expect(result.errored).toBe(1);
    expect(d.proposalStates).toEqual([]);          // not superseded — retried

    // AND IT REACHES BENDIK (round 4). `fail` is console.error + recordDocError, and
    // recordDocError is keyed on vault_path — a create has no row, so it matches
    // nothing. Without this ping the failure is one log line an hour, forever, seen
    // by nobody: the exact dead end the create-WRITE failure path already names.
    expect(d.notified).toHaveLength(1);
    expect(d.notified[0]).toContain(NEW_PATH);
    expect(d.notified[0]).toContain("EACCES");
    expect(d.notified[0]).toMatch(/stuck/);
  });

  it("…and that ping is byte-identical across ticks, but differs per stuck create", async () => {
    // The spine fingerprints sha256(message) with a 24h gate, so anything varying per
    // tick (a counter, a timestamp) turns one incident into hourly noise — and
    // anything NOT carrying the path collapses two different stuck creates into one
    // notification, hiding the second for a day. Same discipline as the create-write
    // failure below it.
    const stuck = (path: string) => async () => {
      const d = makeDeps({
        open: [makeCreate({ vaultPath: path })], rows: NO_ROW, rendered: { [path]: NEW_RENDERED },
      });
      await runApplySync(OPTS, {
        ...d.impl,
        listCollisionCandidates: async (vaultPath: string) =>
          vaultPath.startsWith("___") ? d.impl.listCollisionCandidates(vaultPath) : (() => {
            throw new Error("EACCES");
          })(),
      });
      return d.notified[0];
    };
    expect(await stuck(NEW_PATH)()).toBe(await stuck(NEW_PATH)());
    expect(await stuck(NEW_PATH)()).not.toBe(await stuck("zero7/other.md")());
  });

  it("refuses a path that escapes the vault", async () => {
    const d = makeDeps({ open: [makeCreate({ vaultPath: "../../etc/cron.md" })], rows: NO_ROW });
    const result = await runApplySync(OPTS, d.impl);

    expect(d.created).toEqual([]);
    expect(result.superseded).toBe(1);
    expect(d.notified[0]).toMatch(/refused/i);
  });

  it("refuses an absolute path", async () => {
    const d = makeDeps({ open: [makeCreate({ vaultPath: "/etc/cron.md" })], rows: NO_ROW });
    await runApplySync(OPTS, d.impl);
    expect(d.created).toEqual([]);
    expect(d.notified[0]).toMatch(/refused.*absolute/i);
  });

  it("refuses the machine-owned wiki mirror, but not a folder merely named like it", async () => {
    const refused = makeDeps({ open: [makeCreate({ vaultPath: "wiki/note.md" })], rows: NO_ROW });
    await runApplySync(OPTS, refused.impl);
    expect(refused.created).toEqual([]);
    expect(refused.notified[0]).toMatch(/refused.*mirror/i);

    const allowed = makeDeps({
      open: [makeCreate({ vaultPath: "wikipedia/note.md" })],
      rows: NO_ROW,
      rendered: { "wikipedia/note.md": { markdown: "x", props: makeProps("wikipedia/note.md") } },
    });
    const result = await runApplySync(OPTS, allowed.impl);
    expect(allowed.created).toHaveLength(1);
    expect(result.applied).toBe(1);
  });

  // Shape is not scope. T6 reads the folder half of the path from a Notion `Folder`
  // property, so a well-formed `personal/x.md` passes every shape rule and is still
  // a folder no pass was configured to sync — and pull, which scopes rows only by
  // `exclude`, would then keep that stray file in step with Notion forever.
  it("refuses a well-formed path outside every configured folder", async () => {
    const inZero7 = (path: string): boolean => path.startsWith("zero7/");
    const d = makeDeps({ open: [makeCreate({ vaultPath: "personal/secrets.md" })], rows: NO_ROW });
    const result = await runApplySync({ dryRun: false, inCreateScope: inZero7 }, d.impl);

    expect(d.created).toEqual([]);
    expect(d.upserts).toEqual([]);
    expect(result.superseded).toBe(1);
    expect(d.notified[0]).toMatch(/refused/i);
    expect(d.notified[0]).toMatch(/outside every folder/i);
  });

  it("allows a path the scope predicate accepts", async () => {
    const inZero7 = (path: string): boolean => path.startsWith("zero7/");
    const d = makeDeps({
      open: [makeCreate()],
      rows: NO_ROW,
      rendered: { [NEW_PATH]: NEW_RENDERED },
    });
    const result = await runApplySync({ dryRun: false, inCreateScope: inZero7 }, d.impl);

    expect(d.created).toHaveLength(1);
    expect(result.applied).toBe(1);
  });

  it("refuses a segment padded with whitespace — a second, identical-looking folder", async () => {
    const d = makeDeps({ open: [makeCreate({ vaultPath: "zero7 /note.md" })], rows: NO_ROW });
    await runApplySync(OPTS, d.impl);
    expect(d.created).toEqual([]);
    expect(d.notified[0]).toMatch(/padded with whitespace/i);
  });

  // The failure the length cap exists to prevent is not a bad write — it is an
  // hourly ENAMETOOLONG that nothing records, because a create has no row for
  // recordDocError to find.
  it("refuses a filename too long for the filesystem, in BYTES", async () => {
    // 150 Norwegian characters = 300 bytes: comfortably under any character-count
    // limit and over NAME_MAX. This is what a slugged meeting title looks like.
    const longName = "æ".repeat(150);
    const d = makeDeps({ open: [makeCreate({ vaultPath: `zero7/${longName}.md` })], rows: NO_ROW });
    await runApplySync(OPTS, d.impl);

    expect(d.created).toEqual([]);
    expect(d.notified[0]).toMatch(/too long/i);
  });

  it("refuses _archive/ and dot-directories", async () => {
    const archive = makeDeps({ open: [makeCreate({ vaultPath: "_archive/note.md" })], rows: NO_ROW });
    await runApplySync(OPTS, archive.impl);
    expect(archive.created).toEqual([]);
    expect(archive.notified[0]).toMatch(/refused/i);

    const dot = makeDeps({ open: [makeCreate({ vaultPath: ".git/hooks/note.md" })], rows: NO_ROW });
    await runApplySync(OPTS, dot.impl);
    expect(dot.created).toEqual([]);
    expect(dot.notified[0]).toMatch(/refused.*dot-directory/i);
  });

  // The engine's existence check is a moment before the write; the adapter's O_EXCL
  // is the write. If the file lands in between, the write fails — and that failure
  // must leave the proposal queued so the next tick refuses it cleanly, never
  // half-recorded as applied.
  it("contains a create that fails at the adapter, leaving the proposal queued", async () => {
    const d = makeDeps({
      open: [makeCreate()],
      rows: NO_ROW,
      createError: new Error("refusing to create: a file already exists there"),
    });
    const result = await runApplySync(OPTS, d.impl);

    expect(d.upserts).toEqual([]);
    expect(d.proposalStates).toEqual([]);   // still approved, retried next tick
    expect(result.errored).toBe(1);
    expect(result.applied).toBe(0);
  });

  // A create has NO backstop: recordDocError is an UPDATE keyed on vault_path and a
  // create has no row, `fail` never pings, and the stale-proposal escalation only
  // looks at 'pending'. Without this the write would fail hourly, forever, seen by
  // nobody. The message is fixed per proposal so the spine's 24h fingerprint gate
  // collapses the repeats into one alert a day.
  it("PINGS a failed create — the one path with no row to record an error against", async () => {
    const d = makeDeps({
      open: [makeCreate()],
      rows: NO_ROW,
      createError: new Error("EACCES: permission denied"),
    });
    await runApplySync(OPTS, d.impl);

    expect(d.notified).toHaveLength(1);
    expect(d.notified[0]).toMatch(/could not create/i);
    // The path AND the error are in the text. The spine fingerprints sha256 of the
    // message, so without both, an ENOSPC on one file and an EACCES on another
    // collapse into one notification and the second is invisible for 24h.
    expect(d.notified[0]).toContain(NEW_PATH);
    expect(d.notified[0]).toContain("EACCES");
  });

  it("keeps that ping identical across ticks, so the 24h gate still collapses it", async () => {
    const scenario = {
      open: [makeCreate()],
      rows: NO_ROW,
      createError: new Error("EACCES: permission denied"),
    };
    const first = makeDeps(scenario);
    const second = makeDeps(scenario);
    await runApplySync(OPTS, first.impl);
    await runApplySync(OPTS, second.impl);

    // Same stuck create, byte-identical message — nothing per-tick in it.
    expect(second.notified[0]).toBe(first.notified[0]);

    // A DIFFERENT failure is a different message, so it is not swallowed by the gate.
    const other = makeDeps({
      open: [makeCreate({ vaultPath: "zero7/other.md" })],
      rows: NO_ROW,
      createError: new Error("ENOSPC: no space left on device"),
    });
    await runApplySync(OPTS, other.impl);
    expect(other.notified[0]).not.toBe(first.notified[0]);
  });

  it("stays silent in dry-run — a rehearsal never pings", async () => {
    const d = makeDeps({
      open: [makeCreate()],
      rows: NO_ROW,
      createError: new Error("EACCES: permission denied"),
    });
    const result = await runApplySync(DRY, d.impl);
    expect(d.notified).toEqual([]);
    expect(result.applied).toBe(1);   // dry-run never reaches the write
  });

  // Minor 1: the file IS on disk, so "was NOT created" would be the opposite of the
  // truth. This is the shape left behind when the `applied` flip fails after a
  // successful create — tryRecord counts that and carries on.
  it("closes, rather than refusing, when the row it finds is its OWN earlier create", async () => {
    const d = makeDeps({
      open: [makeCreate()],
      rows: [[NEW_PATH, makeRow({ pageId: "n9" })]],   // same page as the proposal
    });
    const result = await runApplySync(OPTS, d.impl);

    expect(d.created).toEqual([]);                       // never written twice
    expect(d.proposalStates).toEqual([{ id: 9, state: "applied" }]);
    expect(d.notified[0]).toMatch(/already created/i);
    expect(d.notified[0]).not.toMatch(/NOT created/);
    expect(result.superseded).toBe(1);
  });

  // The row is what stops the push pass adopting the new file and creating a second
  // Notion page for it, so it is written even when the hash-after-write render fails
  // — with an honest empty hash rather than an invented one.
  it("still records the row when the hash-after-write render fails", async () => {
    const d = makeDeps({ open: [makeCreate()], rows: NO_ROW, rendered: {} });
    const result = await runApplySync(OPTS, d.impl);

    expect(d.created).toHaveLength(1);
    expect(d.upserts).toHaveLength(1);
    expect(d.upserts[0].mdHash).toBe("");
    expect(result.applied).toBe(1);
    expect(result.errored).toBe(0);
  });
});

describe("runApplySync — rejected create proposals", () => {
  // A rejected create has nothing to revert: the vault file was never written, so
  // there is no vault content to push back to Notion. Closing it is the whole
  // execution. Left open it would hit the rejected loop's row gate (no row, because
  // nothing was created), be counted as skipped, and warn on every tick forever.
  it("closes the rejection without touching Notion or the vault", async () => {
    const d = makeDeps({ rejected: [makeCreate({ state: "rejected" })], rows: NO_ROW });
    const result = await runApplySync(OPTS, d.impl);

    expect(d.created).toEqual([]);
    expect(d.written).toEqual([]);
    expect(d.patched).toEqual([]);        // the Notion page is left exactly as it is
    expect(d.revertedIds).toEqual([9]);   // closed, so it cannot loop
    expect(result.declined).toBe(1);
    expect(result.reverted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(d.notified[0]).toMatch(/not created/i);
  });

  it("dry-run declines nothing", async () => {
    const d = makeDeps({ rejected: [makeCreate({ state: "rejected" })], rows: NO_ROW });
    const result = await runApplySync(DRY,d.impl);

    expect(d.revertedIds).toEqual([]);
    expect(d.notified).toEqual([]);
    expect(result.declined).toBe(1);
  });

  // THE POLICY (Phase 4, T4): rejecting means "not this content", never "never this
  // document". The declined content is recorded on the state row as accounted-for,
  // keyed by PAGE — the only key a rejected create has, since nothing was written
  // and so no path-bearing row exists. Without it the proposer sees Notion holding
  // content the row has not accounted for and proposes the identical file again,
  // hourly, forever.
  it("records the declined content against the PAGE, so it is never proposed again", async () => {
    const d = makeDeps({ rejected: [makeCreate({ state: "rejected" })], rows: NO_ROW });
    await runApplySync(OPTS, d.impl);

    expect(d.accounted).toEqual([{ pageId: "n9", notionHash: sha256("notes pulled from Notion") }]);
  });

  // …and the record and the close travel together. Two independent tryRecords would
  // close the proposal over a failed record — which drops it out of
  // getRejectedUnexecuted, the one thing keeping the proposer quiet — and the loop
  // this branch exists to end would start on the very next tick.
  it("leaves the rejection UNEXECUTED when the decline record fails, so the next tick retries", async () => {
    const d = makeDeps({ rejected: [makeCreate({ state: "rejected" })], rows: NO_ROW });
    d.impl.recordNotionAccounted = async () => { throw new Error("db down"); };

    const result = await runApplySync(OPTS, d.impl);

    expect(result.bookkeepingFailed).toBe(1);
    expect(d.revertedIds).toEqual([]);      // NOT closed — still the engine's work queue
  });
});

describe("runApplySync — containment and dry-run", () => {
  it("contains a notify failure", async () => {
    const d = makeDeps({ open: [makeProposal()], notifyThrows: true });
    const result = await runApplySync(OPTS, d.impl);

    expect(result.applied).toBe(1);
    expect(d.written).toHaveLength(1);
    expect(result.bookkeepingFailed).toBe(0);
  });

  it("counts a bookkeeping failure without aborting the run", async () => {
    const d = makeDeps({ open: [makeProposal()] });
    d.impl.setProposalState = async () => { throw new Error("db down"); };
    const result = await runApplySync(OPTS, d.impl);

    expect(d.written).toHaveLength(1);
    expect(result.bookkeepingFailed).toBe(1);
  });

  it("dry-run plans everything and writes nothing at all", async () => {
    const d = makeDeps({
      open: [makeProposal()],
      rejected: [makeProposal({ id: 5, state: "rejected", vaultPath: "desks/orakel/other.md" })],
      rows: [["desks/orakel/other.md", makeRow()], [PATH, makeRow()]],
      rendered: { [PATH]: RENDERED, "desks/orakel/other.md": { markdown: VAULT_BODY, props: makeProps("desks/orakel/other.md") } },
    });
    const result = await runApplySync(DRY,d.impl);

    expect(d.written).toEqual([]);
    expect(d.patched).toEqual([]);
    expect(d.propUpdates).toEqual([]);
    expect(d.upserts).toEqual([]);
    expect(d.proposalStates).toEqual([]);
    expect(d.revertedIds).toEqual([]);
    expect(d.frozenCalls).toEqual([]);
    expect(d.notified).toEqual([]);

    expect(result.applied).toBe(1);
    expect(result.reverted).toBe(1);
    expect(result.summary).toContain("(dry-run)");
  });
});

// ── The stamp an approved pull carries (ADR-0017 rule 9, W4D-s2) ──────────────────
// Every write below goes through the SAME runApplySync and the same fake deps as
// everything above; these two helpers only spare each case the scenario boilerplate.

type VaultWrite = { vaultPath: string; content: string };

/** Runs one approved UPDATE against a given disk file and returns the bytes written —
 *  or, with `capture`, every write the run made, which for a dry run is none. */
async function applyOneUpdate(
  cfg: { disk: string; proposedBody: string; dryRun?: boolean; capture?: false },
): Promise<string>;
async function applyOneUpdate(
  cfg: { disk: string; proposedBody: string; dryRun?: boolean; capture: true },
): Promise<{ writes: VaultWrite[] }>;
async function applyOneUpdate(cfg: {
  disk: string; proposedBody: string; dryRun?: boolean; capture?: boolean;
}): Promise<string | { writes: VaultWrite[] }> {
  const d = makeDeps({
    open: [makeProposal({ proposedBody: cfg.proposedBody })],
    sources: { [PATH]: cfg.disk },
  });
  await runApplySync(cfg.dryRun === true ? DRY : OPTS, d.impl);
  if (cfg.capture === true) return { writes: d.written };
  return d.written[0]!.content;
}

/** Runs one approved CREATE with a given proposed file and returns the bytes created. */
async function applyOneCreate(cfg: { proposedBody: string }): Promise<string> {
  const d = makeDeps({
    open: [makeCreate({ proposedBody: cfg.proposedBody })],
    rows: NO_ROW,
    rendered: { [NEW_PATH]: NEW_RENDERED },
  });
  await runApplySync(OPTS, d.impl);
  return d.created[0]!.content;
}

describe("an approved pull carries the stamp (ADR-0017 rule 9)", () => {
  it("stamps a file that has frontmatter but no lares_origin", async () => {
    const written = await applyOneUpdate({
      disk: "---\ntype: note\ntitle: a note\n---\n\nold body\n",
      proposedBody: "new body from notion",
    });
    expect(written).toContain("lares_origin: synced");
    expect(written).toContain("title: a note");
    expect(written).toContain("new body from notion");
  });

  it("stamps a file that has NO frontmatter at all — the drop this closes", async () => {
    const written = await applyOneUpdate({ disk: "# heading\n\nold body\n", proposedBody: "new body" });
    expect(written.startsWith("---\nlares_origin: synced\n---\n")).toBe(true);
    expect(written).toContain("new body");
  });

  it("never writes the stamp into a body that opens with a horizontal rule", async () => {
    const body = "---\nfirst section\n\n---\nsecond section";
    const written = await applyOneUpdate({ disk: "# heading\n\nold body\n", proposedBody: body });
    expect(written).toBe(`---\nlares_origin: synced\n---\n\n${body}\n`);
  });

  it("keeps an owner stamp rather than downgrading it to synced", async () => {
    const written = await applyOneUpdate({
      disk: "---\ntype: note\nlares_origin: owner\n---\n\nold\n",
      proposedBody: "new body",
    });
    expect(written).toContain("lares_origin: owner");
    expect(written).not.toContain("lares_origin: synced");
  });

  it("keeps a third_party stamp — never raises a class either", async () => {
    const written = await applyOneUpdate({
      disk: "---\nlares_origin: third_party\n---\n\nold\n",
      proposedBody: "new",
    });
    expect(written).toContain("lares_origin: third_party");
  });

  it("re-asserts the stamp on a create, rather than trusting the proposer", async () => {
    const written = await applyOneCreate({ proposedBody: "---\ntype: note\n---\n\nbody\n" });
    expect(written).toContain("lares_origin: synced");
  });

  it("leaves a create whose proposer already stamped it byte-identical", async () => {
    const body = "---\ntype: note\nsource: notion-docs\nlares_origin: synced\nnotion_page: p1\n---\n\nbody\n";
    expect(await applyOneCreate({ proposedBody: body })).toBe(`${body}\n`);
  });

  it("writes nothing at all on a dry run, stamp or no stamp", async () => {
    const { writes } = await applyOneUpdate({
      disk: "# h\n", proposedBody: "b", dryRun: true, capture: true,
    });
    expect(writes).toEqual([]);
  });
});
