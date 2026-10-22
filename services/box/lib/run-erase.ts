// services/box/lib/run-erase.ts — wires the database half (lib/erase-person.ts) and the
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

import type { Pool, PoolClient } from "pg";
import { erasePerson, withPersonErasureClient, renderEraseReport, type EraseReport } from "./erase-person.js";
import { erasePersonFiles, findPersonFiles, ErasePersonFilesError, type VaultHit } from "./erase-person-vault.js";
import {runJournaledPersonErasure,type PersonErasureFinancialContext} from "../../keeper/lib/person-erasure.js";
import type {HostFinancialJournal} from "../../keeper/lib/financial-journal.js";
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
  /** Required for every apply. This is the existing prepared host custody, never initialized here. */
  journal?:HostFinancialJournal;
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
  transactionOutcome?:"rollback-acknowledged"|"commit-acknowledged"|"unknown"|"not-started";
  journalWarning?:string;
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
  const { db, person, apply } = opts;
  const noVaultGiven = opts.vaults.length === 0;

  if(apply){
    if(!opts.journal?.prepared)return {dbReport:refusalReport(person,'Prepared financial custody is required before erasure.'),vaults:[],noVaultGiven};
    let partial:RunEraseResult|undefined;
    try{
      const {value}=await runJournaledPersonErasure(db as never,opts.journal,async(source,financial)=>{
        let identity;
        try{identity=await resolvePerson(source as never,person);}catch(err){
          if(err instanceof PersonNotFound||err instanceof PersonAmbiguous||err instanceof IdentityRegisterMissing)
            throw new ErasureRefused({dbReport:refusalReport(person,messageOf(err)),vaults:[],noVaultGiven});
          throw err;
        }
        const client=source as PoolClient;
        return withPersonErasureClient(client,identity.id,financial.owner,async()=>{
          const preCheck=await erasePerson(client,{person:identity.id,dryRun:true,resolvedIdentity:identity,journalOwner:financial.owner});
          partial={dbReport:preCheck,vaults:[],noVaultGiven};
          if(preCheck.refusals.length)throw new ErasureRefused({dbReport:preCheck,vaults:[],noVaultGiven});
          const closure=await financial.prepare(source,identity.id);
          const result=await runEraseOwned(opts,identity,client,preCheck,financial,closure,value=>{partial=value;});
          partial=result;
          if(result.vaultError||result.dbReport.refusals.length)throw new ErasureRefused(result);
          return result;
        });
      });
      return {...value,transactionOutcome:"commit-acknowledged"};
    }catch(err){
      const outcome=(err as {outcome?:string}).outcome;
      if(err instanceof ErasureRefused)return {...err.result,transactionOutcome:(outcome as RunEraseResult["transactionOutcome"])??"rollback-acknowledged"};
      if(partial?.dbReport.refusals.length)return {...partial,transactionOutcome:(outcome as RunEraseResult["transactionOutcome"])??"rollback-acknowledged"};
      if(outcome==='commit-acknowledged'&&partial)return {...partial,transactionOutcome:"commit-acknowledged",journalWarning:"The database commit was acknowledged, but its final journal record could not be confirmed. Inspect custody before another financial operation."};
      const safeCause=err instanceof Error&&(err.message.startsWith('Cannot erase the last active organisation owner;')||err.message==='Financial erasure proposal exceeds the journal record limit')?err.message:undefined;
      const failure=outcome==='unknown'
        ?'The database outcome is unknown. The journal is frozen; inspect the database and local files before recovery or retry.'
        :safeCause??'The database transaction was rolled back. Any file removals shown below already happened and were not rolled back.';
      return partial
        ?{...partial,transactionOutcome:(outcome as RunEraseResult["transactionOutcome"])??"not-started",dbReport:{...partial.dbReport,planned:[],deleted:[],refusals:[failure]}}
        :{dbReport:{...refusalReport(person,failure),dryRun:false},vaults:[],noVaultGiven,transactionOutcome:(outcome as RunEraseResult["transactionOutcome"])??"not-started"};
    }
  }

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

  return runEraseOwned(opts,identity,db);
}

class ErasureRefused extends Error {constructor(readonly result:RunEraseResult){super('Person erasure refused');}}

async function runEraseOwned(opts:RunEraseOptions,identity:Awaited<ReturnType<typeof resolvePerson>>,db:Pool|PoolClient,
  preCheck?:EraseReport,financial?:PersonErasureFinancialContext,closure?:Awaited<ReturnType<PersonErasureFinancialContext['prepare']>>,
  progress?:(result:RunEraseResult)=>void):Promise<RunEraseResult>{
  const {vaults,apply}=opts,noVaultGiven=vaults.length===0;
  // ── Step 2: a database dry run, before any file anywhere is touched. ──────────────────────
  preCheck ??= await erasePerson(db, { person: identity.id, dryRun: true,resolvedIdentity:identity });
  if (preCheck.refusals.length > 0) {
    return { dbReport: preCheck, vaults: [], noVaultGiven };
  }

  // ── Step 3: the vault pass, per --vault, read-only unless --apply. A throw here stops
  //    everything before the database is touched — `dbReport` stays the dry run above. ────────
  //    Every vault is walked read-only FIRST, so a vault that cannot be read at all is found out
  //    before the first one has been changed. If a later vault still fails during the real pass
  //    (somebody's staged changes, say), what was already removed is reported, never dropped.
  const vaultResults: VaultPassResult[] = [];
  let activeVault:{vaultRoot:string;hits:VaultHit[]}|undefined;
  try {
    const found = vaults.map((vaultRoot) => ({
      vaultRoot,
      hits: findPersonFiles(vaultRoot, identity.spellings),
    }));
    for (const { vaultRoot, hits } of found) {
      activeVault={vaultRoot,hits};
      await erasePersonFiles({ vaultRoot, hits, dryRun: true });
    }
    for (const { vaultRoot, hits } of found) {
      activeVault={vaultRoot,hits};
      const out = await erasePersonFiles({ vaultRoot, hits, dryRun: !apply });
      vaultResults.push({ vaultRoot, hits, ...out });
      progress?.({dbReport:apply?{...preCheck,dryRun:false}:preCheck,vaults:[...vaultResults],noVaultGiven});
      activeVault=undefined;
    }
  } catch (err) {
    if(err instanceof ErasePersonFilesError&&activeVault)vaultResults.push({vaultRoot:activeVault.vaultRoot,hits:activeVault.hits,...err.partial});
    return { dbReport:apply?{...preCheck,dryRun:false,refusals:["The database was not changed because the vault pass did not finish."]}:preCheck,
      vaults: vaultResults, noVaultGiven, vaultError: messageOf(err) };
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
    resolvedIdentity:identity,
    journalOwner:financial?.owner,
    ...(noVaultGiven ? {} : { paths }),
  });
  const withDbReport={dbReport,vaults:vaultResults,noVaultGiven};
  progress?.(withDbReport);
  if(dbReport.refusals.length)return withDbReport;
  if(!financial||!closure)throw new Error('Journaled financial erasure context is unavailable');
  await financial.finalize(db as never,closure);
  return withDbReport;
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
  if(result.transactionOutcome==='unknown'){
    const out=[`# Erasing ${result.dbReport.person}`,"","**The database outcome is unknown.** The journal is frozen. Inspect the database and every listed vault before recovery or retry."];
    if(result.vaults.length)for(const v of result.vaults){
      out.push("",`${v.vaultRoot}: ${v.removed.length+v.untracked.length} file(s) removed${v.commit?`, local commit ${v.commit}`:""}.`);
      out.push(...[...v.removed,...v.untracked].map(path=>`- ${path}`));
    }
    return out.join("\n");
  }
  const out: string[] = [renderEraseReport(result.dbReport)];
  if(result.journalWarning)out.push("",`**${result.journalWarning}**`);

  if (result.vaultError) {
    out.push("");
    out.push("## The vault pass stopped");
    out.push("");
    out.push(
      "Nothing above happened to the database either: this run stops the moment any part of it " +
        "cannot go ahead safely. " + result.vaultError,
    );
    for (const v of result.vaults.filter((c) => c.removed.length > 0 || c.untracked.length > 0)) {
      out.push("");
      out.push(
        `Before it stopped, ${v.removed.length + v.untracked.length} file(s) had already been ` +
          `removed from the vault at ${v.vaultRoot}${v.commit?` (local commit ${v.commit}, not sent anywhere)`:" (some local file changes may be staged)"}. ` +
          "Those file removals remain. Review the vault and database state before deciding what to do next.",
      );
      out.push(...[...v.removed,...v.untracked].map(path=>`- ${path}`));
    }
    return out.join("\n");
  }

  if (result.dbReport.refusals.length > 0) {
    const filesChanged=!result.dbReport.dryRun&&result.vaults.some(v=>v.removed.length>0||v.untracked.length>0);
    if(!filesChanged)return out.join("\n");
    out.push("");
    out.push("The database transaction did not commit. The file removals below already happened and were not rolled back; inspect current state before any retry.");
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
