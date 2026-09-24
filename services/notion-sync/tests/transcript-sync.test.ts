// T4 (Phase 4, ORB-39) — the transcript pull engine, one tick at a time.
//
// The multi-tick steady state lives in its own file (transcript-seam.test.ts),
// because the two things a reader needs from this one — "does the right proposal
// come out of this world?" — and the thing that has bitten this phase twice —
// "does the SECOND tick do nothing?" — are different questions and read badly
// interleaved.
import { describe, it, expect } from "vitest";
import {
  runTranscriptSync, transcriptSlug, transcriptDate, transcriptBody, transcriptFile,
  type TranscriptSyncDeps, type TranscriptSyncOptions, type TranscriptMeetingRow,
} from "../lib/transcript-sync.js";
import { docRenderHash, vaultBodyHash, type RenderedDoc } from "../lib/pull-sync.js";
import { sha256 } from "../lib/wiki-sync.js";
import { assertPushSafe } from "../lib/translate.js";
import { makeDeskExclusion } from "../lib/desk-scope.js";
import type {
  DocTarget, LinkedRow, MeetingStateRow, ProposalInput, ProposalRow, ProposalState,
} from "../lib/store.js";
import { readOriginFrontmatter } from "@lares/vault-format/origin";

// Built through the REAL derivation rather than a hand-written `() => true`, the
// same posture apply-sync.test.ts takes for `inCreateScope`: a stub here would hide
// the misconfiguration this predicate exists to refuse.
const EXCLUDED = makeDeskExclusion({
  deskDirs: [
    { dir: "alpha", project: "Alpha", exclude: ["transcripts"] },
    { dir: "beta", project: "Beta", exclude: ["transcripts"] },
    { dir: "unexcluded", project: "Gamma" },
  ],
  twoWayDirs: [],
  mirrorFilePrefixes: [],
});
const OPTS: TranscriptSyncOptions = {
  dryRun: false,
  dir: "transcripts",
  projects: [
    { notionProject: "Alpha", vaultFolder: "alpha" },
    { notionProject: "Beta", vaultFolder: "beta" },
  ],
  isExcluded: EXCLUDED,
};
const DRY: TranscriptSyncOptions = { ...OPTS, dryRun: true };
// LAR-30 follow-up: the unmapped-transcript ping only names a page individually
// when it is still within UNMAPPED_PAGE_WARNING_DAYS of `now`. TITLE's default
// meeting starts 2026-08-05T09:00+02:00 — RECENT sits 5 days after that (inside the
// 14-day window), OLD 20 days after (outside it).
const RECENT: TranscriptSyncOptions = { ...OPTS, now: new Date("2026-08-10T00:00:00.000Z") };
const OLD: TranscriptSyncOptions = { ...OPTS, now: new Date("2026-08-25T00:00:00.000Z") };

const PAGE = "m1";
const TITLE = "Ukesmøte — strategi & tall";
const PATH = "alpha/transcripts/2026-08-05-ukesmoete-strategi-tall.md";
// What Notion's GET /markdown hands back for a meeting note: no H1 (the title is
// the `Name` property and is dropped from the body — live-probed at 2026-03-11),
// and a live <transcript> block that no push may ever carry.
const NOTION_MARKDOWN = [
  "## Beslutninger",
  "- [x] valgte alternativ to",
  "",
  "<transcript>",
  "Bendik: hvor landet vi",
  "Kari: på alternativ to",
  "</transcript>",
].join("\n");

function meeting(over: Partial<TranscriptMeetingRow> = {}): TranscriptMeetingRow {
  return {
    pageId: PAGE,
    title: TITLE,
    project: "Alpha",
    startsAt: "2026-08-05T09:00:00.000+02:00",
    ...over,
  };
}

interface World {
  meetings?: TranscriptMeetingRow[];
  rows?: Array<[string, MeetingStateRow]>;
  open?: ProposalRow[];
  rejected?: ProposalRow[];
  notion?: Record<string, string>;
  onDisk?: Set<string>;
  /** `getLinkedRows`: every row that already owns a vault path, across BOTH targets. */
  linked?: Array<[string, LinkedRow]>;
  vault?: Record<string, string>;
  rendered?: Record<string, RenderedDoc>;
  readThrows?: Record<string, Error>;
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

/**
 * One `getLinkedRows` row. Only `pageId`, `target` and `state` are ever read by the
 * transcript pass — it asks this map one question ("who owns this path?") — so the
 * rest is filled with values that would be wrong to act on, which is the point.
 */
function linkedRow(over: Partial<LinkedRow> & { pageId: string }): LinkedRow {
  return {
    target: "docs" as DocTarget,
    mdHash: "legacy-render", notionHash: null, notionLastEdited: null,
    state: "unmatched", direction: "md_to_notion",
    ...over,
  };
}

function makeDeps(world: World) {
  const inserted: ProposalInput[] = [];
  const ensured: string[] = [];
  const accounted: Array<{ pageId: string; notionHash: string }> = [];
  const states: Array<{ id: number; state: ProposalState }> = [];
  const notified: string[] = [];
  const reads: string[] = [];
  const onDisk = world.onDisk ?? new Set<string>();

  const impl: TranscriptSyncDeps = {
    queryMeetings: async () => world.meetings ?? [meeting()],
    getMeetingRows: async () => new Map(world.rows ?? []),
    getOpenProposals: async () => world.open ?? [],
    getRejectedUnexecuted: async () => world.rejected ?? [],
    getPageMarkdown: async (pageId) => {
      reads.push(pageId);
      const err = world.readThrows?.[pageId];
      if (err !== undefined) throw err;
      const markdown = (world.notion ?? { [PAGE]: NOTION_MARKDOWN })[pageId];
      if (markdown === undefined) throw new Error(`no such page ${pageId}`);
      return markdown;
    },
    renderDoc: async (vaultPath) => {
      const doc = world.rendered?.[vaultPath];
      if (doc === undefined) throw new Error(`ENOENT: ${vaultPath}`);
      return doc;
    },
    readVaultFile: async (vaultPath) => {
      const source = world.vault?.[vaultPath];
      if (source === undefined) throw new Error(`ENOENT: ${vaultPath}`);
      return source;
    },
    vaultFileExists: async (vaultPath) => onDisk.has(vaultPath),
    getLinkedRows: async () => new Map(world.linked ?? []),
    ensureMeetingRow: async (pageId) => { ensured.push(pageId); },
    insertProposal: async (input) => { inserted.push(input); return inserted.length; },
    setProposalState: async (id, state) => { states.push({ id, state }); },
    recordNotionAccounted: async (pageId, notionHash) => { accounted.push({ pageId, notionHash }); },
    notify: async (message) => { notified.push(message); },
  };

  return { impl, inserted, ensured, accounted, states, notified, reads, onDisk };
}

// ---------------------------------------------------------------------------
// Path derivation — the part decision 1 fixes forever
// ---------------------------------------------------------------------------

describe("transcriptSlug", () => {
  it("transliterates Norwegian letters rather than dropping them", () => {
    expect(transcriptSlug("Møte på Åsen med Ærlig")).toBe("moete-paa-aasen-med-aerlig");
  });

  it("collapses spaces, ampersands, em dashes and quotes into single hyphens", () => {
    expect(transcriptSlug('Q3 "review" — tall & tempo')).toBe("q3-review-tall-tempo");
  });

  it("strips accents from other Latin letters instead of losing the word", () => {
    expect(transcriptSlug("Café résumé")).toBe("cafe-resume");
  });

  it("returns an empty slug when a title carries nothing usable — never a bare date", () => {
    expect(transcriptSlug("###")).toBe("");
    expect(transcriptSlug("   ")).toBe("");
  });

  it("caps a very long Norwegian title by BYTES, and never ends on a hyphen", () => {
    // 150 characters of "å" transliterate to 300 characters — and, before the
    // transliteration, 300 BYTES. Either way the cap has to bite.
    const slug = transcriptSlug("å".repeat(150));
    expect(new TextEncoder().encode(slug).length).toBeLessThanOrEqual(180);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("transcriptDate", () => {
  it("takes the LOCAL date of a zoned start time, not the UTC one", () => {
    // 2026-08-05 23:30 in Oslo is 21:30 UTC on the same day, but 2026-08-06
    // 00:30+02:00 is the 6th locally and the 5th in UTC. The date a human means
    // is the one written in the offset the meeting was scheduled in.
    expect(transcriptDate("2026-08-06T00:30:00.000+02:00")).toBe("2026-08-06");
  });

  it("accepts a date-only Notion Date property", () => {
    expect(transcriptDate("2026-08-05")).toBe("2026-08-05");
  });

  it("returns null for a missing or malformed date rather than guessing one", () => {
    expect(transcriptDate(null)).toBeNull();
    expect(transcriptDate("")).toBeNull();
    expect(transcriptDate("last tuesday")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The file the proposal carries
// ---------------------------------------------------------------------------

describe("the composed file", () => {
  it("puts the title in the BODY as an H1, because Notion drops it from the markdown", () => {
    expect(transcriptBody("Ukesmøte", "text")).toBe("# Ukesmøte\n\ntext");
  });

  it("keeps the <transcript> block byte-intact — no translation, no round trip", () => {
    const body = transcriptBody(TITLE, NOTION_MARKDOWN);
    expect(body).toContain("<transcript>\nBendik: hvor landet vi\nKari: på alternativ to\n</transcript>");
  });

  it("carries no trailing newline — the apply engine adds exactly one (T3b contract)", () => {
    const file = transcriptFile({
      title: TITLE, markdown: NOTION_MARKDOWN, date: "2026-08-05", project: "Alpha", pageId: PAGE,
    });
    expect(file.endsWith("\n")).toBe(false);
  });

  it("writes frontmatter that a retitle can never contradict — no title key in it", () => {
    const file = transcriptFile({
      title: TITLE, markdown: "body", date: "2026-08-05", project: "Alpha", pageId: PAGE,
    });
    expect(file.startsWith("---\n")).toBe(true);
    expect(file).toContain("date: 2026-08-05");
    expect(file).toContain("project: Alpha");
    expect(file).toContain(`notion_page: ${PAGE}`);
    expect(file).not.toMatch(/^title:/m);
    // The title lives where Notion can update it: inside the document.
    expect(file).toContain(`# ${TITLE}`);
  });

  it("stamps a transcript file as synced", () => {
    const file = transcriptFile({
      title: TITLE, markdown: "body", date: "2026-08-05", project: "Alpha", pageId: PAGE,
    });
    expect(file).toContain("\nlares_origin: synced\n");
  });

  it("keeps the existing source key — lares_origin is an additional field, not a replacement", () => {
    const file = transcriptFile({
      title: TITLE, markdown: "body", date: "2026-08-05", project: "Alpha", pageId: PAGE,
    });
    expect(file).toContain("\nsource: notion-meetings\n");
  });

  it("the stamp is readable by the kit's own reader", () => {
    const file = transcriptFile({
      title: TITLE, markdown: "body", date: "2026-08-05", project: "Alpha", pageId: PAGE,
    });
    expect(readOriginFrontmatter(file)).toBe("synced");
  });

  it("quotes a project name that would break the YAML", () => {
    const file = transcriptFile({
      title: "T", markdown: "b", date: "2026-08-05", project: "Vol: de Nuit", pageId: PAGE,
    });
    expect(file).toContain('project: "Vol: de Nuit"');
  });
});

// ---------------------------------------------------------------------------
// The one-way rail
// ---------------------------------------------------------------------------

describe("a transcript can never reach a push path", () => {
  it("its body is refused by assertPushSafe — enforced by code, not by the absence of a caller", () => {
    const body = transcriptBody(TITLE, NOTION_MARKDOWN);
    expect(() => assertPushSafe(body)).toThrow(/transcript/);
  });
});

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

describe("runTranscriptSync — first sync", () => {
  it("proposes a CREATE at the derived path, with the whole file and a real preview", async () => {
    const d = makeDeps({});
    const result = await runTranscriptSync(OPTS, d.impl);

    expect(result.proposed).toBe(1);
    expect(d.inserted).toHaveLength(1);
    const [proposal] = d.inserted;
    expect(proposal.vaultPath).toBe(PATH);
    expect(proposal.notionPageId).toBe(PAGE);
    expect(proposal.kind).toBe("create");
    // T3b's contract, asserted rather than assumed.
    expect(proposal.baseMdHash).toBe("");
    expect(proposal.proposedBody.endsWith("\n")).toBe(false);
    expect(proposal.proposedBody).toContain("<transcript>");
    expect(proposal.proposedBody).toContain(`# ${TITLE}`);
    // The only thing Bendik sees before tapping.
    expect(proposal.diffPreview).toMatch(/^\+ /m);
    expect(proposal.diffPreview).not.toBe("");
  });

  it("hashes the TITLE with the body, so a retitle is a change even though the markdown is not", async () => {
    const d = makeDeps({});
    await runTranscriptSync(OPTS, d.impl);
    expect(d.inserted[0].notionHash).toBe(sha256(transcriptBody(TITLE, NOTION_MARKDOWN)));
    // …and not the hash of what Notion returned, which omits the title entirely.
    expect(d.inserted[0].notionHash).not.toBe(sha256(NOTION_MARKDOWN));
  });

  it("ensures the Meetings state row exists BEFORE proposing — a decline needs somewhere to live", async () => {
    const d = makeDeps({});
    await runTranscriptSync(OPTS, d.impl);
    expect(d.ensured).toEqual([PAGE]);
  });

  it("skips and reports a meeting whose Project is not mapped — never guesses a folder", async () => {
    const d = makeDeps({ meetings: [meeting({ project: "Gamma" })] });
    const result = await runTranscriptSync(OPTS, d.impl);
    expect(result.proposed).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toMatch(/Project/i);
    expect(result.skipped[0].reason).toContain("Gamma");
    // Skipped BEFORE the read: an unmappable row must not cost an API call a tick.
    expect(d.reads).toEqual([]);
  });

  it("skips and reports a meeting with no Project at all", async () => {
    const d = makeDeps({ meetings: [meeting({ project: null })] });
    const result = await runTranscriptSync(OPTS, d.impl);
    expect(result.skipped[0].reason).toMatch(/Project/i);
  });

  // ORB-155, decision 3; reshaped per LAR-30. Notion's meeting-notes feature files a
  // new note under Project "Other"; nothing in transcripts.projects maps it, so the
  // transcript is correctly skipped — and correctly skipping it silently is how the
  // Folkepuls meetings never reached the Brain for two weeks. A skip that means "this
  // meeting's notes are going nowhere" is a config gap, and config gaps are fixed by a
  // human who has been told WHICH meeting, not just which Project.
  describe("the unmapped-project alert (ORB-155, LAR-30)", () => {
    it("pings once per page, naming the page's own title, not just its Project — for a meeting within the warning window", async () => {
      const d = makeDeps({
        meetings: [
          meeting({ pageId: "m1", title: "Folkepuls sync", project: "Gamma" }),
          meeting({ pageId: "m2", title: "Retro", project: "Other" }),
        ],
      });
      await runTranscriptSync(RECENT, d.impl);

      expect(d.notified).toHaveLength(2);
      expect(d.notified.some((m) => m.includes("m1") && m.includes("Folkepuls sync") && m.includes("Gamma"))).toBe(true);
      expect(d.notified.some((m) => m.includes("m2") && m.includes("Retro") && m.includes("Other"))).toBe(true);
      // The fix, not just the reason — an owner reading this in Slack needs to know
      // what to DO, not only what is wrong.
      expect(d.notified[0]).toMatch(/Fix:/);
    });

    it("says nothing when every project is mapped", async () => {
      const d = makeDeps({ meetings: [meeting()] });
      await runTranscriptSync(RECENT, d.impl);
      expect(d.notified).toEqual([]);
    });

    it("names a row with no Project at all, and tells Bendik to set one — for a meeting within the warning window", async () => {
      const d = makeDeps({ meetings: [meeting({ project: null })] });
      await runTranscriptSync(RECENT, d.impl);
      expect(d.notified).toHaveLength(1);
      expect(d.notified[0]).toContain(TITLE);
      expect(d.notified[0]).toMatch(/no Project/i);
      expect(d.notified[0]).toMatch(/set Project on the Meetings row/i);
    });

    it("stays silent in dry-run", async () => {
      const d = makeDeps({ meetings: [meeting({ project: "Gamma" })] });
      await runTranscriptSync({ ...DRY, now: RECENT.now }, d.impl);
      expect(d.notified).toEqual([]);
    });

    it("ignores a project a row no longer needs — one that already owns its vault path", async () => {
      // The mapping is only consulted on FIRST sync. A row whose path is already
      // stored is not evidence of anything being unmapped.
      const d = makeDeps({
        meetings: [meeting({ project: "Gamma" })],
        rows: [[PAGE, { pageId: PAGE, vaultPath: PATH } as MeetingStateRow]],
        notion: { [PAGE]: NOTION_MARKDOWN },
        vault: { [PATH]: `---\nnotion_page: ${PAGE}\n---\n\n${transcriptBody(TITLE, NOTION_MARKDOWN)}\n` },
      });
      await runTranscriptSync(RECENT, d.impl);
      expect(d.notified).toEqual([]);
    });

    it("emits the byte-identical per-page message across ticks while the row stays unmapped — the spine's fingerprint dedupe is what makes this one signal, not a new one every hour", async () => {
      const d1 = makeDeps({ meetings: [meeting({ project: "Gamma" })] });
      await runTranscriptSync(RECENT, d1.impl);
      const d2 = makeDeps({ meetings: [meeting({ project: "Gamma" })] });
      await runTranscriptSync(RECENT, d2.impl);

      expect(d1.notified).toHaveLength(1);
      expect(d2.notified).toHaveLength(1);
      expect(d2.notified[0]).toBe(d1.notified[0]);
    });

    // LAR-30 follow-up: queryMeetings returns every Meetings row ever synced, with no
    // age window of its own, so a page unmapped since before this alert existed must
    // NOT get its own thread on every tick forever — see UNMAPPED_PAGE_WARNING_DAYS.
    describe("the 14-day warning window", () => {
      it("fires the per-page ping, and no aggregate, for a meeting still within the window", async () => {
        const d = makeDeps({ meetings: [meeting({ project: "Gamma" })] });
        await runTranscriptSync(RECENT, d.impl);

        expect(d.notified).toHaveLength(1);
        expect(d.notified[0]).toContain(TITLE);
        expect(d.notified[0]).toContain(PAGE);
        expect(d.notified[0]).not.toMatch(/are being skipped because their Notion Project/);
      });

      it("falls back to the old aggregate line, naming only the Project, for a meeting older than the window", async () => {
        const d = makeDeps({ meetings: [meeting({ project: "Gamma" })] });
        await runTranscriptSync(OLD, d.impl);

        expect(d.notified).toHaveLength(1);
        expect(d.notified[0]).toMatch(/are being skipped because their Notion Project is not mapped/);
        expect(d.notified[0]).toContain("Gamma");
        expect(d.notified[0]).not.toContain(TITLE);
        expect(d.notified[0]).not.toContain(PAGE);
      });

      it("a mix of ages produces BOTH — a per-page ping for the recent row and an aggregate line for the old one", async () => {
        const d = makeDeps({
          meetings: [
            meeting({
              pageId: "m-recent", title: "Recent one", project: "Gamma",
              startsAt: "2026-08-10T09:00:00.000+02:00",
            }),
            meeting({
              pageId: "m-old", title: "Old one", project: "Delta",
              startsAt: "2026-07-01T09:00:00.000+02:00",
            }),
          ],
        });
        await runTranscriptSync({ ...OPTS, now: new Date("2026-08-12T00:00:00.000Z") }, d.impl);

        expect(d.notified).toHaveLength(2);
        expect(d.notified.some((m) => m.includes("m-recent") && m.includes("Recent one") && m.includes("Gamma"))).toBe(true);
        expect(d.notified.some((m) =>
          m.includes("are being skipped because their Notion Project is not mapped") && m.includes("Delta"),
        )).toBe(true);
        expect(d.notified.some((m) => m.includes("m-old") || m.includes("Old one"))).toBe(false);
      });

      it("treats a row with no usable date as recent rather than dropping it silently", async () => {
        const d = makeDeps({ meetings: [meeting({ project: "Gamma", startsAt: null })] });
        await runTranscriptSync(OLD, d.impl);

        expect(d.notified).toHaveLength(1);
        expect(d.notified[0]).toContain(TITLE);
        expect(d.notified[0]).not.toMatch(/are being skipped because their Notion Project/);
      });
    });
  });

  it("skips and reports a meeting with no Date — the path cannot be invented", async () => {
    const d = makeDeps({ meetings: [meeting({ startsAt: null })] });
    const result = await runTranscriptSync(OPTS, d.impl);
    expect(result.proposed).toBe(0);
    expect(result.skipped[0].reason).toMatch(/Date/i);
    expect(d.reads).toEqual([]);
  });

  it("skips and reports a title that produces no usable filename", async () => {
    const d = makeDeps({ meetings: [meeting({ title: "###" })] });
    const result = await runTranscriptSync(OPTS, d.impl);
    expect(result.skipped[0].reason).toMatch(/title/i);
  });

  it("caps a long Norwegian title instead of throwing ENAMETOOLONG at the write", async () => {
    const d = makeDeps({ meetings: [meeting({ title: "æ".repeat(200) })] });
    const result = await runTranscriptSync(OPTS, d.impl);
    expect(result.skipped).toEqual([]);
    expect(result.proposed).toBe(1);
    const segment = d.inserted[0].vaultPath.split("/").pop() as string;
    expect(new TextEncoder().encode(segment).length).toBeLessThanOrEqual(200);
  });

  it("does not propose into a path already occupied — adoption is a human's call (decision 2)", async () => {
    const d = makeDeps({ onDisk: new Set([PATH]) });
    const result = await runTranscriptSync(OPTS, d.impl);
    expect(result.proposed).toBe(0);
    expect(d.inserted).toEqual([]);
    expect(result.skipped[0].reason).toMatch(/already exists/i);
    expect(d.reads).toEqual([]);
  });

  // The eighth instance of this phase's signature failure, and the first found
  // BETWEEN two passes: apply's guard 0 reads `getLinkedRows` (both targets) and
  // refuses a create whose path any row already owns, so a proposer that reads only
  // `getMeetingRows` raises a proposal that can never land — proposed, approved,
  // refused, proposed again, hourly, forever. The multi-tick proof is in
  // transcript-seam.test.ts; this is the same refusal at one tick's resolution.
  it("does not propose into a path a DOCS row already owns, even with nothing on disk", async () => {
    const d = makeDeps({ linked: [[PATH, linkedRow({ pageId: "legacy-doc-1" })]] });
    const result = await runTranscriptSync(OPTS, d.impl);
    expect(result.proposed).toBe(0);
    expect(d.inserted).toEqual([]);
    // Names the page holding the path — the only thing that makes this actionable.
    expect(result.skipped[0].reason).toContain("legacy-doc-1");
    expect(result.skipped[0].vaultPath).toBe(PATH);
    // Asked before the read, like every other pre-read skip in this pass.
    expect(d.reads).toEqual([]);
  });

  it("still proposes when the only linked rows are OTHER paths — the guard is keyed exactly", async () => {
    const d = makeDeps({
      linked: [["alpha/transcripts/2026-08-05-noe-annet.md", linkedRow({ pageId: "legacy-doc-2" })]],
    });
    const result = await runTranscriptSync(OPTS, d.impl);
    expect(result.skipped).toEqual([]);
    expect(result.proposed).toBe(1);
    expect(d.inserted[0].vaultPath).toBe(PATH);
  });

  it("refuses a folder the desk passes were never told to leave alone", async () => {
    // The destructive misconfiguration: the desk push's walker would LIST these
    // files, adopt them, create a second Notion page for each, and — because
    // upsertDocSynced conflicts on vault_path, which is UNIQUE across targets —
    // repoint the Meetings row at the page it had just invented.
    const d = makeDeps({ meetings: [meeting({ project: "Gamma" })] });
    const result = await runTranscriptSync({
      ...OPTS,
      projects: [{ notionProject: "Gamma", vaultFolder: "unexcluded" }],
    }, d.impl);
    expect(result.proposed).toBe(0);
    expect(result.skipped[0].reason).toMatch(/carved out of the desk scope/);
    expect(d.reads).toEqual([]);
  });

  it("refuses a folder that is no desk dir at all — apply would only refuse it later", async () => {
    const d = makeDeps({ meetings: [meeting({ project: "Gamma" })] });
    const result = await runTranscriptSync({
      ...OPTS,
      projects: [{ notionProject: "Gamma", vaultFolder: "nowhere" }],
    }, d.impl);
    expect(result.proposed).toBe(0);
    expect(result.skipped[0].reason).toMatch(/carved out of the desk scope/);
  });

  it("refuses a second meeting that slugs to a path another one has already claimed", async () => {
    // `notion_sync_proposals_open` is UNIQUE on vault_path across pending+approved,
    // so this is not a duplicate — it is a constraint violation that would throw on
    // every tick forever. Two "Standup" meetings on one day is all it takes.
    const d = makeDeps({
      meetings: [meeting({ pageId: "m-a" }), meeting({ pageId: "m-b" })],
      notion: { "m-a": NOTION_MARKDOWN, "m-b": NOTION_MARKDOWN },
    });
    const result = await runTranscriptSync(OPTS, d.impl);

    expect(result.proposed).toBe(1);
    expect(d.inserted).toHaveLength(1);
    expect(result.bookkeepingFailed).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toMatch(/already has an open proposal/);
  });

  it("does not mistake a meeting's OWN open proposal for someone else's claim", async () => {
    const d = makeDeps({
      open: [makeProposalRow({ notionHash: "an-older-hash" })],
    });
    const result = await runTranscriptSync(OPTS, d.impl);
    expect(result.skipped).toEqual([]);
    expect(result.superseded).toBe(1);
    expect(d.inserted).toHaveLength(1);
  });

  it("dry-run produces the full plan and writes nothing at all", async () => {
    const d = makeDeps({});
    const result = await runTranscriptSync(DRY, d.impl);
    expect(result.proposed).toBe(1);
    expect(d.inserted).toEqual([]);
    expect(d.ensured).toEqual([]);
    expect(d.accounted).toEqual([]);
    expect(d.states).toEqual([]);
    expect(d.notified).toEqual([]);
  });

  // The runbook sends an operator to --dry-run before the first live tick BECAUSE it
  // prints every skip with its reason. A preview that reports a different set of
  // skips than the live run would then hide the one problem in this pass only a
  // human can fix (review round 1).
  it("dry-run reports the SAME skips a live run would — the pre-flight cannot be optimistic", async () => {
    const world = {
      meetings: [meeting({ pageId: "m-a" }), meeting({ pageId: "m-b" })],
      notion: { "m-a": NOTION_MARKDOWN, "m-b": NOTION_MARKDOWN },
    };
    const preview = await runTranscriptSync(DRY, makeDeps(world).impl);
    const live = await runTranscriptSync(OPTS, makeDeps(world).impl);

    expect(preview.proposed).toBe(live.proposed);
    expect(preview.skipped.map((skip) => skip.reason)).toEqual(live.skipped.map((skip) => skip.reason));
    expect(preview.skipped[0].reason).toMatch(/already has an open proposal/);
  });

  // The contract T6 inherits has to be ENFORCED, not documented: a decline is
  // recorded against the state row, so a proposal raised without one closes over a
  // record that matched nothing and comes straight back.
  it("does not propose at all when the state row cannot be created", async () => {
    const d = makeDeps({});
    d.impl.ensureMeetingRow = async () => { throw new Error("db down"); };

    const result = await runTranscriptSync(OPTS, d.impl);

    expect(d.inserted).toEqual([]);
    expect(result.proposed).toBe(0);
    expect(result.bookkeepingFailed).toBe(1);
  });

  it("is a no-op when no meeting is mapped, and never fails the tick for it", async () => {
    const d = makeDeps({ meetings: [] });
    const result = await runTranscriptSync(OPTS, d.impl);
    expect(result.scanned).toBe(0);
    expect(result.summary).toContain("0 scanned");
  });
});

describe("runTranscriptSync — a row that already has its file", () => {
  const HASH = sha256(transcriptBody(TITLE, NOTION_MARKDOWN));
  const VAULT_SOURCE = `---\ndate: 2026-08-05\n---\n\n${transcriptBody(TITLE, NOTION_MARKDOWN)}\n`;
  const RENDERED: RenderedDoc = {
    markdown: "rendered",
    props: {
      name: TITLE, project: "Alpha", folder: "alpha/transcripts", vaultPath: PATH,
      frontmatter: "date: 2026-08-05", archived: false, sync: "📥 Notion source",
    },
  };
  // A meetings row's md_hash is the sha256 of the BODY the apply pass WROTE — not a
  // push render hash (store.ts MeetingStateRow.mdHash). Both ends go through the
  // same `vaultBodyHash`, which is what stops them splitting the file differently.
  const BODY_HASH = vaultBodyHash(VAULT_SOURCE);

  function synced(over: Partial<MeetingStateRow> = {}): Array<[string, MeetingStateRow]> {
    return [[PAGE, { pageId: PAGE, vaultPath: PATH, mdHash: BODY_HASH, notionHash: HASH, ...over }]];
  }

  // The create-only guard must not reach an UPDATE. A synced transcript's own row
  // owns its path — that is what an applied create leaves behind — so a tracked-path
  // check without the "this is a create" condition would freeze every transcript at
  // its first Notion edit, which is worse than the bug it fixes.
  it("proposes an UPDATE normally even though a linked row owns the path — that row is its own", async () => {
    const d = makeDeps({
      rows: synced({ notionHash: "older" }),
      linked: [[PATH, linkedRow({ pageId: PAGE, target: "meetings", state: "synced" })]],
      rendered: { [PATH]: RENDERED },
      vault: { [PATH]: VAULT_SOURCE },
      onDisk: new Set([PATH]),
    });
    const result = await runTranscriptSync(OPTS, d.impl);
    expect(result.skipped).toEqual([]);
    expect(result.proposed).toBe(1);
    expect(d.inserted[0].vaultPath).toBe(PATH);
    expect(d.inserted[0].baseMdHash).toBe(docRenderHash(RENDERED));
  });

  it("says nothing when the content still hashes to what the row accounted for", async () => {
    const d = makeDeps({ rows: synced(), rendered: { [PATH]: RENDERED }, vault: { [PATH]: VAULT_SOURCE } });
    const result = await runTranscriptSync(OPTS, d.impl);
    expect(result.unchanged).toBe(1);
    expect(d.inserted).toEqual([]);
    // Re-asserted, not assumed: this is also what repairs a create whose
    // bookkeeping half failed, instead of re-proposing the same file forever.
    expect(d.accounted).toEqual([{ pageId: PAGE, notionHash: HASH }]);
  });

  it("proposes an UPDATE at the SAME path when the meeting is retitled — never a second file", async () => {
    const retitled = "Ukesmøte — helt nytt navn";
    const d = makeDeps({
      meetings: [meeting({ title: retitled })],
      rows: synced(),
      rendered: { [PATH]: RENDERED },
      vault: { [PATH]: VAULT_SOURCE },
    });
    const result = await runTranscriptSync(OPTS, d.impl);

    expect(result.proposed).toBe(1);
    expect(d.inserted).toHaveLength(1);
    // The stored path wins over anything derived from the new title.
    expect(d.inserted[0].vaultPath).toBe(PATH);
    expect(d.inserted[0].kind).toBe("update");
    // An update proposal carries the BODY only — apply lifts the frontmatter from
    // disk — and the base hash is the vault render it was proposed against.
    expect(d.inserted[0].proposedBody).toBe(transcriptBody(retitled, NOTION_MARKDOWN));
    expect(d.inserted[0].baseMdHash).toBe(docRenderHash(RENDERED));
    expect(d.inserted[0].diffPreview).toContain(`- # ${TITLE}`);
    expect(d.inserted[0].diffPreview).toContain(`+ # ${retitled}`);
  });

  // Asked as CONTENT — does the file still hash to what the row accounted for? —
  // not as a push render hash. The render hash gets this wrong in two ways that both
  // wedge a transcript forever, and both are covered below.
  it("refuses to propose over a vault copy that was edited by hand, and says so once", async () => {
    const d = makeDeps({
      meetings: [meeting({ title: "Nytt navn" })],
      rows: synced(),
      rendered: { [PATH]: RENDERED },
      vault: { [PATH]: `---\ndate: 2026-08-05\n---\n\n# ${TITLE}\n\nsomeone typed this in Obsidian\n` },
    });
    const result = await runTranscriptSync(OPTS, d.impl);
    expect(result.proposed).toBe(0);
    expect(result.skipped[0].reason).toMatch(/edited/i);
    expect(d.notified).toHaveLength(1);
    expect(d.notified[0]).toContain(PATH);
    // …and it does NOT point him at `notion-sync resolve`, which cannot find a
    // meetings row and whose `--keep md` would be the forbidden Notion write.
    expect(d.notified[0]).not.toMatch(/notion-sync resolve/);
  });

  // THE THREE WEDGES, each asserted on its own. A meetings row has no freeze and no
  // `resolve`, so a false "edited by hand" retires the transcript for good and only
  // DB surgery clears it — which is why the hash this compares against has now been
  // wrong twice, and why each failure mode gets its own test rather than a shared one.
  //
  // (1) An empty hash. A written-body hash needs no re-render so it is never empty
  // today, but a row carrying one has nothing truthful to compare against, and the
  // honest move is to proceed rather than to wedge.
  it("is not wedged by an empty md_hash — the file's content is what decides", async () => {
    const d = makeDeps({
      meetings: [meeting({ title: "Nytt navn" })],
      rows: synced({ mdHash: "" }),
      rendered: { [PATH]: RENDERED },
      vault: { [PATH]: VAULT_SOURCE },
    });
    const result = await runTranscriptSync(OPTS, d.impl);
    expect(result.skipped).toEqual([]);
    expect(result.proposed).toBe(1);
  });

  // (2) The push RENDER moving on its own — a `[[wikilink]]` in the body becoming
  // resolvable once its target page exists. The file did not change; the render did.
  it("is not wedged when the push render moves on its own (a wikilink becoming resolvable)", async () => {
    const drifted: RenderedDoc = { ...RENDERED, markdown: "the render resolves a link it could not before" };
    const d = makeDeps({
      meetings: [meeting({ title: "Nytt navn" })],
      rows: synced(),                       // md_hash is the body hash, and the body is untouched
      rendered: { [PATH]: drifted },
      vault: { [PATH]: VAULT_SOURCE },
    });
    const result = await runTranscriptSync(OPTS, d.impl);
    expect(result.skipped).toEqual([]);
    expect(result.proposed).toBe(1);
    // The base hash still comes from the render, because that is what apply
    // re-checks — it is a value to carry, not the decision that was just made.
    expect(d.inserted[0].baseMdHash).toBe(docRenderHash(drifted));
  });

  // (3) A REJECTED update, which advances `notion_hash` to the DECLINED content while
  // the file keeps the previous version — so comparing the file against `notion_hash`
  // read every later Notion edit as a hand edit. The full sequence is driven over
  // seven ticks in transcript-seam.test.ts; this is the state it leaves behind.
  it("is not wedged after a rejection moved notion_hash past the file", async () => {
    const d = makeDeps({
      meetings: [meeting({ title: "Nytt navn" })],
      rows: synced({ notionHash: "the-hash-of-the-version-bendik-declined" }),
      rendered: { [PATH]: RENDERED },
      vault: { [PATH]: VAULT_SOURCE },
    });
    const result = await runTranscriptSync(OPTS, d.impl);
    expect(result.skipped).toEqual([]);
    expect(result.proposed).toBe(1);
  });

  it("reports and never proposes when the vault file behind a linked row has vanished", async () => {
    const d = makeDeps({
      meetings: [meeting({ title: "Nytt navn" })],
      rows: synced(),
      // no rendered/vault entries: renderDoc throws ENOENT
    });
    const result = await runTranscriptSync(OPTS, d.impl);
    expect(result.proposed).toBe(0);
    expect(result.errored).toBe(1);
    expect(d.inserted).toEqual([]);
  });
});

describe("runTranscriptSync — never stacking, and never re-asking", () => {
  const HASH = sha256(transcriptBody(TITLE, NOTION_MARKDOWN));

  it("leaves an open proposal that already carries exactly this content alone", async () => {
    const d = makeDeps({ open: [makeProposalRow({ notionHash: HASH })] });
    const result = await runTranscriptSync(OPTS, d.impl);
    expect(result.awaitingApproval).toBe(1);
    expect(d.inserted).toEqual([]);
    expect(d.states).toEqual([]);
  });

  it("supersedes an open proposal for the same PAGE when Notion has moved on", async () => {
    const d = makeDeps({ open: [makeProposalRow({ id: 7, notionHash: "an-older-hash" })] });
    const result = await runTranscriptSync(OPTS, d.impl);
    expect(result.superseded).toBe(1);
    expect(d.states).toEqual([{ id: 7, state: "superseded" }]);
    expect(d.inserted).toHaveLength(1);
  });

  it("stays silent about content a human rejected whose decline has not executed yet", async () => {
    // Apply runs LATER in the same tick and records the decline; until it does,
    // re-proposing here would hand the same rejected transcript straight back.
    const d = makeDeps({ rejected: [makeProposalRow({ state: "rejected", notionHash: HASH })] });
    const result = await runTranscriptSync(OPTS, d.impl);
    expect(result.awaitingDecline).toBe(1);
    expect(d.inserted).toEqual([]);
    expect(d.ensured).toEqual([]);
  });
});

describe("runTranscriptSync — cost and containment", () => {
  it("charges nothing for a meeting it can never sync — every skip happens BEFORE the read", async () => {
    // The 32 hand-made transcripts and the 6 Project-less rows are permanent
    // residents of this pass's input. If any of them cost a GET, the tick would
    // spend an API call an hour, forever, to reach the same conclusion.
    const d = makeDeps({
      meetings: [
        meeting({ pageId: "m-noproject", project: null }),
        meeting({ pageId: "m-nodate", startsAt: null }),
        meeting({ pageId: "m-exists" }),
      ],
      onDisk: new Set([PATH]),
    });
    const result = await runTranscriptSync(OPTS, d.impl);
    expect(d.reads).toEqual([]);
    expect(result.read).toBe(0);
    expect(result.skipped).toHaveLength(3);
  });

  it("contains a failed page read: counted, logged, and the next meeting still runs", async () => {
    const d = makeDeps({
      meetings: [meeting({ pageId: "m0" }), meeting({ pageId: "m2", title: "Andre møte" })],
      notion: { m2: NOTION_MARKDOWN },
      readThrows: { m0: new Error("notion GET failed: 500") },
    });
    const result = await runTranscriptSync(OPTS, d.impl);
    expect(result.errored).toBe(1);
    expect(result.proposed).toBe(1);
    expect(d.inserted[0].notionPageId).toBe("m2");
  });

  it("flags a Notion-signed expiring media URL rather than pretending the link will keep working", async () => {
    const d = makeDeps({
      notion: { [PAGE]: "![shot](https://prod-files.secure.notion-static.com/x.png?X-Amz-Expires=3600)" },
    });
    const result = await runTranscriptSync(OPTS, d.impl);
    expect(result.mediaDeferred).toBe(1);
    // Reported, not refused: a one-way import creates the file anyway (spec §4.4).
    expect(result.proposed).toBe(1);
  });

  it("contains a bookkeeping failure without losing the rest of the tick", async () => {
    const d = makeDeps({});
    d.impl.insertProposal = async () => { throw new Error("db down"); };
    const result = await runTranscriptSync(OPTS, d.impl);
    expect(result.bookkeepingFailed).toBe(1);
  });
});
