// A Notion-owned document (`direction: 'notion_to_md'`) across CONSECUTIVE TICKS.
//
// Why this file has to exist, and why a one-tick test cannot replace it: the
// approved-update path deliberately leaves `md_hash` stale, because "the push pass
// runs later in the same tick, re-renders the applied file, pushes it and takes its
// own hash-after-write reading" (apply-sync.ts). That sentence is a claim about
// ANOTHER PASS, and for a Notion-owned row it is false — push holds the row back on
// purpose (readOnlyVaultPaths), so nothing refreshes md_hash and the NEXT tick's
// conflict check sees a vault render that no longer matches the store.
//
// The result was a freeze after every single approval, with the reason "changed in
// both Notion and the vault" — which is not even true; only Notion changed, and the
// vault changed because this service wrote it. The exit the freeze ping offers is
// `notion-sync resolve --keep md`, which writes the vault back over Notion: the
// exact direction this whole feature forbids.
//
// So: three ticks, and the assertion is the absence of a freeze.
//
// The push pass is not driven here. It provably does nothing for these rows — that
// is proven directly, twice, in wiki-sync.test.ts (never patched however far the
// vault has drifted; never Archived) — so modelling it as a no-op is faithful, and
// wiring a whole vault-file adapter in would test the same thing less clearly.
import { describe, it, expect } from "vitest";
import { makeCollisionLookup } from "./helpers/collision-world.js";
import { runPullSync, docRenderHash, type PullSyncDeps, type RenderedDoc } from "../lib/pull-sync.js";
import { runApplySync, type ApplySyncDeps } from "../lib/apply-sync.js";
import { sha256 } from "../lib/wiki-sync.js";
import { makeDeskExclusion, makeCreateScope } from "../lib/desk-scope.js";
import { NOTION_TO_MD, TWO_WAY } from "../lib/direction.js";
import type { DeskRow, ProposalRow, ProposalState } from "../lib/store.js";

const PULL_OPTS = {
  dryRun: false,
  now: new Date("2026-08-04T12:00:00.000Z"),
  isExcluded: makeDeskExclusion(undefined),
};
// No creates in this world, so the scope predicate is never consulted — built
// through the real derivation anyway, so it can never become a stub by drift.
const APPLY_OPTS = { dryRun: false, inCreateScope: makeCreateScope({}) };

const PATH = "zero7/transcripts/2026-08-05-standup.md";
const PAGE = "n1";
const ORIGINAL_BODY = "# Standup\n\nwhat Notion held to begin with";
const VAULT_SOURCE = `---\ntitle: Standup\n---\n\n${ORIGINAL_BODY}\n`;
const NOTION_EDIT = "# Standup\n\nwhat Bendik typed in Notion";

function render(vaultPath: string, source: string): RenderedDoc {
  const match = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(source);
  const frontmatter = match === null ? "" : match[1];
  const body = (match === null ? source : match[2]).replace(/\n+$/, "");
  return {
    markdown: body,
    props: {
      name: "Standup", project: "P", folder: "zero7/transcripts", vaultPath,
      frontmatter, archived: false, sync: "📥 Notion source",
    },
  };
}

interface StoredProposal extends ProposalRow {
  resolvedAt: Date | null;
}

function makeWorld(direction: string) {
  const rows = new Map<string, DeskRow>();
  const proposals: StoredProposal[] = [];
  const notion = new Map<string, { markdown: string; lastEditedTime: string }>();
  const vault = new Map<string, string>();
  const notifications: string[] = [];
  const frozen: Array<{ vaultPath: string; reason: string }> = [];
  let nextProposalId = 1;
  let clock = 0;

  const stamp = (): string => {
    clock += 1;
    return `2026-08-04T1${clock}:00:00.000Z`;
  };

  vault.set(PATH, VAULT_SOURCE);
  notion.set(PAGE, { markdown: ORIGINAL_BODY, lastEditedTime: "2026-08-04T10:00:00.000Z" });
  rows.set(PATH, {
    pageId: PAGE,
    mdHash: docRenderHash(render(PATH, VAULT_SOURCE)),
    notionHash: sha256(ORIGINAL_BODY),
    notionLastEdited: "2026-08-04T10:00:00.000Z",
    state: "synced",
    direction,
  });

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
      notion.set(pageId, { markdown: `stored:${markdown}`, lastEditedTime: stamp() });
    },
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
        notionLastEdited: doc.notionLastEdited ?? existing?.notionLastEdited ?? null,
        state: existing?.state === "frozen" ? "frozen" : "synced",
        // Ignored on conflict, exactly like the store's ON CONFLICT branch.
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
    freezeDoc: async (vaultPath: string, reason: string) => {
      const row = rows.get(vaultPath);
      if (row !== undefined) rows.set(vaultPath, { ...row, state: "frozen" });
      frozen.push({ vaultPath, reason });
    },
    recordDocError: async () => {},
    notify: async (message: string) => { notifications.push(message); },
  };

  const pullDeps: PullSyncDeps = {
    ...shared,
    queryDocs: async () => [...notion].map(([pageId, page]) => ({
      pageId, vaultPath: PATH, lastEditedTime: page.lastEditedTime,
    })),
    getStaleProposals: async () => [],
    getFrozenDocs: async () => [],
    createDocPage: async () => { throw new Error("not exercised here"); },
    archiveVaultFile: async (vaultPath: string) => { vault.delete(vaultPath); },
    insertProposal: async (input) => {
      const id = nextProposalId++;
      proposals.push({
        ...input, diffPreview: input.diffPreview ?? "", kind: input.kind ?? "update", notionOwned: direction === "notion_to_md",
        id, state: "pending", createdAt: new Date(), resolvedAt: null,
      });
      return id;
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
    createVaultFile: async (vaultPath: string, content: string) => {
      if (vault.has(vaultPath)) throw new Error(`a file already exists at ${vaultPath}`);
      vault.set(vaultPath, content);
    },
    // Not this seam's concern — the forget-ledger gate is covered end to end in
    // tests/forget-ledger-gate.test.ts.
    pathWasForgotten: async () => null,
  };

  /** One tick, in tickPasses order minus the push that holds these rows back. */
  async function tick(): Promise<void> {
    await runPullSync(PULL_OPTS, pullDeps);
    await runApplySync(APPLY_OPTS, applyDeps);
  }

  return { rows, proposals, notion, vault, notifications, frozen, tick, stamp };
}

describe("a Notion-owned document, approved, across three ticks", () => {
  it("converges: written once, then quiet — never frozen for 'changed in both'", async () => {
    const w = makeWorld(NOTION_TO_MD);

    // Bendik edits the page at its source.
    w.notion.set(PAGE, { markdown: NOTION_EDIT, lastEditedTime: w.stamp() });

    // TICK 1 — pull proposes; nothing is written anywhere.
    await w.tick();
    expect(w.proposals).toHaveLength(1);
    expect(w.proposals[0].state).toBe("pending");
    expect(w.vault.get(PATH)).toBe(VAULT_SOURCE);
    expect(w.frozen).toEqual([]);

    // Bendik taps 👍.
    w.proposals[0].state = "approved";

    // TICK 2 — apply writes the vault. Pull, running first, must leave the row
    // alone because an approved proposal already covers exactly this content.
    await w.tick();
    // The disk block, plus the one key apply adds: the body below came from Notion,
    // so the file says so (W4D-s2). The stamped bytes are what the hash-after-write
    // reading is taken over too — otherwise tick 3 below would find a mismatch.
    expect(w.vault.get(PATH)).toBe(`---\nlares_origin: synced\ntitle: Standup\n---\n\n${NOTION_EDIT}\n`);
    expect(w.proposals[0].state).toBe("applied");
    expect(w.frozen).toEqual([]);
    // The Notion page is untouched: this direction never writes it from the vault.
    expect(w.notion.get(PAGE)?.markdown).toBe(NOTION_EDIT);

    // TICK 3 — THE TEST. Nothing has changed on either side since the write, so
    // this tick must be a no-op. Before the fix it froze here: push never
    // refreshed md_hash (it holds these rows back), so the conflict check saw a
    // vault render that no longer matched the store and blamed the human.
    await w.tick();
    expect(w.frozen).toEqual([]);
    expect(w.rows.get(PATH)?.state).toBe("synced");
    expect(w.proposals).toHaveLength(1);          // no re-proposal
    expect(w.notion.get(PAGE)?.markdown).toBe(NOTION_EDIT);

    // …and a fourth, because a two-tick oscillation would still pass three.
    await w.tick();
    expect(w.frozen).toEqual([]);
    expect(w.rows.get(PATH)?.state).toBe("synced");
    expect(w.proposals).toHaveLength(1);

    // No freeze ping, and no "resolve with:" instruction pointing him at the one
    // command that would write his Notion page back from the vault.
    expect(w.notifications.filter((n) => /frozen|resolve with/i.test(n))).toEqual([]);
  });

  // The whole point of the fix is that it is scoped to the direction that needs it.
  it("leaves a two-way row's convergence to the push pass, exactly as before", async () => {
    const w = makeWorld(TWO_WAY);
    w.notion.set(PAGE, { markdown: NOTION_EDIT, lastEditedTime: w.stamp() });

    await w.tick();
    w.proposals[0].state = "approved";
    await w.tick();

    expect(w.vault.get(PATH)).toBe(`---\nlares_origin: synced\ntitle: Standup\n---\n\n${NOTION_EDIT}\n`);
    expect(w.proposals[0].state).toBe("applied");
    // md_hash is STALE on purpose here — the push pass this world does not run is
    // what refreshes it. Asserting the staleness pins the boundary of the fix: the
    // apply path must not have started recording hashes for two-way rows.
    expect(w.rows.get(PATH)?.mdHash).toBe(docRenderHash(render(PATH, VAULT_SOURCE)));
  });
});

describe("a Notion-owned document, rejected", () => {
  it("does not write the vault, does not touch Notion, and never asks again", async () => {
    const w = makeWorld(NOTION_TO_MD);
    w.notion.set(PAGE, { markdown: NOTION_EDIT, lastEditedTime: w.stamp() });

    await w.tick();
    expect(w.proposals).toHaveLength(1);
    w.proposals[0].state = "rejected";       // 👎

    // TICK 2 — the rejection executes.
    await w.tick();
    // The vault keeps its own version: "no" means "do not bring this in".
    expect(w.vault.get(PATH)).toBe(VAULT_SOURCE);
    // …and Notion is NOT overwritten from the vault. That is the write this
    // direction forbids, and it is what the mirror/two-way path would have done.
    expect(w.notion.get(PAGE)?.markdown).toBe(NOTION_EDIT);
    expect(w.proposals[0].resolvedAt).not.toBeNull();

    // TICK 3 — and he is not asked about the same edit again. Without recording
    // that this content was seen and declined, pull would re-propose it forever.
    await w.tick();
    expect(w.proposals).toHaveLength(1);
    expect(w.frozen).toEqual([]);

    // A LATER edit is still a fresh question.
    w.notion.set(PAGE, { markdown: "# Standup\n\na third version", lastEditedTime: w.stamp() });
    await w.tick();
    expect(w.proposals).toHaveLength(2);
    expect(w.proposals[1].state).toBe("pending");
  });
});
