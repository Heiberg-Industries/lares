// T6 (Phase 4, ORB-39) — the Notion-born page pull engine, one tick at a time.
//
// This is the pass that can write ANYWHERE in the vault: its target folder comes
// from a free-text `Folder` property Bendik types into Notion, and its filename
// comes from a page title. So the guard tests here are not decoration — they are
// the reason the file is long. Each of the three guards from plan decision 3 is
// driven through T6's OWN path derivation, because T3b proved the MECHANISM and
// this proves the PROPOSER cannot smuggle a bad path into it.
//
// The multi-tick steady state lives in notion-born-seam.test.ts, for the same
// reason T4 split its own: "does the right proposal come out of this world" and
// "does the SECOND tick do nothing" are different questions and read badly
// interleaved.
import { describe, it, expect } from "vitest";
import {
  runNotionBornSync, notionBornFile,
  type NotionBornSyncDeps, type NotionBornSyncOptions, type NotionBornRow,
} from "../lib/notion-born-sync.js";
import { sha256 } from "../lib/wiki-sync.js";
import { makeDeskExclusion, makeCreateScope } from "../lib/desk-scope.js";
import { transcriptBody } from "../lib/transcript-sync.js";
import type {
  DeskRow, PageStateRow, ProposalInput, ProposalRow, ProposalState,
} from "../lib/store.js";
import { readOriginFrontmatter } from "@lares/vault-format/origin";

// Both predicates are built through the REAL derivations rather than hand-written
// stubs — the posture apply-sync.test.ts and transcript-sync.test.ts already take.
// A `() => true` here would hide exactly the refusals these tests exist to prove.
const CONFIG = {
  desks: {
    deskDirs: [
      { dir: "alpha", project: "Alpha", exclude: ["transcripts"] },
      { dir: "beta", project: "Beta" },
      // A real desk dir whose NAME starts with the machine-owned one. The guard
      // matches path segments, never string prefixes, so this must be allowed.
      { dir: "wikipedia", project: "Wikipedia" },
    ],
    twoWayDirs: [],
    mirrorFilePrefixes: [],
  },
  transcripts: { dir: "transcripts", projects: [] },
};

const OPTS: NotionBornSyncOptions = {
  dryRun: false,
  projects: [
    { notionProject: "Alpha", vaultFolder: "alpha" },
    { notionProject: "Beta", vaultFolder: "beta" },
    { notionProject: "Wikipedia", vaultFolder: "wikipedia" },
  ],
  inCreateScope: makeCreateScope(CONFIG),
  isExcluded: makeDeskExclusion(CONFIG.desks),
  transcriptsDir: CONFIG.transcripts.dir,
};
const DRY: NotionBornSyncOptions = { ...OPTS, dryRun: true };

const PAGE = "d1";
const TITLE = "Løpende notater — strategi & tall";
const SLUG = "loepende-notater-strategi-tall";
const PATH = `alpha/${SLUG}.md`;
// What Notion's GET /markdown hands back for a page a human created there: no H1
// at all. The title is the `Name` property and a leading `# H1` is silently
// dropped on both create and patch (live probe, API version 2026-03-11).
const NOTION_MARKDOWN = "## Første avsnitt\n\nnoe innhold her";

function doc(over: Partial<NotionBornRow> = {}): NotionBornRow {
  return {
    pageId: PAGE,
    title: TITLE,
    project: "Alpha",
    folder: "",
    vaultPath: "",
    ...over,
  };
}

interface World {
  docs?: NotionBornRow[];
  rows?: Array<[string, PageStateRow]>;
  deskRows?: Array<[string, DeskRow]>;
  open?: ProposalRow[];
  rejected?: ProposalRow[];
  notion?: Record<string, string>;
  onDisk?: Set<string>;
  /** Files that exist but are NOT case-identical to anything asked for by lstat. */
  alsoOnDisk?: string[];
  readThrows?: Record<string, Error>;
  ensureThrows?: boolean;
}

function makeProposalRow(over: Partial<ProposalRow> = {}): ProposalRow {
  return {
    id: 1,
    vaultPath: PATH,
    notionPageId: PAGE,
    proposedBody: "whatever",
    baseMdHash: "",
    notionHash: "some-hash",
    diffPreview: "",
    kind: "create",
    notionOwned: true,
    state: "pending",
    createdAt: new Date("2026-08-05T10:05:00.000Z"),
    ...over,
  };
}

function makeDeps(world: World) {
  const inserted: ProposalInput[] = [];
  const ensured: string[] = [];
  const states: Array<{ id: number; state: ProposalState }> = [];
  const reads: string[] = [];
  const onDisk = world.onDisk ?? new Set<string>();

  const impl: NotionBornSyncDeps = {
    queryDocs: async () => world.docs ?? [doc()],
    getPageRows: async () => new Map(world.rows ?? []),
    getDeskRows: async () => new Map(world.deskRows ?? []),
    getOpenProposals: async () => world.open ?? [],
    getRejectedUnexecuted: async () => world.rejected ?? [],
    getPageMarkdown: async (pageId) => {
      reads.push(pageId);
      const boom = world.readThrows?.[pageId];
      if (boom !== undefined) throw boom;
      return (world.notion ?? { [PAGE]: NOTION_MARKDOWN })[pageId] ?? "";
    },
    vaultFileExists: async (vaultPath) => onDisk.has(vaultPath),
    // The listing the case/normalisation guard compares against. Modelled as the
    // REAL adapter behaves: a plain list of vault-relative markdown paths, exactly
    // the same set `vaultFileExists` answers for — so the two guards cannot be
    // handed different worlds and quietly agree by accident.
    listVaultFiles: async () => [...onDisk, ...(world.alsoOnDisk ?? [])],
    ensureDocsRow: async (pageId) => {
      if (world.ensureThrows === true) throw new Error("db down");
      ensured.push(pageId);
    },
    insertProposal: async (input) => {
      inserted.push(input);
      return inserted.length;
    },
    setProposalState: async (id, state) => { states.push({ id, state }); },
  };
  return { impl, inserted, ensured, states, reads, onDisk };
}

/** The whole file a create for the default world should carry. */
const EXPECTED_FILE = notionBornFile({ title: TITLE, body: NOTION_MARKDOWN, pageId: PAGE });

describe("runNotionBornSync — selection", () => {
  it("proposes a CREATE at <project folder>/<title-slug>.md for a page with no vault file", async () => {
    const { impl, inserted, ensured } = makeDeps({});
    const result = await runNotionBornSync(OPTS, impl);

    expect(result.proposed).toBe(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].vaultPath).toBe(PATH);
    expect(inserted[0].kind).toBe("create");
    expect(inserted[0].notionPageId).toBe(PAGE);
    // T3b's contract, asserted rather than assumed: a create is proposed against no
    // vault render, and the engine refuses one that carries a base hash.
    expect(inserted[0].baseMdHash).toBe("");
    // …and the state row exists BEFORE the proposal does (T4's enforced contract).
    expect(ensured).toEqual([PAGE]);
  });

  it("ignores a page that already carries a Vault Path — that is adoption's business, not this pass's", async () => {
    // The ONE field that separates this pass from wiki-sync.ts's adoptRemoteRows:
    // adoption requires a NON-EMPTY Vault Path (a page this service created, whose
    // store row was lost); this pass requires an EMPTY one (a page a human made).
    const { impl, inserted, reads } = makeDeps({
      docs: [doc({ vaultPath: "alpha/already-there.md" })],
    });
    const result = await runNotionBornSync(OPTS, impl);

    expect(inserted).toEqual([]);
    expect(reads).toEqual([]);         // not even read: no API call for a page not ours
    expect(result.candidates).toBe(0);
    expect(result.scanned).toBe(1);
  });

  it("ignores a page whose state row already has a vault file", async () => {
    const { impl, inserted, reads } = makeDeps({
      rows: [[PAGE, { pageId: PAGE, target: "docs", vaultPath: "alpha/existing.md", notionHash: "h" }]],
    });
    await runNotionBornSync(OPTS, impl);
    expect(inserted).toEqual([]);
    expect(reads).toEqual([]);
  });

  // Round 1, Minor 1: this used to pass a meetings row WITH a vaultPath, which the
  // test above already covers — it did not discriminate, and `PageStateRow.target`
  // was never read. The shape that matters is a meetings row with a NULL vault_path:
  // what `ensureMeetingRow` leaves behind after a DECLINED transcript.
  it("refuses a page whose state row belongs to another database, and says so", async () => {
    const { impl, inserted } = makeDeps({
      rows: [[PAGE, { pageId: PAGE, target: "meetings", vaultPath: null, notionHash: "declined" }]],
    });
    const result = await runNotionBornSync(OPTS, impl);

    expect(inserted).toEqual([]);
    // Reported, not silent: approving a create here would fill in the vault_path of
    // a MEETINGS row (linkPageToVaultFile conflicts on notion_page_id), taking over
    // the row T4's pass owns.
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toMatch(/meetings database/);
  });
});

describe("runNotionBornSync — path derivation", () => {
  it("maps Project to the desk folder, and slugs a Norwegian title with an em dash sanely", async () => {
    const { impl, inserted } = makeDeps({});
    await runNotionBornSync(OPTS, impl);
    // ø→oe, the em dash and the ampersand become separators, no double hyphens,
    // and every byte is ASCII (the vault is a Linux clone also checked out on APFS).
    expect(inserted[0].vaultPath).toBe("alpha/loepende-notater-strategi-tall.md");
    expect(/^[a-z0-9/.-]+$/.test(inserted[0].vaultPath)).toBe(true);
  });

  it("a filled Folder WINS over the Project mapping", async () => {
    const { impl, inserted } = makeDeps({
      docs: [doc({ project: "Alpha", folder: "beta/notes" })],
    });
    await runNotionBornSync(OPTS, impl);
    expect(inserted[0].vaultPath).toBe(`beta/notes/${SLUG}.md`);
  });

  it("skips and REPORTS a page with no Project and no Folder — never guesses, and never falls back to _inbox", async () => {
    const { impl, inserted } = makeDeps({ docs: [doc({ project: null })] });
    const result = await runNotionBornSync(OPTS, impl);

    expect(inserted).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toMatch(/no Project/i);
    // The one thing decision 3 explicitly forbids.
    expect(result.skipped[0].reason).not.toMatch(/_inbox/);
  });

  it("skips and REPORTS a Project that maps to no desk folder", async () => {
    const { impl, inserted } = makeDeps({ docs: [doc({ project: "Nowhere" })] });
    const result = await runNotionBornSync(OPTS, impl);
    expect(inserted).toEqual([]);
    expect(result.skipped[0].reason).toMatch(/"Nowhere"/);
  });

  it("skips and REPORTS an AMBIGUOUS Project — config permits two desk dirs to share one Project value", async () => {
    const ambiguous: NotionBornSyncOptions = {
      ...OPTS,
      projects: [
        { notionProject: "Alpha", vaultFolder: "alpha" },
        { notionProject: "Alpha", vaultFolder: "beta" },
      ],
    };
    const { impl, inserted } = makeDeps({});
    const result = await runNotionBornSync(ambiguous, impl);
    expect(inserted).toEqual([]);
    expect(result.skipped[0].reason).toMatch(/more than one/i);
  });

  it("skips and REPORTS a title that slugs to nothing", async () => {
    const { impl, inserted } = makeDeps({ docs: [doc({ title: "‽‽‽" })] });
    const result = await runNotionBornSync(OPTS, impl);
    expect(inserted).toEqual([]);
    expect(result.skipped[0].reason).toMatch(/no usable filename/);
  });

  it("caps a very long Norwegian title by BYTES, so the derived path is never refused for length", async () => {
    // 150 characters of `æ` is 300 UTF-8 bytes — past NAME_MAX while `.length`
    // still looks short. The slug must fit the segment budget on its own.
    const { impl, inserted } = makeDeps({ docs: [doc({ title: "æ".repeat(150) })] });
    await runNotionBornSync(OPTS, impl);
    const name = inserted[0].vaultPath.split("/").pop() as string;
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(200);
  });
});

// ── GUARD 1 of 3 — never overwrite ────────────────────────────────────────────
describe("runNotionBornSync — GUARD: never overwrite", () => {
  it("skips and REPORTS a title that slugs onto an existing file, rather than merging into it", async () => {
    const { impl, inserted, reads } = makeDeps({ onDisk: new Set([PATH]) });
    const result = await runNotionBornSync(OPTS, impl);

    expect(inserted).toEqual([]);
    expect(reads).toEqual([]);          // refused before the page is even read
    expect(result.skipped[0].vaultPath).toBe(PATH);
    expect(result.skipped[0].reason).toMatch(/already exists/i);
  });

  it("refuses a SECOND page whose title slugs to the same path in the same tick", async () => {
    const { impl, inserted } = makeDeps({
      docs: [
        doc({ pageId: "d1", title: "Løpende notater — strategi & tall" }),
        // A different string, the same slug: the ø, the punctuation and the casing
        // all normalise away. This is the ordinary way two pages collide.
        doc({ pageId: "d2", title: "løpende NOTATER: strategi / tall" }),
      ],
    });
    const result = await runNotionBornSync(OPTS, impl);

    // Only the first is proposed; the second is named, with the other page id in
    // the reason, because only a human can tell the two pages apart.
    expect(inserted).toHaveLength(1);
    const collided = result.skipped.find((s) => s.pageId === "d2");
    expect(collided?.reason).toMatch(/d1/);
  });

  // ── Round 1, Important A: the filesystem seam ────────────────────────────
  //
  // `vaultFileExists` is an lstat, and an lstat answers for the filesystem it runs
  // on. The box is case-SENSITIVE, Bendik's Mac is not — so a guard that holds on
  // the box can still lose on the machine he actually reads the vault on.
  it("refuses a slug that differs from an existing file ONLY BY CASE", async () => {
    const { impl, inserted, reads } = makeDeps({ alsoOnDisk: ["alpha/Loepende-Notater-Strategi-Tall.md"] });
    const result = await runNotionBornSync(OPTS, impl);

    expect(inserted).toEqual([]);
    expect(reads).toEqual([]);
    expect(result.skipped[0].reason).toMatch(/SAME FILE as that path on macOS/);
    // The refusal NAMES the file it collided with — the whole point is that Bendik
    // cannot see the collision by reading either name on its own.
    expect(result.skipped[0].reason).toContain("alpha/Loepende-Notater-Strategi-Tall.md");
  });

  it("refuses a path that differs from an existing file ONLY BY UNICODE NORMALISATION", async () => {
    // The slug is always transliterated ASCII, so normalisation can only differ in
    // the FOLDER half — which is exactly the untrusted half: `Folder` is free text
    // Bendik types, and a folder name typed on a Mac arrives decomposed while the
    // same name typed on Linux arrives composed. Two directories on ext4, one on
    // APFS, and the two `notater.md` inside them are the collision.
    const composedFolder = "alpha/håndbok";                    // å  (NFC)
    const decomposedOnDisk = "alpha/ha\u030Andbok/notater.md";  // a + combining ring (NFD)
    // Sanity: different JS strings, the same file on APFS.
    expect(decomposedOnDisk).not.toBe(`${composedFolder}/notater.md`);
    expect(decomposedOnDisk.normalize("NFC")).toBe(`${composedFolder}/notater.md`);

    const { impl, inserted } = makeDeps({
      docs: [doc({ title: "Notater", folder: composedFolder })],
      alsoOnDisk: [decomposedOnDisk],
    });
    const result = await runNotionBornSync(OPTS, impl);
    expect(inserted).toEqual([]);
    expect(result.skipped[0].reason).toMatch(/unicode form/);
  });

  it("still proposes when the only nearby file is genuinely a different name", async () => {
    // The guard must not pass by refusing everything: a real neighbour is fine.
    const { impl, inserted } = makeDeps({ alsoOnDisk: ["alpha/loepende-notater-strategi-tall-2.md"] });
    await runNotionBornSync(OPTS, impl);
    expect(inserted).toHaveLength(1);
  });

  // ── Round 1, Important B: a path a STATE ROW still owns ──────────────────
  it("refuses a path a state row still tracks for ANOTHER page, though nothing is on disk", async () => {
    const { impl, inserted, reads } = makeDeps({
      rows: [["old", { pageId: "old", target: "docs", vaultPath: PATH, notionHash: "h" }]],
    });
    const result = await runNotionBornSync(OPTS, impl);

    // Without this the create is proposed, approved, refused by apply's guard 0 —
    // and proposed again on the very next tick, forever, with an EMPTY skip list.
    expect(inserted).toEqual([]);
    expect(reads).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toMatch(/still tracks that path/);
    expect(result.skipped[0].reason).toContain("old");
  });

  it("refuses a page whose path an OPEN proposal for another page has already claimed", async () => {
    const { impl, inserted } = makeDeps({
      open: [makeProposalRow({ id: 7, vaultPath: PATH, notionPageId: "other-page" })],
    });
    const result = await runNotionBornSync(OPTS, impl);
    expect(inserted).toEqual([]);
    expect(result.skipped[0].reason).toMatch(/other-page/);
  });
});

// ── GUARD 2 of 3 — never escape the vault ─────────────────────────────────────
describe("runNotionBornSync — GUARD: never escape the vault", () => {
  // `Folder` is free text in Notion. Every one of these is something Bendik can
  // type, and every one of them is refused BEFORE anything is proposed — so the
  // apply-time guard (which is the actual guarantee) never has to be the only one.
  const escapes = [
    ["..", ".."],
    ["parent walk", "../etc"],
    ["deep parent walk", "alpha/../../etc"],
    ["absolute", "/etc"],
    ["absolute inside", "/alpha/notes"],
    ["dot segment", "alpha/./notes"],
    ["empty segment", "alpha//notes"],
    ["trailing slash", "alpha/notes/"],
    ["padded segment", "alpha /notes"],
    ["newline in the property", "alpha\nnotes"],
  ] as const;

  for (const [name, folder] of escapes) {
    it(`refuses a Folder of ${name} (${JSON.stringify(folder)})`, async () => {
      const { impl, inserted, reads } = makeDeps({ docs: [doc({ folder })] });
      const result = await runNotionBornSync(OPTS, impl);
      expect(inserted).toEqual([]);
      expect(reads).toEqual([]);
      expect(result.skipped).toHaveLength(1);
    });
  }

  it("refuses a Folder outside every configured desk dir, even when its shape is perfectly legal", async () => {
    // The hole `refuseVaultTarget` alone cannot close: `personal/x.md` is a
    // well-formed vault path and still a folder no pass was configured to sync.
    const { impl, inserted } = makeDeps({ docs: [doc({ folder: "personal" })] });
    const result = await runNotionBornSync(OPTS, impl);
    expect(inserted).toEqual([]);
    expect(result.skipped[0].reason).toMatch(/not a folder this sync manages/i);
  });

  it("refuses a Folder that is a desk dir's CARVED-OUT sub-path (another pass owns it)", async () => {
    const { impl, inserted } = makeDeps({ docs: [doc({ folder: "alpha/transcripts" })] });
    const result = await runNotionBornSync(OPTS, impl);
    expect(inserted).toEqual([]);
    expect(result.skipped[0].reason).toMatch(/carved out/i);
  });

  // Round 1, Minor 6: `beta` is a desk dir with NO `exclude` — the config an operator
  // produces by deleting one line. The carve-out refusal above cannot fire (nothing is
  // carved out) and `makeCreateScope` says yes, so without the transcripts-dir half
  // this lands a docs page among T4's transcripts.
  it("refuses a transcripts folder even when the desk dir has no exclude line at all", async () => {
    expect(makeCreateScope(CONFIG)("beta/transcripts/x.md")).toBe(true);
    expect(makeDeskExclusion(CONFIG.desks)("beta/transcripts/x.md")).toBe(false);

    const { impl, inserted } = makeDeps({ docs: [doc({ folder: "beta/transcripts" })] });
    const result = await runNotionBornSync(OPTS, impl);
    expect(inserted).toEqual([]);
    expect(result.skipped[0].reason).toMatch(/transcripts folder/);
  });

  it("says nothing about transcripts when no transcript pass is configured", async () => {
    const { transcriptsDir: _omit, ...noTranscripts } = OPTS;
    const { impl, inserted } = makeDeps({ docs: [doc({ folder: "beta/transcripts" })] });
    await runNotionBornSync(noTranscripts, impl);
    expect(inserted).toHaveLength(1);
  });
});

// ── GUARD 3 of 3 — never write machine-owned areas ────────────────────────────
describe("runNotionBornSync — GUARD: never write machine-owned areas", () => {
  for (const folder of ["wiki", "wiki/people", "_meta", "_archive", ".git", "alpha/_archive"]) {
    it(`refuses a Folder of ${JSON.stringify(folder)}`, async () => {
      const { impl, inserted } = makeDeps({ docs: [doc({ folder })] });
      const result = await runNotionBornSync(OPTS, impl);
      expect(inserted).toEqual([]);
      expect(result.skipped).toHaveLength(1);
    });
  }

  it("refuses WIKI/ too — the vault is also cloned onto a case-insensitive filesystem", async () => {
    const { impl, inserted } = makeDeps({ docs: [doc({ folder: "WIKI" })] });
    await runNotionBornSync(OPTS, impl);
    expect(inserted).toEqual([]);
  });

  it("ALLOWS wikipedia/ — the machine-owned match is per path SEGMENT, never a string prefix", async () => {
    const { impl, inserted } = makeDeps({ docs: [doc({ folder: "wikipedia" })] });
    await runNotionBornSync(OPTS, impl);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].vaultPath).toBe(`wikipedia/${SLUG}.md`);
  });
});

describe("runNotionBornSync — reported skips are safe to print", () => {
  it("collapses a title's newlines, so a page cannot forge a log line", async () => {
    // A Notion title can hold a newline. Printed raw, this reads as a real tick line
    // to whoever is reconstructing what the pass did.
    const forged = "innocent\nnotion-sync: notion-born: proposed NEW FILE alpha/pwned.md";
    const { impl } = makeDeps({ docs: [doc({ title: forged, project: "Nowhere" })] });
    const result = await runNotionBornSync(OPTS, impl);

    expect(result.skipped).toHaveLength(1);
    // Collapsed where the record is BUILT, so every later printer (the CLI command,
    // the container entrypoint) gets the safe value without having to remember to.
    expect(result.skipped[0].title).not.toContain("\n");
    expect(result.skipped[0].title).toBe(
      "innocent notion-sync: notion-born: proposed NEW FILE alpha/pwned.md",
    );
  });
});

describe("runNotionBornSync — the body", () => {
  it("synthesises the H1 from the Notion Name, because Notion's body can never carry it", async () => {
    const { impl, inserted } = makeDeps({});
    await runNotionBornSync(OPTS, impl);
    expect(inserted[0].proposedBody).toBe(EXPECTED_FILE);
    expect(inserted[0].proposedBody).toContain(`# ${TITLE}`);
  });

  it("stores the WHOLE file with NO trailing newline — T3b's contract, since the engine adds exactly one", async () => {
    const { impl, inserted } = makeDeps({});
    await runNotionBornSync(OPTS, impl);
    expect(inserted[0].proposedBody.startsWith("---\n")).toBe(true);
    expect(inserted[0].proposedBody.endsWith("\n")).toBe(false);
  });

  it("hashes what PULL will hash — the raw Notion markdown — so the row converges instead of churning", async () => {
    // The single most load-bearing line in this engine. pull-sync's change test is
    // `sha256(getPageMarkdown(...))`; a hash over the composed file would differ
    // from it forever and pull would propose a phantom edit the tick after every
    // create.
    const { impl, inserted } = makeDeps({});
    await runNotionBornSync(OPTS, impl);
    expect(inserted[0].notionHash).toBe(sha256(NOTION_MARKDOWN));
    expect(inserted[0].notionHash).not.toBe(sha256(inserted[0].proposedBody));
  });

  it("gives every proposal a real diff preview — it is the only thing Bendik sees before tapping", async () => {
    const { impl, inserted } = makeDeps({});
    await runNotionBornSync(OPTS, impl);
    const preview = inserted[0].diffPreview as string;
    expect(preview.length).toBeGreaterThan(0);
    expect(preview.startsWith("+ ")).toBe(true);
    expect(preview).not.toMatch(/^- /m);      // a create has no "before" side
  });

  it("translates Notion's flavour into Obsidian's, the same way pull does", async () => {
    const { impl, inserted } = makeDeps({
      notion: { [PAGE]: '<callout icon="💡" color="blue">\nen oppsummering\n</callout>' },
    });
    await runNotionBornSync(OPTS, impl);
    expect(inserted[0].proposedBody).toContain("> [!summary]");
  });

  it("refuses a body that cannot round-trip — an expiring Notion media URL is skipped and reported", async () => {
    const { impl, inserted } = makeDeps({
      notion: { [PAGE]: "![x](https://prod-files-secure.s3.us-west-2.amazonaws.com/a?X-Amz-Signature=b)" },
    });
    const result = await runNotionBornSync(OPTS, impl);
    expect(inserted).toEqual([]);
    expect(result.skipped[0].reason).toMatch(/expiring URL|round trip|cannot be brought/i);
  });

  it("resolves a Notion mention into a wikilink using the desk rows, exactly as pull's resolver does", async () => {
    const { impl, inserted } = makeDeps({
      deskRows: [["beta/target.md", {
        pageId: "00000000-0000-0000-0000-0000000000aa", mdHash: "m", notionHash: "n",
        notionLastEdited: null, state: "synced", direction: "two_way",
      }]],
      notion: {
        [PAGE]: 'see <mention-page url="https://www.notion.so/00000000-0000-0000-0000-0000000000aa">Target</mention-page> here',
      },
    });
    await runNotionBornSync(OPTS, impl);
    expect(inserted[0].proposedBody).toContain("[[target]]");
  });
});

describe("runNotionBornSync — never stack, never re-ask", () => {
  it("leaves an open proposal that already carries exactly this file alone", async () => {
    const { impl, inserted, states } = makeDeps({
      open: [makeProposalRow({
        vaultPath: PATH, notionHash: sha256(NOTION_MARKDOWN), proposedBody: EXPECTED_FILE,
      })],
    });
    const result = await runNotionBornSync(OPTS, impl);

    expect(inserted).toEqual([]);
    expect(states).toEqual([]);              // no supersede, no duplicate
    expect(result.awaitingApproval).toBe(1);
  });

  it("supersedes and re-proposes when the page was RETITLED while the proposal waited", async () => {
    // Notion's markdown is byte-identical after a retitle (the title is a property),
    // so the notion hash alone cannot see this. Comparing the composed FILE can.
    const { impl, inserted, states } = makeDeps({
      docs: [doc({ title: "Et helt nytt navn" })],
      open: [makeProposalRow({
        id: 9, vaultPath: PATH, notionHash: sha256(NOTION_MARKDOWN), proposedBody: EXPECTED_FILE,
      })],
    });
    await runNotionBornSync(OPTS, impl);

    expect(states).toEqual([{ id: 9, state: "superseded" }]);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].proposedBody).toContain("# Et helt nytt navn");
  });

  it("says nothing at all about content a human has just REJECTED, before apply has recorded the decline", async () => {
    const { impl, inserted } = makeDeps({
      rejected: [makeProposalRow({
        state: "rejected", notionHash: sha256(NOTION_MARKDOWN), proposedBody: EXPECTED_FILE,
      })],
    });
    const result = await runNotionBornSync(OPTS, impl);

    expect(inserted).toEqual([]);
    expect(result.awaitingDecline).toBe(1);
  });

  it("says nothing about content the state row has ACCOUNTED FOR — the decline, remembered", async () => {
    // T4's policy, reused rather than reinvented: reject means "not this content",
    // never "never this document". The declined hash lives on the state row.
    const { impl, inserted } = makeDeps({
      rows: [[PAGE, {
        pageId: PAGE, target: "docs", vaultPath: null, notionHash: sha256(NOTION_MARKDOWN),
      }]],
    });
    const result = await runNotionBornSync(OPTS, impl);

    expect(inserted).toEqual([]);
    expect(result.accounted).toBe(1);
  });

  it("…and a LATER edit to that same page is a fresh question", async () => {
    const { impl, inserted } = makeDeps({
      rows: [[PAGE, { pageId: PAGE, target: "docs", vaultPath: null, notionHash: sha256("older") }]],
    });
    await runNotionBornSync(OPTS, impl);
    expect(inserted).toHaveLength(1);
  });
});

describe("runNotionBornSync — containment", () => {
  it("does not propose at all when the state row cannot be created", async () => {
    // T4's enforced contract: `recordNotionAccounted` THROWS on a zero-row match,
    // so a proposal raised against a page with no row would leave a decision with
    // nowhere to live. Not proposing costs one tick; proposing costs a loop.
    const { impl, inserted } = makeDeps({ ensureThrows: true });
    const result = await runNotionBornSync(OPTS, impl);

    expect(inserted).toEqual([]);
    expect(result.bookkeepingFailed).toBe(1);
    expect(result.proposed).toBe(0);
  });

  it("contains a failed page read per page and keeps going", async () => {
    const { impl, inserted } = makeDeps({
      docs: [doc({ pageId: "d1" }), doc({ pageId: "d2", title: "Andre siden" })],
      readThrows: { d1: new Error("notion 500") },
      notion: { d2: NOTION_MARKDOWN },
    });
    const result = await runNotionBornSync(OPTS, impl);

    expect(result.errored).toBe(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].notionPageId).toBe("d2");
  });

  it("does not count a proposal whose insert failed", async () => {
    const { impl } = makeDeps({});
    const result = await runNotionBornSync(OPTS, {
      ...impl,
      insertProposal: async () => { throw new Error("unique violation"); },
    });
    // `proposed` names a thing that exists. A failed insert is `bookkeepingFailed`,
    // which is what makes the tick visibly unclean.
    expect(result.proposed).toBe(0);
    expect(result.bookkeepingFailed).toBe(1);
  });

  it("dry-run produces the full plan and writes nothing at all", async () => {
    const { impl, inserted, ensured, states } = makeDeps({});
    const result = await runNotionBornSync(DRY, impl);

    expect(result.proposed).toBe(1);
    expect(inserted).toEqual([]);
    expect(ensured).toEqual([]);
    expect(states).toEqual([]);
    expect(result.summary).toMatch(/dry-run/);
  });

  it("dry-run reports the SAME skips a live run would", async () => {
    const world: World = {
      docs: [
        doc({ pageId: "d1", title: "Samme navn" }),
        doc({ pageId: "d2", title: "samme navn" }),
      ],
    };
    const live = await runNotionBornSync(OPTS, makeDeps(world).impl);
    const dry = await runNotionBornSync(DRY, makeDeps(world).impl);
    expect(dry.skipped.map((s) => s.reason)).toEqual(live.skipped.map((s) => s.reason));
  });
});

describe("notionBornFile — the whole file a create carries", () => {
  it("carries the title in the frontmatter AND as the H1, and the page id to get back", () => {
    const file = notionBornFile({ title: "Q3 planer", body: "innhold", pageId: "p-1" });
    expect(file).toBe(
      "---\ntitle: Q3 planer\nsource: notion-docs\nlares_origin: synced\nnotion_page: p-1\n---\n\n" +
      "# Q3 planer\n\ninnhold",
    );
  });

  it("stamps a Notion-born file as synced", () => {
    const out = notionBornFile({ title: "A page", body: "text", pageId: "p1" });
    expect(out).toContain("\nlares_origin: synced\n");
  });

  it("keeps the existing source key — lares_origin is an additional field, not a replacement", () => {
    const out = notionBornFile({ title: "A page", body: "text", pageId: "p1" });
    expect(out).toContain("\nsource: notion-docs\n");
  });

  it("the stamp is readable by the kit's own reader", () => {
    expect(readOriginFrontmatter(notionBornFile({ title: "A page", body: "text", pageId: "p1" }))).toBe("synced");
  });

  it("quotes a title YAML would otherwise read as something else", () => {
    const file = notionBornFile({ title: "Q3: planer # 2", body: "x", pageId: "p" });
    expect(file).toContain('title: "Q3: planer # 2"');
  });

  it("collapses a multi-line title — a two-line H1 is two blocks, only one of them a heading", () => {
    const file = notionBornFile({ title: "to\nlinjer", body: "x", pageId: "p" });
    expect(file).toContain("# to linjer");
  });

  it("composes its body through the SAME helper the transcript pass uses", () => {
    expect(notionBornFile({ title: "T", body: "b", pageId: "p" }))
      .toContain(transcriptBody("T", "b"));
  });
});
