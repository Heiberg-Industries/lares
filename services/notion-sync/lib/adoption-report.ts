// T5 (Phase 4, ORB-39): the adoption report — plan decision 2. Phase 3 swept 32
// meeting-transcript files into Notion by accident; earlier Phase 4 tasks carved
// them out of the sync scope and retired the bad Notion pages, but the 32 vault
// files themselves were left exactly as they were. This engine answers ONE
// question — "for each of the 50 Meetings rows, which (if any) of those 32 files
// is plainly the same meeting?" — and answers it as a REPORT. It decides nothing.
//
// "Report only. Zero writes. Bendik rules; adoption is a follow-up task, not this
// one" (plan decision 2). That is not a policy this engine chooses to follow — it
// is a property of its TYPE. AdoptionReportDeps below has exactly two members,
// both reads (a Notion query, a file listing), and neither returns anything this
// engine could hand to a write call even if it wanted to: no page id paired with a
// write function, no createVaultFile/writeVaultFile, no store handle. A future
// call site cannot wire this engine to a write by mistake, because there is no
// write-shaped dependency slot to put one in. tests/adoption-report.test.ts pins
// this by scanning this file's own source for every write-capable import this
// service owns (T3's precedent, `archive-excluded.ts`'s forbidden-import test) —
// the filesystem module, the adapter that writes a vault file (it shells out to
// git, so the module it uses to launch that subprocess is forbidden too), the
// Notion HTTP adapter. tests/cli.test.ts pins the WRAPPER the same way T3's review demanded
// after its first version scanned only the engine: a dynamic proof that
// `runAdoptionReportOnce` (cli.ts) touches neither the vault nor Notion's write
// endpoints, because cli.ts itself legitimately writes files for other commands
// and a source scan of the whole file would prove nothing.
//
// Read-only means no dry-run/live split (T5 brief) — there is only one mode, and
// no `--no-dry-run` exists for this command.
//
// Vendor-neutral and pure in the same sense as archive-excluded.ts/transcript-
// sync.ts: every side effect arrives as an injected dep, ordering is deterministic
// (sorted throughout), and this file imports no adapter — `AdoptionMeetingRow`
// below is a structural echo of the Notion HTTP adapter's own `NotionMeetingRow`
// (and of transcript-sync.ts's own `TranscriptMeetingRow`), declared fresh rather
// than imported, for the reason transcript-sync.ts's header gives for doing the
// same thing: the engine may not import the adapters, and a second pure engine's
// row type is not this one's to depend on either — two engines that happen to
// want the same four fields today are not the same engine tomorrow.
//
// The one thing this file DOES import at runtime, deliberately: `transcriptSlug`
// and `transcriptDate` from transcript-sync.ts (T4). The brief is explicit that
// these should be reused, not reinvented — they already handle the vault's real
// mess (æøå transliterated before NFD, byte-length caps, `&`/em-dash/quote
// collapsing) — and reusing them means a vault filename this report parses and a
// vault filename T4 itself WRITES are guaranteed to slug identically, because they
// run through the same function. Both are pure, side-effect-free string
// transforms; importing them pulls in no write capability (see the forbidden-
// import test's own comment for why this is safe despite the source-scan
// technique it uses).
import { transcriptSlug, transcriptDate } from "./transcript-sync.js";

/**
 * One Meetings row as this engine needs it — pageId/title/project/startsAt, the
 * same four fields transcript-sync.ts's `TranscriptMeetingRow` carries, because
 * both engines are reading the same Notion database for the same purpose (identify
 * a meeting). Assignable straight from the Notion HTTP adapter's own
 * `NotionMeetingRow` at the composition root, with no mapping layer in between.
 */
export interface AdoptionMeetingRow {
  pageId: string;
  /** The `Meeting Title` property. */
  title: string;
  /** The `Project` select. Carried through to the report for context only — matching never uses it. */
  project: string | null;
  /** When the meeting started, as the adapter derives it (ORB-155). */
  startsAt: string | null;
}

/**
 * Why a (meeting, file) pairing was judged plausible, ordered strongest to
 * weakest — only to say, per candidate, what kind of evidence it is so Bendik can
 * judge it themselves (T5 brief: "state your matching rules... so Bendik can
 * judge the matcher, not just its output").
 *
 * - "page-id": the filename embeds this meeting's own Notion page id. Exact, and
 *   GROUND TRUTH, not merely "strictly better than fuzzy" (T5 brief) — Notion's
 *   own id is not a hypothesis to be weighed against a fuzzy edge (fix round 1,
 *   Important 2). `peelSafePageIdMatches` below is what makes that true in code:
 *   a page-id pairing is settled Confident on its own terms and never gets
 *   dragged into an unrelated Ambiguous group just because ONE of its two nodes
 *   also has a weak fuzzy neighbour elsewhere. The one case it is NOT settled
 *   unilaterally is when the SAME meeting also fuzzy-matches a DIFFERENT file —
 *   see that function's own comment for why that has to stay Ambiguous (the
 *   brief's own two-files-one-meeting fixture is exactly this shape).
 * - "date-title": the filename's leading date and its title slug both agree with
 *   the meeting's Date and title, exactly.
 * - "title-only": the title slug agrees, but at least one side has no date to
 *   corroborate it with. Weaker — and NEVER placed in the bucket meant to be
 *   skimmed and trusted without opening a file (fix round 1, Critical). See
 *   `AdoptionReportResult.titleOnly`.
 */
export type MatchBasis = "page-id" | "date-title" | "title-only";

/** A vault filename, taken apart into the pieces matching cares about. */
export interface ParsedVaultFile {
  vaultPath: string;
  /** `YYYY-MM-DD` parsed from a leading date in the filename, or null when absent. */
  date: string | null;
  /** The comparable slug of whatever text is left after date/id/time noise is stripped. */
  titleSlug: string;
  /** A 32-hex Notion page id embedded in the filename, lowercased, or null. */
  pageIdHex: string | null;
}

/** One edge in the candidate graph: this meeting and this file could plausibly be the same thing. */
export interface MatchCandidate {
  pageId: string;
  title: string;
  vaultPath: string;
  basis: MatchBasis;
  /** Human-readable "why this matched" — printed verbatim, so Bendik never has to open a file to judge it. */
  reason: string;
}

/**
 * One meeting resolved to exactly one file, and vice versa — the shape both the
 * Confident bucket and the (fix round 1) title-only bucket carry. `basis` says
 * which: `confident` entries are always "page-id" or "date-title"; `titleOnly`
 * entries are always "title-only". Kept as one shape rather than two so a caller
 * (the CLI's print loop) has one row format to render regardless of which array
 * it came from — the ARRAY the entry lives in is what carries the trust level,
 * not a field a reader could overlook.
 */
export interface ResolvedMatch {
  pageId: string;
  title: string;
  date: string | null;
  project: string | null;
  vaultPath: string;
  basis: MatchBasis;
  reason: string;
}

/** A meeting as it appears inside an ambiguous group — the same shape an unmatched meeting carries. */
export interface AmbiguousMeetingRef {
  pageId: string;
  title: string;
  date: string | null;
  project: string | null;
}

/**
 * Bucket 2: every meeting and every file connected by AT LEAST ONE plausible
 * pairing, when that connected set has more than one meeting or more than one
 * file. Covers both directions the brief names — one meeting with two candidate
 * files (the "same meeting in two files" case) and, symmetrically, one file that
 * two meetings could plausibly claim — under a single shape, because a reader
 * ruling on one is ruling on the other.
 */
export interface AmbiguousGroup {
  meetings: AmbiguousMeetingRef[];
  vaultPaths: string[];
  /** Every edge inside this group, so Bendik can see why EACH candidate matched, not just that it did. */
  candidates: MatchCandidate[];
}

/** Bucket 3a: a Meetings row with no plausible file at all. */
export interface UnmatchedMeeting {
  pageId: string;
  title: string;
  date: string | null;
  project: string | null;
}

/** Bucket 3b: a vault file with no plausible Meetings row. Carries the PARSED reading, not just the path,
 *  so Bendik can see how the matcher read the filename even though nothing matched it. */
export interface UnmatchedFile {
  vaultPath: string;
  parsedDate: string | null;
  parsedTitleSlug: string;
  /**
   * A 32-hex Notion page id this filename embeds, if any — present here means the
   * token was SEEN but matched no Meetings row (fix round 1, Minor). That is a
   * different and more informative signal than "no id at all": it usually means
   * the Notion page this file came from was later deleted, or moved out of the
   * Meetings database, and is worth telling Bendik rather than folding into the
   * same bucket as a file that never had an id to begin with.
   */
  parsedPageIdHex: string | null;
}

export interface AdoptionReportDeps {
  /** Every Meetings row, read-only — the Notion HTTP adapter's `queryMeetings`, the same read the attendee
   *  and transcript passes make. No store dependency: this is a point-in-time comparison, not a sync pass,
   *  and nothing about it needs to know what a prior tick already did (T5 brief's own "Read before writing"
   *  list names only the Notion adapter and the vault file walkers — the store is deliberately not among them). */
  queryMeetings: () => Promise<AdoptionMeetingRow[]>;
  /** Every vault file under the configured transcript folders, as a vault-root-relative path
   *  ("zero7/transcripts/2026-03-25-kristiania-maida.md") — the composition root's job (cli.ts), which
   *  knows `transcripts.projects` and can walk each one; this engine only ever sees the flat, resolved list. */
  listVaultFiles: () => Promise<string[]>;
}

export interface AdoptionReportResult {
  totalMeetings: number;
  totalVaultFiles: number;
  /** Skim-and-trust: exact page-id, or exact date+title with no competing candidate. */
  confident: ResolvedMatch[];
  /**
   * (Fix round 1, Critical) A unique pairing whose ONLY evidence is a title-slug
   * match with no date on either side to corroborate it — same shape as
   * `confident`, but deliberately a SEPARATE array rather than a `basis` field
   * inside `confident` a reader could skim past. A matcher can honestly produce a
   * false positive here (a coincidentally-similar-titled, wholly unrelated file —
   * proven live against this engine, see the fix-round-1 report), so this bucket
   * is "needs a quick look", never "trust without opening the file".
   */
  titleOnly: ResolvedMatch[];
  ambiguous: AmbiguousGroup[];
  unmatchedMeetings: UnmatchedMeeting[];
  unmatchedFiles: UnmatchedFile[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Filename parsing
// ---------------------------------------------------------------------------

/**
 * A 32-hex Notion page id, trailing the stem after a space or hyphen — the shape
 * every real example in the T5 brief uses ("...13 00 382cc987b45780c38dfbf6ad2a
 * 8e32ad", double space and all: the separator group consumes exactly one
 * character, so a second stray space simply stays in the text the caller trims).
 * `.*?` is lazy and the whole pattern is anchored at `$`, so this always finds the
 * LAST such run — the only one that can exist, since a filename ends once.
 */
const TRAILING_PAGE_ID = /^(.*?)[\s-]([0-9a-f]{32})$/i;

/**
 * The degenerate case `TRAILING_PAGE_ID` cannot reach (fix round 1, Minor): that
 * pattern requires a separator BEFORE the id, so a filename that is nothing but
 * the bare id (no title, no date — e.g. an export saved before Notion ever filled
 * in a title) has no character left for the separator to consume. Probably moot
 * against the real 32, cheap to cover.
 */
const BARE_PAGE_ID = /^[0-9a-f]{32}$/i;

/** A leading `YYYY-MM-DD`, T4's own tidy shape — followed by a separator or the end of the string. */
const LEADING_DATE = /^(\d{4}-\d{2}-\d{2})(?:[\s-]+|$)/;

/**
 * The raw Notion-export time marker, e.g. "@Today 13 00" or (an observed real
 * example) "@Today 10" with no minutes at all. Optional minute group, so both
 * shapes match; the leading `\s*` absorbs the space that joins it to the title.
 */
const TODAY_TIME_SUFFIX = /\s*@Today\s+\d{1,2}(?:[\s:]\d{2})?\s*$/i;

/**
 * A hand-tidied filename's own trailing time-of-day fragment — the T5 brief's
 * two-files-one-meeting example: an already-slugged name ending "...-12-00.md"
 * sitting alongside the same meeting's raw export. Deliberately narrow (exactly
 * two 1-2-digit groups) rather than "any trailing digits", so a title that
 * genuinely ends in a number (a quarter, a
 * year) is not silently mistaken for a clock. Named risk, not a blind spot: a
 * title that legitimately ends "...-12-25" (say, a date written as month-day)
 * would still be stripped here. Acceptable because this function only ever
 * WEAKENS a match into "title-only" or removes one candidate from a REPORT a
 * human reads before anything is written — see this file's header on the
 * consequence of a wrong report versus a wrong write.
 */
const TRAILING_HHMM = /[\s-](\d{1,2})[\s-](\d{2})$/;

/**
 * Takes a vault filename apart into the pieces `matchReason` compares. Every
 * comparison this engine makes is on VALUES this function returns — never on the
 * raw path — which is what makes "normalise for comparison only, never on disk"
 * (T5 brief) a property of the code rather than a discipline to remember: nothing
 * downstream of this function ever sees the original bytes.
 *
 * Order matters and mirrors how the real names are built (T4's own convention,
 * and the raw Notion export shape the brief documents): a trailing page id is
 * stripped first (it is the most specific token — 32 hex characters cannot be
 * mistaken for anything else), then a leading date, then a trailing time
 * marker in either of the two shapes the vault actually contains.
 */
export function parseVaultFilename(vaultPath: string): ParsedVaultFile {
  const basename = vaultPath.split("/").pop() ?? vaultPath;
  // NFC, for comparison only — never written back anywhere. The box is Linux and
  // Bendik's clone is macOS; the same logical filename can arrive as different
  // bytes (NFC vs NFD) depending which machine listed it, and every later
  // comparison in this file (titleSlug via transcriptSlug, and this string itself)
  // has to agree regardless of which one handed it to us (T5 brief).
  const stem = basename.replace(/\.md$/i, "").normalize("NFC");

  let pageIdHex: string | null = null;
  let rest = stem;
  if (BARE_PAGE_ID.test(stem)) {
    pageIdHex = stem.toLowerCase();
    rest = "";
  } else {
    const idMatch = TRAILING_PAGE_ID.exec(stem);
    if (idMatch) {
      pageIdHex = idMatch[2].toLowerCase();
      rest = idMatch[1].trimEnd();
    }
  }

  let date: string | null = null;
  const dateMatch = LEADING_DATE.exec(rest);
  if (dateMatch) {
    date = dateMatch[1];
    rest = rest.slice(dateMatch[0].length);
  }

  rest = rest.replace(TODAY_TIME_SUFFIX, "").trimEnd();
  rest = rest.replace(TRAILING_HHMM, "").trimEnd();

  // transcriptSlug (T4) does the rest: lowercasing, æøå→ae/oe/aa before NFD,
  // collapsing "&"/em-dash/comma/whitespace runs into single hyphens, byte-capping
  // a pathological title. Reused rather than reinvented (T5 brief) — and because
  // it is idempotent on an already-slugged string (a hyphen run collapses to the
  // same single hyphen), it is the ONE function for both the tidy `<date>-<slug>`
  // shape (where `rest` is already a slug) and the raw export shape (where `rest`
  // is still a human title) — this function does not need to know which one it was
  // handed.
  return { vaultPath, date, titleSlug: transcriptSlug(rest), pageIdHex };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Notion page ids appear dashed (API responses) or bare (filenames) — compared as lowercase hex only. */
function normalizePageIdHex(pageId: string): string {
  return pageId.replace(/-/g, "").toLowerCase();
}

/**
 * Is this (meeting, file) pair plausible, and on what evidence? Returns the
 * STRONGEST single reason — never more than one basis per pair, so a pairing that
 * happens to satisfy two rules is not double-counted as two edges in the graph
 * below.
 *
 * Deliberately does NOT treat "the dates agree but the titles don't" as a
 * candidate at all: many meetings can share a calendar day, so a bare date match
 * is noise, not evidence, and the brief only ever asks for "date + title"
 * together or "title alone" — never "date alone".
 */
function matchReason(meeting: AdoptionMeetingRow, file: ParsedVaultFile): { basis: MatchBasis; reason: string } | null {
  const meetingIdHex = normalizePageIdHex(meeting.pageId);
  if (file.pageIdHex !== null && file.pageIdHex === meetingIdHex) {
    return { basis: "page-id", reason: `the filename embeds this meeting's Notion page id (${file.pageIdHex})` };
  }

  // NFC first — same reason `parseVaultFilename` normalises the file side (fix
  // round 1, Important): Notion's API has no documented normal-form guarantee,
  // and `transcriptSlug` is NOT normalisation-agnostic on its own — verified live
  // against this engine: `transcriptSlug(NFC "Åsa")` transliterates å→"aa" and
  // produces "aasa", but `transcriptSlug(NFD "Åsa")` never sees the precomposed
  // "å" codepoint TRANSLITERATE keys on (NFD spells it as bare "a" plus a
  // separate combining ring), so the combining mark is simply stripped and the
  // result is "asa" — one fewer "a", a different slug for the identical name. A
  // meeting titled "Åsa Check-in" arriving from Notion in NFD would then fail to
  // match a correctly-NFC'd vault file of the same meeting. Without this line
  // only the FILE side was normalised, which is half the fix and fails exactly
  // this case (the brief's own real Åsa file makes this non-hypothetical).
  const meetingSlug = transcriptSlug(meeting.title.normalize("NFC"));
  // An untitled meeting or an unreadable filename has nothing to compare — never a
  // candidate on title grounds (and two empty slugs must not "agree" with each other).
  if (meetingSlug === "" || file.titleSlug === "") return null;
  const meetingDate = transcriptDate(meeting.startsAt);

  if (file.date !== null && meetingDate !== null) {
    // Both sides carry a date: the strong, corroborated case, and it earns the
    // STRICTER comparison below — exact slug equality only, no prefix fuzz. A
    // dated file is, by construction, either T4's own `${date}-${transcriptSlug
    // (title)}.md` (nothing appended after the slug) or a hand-tidied name meant
    // to look that way — either way a genuine match has no legitimate reason to
    // differ by more than the slug itself.
    if (file.date === meetingDate && file.titleSlug === meetingSlug) {
      return { basis: "date-title", reason: `date ${meetingDate} and title slug "${meetingSlug}" both match exactly` };
    }
    // A similar-looking title on a DIFFERENT date is stronger evidence of "a
    // different meeting, coincidentally similar name" than it is evidence of
    // sameness — never a candidate, whatever the titles look like.
    return null;
  }

  // At least one side has no date to corroborate with, so title is the only
  // signal available — and it is allowed to be looser here (agreement OR one
  // slug being the other plus a "-something" tail), specifically for the T5
  // brief's own two-files-one-meeting example: an already-slugged filename that
  // kept a trailing time fragment TRAILING_HHMM did not (or could not) strip
  // cleanly in every phrasing. Tightening this to exact equality would silence
  // exactly the ambiguity (two files, one meeting) the brief requires this
  // engine to surface.
  const titleAgrees =
    file.titleSlug === meetingSlug
    || file.titleSlug.startsWith(`${meetingSlug}-`)
    || meetingSlug.startsWith(`${file.titleSlug}-`);
  if (!titleAgrees) return null;

  const reason = file.date === null && meetingDate === null
    ? `title slug "${meetingSlug}" matches; neither side carries a date to corroborate it`
    : file.date === null
      ? `title slug "${meetingSlug}" matches; the filename carries no date to corroborate the meeting's ${String(meetingDate)}`
      : `title slug "${meetingSlug}" matches; the meeting carries no Date property to corroborate the filename's ${file.date}`;
  return { basis: "title-only", reason };
}

// ---------------------------------------------------------------------------
// Ground truth — page-id matches, resolved before any grouping runs
// ---------------------------------------------------------------------------

/**
 * Peels off page-id pairings that are safe to settle as Confident on their own,
 * BEFORE the fuzzy candidate graph is grouped at all (fix round 1, Critical +
 * Important 2).
 *
 * The naive fix — "a page-id match is ground truth, so remove both nodes from
 * the graph before grouping runs" — is WRONG, and it is wrong in a way that
 * silently breaks the brief's own two-files-one-meeting fixture. Two adversarial
 * cases pin the exact rule, both executed against this engine during review:
 *
 *   1. (The bug this function fixes.) Meeting M2 has its OWN page-id file F2,
 *      and SEPARATELY fuzzy-matches an unrelated file F1 that a DIFFERENT
 *      meeting M1 also matches (by exact title). Plain union-find merges all
 *      four into one Ambiguous group, burying M2's page-id evidence inside noise
 *      that has nothing to do with it. F2 is uncontested (nothing else points to
 *      it) — M2's stray fuzzy edge to F1 is the noise, not F2.
 *
 *   2. (Why "just remove every page-id pair" breaks fixture 1 of the green bar.)
 *      Meeting M has its OWN page-id file (the raw Notion export) AND a SECOND,
 *      genuinely-plausible file (a hand-tidied duplicate with no date and no id —
 *      the brief's own "same meeting in two files" example). If M is removed
 *      from consideration the instant its page-id match is found, the second
 *      file has nothing left to connect to and quietly becomes "unmatched" — the
 *      exact silent loss of a real duplicate the brief says must never happen.
 *
 * The rule that gets both right: a page-id pairing (M, F) is safe to extract
 * only when F has no OTHER meeting connected to it (trivially true in practice —
 * a page id belongs to one meeting), AND every OTHER file M is fuzzy-connected to
 * has some OTHER meeting that could also claim it. Case 1: F2's only neighbour is
 * M2 (safe on F2's side); M2's other neighbour F1 already has M1 attached, so
 * removing M2 does not strand F1 — safe. Extracted. Case 2: M's other neighbour
 * (the duplicate file) has NO other meeting attached at all — removing M would
 * strand it. NOT safe. Left in the graph, where it groups into an Ambiguous pair
 * with both candidates shown.
 *
 * Runs to a fixpoint rather than one pass, because peeling one meeting can make a
 * SECOND one safe (a file that looked contested loses its only other contender
 * once that contender is settled elsewhere). A useful corollary, proved in this
 * file's own tests rather than merely asserted: after this function returns,
 * `remaining` can no longer contain a page-id edge that stands alone as a
 * meeting's only edge to a file with no other neighbour — if it could, this loop
 * would have extracted it. So a 1-meeting/1-file group found later, downstream,
 * can only ever be "date-title" or "title-only" — never "page-id" arriving
 * unresolved. `runAdoptionReport` relies on that rather than re-checking it.
 */
function peelSafePageIdMatches(
  edges: MatchCandidate[],
): { extracted: MatchCandidate[]; remaining: MatchCandidate[] } {
  let remaining = edges;
  const extracted: MatchCandidate[] = [];

  for (;;) {
    const fileDegree = new Map<string, number>();
    const edgesByMeeting = new Map<string, MatchCandidate[]>();
    for (const edge of remaining) {
      fileDegree.set(edge.vaultPath, (fileDegree.get(edge.vaultPath) ?? 0) + 1);
      const list = edgesByMeeting.get(edge.pageId);
      if (list) list.push(edge); else edgesByMeeting.set(edge.pageId, [edge]);
    }

    const safe = remaining.find((edge) => {
      if (edge.basis !== "page-id") return false;
      if ((fileDegree.get(edge.vaultPath) ?? 0) !== 1) return false; // F contested — not safe
      const othersFromSameMeeting = (edgesByMeeting.get(edge.pageId) ?? []).filter((e) => e !== edge);
      // Every OTHER file this meeting touches must have some OTHER meeting able
      // to claim it once this one is gone — otherwise removing this meeting stands
      // that file up as an orphan (case 2 above).
      return othersFromSameMeeting.every((other) => (fileDegree.get(other.vaultPath) ?? 0) >= 2);
    });
    if (safe === undefined) break;

    extracted.push(safe);
    // The WHOLE meeting is settled, not just this one edge — its other (fuzzy)
    // edges are dropped too, because a meeting Notion has already identified by
    // id is not still "looking" for a file via a weaker signal.
    remaining = remaining.filter((edge) => edge.pageId !== safe.pageId);
  }

  return { extracted, remaining };
}

// ---------------------------------------------------------------------------
// Grouping — connected components over what's LEFT after peelSafePageIdMatches
// ---------------------------------------------------------------------------

/**
 * Plain union-find over string keys. Why a graph at all, rather than "does this
 * meeting have exactly one candidate": a meeting can genuinely have TWO
 * candidate files by two different (fuzzy) bases — the brief's own two-files-
 * one-meeting fixture, once the SAFE page-id extractions above have already
 * removed the pairings that were never really in question. Union-find is what
 * turns "everyone touching this ambiguity, however they're connected" into one
 * order-independent group instead of a pairwise patchwork that could report the
 * same file twice under two different meetings.
 */
class UnionFind {
  private readonly parent = new Map<string, string>();

  private find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root) as string;
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur) as string;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  rootOf(x: string): string {
    return this.find(x);
  }
}

/** Node-key prefixes, so a meeting pageId and a vaultPath can never collide inside the same UnionFind. */
const meetingKey = (pageId: string): string => `m:${pageId}`;
const fileKey = (vaultPath: string): string => `f:${vaultPath}`;

/** One connected component of the candidate graph — every meeting and file reachable from each other. */
interface Component {
  meetingIds: Set<string>;
  filePaths: Set<string>;
  edges: MatchCandidate[];
}

/** Groups `edges` into connected components via `UnionFind`. Used once, over whatever `peelSafePageIdMatches`
 *  left behind — the settled page-id pairings it extracted never reach here at all. */
function groupByComponent(edges: MatchCandidate[]): Component[] {
  const uf = new UnionFind();
  for (const edge of edges) uf.union(meetingKey(edge.pageId), fileKey(edge.vaultPath));

  const byRoot = new Map<string, Component>();
  for (const edge of edges) {
    const root = uf.rootOf(meetingKey(edge.pageId));
    let component = byRoot.get(root);
    if (component === undefined) {
      component = { meetingIds: new Set(), filePaths: new Set(), edges: [] };
      byRoot.set(root, component);
    }
    component.meetingIds.add(edge.pageId);
    component.filePaths.add(edge.vaultPath);
    component.edges.push(edge);
  }
  return [...byRoot.values()];
}

/** One resolved (meeting, file) edge, rendered as a `ResolvedMatch` row — shared by both the Confident
 *  and title-only buckets, whichever array the caller pushes the result into. */
function toResolvedMatch(edge: MatchCandidate, meetingByPageId: Map<string, AdoptionMeetingRow>): ResolvedMatch {
  const meeting = meetingByPageId.get(edge.pageId);
  return {
    pageId: edge.pageId,
    title: edge.title,
    date: transcriptDate(meeting?.startsAt ?? null),
    project: meeting?.project ?? null,
    vaultPath: edge.vaultPath,
    basis: edge.basis,
    reason: edge.reason,
  };
}

/**
 * `notion-sync adoption-report` (T5): matches the pre-existing vault transcripts
 * against Notion's Meetings rows and reports — Confident / title-only / Ambiguous
 * / Unmatched — so Bendik can rule on adoption. Writes nothing; see this file's
 * header for how that is structural rather than a promise.
 */
export async function runAdoptionReport(deps: AdoptionReportDeps): Promise<AdoptionReportResult> {
  const meetings = [...await deps.queryMeetings()].sort((a, b) => (a.pageId < b.pageId ? -1 : 1));
  const files = [...await deps.listVaultFiles()].sort().map(parseVaultFilename);

  const meetingByPageId = new Map(meetings.map((m) => [m.pageId, m]));

  // Every plausible pairing, meetings × files. 50 × 32 in production — trivial
  // either way, and this engine runs on demand, never on a tick.
  const edges: MatchCandidate[] = [];
  for (const meeting of meetings) {
    for (const file of files) {
      const match = matchReason(meeting, file);
      if (match !== null) {
        edges.push({ pageId: meeting.pageId, title: meeting.title, vaultPath: file.vaultPath, ...match });
      }
    }
  }
  edges.sort((a, b) => (a.vaultPath === b.vaultPath ? (a.pageId < b.pageId ? -1 : 1) : (a.vaultPath < b.vaultPath ? -1 : 1)));

  // Matched/unmatched is decided from the FULL edge set, before page-id peeling —
  // peeling only ever relocates an edge's endpoints between confident/title-only/
  // ambiguous, it never removes a meeting or file that had a candidate at all.
  const matchedMeetingIds = new Set(edges.map((e) => e.pageId));
  const matchedFilePaths = new Set(edges.map((e) => e.vaultPath));

  // Ground truth first (fix round 1) — see peelSafePageIdMatches's own comment
  // for the two adversarial cases that pin exactly what "safe" has to mean here.
  const { extracted, remaining } = peelSafePageIdMatches(edges);

  const confident: ResolvedMatch[] = extracted.map((edge) => toResolvedMatch(edge, meetingByPageId));
  const titleOnly: ResolvedMatch[] = [];
  const ambiguous: AmbiguousGroup[] = [];

  for (const component of groupByComponent(remaining)) {
    const vaultPaths = [...component.filePaths].sort();
    const candidates = component.edges
      .slice()
      .sort((a, b) => (a.vaultPath === b.vaultPath ? (a.pageId < b.pageId ? -1 : 1) : (a.vaultPath < b.vaultPath ? -1 : 1)));

    if (component.meetingIds.size === 1 && vaultPaths.length === 1) {
      // "No competing candidate" (T5 brief) — one meeting, one file, connected by
      // exactly the one edge that put them in this component. Its basis can only
      // be "date-title" or "title-only" here: any lone, uncontested page-id edge
      // was already extracted above (see peelSafePageIdMatches's own closing
      // paragraph for why that is guaranteed, not merely likely).
      const only = candidates[0];
      const entry = toResolvedMatch(only, meetingByPageId);
      if (only.basis === "date-title") confident.push(entry);
      else titleOnly.push(entry); // "title-only" — needs a quick look (fix round 1, Critical)
      continue;
    }

    const groupMeetings = [...component.meetingIds]
      .map((pageId) => {
        const meeting = meetingByPageId.get(pageId);
        return {
          pageId,
          title: meeting?.title ?? "",
          date: transcriptDate(meeting?.startsAt ?? null),
          project: meeting?.project ?? null,
        };
      })
      .sort((a, b) => (a.pageId < b.pageId ? -1 : 1));
    ambiguous.push({ meetings: groupMeetings, vaultPaths, candidates });
  }

  confident.sort((a, b) => (a.vaultPath < b.vaultPath ? -1 : 1));
  titleOnly.sort((a, b) => (a.vaultPath < b.vaultPath ? -1 : 1));
  // Deterministic print/report order: by the group's first (sorted) vault path,
  // falling back to its first meeting when a group somehow has no file (cannot
  // happen today — every edge has both a meeting and a file by construction — but
  // sorting defensively rather than assuming keeps this stable if that ever changes).
  ambiguous.sort((a, b) => {
    const ak = a.vaultPaths[0] ?? a.meetings[0]?.pageId ?? "";
    const bk = b.vaultPaths[0] ?? b.meetings[0]?.pageId ?? "";
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });

  const unmatchedMeetings: UnmatchedMeeting[] = meetings
    .filter((m) => !matchedMeetingIds.has(m.pageId))
    .map((m) => ({ pageId: m.pageId, title: m.title, date: transcriptDate(m.startsAt), project: m.project }));

  const unmatchedFiles: UnmatchedFile[] = files
    .filter((f) => !matchedFilePaths.has(f.vaultPath))
    // parsedPageIdHex rides along even here (fix round 1, Minor): a file whose
    // name embeds an id-shaped token that matched NO Meetings row is a different,
    // more informative signal than a file that never had one — usually the
    // Notion page it once pointed at is gone.
    .map((f) => ({ vaultPath: f.vaultPath, parsedDate: f.date, parsedTitleSlug: f.titleSlug, parsedPageIdHex: f.pageIdHex }))
    .sort((a, b) => (a.vaultPath < b.vaultPath ? -1 : 1));

  // Defence in depth, same posture as archive-excluded's "matched EVERY row"
  // guard: every meeting and every file is, by construction, in EXACTLY one of
  // {confident, title-only, some ambiguous group, unmatched} — a bug in the
  // peeling or grouping above (double-counting a node, or dropping one) would
  // otherwise ship a report whose own numbers contradict each other, which the
  // brief calls worse than no report at all. Checked here, once, rather than
  // trusted.
  const ambiguousMeetings = ambiguous.reduce((sum, g) => sum + g.meetings.length, 0);
  const ambiguousFiles = ambiguous.reduce((sum, g) => sum + g.vaultPaths.length, 0);
  const meetingsAccounted = confident.length + titleOnly.length + ambiguousMeetings + unmatchedMeetings.length;
  const filesAccounted = confident.length + titleOnly.length + ambiguousFiles + unmatchedFiles.length;
  if (meetingsAccounted !== meetings.length) {
    throw new Error(
      `notion-sync: adoption-report: accounting mismatch — ${meetingsAccounted} of ${meetings.length} ` +
      "Meetings rows accounted for across confident/title-only/ambiguous/unmatched. This is a bug in the " +
      "matcher, not a real report — refusing to return one whose own counts do not add up.",
    );
  }
  if (filesAccounted !== files.length) {
    throw new Error(
      `notion-sync: adoption-report: accounting mismatch — ${filesAccounted} of ${files.length} ` +
      "vault files accounted for across confident/title-only/ambiguous/unmatched. This is a bug in the " +
      "matcher, not a real report — refusing to return one whose own counts do not add up.",
    );
  }

  const summary =
    `${meetings.length} Meetings rows, ${files.length} vault files — ` +
    `${confident.length} confident, ` +
    `${titleOnly.length} title-only match(es) (no date to confirm — worth a quick look), ` +
    `${ambiguous.length} ambiguous group(s) covering ${ambiguousMeetings} meeting(s) / ${ambiguousFiles} file(s), ` +
    `${unmatchedMeetings.length} meeting(s) with no file, ${unmatchedFiles.length} file(s) with no meeting`;

  return {
    totalMeetings: meetings.length, totalVaultFiles: files.length,
    confident, titleOnly, ambiguous, unmatchedMeetings, unmatchedFiles, summary,
  };
}
