// T4 (Phase 4, ORB-39): the transcript pull — the meeting note Bendik actually
// reads in Notion, checked todos and all, becoming the vault copy his agents can
// search. One-way Notion→vault, permanently (spec §17.2), and 👍-gated like every
// other Notion→vault write (§18.4/§20): this engine proposes, it never writes.
//
// Vendor-neutral and pure in exactly the sense pull-sync.ts and archive-excluded.ts
// are: every side effect arrives as an injected dep, every meeting is contained,
// the ordering is deterministic (sorted), and dry-run produces the full plan with
// zero writes.
//
// FOUR things this engine must not get wrong, each of which is a decision rather
// than an implementation detail:
//
//   1. **The state row IS the Meetings row.** `notion_page_id` is globally UNIQUE
//      and the attendee pass already keys Meetings rows by it, so a transcript
//      cannot have a second, docs-shaped row of its own — inserting one violates the
//      constraint, and the file it just wrote is then an orphan the push pass adopts
//      into a SECOND Notion page. `vault_path` on that Meetings row is exactly what
//      the schema reserved for this ("NULL until a vault file is linked", sql/015),
//      and it is what plan decision 1 means by "stored on the state row".
//
//   2. **The path is fixed at first sync and never moves** (decision 1). Once
//      `vault_path` is set it is authoritative forever: a later rename in Notion
//      changes the TITLE INSIDE the document and never the path. Deriving the path
//      afresh every tick would fork a retitled meeting into a second file and orphan
//      the first — with all of the first file's backlinks pointing at a dead note.
//
//   3. **The `<transcript>` block survives byte-intact**, which is why this pass
//      does NOT put the body through `parseNotionPage`/`assertPullSafe`. Those two
//      exist to make a body that can round-trip BACK to Notion, and `assertPullSafe`
//      refuses a live `<transcript` outright for exactly that reason ("cannot round
//      trip"). There is no round trip here — the vault copy is a projection that no
//      pass may ever push — so the honest thing to store is what Notion said, and
//      the honest way to guarantee "byte-intact" is not to touch it. The cost,
//      named: Notion-flavoured constructs (`<callout …>`, `<mention-page>`) land in
//      the vault as themselves rather than as Obsidian's spellings.
//
//   4. **The title is content, not metadata.** Notion's `GET /markdown` omits the
//      page title — it is the `Name` property, and a leading `# H1` is silently
//      DROPPED on both create and patch (live-probed at API version 2026-03-11) — so
//      this engine synthesises the H1 itself and hashes it WITH the body. Hashing
//      Notion's markdown alone would make a retitle invisible to change detection,
//      and putting the title in frontmatter instead would put it where an approved
//      update can never reach it (apply lifts the frontmatter block from disk,
//      verbatim, and only the body is Notion's to change).
import {
  diffPreview, docRenderHash, splitFrontmatter, vaultBodyHash, type RenderedDoc,
} from "./pull-sync.js";
import { sha256 } from "./wiki-sync.js";
import { refuseVaultTarget, truncateToBytes, MAX_SEGMENT_BYTES } from "./vault-target.js";
import type {
  LinkedRow, MeetingStateRow, ProposalInput, ProposalRow, ProposalState,
} from "./store.js";
import type { ProjectMapping } from "./types.js";
// Straight from @lares/vault-format — the dependency-free package, not the role kit this
// service does not ship with (docs/specs/2026-09-18-origin-model-design.md).
import { originFrontmatterLine } from "@lares/vault-format/origin";

/**
 * One Meetings row as this engine needs it. A structural type rather than the
 * adapter's `NotionMeetingRow`, for the same reason attendees.ts declares its own
 * `MeetingRow`: the engine may not import from adapters/ (neutrality.test.ts), and
 * the adapter's row is assignable to this one, so the composition root hands it
 * over with no mapping layer in between.
 */
export interface TranscriptMeetingRow {
  pageId: string;
  /** The `Meeting Title` property. */
  title: string;
  /** The `Project` select — the key into the folder mapping. NULL is a real state. */
  project: string | null;
  /**
   * When the meeting started — the adapter's DERIVED value (ORB-155), not the raw
   * `Date` property: the property first when it carries a time, then the title's
   * date mention, then the page's `created_time`. Only the day is used here, and
   * the first two sources carry their own offset so slicing gives the human's day.
   * `created_time` is UTC, so a meeting starting after 22:00 local could name the
   * previous day — accepted, because it is the last resort for a row that would
   * otherwise have no filename at all and so no transcript in the vault.
   */
  startsAt: string | null;
}

export interface TranscriptSyncOptions {
  dryRun: boolean;
  /** `transcripts.dir` — the sub-folder inside each project folder ("transcripts"). */
  dir: string;
  /** `transcripts.projects` — Notion `Project` → vault folder. Config, never code. */
  projects: ProjectMapping[];
  /**
   * Has config carved this vault path out of the DESK scope (`deskDirs[].exclude`)?
   * Pass `makeDeskExclusion(cfg.desks)` — there is no other correct value.
   *
   * REQUIRED, and it is a refusal rather than a filter: a transcript may only be
   * proposed into a folder the desk passes have been told to leave alone. Two
   * misconfigurations reach here, and the second is destructive:
   *
   *  - the mapped `vaultFolder` is not a configured desk dir at all. `makeCreateScope`
   *    would then refuse the create at apply time (T3b), so every proposal this pass
   *    made would be superseded after Bendik had already tapped Approve. Refusing
   *    here turns that into one reported line per meeting instead.
   *  - the mapped folder IS a desk dir but does NOT exclude `transcripts.dir`. Then
   *    the desk push's vault walker LISTS the transcript file, finds no docs row for
   *    it, and adopts it — creating a second Notion page for a document Notion
   *    already holds, and (because `upsertDocSynced` conflicts on vault_path, which
   *    is UNIQUE across targets) REPOINTING the Meetings row at that new page. The
   *    transcript's own source would be lost from the row that tracks it.
   *
   * So this is not belt-and-braces over T2's config carve-out — it is the check that
   * makes the carve-out's ABSENCE loud instead of destructive. Built from the same
   * `makeDeskExclusion` every other boundary uses, never a second notion of scope.
   */
  isExcluded: (vaultPath: string) => boolean;
  /**
   * The clock the unmapped-page alert ages meetings against (LAR-30 follow-up).
   * This file has no clock dep of its own to reuse, so — matching the pattern
   * `run.ts`/`attendees.ts` already take for the same problem — it is an option a
   * caller can pin, defaulting to `new Date()` so production needs nothing and
   * tests stay deterministic without faking the global clock.
   */
  now?: Date;
}

export interface TranscriptSyncDeps {
  /** One query per tick — every Meetings row, the same read the attendee pass makes. */
  queryMeetings: () => Promise<TranscriptMeetingRow[]>;
  /** The Meetings state rows, keyed by page id (store.ts getMeetingRows). */
  getMeetingRows: () => Promise<Map<string, MeetingStateRow>>;
  getOpenProposals: () => Promise<ProposalRow[]>;
  /**
   * Rejected proposals whose decline the apply pass has not executed yet. Needed
   * for the same reason pull needs it: a rejection is invisible in
   * `getOpenProposals`, and apply runs LATER in this same tick, so without this the
   * pass would hand a human the transcript he just rejected straight back.
   */
  getRejectedUnexecuted: () => Promise<ProposalRow[]>;
  getPageMarkdown: (pageId: string) => Promise<string>;
  /**
   * The push-shaped render of the vault file (cli.ts makeDocRender) — the SAME
   * function the apply pass uses, which is what makes `baseMdHash` and the stored
   * `md_hash` comparable at all.
   */
  renderDoc: (vaultPath: string) => Promise<RenderedDoc>;
  /** Raw vault bytes — only for the diff preview; this engine never writes the vault. */
  readVaultFile: (vaultPath: string) => Promise<string>;
  /** Is something already at this path? Asked before a first sync, never after. */
  vaultFileExists: (vaultPath: string) => Promise<boolean>;
  /**
   * Every row that HAS a vault file, keyed by path, ACROSS BOTH TARGETS (store.ts
   * getLinkedRows) — the "who already owns this path?" reader, which is a different
   * question from `getMeetingRows`'s "what is the state of this meeting?".
   *
   * It is deliberately the SAME reader the apply pass builds its snapshot from
   * (apply-sync.ts), because apply's guard 0 is what refuses a create for a path a
   * row already tracks. A proposer that asks a NARROWER question than the guard it
   * feeds can raise a proposal that can never land: proposed, approved, refused,
   * and proposed again on the very next tick, forever, with one Telegram button
   * message per round. T6 already wrote that down for the other create proposer
   * (notion-born-sync.ts, review round 1, Important B); this is the same defect.
   *
   * `getMeetingRows` cannot answer it — it is `WHERE target='meetings'`, so a DOCS
   * row sitting on the derived path is invisible to it. That row is not exotic:
   * Phase 3's sweep left 32 of them on `<project>/transcripts/` paths, T3 orphans
   * the row and keeps it, and the file under it disappears the moment Bendik acts
   * on this pass's own "adoption is a decision for a human" skip.
   */
  getLinkedRows: () => Promise<Map<string, LinkedRow>>;
  /** Makes sure the Meetings page has a state row (store.ts) — see the create branch. */
  ensureMeetingRow: (pageId: string) => Promise<void>;
  insertProposal: (input: ProposalInput) => Promise<number>;
  setProposalState: (id: number, state: ProposalState) => Promise<void>;
  /** Records the Notion content this row has accounted for, keyed by PAGE. */
  recordNotionAccounted: (pageId: string, notionHash: string) => Promise<void>;
  /** Best-effort human ping (signal-spine, or console.log when unconfigured). */
  notify: (message: string, opts?: { key?: string; severity?: "info" | "warn" }) => Promise<void>;
}

/** A meeting this pass deliberately did nothing about, and why. Reported, never silent. */
export interface TranscriptSkip {
  pageId: string;
  title: string;
  /** The path it would have landed at, when one could be derived at all. */
  vaultPath?: string;
  reason: string;
}

export interface TranscriptSyncResult {
  /** Meetings rows considered this tick. */
  scanned: number;
  /** Pages actually fetched (`GET /markdown`) — the cost of the tick. */
  read: number;
  /** Read, but the content still hashes to what the row already accounted for. */
  unchanged: number;
  proposed: number;
  superseded: number;
  /** Rows whose open proposal already carries exactly this content. */
  awaitingApproval: number;
  /** Rows holding content a human rejected, waiting for apply to record the decline. */
  awaitingDecline: number;
  errored: number;
  /**
   * Proposals carrying a Notion-signed media URL that will expire (spec §4.4). A
   * one-way import creates the file anyway — the alternative is no meeting note at
   * all — but the file is FLAGGED rather than quietly shipped with a link that dies
   * within the hour.
   */
  mediaDeferred: number;
  bookkeepingFailed: number;
  skipped: TranscriptSkip[];
  summary: string;
}

/**
 * Norwegian letters get their conventional two-letter ASCII spelling rather than
 * being stripped to a bare vowel: `møte` must become `moete`, not `mte` (which
 * loses the word) and not `mote` (which is a different word). Applied BEFORE the
 * accent strip below, because NFD decomposition would turn `å` into `a` + a
 * combining ring and the ring is what gets removed.
 */
const TRANSLITERATE: Record<string, string> = {
  æ: "ae", ø: "oe", å: "aa", ð: "d", þ: "th", đ: "d", ł: "l", ß: "ss",
};

/**
 * The filename stem's byte budget, comfortably under `refuseVaultTarget`'s
 * per-segment cap so the `.md` suffix and any future prefix still fit. The
 * budget lives with the rule that enforces it (vault-target.ts) rather than as a
 * second number here — see truncateToBytes.
 */
const MAX_SLUG_BYTES = MAX_SEGMENT_BYTES - 20;

/** `YYYY-MM-DD`, and nothing that merely looks like it. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Notion-signed media URLs, which expire in roughly an hour (spec §4.4). A local
 * copy of the pattern translate-pull.ts carries, deliberately not shared: that one
 * is a `g` regex whose `lastIndex` is reset by its own caller, and reaching across
 * for it would couple two rails that mean different things — there, a match REFUSES
 * a write-back; here, it flags a file that is created anyway.
 */
const EXPIRING_MEDIA = /secure\.notion-static\.com|file\.notion\.so|X-Amz-/i;

/**
 * How long an unmapped meeting still gets its OWN per-page ping (LAR-30 follow-up).
 * `queryMeetings` returns every Meetings row ever synced, with no age window of its
 * own — so without a cutoff, a page unmapped since before this alert existed would
 * fire a per-page thread on every tick forever, alongside every OTHER long-unmapped
 * page: dozens of Slack threads and a brief full of individually-named warnings on
 * first deploy, none of them anything Bendik can still act on this week. Recent
 * meetings still get named individually, because those are the ones worth opening
 * and fixing; the backlog goes back to one quiet aggregate line (see below).
 */
const UNMAPPED_PAGE_WARNING_DAYS = 14;

/**
 * Is this row recent enough to still earn its own named ping? Ages `startsAt` — the
 * same derived value `transcriptDate` slices for the filename (see the field's own
 * comment above) — against `now`, in whole days.
 *
 * A row with no usable `startsAt` counts as recent: `startsAt` is missing only for a
 * row so sparse it also has no filename (transcriptDate returns null for the same
 * input), and treating "no date" as "old, so stay quiet" would let a genuinely
 * unmappable meeting go unmentioned forever. Silence is exactly the bug this alert
 * exists to fix, so the ambiguous case errs toward warning, not toward dropping it.
 */
function isRecentMeeting(startsAt: string | null, now: Date): boolean {
  if (startsAt === null) return true;
  const startedAt = new Date(startsAt);
  if (Number.isNaN(startedAt.getTime())) return true;
  const ageMs = now.getTime() - startedAt.getTime();
  return ageMs <= UNMAPPED_PAGE_WARNING_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * A Notion title as a filename stem: ASCII, lowercase, hyphen-separated, capped by
 * BYTES.
 *
 * ASCII on purpose, even though `refuseVaultTarget` would happily accept `æøå` and
 * git and Obsidian both handle UTF-8 filenames. The vault is a Linux clone that is
 * also checked out on an APFS Mac, and the two disagree about unicode filenames in
 * two independent ways — case folding, and NFC vs NFD normalisation of exactly
 * these letters. A transliterated stem is the same bytes on both, and nothing is
 * lost: the full title, accents and all, is the H1 on the document's first line.
 *
 * Returns "" when the title carries nothing usable. The caller must treat that as a
 * SKIP rather than falling back to a bare date, because two untitled meetings on one
 * day would then claim the same path — and the second create would be refused at
 * apply time with no way for anyone to tell which meeting it was about.
 */
export function transcriptSlug(title: string): string {
  const lowered = title.toLowerCase();
  let mapped = "";
  for (const ch of lowered) mapped += TRANSLITERATE[ch] ?? ch;
  const cleaned = mapped
    // Strip the combining marks NFD exposes, so `é` becomes `e` rather than
    // vanishing with the rest of the non-ASCII text below.
    .normalize("NFD").replace(/\p{M}+/gu, "")
    // Everything that is not an unaccented ASCII letter or digit is a separator:
    // spaces, `&`, em dashes, quotes, slashes, colons. One rule rather than a list
    // of characters to escape, so a title this service has never seen cannot
    // produce a path shape it has never seen either.
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Capped by BYTES through the same helper the shape guard's budget lives with, so
  // the cap here and the refusal there cannot drift apart. The stem is pure
  // `[a-z0-9-]` by the time it gets here, so bytes and characters agree — but the
  // budget is a filesystem limit, which counts bytes, and stating it in the unit the
  // limit is actually in is what keeps this correct if the transliteration rule ever
  // widens. The trailing-hyphen trim runs AGAIN afterwards so a cut landing mid-word
  // does not leave the stem ending on a separator.
  return truncateToBytes(cleaned, MAX_SLUG_BYTES).replace(/-+$/, "");
}

/**
 * The `Date` property's start as a plain calendar date, or null when there is none
 * to be had.
 *
 * The LOCAL date, taken by slicing the string Notion returned rather than by
 * building a `Date` and asking for its UTC day. A meeting at `2026-08-06T00:30+02:00`
 * is the 6th to the person who scheduled it and the 5th in UTC, and the date in a
 * meeting note's filename is the human's, not the clock's. Slicing keeps the offset
 * Notion stored; converting would silently move a late-evening or early-morning
 * meeting into the wrong day — permanently, since the path is fixed at first sync.
 */
export function transcriptDate(startsAt: string | null): string | null {
  if (startsAt === null) return null;
  const date = startsAt.slice(0, 10);
  return ISO_DATE.test(date) ? date : null;
}

/**
 * The document body: the title as an H1, then Notion's markdown VERBATIM.
 *
 * The H1 is synthesised because Notion does not give it back — the title is the
 * `Name` property, and a leading `# H1` is dropped on both create and patch (live
 * probe, API version 2026-03-11). It goes in the body rather than in frontmatter
 * because an approved update writes `frontmatter-from-disk + proposed body`, so the
 * body is the only part of the file a later retitle can actually reach.
 *
 * Whitespace inside the title is collapsed: a Notion title can contain a newline,
 * and a two-line H1 is two blocks, of which only the first is a heading.
 */
export function transcriptBody(title: string, markdown: string): string {
  const heading = `# ${title.replace(/\s+/g, " ").trim()}`;
  const body = markdown.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  return body === "" ? heading : `${heading}\n\n${body}`;
}

export interface TranscriptFileInput {
  title: string;
  markdown: string;
  date: string;
  project: string;
  pageId: string;
}

/**
 * A YAML scalar that says what it means: bare when it is unambiguous, JSON-quoted
 * otherwise. `project` is a Notion select value and can hold a colon, a `#`, or a
 * leading quote, any of which turns a bare scalar into either a different value or
 * a parse error in every tool that reads the vault's frontmatter.
 *
 * Exported for T6 (Phase 4), which composes frontmatter from Notion properties that
 * are just as free-form. Both create proposers write frontmatter into files a human
 * and every vault tool then read, and two quoting rules that agree today are two
 * that can disagree tomorrow.
 */
export function yamlScalar(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(value) ? value : JSON.stringify(value);
}

/**
 * The WHOLE file a create proposal carries — frontmatter included, because there is
 * no file on disk to lift a frontmatter block from (T3b) — and with NO trailing
 * newline, because the apply engine adds exactly one.
 *
 * The frontmatter deliberately carries no `title`. The title is the one field a
 * retitle in Notion changes, and an approved update can only reach the BODY, so a
 * `title:` here would be correct exactly once and then quietly disagree with the H1
 * three lines below it forever. What it does carry is the part that identifies the
 * document rather than describing it: which meeting, which day, which project, the
 * Notion page to go back to when a media link has expired, and `lares_origin: synced`
 * (ADR-0017 rule 9) — the class names the sync job's own 👍 gate that put this file
 * here, never the meeting participants, so the class holds regardless of who spoke.
 */
export function transcriptFile(input: TranscriptFileInput): string {
  const frontmatter = [
    "---",
    `date: ${input.date}`,
    `project: ${yamlScalar(input.project)}`,
    "source: notion-meetings",
    originFrontmatterLine("synced"),
    `notion_page: ${input.pageId}`,
    "---",
  ].join("\n");
  return `${frontmatter}\n\n${transcriptBody(input.title, input.markdown)}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runTranscriptSync(
  opts: TranscriptSyncOptions,
  deps: TranscriptSyncDeps,
): Promise<TranscriptSyncResult> {
  const folderByProject = new Map(opts.projects.map((p) => [p.notionProject, p.vaultFolder]));
  const now = opts.now ?? new Date();
  const meetings = [...await deps.queryMeetings()].sort((a, b) => (a.pageId < b.pageId ? -1 : 1));
  const rows = await deps.getMeetingRows();
  // Every vault path a state row already owns, ACROSS BOTH TARGETS — the propose-side
  // twin of apply's guard 0 ("the vault already tracks that file"). See
  // `TranscriptSyncDeps.getLinkedRows` for why the meetings-only snapshot above
  // cannot answer this, and what it costs to ask the narrower question.
  const trackedPaths = await deps.getLinkedRows();

  // Open and rejected-unexecuted proposals indexed by PAGE, not by path: a meeting
  // is one document however many paths a retitle has made it consider, and the
  // open-proposal unique index is per vault_path, so two open proposals for one
  // page under two slugs is a shape the store permits and this pass must collapse.
  const openByPage = new Map<string, ProposalRow[]>();
  // …and by PATH, which answers a different question: who has already claimed this
  // filename? Two meetings on one day with the same title produce the same slug, and
  // `notion_sync_proposals_open` (016) is UNIQUE on vault_path across pending and
  // approved — so a second create for that path does not merely duplicate, it
  // VIOLATES the index. Left unguarded the insert throws every tick, forever, and
  // the tick reports unclean with nothing an operator can do about it.
  const claimedBy = new Map<string, string>();
  for (const proposal of await deps.getOpenProposals()) {
    const list = openByPage.get(proposal.notionPageId);
    if (list === undefined) openByPage.set(proposal.notionPageId, [proposal]);
    else list.push(proposal);
    claimedBy.set(proposal.vaultPath, proposal.notionPageId);
  }
  const rejectedByPage = new Map<string, ProposalRow[]>();
  for (const proposal of await deps.getRejectedUnexecuted()) {
    const list = rejectedByPage.get(proposal.notionPageId);
    if (list === undefined) rejectedByPage.set(proposal.notionPageId, [proposal]);
    else list.push(proposal);
  }

  let read = 0;
  let unchanged = 0;
  let proposed = 0;
  let superseded = 0;
  let awaitingApproval = 0;
  let awaitingDecline = 0;
  let errored = 0;
  let mediaDeferred = 0;
  let bookkeepingFailed = 0;
  const skipped: TranscriptSkip[] = [];

  /** Same containment as every other engine here — a bookkeeping write never aborts a run. */
  async function tryRecord(what: string, pageId: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      bookkeepingFailed += 1;
      console.error(`notion-sync: bookkeeping write failed (${what}) for meeting ${pageId}: ${errorMessage(err)}`);
    }
  }

  /** Best-effort, never fatal, silent in dry-run — the contract every pass here shares. */
  async function ping(message: string, pingOpts?: { key?: string; severity?: "info" | "warn" }): Promise<void> {
    if (opts.dryRun) return;
    try {
      await deps.notify(message, pingOpts);
    } catch (err) {
      console.error(`notion-sync: notify failed: ${errorMessage(err)}`);
    }
  }

  function skip(row: TranscriptMeetingRow, reason: string, vaultPath?: string): void {
    skipped.push({
      pageId: row.pageId, title: row.title, reason,
      ...(vaultPath === undefined ? {} : { vaultPath }),
    });
    console.log(`notion-sync: transcripts: skipped ${row.pageId} (${row.title}) — ${reason}`);
  }

  /**
   * Projects whose transcripts land nowhere, for meetings OLDER than
   * `UNMAPPED_PAGE_WARNING_DAYS` (ORB-155, decision 3; restored, scoped, LAR-30
   * follow-up). A recent unmapped meeting gets its own named ping, below, because
   * that is one Bendik can still open and fix this fortnight. A meeting this old is
   * backlog — naming each one individually would just be dozens of threads for
   * nothing actionable — so the backlog goes back to the original ONE aggregate
   * line per tick, by Project, exactly as it read before this file learned to name
   * pages. `null` stands for a row carrying no Project at all, same as before.
   */
  const unmappedProjects = new Set<string | null>();

  for (const row of meetings) {
    const state = rows.get(row.pageId);

    // ── Where does it go? ────────────────────────────────────────────────────
    // A stored vault_path is AUTHORITATIVE and is not re-derived (decision 1).
    // Everything below the `else` is first-sync-only, which is what makes a
    // retitle change the document's heading and never its filename.
    let vaultPath: string;
    if (state?.vaultPath != null) {
      vaultPath = state.vaultPath;
    } else {
      const folder = row.project === null ? undefined : folderByProject.get(row.project);
      if (folder === undefined) {
        skip(row, row.project === null
          ? "the meeting has no Project, so no vault folder can be chosen for it"
          : `the Project "${row.project}" is not in transcripts.projects — add the mapping, or leave it out on purpose`);
        if (isRecentMeeting(row.startsAt, now)) {
          // One signal per PAGE, not per tick (ORB-155 decision 3; LAR-30), but only
          // for a meeting still within UNMAPPED_PAGE_WARNING_DAYS — see that constant
          // for why the backlog does not also get a thread each. Naming the Project
          // only told Bendik that a whole category was broken and left him to guess
          // which meeting to fix; naming the TITLE tells him exactly which Meetings
          // row to open. The message is built ONLY from this row's own fields, so it
          // is byte-identical every tick this row stays unmapped — the spine dedupes
          // on that text (signal-notify.ts: "a repeat threads under the first Slack
          // post and edits its counter"), which is what makes this "one per page id
          // until the row changes" without this pass tracking any state of its own.
          // Once Project is set or the mapping is added, the message changes (or
          // stops firing), and the thread resolves on the spine's side.
          await ping(
            `notion-sync: transcripts: "${row.title}" (${row.pageId}) has no vault folder — ` +
            (row.project === null
              ? "the meeting has no Project. Fix: set Project on the Meetings row."
              : `the Project "${row.project}" is not in transcripts.projects. ` +
                "Fix: add the mapping to transcripts.projects, or set a different Project on the row."),
            { key: "unmapped-project", severity: "warn" },
          );
        } else {
          unmappedProjects.add(row.project);
        }
        continue;
      }
      const date = transcriptDate(row.startsAt);
      if (date === null) {
        skip(row, "the meeting has no usable Date property, and a transcript's filename starts with its date");
        continue;
      }
      const slug = transcriptSlug(row.title);
      if (slug === "") {
        skip(row, `the title ${JSON.stringify(row.title)} produces no usable filename`);
        continue;
      }
      vaultPath = `${folder}/${opts.dir}/${date}-${slug}.md`;

      // The shape rules, asked EARLY as a courtesy: the same function refuses the
      // path again at apply time, under the note lock, which is the actual
      // guarantee (vault-target.ts). Reaching it here means the folder mapping or
      // the transcripts dir is configured to something that could never be
      // written, which is an operator's problem, not a per-tick failure.
      const refusal = refuseVaultTarget(vaultPath);
      if (refusal !== null) {
        skip(row, `the derived path cannot be written: ${refusal}`, vaultPath);
        continue;
      }

    }

    // …and the SCOPE rule the shape rules cannot answer, asked for EVERY row rather
    // than only for a freshly derived one (review round 1). A transcript that synced
    // fine last week is exactly the case that matters: the carve-out is a line in a
    // config file, and an operator can remove it from under a document that already
    // has its `vault_path`. Checking only on first sync left this branch guarding
    // the harmless half.
    //
    // It is the SECOND guard, not the only one. Refusing to propose stops nothing on
    // its own — the damage happens in the push pass — so the real protections are
    // structural and live there: `pushHoldBack` (direction.ts) holds back any path a
    // non-docs row owns, and `upsertDocSynced` refuses to update one. This is the
    // half that makes the misconfiguration READABLE, per meeting, with the fix in
    // the sentence.
    if (!opts.isExcluded(vaultPath)) {
      skip(
        row,
        "that folder is not carved out of the desk scope — add it to the desk dir's " +
        "`exclude` in config, or the desk passes will keep trying to treat these files " +
        "as their own",
        vaultPath,
      );
      continue;
    }

    // ── Is there anything to do? ─────────────────────────────────────────────
    // NO TIMESTAMP PRE-FILTER, unlike the desk pull, and that is a decision worth
    // stating because the absence is what a reader will notice.
    //
    // `notion_last_edited` on a Meetings row belongs to the ATTENDEE pass: it is the
    // stamp as of the last time THAT pass filled or flagged the row, which is a
    // claim about a different question. Borrowing it here would be the same
    // two-meanings-one-column mistake the state gate below refuses to make — and it
    // would buy nothing, because the pre-filter it would feed cannot fire: the
    // comparison has to be `>=` rather than `>` (Notion stamps last_edited_time at
    // MINUTE granularity, so an edit inside the same minute as the last reading
    // would otherwise be invisible forever), and `>=` against an observed stamp is
    // true on every subsequent tick by construction. The desk pull carries the same
    // `>=` and re-reads every synced row every tick for exactly this reason.
    //
    // So the content hash is the whole change test, which is what spec §3 says it
    // must be. The cost is one `GET /markdown` per mapped meeting per tick — and
    // every skip below happens BEFORE the read, so the rows that will never sync
    // (unmapped Project, no Date, path already occupied) cost nothing at all.

    // Nothing has been brought into the vault yet AND something is already sitting
    // at the path this meeting would claim. That is the 32 hand-made transcripts
    // this vault already holds, and adopting one on a derived-path match is exactly
    // what decision 2 forbids ("REPORTED, never auto-adopted"): the file may be
    // hand-curated, and Notion's version would silently replace it. Asked BEFORE the
    // read so a folder full of them costs no API calls at all.
    if (state?.vaultPath == null && await deps.vaultFileExists(vaultPath)) {
      skip(row, "a vault file already exists at that path — adoption is a decision for a human, not this pass", vaultPath);
      continue;
    }

    // …and the same question asked of the STORE, which the disk cannot answer: a row
    // already OWNS this path even though nothing is sitting there. Apply's guard 0
    // reads exactly this (`getLinkedRows`, across both targets) and refuses the
    // create, so without this the proposal is raised, approved, refused, and raised
    // again on the very next tick — forever, one Telegram button message per round.
    //
    // AFTER the disk check on purpose. When both are true the file is the thing
    // Bendik can see, and "a vault file already exists at that path" is the sentence
    // that tells him what to do about it; this one is for the case only the database
    // knows about, which is where a reader would otherwise have nothing to go on.
    //
    // No page comparison: reaching here means this meeting's own row carries no
    // `vault_path`, so the row holding this path is always somebody else's.
    if (state?.vaultPath == null) {
      const tracked = trackedPaths.get(vaultPath);
      if (tracked !== undefined) {
        skip(
          row,
          `the vault already tracks that path as the projection of another Notion page ` +
          `(${tracked.pageId}, a ${tracked.target} row, state ${tracked.state}) — a file ` +
          "created there could never be approved. Retitle the meeting in Notion, or retire " +
          "that row first.",
          vaultPath,
        );
        continue;
      }
    }

    // ── What does Notion hold? ───────────────────────────────────────────────
    read += 1;
    let markdown: string;
    try {
      markdown = await deps.getPageMarkdown(row.pageId);
    } catch (err) {
      // Contained per meeting, like every other engine here. Nothing is recorded:
      // a meetings row has no error counter this pass may write (recordDocError is
      // `target='docs'`), and the honest consequence of a failed read is simply
      // that the watermark does not move, so the next tick tries again.
      errored += 1;
      console.error(`notion-sync: transcripts: page read failed for ${row.pageId}: ${errorMessage(err)}`);
      continue;
    }

    const body = transcriptBody(row.title, markdown);
    // THE change test. Over the composed body, not over Notion's markdown, because
    // the title is a PROPERTY: a retitled meeting comes back with byte-identical
    // markdown, and hashing that alone would make the rename invisible forever.
    const notionHash = sha256(body);

    if (notionHash === state?.notionHash) {
      unchanged += 1;
      // Re-asserted rather than assumed to be already stored, because this is also
      // the step that CLOSES a create: the apply pass records the proposal's hash
      // when it writes the file, so the first tick afterwards lands here and agrees
      // — and if that bookkeeping had failed, this is what repairs it, silently and
      // idempotently, instead of leaving the row proposing the same file forever.
      if (!opts.dryRun) {
        await tryRecord("accounted", row.pageId, () =>
          deps.recordNotionAccounted(row.pageId, notionHash));
      }
      continue;
    }

    // A human already said no to exactly this content and the apply pass has not
    // recorded the decline yet — it runs later in this same tick. Re-proposing here
    // would hand him back the transcript he just rejected. Nothing at all happens
    // for this row: no proposal, no watermark move, so the state stays honest until
    // the decline lands.
    if ((rejectedByPage.get(row.pageId) ?? []).some((p) => p.notionHash === notionHash)) {
      awaitingDecline += 1;
      continue;
    }

    // Never stack (§18.4): an open proposal already carrying exactly this content
    // IS this content's proposal. Left as it stands — no supersede, no duplicate, no
    // watermark move — which is what makes the pass tick-stable rather than a
    // re-propose loop.
    const open = openByPage.get(row.pageId) ?? [];
    if (open.some((p) => p.notionHash === notionHash)) {
      awaitingApproval += 1;
      continue;
    }

    // ── Create, or update? ───────────────────────────────────────────────────
    const isCreate = state?.vaultPath == null;

    // One open claim per path, and the claimant has to be this meeting. Seeded from
    // the open proposals and extended as this tick proposes, so two meetings whose
    // titles slug the same way on the same day are caught whether the first claim
    // was made last week or four lines ago. Reported rather than silently dropped:
    // only a human can tell the two meetings apart, and renaming one in Notion is
    // the fix.
    const claimant = claimedBy.get(vaultPath);
    if (isCreate && claimant !== undefined && claimant !== row.pageId) {
      skip(
        row,
        `another meeting (${claimant}) already has an open proposal for that exact path — ` +
        "two meetings on one day are slugging to the same filename; retitle one of them",
        vaultPath,
      );
      continue;
    }
    let proposedBody: string;
    let baseMdHash: string;
    let before = "";

    if (isCreate) {
      // The proposal owns every byte, frontmatter included, and carries no trailing
      // newline (T3b's contract — the engine adds exactly one).
      proposedBody = transcriptFile({
        title: row.title,
        markdown,
        // Both non-null here: a create only gets this far through the derivation
        // above, which skips a meeting missing either.
        date: transcriptDate(row.startsAt) as string,
        project: row.project as string,
        pageId: row.pageId,
      });
      // A create is proposed against no vault render, and the apply engine ASSERTS
      // that (guard 1) rather than assuming it.
      baseMdHash = "";
    } else {
      let source: string;
      try {
        source = await deps.readVaultFile(vaultPath);
      } catch (err) {
        // The row says a file is linked and the vault disagrees — a hand-deleted or
        // hand-moved transcript. Reported and left alone: this pass creates files
        // only where nothing has ever been, and re-creating one a human removed is
        // the opposite of what removing it meant.
        errored += 1;
        console.error(
          `notion-sync: transcripts: ${vaultPath} is linked to ${row.pageId} but could not be ` +
          `read: ${errorMessage(err)} — nothing proposed`,
        );
        continue;
      }

      // Freeze-and-flag rather than merge (§6), in this pass's own terms: has a
      // human edited the vault copy since this service last wrote it?
      //
      // Compared against `md_hash`, which for a meetings row is the sha256 of the
      // BODY THE APPLY PASS WROTE (store.ts MeetingStateRow.mdHash). Three candidate
      // hashes have been tried here and the other two are both wrong in ways that
      // permanently retire a transcript — which matters more here than anywhere else
      // in this service, because a meetings row has no freeze and no `resolve` to
      // heal it, so the only exit is DB surgery:
      //
      //   - a push RENDER hash moves on its own when a `[[wikilink]]` in the body
      //     becomes resolvable, and is `""` whenever the post-write re-render failed
      //     ("" != null, so every later change read as a hand edit);
      //   - `notion_hash` means "the content this row has ACCOUNTED FOR", and a
      //     REJECTED update deliberately advances it to the content that was
      //     DECLINED — that is what stops pull re-asking — while the file on disk
      //     still holds the previous version. So after one 👎, every later Notion
      //     edit was misdiagnosed as a hand edit (review round 2).
      //
      // `md_hash` is the only one that answers the question actually being asked. It
      // needs no re-render, so it can never be empty, and it moves only when the file
      // does. Both ends go through the same `vaultBodyHash`, so they cannot split the
      // file differently.
      //
      // The `!== ""` is belt: a written-body hash is never empty today, and if a row
      // ever carries one there is nothing truthful to compare against, so the honest
      // move is to proceed rather than to wedge.
      //
      // Reported rather than frozen, deliberately: a freeze is a claim about a DOCS
      // row (`freezeDoc`, `getFrozenDocs` and `notion-sync resolve` are all
      // `target='docs'`), so calling it here would update nothing and hand Bendik a
      // command that cannot find the row. The ping text is FIXED per path so the
      // fingerprint is stable and the spine can collapse the repeats: the first sighting
      // posts one card, and every later one threads under it and edits its counter
      // (10 replies/hour cap, closed after 24 h quiet). NOT "one alert a day" and NOT a
      // 24 h gate — that gate is the LINEAR one (`alreadyIssued`), which decides whether
      // a ticket is opened and has never had anything to do with what Slack shows.
      if (state?.mdHash != null && state.mdHash !== "" && vaultBodyHash(source) !== state.mdHash) {
        skip(row, "the vault copy has been edited by hand — Notion's newer version is not being proposed", vaultPath);
        // NOT "or move the file" (review round 2): the state row still points at
        // this path, so a moved file makes every later tick fail to read it and
        // report an error instead — that retires the transcript rather than
        // recovering it. A byte-exact restore is the only thing that works, and the
        // vault is a git repo in which every write this service made was committed.
        await ping(
          `transcript ${vaultPath} has been edited in the vault, and Notion's copy has changed too — ` +
          `nothing was written on either side. Notion owns this document: restore the vault copy ` +
          `to the version this sync wrote (it is in the vault's git history) and the next tick ` +
          `will bring Notion's current version in.`,
        );
        continue;
      }

      // The base hash is still the push-shaped render, because that is what the
      // apply engine re-checks at approval time (`docRenderHash(rendered) !==
      // proposal.baseMdHash`) — a different function here would make every approval
      // read as stale. It is a value to carry, not a decision to make.
      let rendered: RenderedDoc;
      try {
        rendered = await deps.renderDoc(vaultPath);
      } catch (err) {
        errored += 1;
        console.error(
          `notion-sync: transcripts: ${vaultPath} could not be rendered for a base hash: ` +
          `${errorMessage(err)} — nothing proposed`,
        );
        continue;
      }
      baseMdHash = docRenderHash(rendered);

      proposedBody = transcriptBody(row.title, markdown);
      // The "before" side of the preview is the file as it stands on disk, minus its
      // frontmatter — the exact half an approved update replaces. No canonicalisation
      // dance is needed here (unlike the desk pull's): both sides of this diff are
      // verbatim Notion markdown under a synthesised H1, so they are already in the
      // same shape and every reported line is a real change.
      before = splitFrontmatter(source).body;
    }

    if (EXPIRING_MEDIA.test(markdown)) {
      mediaDeferred += 1;
      console.warn(
        `notion-sync: transcripts: ${vaultPath} carries a Notion-signed media URL that expires ` +
        `within the hour (spec §4.4) — the note is still proposed; the image will need the Notion page`,
      );
    }

    if (opts.dryRun) {
      // Claimed in the dry-run branch too (review round 1): the runbook sends an
      // operator here precisely because it prints every skip with its reason, and
      // the in-tick claim is the ONLY way the "two meetings slug to the same
      // filename" skip can be discovered. Without it a preview reported 2 proposed /
      // 0 skipped for a tick that would really do 1 and 1.
      claimedBy.set(vaultPath, row.pageId);
      superseded += open.length;
      proposed += 1;
      continue;
    }

    // Supersede first: an open proposal for this page describes content Notion has
    // moved on from. For a retitle before approval it may also sit at a DIFFERENT
    // path than the one being proposed now, which the per-path unique index cannot
    // collapse on its own.
    for (const stale of open) {
      superseded += 1;
      await tryRecord("supersede", row.pageId, () => deps.setProposalState(stale.id, "superseded"));
    }

    // The row has to exist before the proposal does. It is where a DECLINE is
    // recorded (`notion_hash`), and the attendee pass only writes a row for a
    // meeting it filled or flagged — so a meeting whose Attendees was already set
    // has no row at all, and a rejected create would have nowhere to be remembered
    // and would be proposed again on the next tick, and the next.
    //
    // NOT contained by tryRecord (review round 1): a contained failure here would
    // let the proposal be raised anyway, against a page with no row — and
    // `recordNotionAccounted` was an UPDATE, so the decline would match zero rows,
    // "succeed", close the proposal, and re-ask on the next tick. The whole contract
    // this branch exists to honour turned on one write that was allowed to fail
    // quietly. So: if the row cannot be made, this meeting is not proposed this
    // tick. Nothing is lost — the next tick tries again from the top.
    try {
      await deps.ensureMeetingRow(row.pageId);
    } catch (err) {
      bookkeepingFailed += 1;
      console.error(
        `notion-sync: transcripts: could not create the state row for ${row.pageId}: ` +
        `${errorMessage(err)} — not proposing ${vaultPath}, because a decision about it ` +
        "would have nowhere to be recorded",
      );
      continue;
    }

    proposed += 1;
    await tryRecord("propose", row.pageId, async () => {
      await deps.insertProposal({
        vaultPath,
        notionPageId: row.pageId,
        proposedBody,
        baseMdHash,
        notionHash,
        // Every proposal needs a real preview: it is the only thing Bendik sees
        // before tapping. For a create the "before" side is empty, so this reads as
        // a `+`-prefixed head of the new file, which is exactly what it is.
        diffPreview: diffPreview(before, proposedBody),
        kind: isCreate ? "create" : "update",
      });
      // Claimed only once the proposal REALLY exists (review round 2). Set any
      // earlier — before the dry-run return, or before the ensure below it — and a
      // second meeting slugging to the same path is told "another meeting already
      // has an open proposal for that exact path" when none was raised.
      claimedBy.set(vaultPath, row.pageId);
    });

    // NO PING (spec §20.4, ORB-38): Saga polls the proposals table and opens the DM
    // with the buttons. Pinging here as well would tell him the same thing twice on
    // two surfaces, and a proposal nobody answers is already covered better, by the
    // stale-proposal escalation the pull pass runs.
    console.log(
      `notion-sync: transcripts: proposed ${isCreate ? "NEW FILE" : "an edit to"} ${vaultPath}` +
      `${open.length === 0 ? "" : " (supersedes an earlier proposal)"} — awaiting Bendik's decision`,
    );
  }

  // One ping per tick, after the loop (ORB-155, decision 3; restored, scoped to the
  // backlog, LAR-30 follow-up). Everything gathered here is OLDER than
  // UNMAPPED_PAGE_WARNING_DAYS — a recent unmapped meeting already got its own named
  // ping, above. The fact worth telling a human about a fortnight-old-or-older gap is
  // "this project has no mapping", which is one config line however many meetings it
  // silently swallowed; naming each of them individually would be dozens of threads
  // for a backlog nobody is about to work through meeting by meeting today.
  if (unmappedProjects.size > 0) {
    const named = [...unmappedProjects]
      .map((p) => (p === null ? "(no Project set)" : `"${p}"`))
      .sort()
      .join(", ");
    await ping(
      `notion-sync: transcripts are being skipped because their Notion Project is not mapped: ` +
      `${named}. Those meetings' notes are not reaching the vault at all — add the mapping to ` +
      `transcripts.projects (and a matching deskDirs entry excluding "${opts.dir}"), or retag ` +
      `the meetings in Notion.`,
      { key: "unmapped-project", severity: "warn" },
    );
  }

  return {
    scanned: meetings.length,
    read,
    unchanged,
    proposed,
    superseded,
    awaitingApproval,
    awaitingDecline,
    errored,
    mediaDeferred,
    bookkeepingFailed,
    skipped,
    summary:
      `${read} read, ${unchanged} unchanged, ${proposed} proposed, ` +
      `${superseded} superseded, ${awaitingApproval} awaiting approval, ` +
      `${awaitingDecline} awaiting decline, ${skipped.length} skipped, ${errored} errored, ` +
      `${mediaDeferred} with deferred media, ${bookkeepingFailed} bookkeeping-failed, ` +
      `${meetings.length} scanned${opts.dryRun ? " (dry-run)" : ""}`,
  };
}
