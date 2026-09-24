// T6 (Phase 4, ORB-39): the Notion-born page — a page Bendik creates by hand in
// the Docs database becoming a vault file, behind a 👍 (plan decision 3).
//
// **This is the pass that can write anywhere in the vault**, and everything about
// its shape follows from that. Every other write in this service goes to a path
// somebody already found on disk; here the FOLDER comes from a free-text `Folder`
// property a human types into Notion and the FILENAME comes from a page title. Both
// are untrusted content, so the derived path is run through the same two predicates
// the apply pass re-checks immediately before the write:
//
//   `refuseVaultTarget` (vault-target.ts)  — the shape: no escapes, no dot-dirs, no
//                                            `wiki/`, `_meta/`, `_archive/`, markdown only
//   `inCreateScope`     (desk-scope.ts)    — the place: inside a configured desk dir
//
// …plus one refusal that is T6's own and stricter than the shared scope predicate:
// a path config has CARVED OUT of the desk scope is refused here (see
// `isExcluded` below). Nothing is re-implemented: the propose-side checks are the
// identical functions, called early so a refusal is a readable line in a report
// rather than an opaque failure after Bendik has already tapped Approve. The
// guarantee remains where T3b put it — at the write, under the note lock, with
// `O_EXCL` and a realpath of the deepest existing ancestor.
//
// Like every Notion→vault write in this service, it PROPOSES and never writes:
// `kind='create'` into the existing queue → Saga's DM and button row →
// `resolveProposal` → `runApplySync`. No new gate, no new execution path.
//
// FOUR decisions worth stating up front, each of which is a "correct for one tick,
// wrong on the next" trap this phase has already fallen into twice:
//
//   1. **The proposal's `notionHash` is `sha256` of Notion's RAW markdown**, not of
//      the file this engine composes. Once the create lands, the row is an ordinary
//      Notion-owned DOCS row and the desk PULL owns it — and pull's change test is
//      `sha256(getPageMarkdown(...))`. Hash anything else and the very next tick
//      reads a difference that is not there and proposes a phantom edit.
//
//   2. **The H1 is synthesised here, from the `Name` property.** Notion's
//      `GET /markdown` never returns the title, and a leading `# H1` is silently
//      DROPPED on both create and patch (live probe, API version 2026-03-11) — so
//      the page body can never carry it and no corrective patch can put it there.
//
//   3. **…and `title:` goes in the FRONTMATTER as well, which is the opposite of
//      what T4 does, for a reason that is the mirror image of T4's.** A transcript's
//      updates are composed by T4's own pass, which regenerates the H1 every time,
//      so a frontmatter `title:` there would be the one copy that goes stale. A
//      Notion-born page's updates are composed by the desk PULL, which writes
//      `frontmatter-from-disk + Notion's body` — and Notion's body has no H1. So
//      here the frontmatter is the half that survives an update and the H1 is the
//      half that does not. `extractTitle` (translate.ts) reads frontmatter `title:`
//      first, so the round trip stays stable either way; without it the title would
//      degrade to the filename SLUG on the first edit Bendik approves.
//      **Named cost:** the visible `# Heading` does disappear from the file on that
//      first approved edit, because Notion has nowhere to keep it.
//
//   4. **The body goes through `parseNotionPage`/`assertPullSafe`, exactly as pull
//      does.** T4 stores a transcript verbatim because nothing may ever push it
//      back; a Notion-born page is an ordinary desk document that pull will keep in
//      step from the next tick on, so it must land in the same canonical Obsidian
//      shape pull would write — otherwise the first approved edit rewrites the whole
//      file and buries the actual change in a re-flow.
import { diffPreview, buildPageResolver } from "./pull-sync.js";
import { parseNotionPage, assertPullSafe } from "./translate-pull.js";
import { pageKey } from "./pull-sync.js";
import { sha256 } from "./wiki-sync.js";
import { refuseVaultTarget, findCollidingPath } from "./vault-target.js";
import { isUnderDir } from "./desk-scope.js";
// Straight from @lares/vault-format — the dependency-free package, not the role kit this
// service does not ship with (docs/specs/2026-09-18-origin-model-design.md).
import { originFrontmatterLine } from "@lares/vault-format/origin";
// The three derivations both create proposers share. Reused rather than copied —
// a second slug rule, a second H1 composer or a second YAML quoter is how the two
// ends of one rule drift apart, and the two proposers write into the same vault.
import { transcriptSlug, transcriptBody, yamlScalar } from "./transcript-sync.js";
import type {
  DeskRow, PageStateRow, ProposalInput, ProposalRow, ProposalState,
} from "./store.js";
import type { ProjectMapping } from "./types.js";

/**
 * One row of the Notion Docs database as this engine needs it. A structural type
 * rather than the adapter's `NotionDocRow`, for the reason every engine here
 * declares its own: lib/ may not import from adapters/ (neutrality.test.ts), and
 * the adapter's row is assignable to this one, so the composition root hands it
 * straight over with no mapping layer in between.
 */
export interface NotionBornRow {
  pageId: string;
  /** The `Name` title property. The page body never carries it — see decision 2. */
  title: string;
  /** The `Project` select — the key into the desk-folder mapping. NULL is a real state. */
  project: string | null;
  /**
   * The `Folder` rich_text. Empty is the ordinary case; when a human fills it in it
   * WINS over the Project mapping (plan decision 3). Vault-relative, which is the
   * meaning the push pass already gives this property (cli.ts makeDocRender writes
   * `<desk dir>/<sub folder>` into it), so a human filling it in by hand is copying
   * a shape the database already shows them.
   *
   * **Untrusted content.** Nothing here is trimmed, normalised or repaired — a
   * value that does not survive `refuseVaultTarget` is reported back with the reason
   * rather than quietly turned into something that does.
   */
  folder: string;
  /**
   * The `Vault Path` rich_text. **`""` is what makes a page Notion-BORN**, and it is
   * the single field that keeps this pass and `wiki-sync.ts`'s `adoptRemoteRows`
   * from ever reaching for the same page:
   *
   *   - adoption requires it NON-EMPTY — a page THIS SERVICE created, whose store
   *     row was lost, matched back to the file it already names. It writes no vault
   *     file at all; it writes the row.
   *   - this pass requires it EMPTY — a page a human made, which has never had a
   *     file. It writes no row; it proposes a file.
   *
   * The two predicates are complementary on one field, so no page can be a
   * candidate for both, on any tick, in any order.
   */
  vaultPath: string;
}

export interface NotionBornSyncOptions {
  dryRun: boolean;
  /**
   * Notion `Project` select value → vault folder, built by the composition root from
   * `desks.deskDirs` (`{notionProject: entry.project, vaultFolder: entry.dir}`).
   * Config, never code — the same rule `wikiProject` and `transcripts.projects`
   * carry.
   *
   * `deskDirs` deliberately, and NOT the wiki dir: `wikiDir` is the one-way mirror,
   * and a page mapped into it would fight that projection on every tick. A page
   * carrying the wiki's Project value therefore has no folder here and is skipped
   * and reported, which is the honest answer.
   */
  projects: ProjectMapping[];
  /**
   * May this service create a file at this path? Pass `makeCreateScope(cfg)` — the
   * SAME predicate the apply pass re-checks immediately before the write, so a
   * proposal this engine raises cannot be refused later for a reason this engine
   * could have seen.
   */
  inCreateScope: (vaultPath: string) => boolean;
  /**
   * Has config carved this vault path out of the desk scope (`deskDirs[].exclude`)?
   * Pass `makeDeskExclusion(cfg.desks)` — there is no other correct value.
   *
   * REQUIRED, and used as a REFUSAL, which makes T6 strictly stricter than
   * `makeCreateScope` on purpose. That predicate ALLOWS a carve-out when it is a
   * configured `transcripts.dir`, because T4's whole job is to create files there
   * (T3b fix round 1). T6 has no such business: a carve-out means another pass owns
   * that sub-tree, and a Notion-born DOCS page dropped into it would land a docs row
   * at a path the desk pull is scoped away from — a tracked document that can never
   * be kept in step again, silently, forever.
   *
   * Refusing here is enough for the whole system, and that is worth stating rather
   * than assuming: `kind='create'` proposals have exactly two authors, and the other
   * one (T4) proposes ONLY into `transcripts.dir` and refuses everything else. So no
   * create proposal for an excluded non-transcript path can exist to reach the apply
   * pass, and `makeCreateScope` keeps the shape T4 needs.
   */
  isExcluded: (vaultPath: string) => boolean;
  /**
   * `transcripts.dir`, when a transcripts pass is configured at all (review round 1,
   * Minor 6). Absent ⇒ nothing extra is refused, which is every Phase 1–3 deployment
   * and the box's today.
   *
   * It closes the one gap `isExcluded` above cannot see. That refusal fires on a
   * CARVE-OUT — but a desk dir with `exclude` absent or `[]` has no carve-out, so for
   * `<that dir>/<transcripts.dir>/x.md` the exclusion predicate says false, and
   * `makeCreateScope` (whose transcripts exception exists for T4) says true. Neither
   * rule fires, and a Notion-born docs page lands among T4's transcripts — where the
   * desk push would also list it as its own, because nothing carved it out.
   *
   * Refused HERE rather than at config parse time, deliberately: a parse-time refusal
   * would stop the whole service — every pass, including the ones with nothing to do
   * with it — over one missing `exclude` line, and it would make T4's own
   * defence-in-depth (`pushHoldBack`, the scoped `upsertDocSynced`) unreachable, since
   * those exist precisely for the config that has lost that line. T6 is the only pass
   * that can create a docs file there, so T6 is where the refusal belongs.
   */
  transcriptsDir?: string;
}

export interface NotionBornSyncDeps {
  /** One query per tick — the same Docs data source the pull pass reads. */
  queryDocs: () => Promise<NotionBornRow[]>;
  /** State rows keyed by PAGE, across both targets (store.ts getPageRows). */
  getPageRows: () => Promise<Map<string, PageStateRow>>;
  /**
   * The desk row snapshot — used for ONE thing: building the wikilink resolver, so a
   * `<mention-page>` in a Notion-born page becomes the same `[[wikilink]]` the pull
   * pass would write for it. Same function (`buildPageResolver`), same input, so a
   * link this engine writes resolves back to the same page on any later push.
   */
  getDeskRows: () => Promise<Map<string, DeskRow>>;
  getOpenProposals: () => Promise<ProposalRow[]>;
  /**
   * Rejected proposals whose decline the apply pass has not executed yet. Needed for
   * the same reason pull and the transcript pass need it: a rejection is invisible in
   * `getOpenProposals`, and apply runs LATER in this same tick, so without this the
   * pass would hand a human back the file he just declined.
   */
  getRejectedUnexecuted: () => Promise<ProposalRow[]>;
  getPageMarkdown: (pageId: string) => Promise<string>;
  /** Is something already at this path? A create never overwrites — plan decision 3. */
  vaultFileExists: (vaultPath: string) => Promise<boolean>;
  /**
   * Every markdown path under the vault root (`makeVaultWalk().listAllFiles()`) —
   * the CASE-AND-NORMALISATION half of "never overwrite" (review round 1,
   * Important A).
   *
   * `vaultFileExists` is an `lstat`, and an `lstat` answers the question the
   * FILESYSTEM UNDERNEATH IT asks. The box is Linux/ext4 and case-sensitive, so a
   * hand-written `zero7/Notater.md` does not answer to `zero7/notater.md` — the
   * guard says "nothing there", `O_EXCL` succeeds, and the commit the box pushes
   * contains BOTH files. Bendik then pulls it onto APFS, where they are one path:
   * git reports `warning: the following paths have collided`, Notion's file is what
   * lands on disk, and his own note reads as MODIFIED. One `git add -A` — which
   * Obsidian Git does automatically on many setups — overwrites it in history.
   *
   * The guard was never violated; it was routed around by the filesystem seam. So
   * the comparison has to be made in the engine, where it can be made in the FORM
   * BOTH filesystems agree on: `NFC` + lowercase. NFC matters as much as case —
   * `nøtter` typed on a Mac is decomposed and on Linux is composed, and those are
   * two directories on ext4 and one on APFS.
   *
   * T4 is not exposed to this (its filenames are date-prefixed and go into a folder
   * only it writes). T6 is the only pass that mints new filenames into folders where
   * a human keeps hand-written notes, which is why the guard lives here.
   *
   * Read at most ONCE per tick, and only when a page has actually reached the
   * overwrite check.
   */
  listVaultFiles: () => Promise<string[]>;
  /** Makes sure the page has a state row (store.ts) — see the create branch. */
  ensureDocsRow: (pageId: string) => Promise<void>;
  insertProposal: (input: ProposalInput) => Promise<number>;
  setProposalState: (id: number, state: ProposalState) => Promise<void>;
}

/** A page this pass deliberately did nothing about, and why. Reported, never silent. */
export interface NotionBornSkip {
  pageId: string;
  title: string;
  /** The path it would have landed at, when one could be derived at all. */
  vaultPath?: string;
  reason: string;
}

export interface NotionBornSyncResult {
  /** Remote Docs rows considered this tick. */
  scanned: number;
  /** …of which are Notion-born with no vault file yet: this pass's actual subject. */
  candidates: number;
  /** Pages actually fetched (`GET /markdown`) — the cost of the tick. */
  read: number;
  /** Read, but the content still hashes to what the state row already accounted for. */
  accounted: number;
  proposed: number;
  superseded: number;
  /** Pages whose open proposal already carries exactly this file. */
  awaitingApproval: number;
  /** Pages holding content a human rejected, waiting for apply to record the decline. */
  awaitingDecline: number;
  errored: number;
  bookkeepingFailed: number;
  skipped: NotionBornSkip[];
  summary: string;
}

export interface NotionBornFileInput {
  title: string;
  /** The body as `parseNotionPage` produced it — Obsidian flavour, no H1. */
  body: string;
  pageId: string;
}

/**
 * The WHOLE file a create proposal carries — frontmatter included, because there is
 * no file on disk to lift a frontmatter block from (T3b) — and with NO trailing
 * newline, because the apply engine adds exactly one.
 *
 * Four keys and no more. `title` because it is the only durable home a Notion-born
 * page's title has (see decision 3 in the header); `source` because a reader
 * deserves to know the file is a projection rather than something hand-written;
 * `lares_origin: synced` (ADR-0017 rule 9) because this file was written by a sync
 * job's own 👍 gate, not by the owner or the agent — the class names the PIPE, never
 * the page's author, so a colleague's own Notion page lands here `synced` too, its
 * content read with the same scepticism as any `third_party` block downstream; and
 * `notion_page` because it is the way back to the page that owns the document —
 * which matters more here than anywhere else in this service, since no pass will
 * ever push a change to this file back.
 *
 * Deliberately NO `project:`. The folder says which project the file belongs to, and
 * a filled `Folder` may legitimately put the file somewhere the Notion `Project`
 * does not name — at which point a `project:` key would be a second answer to a
 * question the path has already answered, and the wrong one.
 */
export function notionBornFile(input: NotionBornFileInput): string {
  const title = input.title.replace(/\s+/g, " ").trim();
  const frontmatter = [
    "---",
    `title: ${yamlScalar(title)}`,
    "source: notion-docs",
    originFrontmatterLine("synced"),
    `notion_page: ${input.pageId}`,
    "---",
  ].join("\n");
  return `${frontmatter}\n\n${transcriptBody(input.title, input.body)}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A page title as it is safe to put in a log line. A Notion title can contain a
 * newline, and this pass prints the title into the tick's log — where a forged
 * `\nnotion-sync: notion-born: proposed NEW FILE …` would read exactly like a real
 * line to whoever is reconstructing what a tick did. Collapsed once, where the skip
 * record is BUILT, so every surface that later prints it (the CLI command, the
 * container entrypoint) gets the safe value without having to remember to.
 *
 * The path itself needs no such treatment: `refuseVaultTarget` refuses a control
 * character outright, and a page that got as far as having one printed was refused
 * for that very reason.
 */
function logSafe(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

export async function runNotionBornSync(
  opts: NotionBornSyncOptions,
  deps: NotionBornSyncDeps,
): Promise<NotionBornSyncResult> {
  // Built as a count, not a lookup, because `config.ts` validates `deskDirs[].dir`
  // for overlap but says nothing about two entries sharing a `project` value. A
  // Map would silently hand out the last one written; counting lets an ambiguous
  // Project be REPORTED, which is the only honest answer — this pass has no way to
  // tell which of two folders a human meant.
  const foldersByProject = new Map<string, string[]>();
  for (const mapping of opts.projects) {
    const list = foldersByProject.get(mapping.notionProject);
    if (list === undefined) foldersByProject.set(mapping.notionProject, [mapping.vaultFolder]);
    else list.push(mapping.vaultFolder);
  }

  const remote = [...await deps.queryDocs()].sort((a, b) => (a.pageId < b.pageId ? -1 : 1));
  // Keyed the way pull keys its own page lookups (`pageKey`): a bare id, a dashed
  // id and a page URL all have to answer as the same page, or a row written through
  // one spelling is invisible to a query that returns the other.
  const rows = new Map<string, PageStateRow>();
  for (const [pageId, row] of await deps.getPageRows()) rows.set(pageKey(pageId), row);

  // Open and rejected-unexecuted proposals by PAGE — the key a create has, since its
  // path is the thing it is asking to bring into existence and can legitimately move
  // between ticks (a human edits `Folder`, or retitles the page).
  const openByPage = new Map<string, ProposalRow[]>();
  // …and by PATH, which answers a different question: who has already claimed this
  // filename? Two Notion pages whose titles slug the same way produce one path, and
  // `notion_sync_proposals_open` (016) is UNIQUE on vault_path across pending and
  // approved — so a second create for that path does not merely duplicate, it
  // VIOLATES the index and throws on every tick, forever.
  const claimedBy = new Map<string, string>();
  for (const proposal of await deps.getOpenProposals()) {
    const list = openByPage.get(pageKey(proposal.notionPageId));
    if (list === undefined) openByPage.set(pageKey(proposal.notionPageId), [proposal]);
    else list.push(proposal);
    claimedBy.set(proposal.vaultPath, proposal.notionPageId);
  }
  const rejectedByPage = new Map<string, ProposalRow[]>();
  for (const proposal of await deps.getRejectedUnexecuted()) {
    const list = rejectedByPage.get(pageKey(proposal.notionPageId));
    if (list === undefined) rejectedByPage.set(pageKey(proposal.notionPageId), [proposal]);
    else list.push(proposal);
  }

  let candidates = 0;
  let read = 0;
  let accounted = 0;
  let proposed = 0;
  let superseded = 0;
  let awaitingApproval = 0;
  let awaitingDecline = 0;
  let errored = 0;
  let bookkeepingFailed = 0;
  const skipped: NotionBornSkip[] = [];

  /** Same containment as every other engine here — a bookkeeping write never aborts a run. */
  async function tryRecord(what: string, pageId: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      bookkeepingFailed += 1;
      console.error(
        `notion-sync: bookkeeping write failed (${what}) for page ${pageId}: ${errorMessage(err)}`,
      );
    }
  }

  function skip(row: NotionBornRow, reason: string, vaultPath?: string): void {
    const title = logSafe(row.title);
    skipped.push({
      pageId: row.pageId, title, reason,
      ...(vaultPath === undefined ? {} : { vaultPath }),
    });
    console.log(`notion-sync: notion-born: skipped ${row.pageId} (${title}) — ${reason}`);
  }

  // Every vault path that already EXISTS, keyed in the form both filesystems agree
  // about. Read at most once per tick and only when a page reaches the overwrite
  // check, so a tick with no candidates pays nothing for it.
  //
  // A failed listing is NOT cached as "no collisions" and is not contained per page:
  // an unreadable vault is a whole-pass condition (a broken /srv/brain mount), and
  // treating it as an empty set would turn it into a green light to create files
  // across the whole vault. It throws, `runPassesContained` reports the tick unclean,
  // and nothing is proposed — the same posture as the push pass's empty-listing guard
  // and `vaultFileExists`'s own non-ENOENT rule.
  let existingOnDisk: Promise<string[]> | undefined;
  const onDisk = (): Promise<string[]> => (existingOnDisk ??= deps.listVaultFiles());

  // Every vault path a STATE ROW already claims, and which page claims it — the
  // propose-side mirror of apply's guard 0 (`apply-sync.ts`, "the vault already
  // tracks that file"), added in review round 1 (Important B).
  //
  // Without it, a page whose derived path is owned by a DIFFERENT page's row is
  // proposed, approved, refused by guard 0 at apply, and proposed again on the very
  // next tick — forever, with an EMPTY skip list, so it is neither proposed
  // successfully nor reported as skipped. The reachable shape is ordinary: a page is
  // created, trashed in Notion (pull retires the file to `_archive/` and leaves the
  // row at the old path), and a new page is made with the same title. `_archive/` is
  // outside the listing above, so the disk check says "nothing there" and only the
  // ROW knows.
  //
  // No new query: `getPageRows()` is already read whole and already carries
  // `vaultPath`.
  const trackedBy = new Map<string, string>();
  for (const row of rows.values()) {
    if (row.vaultPath !== null) trackedBy.set(row.vaultPath, row.pageId);
  }

  // Built once, from the snapshot, exactly as pull builds it: the resolver is a
  // function of the rows as of this tick's start, which is what keeps a link this
  // engine writes and a link the push pass reads back in agreement.
  let resolvePage: ReturnType<typeof buildPageResolver> | undefined;

  for (const row of remote) {
    // ── Is this page even ours? ──────────────────────────────────────────────
    // A page with a Vault Path is one this service created (or adopted); the store
    // row for it may be missing, but recovering that is `adoptRemoteRows`'s job and
    // it does it by claiming the EXISTING file, never by writing a new one. Silent
    // rather than reported: on a cold-start recovery every page in the database is
    // this shape, and a report line per page would bury the ones that matter.
    if (row.vaultPath !== "") continue;

    const state = rows.get(pageKey(row.pageId));
    // A state row that already names a vault file means the document exists and some
    // other pass owns keeping it in step — the desk pull for a docs row, T4 for a
    // meetings row. Either way there is nothing here to create.
    if (state?.vaultPath != null) continue;

    // A state row from ANOTHER database, with no vault file yet: what
    // `ensureMeetingRow` leaves behind after a declined transcript. Reachable because
    // a page can be moved between Notion databases, and consequential because
    // `notion_page_id` is UNIQUE table-wide and `linkPageToVaultFile` conflicts on
    // it — so approving a create for this page would fill in the vault_path of a
    // MEETINGS row, quietly turning a meeting into a desk document and handing T4's
    // pass a row it did not write. Reported rather than silently skipped: a page in
    // two databases is a thing only a human can untangle.
    //
    // This is the read that makes `PageStateRow.target` load-bearing rather than
    // decorative (review round 1, Minor 1).
    if (state !== undefined && state.target !== "docs") {
      skip(row,
        `that Notion page already has a state row from the ${state.target} database — ` +
        "creating a vault file for it would take over the row that pass owns");
      continue;
    }

    candidates += 1;

    // ── Where would it go? ───────────────────────────────────────────────────
    // Asked BEFORE the page is read, so a page that can never be placed costs no
    // API call on this tick or any later one.
    let folder: string;
    if (row.folder !== "") {
      // A filled Folder WINS (plan decision 3) — and is used exactly as typed. See
      // NotionBornRow.folder: repairing it here would mean this pass and the guards
      // disagree about what the human actually asked for.
      folder = row.folder;
    } else {
      const mapped = row.project === null ? [] : foldersByProject.get(row.project) ?? [];
      if (mapped.length === 0) {
        skip(row, row.project === null
          ? "the page has no Project and no Folder, so no vault folder can be chosen for it"
          : `the Project "${row.project}" is not one of the configured desk folders — ` +
            "set the page's Folder, add the desk dir to config, or leave it out on purpose");
        continue;
      }
      if (mapped.length > 1) {
        skip(row,
          `the Project "${row.project}" maps to more than one desk folder ` +
          `(${mapped.join(", ")}) — set the page's Folder to say which one`);
        continue;
      }
      folder = mapped[0];
    }

    const slug = transcriptSlug(row.title);
    if (slug === "") {
      skip(row, `the title ${JSON.stringify(row.title)} produces no usable filename`);
      continue;
    }
    const vaultPath = `${folder}/${slug}.md`;

    // GUARD — the SHAPE of the path (`refuseVaultTarget`): escapes, dot-directories,
    // control characters, whitespace-padded segments, byte budgets, `.md` only, and
    // the machine-owned areas `wiki/`, `_meta/` and `_archive/`. The identical
    // function refuses the identical path again at apply time and a third time
    // inside the writer, under the note lock — that is the guarantee. This call is
    // what makes the refusal a sentence Bendik can read instead of a proposal that
    // dies after he has already approved it.
    const refusal = refuseVaultTarget(vaultPath);
    if (refusal !== null) {
      skip(row, `that Folder and title give a path this service will not create: ${refusal}`, vaultPath);
      continue;
    }

    // GUARD — the PLACE, which no rule about the string can answer. `personal/x.md`
    // is a perfectly well-formed vault path and still a folder no pass was ever
    // configured to sync. Same predicate the apply pass re-checks.
    if (!opts.inCreateScope(vaultPath)) {
      skip(row,
        "that is not a folder this sync manages — a page can only land inside a " +
        "configured desk folder", vaultPath);
      continue;
    }

    // …and the refusal that is T6's own, in its two halves. Both say the same thing —
    // "another pass owns that sub-tree" — but they are two different facts about
    // config and only together do they cover it. See `isExcluded` and
    // `transcriptsDir`: the carve-out half misses a desk dir whose `exclude` line is
    // absent, which is exactly the config an operator produces by deleting one line.
    if (opts.isExcluded(vaultPath)) {
      skip(row,
        "that folder is carved out of the desk scope in config, so another pass owns " +
        "it — a page dropped there could never be kept in step again", vaultPath);
      continue;
    }
    if (opts.transcriptsDir !== undefined
      && opts.projects.some((p) => isUnderDir(vaultPath, `${p.vaultFolder}/${opts.transcriptsDir}`))) {
      skip(row,
        `that is a transcripts folder — the transcript pass owns it, and a page dropped ` +
        "there would be treated as a meeting note by one pass and a desk document by " +
        "another", vaultPath);
      continue;
    }

    // GUARD — NEVER OVERWRITE, half one: something is already at that path. The
    // create path only ever creates (plan decision 3), so a slug that lands on a
    // hand-written note is refused and REPORTED — merging Notion's version into it,
    // or over it, is the accident this whole task is reviewed hardest for. Asked
    // before the read, so a folder full of collisions costs no API calls.
    if (await deps.vaultFileExists(vaultPath)) {
      skip(row,
        "a vault file already exists at that path, and a create never overwrites — " +
        "retitle the page in Notion, or set its Folder", vaultPath);
      continue;
    }

    // …half two: a file that DIFFERS ONLY BY CASE OR UNICODE NORMALISATION. The
    // `lstat` above answers for the filesystem it is running on, and the vault lives
    // on two that disagree — see `NotionBornSyncDeps.listVaultFiles`. `transcriptSlug`
    // always lowercases, so `Notater.md` versus `notater.md` is not an exotic case,
    // it is what happens the first time a page is titled after a note Bendik already
    // wrote.
    // ONE predicate, shared verbatim with apply's guard 3b (`findCollidingPath`,
    // vault-target.ts). Round 2 shared only the KEY and let the two sides build
    // different comparisons on it, which is how apply ended up blind to a variant in
    // an ancestor directory. The function is the contract now, not the key.
    const collision = findCollidingPath(vaultPath, await onDisk());
    if (collision !== null) {
      skip(row,
        `the vault already holds ${collision}, which is the SAME FILE as that path on ` +
        "macOS (they differ only in capitalisation or unicode form) — a create never " +
        "overwrites; retitle the page in Notion, or set its Folder", vaultPath);
      continue;
    }

    // …half three: a STATE ROW already owns that path, even though nothing is on disk
    // there. The file was retired to `_archive/` when its Notion page was trashed, and
    // the row still points at the old path. Approving a create here is refused by
    // apply's guard 0 — so without this the same proposal is raised, approved,
    // superseded and raised again, every tick, forever. See `trackedBy`.
    const tracked = trackedBy.get(vaultPath);
    if (tracked !== undefined) {
      skip(row,
        `the vault still tracks that path as the projection of another Notion page ` +
        `(${tracked}), so a file created there could never be approved — retitle this ` +
        "page in Notion, or set its Folder", vaultPath);
      continue;
    }

    // …and half four: another page has already claimed this filename. Seeded from the
    // open proposals and extended as this tick proposes, so two pages slugging the
    // same way are caught whether the first claim was made last week or four lines
    // ago. Reported rather than silently dropped: only a human can tell the two
    // pages apart, and retitling one of them in Notion is the fix.
    const claimant = claimedBy.get(vaultPath);
    if (claimant !== undefined && pageKey(claimant) !== pageKey(row.pageId)) {
      skip(row,
        `another Notion page (${claimant}) already has an open proposal for that exact ` +
        "path — two page titles are slugging to the same filename; retitle one of them",
        vaultPath);
      continue;
    }

    // ── What does Notion hold? ───────────────────────────────────────────────
    // NO TIMESTAMP PRE-FILTER, for the reason the transcript pass states at length:
    // a row awaiting its first vault file has no watermark to compare against, and
    // the content hash is the whole change test (spec §3). The cost is one
    // `GET /markdown` per placeable Notion-born page per tick — and in steady state
    // that set is empty, because an approved create fills in the row's vault_path
    // and a page then leaves this pass's subject entirely.
    //
    // With ONE named exception, because it is permanent rather than transient (review
    // round 1, Minor 3): a page Bendik DECLINED stays Notion-born forever — no vault
    // file, so no `vault_path`, so it is a candidate on every tick — and its `accounted`
    // branch below needs the hash to recognise it, which needs the read. So each
    // declined page costs one `GET /markdown` an hour, indefinitely. Twenty declines is
    // twenty extra calls an hour against Notion's ~3 req/s budget: real, bounded, and
    // not worth a second watermark column to avoid. `notion_last_edited` cannot be
    // borrowed for it — `recordNotionAccounted` deliberately touches `notion_hash` and
    // nothing else, and giving that column a second meaning is the mistake this phase
    // has already made three times.
    read += 1;
    let markdown: string;
    try {
      markdown = await deps.getPageMarkdown(row.pageId);
    } catch (err) {
      // Contained per page. Nothing is recorded: `recordDocError` is an UPDATE keyed
      // on vault_path and this page has none, so the honest consequence of a failed
      // read is that nothing moves and the next tick tries again.
      errored += 1;
      console.error(`notion-sync: notion-born: page read failed for ${row.pageId}: ${errorMessage(err)}`);
      continue;
    }

    // THE change test — and it is Notion's RAW markdown, because that is what the
    // desk pull will hash for this row from the tick after the create lands. See
    // decision 1 in the header: any other definition converges on nothing.
    const notionHash = sha256(markdown);

    // Content this row has already ACCOUNTED FOR. For a row with no vault file that
    // means exactly one thing: Bendik looked at this version and said no, and the
    // apply pass recorded it (`recordNotionAccounted`). T4's policy, reused rather
    // than reinvented — reject means "not this content", never "never this
    // document" — so a LATER edit to the page hashes differently and arrives as its
    // own fresh question.
    if (state?.notionHash != null && state.notionHash === notionHash) {
      accounted += 1;
      continue;
    }

    // …and the same decision one step earlier in its life: rejected, but the apply
    // pass has not carried it out yet — it runs later in THIS tick. Re-proposing
    // here would hand him back the file he just declined. Nothing happens for this
    // page at all, so the state stays honest until the decline lands.
    if ((rejectedByPage.get(pageKey(row.pageId)) ?? []).some((p) => p.notionHash === notionHash)) {
      awaitingDecline += 1;
      continue;
    }

    // ── Compose the file ─────────────────────────────────────────────────────
    if (resolvePage === undefined) resolvePage = buildPageResolver(await deps.getDeskRows());
    let body: string;
    try {
      const parsed = parseNotionPage(markdown, { resolvePage });
      // The pull-direction rail (spec §4.4 as amended), applied for the same reason
      // pull applies it: this file is about to become an ordinary desk document, and
      // a Notion-signed URL baked into it goes stale within the hour. Refused whole,
      // never sanitised. Reported rather than frozen — `freezeDoc` is an UPDATE
      // keyed on vault_path, and this page has none, so a freeze here would update
      // nothing and hand Bendik a `notion-sync resolve` command that finds no row.
      assertPullSafe(parsed.body);
      body = parsed.body;
      for (const warning of parsed.warnings) {
        console.warn(`notion-sync: notion-born: ${vaultPath}: ${warning}`);
      }
    } catch (err) {
      skip(row, `Notion's content cannot be brought into the vault: ${errorMessage(err)}`, vaultPath);
      continue;
    }
    const proposedBody = notionBornFile({ title: row.title, body, pageId: row.pageId });

    // Never stack (§18.4): an open proposal already carrying exactly this file IS
    // this file's proposal — left as it stands, no supersede, no duplicate, which is
    // what makes the pass tick-stable rather than a re-propose loop.
    //
    // Compared on the composed FILE and the PATH, not on `notionHash` alone, and
    // that is deliberate. A retitle in Notion returns byte-identical markdown (the
    // title is a property), and so does a change to `Folder` — so a hash-only test
    // would leave a pending proposal carrying the old title, or the old path, and
    // Bendik's 👍 would then create a file he had already asked Notion to rename.
    const open = openByPage.get(pageKey(row.pageId)) ?? [];
    if (open.some((p) => p.notionHash === notionHash
      && p.proposedBody === proposedBody && p.vaultPath === vaultPath)) {
      awaitingApproval += 1;
      continue;
    }

    if (opts.dryRun) {
      // Claimed in the dry-run branch too, so a preview reports the same skips a
      // live run would — the "two pages slug to the same filename" skip can only be
      // discovered by an in-tick claim, and an operator runs the preview precisely
      // to see it (the posture T4's review round 1 settled).
      claimedBy.set(vaultPath, row.pageId);
      superseded += open.length;
      proposed += 1;
      continue;
    }

    // Supersede first: an open proposal for this page describes a file Notion has
    // moved on from, and it may sit at a DIFFERENT path than the one being proposed
    // now (a changed `Folder`), which the per-path unique index cannot collapse on
    // its own.
    //
    // INCLUDING AN APPROVED ONE, which is where this differs from pull — and the
    // asymmetry is deliberate rather than an oversight (review round 1, Minor 2).
    // `proposeDesk` special-cases `state === "approved"` and leaves it alone, because
    // apply runs LATER IN THIS SAME TICK and will land it: superseding there would
    // throw away a decision that was about to take effect on content still worth
    // writing. For a create the content it was about to write is a FILE WHOSE TITLE
    // OR PATH IS NOW WRONG — the H1 is baked into the proposed body and the path is
    // baked into the row, and neither can be corrected afterwards by any pass. So the
    // honest move is to discard the tap and ask again with the right file. Nothing is
    // written either way; what he loses is the tap, and Saga asks once more.
    for (const stale of open) {
      superseded += 1;
      await tryRecord("supersede", row.pageId, () => deps.setProposalState(stale.id, "superseded"));
    }

    // THE ROW HAS TO EXIST BEFORE THE PROPOSAL DOES. This is T4's contract, and it is
    // enforced rather than documented: a rejected create is remembered by
    // `recordNotionAccounted`, which is keyed by page and THROWS on a zero-row match,
    // and apply runs it inside the same tryRecord as the close — so a proposal raised
    // against a page with no row would leave the rejection unexecuted and retried
    // forever. NOT contained: if the row cannot be made, this page is not proposed
    // this tick, because a decision about it would have nowhere to be recorded.
    // Nothing is lost — the next tick starts again from the top.
    try {
      await deps.ensureDocsRow(row.pageId);
    } catch (err) {
      bookkeepingFailed += 1;
      console.error(
        `notion-sync: notion-born: could not create the state row for ${row.pageId}: ` +
        `${errorMessage(err)} — not proposing ${vaultPath}, because a decision about it ` +
        "would have nowhere to be recorded",
      );
      continue;
    }

    // Counted INSIDE the tryRecord, after the insert resolves (review round 1,
    // Minor 8). Outside it, a failed `insertProposal` reported a proposal that does
    // not exist — `bookkeepingFailed` made the tick visibly unclean, so nothing was
    // lost silently, but the number an operator reads was wrong about the one thing
    // it names.
    await tryRecord("propose", row.pageId, async () => {
      await deps.insertProposal({
        vaultPath,
        notionPageId: row.pageId,
        proposedBody,
        // A create is proposed against no vault render, and the apply engine ASSERTS
        // that (its guard 1) rather than assuming it.
        baseMdHash: "",
        notionHash,
        // Every proposal needs a real preview: it is the only thing Bendik sees
        // before tapping. A create has no "before" side, so this reads as a
        // `+`-prefixed head of the new file, which is exactly what it is.
        diffPreview: diffPreview("", proposedBody),
        kind: "create",
      });
      proposed += 1;
      // Claimed only once the proposal REALLY exists, so a second page slugging to
      // the same path is never told "another page already has an open proposal" when
      // none was raised.
      claimedBy.set(vaultPath, row.pageId);
      // NO PING (spec §20.4, ORB-38): Saga polls the proposals table and opens the DM
      // with the buttons. Pinging here as well would tell him the same thing twice on
      // two surfaces, and a proposal nobody answers is already covered better, by the
      // stale-proposal escalation the pull pass runs. The log line is inside the
      // tryRecord for the same reason the counter is: it claims a proposal exists.
      console.log(
        `notion-sync: notion-born: proposed NEW FILE ${vaultPath} from Notion page ${row.pageId}` +
        `${open.length === 0 ? "" : " (supersedes an earlier proposal)"} — awaiting Bendik's decision`,
      );
    });
  }

  return {
    scanned: remote.length,
    candidates,
    read,
    accounted,
    proposed,
    superseded,
    awaitingApproval,
    awaitingDecline,
    errored,
    bookkeepingFailed,
    skipped,
    summary:
      `${candidates} Notion-born of ${remote.length} scanned, ${read} read, ` +
      `${accounted} already accounted for, ${proposed} proposed, ${superseded} superseded, ` +
      `${awaitingApproval} awaiting approval, ${awaitingDecline} awaiting decline, ` +
      `${skipped.length} skipped, ${errored} errored, ` +
      `${bookkeepingFailed} bookkeeping-failed${opts.dryRun ? " (dry-run)" : ""}`,
  };
}
