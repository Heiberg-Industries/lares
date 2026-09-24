// The execution half of the 👍 loop (Phase 3 plan T5, spec §18.4): proposals a
// human has decided on, carried out. runPullSync produces proposals and never
// touches the vault; this engine is the ONLY code in the service that writes a
// vault file — and it does so through an injected dep, so the pure engine stays
// pure and the locking/git side lives in lib/adapters/vault-writer.ts.
//
// Two decisions, two shapes:
//   - approved → the Notion body lands in the vault, under the file's OWN
//     frontmatter block read verbatim at apply time. Frontmatter travels to Notion
//     as a property and is deliberately NOT round-tripped back: an edit to the
//     Frontmatter property in Notion is ignored and overwritten by the next push.
//   - rejected → ONE OF THREE things, decided by what the proposal is about, not by
//     the button (Phase 4). For a mirror or two-way row the Notion page is reverted
//     from the vault, exactly like a mirror row's revert, and the rejection is only
//     closed once that write has happened — see store.ts setProposalState for why
//     resolved_at carries that meaning. For a NOTION-OWNED row nothing is written on
//     either side (the page is the source; the vault file is its copy) and only the
//     watermark moves, so pull stops re-asking. For a CREATE nothing was ever written,
//     so there is nothing to revert. The canonical sentences for all three live in
//     @lares/agent-box's rejectConsequence, which every human-facing surface renders.
//
// Two rails make this safe to run unattended, and they apply to BOTH decisions:
// a decision is carried out only if the row is 'synced' (a frozen row belongs to
// the human who owes it a `notion-sync resolve`), and an approval only if the
// vault file still renders to the hash it was proposed against. Anything else is
// stale, and a stale proposal is superseded and frozen — never written.
//
// Phase 4 (T3b) adds a THIRD shape to the same engine: a proposal of kind 'create',
// for a vault file that does not exist yet (a Meetings transcript, T4; a Notion-born
// page, T6). It is a branch inside this loop rather than a second pass or a second
// approval surface, because the constraint is absolute — one queue, one 👍, one
// execution path (spec §18.4/§20). Every rail above inverts or falls away for it and
// is replaced by its own, and those replacements are the security boundary of the
// whole phase: see the create branch below.
import { assertPushSafe } from "./translate.js";
import { sha256 } from "./wiki-sync.js";
import {
  docRenderHash, splitFrontmatter, vaultBodyHash,
  type PullDocProps, type RenderedDoc,
} from "./pull-sync.js";
// Straight from @lares/vault-format — the dependency-free package, not the role kit this
// service must never import (the sync-jobs image does not contain it).
import {
  originAfterWrite, originFrontmatterLine, readOriginFrontmatter, upsertOriginFrontmatter,
} from "@lares/vault-format/origin";
import { refuseVaultTarget, findCollidingPath } from "./vault-target.js";
import { NOTION_TO_MD, notionOwns } from "./direction.js";
import type { DocSyncedInput, LinkedFileInput, LinkedRow, ProposalRow, ProposalState } from "./store.js";

export interface ApplySyncOptions {
  dryRun: boolean;
  /**
   * May a CREATE target this vault path? (`makeCreateScope`, desk-scope.ts.)
   *
   * Required rather than optional-defaulting-to-allow, deliberately: a create's
   * path comes from Notion content, and an engine wired without a scope check would
   * accept any shape-valid path anywhere in the vault while looking correctly
   * configured. A missing argument is a compile error; a silent default would be a
   * hole nobody sees.
   *
   * Consulted ONLY in the create branch. An update writes a file that already has a
   * synced row, which the push pass could only have adopted from a configured
   * directory — in scope by construction.
   */
  inCreateScope: (vaultPath: string) => boolean;
}

export interface ApplySyncDeps {
  /** pending + approved; this engine acts only on the approved ones. */
  getOpenProposals: () => Promise<ProposalRow[]>;
  /** Rejected proposals whose Notion page has not been reverted yet. */
  getRejectedUnexecuted: () => Promise<ProposalRow[]>;
  /**
   * Every row that HAS a vault file, keyed by path, across BOTH targets
   * (store.ts getLinkedRows) — NOT the desk-only `getDeskRows` this used to be.
   *
   * The question this engine asks is "what is the state row for the vault file this
   * decision is about?", and from Phase 4 on a transcript's answer is its MEETINGS
   * row: `notion_page_id` is globally UNIQUE, so a transcript cannot have a second
   * row of its own, and its Meetings row is where `vault_path` belongs (T4). With a
   * docs-only read every transcript proposal resolved to "row missing" and was
   * skipped, on every tick, forever.
   *
   * ONE lookup with one meaning, deliberately, rather than a second target-aware
   * read beside it: `vault_path` is UNIQUE across the whole table, so a path
   * identifies at most one row whatever database it came from. Widening it also
   * hands the create branch's page-uniqueness guard the meetings rows for free.
   */
  getLinkedRows: () => Promise<Map<string, LinkedRow>>;
  renderDoc: (vaultPath: string) => Promise<RenderedDoc>;
  readVaultFile: (vaultPath: string) => Promise<string>;
  /** Verbatim bytes, under the note lock, committed to the vault's git (T7 wiring). */
  writeVaultFile: (vaultPath: string, content: string) => Promise<void>;
  /**
   * Does a vault file exist at this path RIGHT NOW? Asked immediately before a
   * create, never at propose time — see the create branch's never-overwrite guard.
   */
  vaultFileExists: (vaultPath: string) => Promise<boolean>;
  /**
   * Creates a file that does not exist yet, and REFUSES if it does. A separate dep
   * from writeVaultFile, not a flag on it: writeVaultFile overwrites by design and
   * this one must never overwrite anything, and one call site away from each other a
   * boolean would eventually be wrong. The adapter enforces the same guards this
   * engine checks (O_EXCL, real-path resolution, the shared shape rules), so a create
   * cannot be smuggled past them by any caller.
   */
  createVaultFile: (vaultPath: string, content: string) => Promise<void>;
  /**
   * Every existing vault path that could be the SAME FILE as a create's target on a
   * case-/normalisation-insensitive filesystem (adapters/vault-files.ts
   * `listCollisionCandidates`) — guard 3b's input (T6 review rounds 2–3).
   *
   * It exists because `vaultFileExists` is an `lstat`, and an `lstat` answers for the
   * filesystem it is running on. The box is case-SENSITIVE and the machine the vault
   * is read on is not, so `Notater.md` and `notater.md` are two files here and one
   * there — the guard says "nothing at that path", `O_EXCL` succeeds, and the commit
   * the box pushes shadows a hand-written note the moment it is pulled. `O_EXCL`
   * cannot close this: the two names really are two inodes on ext4. The comparison
   * has to be made in the engine, in the form both filesystems agree about
   * (`collisionKey`, vault-target.ts).
   *
   * Vault-relative PATHS, not basenames, and the ancestry is resolved
   * case-insensitively before listing — see the adapter. Both properties matter: with
   * basenames, or with a literally-spelled parent, this engine would be asking a
   * NARROWER question than the propose side, and round 2 shipped exactly that gap.
   *
   * REQUIRED, like `inCreateScope` and for the identical reason: an optional member
   * defaulting to "nothing collides" would be a hole nobody sees. And required is only
   * half the answer — `assertCollisionLookupIsReal` is the other half, because a
   * type-level guarantee cannot catch a call site that passes something
   * wrong-but-present.
   */
  listCollisionCandidates: (vaultPath: string) => Promise<string[]>;
  patchPageMarkdown: (pageId: string, markdown: string) => Promise<void>;
  updateDocProps: (pageId: string, props: Partial<PullDocProps>) => Promise<void>;
  getPageMarkdown: (pageId: string) => Promise<string>;
  upsertDocSynced: (doc: DocSyncedInput) => Promise<void>;
  /**
   * Binds a vault file to the page it came from, keyed on `notion_page_id`
   * (store.ts linkPageToVaultFile) — the create branch's bookkeeping, and the hash
   * refresh after a Notion-owned vault write.
   *
   * Keyed by PAGE rather than by path because a create's identity IS its page: the
   * path is what it is asking to bring into existence. For a transcript the row
   * already exists (its Meetings row, with a NULL vault_path), and a path-keyed
   * upsert would have tried to INSERT and violated `notion_page_id UNIQUE` — leaving
   * a file on disk that no row points at, which the push pass then adopts into a
   * SECOND Notion page.
   */
  linkPageToVaultFile: (doc: LinkedFileInput) => Promise<void>;
  /**
   * Moves `notion_hash` (and the watermark) without touching state, md_hash or the
   * error count. Used for a rejected edit on a Notion-owned row: the decision is
   * recorded so pull stops re-proposing it, and nothing is written to either side.
   */
  updateNotionWatermark: (
    vaultPath: string, notionHash: string, notionLastEdited: string | null,
  ) => Promise<void>;
  /**
   * The same record, keyed by PAGE — the only key a rejected CREATE has, because the
   * whole point of a rejected create is that no vault file, and so no path-bearing
   * row, exists. See the rejected-create branch for the policy this implements.
   */
  recordNotionAccounted: (pageId: string, notionHash: string) => Promise<void>;
  setProposalState: (id: number, state: ProposalState) => Promise<void>;
  markProposalReverted: (id: number) => Promise<void>;
  freezeDoc: (vaultPath: string, reason: string) => Promise<void>;
  recordDocError: (vaultPath: string, message: string) => Promise<void>;
  notify: (message: string) => Promise<void>;
  /**
   * Was this vault path forgotten (a `note`-kind `forget_ledger` row, ADR-0017 rule
   * 7: "a Notion pull or a Brain restore cannot silently resurrect a retired fact")?
   * Answers the date it was forgotten, or `null` when it was not — never the
   * forgotten words, which the ledger does not hold (it is hash-only).
   *
   * Consulted ONLY by the CREATE branch, immediately before guard 1. An UPDATE
   * writes to a file that already exists on disk right now, which is not what this
   * ledger is about — it stops resurrection, not edits — so the update loop never
   * calls this dependency at all.
   *
   * MUST NEVER let a ledger failure or an unreachable database stop the tick: the
   * wiring answers `null` for a missing `forget_ledger` table, an installation whose
   * single owner this service cannot yet resolve, or any other read failure — the
   * ledger is a guard, not a dependency. `applyCreate` also catches a throw from
   * this function itself and treats it the same way, belt and braces.
   */
  pathWasForgotten: (vaultPath: string) => Promise<Date | null>;
}

export interface ApplySyncResult {
  /** Proposals this engine had a decision to act on (approved + rejected-unexecuted). */
  scanned: number;
  applied: number;
  reverted: number;
  /**
   * Rejections carried out by writing NOTHING to either side, and then closing.
   *
   * Two shapes reach it: a rejected CREATE (the vault file was never made, so there
   * is no vault content to revert a page from) and a rejected update on a
   * NOTION-OWNED row (the page is the source, so reverting it from its own copy is
   * the write that direction forbids — only the watermark moves, so pull stops
   * re-asking).
   *
   * Counted apart from `reverted` because calling either one "reverted" is a lie in
   * the operator's summary, and apart from `skipped` because nothing is still owed.
   */
  declined: number;
  superseded: number;
  frozen: number;
  /**
   * Decisions this engine deliberately did not carry out — the row is frozen,
   * erroring or missing, so a human owns it (I2: the same gate for an approval
   * and for a rejection). They stay queued and land once the row is synced again.
   */
  skipped: number;
  errored: number;
  bookkeepingFailed: number;
  summary: string;
}

const STALE_REASON =
  "the vault file changed after this Notion edit was approved — nothing was written";
const MIRROR_CHILD_REASON = "sub-page added under a mirror row — move it out, then resolve";
const CHILD_CONTENT_ERROR = /child|allow_deleting_content/i;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Direction seeded on the row a create leaves behind.
 *
 * `notion_to_md`, not the store's ordinary `md_to_notion` default: a mirror row means
 * "the vault authored this and Notion is its projection", which is backwards for a
 * file Notion authored and the vault has only just received. Promotion to `two_way`
 * stays where it has always been — the explicit `enable-two-way` behind the fidelity
 * gate (§4.5/§18.3), never a side effect of a write.
 *
 * That value now MEANS something on every pass (fix round 1): pull proposes rather
 * than reverting, a trashed page retires the file rather than being recreated from
 * it, push writes nothing at all, and the page is stamped 📥 Notion source and left
 * unlocked. See direction.ts — until that landed, this constant behaved exactly like
 * `md_to_notion` and the comment above was a claim the code did not implement.
 */
const CREATED_DIRECTION = NOTION_TO_MD;

export async function runApplySync(opts: ApplySyncOptions, deps: ApplySyncDeps): Promise<ApplySyncResult> {
  const approved = (await deps.getOpenProposals())
    .filter((proposal) => proposal.state === "approved")
    .sort((a, b) => a.id - b.id);
  const rejected = [...await deps.getRejectedUnexecuted()].sort((a, b) => a.id - b.id);

  let applied = 0;
  let reverted = 0;
  let declined = 0;
  let superseded = 0;
  let frozen = 0;
  let skipped = 0;
  let errored = 0;
  let bookkeepingFailed = 0;

  async function tryRecord(what: string, vaultPath: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      bookkeepingFailed += 1;
      console.error(`notion-sync: bookkeeping write failed (${what}) for ${vaultPath}: ${errorMessage(err)}`);
    }
  }

  /** Best-effort, never fatal, silent in dry-run — same contract as the pull pass. */
  async function ping(message: string): Promise<void> {
    if (opts.dryRun) return;
    try {
      await deps.notify(message);
    } catch (err) {
      console.error(`notion-sync: notify failed: ${errorMessage(err)}`);
    }
  }

  async function fail(vaultPath: string, what: string, err: unknown): Promise<void> {
    errored += 1;
    const message = errorMessage(err);
    console.error(`notion-sync: ${what} failed for ${vaultPath}: ${message}`);
    if (!opts.dryRun) {
      await tryRecord("error", vaultPath, () => deps.recordDocError(vaultPath, message));
    }
  }

  // One read for both loops. Taken up front rather than lazily because BOTH
  // decisions are now gated on the row's state (I2) — see the gate below.
  const rows = approved.length + rejected.length === 0
    ? new Map<string, LinkedRow>()
    : await deps.getLinkedRows();

  /**
   * Defence in depth against a mis-wired scope predicate (fix round 2).
   *
   * `inCreateScope` being REQUIRED is a type-level guarantee, and a type-level
   * guarantee cannot catch a call site that passes something wrong-but-present —
   * `() => true` compiles perfectly and silently turns the scope guard off, letting
   * an approved create write anywhere shape-valid in the vault. The same hole
   * archive-excluded names for `isExcluded`, answered the same way it was there.
   *
   * The sentinel is a path no configuration can legitimately manage: `deskDirs[].dir`
   * is validated as a bare vault-relative folder (config.ts), so no desk dir can
   * begin with a `..` segment and nothing under one can be in scope. A predicate that
   * says yes to it is not scoping anything.
   *
   * Checked once per run, and only when there is a create to protect, so a tick with
   * none pays nothing.
   */
  const SCOPE_SENTINEL = "../definitely-not-a-configured-desk-dir/probe.md";
  let scopeChecked = false;
  function assertScopePredicateIsReal(): void {
    if (scopeChecked) return;
    scopeChecked = true;
    if (opts.inCreateScope(SCOPE_SENTINEL)) {
      throw new Error(
        "notion-sync: apply: inCreateScope accepted a path no config can manage " +
        `("${SCOPE_SENTINEL}") — refusing to run creates against a scope predicate ` +
        "that is not scoping anything (wire makeCreateScope(cfg), not a stub)",
      );
    }
  }

  /**
   * The same defence, for the same reason, on the OTHER guard whose value can be
   * wrong-but-present (T6 review round 3).
   *
   * `listCollisionCandidates` was made REQUIRED on the argument that this is "like
   * `inCreateScope`, for the identical reason" — and then only the type-level half was
   * taken. The type-level half is exactly the half that cannot catch a mis-wire:
   * changing the composition root to `async () => []` compiled, ran, and left the
   * entire package green while guard 3b was silently off at the only call site that
   * runs on the box.
   *
   * **TWO probes whose correct answers CONTRADICT each other**, and that shape is the
   * whole point (review round 4). The first version asked one question whose only
   * failing answer was emptiness — so `async () => []` failed it and
   * `async () => [".git"]`, an equally plausible stub, sailed through with guard 3b
   * completely off. `inCreateScope`'s sentinel works because it is a semantic
   * contradiction, not because it is a probe; this one had to become one too.
   *
   *  1. **A file at the VAULT ROOT must find something.** A real adapter answers with
   *     the root's own entries — a git clone always has at least `.git`, and a
   *     deployment has desk folders besides. Empty means the dep is a stub or the
   *     vault mount is gone, and both forbid running creates. (The push pass's
   *     empty-listing guard refuses on identical reasoning.)
   *  2. **A file under an ancestor that cannot exist must find NOTHING.** No directory
   *     is named `___notion-sync-wiring-probe___`, so a real adapter resolves that
   *     segment against the root, matches nothing, and returns `[]` before listing
   *     anything at all.
   *
   * No constant function can satisfy both. `() => []` fails the first, `() => [x]`
   * fails the second, and anything that answers correctly has to have looked at the
   * argument AND at the vault.
   *
   * Neither sentinel NAME can collide with something a create could target: both are
   * rooted at a path `makeCreateScope` cannot accept (it requires a configured desk
   * dir prefix), so the probe can never be mistaken for a real question.
   *
   * Checked once per run and only when there is a create to protect, exactly like the
   * scope probe above.
   */
  const CANDIDATES_ROOT_SENTINEL = "___notion-sync-wiring-probe___.md";
  const CANDIDATES_ABSENT_SENTINEL = "___notion-sync-wiring-probe___/probe.md";
  let candidatesChecked = false;
  async function assertCollisionLookupIsReal(): Promise<void> {
    if (candidatesChecked) return;
    candidatesChecked = true;
    const refuse = (why: string): never => {
      throw new Error(
        `notion-sync: apply: the collision lookup ${why} — refusing to run creates ` +
        "against a lookup that is not reading the vault (wire the vault walker, not a " +
        "stub; or the vault mount is missing)",
      );
    };
    if ((await deps.listCollisionCandidates(CANDIDATES_ROOT_SENTINEL)).length === 0) {
      refuse(`found nothing beside a file at the vault root ("${CANDIDATES_ROOT_SENTINEL}")`);
    }
    if ((await deps.listCollisionCandidates(CANDIDATES_ABSENT_SENTINEL)).length !== 0) {
      refuse(
        `answered for a directory that does not exist ("${CANDIDATES_ABSENT_SENTINEL}"), ` +
        "so it is not resolving the path it was given",
      );
    }
  }

  /**
   * A create that must not happen. Superseded — not left queued, not frozen.
   *
   * Not queued, because every reason a create is refused is permanent from this
   * engine's point of view: a file now exists there, a row now exists for it, or the
   * path was never one this service may write. Re-checking on the next tick would
   * re-refuse and re-ping, hourly, forever.
   *
   * Not frozen, because a freeze is a claim about a DOC ROW — "both sides moved,
   * nothing is written on either, a human owes a `notion-sync resolve`". For a
   * refused create there is either no row at all (freezeDoc would silently update
   * nothing) or a perfectly healthy synced row that has done nothing wrong. Freezing
   * it would stop that file's ordinary sync and demand a resolve for a conflict that
   * does not exist.
   *
   * The ping is the whole point of the refusal: a create that vanishes silently is
   * indistinguishable from a sync that quietly stopped working, and Bendik tapped
   * Approve — he is owed the answer.
   */
  async function refuseCreate(proposal: ProposalRow, reason: string): Promise<void> {
    superseded += 1;
    console.warn(`notion-sync: refused create for ${proposal.vaultPath} — ${reason}`);
    if (opts.dryRun) return;
    await tryRecord("supersede", proposal.vaultPath, () =>
      deps.setProposalState(proposal.id, "superseded"));
    await ping(`refused: ${proposal.vaultPath} was NOT created — ${reason}`);
  }

  /**
   * Hash-after-write for a vault write on a NOTION-OWNED row: re-render what was
   * just written and store it beside the Notion hash the proposal carried, so the
   * next tick's conflict check compares like with like and finds nothing to react
   * to. Used by the approved-update path; the create branch does the same thing
   * inline because it also has a row to INSERT rather than update.
   *
   * The render is best-effort by design. If it fails, an empty md_hash is left
   * behind, which the next tick reads as a conflict and freezes — visibly, with a
   * human owning it. That is the right failure: the alternative is inventing a hash
   * for bytes nobody read back, which is exactly the class of lie the whole
   * hash-after-write discipline exists to prevent.
   *
   * `notionLastEdited` is carried through from the row, never invented (the same
   * rule the reject path follows): this engine took no reading from Notion.
   */
  async function reconcileAfterVaultWrite(
    vaultPath: string, proposal: ProposalRow, row: LinkedRow, written: string,
  ): Promise<void> {
    let rendered: RenderedDoc | undefined;
    try {
      rendered = await deps.renderDoc(vaultPath);
    } catch (err) {
      console.warn(
        `notion-sync: wrote ${vaultPath} but could not re-render it for a hash: ` +
        `${errorMessage(err)} — the next tick will see a conflict and freeze it`,
      );
    }
    // Keyed on the PAGE, like the create branch, and for a reason beyond symmetry:
    // the path-keyed upsert also resets `state` to 'synced' and zeroes the error
    // count, which is harmless for a docs row (the gate above already proved it was
    // 'synced') and wrong for a MEETINGS row, where `state` is the attendee pass's
    // verdict about a calendar match and none of this pass's business.
    await tryRecord("synced", vaultPath, () => deps.linkPageToVaultFile({
      vaultPath,
      pageId: proposal.notionPageId,
      mdHash: rendered === undefined ? "" : docRenderHash(rendered),
      // What the vault now holds IS this Notion content, translated. Saying so is
      // the reconciliation; no Notion write is claimed, because none is owed.
      notionHash: proposal.notionHash,
      notionLastEdited: row.notionLastEdited,
      direction: row.direction,
      // What a MEETINGS row stores instead of the render hash above — computed from
      // the bytes just written, so it needs no re-render and can never be "".
      writtenBodyHash: vaultBodyHash(written),
    }));
  }

  /**
   * May this engine write the vault file behind this row?
   *
   * For a DOCS row the answer is the one it has always been: only a 'synced' row.
   * Frozen, erroring or orphaned means a human owes a `notion-sync resolve`, and
   * writing underneath that decision would overwrite the very content they are
   * looking at.
   *
   * For a MEETINGS row (Phase 4 — a transcript's state row IS its Meetings row)
   * `state` is a DIFFERENT pass's verdict about a DIFFERENT question. The attendee
   * pass writes 'unmatched' when it cannot find a calendar event for the meeting (6
   * of the 50 live rows) and 'retrying'/'error' when a Notion `Attendees` write
   * failed — none of which says anything about whether the transcript may be
   * written. Gating on it would mean a meeting whose calendar match failed could
   * never receive its transcript, silently, forever.
   *
   * And there is nothing to gate: no code in this service can put a meetings row
   * into a state a human owes a decision on. `freezeDoc`, `markDocOrphaned` and
   * `recordDocError` are all `target='docs'`, so the freeze-and-flag machinery this
   * gate exists to protect cannot reach one. The transcript pass makes the
   * equivalent refusal itself, before proposing (transcript-sync.ts).
   */
  function engineMayWrite(row: LinkedRow): boolean {
    return row.target === "meetings" || row.state === "synced";
  }

  /**
   * The approved-create path. Every rail the update path relies on is meaningless
   * here — there is no file to render, no base hash to re-check, no frontmatter block
   * to lift from disk — so this branch carries its own, and they are the security
   * boundary of the whole phase.
   *
   * THE TIMING IS THE POINT. A proposal sits in the queue between being proposed and
   * being approved; Bendik may take minutes or days. Everything below re-checks the
   * world as it is NOW, immediately before the write, never as it was when the
   * proposal was made. A guard checked only at propose time is a time-of-check /
   * time-of-use hole: a human creates a file at that exact path in the window and the
   * approval silently overwrites hand-written work. That is the accident this exists
   * to make impossible.
   */
  async function applyCreate(proposal: ProposalRow, row: LinkedRow | undefined): Promise<void> {
    const vaultPath = proposal.vaultPath;

    // GUARD 0 — the row gate, INVERTED. The update path requires a synced row; a
    // create requires no row at all. A row means this path is already a tracked
    // participant, so the create is asking for something that has already happened —
    // by a human, by an earlier tick, or by an earlier apply of this same proposal
    // whose bookkeeping half failed. Writing would be a duplicate or an overwrite.
    if (row !== undefined) {
      // Two different stories end here, and telling the wrong one is worse than
      // saying nothing. If the row points at THIS proposal's page, the file was
      // created — by an earlier run of this very proposal whose `applied` flip
      // failed afterwards (tryRecord counts that, it does not abort). Saying "was
      // NOT created" then is the exact opposite of the truth, and Bendik would go
      // looking for a file that is sitting right there.
      if (row.pageId === proposal.notionPageId) {
        superseded += 1;
        console.warn(
          `notion-sync: create for ${vaultPath} already landed — closing the proposal ` +
          `(its 'applied' flip must have failed on an earlier tick)`,
        );
        if (!opts.dryRun) {
          await tryRecord("applied", vaultPath, () => deps.setProposalState(proposal.id, "applied"));
          await ping(`${vaultPath} was already created from this Notion page — nothing more to do`);
        }
        return;
      }
      await refuseCreate(proposal, `the vault already tracks that file (row state: ${row.state})`);
      return;
    }

    // …and the same question asked of the PAGE, not the path. A create binds its new
    // file to the Notion page it came from, and notion_page_id is UNIQUE: if that page
    // already belongs to some other vault file — it was adopted under a different name
    // while this proposal waited, or the same page was proposed twice under two slugs
    // — the row insert below would violate the constraint, leaving a file on disk that
    // no row points at. The push pass then adopts that orphan and creates a SECOND
    // Notion page for content Notion already holds. Cheap to check: the row snapshot
    // is already in memory.
    const boundTo = [...rows].find(([, r]) => r.pageId === proposal.notionPageId);
    if (boundTo !== undefined) {
      await refuseCreate(
        proposal,
        `that Notion page is already the source of ${boundTo[0]} — creating a second ` +
        `file for it would split the document in two`,
      );
      return;
    }

    // GUARD 0c — the forget ledger (ADR-0017 rule 7). A file the owner told the
    // agent to forget must not come back the moment Notion offers it again. Asked
    // here, before any of the guards below, because it is a veto independent of
    // path shape, scope or collisions: nothing past this point should run for a
    // path the owner has already said no to.
    //
    // `refuseCreate` is reused rather than a bespoke reply, deliberately: it is the
    // SAME channel every other refused create reaches the owner through (a ping, and
    // the proposal closes as superseded rather than retrying hourly) — "in the same
    // place other refusals surface, never silently dropped". A `freezeDoc` is not
    // this branch's tool: guard 0 above proves no row exists for this path, and
    // freezeDoc is an UPDATE keyed on vault_path that would silently touch nothing
    // (the same reasoning `refuseCreate`'s own header gives for every create refusal).
    //
    // NEVER STOPS THE SYNC. `pathWasForgotten`'s contract already promises never to
    // throw (the wiring answers `null` for a missing ledger table or an
    // unidentifiable owner); caught here too; a failure reads as "not forgotten" and
    // the create proceeds exactly as it would today.
    let forgottenAt: Date | null;
    try {
      forgottenAt = await deps.pathWasForgotten(vaultPath);
    } catch (err) {
      console.warn(
        `notion-sync: forget ledger check failed for ${vaultPath}: ${errorMessage(err)} — ` +
        "proceeding as if it was never forgotten",
      );
      forgottenAt = null;
    }
    if (forgottenAt !== null) {
      await refuseCreate(
        proposal,
        `you asked me to forget this file on ${forgottenAt.toISOString().slice(0, 10)}`,
      );
      return;
    }

    // GUARD 1 — the proposer's contract. base_md_hash is "the vault render this was
    // proposed against", and a create has no vault render. A non-empty one means the
    // row was written by something that thinks this is an update, and acting on a
    // proposal whose author disagrees with this branch about what it is asking for is
    // exactly how the wrong bytes reach the wrong file.
    if (proposal.baseMdHash !== "") {
      await refuseCreate(proposal, "it carries a base hash, so it is not describing a create");
      return;
    }

    // GUARD 2 — the path shape. A create is the only write in this service whose
    // target comes from Notion CONTENT (a title, a Folder property), so the path is
    // untrusted: no escapes, no dot-directories, no machine-owned areas, markdown
    // only. Shared with the vault writer (lib/vault-target.ts) — ONE definition, so
    // the friendly refusal here and the hard refusal at the write cannot drift apart.
    const refusal = refuseVaultTarget(vaultPath);
    if (refusal !== null) {
      await refuseCreate(proposal, refusal);
      return;
    }

    // GUARD 2b — the path SCOPE, which the shape guard cannot answer. A well-formed
    // `personal/x.md` passes every rule above and is still a folder no pass was
    // configured to sync; creating a tracked document there would leave a file
    // outside the desk scope that pull nonetheless keeps in step with Notion
    // forever. The folder half of a create's path is Notion content (T6 reads it
    // from a `Folder` property), so it is exactly as untrusted as the filename.
    assertScopePredicateIsReal();
    if (!opts.inCreateScope(vaultPath)) {
      await refuseCreate(
        proposal,
        "that path is outside every folder this sync is configured to manage",
      );
      return;
    }

    // GUARD 3 — NEVER OVERWRITE, asked of the disk, now. The store row above is not
    // enough: a file can exist without a row (a human's own note, an untracked
    // draft), and a store row is a claim about the past while this is a question
    // about the present.
    //
    // The adapter re-checks this atomically with O_EXCL, which is what actually makes
    // it unbypassable. This check exists so the refusal is CLEAN — superseded with a
    // reason Bendik can read — instead of an opaque write failure that retries hourly.
    let exists: boolean;
    try {
      exists = await deps.vaultFileExists(vaultPath);
    } catch (err) {
      await fail(vaultPath, "vault existence check", err);
      return;
    }
    if (exists) {
      await refuseCreate(
        proposal,
        "a file already exists there and a create never overwrites (written by hand " +
        "while this waited for your decision?)",
      );
      return;
    }

    // GUARD 3b — NEVER OVERWRITE, the half the kernel cannot answer (T6 review round
    // 2). Guard 3 above and the adapter's `O_EXCL` both ask the FILESYSTEM, and the
    // filesystem underneath this process is not the one Bendik reads the vault on:
    // ext4 here, APFS there. `Notater.md` and `notater.md` are two inodes on the box
    // and one path on his Mac, so both of those guards can be satisfied and the file
    // still lands shadowing a hand-written note the moment the commit is pulled.
    //
    // Asked HERE and not only at propose time, and that is the whole reason this
    // guard was added rather than left as a propose-side courtesy: a proposal sits in
    // the queue while a human decides, and this branch's entire premise is that the
    // world is re-checked as it is NOW. The window is not theoretical either — he has
    // just read a DM naming this exact path, which is precisely the moment he might go
    // and write a note about it.
    //
    // ONE PREDICATE, shared verbatim with the propose side: `findCollidingPath` over
    // WHOLE PATHS (vault-target.ts). Round 2 shared only the key and built two
    // different comparisons on it — whole-path there, basename-in-the-literal-parent
    // here — and the two disagreed exactly where a variant sits in an ancestor
    // DIRECTORY: the literal `readdir` ENOENT'd, returned nothing, and the create
    // landed. `listCollisionCandidates` resolves the ancestry case-insensitively so
    // the engine is handed the paths that could really collide, and the question it
    // then asks is the propose side's question, letter for letter.
    await assertCollisionLookupIsReal();
    let candidates: string[];
    try {
      candidates = await deps.listCollisionCandidates(vaultPath);
    } catch (err) {
      // …AND A PING, for the same reason the create-write failure a few lines below
      // carries one (review round 4). `fail` is `console.error` + `recordDocError`,
      // and `recordDocError` is an UPDATE keyed on vault_path — a create has no row,
      // so it matches nothing. Left at `fail` alone this is the dead end that comment
      // already names: one log line an hour, forever, seen by nobody. The reachable
      // shape is not hypothetical either: the adapter THROWS rather than truncating
      // when an ancestor has too many case-variant spellings, and that condition never
      // clears on its own — only a human tidying the folder ends it.
      //
      // Same message discipline as the write failure below: FIXED per proposal so the
      // spine's 24h fingerprint gate collapses the hourly repeats into one alert, but
      // carrying the path and the error so two different stuck creates cannot collapse
      // into one. No new sentence about what approving or rejecting means — this is a
      // failure notice, and the decision consequences stay `rejectConsequence` /
      // `approveConsequence`'s alone.
      await fail(vaultPath, "vault collision listing", err);
      await ping(
        `could not check ${vaultPath} for name collisions, so the approved create is ` +
        `stuck: ${errorMessage(err)}`,
      );
      return;
    }
    const shadowed = findCollidingPath(vaultPath, candidates);
    if (shadowed !== null) {
      await refuseCreate(
        proposal,
        `the vault already holds "${shadowed}", which is the SAME FILE as that path on ` +
        "macOS (they differ only in capitalisation or unicode form) — creating it would " +
        "shadow that file in the vault the moment this commit is pulled",
      );
      return;
    }

    if (opts.dryRun) {
      applied += 1;
      return;
    }

    // The proposed content IS the whole file, frontmatter included: there is no file
    // on disk to lift a verbatim frontmatter block from, so the proposer owns every
    // byte. The single trailing newline is the same convention the update path uses
    // (`${block}${proposedBody}\n`) — bodies are stored without one, and a file
    // without a final newline is a git diff nobody wants to read.
    //
    // The proposer (transcript-sync.ts / notion-born-sync.ts) already writes
    // `lares_origin: synced` into the file it composed. Re-asserted here anyway: this
    // is the last line before the bytes reach the vault, a create may in future come
    // from a proposer this file does not know, and originAfterWrite makes the
    // re-assertion a no-op whenever the proposer did its job.
    const proposed = `${proposal.proposedBody}\n`;
    const written = upsertOriginFrontmatter(
      proposed,
      originAfterWrite(readOriginFrontmatter(proposed), "synced"),
    );
    try {
      await deps.createVaultFile(vaultPath, written);
    } catch (err) {
      // A failed create has NO BACKSTOP, and that is what this branch exists for.
      // The update path degrades gracefully because `recordDocError` finds a real
      // row and the 3-strike counter walks it to 'error' where the console shows it.
      // A create has no row (that is the precondition), so recordDocError matches
      // nothing, `fail` never pings, and `getStaleProposals` only looks at 'pending'
      // — an approved create is outside the escalation too. Left alone, a
      // permanently-failing create logs one line an hour, forever, seen by nobody.
      //
      // The fix is to make it LOUD, not to stop it. The proposal stays approved and
      // is retried, because the honest reading of EACCES / ENOSPC / a held lock is
      // "not yet" — a mount comes back, a prune runs, another writer finishes — and
      // throwing away a decision Bendik already made would be worse than waiting.
      // What must not persist is the SILENCE.
      //
      // The message is STABLE ACROSS TICKS but DISTINCT PER FAILURE. The spine
      // fingerprints `sha256(message)` (signal-notify.ts), so anything varying per
      // tick — a counter, a timestamp — would defeat the 24h gate and turn an
      // incident into hourly noise. But the path and the errno must be IN it:
      // without them an ENOSPC on one file and an EACCES on another collapse into
      // one notification, and the second failure is invisible for a day. Same text
      // every tick for the same stuck create, different text for a different one.
      //
      // The one class this cannot reach is a path too long to write: that is refused
      // at the guard now (MAX_SEGMENT_BYTES / MAX_PATH_BYTES, vault-target.ts) and
      // never gets as far as a write it would fail hourly.
      await fail(vaultPath, "vault create", err);
      await ping(
        `could not create ${vaultPath} in the vault — the approved create is stuck: ${errorMessage(err)}`,
      );
      return;
    }

    applied += 1;

    // The row goes in BEFORE the proposal is closed, and it goes in even if the
    // hash-after-write render fails. Without a row the file is an orphan the push
    // pass will adopt — creating a SECOND Notion page for content Notion already
    // holds. An honest empty md_hash costs one redundant push next tick; a missing
    // row costs a duplicate page and a split-brained document.
    //
    // notion_last_edited is left NULL on purpose: this engine took no reading from
    // Notion, and inventing a watermark would be a guess. The row is still reachable
    // — pull skips an unbaselined row only when its notion_hash is empty too
    // (pull-sync.ts) — so the next tick reads the page, matches the hash it was
    // proposed with, and writes the real watermark from an OBSERVED lastEditedTime.
    let rendered: RenderedDoc | undefined;
    try {
      rendered = await deps.renderDoc(vaultPath);
    } catch (err) {
      console.warn(
        `notion-sync: created ${vaultPath} but could not re-render it for a hash: ` +
        `${errorMessage(err)} — recording the row without one`,
      );
    }
    await tryRecord("synced", vaultPath, () => deps.linkPageToVaultFile({
      vaultPath,
      pageId: proposal.notionPageId,
      mdHash: rendered === undefined ? "" : docRenderHash(rendered),
      notionHash: proposal.notionHash,
      notionLastEdited: null,
      direction: CREATED_DIRECTION,
      // A create's proposedBody is the WHOLE file, so the body is what is left after
      // its own frontmatter — the same split the transcript pass makes on the file it
      // reads back, through the same function.
      writtenBodyHash: vaultBodyHash(written),
    }));
    await tryRecord("applied", vaultPath, () => deps.setProposalState(proposal.id, "applied"));

    // The snapshot is normally "the rows as of this tick's start", but a create is a
    // row this loop just made — and the two guards above are asked of this same map.
    // Two open creates naming the same Notion page under different paths is possible
    // (the open-proposal index is per vault_path, not per page), and without this the
    // second one would sail past the page guard on a snapshot that predates the first.
    rows.set(vaultPath, {
      pageId: proposal.notionPageId,
      mdHash: rendered === undefined ? "" : docRenderHash(rendered),
      notionHash: proposal.notionHash,
      notionLastEdited: null,
      state: "synced",
      direction: CREATED_DIRECTION,
      // The row a create BINDS may be a fresh docs row (a Notion-born page) or the
      // Meetings row a transcript already had — and this branch cannot tell which,
      // by construction: guard 0 above proves no PATH-bearing row exists, and a
      // Meetings row awaiting its first vault file has a NULL vault_path, so it is
      // absent from this path-keyed snapshot either way.
      //
      // 'docs' is therefore a guess, and it is the STRICTER one: the only reader of
      // this field is engineMayWrite, where 'docs' demands a 'synced' state and
      // 'meetings' waives the check. So the guess can never wrongly PERMIT a write.
      // (It cannot wrongly refuse one either — this entry is always 'synced', and a
      // create and an update for the same path cannot both be open, because 016's
      // partial unique index allows one open proposal per vault_path.)
      target: "docs",
    });
    await ping(`created ${vaultPath} in the vault from Notion`);
  }

  for (const proposal of approved) {
    const vaultPath = proposal.vaultPath;
    const row = rows.get(vaultPath);

    if (proposal.kind === "create") {
      await applyCreate(proposal, row);
      continue;
    }

    // The freeze invariant, applied uniformly (I2, final review): a frozen (or
    // erroring, or orphaned) row is not this engine's to write, whichever way the
    // human decided. It used to hold for rejections only, so an approved proposal
    // still wrote the vault file of a frozen row — breaking the one promise the
    // README and the runbook both make about a freeze ("written on neither
    // side"), and doing it underneath a human who is mid-decision.
    //
    // The approval is NOT closed: it stays queued and lands on the tick after
    // `notion-sync resolve` returns the row to 'synced'. Logged, not pinged —
    // exactly like the rejected loop below, and for the same reason: this
    // condition repeats on EVERY tick until the human resolves the row, and the
    // one thing allowed to nag them about a standing freeze is the pull pass's
    // stale-freeze ping, which is rate-limited by design (spec §6).
    if (row === undefined || !engineMayWrite(row)) {
      skipped += 1;
      console.warn(
        `notion-sync: approved proposal for ${vaultPath} left queued — row is ` +
        `${row === undefined ? "missing" : row.state}, not synced`,
      );
      continue;
    }

    let rendered: RenderedDoc;
    try {
      rendered = await deps.renderDoc(vaultPath);
    } catch (err) {
      await fail(vaultPath, "render", err);
      continue;
    }

    // The §18.4 re-check, and the whole reason apply is a separate pass from the
    // human's click: between proposing and approving, the vault may have moved.
    // Writing then would silently destroy the newer vault edit, so the proposal
    // dies here and the row freezes for a human `resolve` instead.
    if (docRenderHash(rendered) !== proposal.baseMdHash) {
      superseded += 1;
      // The freeze is a claim about a DOCS row, and only a docs row can carry it:
      // `freezeDoc`, `getFrozenDocs` and `notion-sync resolve` are all
      // `target='docs'`, so on a MEETINGS row (a transcript, T4) the call updated
      // nothing and the ping told Bendik to run a command that answers "no doc row
      // for <path>" — the same class of defect as the consequence strings this phase
      // has already fixed twice, one layer deeper. And `--keep md` on a transcript
      // would be the md→Notion write §17.2 forbids outright, so pointing him at it
      // was worse than useless.
      //
      // What is TRUE for both: the approval is dead, nothing was written on either
      // side, and the vault keeps the newer text. What differs is who heals it. A
      // docs row is frozen and waits for a human `resolve`; a transcript needs no
      // resolve at all — the transcript pass re-reads the page every tick, sees the
      // vault copy no longer matches what the row accounted for, and reports it with
      // the same instruction as every other hand-edited transcript.
      //
      // `frozen` is counted where the freeze actually happens (it never was, which
      // made the operator summary say "0 frozen" for a tick that froze a row).
      const freezes = row.target !== "meetings";
      if (freezes) frozen += 1;
      if (!opts.dryRun) {
        await tryRecord("supersede", vaultPath, () => deps.setProposalState(proposal.id, "superseded"));
        if (freezes) {
          await tryRecord("freeze", vaultPath, () => deps.freezeDoc(vaultPath, STALE_REASON));
          await ping(
            `stale approval for ${vaultPath} — ${STALE_REASON}; ` +
            `resolve with: notion-sync resolve ${vaultPath} --keep md|notion`,
          );
        } else {
          // NOT "or move the file" (review round 2): the state row still points at
          // this path, so a moved file makes every later tick fail to read it and
          // report an error instead — the transcript is retired, not recovered. The
          // one thing that works is putting the vault copy back byte for byte, and
          // the vault is a git repo in which every write this service made was
          // committed, so that is a real instruction rather than a hope.
          await ping(
            `stale approval for ${vaultPath} — ${STALE_REASON}. Notion owns this document, so ` +
            `there is nothing to resolve: restore the vault copy (it is in the vault's git ` +
            `history) and the next sync will offer Notion's current version again.`,
          );
        }
      }
      continue;
    }

    let source: string;
    try {
      source = await deps.readVaultFile(vaultPath);
    } catch (err) {
      await fail(vaultPath, "vault read", err);
      continue;
    }

    if (opts.dryRun) {
      applied += 1;
      continue;
    }

    // Frontmatter comes from DISK, at apply time — not from the render, and never
    // from Notion. The proposed body is everything Notion is allowed to change.
    //
    // That rule is unchanged, and it is why an owner's own keys survive a pull. What
    // is new is the ONE key this content's provenance decides: the body below came
    // from Notion, so the file must say so unless it already says something less
    // trusted or more deliberate. A file with no frontmatter block at all gets a
    // block whose only key is the stamp, above Notion's body. That case used to be written back bare: Notion's bytes in a
    // file that claimed nothing about where they came from, reading as trusted for
    // ever afterwards.
    //
    // The stamp is applied to the DISK block alone, never to block + body joined: Notion's body
    // may itself open with a `---` rule, and a joined text with no block of its own would have
    // that rule read as frontmatter and the stamp written into the middle of the body.
    const diskBlock = splitFrontmatter(source).block;
    const stamp = originAfterWrite(readOriginFrontmatter(source), "synced");
    const stampedBlock = diskBlock === ""
      ? `---\n${originFrontmatterLine(stamp)}\n---\n\n`
      : upsertOriginFrontmatter(diskBlock, stamp);
    const content = `${stampedBlock}${proposal.proposedBody}\n`;
    try {
      await deps.writeVaultFile(vaultPath, content);
    } catch (err) {
      await fail(vaultPath, "vault write", err);
      continue;
    }

    applied += 1;
    // Marked AFTER the write: if this bookkeeping fails the file is already
    // correct, and the next tick finds the proposal still approved but the vault
    // render no longer matching its base hash — so it supersedes and freezes
    // rather than writing twice. Loud, safe, never destructive.
    await tryRecord("applied", vaultPath, () => deps.setProposalState(proposal.id, "applied"));

    // …and for a NOTION-OWNED row, this pass reconciles the hashes itself, because
    // the pass that normally does it will not.
    //
    // The rule below ("leave md_hash stale, push will refresh it") is a claim about
    // ANOTHER PASS, and it is true only where that pass writes. Push deliberately
    // holds a notion_to_md row back (readOnlyVaultPaths, wiki-sync.ts), so for this
    // direction nothing ever refreshed md_hash — and the NEXT tick's conflict check
    // saw a vault render that no longer matched the store and froze the document
    // with "changed in both Notion and the vault". Only Notion had changed; the
    // vault changed because this engine wrote it, on Bendik's own 👍. The freeze
    // then pointed him at `resolve --keep md`, which pushes the vault back over
    // Notion — the exact write this direction exists to forbid. A freeze after
    // every single approval, i.e. the steady state of every transcript.
    //
    // Recording both hashes here is honest for THIS direction specifically: no
    // Notion write is being claimed, because none is owed. The vault now holds what
    // Notion holds, and saying so is the whole of the reconciliation.
    if (notionOwns(row.direction)) {
      await reconcileAfterVaultWrite(vaultPath, proposal, row, content);
    }
    await ping(`applied the Notion edit to ${vaultPath}`);
  }

  // For every OTHER direction the md_hash the vault now has is stale in the store,
  // and deliberately so: the push pass runs later in the same tick, re-renders the
  // applied file, pushes it and takes its own hash-after-write reading. Recording a
  // hash here would claim a Notion write this engine never made.

  for (const proposal of rejected) {
    const vaultPath = proposal.vaultPath;
    const row = rows.get(vaultPath);

    // A rejected CREATE is executed by doing nothing, and then closing.
    //
    // Rejecting an update owes the world a write — the Notion page is reverted from
    // the vault (§18.4). Rejecting a create owes nothing: the file was never made, so
    // there is no vault content to revert a page from, and the Notion page the
    // proposal came from is the human's own and is left exactly as it is. "No" here
    // means "do not bring this into the vault", not "undo it in Notion".
    //
    // Closing it matters. Left open it would fall into the row gate below, find no
    // row (nothing was created — that is the point), be counted as skipped and warn
    // on every tick, forever, while resolved_at stayed NULL and the queue never
    // drained.
    //
    // AND THE DECISION HAS TO BE REMEMBERED. Closing the proposal drains the queue;
    // it records nothing about what was decided, so the proposer — which knows only
    // "Notion holds content this row has not accounted for" — proposes the identical
    // file on the very next tick, and the next, hourly, forever. T3b flagged this as
    // the one thing it could not settle from where it stood.
    //
    // THE POLICY, stated once here because both create proposers must share it:
    //
    //   **Reject means "not this content", never "never this document".** The exact
    //   Notion content Bendik declined is recorded on the state row as accounted-for
    //   (`notion_hash`), so the next tick is silent — and any LATER change to that
    //   page hashes differently and arrives as its own fresh question. That is the
    //   same rule the Notion-owned update rejection below already follows, stated
    //   once rather than invented twice. A permanent "never ask about this document"
    //   would be a different feature, needs its own durable state, and is not what a
    //   👎 on one version of a document means.
    //
    // Keyed by PAGE, because a rejected create has no vault file and therefore no
    // path-bearing row to key on. **THE CONTRACT THAT FOLLOWS FOR A CREATE PROPOSER:
    // it must ensure a state row exists for its Notion page BEFORE proposing.**
    //
    // That is ENFORCED, not merely stated (review round 1): `recordNotionAccounted`
    // THROWS when it matches no row, and it shares this branch's one tryRecord with
    // the close — so a proposal raised without a row leaves the rejection unexecuted
    // and retried, with the proposer still silent because the row is still in
    // `getRejectedUnexecuted`. It used to be a plain UPDATE, where a page with no row
    // was a silent no-op: the decline "succeeded", the proposal closed, and Bendik
    // was asked about the same file on the next tick, and the next. T4 satisfies the
    // precondition with `ensureMeetingRow` and refuses to propose if it fails; T6
    // owes the same for a Notion-born page.
    if (proposal.kind === "create") {
      declined += 1;
      console.log(`notion-sync: declined create for ${vaultPath} — nothing written, nothing reverted`);
      if (!opts.dryRun) {
        // ONE tryRecord covering BOTH writes, in this order, deliberately. If the
        // decline record fails, `markProposalReverted` must not run: leaving the
        // proposal rejected-but-unexecuted keeps it in `getRejectedUnexecuted`,
        // which is what both proposers consult to stay silent — so the next tick
        // retries the record instead of re-asking. Two independent tryRecords would
        // close the proposal over a failed record and re-propose it forever, which
        // is the exact loop this branch exists to end.
        await tryRecord("declined", vaultPath, async () => {
          await deps.recordNotionAccounted(proposal.notionPageId, proposal.notionHash);
          await deps.markProposalReverted(proposal.id);
        });
        await ping(`${vaultPath} was not created — the Notion page is unchanged`);
      }
      continue;
    }

    // The same gate as the approved loop above, for the same reason: a frozen
    // (or erroring, or orphaned) row is not this engine's to write. The freeze
    // means a human owes a `notion-sync resolve` decision, and reverting
    // underneath that decision would overwrite the very content they are looking
    // at. The rejection stays queued and executes once the row is synced again.
    if (row === undefined || !engineMayWrite(row)) {
      skipped += 1;
      console.warn(
        `notion-sync: rejection for ${vaultPath} left queued — row is ` +
        `${row === undefined ? "missing" : row.state}, not synced`,
      );
      continue;
    }

    // A rejected update on a NOTION-OWNED row: also executed by doing nothing to
    // Notion. THE DECISION, stated once and implemented here (Phase 4 fix round 2).
    //
    // For a mirror or two-way row, "reject" means the vault wins and the page is
    // overwritten from it. For a Notion-owned row that reading is backwards: the
    // page IS the document and the vault file is its projection, so reverting would
    // be the projection overwriting its own source — precisely the write direction.ts
    // says no pass may make. So here "reject" means the narrower, honest thing: **do
    // not bring this into the vault.** The vault keeps what it has, and Bendik's
    // Notion page is left exactly as he wrote it.
    //
    // Reachable only BECAUSE of this phase: before notion_to_md started proposing,
    // such a row never produced a proposal to reject.
    //
    // The watermark still moves. That is what closes the loop: `notion_hash` means
    // "the Notion content this row has accounted for", and content a human looked at
    // and declined IS accounted for. Without it, pull would see a page hash that
    // differs from the row's on the very next tick and re-propose the rejected edit,
    // forever. No Notion read is needed to do it — unlike the revert below, nothing
    // here depends on the page still holding those bytes; if it has moved on, the
    // stored hash simply will not match next tick and the newer content arrives as
    // its own fresh proposal, which is correct.
    if (notionOwns(row.direction)) {
      declined += 1;
      console.log(
        `notion-sync: declined the Notion edit for ${vaultPath} — vault unchanged, Notion untouched`,
      );
      if (!opts.dryRun) {
        // Both writes in ONE tryRecord, same reason as the rejected-create branch
        // above: a watermark that failed to move while the proposal is closed means
        // pull re-proposes the rejected edit on the next tick and every tick after.
        // Leaving it unexecuted retries instead.
        await tryRecord("declined", vaultPath, async () => {
          await deps.updateNotionWatermark(vaultPath, proposal.notionHash, row.notionLastEdited);
          await deps.markProposalReverted(proposal.id);
        });
        await ping(
          `rejected the Notion edit for ${vaultPath} — the vault is unchanged and your ` +
          `Notion page was left as it is (Notion owns this document)`,
        );
      }
      continue;
    }

    let rendered: RenderedDoc;
    try {
      rendered = await deps.renderDoc(vaultPath);
      assertPushSafe(rendered.markdown);
    } catch (err) {
      await fail(vaultPath, "render", err);
      continue;
    }

    // What the human rejected is not necessarily what the page holds now. A revert
    // is a wholesale overwrite, so it may only run against the exact content the
    // rejection was about — otherwise a newer, unjudged edit would be destroyed by
    // a decision that was never made about it.
    //
    // On a mismatch the rejection is SUPERSEDED, not left queued: it ruled on
    // content that no longer exists, so the revert obligation dies with it, and
    // pull brings the newer content back as a fresh proposal the human can rule on
    // in its own right. (Leaving it queued would re-detect and re-ping the same
    // mismatch on every tick, possibly forever.)
    let current: string;
    try {
      current = await deps.getPageMarkdown(proposal.notionPageId);
    } catch (err) {
      await fail(vaultPath, "reject pre-check read", err);
      continue;
    }
    if (sha256(current) !== proposal.notionHash) {
      superseded += 1;
      if (!opts.dryRun) {
        await tryRecord("supersede", vaultPath, () => deps.setProposalState(proposal.id, "superseded"));
        await ping(
          `rejected edit for ${vaultPath} was NOT reverted — the page changed after you ` +
          `rejected it; the new content will arrive as a fresh proposal`,
        );
      }
      continue;
    }

    if (opts.dryRun) {
      reverted += 1;
      continue;
    }

    try {
      await deps.patchPageMarkdown(proposal.notionPageId, rendered.markdown);
    } catch (err) {
      const message = errorMessage(err);
      if (CHILD_CONTENT_ERROR.test(message)) {
        // Notion is protecting a human's nested page. The rejection cannot be
        // carried out as a wholesale replace, so the freeze takes ownership of the
        // unfinished business and the proposal is closed — otherwise this exact
        // failure would repeat, and ping, on every tick forever.
        frozen += 1;
        await tryRecord("freeze", vaultPath, () => deps.freezeDoc(vaultPath, MIRROR_CHILD_REASON));
        await tryRecord("reverted", vaultPath, () => deps.markProposalReverted(proposal.id));
        await ping(`rejected edit for ${vaultPath} could not be reverted — ${MIRROR_CHILD_REASON}`);
        continue;
      }
      // Anything else may well be transient: leave the proposal queued so the next
      // tick tries again, and let the 3-strike counter surface a persistent failure.
      await fail(vaultPath, "reject revert patch", err);
      continue;
    }

    try {
      await deps.updateDocProps(proposal.notionPageId, rendered.props);
    } catch (err) {
      await fail(vaultPath, "reject revert props", err);
      continue;
    }

    let stored: string;
    try {
      stored = await deps.getPageMarkdown(proposal.notionPageId);
    } catch (err) {
      // No upsert on purpose (same as the mirror revert): the stale stored hash is
      // what makes the next pull tick re-read and finish the job.
      await fail(vaultPath, "hash-after-write read", err);
      continue;
    }

    reverted += 1;
    await tryRecord("synced", vaultPath, () => deps.upsertDocSynced({
      vaultPath,
      pageId: proposal.notionPageId,
      mdHash: docRenderHash(rendered),
      notionHash: sha256(stored),
      // Carried through unchanged (the state gate above guarantees the row).
      // Inventing a stamp would be a guess; the store keeps this one either way.
      notionLastEdited: row.notionLastEdited,
      direction: row.direction,
    }));
    await tryRecord("reverted", vaultPath, () => deps.markProposalReverted(proposal.id));
    await ping(`rejected the Notion edit for ${vaultPath} — the page was reverted from the vault`);
  }

  const scanned = approved.length + rejected.length;
  return {
    scanned,
    applied,
    reverted,
    declined,
    superseded,
    frozen,
    skipped,
    errored,
    bookkeepingFailed,
    summary:
      `${applied} applied, ${reverted} reverted, ${declined} declined, ${superseded} superseded, ` +
      `${frozen} frozen, ${skipped} left queued, ${errored} errored, ` +
      `${bookkeepingFailed} bookkeeping-failed, ${scanned} decided` +
      `${opts.dryRun ? " (dry-run)" : ""}`,
  };
}
