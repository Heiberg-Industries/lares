// A transcript across CONSECUTIVE TICKS — the test this task's brief calls its
// highest-risk area, because T3b was bitten TWICE by a change that looked right for
// one tick and then froze or churned on the next.
//
// A one-tick test cannot see any of what this file is for. Three separate mechanisms
// only exist between ticks:
//
//   - the create's bookkeeping (`vault_path` landing on the MEETINGS row rather than
//     a second, UNIQUE-violating docs row) is what makes tick 3 recognise the file it
//     made on tick 2 — get it wrong and the pass proposes the same new file forever;
//   - the DECLINE record is what makes the tick after a 👎 silent — without it Bendik
//     gets the identical DM every hour for the rest of time;
//   - the update path's base hash and the row's `md_hash` are written by two
//     different passes and compared by a third, so they can only be proved to agree
//     by running all of them in order.
//
// So: a world that models the store's real keying (rows keyed by PAGE, `vault_path`
// UNIQUE across targets), and ticks driven in the order lib/cli.ts fixes.
//
// The passes not driven here — pull, wiki, desk — provably do nothing for these
// rows: all three scope their reads to `target='docs'`, and a transcript's state row
// is `target='meetings'`. That is asserted directly rather than assumed, at the
// bottom of this file and again against a real Postgres in cli.test.ts.
import { describe, it, expect } from "vitest";
import { makeCollisionLookup } from "./helpers/collision-world.js";
import {
  runTranscriptSync, transcriptBody,
  type TranscriptSyncDeps, type TranscriptSyncOptions, type TranscriptMeetingRow,
  type TranscriptSyncResult,
} from "../lib/transcript-sync.js";
import { runApplySync, type ApplySyncDeps } from "../lib/apply-sync.js";
import { docRenderHash, type RenderedDoc } from "../lib/pull-sync.js";
import { sha256 } from "../lib/wiki-sync.js";
import { makeCreateScope, makeDeskExclusion } from "../lib/desk-scope.js";
import type {
  DocState, DocTarget, LinkedFileInput, LinkedRow, MeetingStateRow, ProposalRow,
} from "../lib/store.js";

/** One `notion_sync_docs` row, keyed the way the real table is: by notion_page_id. */
interface StoreRow {
  pageId: string;
  vaultPath: string | null;
  target: DocTarget;
  direction: string;
  state: DocState;
  mdHash: string | null;
  notionHash: string | null;
  notionLastEdited: string | null;
}

/** `getDeskRows`'s predicate, exactly: `target = 'docs' AND vault_path IS NOT NULL`. */
function deskRowPaths(store: Map<string, StoreRow>): string[] {
  return [...store.values()]
    .filter((row) => row.target === "docs" && row.vaultPath !== null)
    .map((row) => row.vaultPath as string);
}

const CONFIG = {
  desks: {
    deskDirs: [{ dir: "alpha", project: "Alpha", exclude: ["transcripts"] }],
    twoWayDirs: [],
    mirrorFilePrefixes: [],
  },
  transcripts: { dir: "transcripts", projects: [{ notionProject: "Alpha", vaultFolder: "alpha" }] },
};
const TRANSCRIPT_OPTS: TranscriptSyncOptions = {
  dryRun: false, dir: "transcripts", projects: CONFIG.transcripts.projects,
  isExcluded: makeDeskExclusion(CONFIG.desks),
};
// Built through the REAL derivation, never a `() => true` stub — the engine probes
// this predicate with a sentinel and refuses to run creates against one that is not
// scoping anything (T3b fix round 2).
const APPLY_OPTS = { dryRun: false, inCreateScope: makeCreateScope(CONFIG) };

const PAGE = "meeting-1";
const TITLE = "Ukesmøte";
const PATH = "alpha/transcripts/2026-08-05-ukesmoete.md";
const MARKDOWN = "## Beslutninger\n- [x] valgte alternativ to\n\n<transcript>\nBendik: ja\n</transcript>";
const EDITED = "## Beslutninger\n- [x] valgte alternativ to\n- [ ] og ett til\n\n<transcript>\nBendik: ja\n</transcript>";

function render(vaultPath: string, source: string): RenderedDoc {
  const match = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(source);
  return {
    markdown: (match === null ? source : match[2]).replace(/\n+$/, ""),
    props: {
      name: TITLE, project: "Alpha", folder: "alpha/transcripts", vaultPath,
      frontmatter: match === null ? "" : match[1], archived: false, sync: "📥 Notion source",
    },
  };
}

interface StoredProposal extends ProposalRow {
  resolvedAt: Date | null;
}

function makeWorld() {
  const store = new Map<string, StoreRow>();
  const proposals: StoredProposal[] = [];
  const vault = new Map<string, string>();
  const notifications: string[] = [];
  /** Every Notion WRITE this world ever sees. Must stay empty, forever. */
  const notionWrites: string[] = [];
  let nextProposalId = 1;

  // Mutable: a retitle in Notion changes this property and nothing else, which is
  // the case the path-fixing rule (decision 1) exists for.
  const meeting: TranscriptMeetingRow = {
    pageId: PAGE, title: TITLE, project: "Alpha", startsAt: "2026-08-05T09:00:00.000+02:00",
  };
  const notion = new Map<string, string>([[PAGE, MARKDOWN]]);

  /**
   * `getLinkedRows`: `WHERE vault_path IS NOT NULL`, keyed by path, across BOTH
   * targets. Declared once and handed to the transcript pass AND the apply pass,
   * because the whole point of the tracked-path guard is that the proposer and the
   * guard that would refuse it read the same question from the same reader.
   */
  const linkedRows = async (): Promise<Map<string, LinkedRow>> => {
    const rows = new Map<string, LinkedRow>();
    for (const row of store.values()) {
      if (row.vaultPath === null) continue;
      rows.set(row.vaultPath, {
        pageId: row.pageId, mdHash: row.mdHash, notionHash: row.notionHash,
        notionLastEdited: row.notionLastEdited, state: row.state,
        direction: row.direction, target: row.target,
      });
    }
    return rows;
  };

  const transcriptDeps: TranscriptSyncDeps = {
    queryMeetings: async () => [{ ...meeting }],
    getMeetingRows: async () => {
      const rows = new Map<string, MeetingStateRow>();
      for (const [pageId, row] of store) {
        if (row.target !== "meetings") continue;
        rows.set(pageId, {
          pageId, vaultPath: row.vaultPath, mdHash: row.mdHash, notionHash: row.notionHash,
        });
      }
      return rows;
    },
    getOpenProposals: async () =>
      proposals.filter((p) => p.state === "pending" || p.state === "approved").map((p) => ({ ...p })),
    getRejectedUnexecuted: async () =>
      proposals.filter((p) => p.state === "rejected" && p.resolvedAt === null).map((p) => ({ ...p })),
    getPageMarkdown: async (pageId) => {
      const markdown = notion.get(pageId);
      if (markdown === undefined) throw new Error(`no such page ${pageId}`);
      return markdown;
    },
    renderDoc: async (vaultPath) => {
      const source = vault.get(vaultPath);
      if (source === undefined) throw new Error(`ENOENT: ${vaultPath}`);
      return render(vaultPath, source);
    },
    readVaultFile: async (vaultPath) => {
      const source = vault.get(vaultPath);
      if (source === undefined) throw new Error(`ENOENT: ${vaultPath}`);
      return source;
    },
    vaultFileExists: async (vaultPath) => vault.has(vaultPath),
    getLinkedRows: linkedRows,
    ensureMeetingRow: async (pageId) => {
      if (store.has(pageId)) return;   // ON CONFLICT DO NOTHING
      store.set(pageId, {
        pageId, vaultPath: null, target: "meetings", direction: "notion_to_md",
        state: "synced", mdHash: null, notionHash: null, notionLastEdited: null,
      });
    },
    insertProposal: async (input) => {
      const id = nextProposalId++;
      proposals.push({
        ...input,
        diffPreview: input.diffPreview ?? "",
        kind: input.kind ?? "update",
        notionOwned: true,
        id, state: "pending", createdAt: new Date(), resolvedAt: null,
      });
      return id;
    },
    setProposalState: async (id, state) => {
      const proposal = proposals.find((p) => p.id === id);
      if (proposal === undefined) throw new Error(`no proposal ${id}`);
      proposal.state = state;
      if (state === "applied" || state === "superseded") proposal.resolvedAt = new Date();
    },
    recordNotionAccounted: async (pageId, notionHash) => {
      const row = store.get(pageId);
      if (row !== undefined) row.notionHash = notionHash;   // no row ⇒ no-op, as in SQL
    },
    notify: async (message) => { notifications.push(message); },
  };

  const applyDeps: ApplySyncDeps = {
    getOpenProposals: transcriptDeps.getOpenProposals,
    getRejectedUnexecuted: transcriptDeps.getRejectedUnexecuted,
    getLinkedRows: linkedRows,
    renderDoc: transcriptDeps.renderDoc,
    readVaultFile: transcriptDeps.readVaultFile,
    vaultFileExists: transcriptDeps.vaultFileExists,
    writeVaultFile: async (vaultPath, content) => { vault.set(vaultPath, content); },
    // Guard 3b's input, from the SAME world `vaultFileExists` answers for — two
    // different worlds here would let the two halves of one guard agree by accident.
    // One shared model (tests/helpers/collision-world.ts); see its header for what it
    // does and does not model.
    listCollisionCandidates: makeCollisionLookup(() => vault.keys()),
    createVaultFile: async (vaultPath, content) => {
      // The real adapter is O_EXCL: a create that meets an existing file fails.
      if (vault.has(vaultPath)) throw new Error(`a file already exists at ${vaultPath}`);
      vault.set(vaultPath, content);
    },
    patchPageMarkdown: async (pageId) => { notionWrites.push(`patch:${pageId}`); },
    updateDocProps: async (pageId) => { notionWrites.push(`props:${pageId}`); },
    getPageMarkdown: transcriptDeps.getPageMarkdown,
    upsertDocSynced: async () => { throw new Error("not expected: no path-keyed upsert on this seam"); },
    linkPageToVaultFile: async (doc: LinkedFileInput) => {
      // ON CONFLICT (notion_page_id): adopt the existing row (and only the columns
      // the real statement names), or insert a fresh docs row. The md_hash CASE is
      // modelled exactly — a meetings row takes the WRITTEN-BODY hash, a docs row
      // keeps the render hash — because that distinction is the whole of N1.
      const existing = store.get(doc.pageId);
      if (existing !== undefined) {
        existing.vaultPath = doc.vaultPath;
        existing.mdHash = existing.target === "meetings" ? doc.writtenBodyHash : doc.mdHash;
        existing.notionHash = doc.notionHash;
        existing.notionLastEdited = doc.notionLastEdited ?? existing.notionLastEdited;
        return;
      }
      store.set(doc.pageId, {
        pageId: doc.pageId, vaultPath: doc.vaultPath, target: "docs",
        direction: doc.direction ?? "md_to_notion", state: "synced",
        mdHash: doc.mdHash, notionHash: doc.notionHash, notionLastEdited: doc.notionLastEdited,
      });
    },
    updateNotionWatermark: async (vaultPath, notionHash, notionLastEdited) => {
      // `WHERE vault_path = $1` — not target-scoped, so it reaches a meetings row.
      for (const row of store.values()) {
        if (row.vaultPath !== vaultPath) continue;
        row.notionHash = notionHash;
        row.notionLastEdited = notionLastEdited;
      }
    },
    recordNotionAccounted: transcriptDeps.recordNotionAccounted,
    setProposalState: transcriptDeps.setProposalState,
    markProposalReverted: async (id) => {
      const proposal = proposals.find((p) => p.id === id);
      if (proposal === undefined) throw new Error(`no proposal ${id}`);
      if (proposal.state === "rejected" && proposal.resolvedAt === null) proposal.resolvedAt = new Date();
    },
    freezeDoc: async () => { throw new Error("not expected: freezeDoc is target='docs' and cannot reach a meetings row"); },
    recordDocError: async () => {},
    notify: async (message) => { notifications.push(message); },
    // Not this seam's concern — the forget-ledger gate is covered end to end in
    // tests/forget-ledger-gate.test.ts.
    pathWasForgotten: async () => null,
  };

  /**
   * One tick, in tickPasses order minus the three passes that cannot see this row.
   * Returns the transcript pass's own result, because some of what this file has to
   * prove is a SKIP — a thing that happens by nothing happening, and is otherwise
   * indistinguishable from a pass that quietly did nothing at all.
   */
  async function tick(): Promise<TranscriptSyncResult> {
    const result = await runTranscriptSync(TRANSCRIPT_OPTS, transcriptDeps);
    await runApplySync(APPLY_OPTS, applyDeps);
    return result;
  }

  return { store, proposals, vault, notion, meeting, notifications, notionWrites, tick };
}

const FIRST_HASH = sha256(transcriptBody(TITLE, MARKDOWN));

describe("a transcript, approved, across four ticks", () => {
  it("is created once and then goes quiet — no second file, no second row, no churn", async () => {
    const w = makeWorld();

    // TICK 1 — proposed. Nothing is written on either side.
    await w.tick();
    expect(w.proposals).toHaveLength(1);
    expect(w.proposals[0].kind).toBe("create");
    expect(w.proposals[0].vaultPath).toBe(PATH);
    expect(w.vault.size).toBe(0);
    // The row was reserved so the decision has somewhere to live, and it carries no
    // vault_path yet — which is what keeps the create's own guards meaningful.
    expect(w.store.get(PAGE)?.vaultPath).toBeNull();

    // Bendik taps 👍.
    w.proposals[0].state = "approved";

    // TICK 2 — the transcript pass must leave the row alone (an open proposal
    // already carries exactly this content), and apply writes the file.
    await w.tick();
    expect(w.proposals).toHaveLength(1);
    expect(w.proposals[0].state).toBe("applied");
    expect(w.vault.get(PATH)).toContain("<transcript>\nBendik: ja\n</transcript>");
    // Exactly one trailing newline: the proposal stored none, the engine added one.
    expect(w.vault.get(PATH)?.endsWith("\n</transcript>\n")).toBe(true);

    // THE ROW: the Meetings row was filled in, and no second row was inserted.
    expect(w.store.size).toBe(1);
    const row = w.store.get(PAGE);
    expect(row?.vaultPath).toBe(PATH);
    expect(row?.target).toBe("meetings");
    expect(row?.direction).toBe("notion_to_md");
    expect(row?.notionHash).toBe(FIRST_HASH);

    // TICK 3 — THE TEST. Nothing changed on either side, so this tick does nothing.
    await w.tick();
    expect(w.proposals).toHaveLength(1);
    expect(w.vault.size).toBe(1);
    expect(w.store.size).toBe(1);

    // …and a fourth, because a two-tick oscillation would still pass three.
    await w.tick();
    expect(w.proposals).toHaveLength(1);
    expect(w.vault.size).toBe(1);
    expect(w.store.size).toBe(1);

    // Notion was never written to, at any point, by any pass.
    expect(w.notionWrites).toEqual([]);
    expect(w.notion.get(PAGE)).toBe(MARKDOWN);
  });

  it("a retitle changes the heading INSIDE the file, never the path — and then settles", async () => {
    const w = makeWorld();
    await w.tick();
    w.proposals[0].state = "approved";
    await w.tick();
    await w.tick();                                   // settled

    // Bendik renames the meeting in Notion. The page MARKDOWN is byte-identical —
    // the title is a PROPERTY — which is exactly why the change test hashes the
    // body this engine composes rather than what the API handed back.
    w.meeting.title = "Ukesmøte — nytt navn";

    await w.tick();
    expect(w.proposals).toHaveLength(2);
    expect(w.proposals[1].kind).toBe("update");
    // The stored vault_path wins over anything the new title would derive: a second
    // file here would orphan the first, with every backlink pointing at a dead note.
    expect(w.proposals[1].vaultPath).toBe(PATH);
    expect(w.proposals[1].proposedBody.startsWith("# Ukesmøte — nytt navn")).toBe(true);

    w.proposals[1].state = "approved";
    await w.tick();
    expect(w.vault.get(PATH)).toContain("# Ukesmøte — nytt navn");
    expect(w.vault.get(PATH)).not.toContain("# Ukesmøte\n");
    expect([...w.vault.keys()]).toEqual([PATH]);      // still exactly one file

    // …and two more quiet ticks.
    await w.tick();
    await w.tick();
    expect(w.proposals).toHaveLength(2);
    expect(w.store.size).toBe(1);
    expect(w.notionWrites).toEqual([]);
  });

  it("an edit in Notion becomes an UPDATE proposal, applies, and settles", async () => {
    const w = makeWorld();
    await w.tick();
    w.proposals[0].state = "approved";
    await w.tick();
    await w.tick();

    // Bendik ticks another todo on the page.
    w.notion.set(PAGE, EDITED);

    // TICK 4 — proposed as an UPDATE against the file that now exists.
    await w.tick();
    expect(w.proposals).toHaveLength(2);
    expect(w.proposals[1].kind).toBe("update");
    expect(w.proposals[1].vaultPath).toBe(PATH);          // never a second file
    // The base hash is the render of the file as it stands — the staleness guard
    // apply re-checks at approval time.
    expect(w.proposals[1].baseMdHash)
      .toBe(docRenderHash(render(PATH, w.vault.get(PATH) as string)));
    expect(w.proposals[1].diffPreview).toContain("+ - [ ] og ett til");
    // Not yet written: this is a proposal, not a write.
    expect(w.vault.get(PATH)).not.toContain("og ett til");

    w.proposals[1].state = "approved";

    // TICK 5 — applied, with the frontmatter lifted verbatim from disk.
    await w.tick();
    expect(w.vault.get(PATH)).toContain("og ett til");
    expect(w.vault.get(PATH)).toContain("notion_page: meeting-1");
    expect(w.proposals[1].state).toBe("applied");

    // TICKS 6 and 7 — quiet. This is where the notion-owned seam bug lived: the
    // push pass never refreshes md_hash for this direction, so without apply's own
    // reconciliation the next tick sees a vault render that no longer matches the
    // store and re-proposes (or, on the desk side, freezes).
    await w.tick();
    await w.tick();
    expect(w.proposals).toHaveLength(2);
    expect(w.store.size).toBe(1);
    expect(w.notionWrites).toEqual([]);
  });
});

describe("a transcript, rejected", () => {
  it("is not created, is not asked about again, and a LATER edit still asks", async () => {
    const w = makeWorld();

    // TICK 1 — proposed.
    await w.tick();
    expect(w.proposals).toHaveLength(1);

    // Bendik taps 👎.
    w.proposals[0].state = "rejected";

    // TICK 2 — the transcript pass must stay silent (the decline has not executed
    // yet, and it runs BEFORE apply), and apply carries the rejection out.
    await w.tick();
    expect(w.proposals).toHaveLength(1);
    expect(w.proposals[0].resolvedAt).not.toBeNull();
    // Nothing was created, and the Notion page was not touched — "no" means "do not
    // bring this into the vault", never "undo it in Notion".
    expect(w.vault.size).toBe(0);
    expect(w.notionWrites).toEqual([]);
    expect(w.notion.get(PAGE)).toBe(MARKDOWN);

    // TICKS 3, 4 and 5 — he is never asked again. Without a decline record this is
    // where the same DM would arrive every hour, forever. Asserted BEFORE the
    // mechanism below, so a regression shows up as the consequence Bendik would
    // actually feel rather than as a hash that moved.
    await w.tick();
    await w.tick();
    await w.tick();
    expect(w.proposals).toHaveLength(1);
    expect(w.vault.size).toBe(0);

    // …and the mechanism that achieves it: the declined content is recorded against
    // the PAGE as accounted-for, which is the only key a rejected create has.
    expect(w.store.get(PAGE)?.notionHash).toBe(FIRST_HASH);

    // A LATER edit is a fresh question: "not this content", never "never again".
    w.notion.set(PAGE, EDITED);
    await w.tick();
    expect(w.proposals).toHaveLength(2);
    expect(w.proposals[1].state).toBe("pending");
    expect(w.proposals[1].kind).toBe("create");         // still nothing on disk
    expect(w.proposals[1].vaultPath).toBe(PATH);

    // …and rejecting THAT one settles again, with no create ever having happened.
    w.proposals[1].state = "rejected";
    await w.tick();
    await w.tick();
    expect(w.proposals).toHaveLength(2);
    expect(w.vault.size).toBe(0);
    expect(w.notionWrites).toEqual([]);
  });
});

describe("a transcript whose edit was rejected, and then edited again", () => {
  // N1 (review round 2). `notion_hash` means "the content this row has ACCOUNTED
  // FOR", and a rejected update deliberately advances it to the DECLINED content
  // while the file on disk still holds the previous version — that is what stops
  // pull re-asking. So a hand-edit test that compares the file against
  // `notion_hash` reads every later Notion edit as a hand edit, forever, on a row
  // with no freeze and no `resolve` to heal it.
  //
  // The sequence is ordinary: 👎 one version of a meeting note, then the note gets
  // edited again.
  it("still proposes the NEXT edit — a declined version must not retire the transcript", async () => {
    const w = makeWorld();

    // Created and applied.
    await w.tick();
    w.proposals[0].state = "approved";
    await w.tick();
    await w.tick();
    const fileAfterCreate = w.vault.get(PATH);

    // An edit, proposed and REJECTED.
    w.notion.set(PAGE, EDITED);
    await w.tick();
    expect(w.proposals).toHaveLength(2);
    expect(w.proposals[1].kind).toBe("update");
    w.proposals[1].state = "rejected";
    await w.tick();
    // Nothing was written: the vault keeps the version it had.
    expect(w.vault.get(PATH)).toBe(fileAfterCreate);

    // A SECOND edit in Notion. This has to be a fresh question.
    w.notion.set(PAGE, `${EDITED}\n\nog enda en linje`);
    await w.tick();

    expect(w.proposals).toHaveLength(3);
    expect(w.proposals[2].state).toBe("pending");
    expect(w.proposals[2].kind).toBe("update");
    expect(w.proposals[2].proposedBody).toContain("og enda en linje");
  });

  it("still catches a REAL hand edit after a rejection — the fix must not blind the test", async () => {
    const w = makeWorld();
    await w.tick();
    w.proposals[0].state = "approved";
    await w.tick();
    await w.tick();

    w.notion.set(PAGE, EDITED);
    await w.tick();
    w.proposals[1].state = "rejected";
    await w.tick();

    // Now somebody really does edit the vault copy.
    w.vault.set(PATH, `${w.vault.get(PATH) as string}\nsomeone typed this in Obsidian\n`);
    w.notion.set(PAGE, `${EDITED}\n\nog enda en linje`);
    await w.tick();

    expect(w.proposals).toHaveLength(2);        // nothing new proposed
  });
});

describe("a transcript whose derived path is already tracked by a DOCS row", () => {
  // THE EIGHTH instance of this phase's signature failure — correct for one tick,
  // wrong on the next — and the first found BETWEEN two passes rather than inside
  // one. T6 wrote the same reasoning down for the OTHER create proposer
  // (notion-born-sync.ts, review round 1, Important B) and it was never carried
  // back here.
  //
  // The shape is not hypothetical, it is the live database: Phase 3's sweep put 32
  // docs rows on `*/transcripts/*` paths, T3 deliberately ORPHANS those rows and
  // leaves the files, and the file disappears the moment Bendik acts on the
  // transcript pass's own skip text ("adoption is a decision for a human") by
  // deleting or renaming one. From that tick on, the disk check is quiet and only
  // the ROW knows the path is taken — while apply, which this pass feeds, reads
  // across both targets (`getLinkedRows`) and refuses.
  //
  // Without the guard: propose → 👍 → refused at apply → proposed again, hourly,
  // forever, with one Telegram button message per round.
  function seedLegacyDocsRow(w: ReturnType<typeof makeWorld>): void {
    w.store.set("legacy-doc-1", {
      pageId: "legacy-doc-1", vaultPath: PATH, target: "docs", direction: "md_to_notion",
      // Exactly what T3's `archive-excluded` leaves behind: the Notion page is in the
      // trash, the row is orphaned, the vault_path stays.
      state: "unmatched", mdHash: "legacy-render", notionHash: null, notionLastEdited: null,
    });
  }

  it("is skipped every tick, with a reason — never proposed, approved and refused forever", async () => {
    const w = makeWorld();
    seedLegacyDocsRow(w);

    // Five ticks, and on each one Bendik taps Approve on whatever arrived — which is
    // what turns the bug from a stuck proposal into an endless loop.
    const skips: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const result = await w.tick();
      skips.push(...result.skipped.map((s) => s.reason));
      for (const proposal of w.proposals) {
        if (proposal.state === "pending") proposal.state = "approved";
      }
    }

    // Nothing was ever asked, so nothing was ever refused.
    expect(w.proposals).toEqual([]);
    expect(w.vault.size).toBe(0);
    // The docs row is untouched — this pass does not clean up after Phase 3.
    expect(w.store.get("legacy-doc-1")?.vaultPath).toBe(PATH);
    // …and every tick said why, naming the page holding the path so Bendik can find it.
    expect(skips).toHaveLength(5);
    expect(skips[0]).toContain("legacy-doc-1");
    expect(skips[0]).toContain("docs");
    expect(new Set(skips).size).toBe(1);          // byte-identical, so logs stay readable
    expect(w.notionWrites).toEqual([]);
  });

  it("does NOT refuse a path some other row merely sits NEAR — the guard is not a blanket", async () => {
    const w = makeWorld();
    // A docs row for a different file in the same folder. The guard is keyed by the
    // exact path, so this must change nothing at all.
    w.store.set("legacy-doc-2", {
      pageId: "legacy-doc-2", vaultPath: "alpha/transcripts/2026-08-05-noe-annet.md",
      target: "docs", direction: "md_to_notion", state: "unmatched",
      mdHash: "legacy-render", notionHash: null, notionLastEdited: null,
    });

    const result = await w.tick();
    expect(result.skipped).toEqual([]);
    expect(w.proposals).toHaveLength(1);
    expect(w.proposals[0].vaultPath).toBe(PATH);

    // …and it applies and settles exactly as it does with no legacy row at all.
    w.proposals[0].state = "approved";
    await w.tick();
    await w.tick();
    expect(w.vault.get(PATH)).toContain("<transcript>");
    expect(w.proposals).toHaveLength(1);
  });
});

describe("the desk passes cannot see a transcript at all", () => {
  it("its state row is invisible to a target='docs' read, however long it has been synced", async () => {
    const w = makeWorld();
    await w.tick();
    w.proposals[0].state = "approved";
    await w.tick();

    // The row exists, is synced, and HAS a vault path…
    expect(w.store.get(PAGE)?.vaultPath).toBe(PATH);
    // …and getDeskRows (`target='docs' AND vault_path IS NOT NULL`) still returns
    // nothing. That is the structural half of "one-way, permanently": the push
    // pass, the pull pass, `archive-excluded` and `enable-two-way` all scope their
    // snapshot this way, so none of them can reach this document even if config's
    // own `exclude` carve-out were removed tomorrow.
    expect(deskRowPaths(w.store)).toEqual([]);
  });
});
