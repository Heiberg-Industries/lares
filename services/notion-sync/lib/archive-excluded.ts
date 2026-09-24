// T3 (Phase 4, ORB-39): retiring the Docs rows that config's `deskDirs[].exclude`
// has carved out of the desk scope (desk-scope.ts). T2 stopped the sync engine
// from CREATING or ITERATING these paths; this is the one-shot pass that removes
// the rows that already existed BEFORE that carve-out shipped — the 32
// meeting-transcript pages Phase 3 wrongly swept into the Docs database.
//
// Vendor-neutral and pure in exactly the sense apply-sync.ts/pull-sync.ts are:
// every side effect arrives as an injected dep, every row is contained, dry-run
// makes zero writes. Deliberately has NO filesystem dependency at all — no
// readVaultFile, no writeVaultFile, no archiveVaultFile in ArchiveExcludedDeps —
// because the vault files are the real artifact (T3 brief) and Bendik, not this
// command, decides later whether to adopt them. That is a property of the TYPE,
// not just today's implementation: a future call site literally cannot hand this
// engine a way to touch the vault.
import { notionOwns } from "./direction.js";
import type { DeskRow } from "./store.js";

export interface ArchiveExcludedOptions {
  dryRun: boolean;
  /**
   * Has config carved this vault path out of the desk scope
   * (`deskDirs[].exclude`)? Pass `makeDeskExclusion(cfg.desks)` — there is no
   * other correct value (mirrors PullSyncOptions.isExcluded, pull-sync.ts, for
   * the same reason). REQUIRED rather than defaulted: a call site that forgot to
   * scope this pass would, on the very next line, trash a real desk page instead
   * of merely missing an exclusion — the one mistake this command exists to make
   * impossible by construction. A second, cheap backstop against the same
   * mistake lives in the function body below (fix round 1, Important 1) — this
   * type-level one cannot catch a call site that wires a WRONG-but-present
   * predicate, e.g. `() => true`, which still compiles.
   */
  isExcluded: (vaultPath: string) => boolean;
}

export interface ArchiveExcludedDeps {
  /** Raw, unfiltered store truth (store.ts) — this pass does its own scoping via `isExcluded`. */
  getDeskRows: () => Promise<Map<string, DeskRow>>;
  /**
   * PATCH /v1/pages/{id} { in_trash: true } (notion-client.ts). `alreadyDone:
   * true` covers both a page that is genuinely gone AND one an earlier call
   * already trashed — see notion-client.ts's trashPage for the live-verified
   * detail — either way this pass treats it as success-already-done, never a
   * failure (T3 brief: idempotent re-runs must not trip over their own past
   * work).
   */
  trashPage: (pageId: string) => Promise<{ alreadyDone: boolean }>;
  /** Flags the STATE ROW orphaned (store.ts) — never deletes it (T3 brief decision 3). */
  markDocOrphaned: (vaultPath: string, reason: string) => Promise<void>;
}

/** One row this pass named, with enough to act on it later — "with its page id" (T3 brief). */
export interface ArchiveExcludedRow {
  vaultPath: string;
  pageId: string;
}

export interface ArchiveExcludedIssue extends ArchiveExcludedRow {
  reason: string;
}

export interface ArchiveExcludedResult {
  /** Whether this run was a dry-run — carried on the result so a caller's own
   *  report can pick the right tense (`trashed` vs `would trash`) without
   *  re-deriving it or parsing `summary` (fix round 1, Important 2: a caller
   *  that forgot this distinction could produce a report byte-identical to a
   *  successful live run). */
  dryRun: boolean;
  /**
   * Trashed this run — or, in dry-run, WOULD be (the full plan, T3 brief). Dry-run
   * makes no trashPage call at all, so it cannot distinguish "fresh trash" from
   * "already done" without making the exact write it must not make; both land
   * in this one bucket in a preview, same as `enabled` in runEnableTwoWay covers
   * both "would enable" and "did enable". Callers MUST consult `dryRun` (above)
   * before printing this bucket — see cli.ts/bin/notion-sync.ts's "would trash"
   * vs "trashed" wording.
   */
  trashed: ArchiveExcludedRow[];
  /**
   * The Notion page needed no fresh trash write — either genuinely gone (404)
   * or already trashed by an earlier call (400; see notion-client.ts's
   * trashPage). Only ever populated live; dry-run cannot produce this bucket.
   */
  alreadyDone: ArchiveExcludedRow[];
  /** In scope but not attempted — wrong state (T3 brief: "not silently included"). */
  skipped: ArchiveExcludedIssue[];
  /** The trash call itself failed. The row's state is UNTOUCHED — still 'synced' — so a re-run retries it. */
  failed: ArchiveExcludedIssue[];
  /** Trash succeeded (or was already done) but marking the row orphaned failed — Notion is done; only the local record missed it. Re-running this command retries it — see the catch block below. */
  orphanFailed: ArchiveExcludedIssue[];
  summary: string;
}

/** The one frozen_reason every row this command orphans gets — stated once, not per call site. */
export const EXCLUDED_REASON = "out of desk scope — transcripts are Notion-primary (Phase 4)";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `notion-sync archive-excluded` (T3): the retiring half of Phase 4 decision 5.
 * T2 carved every `transcripts` sub-path out of the desk scope so the sync
 * engine can no longer create or iterate them; this command removes the 32 Docs
 * rows (and their Notion pages) that predate that carve-out.
 *
 * "Archive" means moving the Notion PAGE to trash (`in_trash: true`), never
 * ticking the database's own `Archived` checkbox property — a plan decision
 * (T3 brief), not this engine's to re-litigate: a ticked checkbox leaves the row
 * live and returned by every future `queryDocs`, forever in reach of the
 * adoption path. Trash removes it from the database outright while staying
 * recoverable from Notion's own UI for 30 days — reversible AND correct.
 *
 * Selects rows by the SAME exclusion predicate T2 built (`isExcluded`, always
 * `makeDeskExclusion(cfg.desks)`), never a hardcoded path literal — see
 * ArchiveExcludedOptions.isExcluded. That makes this command mean "retire
 * whatever the CURRENT config says is out of desk scope", which stays correct
 * for any future exclusion without a second, driftable definition of scope.
 * Defence in depth against a MIS-WIRED (but type-correct) predicate: if
 * `isExcluded` selects every single row the store holds, this throws instead
 * of running — no real config excludes everything (a wiki mirror row alone,
 * carrying no desk dir at all, guarantees `isExcluded` must answer false for
 * SOMETHING), so 100% selected is never legitimate (fix round 1, Important 1;
 * a mutation test — `isExcluded: () => true` — survived the whole suite
 * before this guard existed).
 *
 * Per-row order is load-bearing (T3 brief): trash the Notion page FIRST, mark
 * the state row orphaned SECOND.
 *   - A failed trash leaves the row exactly as it was — 'synced' — so a re-run
 *     retries it from scratch; markDocOrphaned is never called for that row.
 *   - A page that needs no fresh trash write (trashPage's `alreadyDone: true`
 *     — genuinely gone, or already trashed by an earlier call; see
 *     notion-client.ts) is success-already-done, not a failure: it proceeds to
 *     the orphan step exactly like a fresh trash would. This is what makes
 *     re-running this command always safe: whatever state a row was left in,
 *     the next run's trashPage call classifies correctly (fix round 1 — the
 *     ORIGINAL version of this comment claimed a repeat trash always 200s,
 *     which is false; see notion-client.ts's trashPage for the live probe that
 *     caught it) and execution reaches markDocOrphaned again either way.
 *   - A failure IN the orphan step itself, after a successful (or
 *     already-done) trash, does NOT strand the row: it is still 'synced' (this
 *     function never wrote it), so it is not skipped on a re-run either — see
 *     the catch block below for why this is reported loudly despite being
 *     self-healing.
 *
 * Idempotent: a row not in state 'synced' — including one this command already
 * orphaned on a prior run — is skipped and reported, never re-touched. This is
 * the SAME state gate runApplySync and runEnableTwoWay use for "a human, or a
 * prior run, already owns this row."
 *
 * No filesystem dependency exists on this engine at all (see the file header
 * and ArchiveExcludedDeps) — the vault files are the real artifact and survive
 * this pass completely untouched.
 */
export async function runArchiveExcluded(
  opts: ArchiveExcludedOptions,
  deps: ArchiveExcludedDeps,
): Promise<ArchiveExcludedResult> {
  const allRows = await deps.getDeskRows();
  const rows = [...allRows]
    .filter(([vaultPath]) => opts.isExcluded(vaultPath))
    .sort(([a], [b]) => (a < b ? -1 : 1));

  // Defence in depth (fix round 1, Important 1): a mis-wired but
  // type-correct `isExcluded` — `() => true`, or any predicate that happens
  // to match every row the store currently holds — would otherwise trash the
  // wiki mirror and every desk row alongside the real 32. No config for this
  // service has ever excluded 100% of its own rows (the wiki mirror carries
  // no desk dir at all, so a correct predicate always leaves it, and
  // everything else not positively named by an `exclude` entry, unmatched).
  // Refusing outright here is cheap and closes the whole mutant class that
  // the unit tests below — which construct `isExcluded` however a test
  // pleases — cannot be relied on alone to catch in production.
  if (allRows.size > 0 && rows.length === allRows.size) {
    throw new Error(
      "notion-sync: archive-excluded: isExcluded matched EVERY row in the store " +
      `(${rows.length} of ${allRows.size}) — refusing to run. No real config excludes ` +
      "everything; this looks like a mis-wired isExcluded, not a real 100%-excluded desk scope.",
    );
  }

  const trashed: ArchiveExcludedRow[] = [];
  const alreadyDone: ArchiveExcludedRow[] = [];
  const skipped: ArchiveExcludedIssue[] = [];
  const failed: ArchiveExcludedIssue[] = [];
  const orphanFailed: ArchiveExcludedIssue[] = [];

  for (const [vaultPath, row] of rows) {
    // Rows not in 'synced' are skipped and reported, not silently included (T3
    // brief) — this is also what makes a SECOND run of this command a no-op: the
    // first run's markDocOrphaned left the row 'unmatched', so it lands here
    // instead of being re-trashed.
    if (row.state !== "synced") {
      skipped.push({ vaultPath, pageId: row.pageId, reason: `row state is '${row.state}', not 'synced'` });
      continue;
    }

    // …and NOTION-OWNED rows are skipped too (Phase 4 fix round 2). Reached only for
    // a 'synced' row, because the state check above returns first — the ordering is
    // immaterial to what happens (both skip) but not to the reason reported, and the
    // reason is what an operator reads.
    //
    // This command retires the Notion pages of rows config has carved out of the
    // desk scope. That is sound when the vault authored the page — trashing it
    // retires a projection nobody syncs any more. It is destructive in the exact
    // opposite way when NOTION authored it: the page is the document, the vault file
    // is the copy, and trashing the page throws away the original.
    //
    // Newly reachable, and by design: `makeCreateScope` deliberately allows creates
    // into the `transcripts` carve-out (that is where T4's transcripts live), and
    // `upsertDocSynced` inserts them with `target='docs'`. So a created transcript
    // row is BOTH excluded and Notion-owned, and would have landed squarely in this
    // loop's sights on the next `archive-excluded` run.
    if (notionOwns(row.direction)) {
      skipped.push({
        vaultPath,
        pageId: row.pageId,
        reason: "Notion owns this document (direction notion_to_md) — its page is the source, not a projection",
      });
      continue;
    }

    if (opts.dryRun) {
      trashed.push({ vaultPath, pageId: row.pageId });
      continue;
    }

    let alreadyDoneFlag: boolean;
    try {
      ({ alreadyDone: alreadyDoneFlag } = await deps.trashPage(row.pageId));
    } catch (err) {
      // The row's state is UNTOUCHED — still 'synced' — so a re-run retries this
      // exact row from the top. markDocOrphaned is deliberately never reached.
      const reason = `trash failed: ${errorText(err)}`;
      failed.push({ vaultPath, pageId: row.pageId, reason });
      console.error(`notion-sync: archive-excluded: ${vaultPath}: ${reason}`);
      continue;
    }

    try {
      await deps.markDocOrphaned(vaultPath, EXCLUDED_REASON);
    } catch (err) {
      // Notion's side is DONE — trashed just now, or already done — and only
      // the local record missed it. The row's STATE IS UNCHANGED (still
      // 'synced': this function never writes it on this path), so it is NOT
      // skipped on a re-run either — re-running this command retries this
      // exact row, trashPage now (correctly) reports it alreadyDone, and this
      // pass proceeds straight to retrying the orphan write. (Fix round 1,
      // Important 3: the ORIGINAL version of this message told the operator to
      // "fix the database by hand", which was wrong and directed them to a
      // riskier manual edit instead of the safe, already-available fix —
      // re-run the command.) Reported and logged loudly anyway, despite being
      // self-healing: a repeat failure on the SAME row across multiple runs
      // means something is actually wrong (a stuck lock, a permissions
      // problem) and deserves a human's attention even though the mechanism
      // to retry it is "run the command again".
      const reason = errorText(err);
      orphanFailed.push({ vaultPath, pageId: row.pageId, reason });
      console.error(
        `notion-sync: archive-excluded: ${vaultPath} was trashed in Notion but the state row ` +
        `could not be marked orphaned: ${reason} — the row is still 'synced', so re-running ` +
        "this command retries it; if it keeps failing, that is worth investigating",
      );
      continue;
    }

    if (alreadyDoneFlag) alreadyDone.push({ vaultPath, pageId: row.pageId });
    else trashed.push({ vaultPath, pageId: row.pageId });
  }

  // A leading tag, not a trailing suffix (fix round 1, Important 2): a
  // dry-run report is otherwise byte-identical to a successful live run
  // except for a ten-character suffix an operator scanning output can miss —
  // and the runbook's own expected string for a REAL run ("N trashed, ...")
  // would then also match a preview verbatim. The per-row lines carry the
  // same distinction — see cli.ts/bin/notion-sync.ts's print loops, which
  // consult `dryRun` (above) rather than re-deriving this text.
  const summary =
    `${opts.dryRun ? "DRY-RUN (nothing written): " : ""}` +
    `archive-excluded: ${rows.length} in scope, ` +
    `${trashed.length} ${opts.dryRun ? "would be trashed" : "trashed"}, ` +
    `${alreadyDone.length} already done, ${skipped.length} skipped, ` +
    `${failed.length} failed, ${orphanFailed.length} orphan-write failed`;

  return { dryRun: opts.dryRun, trashed, alreadyDone, skipped, failed, orphanFailed, summary };
}
