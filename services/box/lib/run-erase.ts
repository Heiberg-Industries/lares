// services/box/lib/run-erase.ts — W5B-s8: wires the database half (lib/erase-person.ts) and the
// vault half (lib/erase-person-vault.ts) together, in the one order that keeps both halves'
// promises, and composes the one report a person actually reads.
//
// THE ORDER, AND WHY IT IS EXACTLY THIS ORDER.
//   1. Resolve the person ONCE, up front (`resolvePerson`). Both halves need the very same
//      `PersonIdentity` — the vault pass needs every spelling a note might be stamped with,
//      exactly the same set the database pass matches columns against — and resolving twice would
//      be two chances for the two halves to (even briefly, even harmlessly) disagree.
//   2. A DATABASE DRY RUN. If it reports any refusal — an unknown name, a name two people claim,
//      a table this box has not migrated — that is found out before a single vault file is
//      touched. A refused erase that already deleted files is a worse state than a refused erase
//      that touched nothing, which is the whole reason `erasePerson` itself is one transaction.
//   3. THE VAULT PASS, once per `--vault` given, in the order given. A vault pass that throws —
//      the vault already has staged changes, a hit would land outside the vault — stops
//      EVERYTHING right there, before the database is touched at all.
//   4. THE REAL DATABASE ERASE, with the paths the vault pass just removed (tracked and
//      untracked both) handed in as `erasePerson`'s `opts.paths`, so the sync-state rows for
//      those exact files are cleared in the SAME run rather than left as a promise to come back
//      to later.
//
// `opts.paths` is passed to `erasePerson` only when at least one `--vault` was given at all —
// never as an empty array standing in for "no vault was looked at". Those are different facts:
// one says "these particular files, and nothing more, need clearing"; the other says "nobody
// checked". `erasePerson`'s own outstanding line already tells them apart (see its `pathsGiven`
// handling); this module tells them apart too, in `noVaultGiven`.

import type { Pool } from "pg";
import { erasePerson, renderEraseReport, type EraseReport } from "./erase-person.js";
import { erasePersonFiles, findPersonFiles, type VaultHit } from "./erase-person-vault.js";
import {
  resolvePerson,
  IdentityRegisterMissing,
  PersonAmbiguous,
  PersonNotFound,
} from "./person-identity.js";

/** What one `--vault` pass did (or, on a practice run, would do). */
export interface VaultPassResult {
  vaultRoot: string;
  hits: readonly VaultHit[];
  commit: string | null;
  removed: readonly string[];
  untracked: readonly string[];
  leftShared: readonly string[];
}

export interface RunEraseOptions {
  db: Pool;
  /** Whatever the operator typed: the register id, an old handle, an email address. */
  person: string;
  /** Every `--vault <path>` given, in the order given. Empty is a real, reportable choice — see
   *  the header — not an oversight this routine quietly works around. */
  vaults: readonly string[];
  /** `--apply`. Without it, both halves are read-only: the database dry-runs and the vault pass
   *  previews what it would remove without writing a single file. */
  apply: boolean;
}

export interface RunEraseResult {
  /** The database half's own report — a dry run's counts, or what actually happened. */
  dbReport: EraseReport;
  /** One entry per `--vault` that was actually looked at. Empty when the run refused before any
   *  vault was reached, or when a vault pass threw partway through. */
  vaults: readonly VaultPassResult[];
  /** True when no `--vault` was given at all — distinct from "given, but held nothing of theirs". */
  noVaultGiven: boolean;
  /** Set when a vault pass threw. The database was never touched beyond the earlier dry run when
   *  this is present — `dbReport` in that case IS that dry run, not a real erase. */
  vaultError?: string;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A refusal that never got as far as `erasePerson` itself — the register lookup failed before
 *  there was a database report to build one from. Same shape as `erasePerson`'s own refusal
 *  report, so `renderEraseReport` renders it exactly the same way. */
function refusalReport(person: string, message: string): EraseReport {
  return {
    person,
    dryRun: true,
    planned: [],
    deleted: [],
    outstanding: [],
    refusals: [message],
  };
}

/**
 * Runs both halves of an erase, in the order the header describes.
 *
 * Never throws for a refusal or a vault-side error that is this routine's job to report — those
 * come back on the result for `renderRunEraseReport` to render. An unexpected error (the database
 * unreachable, for instance) is allowed to propagate, exactly as `erasePerson` and
 * `erasePersonFiles` already let it.
 */
export async function runErase(opts: RunEraseOptions): Promise<RunEraseResult> {
  const { db, person, vaults, apply } = opts;
  const noVaultGiven = vaults.length === 0;

  // ── Step 1: who, once, for both halves. ────────────────────────────────────────────────────
  let identity;
  try {
    identity = await resolvePerson(db, person);
  } catch (err) {
    if (
      err instanceof PersonNotFound ||
      err instanceof PersonAmbiguous ||
      err instanceof IdentityRegisterMissing
    ) {
      return { dbReport: refusalReport(person, messageOf(err)), vaults: [], noVaultGiven };
    }
    throw err;
  }

  // ── Step 2: a database dry run, before any file anywhere is touched. ──────────────────────
  const preCheck = await erasePerson(db, { person: identity.id, dryRun: true });
  if (preCheck.refusals.length > 0) {
    return { dbReport: preCheck, vaults: [], noVaultGiven };
  }

  // ── Step 3: the vault pass, per --vault, read-only unless --apply. A throw here stops
  //    everything before the database is touched — `dbReport` stays the dry run above. ────────
  //    Every vault is walked read-only FIRST, so a vault that cannot be read at all is found out
  //    before the first one has been changed. If a later vault still fails during the real pass
  //    (somebody's staged changes, say), what was already removed is reported, never dropped.
  const vaultResults: VaultPassResult[] = [];
  try {
    const found = vaults.map((vaultRoot) => ({
      vaultRoot,
      hits: findPersonFiles(vaultRoot, identity.spellings),
    }));
    for (const { vaultRoot, hits } of found) {
      await erasePersonFiles({ vaultRoot, hits, dryRun: true });
    }
    for (const { vaultRoot, hits } of found) {
      const out = await erasePersonFiles({ vaultRoot, hits, dryRun: !apply });
      vaultResults.push({ vaultRoot, hits, ...out });
    }
  } catch (err) {
    return { dbReport: preCheck, vaults: vaultResults, noVaultGiven, vaultError: messageOf(err) };
  }

  if (!apply) {
    // Counted again with the paths in hand, so a practice run also shows the sync records a
    // real run would clear.
    const paths = vaultResults.flatMap((v) => [...v.removed, ...v.untracked]);
    const dryWithPaths = noVaultGiven
      ? preCheck
      : await erasePerson(db, { person: identity.id, dryRun: true, paths });
    return { dbReport: dryWithPaths, vaults: vaultResults, noVaultGiven };
  }

  // ── Step 4: the real database erase, with the paths the vault pass just removed. `paths` is
  //    passed only when a vault was actually looked at — see the header on why that is not the
  //    same thing as an empty list. ──────────────────────────────────────────────────────────
  const paths = vaultResults.flatMap((v) => [...v.removed, ...v.untracked]);
  const dbReport = await erasePerson(db, {
    person: identity.id,
    dryRun: false,
    ...(noVaultGiven ? {} : { paths }),
  });
  return { dbReport, vaults: vaultResults, noVaultGiven };
}

/** How many, pluralised the plain way this whole report already uses. */
function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * The full report: the database half's own report (`renderEraseReport`), plus what each vault
 * pass did — one document, in the order things actually happened, for a person who is not a
 * developer. No column names, no id conventions, no SQL.
 */
export function renderRunEraseReport(result: RunEraseResult): string {
  const out: string[] = [renderEraseReport(result.dbReport)];

  if (result.vaultError) {
    out.push("");
    out.push("## The vault pass stopped");
    out.push("");
    out.push(
      "Nothing above happened to the database either: this run stops the moment any part of it " +
        "cannot go ahead safely. " + result.vaultError,
    );
    for (const v of result.vaults.filter((c) => c.commit !== null)) {
      out.push("");
      out.push(
        `Before it stopped, ${v.removed.length + v.untracked.length} file(s) had already been ` +
          `removed from the vault at ${v.vaultRoot} (saved locally as ${v.commit}, not sent ` +
          "anywhere). Nothing else was changed. Fix what is named above and run the same " +
          "command again: it carries on from here.",
      );
    }
    return out.join("\n");
  }

  if (result.dbReport.refusals.length > 0) {
    return out.join("\n");
  }

  if (result.noVaultGiven) {
    out.push("");
    out.push("## The vault was not looked at");
    out.push("");
    out.push(
      "No `--vault` was given, so this run never looked at any notes at all — nothing there was " +
        "read, nothing was removed, and nothing about it is reported below. Run this again with " +
        "`--vault <path>` for every vault this person might have notes in.",
    );
    return out.join("\n");
  }

  for (const v of result.vaults) {
    out.push("");
    out.push(`## The vault at ${v.vaultRoot}`);
    out.push("");

    if (v.removed.length === 0 && v.untracked.length === 0) {
      out.push("No file of theirs was found here.");
    }

    if (v.removed.length > 0) {
      out.push(
        `**${count(v.removed.length, "file")}** ${result.dbReport.dryRun ? "would be" : "were"} ` +
          "removed" + (v.commit ? `, in one local commit (\`${v.commit}\`):` : ":"),
      );
      out.push("");
      for (const p of v.removed) out.push(`- ${p}`);
    }

    if (v.untracked.length > 0) {
      out.push("");
      out.push(
        `**${count(v.untracked.length, "file")}** that ${
          result.dbReport.dryRun ? "would be" : "were"
        } removed had never been saved into this vault's history at all — there is nothing kept ` +
          "anywhere of them:",
      );
      out.push("");
      for (const p of v.untracked) out.push(`- ${p}`);
    }

    if (v.leftShared.length > 0) {
      out.push("");
      out.push("**Notes that also name other people — left alone, for you to decide:**");
      out.push("");
      for (const p of v.leftShared) out.push(`- ${p}`);
    }

    if (v.commit) {
      out.push("");
      out.push(
        "That commit only exists on this machine so far. To send it on, run this yourself — it " +
          "is never run for you:",
      );
      out.push("");
      out.push(`    git -C ${v.vaultRoot} push`);
    }
  }

  return out.join("\n");
}
