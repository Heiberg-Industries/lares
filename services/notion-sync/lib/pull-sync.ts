// The pull direction (Phase 3 plan T5, spec §18): what Notion says about pages
// this service owns, and what to do about it. Vendor-neutral and pure in exactly
// the sense wiki-sync.ts is — every side effect arrives as an injected dep, every
// failure is contained per document, the ordering is deterministic (sorted), and
// dry-run produces the full plan with zero writes.
//
// The two things this engine must never get wrong:
//
//   1. "Notion changed" is `sha256(GET /markdown) != stored notion_hash` — NEVER a
//      timestamp comparison (spec §3). last_edited_time is only the cheap
//      pre-filter that decides whether the read is worth doing, and because Notion
//      stamps it at MINUTE granularity the filter re-reads on `>=`, not `>`.
//   2. It never merges. A mirror row's Notion-side edit is reverted from the
//      vault; a desk row's becomes a PROPOSAL a human approves; anything ambiguous
//      freezes (spec §6/§7). Nothing here deletes, and nothing here writes the
//      vault — that is runApplySync's job, after the 👍.
import {
  assertPushSafe,
} from "./translate.js";
import {
  parseNotionPage, assertPullSafe,
  type ResolvedWikiTarget,
} from "./translate-pull.js";
import {
  sha256, wikiRenderHash,
  type RemoteDocRow, type WikiDocProps,
} from "./wiki-sync.js";
import { withoutExcluded } from "./desk-scope.js";
import { vaultOwns } from "./direction.js";
import type {
  DeskRow, DocSyncedInput, FrozenDocRow, ProposalInput, ProposalRow, ProposalState,
  StaleProposalRow,
} from "./store.js";

/**
 * The push pass's property set, including the Phase 3 `Sync` stamp — the select
 * property added to the Docs DB by hand at deploy (plan decision 5), carrying the
 * mirror or desk marker.
 *
 * An alias, not an extension, since T7: the stamp moved INTO WikiDocProps when
 * the push pass started carrying it too (a created or patched desk row must land
 * stamped, not wait for the next `reconcile`). Kept as a distinct name because
 * this direction's vocabulary reads better at its own call sites, and because
 * every T5 signature already names it.
 */
export type PullDocProps = WikiDocProps;

/**
 * One vault file as the PUSH pass would send it. Produced by the composition root
 * (T7), which is the only layer that knows the dir→project mapping and the
 * per-direction `sync` stamp — putting that config lookup in the engine would be
 * exactly the deployment-specific knowledge the neutrality rule keeps out.
 *
 * Deliberately does NOT carry `title`/`frontmatter` next to `props`: they would be
 * the same two strings twice, and the day they disagreed every desk row would
 * read as "changed in both sides" and freeze. `props.name`/`props.frontmatter`
 * are the single source — see docRenderHash.
 */
export interface RenderedDoc {
  /** Notion-flavoured body, byte-identical to what the push pass would patch. */
  markdown: string;
  props: PullDocProps;
}

/**
 * The change-detection hash of a rendered vault file — the SAME function the push
 * pass stores as `md_hash` (wikiRenderHash over body + title + frontmatter), fed
 * from the props the push pass builds those two fields from. Any divergence here
 * would make every desk row look like a two-sided conflict.
 */
export function docRenderHash(rendered: RenderedDoc): string {
  return wikiRenderHash({
    markdown: rendered.markdown,
    title: rendered.props.name,
    frontmatter: rendered.props.frontmatter,
  });
}

/**
 * Splits a vault file into its frontmatter BLOCK (verbatim, fences and all,
 * including whatever blank lines followed it) and the body.
 *
 * Lives here rather than in apply-sync.ts because both directions need the exact
 * same split and must never disagree: this engine uses the body as the "before"
 * side of a proposal's diff preview, and runApplySync reassembles a written file
 * as `block + proposed body`. A preview computed against a different split would
 * quietly lie about what apply is going to do.
 */
export function splitFrontmatter(source: string): { block: string; body: string } {
  const normalized = source.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") return { block: "", body: normalized };
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() !== "---") continue;
    let end = i + 1;
    // Keep the blank lines between the closing fence and the body in the block:
    // "verbatim" has to include the gap, or every apply would reflow it.
    while (end < lines.length && lines[end].trim() === "") end += 1;
    return {
      block: lines.slice(0, end).join("\n") + (end < lines.length ? "\n" : ""),
      body: lines.slice(end).join("\n"),
    };
  }
  return { block: "", body: normalized };
}

/**
 * The sha256 of a vault file's BODY — everything under the frontmatter block, with
 * the file's own final newline removed (Phase 4, T4).
 *
 * Lives beside splitFrontmatter, and for the same stated reason: two sides need the
 * exact same answer and must never disagree. The apply engine computes it over the
 * bytes it is about to write and stores it as a meetings row's `md_hash`; the
 * transcript pass computes it over the file on disk and compares. If those two ever
 * split the file differently, every transcript reads as hand-edited and retires
 * itself — so there is one function, called from both ends.
 *
 * The trailing-newline strip is what makes them line up: a proposal's body never
 * ends in whitespace (transcript-sync.ts composes it that way) and the apply engine
 * appends exactly one newline when it writes.
 */
export function vaultBodyHash(source: string): string {
  return sha256(splitFrontmatter(source).body.replace(/\s+$/, ""));
}

/** The three writes that make "the vault wins" true, in the one order they may happen in. */
export type PageWriteStep = "patch" | "props" | "read-back";

export type PageWriteOutcome =
  | { ok: true; notionHash: string }
  | { ok: false; step: PageWriteStep; error: unknown };

/** The Notion side of overwritePageFromVault — a subset of PullSyncDeps by design. */
export interface PageWriteDeps {
  patchPageMarkdown: (pageId: string, markdown: string) => Promise<void>;
  updateDocProps: (pageId: string, props: Partial<PullDocProps>) => Promise<void>;
  getPageMarkdown: (pageId: string) => Promise<string>;
}

/**
 * "The vault wins" as one unit: replace the page's body, refresh its properties,
 * then read the page back and hash what NOTION stored (spec §6).
 *
 * The ordering is the hash-after-write rule and it is load-bearing: hashing the
 * body we pushed instead of the one Notion kept makes the next tick see a phantom
 * edit, every tick, forever. Properties travel with the body because a full
 * refresh must never leave the title, frontmatter or `Sync` stamp describing the
 * previous version.
 *
 * Exported and shared (T9 fix wave) because there are now two callers that must
 * not drift: this engine's mirror revert, and `notion-sync resolve --keep md` in
 * cli.ts. It reports its failing step rather than throwing so each caller can
 * classify it in its own idiom — the engine's contained per-doc `fail`/freeze, the
 * command's loud throw — without either re-implementing the sequence.
 */
export async function overwritePageFromVault(
  pageId: string, rendered: RenderedDoc, deps: PageWriteDeps,
): Promise<PageWriteOutcome> {
  try {
    await deps.patchPageMarkdown(pageId, rendered.markdown);
  } catch (error) {
    return { ok: false, step: "patch", error };
  }
  try {
    await deps.updateDocProps(pageId, rendered.props);
  } catch (error) {
    return { ok: false, step: "props", error };
  }
  try {
    return { ok: true, notionHash: sha256(await deps.getPageMarkdown(pageId)) };
  } catch (error) {
    return { ok: false, step: "read-back", error };
  }
}

export interface PullSyncOptions {
  dryRun: boolean;
  /**
   * Has config carved this vault path out of the desk scope (`deskDirs[].exclude`)?
   * Pass `makeDeskExclusion(cfg.desks)` — there is no other correct value.
   *
   * REQUIRED, unlike every other option here, and that is the point (Phase 4,
   * plan decision 5). This pass treats a row whose Notion page has vanished as
   * "recreate the page from the vault" (handleMissingPage, for any row that is
   * not two-way), so a call site that forgot to scope its rows would recreate
   * every page a human had just deliberately deleted, on the next tick, forever.
   * A required field is the only version of this the compiler can enforce: a new
   * call site cannot compile without saying what its scope is.
   */
  isExcluded: (vaultPath: string) => boolean;
  /** Wall clock for the stale-freeze age check. Injected so tests are deterministic. */
  now?: Date;
  /** How long a freeze may sit before every tick re-pings it (spec §6). */
  staleFreezeDays?: number;
  /**
   * How long an ANNOUNCED proposal may sit undecided before it escalates to
   * #lares-alerts (spec §20.4). This is what replaced the retired per-proposal ping:
   * Saga asking is routine, Saga asking and getting no answer is not.
   */
  staleProposalHours?: number;
  /**
   * Reconciliation mode (spec §18.5, driven by `notion-sync reconcile`): read
   * EVERY synced row's page once, ignoring both the `lastEditedTime >=` timestamp
   * pre-filter and the "no baseline yet" skip.
   *
   * A flag on this engine rather than a second engine or a CLI-side loop,
   * deliberately: everything the go-live reconciliation has to do once — revert a
   * hand-edited mirror row, propose a hand-edited desk row, freeze a two-sided
   * conflict, freeze a mirror row that grew a sub-page, refuse an unsafe pull —
   * is what this engine already does every tick, and the two must never drift
   * apart. What reconcile changes is only WHICH rows are read, which is one
   * condition, so that is all it gets to change.
   */
  readAllRows?: boolean;
}

export interface PullSyncDeps {
  /** One query per tick — the pre-filter and the "is the page still there" oracle. */
  queryDocs: () => Promise<RemoteDocRow[]>;
  getDeskRows: () => Promise<Map<string, DeskRow>>;
  getFrozenDocs: () => Promise<FrozenDocRow[]>;
  /** Proposals still pending long past a decision — announced or never announced (§20.4). */
  getStaleProposals: (hours: number) => Promise<StaleProposalRow[]>;
  getOpenProposals: () => Promise<ProposalRow[]>;
  /**
   * Rejected proposals whose Notion revert runApplySync still owes. Pull needs
   * them because a rejection is NOT visible in getOpenProposals — without this the
   * next tick would re-propose the very content the human just rejected, whichever
   * order the two passes run in.
   */
  getRejectedUnexecuted: () => Promise<ProposalRow[]>;
  getPageMarkdown: (pageId: string) => Promise<string>;
  patchPageMarkdown: (pageId: string, markdown: string) => Promise<void>;
  updateDocProps: (pageId: string, props: Partial<PullDocProps>) => Promise<void>;
  createDocPage: (props: PullDocProps, markdown: string) => Promise<{ pageId: string }>;
  /** path → the push render (see RenderedDoc). Throws if the file is unreadable. */
  renderDoc: (vaultPath: string) => Promise<RenderedDoc>;
  /** Raw vault bytes — only for the diff preview; the engine never writes the vault. */
  readVaultFile: (vaultPath: string) => Promise<string>;
  /** git mv to `_archive/<path>` (spec §7). The one vault mutation pull can cause. */
  archiveVaultFile: (vaultPath: string) => Promise<void>;
  insertProposal: (input: ProposalInput) => Promise<number>;
  setProposalState: (id: number, state: ProposalState) => Promise<void>;
  upsertDocSynced: (doc: DocSyncedInput) => Promise<void>;
  updateNotionWatermark: (
    vaultPath: string, notionHash: string, notionLastEdited: string | null,
  ) => Promise<void>;
  freezeDoc: (vaultPath: string, reason: string) => Promise<void>;
  markDocOrphaned: (vaultPath: string, reason: string) => Promise<void>;
  recordDocError: (vaultPath: string, message: string) => Promise<void>;
  /** Best-effort human ping (signal-spine, or console.log when unconfigured). */
  notify: (message: string) => Promise<void>;
}

export interface PullSyncResult {
  /** Doc rows considered this tick. */
  scanned: number;
  /** Pages actually fetched (`GET /markdown`) — the cost of the tick. */
  read: number;
  /** Notion re-saved but the content hash matched: watermark moved, nothing else. */
  unchanged: number;
  reverted: number;
  proposed: number;
  superseded: number;
  /** Rows whose open proposal already covers exactly this Notion content. */
  awaitingApproval: number;
  /** Rows holding content a human rejected, waiting for apply's revert. */
  awaitingRevert: number;
  frozen: number;
  recreated: number;
  archived: number;
  skipped: number;
  errored: number;
  /** Rows re-pinged because their freeze has gone stale (spec §6). */
  stalePinged: number;
  /** Proposals escalated because Saga asked and got no answer (spec §20.4). */
  staleProposalsPinged: number;
  /** Notion outcomes that could not be recorded locally — see wiki-sync.ts. */
  bookkeepingFailed: number;
  summary: string;
}

const MIRROR_CHILD_REASON = "sub-page added under a mirror row — move it out, then resolve";
const CONFLICT_REASON = "changed in both Notion and the vault";
const DEFAULT_STALE_FREEZE_DAYS = 7;
// A day. Long enough that a normal "I'll look at it tonight" never alarms; short enough
// that an edit lost to a broken DM surfaces the next morning rather than next week.
const DEFAULT_STALE_PROPOSAL_HOURS = 24;
const DIFF_PREVIEW_LINES = 10;
const DIFF_LINE_CHARS = 100;

/**
 * Notion's own words for "you asked me to replace content that has child pages
 * under it". Matched on the message text because that is all the client surfaces
 * (notion-client.ts throws `notion PATCH ... failed: <status> <body>`), and kept
 * deliberately broad — `allow_deleting_content` is the flag we send, `child` is
 * what Notion calls the blocks it refuses to drop. A miss here is not dangerous
 * (the row takes the ordinary 3-strike path); a false positive would freeze a row
 * over a transient error, so nothing looser than these two words.
 */
const CHILD_CONTENT_ERROR = /child|allow_deleting_content/i;

/** What each step of a failed mirror revert is called in the log. */
const REVERT_STEP: Record<PageWriteStep, string> = {
  patch: "revert patch",
  props: "revert props",
  "read-back": "hash-after-write read",
};

/** UUID with or without dashes — Notion page urls carry the id last, after a slug. */
const PAGE_ID_IN_TEXT = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi;

/**
 * One comparable key for a page, whatever form it arrives in: a bare id, a dashed
 * id, or a full `https://www.notion.so/Some-Title-<id>` url. Falls back to the
 * trimmed lowercase string so a non-UUID id (a fixture, a hand-made row) still
 * matches itself.
 *
 * Exported (T7) so `notion-sync reconcile` joins its fresh `queryDocs` reading to
 * the store's rows by the SAME notion of page identity this engine uses — a
 * second, subtly different join would silently baseline the wrong rows.
 */
export function pageKey(value: string): string {
  const matches = value.match(PAGE_ID_IN_TEXT);
  if (matches !== null) return matches[matches.length - 1].replace(/-/g, "").toLowerCase();
  return value.trim().toLowerCase();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The wikilink target text for a page, computed from the store snapshot exactly
 * the way the PUSH resolver reads it back (wiki-sync.ts buildResolver): a bare
 * stem when that stem is unique, otherwise the full vault path minus `.md` —
 * which is the "with the wikiDir prefix" form buildResolver explicitly accepts.
 * So a link this engine writes into a proposed body resolves back to the same
 * page on the next push, which is what keeps a pulled file from churning.
 *
 * Built here rather than injected: the map it needs IS getDeskRows's snapshot, and
 * a second source for it could disagree with the rows this tick is reasoning about.
 *
 * Exported (T6) so `notion-sync resolve <path> --keep notion` can build the same
 * resolver from its own getDeskRows() read, one-off, without duplicating this logic.
 */
export function buildPageResolver(rows: Map<string, DeskRow>): (urlOrId: string) => ResolvedWikiTarget | null {
  const pathByPage = new Map<string, string>();
  const stemCounts = new Map<string, number>();
  for (const [vaultPath, row] of rows) {
    pathByPage.set(pageKey(row.pageId), vaultPath);
    const key = vaultPath.replace(/\.md$/i, "");
    const stem = key.split("/").pop() ?? key;
    stemCounts.set(stem, (stemCounts.get(stem) ?? 0) + 1);
  }
  return (urlOrId) => {
    const vaultPath = pathByPage.get(pageKey(urlOrId));
    if (vaultPath === undefined) return null;
    const key = vaultPath.replace(/\.md$/i, "");
    const stem = key.split("/").pop() ?? key;
    return { target: stemCounts.get(stem) === 1 ? stem : key };
  };
}

/**
 * Text as the lines a human would count, for diffing purposes: a file's trailing
 * newline TERMINATES the last line rather than starting an empty one, and empty
 * text is zero lines rather than one blank one.
 *
 * Not a nicety. The two sides of every preview arrive in different shapes — the
 * "before" is a vault body read off disk (ends in the file's own newline), the
 * "after" is what Notion returned (does not) — so a naive split gave the before
 * side one extra "" element that no edit ever produced. It could never be part of
 * the common suffix, so EVERY preview this service has ever shown carried a
 * spurious `- ` line at the end of its removals (T5 minor, fixed in the T9 wave).
 */
function diffLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * A compact, dependency-free preview of what a proposal would change: the lines
 * that differ once the common prefix and suffix are trimmed, `-` for the vault's
 * current text and `+` for Notion's. Not a minimal diff (no LCS) — for a page
 * someone edited by hand in Notion the trimmed window IS the edit, and being
 * wrong here costs a slightly longer preview, never a wrong write.
 *
 * Exported (T6) so `notion-sync proposals` renders the SAME preview text this
 * engine already pings on propose — one algorithm, not two that could drift.
 */
export function diffPreview(before: string, after: string): string {
  const a = diffLines(before);
  const b = diffLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const clip = (line: string): string =>
    line.length > DIFF_LINE_CHARS ? `${line.slice(0, DIFF_LINE_CHARS)}…` : line;
  const changed: string[] = [];
  for (let i = start; i < endA; i += 1) changed.push(`- ${clip(a[i])}`);
  for (let i = start; i < endB; i += 1) changed.push(`+ ${clip(b[i])}`);
  if (changed.length === 0) return "(no line-level changes)";
  const shown = changed.slice(0, DIFF_PREVIEW_LINES);
  const rest = changed.length - shown.length;
  return rest > 0 ? `${shown.join("\n")}\n… ${rest} more changed line(s)` : shown.join("\n");
}

export async function runPullSync(opts: PullSyncOptions, deps: PullSyncDeps): Promise<PullSyncResult> {
  const now = opts.now ?? new Date();
  const staleMs = (opts.staleFreezeDays ?? DEFAULT_STALE_FREEZE_DAYS) * 24 * 60 * 60 * 1000;
  const staleProposalHours = opts.staleProposalHours ?? DEFAULT_STALE_PROPOSAL_HOURS;
  const readAllRows = opts.readAllRows === true;

  // Scoped HERE, at the one read, rather than by a `continue` inside the row loop
  // below: everything after this line — the empty-query guard, the wikilink
  // resolver, the loop itself and the `scanned` count — then reasons about one
  // consistent set of rows, and no future branch added to this function can miss
  // the carve-out. `getDeskRows` itself stays deliberately unfiltered (store.ts):
  // ops tooling and the archival of the rows this exclusion orphans both need the
  // raw table, and a filter buried in the store would hide it from them.
  const rows = withoutExcluded(await deps.getDeskRows(), opts.isExcluded);
  const remoteRows = await deps.queryDocs();

  // The same posture as the push pass's empty-listing guard: an empty Docs query
  // in front of a populated store is what a broken token, a wrong data-source id
  // or a half-finished pagination looks like — never "a human trashed all 457
  // pages". Treating it as the latter would archive the vault.
  if (remoteRows.length === 0 && rows.size > 0) {
    throw new Error(
      `notion-sync: the Docs query returned 0 rows while ${rows.size} doc row(s) exist — ` +
      `refusing to treat every page as removed; check the Notion token and docsDataSourceId`,
    );
  }

  const remoteByPage = new Map(remoteRows.map((remote) => [pageKey(remote.pageId), remote]));
  const openByPath = new Map((await deps.getOpenProposals()).map((p) => [p.vaultPath, p]));
  // Many per path is legitimate: rejections are terminal for the open-proposal
  // index (the partial unique index only covers pending/approved), so a file can
  // carry several rejected-but-unreverted decisions at once.
  const rejectedByPath = new Map<string, ProposalRow[]>();
  for (const proposal of await deps.getRejectedUnexecuted()) {
    const list = rejectedByPath.get(proposal.vaultPath);
    if (list === undefined) rejectedByPath.set(proposal.vaultPath, [proposal]);
    else list.push(proposal);
  }
  const resolvePage = buildPageResolver(rows);

  let read = 0;
  let unchanged = 0;
  let reverted = 0;
  let proposed = 0;
  let superseded = 0;
  let awaitingApproval = 0;
  let awaitingRevert = 0;
  let frozen = 0;
  let recreated = 0;
  let archived = 0;
  let skipped = 0;
  let errored = 0;
  let stalePinged = 0;
  let staleProposalsPinged = 0;
  let bookkeepingFailed = 0;

  /** Same containment as wiki-sync's tryRecord — a bookkeeping write never aborts a run. */
  async function tryRecord(what: string, vaultPath: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      bookkeepingFailed += 1;
      console.error(`notion-sync: bookkeeping write failed (${what}) for ${vaultPath}: ${errorMessage(err)}`);
    }
  }

  /**
   * Pings are best-effort by construction: signal-spine being down must not lose a
   * revert that already happened, and it is NOT bookkeeping (nothing about the
   * sync's own state is wrong afterwards), so it never counts as a failure. Silent
   * in dry-run — a rehearsal has no business messaging a human.
   */
  async function ping(message: string): Promise<void> {
    if (opts.dryRun) return;
    try {
      await deps.notify(message);
    } catch (err) {
      console.error(`notion-sync: notify failed: ${errorMessage(err)}`);
    }
  }

  async function freeze(vaultPath: string, reason: string, message: string): Promise<void> {
    frozen += 1;
    if (opts.dryRun) return;
    await tryRecord("freeze", vaultPath, () => deps.freezeDoc(vaultPath, reason));
    await ping(message);
  }

  async function fail(vaultPath: string, what: string, err: unknown): Promise<void> {
    errored += 1;
    const message = errorMessage(err);
    console.error(`notion-sync: ${what} failed for ${vaultPath}: ${message}`);
    if (!opts.dryRun) {
      await tryRecord("error", vaultPath, () => deps.recordDocError(vaultPath, message));
    }
  }

  /**
   * Vault wins, always (spec §6): re-render the file and overwrite the page with
   * it, through the shared overwritePageFromVault composition. Used for a mirror
   * row whose Notion copy drifted; `resolve --keep md` is the same three writes
   * from the CLI side, which is why they live in one exported function.
   */
  async function revertMirror(vaultPath: string, row: DeskRow, remote: RemoteDocRow): Promise<void> {
    let rendered: RenderedDoc;
    try {
      rendered = await deps.renderDoc(vaultPath);
      assertPushSafe(rendered.markdown);
    } catch (err) {
      await fail(vaultPath, "render", err);
      return;
    }

    if (opts.dryRun) {
      reverted += 1;
      return;
    }

    const outcome = await overwritePageFromVault(row.pageId, rendered, deps);
    if (!outcome.ok) {
      // Notion refuses a patch when a human has nested a page under this one and
      // allow_deleting_content is false. That is the never-delete posture working,
      // not a flaky API call — so it freezes with an instruction instead of walking
      // the 3-strike path to a generic 'error' (spec §18.1).
      if (outcome.step === "patch" && CHILD_CONTENT_ERROR.test(errorMessage(outcome.error))) {
        await freeze(
          vaultPath, MIRROR_CHILD_REASON,
          `frozen: ${vaultPath} — ${MIRROR_CHILD_REASON}`,
        );
        return;
      }
      // A failed read-back deliberately records nothing: the stored notion_hash
      // stays stale, so the next tick re-reads, sees a difference, and re-reverts.
      // Self-healing.
      await fail(vaultPath, REVERT_STEP[outcome.step], outcome.error);
      return;
    }

    reverted += 1;
    await tryRecord("synced", vaultPath, () => deps.upsertDocSynced({
      vaultPath,
      pageId: row.pageId,
      mdHash: docRenderHash(rendered),
      notionHash: outcome.notionHash,
      // The write we just made bumped Notion's last_edited_time past this value;
      // storing what we OBSERVED (never a locally invented timestamp, per the push
      // pass's rule) costs one extra read next tick, which then finds the hash
      // equal and moves the watermark forward. Converges in one tick.
      notionLastEdited: remote.lastEditedTime,
      direction: row.direction,
    }));
    await ping(`mirror page ${vaultPath} — edit reverted; source is the vault`);
  }

  /**
   * Desk row: translate what Notion holds back into Obsidian markdown and queue it
   * for a 👍. Nothing is written to either side here — the proposal IS the output.
   */
  async function proposeDesk(
    vaultPath: string, row: DeskRow, notionMarkdown: string, notionHash: string,
  ): Promise<void> {
    // A human already said no to exactly this content, and apply still owes the
    // revert that will put the vault's version back. Re-proposing it here would
    // hand the same rejected edit back for approval — so this tick does nothing at
    // all for the row: no proposal, no ping, and crucially no watermark move, so
    // the state stays honest until the revert lands. Checked FIRST, before the
    // parse and the conflict test, because a freeze here would block the very
    // revert that resolves it (runApplySync skips rows that are not 'synced').
    const rejected = rejectedByPath.get(vaultPath);
    if (rejected !== undefined && rejected.some((p) => p.notionHash === notionHash)) {
      awaitingRevert += 1;
      return;
    }

    // An APPROVED proposal already carrying exactly this Notion content is a
    // decision in flight: leave the row alone — no new proposal, no freeze, and
    // no watermark move — and let apply land it.
    //
    // Asked BEFORE the conflict test below, and that order is the whole reason
    // `resolve` converges (C1, final review). `resolve --keep notion` leaves
    // exactly this shape behind: a forced proposal for the current Notion
    // content on a row whose vault render no longer matches the stored md_hash —
    // the very mismatch that froze it. With the conflict test first, the next
    // tick's pull re-froze the row before apply ever saw it, and apply skips
    // non-'synced' rows: the approved proposal could never land, and a second
    // `resolve` reproduced the same loop forever.
    //
    // ONLY approved, and that is the narrow part (C1 re-review): apply runs
    // EARLIER IN THIS SAME TICK and consumes an approved proposal, so the row's
    // md_hash is stale for minutes, not indefinitely. Nothing consumes a PENDING
    // one — it waits on a human — so deferring the conflict question for it
    // would leave the row 'synced' with a stale md_hash all the way to the push
    // at the end of this same tick, which would then overwrite the Notion page
    // the human is still judging. A pending proposal therefore falls through to
    // the ordinary path: the conflict check freezes if the vault moved too, and
    // the never-stack rule below still refuses to raise a second proposal if it
    // did not.
    const existing = openByPath.get(vaultPath);
    if (existing !== undefined && existing.notionHash === notionHash && existing.state === "approved") {
      awaitingApproval += 1;
      return;
    }

    let body: string;
    try {
      const parsed = parseNotionPage(notionMarkdown, { resolvePage });
      // The pull-direction rail (spec §4.4 as amended): an expiring Notion URL or a
      // live <transcript> block means the whole write-back is refused, not sanitised.
      assertPullSafe(parsed.body);
      body = parsed.body;
      for (const warning of parsed.warnings) {
        console.warn(`notion-sync: ${vaultPath}: ${warning}`);
      }
    } catch (err) {
      const reason = errorMessage(err);
      await freeze(vaultPath, reason, `frozen: ${vaultPath} — ${reason}`);
      return;
    }

    let rendered: RenderedDoc;
    try {
      rendered = await deps.renderDoc(vaultPath);
    } catch (err) {
      await fail(vaultPath, "render", err);
      return;
    }

    // Both sides moved since the last successful sync: freeze-and-flag, never merge
    // (spec §6). md_hash is what the last push stored; a different render now means
    // the vault changed too — and this engine has no business choosing a winner.
    if (docRenderHash(rendered) !== row.mdHash) {
      await freeze(
        vaultPath, CONFLICT_REASON,
        `frozen: ${vaultPath} — ${CONFLICT_REASON}; resolve with: notion-sync resolve ${vaultPath} --keep md|notion`,
      );
      return;
    }

    // Never stack (§18.4), for the pending proposals the branch above no longer
    // covers: an open proposal that already carries exactly this Notion content
    // IS this content's proposal, so it is left as it stands — no supersede, no
    // duplicate, no watermark move, which is what makes this tick-stable rather
    // than a re-propose loop. Only genuinely new Notion content supersedes it.
    if (existing !== undefined && existing.notionHash === notionHash) {
      awaitingApproval += 1;
      return;
    }

    if (opts.dryRun) {
      if (existing !== undefined) superseded += 1;
      proposed += 1;
      return;
    }

    if (existing !== undefined) {
      superseded += 1;
      await tryRecord("supersede", vaultPath, () => deps.setProposalState(existing.id, "superseded"));
    }

    // Computed BEFORE insertProposal (T6 review, F2) so the SAME preview text
    // is both persisted (diff_preview — the console has no vault mount to
    // re-derive one, spec §18.4's "diff visible" contract) and pinged, rather
    // than two independent computations that could disagree. A failure here
    // degrades the preview to an empty "before" side, never the proposal
    // itself — the row above is already correct regardless.
    //
    // The "before" side is the vault file put through the SAME push→pull
    // canonicalisation `body` came out of, not the file as written. A pulled
    // body always comes back in the canonical block shape (translate-pull.ts's
    // OUTPUT SHAPE note), so diffing it against a vault file spaced any other
    // way reports every re-spaced line as a change and buries the human's
    // actual edit — on a real file, a one-line edit read as 1549 changed lines.
    // Canonical vs canonical shows the edit and nothing else. The re-spacing is
    // still what gets WRITTEN; it is announced once, in the README and in the
    // `reflow` marker `enable-two-way` prints, rather than in every preview.
    // `rendered` is the render this pass already did — no second read, and the
    // same bytes the push pass would have sent.
    let before = "";
    try {
      before = parseNotionPage(rendered.markdown, { resolvePage }).body;
    } catch (err) {
      console.warn(`notion-sync: diff preview unavailable for ${vaultPath}: ${errorMessage(err)}`);
    }
    const preview = diffPreview(before, body);

    proposed += 1;
    await tryRecord("propose", vaultPath, async () => {
      await deps.insertProposal({
        vaultPath,
        notionPageId: row.pageId,
        proposedBody: body,
        baseMdHash: row.mdHash ?? "",
        notionHash,
        diffPreview: preview,
      });
    });

    // NO PING HERE ANY MORE (spec §20.4, ORB-38). This was the only notify() call that
    // asked a human to DECIDE something, and decisions now belong to Saga: she polls the
    // proposals table and opens a DM about each new one, where he can answer in words and
    // 👍 her card. Pinging as well would mean he is told twice about the same thing on two
    // surfaces, and #lares-alerts stops being a channel worth reading.
    //
    // The awareness pings all stay: freezes, errors, mirror reverts/recreates/archives,
    // applied/reverted confirmations, and the stale-freeze re-ping. And the failure mode
    // this used to cover — a proposal nobody ever answers — is now covered better, by the
    // stale-proposal escalation at the end of this pass: the spine hears about it only
    // when the NEW surface has failed to get a decision.
    //
    // A log line stays, because the box's own logs are how an operator reconstructs a tick.
    console.log(
      `notion-sync: proposed ${vaultPath}` +
      `${existing === undefined ? "" : " (supersedes an earlier proposal)"} — awaiting Bendik's decision`,
    );
  }

  /**
   * The page is gone from Notion — trashed or hard-archived by a human (spec §7 as
   * amended). A MIRROR page is the vault's own projection, so it comes back; every
   * other direction is Notion-primary enough that a removal means "retire this
   * file", which is a move to `_archive/`, never a delete.
   *
   * Asked as ownership rather than `!== two_way` (Phase 4): a `notion_to_md` row
   * whose page Bendik trashed would otherwise be RECREATED from the vault — the
   * service re-uploading a document he had just deleted at its source, and then
   * pinning the row to the new page so his deletion could never take. Trashing the
   * source of a projection means retire the projection.
   *
   * Excluded rows never reach here: the row snapshot is scoped once, at the single
   * `getDeskRows` read (`withoutExcluded`, T2), so a carved-out path is absent from
   * this loop entirely rather than filtered inside it. Retiring the rows an
   * exclusion orphans is `notion-sync archive-excluded`'s deliberate one-off job
   * (T3), never a side effect of a tick.
   */
  async function handleMissingPage(vaultPath: string, row: DeskRow): Promise<void> {
    if (vaultOwns(row.direction)) {
      let rendered: RenderedDoc;
      try {
        rendered = await deps.renderDoc(vaultPath);
        assertPushSafe(rendered.markdown);
      } catch (err) {
        await fail(vaultPath, "render", err);
        return;
      }
      if (opts.dryRun) {
        recreated += 1;
        return;
      }
      let pageId: string;
      try {
        pageId = (await deps.createDocPage(rendered.props, rendered.markdown)).pageId;
      } catch (err) {
        await fail(vaultPath, "recreate", err);
        return;
      }
      let stored: string;
      try {
        stored = await deps.getPageMarkdown(pageId);
      } catch (err) {
        // The page exists but the row still points at the trashed one. Pin the new
        // id with an empty hash ("" never equals a real read) so the next tick
        // re-reads and completes, rather than creating a SECOND replacement.
        await tryRecord("pin", vaultPath, () => deps.upsertDocSynced({
          vaultPath, pageId, mdHash: "", notionHash: "", notionLastEdited: null,
          direction: row.direction,
        }));
        await fail(vaultPath, "hash-after-write read", err);
        return;
      }
      recreated += 1;
      await tryRecord("synced", vaultPath, () => deps.upsertDocSynced({
        vaultPath,
        pageId,
        mdHash: docRenderHash(rendered),
        notionHash: sha256(stored),
        // No observed last_edited_time for a page created seconds ago, and this
        // engine never invents one (same rule as the push pass). The store reads
        // null as "took no reading" and keeps whatever baseline the row had — the
        // new page's stamp is necessarily newer, so the next tick re-reads it and
        // the watermark catches up. A row that never had a baseline stays
        // unbaselined and remains `notion-sync reconcile`'s job.
        notionLastEdited: null,
        direction: row.direction,
      }));
      await ping(`mirror page ${vaultPath} — removed in Notion, recreated from the vault`);
      return;
    }

    if (opts.dryRun) {
      archived += 1;
      return;
    }
    try {
      await deps.archiveVaultFile(vaultPath);
    } catch (err) {
      await fail(vaultPath, "archive", err);
      return;
    }
    archived += 1;
    await tryRecord("orphaned", vaultPath, () =>
      deps.markDocOrphaned(vaultPath, "page removed in Notion — file moved to _archive/"));
    // Every outstanding decision about this file dies with the archive. An open
    // proposal would otherwise sit there waiting to write a file that no longer
    // lives at that path, and a queued rejection would keep asking apply to revert
    // a page Notion no longer has — both would fail on every tick, forever.
    const outstanding = [
      ...(openByPath.has(vaultPath) ? [openByPath.get(vaultPath) as ProposalRow] : []),
      ...(rejectedByPath.get(vaultPath) ?? []),
    ];
    for (const proposal of outstanding) {
      superseded += 1;
      await tryRecord("supersede", vaultPath, () => deps.setProposalState(proposal.id, "superseded"));
    }
    await ping(`desk page ${vaultPath} — removed in Notion; the vault file moved to _archive/`);
  }

  for (const vaultPath of [...rows.keys()].sort()) {
    const row = rows.get(vaultPath) as DeskRow;

    // A row that is frozen, erroring or orphaned is not in a state pull can reason
    // about — push (or a human `resolve`) heals it first (§18.4). Frozen rows are
    // still re-pinged below; that is the only attention they get.
    if (row.state !== "synced") {
      skipped += 1;
      continue;
    }

    const remote = remoteByPage.get(pageKey(row.pageId));
    if (remote === undefined) {
      await handleMissingPage(vaultPath, row);
      continue;
    }

    // No baseline yet. Two different situations hide behind that one NULL, and
    // treating them the same is what would make every file added after go-live
    // invisible to this pass forever (T7 review, F1):
    //
    //   - The row HAS a real `notion_hash`. That hash came from a
    //     hash-after-write read, so the page and the store genuinely agree; all
    //     that is missing is a timestamp, because the push pass never reads one
    //     and upsertDocSynced COALESCEs a NULL rather than storing it. Every page
    //     created after `reconcile` ran is this shape. Reading it once costs one
    //     GET, the hash then matches, and the `unchanged` branch below writes the
    //     baseline from an OBSERVED `lastEditedTime` — nothing invented, and the
    //     row joins the ordinary pre-filtered loop from the next tick on. Without
    //     it the row sits outside auto-revert and proposals for good, silently,
    //     counted as `skipped`.
    //   - The row's `notion_hash` is the "" sentinel (an adoption pin, or a pin
    //     written when a hash-after-write read failed). There is nothing truthful
    //     to compare a read against, so it stays the PUSH pass's job until a
    //     successful write gives it a real hash — the original rule, unchanged.
    //
    // reconcile reads both shapes: it is the pass that baselines from scratch.
    const unbaselined = row.notionLastEdited === null;
    if (!readAllRows && unbaselined && !row.notionHash) {
      skipped += 1;
      continue;
    }

    // Both sides are ISO-8601 UTC text (store.ts casts the column in SQL for exactly
    // this comparison). `>=`, not `>`: Notion's stamps are minute-granular, so an
    // edit inside the same minute as the last sync would otherwise be invisible.
    if (!readAllRows && !unbaselined && !(remote.lastEditedTime >= (row.notionLastEdited as string))) {
      skipped += 1;
      continue;
    }

    read += 1;
    let notionMarkdown: string;
    try {
      notionMarkdown = await deps.getPageMarkdown(row.pageId);
    } catch (err) {
      await fail(vaultPath, "page read", err);
      continue;
    }

    // THE test for "Notion changed" (spec §3). A timestamp moved for all sorts of
    // reasons — including this service's own write — but the content hash only
    // moves when the content did.
    const notionHash = sha256(notionMarkdown);
    if (notionHash === row.notionHash) {
      unchanged += 1;
      if (!opts.dryRun) {
        await tryRecord("watermark", vaultPath, () =>
          deps.updateNotionWatermark(vaultPath, notionHash, remote.lastEditedTime));
      }
      continue;
    }

    // Notion changed. WHO OWNS THE DOCUMENT decides what that means — and the
    // question is asked as ownership, not as `=== two_way`, because the else-branch
    // of that compare used to swallow `notion_to_md` and revert it as a mirror:
    // Bendik's edit to a page Notion itself authored, overwritten from the vault
    // copy, hourly, with no 👍 and a ping telling him the vault is the source.
    //
    // Only a mirror is reverted. Everything else — negotiated (two_way) or
    // Notion-owned (notion_to_md) — reaches him as a gated proposal, which is also
    // where the two-sided-conflict freeze lives (proposeDesk's md_hash check).
    if (vaultOwns(row.direction)) {
      await revertMirror(vaultPath, row, remote);
    } else {
      await proposeDesk(vaultPath, row, notionMarkdown, notionHash);
    }
  }

  // Stale freezes (spec §6): a conflict nobody resolved is worse the longer it
  // sits, so it gets re-announced every tick past the threshold — once per row,
  // and never in dry-run.
  const staleCutoff = now.getTime() - staleMs;
  for (const frozenRow of await deps.getFrozenDocs()) {
    if (frozenRow.frozenAt.getTime() > staleCutoff) continue;
    stalePinged += 1;
    await ping(
      `still frozen: ${frozenRow.vaultPath} — ${frozenRow.reason ?? "no reason recorded"}; ` +
      `resolve with: notion-sync resolve ${frozenRow.vaultPath} --keep md|notion`,
    );
  }

  // Stale proposals (spec §20.4) — what REPLACES the retired per-proposal ping. Saga
  // announced this one (announced_at is set) and it is still pending well past the
  // threshold, so the conversational surface asked and got no answer: either he has not
  // looked, or Saga is down and the DM never really landed. That is worth #lares-alerts;
  // routine "here is an edit to approve" no longer is.
  //
  // Rows Saga has NOT announced yet are deliberately excluded (getStaleAnnouncedProposals
  // filters them): un-announced is the poll's job, and treating them as stale would fire
  // the alarm for every proposal in the gap between propose and the next poll.
  //
  // The message text is fixed per proposal so the spine's 24h fingerprint gate collapses
  // the repeats — same trick as the stale-freeze re-ping above, which sends identical
  // text every tick past its threshold.
  // CONTAINED, unlike every other pass step here: this is the one dep that reads a column
  // (`announced_at`) which does not exist until 017 is applied BY HAND on the box — i.e.
  // it is guaranteed to be missing for some window after the image ships. Letting it throw
  // would abort the tick after all the real work was done, losing the pull summary line and
  // painting every cycle red, which is exactly the noise that hides a genuine failure.
  let staleProposals: StaleProposalRow[] = [];
  try {
    staleProposals = await deps.getStaleProposals(staleProposalHours);
  } catch (err) {
    console.error(
      `notion-sync: stale-proposal check unavailable (has sql/017 been applied?): ${errorMessage(err)}`,
    );
  }
  for (const stale of staleProposals) {
    staleProposalsPinged += 1;
    // The two cases mean different things to whoever reads #lares-alerts, so they must not
    // share a sentence: "asked, no answer" is a human who has not looked; "never announced"
    // is the notification path itself being broken.
    //
    // Both texts are FIXED per proposal (no elapsed-time phrasing) so the spine's 24h
    // fingerprint gate collapses the repeats — same trick as the stale-freeze re-ping.
    const proposedOn = stale.createdAt.toISOString().slice(0, 10);
    await ping(
      stale.announcedAt === null
        ? `never announced: ${stale.vaultPath} — proposed ${proposedOn} and NOBODY has been told. ` +
          `Saga's proposal watch is not running (check sql/017 is applied and the saga image carries the notion hand). ` +
          `Decide meanwhile on the console /integrations card, or with: notion-sync approve|reject ${stale.vaultPath}`
        : `still awaiting your decision: ${stale.vaultPath} — proposed ${proposedOn}, ` +
          `Saga asked and got no answer. Decide in her DM, on the console /integrations card, ` +
          `or with: notion-sync approve|reject ${stale.vaultPath}`,
    );
  }

  return {
    scanned: rows.size,
    read,
    unchanged,
    reverted,
    proposed,
    superseded,
    awaitingApproval,
    awaitingRevert,
    frozen,
    recreated,
    archived,
    skipped,
    errored,
    stalePinged,
    staleProposalsPinged,
    bookkeepingFailed,
    summary:
      `${read} read, ${unchanged} unchanged, ${reverted} reverted, ${proposed} proposed, ` +
      `${superseded} superseded, ${awaitingApproval} awaiting approval, ` +
      `${awaitingRevert} awaiting revert, ${frozen} frozen, ` +
      `${recreated} recreated, ${archived} archived, ${skipped} skipped, ${errored} errored, ` +
      `${stalePinged} stale-freeze pinged, ${staleProposalsPinged} stale-proposal pinged, ` +
      `${bookkeepingFailed} bookkeeping-failed, ` +
      `${rows.size} scanned${opts.dryRun ? " (dry-run)" : ""}`,
  };
}
