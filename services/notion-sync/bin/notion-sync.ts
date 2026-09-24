#!/usr/bin/env tsx
/**
 * bin/notion-sync.ts — the container entrypoint for the notion-sync passes:
 * attendees (Phase 1), transcripts and notion-born (Phase 4), then pull → apply → push wiki →
 * push each desk dir (Phase 3), and finally people (Phase 4), in that order per tick. The
 * order is not arbitrary — see `tickPasses` in lib/cli.ts for why push may never run before
 * pull, and why people runs last.
 *
 *   tsx bin/notion-sync.ts --once      → run one tick now (manual / verification)
 *   NOTION_SYNC_LIVE=1 tsx bin/...     → daemon: run a tick every NOTION_SYNC_TICK_MS
 *
 * Plus the nine one-shot operator modes (spec §18.5, §6; T3, T4, T5, T6 and T7 are
 * Phase 4/ORB-39). They live here, not only in the commander CLI, because the box has
 * no lares checkout and the shared image ships THIS package only — this file is the
 * sole way to run them where the vault, the database and the Notion token actually
 * are. **Every operator command the docs name must appear in this list**; four of
 * them did not until the final fix wave, which made the runbook's own steps
 * un-runnable on the box:
 *
 *   tsx bin/notion-sync.ts --fidelity-record        → record the offline gate's verdicts
 *   tsx bin/notion-sync.ts --reconcile              → go-live: read all, stamp, baseline
 *   tsx bin/notion-sync.ts --enable-two-way <dir>   → flip a desk dir's rows, per file
 *   tsx bin/notion-sync.ts --resolve <path> --keep md|notion
 *                                                   → decide a frozen row (spec §6)
 *   tsx bin/notion-sync.ts --archive-excluded [--no-dry-run]
 *                                                   → T3: trash the Docs rows config's
 *                                                     deskDirs[].exclude carved out of
 *                                                     desk scope, orphan their state rows
 *   tsx bin/notion-sync.ts --adoption-report        → T5: match the 32 pre-existing vault
 *                                                     transcripts against the Meetings
 *                                                     rows. READS ONLY — no database
 *                                                     connection is opened at all
 *   tsx bin/notion-sync.ts --transcripts [--dry-run] → T4: run just that pass
 *   tsx bin/notion-sync.ts --notion-born [--dry-run] → T6: run just that pass
 *   tsx bin/notion-sync.ts --people [--dry-run]      → T7: run just that pass
 *   tsx bin/notion-sync.ts --approve <path>          → approve the open proposal for <path>
 *   tsx bin/notion-sync.ts --reject <path>           → reject the open proposal for <path>
 *
 * `--approve`/`--reject` (LAR-64) are the same fix as `--resolve`, for the same reason:
 * the commander `approve <path>` / `reject <path>` subcommands (lib/cli.ts) had no
 * caller left once the lares CLI was deleted in the split, and typing that form on
 * the box — a bare positional argument — used to fall through silently into daemon
 * mode instead of erroring.
 *
 * The three single-pass flags exist because the Phase 4 deploy enables one pass at a
 * time and previews each before enabling it: `--once --dry-run` would rehearse ALL
 * of them, including a ~400-day calendar re-scan, to preview one.
 *
 * All eleven bypass the NOTION_SYNC_LIVE gate, like --once: they are deliberate
 * one-shot operator actions. `--fidelity-record`/`--reconcile`/`--enable-two-way`
 * and the three pass flags honour --dry-run/NOTION_SYNC_DRY_RUN, defaulting to LIVE
 * like the daemon tick; `--adoption-report` ignores it, because a report that never
 * writes has nothing to rehearse and refusing the flag would be noise, not safety;
 * `--resolve`/`--approve`/`--reject` REFUSE either (each carries out a decision that
 * has already been made, so there is nothing to rehearse — and writing live behind a
 * flag that promises otherwise is worse than a clear error). `--archive-excluded` is the
 * odd one out in the OTHER direction: it trashes real Notion pages, so dry-run
 * is its DEFAULT — nothing is written unless `--no-dry-run` is passed — and it
 * REFUSES `--no-dry-run` alongside the shared --dry-run/NOTION_SYNC_DRY_RUN
 * safety net (fix round 1), the same posture as `--resolve` above: a genuine
 * contradiction between "write" and "preview" must be a loud error, never a
 * silently-picked winner (see runOneShot below and archiveExcludedDryRun's own
 * doc comment, lib/cli.ts).
 *
 * Why a daemon and not a timer: the agent box has no cron container and no oneshot
 * service. Every scheduled job there (digest, saga-dream, commercial-radar,
 * email-watcher, voice-learn) is a `restart: unless-stopped` container that ticks
 * in-process. This matches that, so the job runs under the same non-root, read-only,
 * cap-dropped, internal-network containment as its neighbours instead of as a bare
 * root process on the host.
 *
 * Runbook: docs/runbooks/notion-sync.md
 */
// Every rule about which flags may travel together lives in parseOneShotArgs
// (lib/cli.ts) — pure, exported, and tested — because it is the only logic in this
// file with a wrong answer available.
const {
  // `path` is shared by --resolve, --approve and --reject (parseOneShotArgs never
  // sets more than one mode), so this name is generic on purpose.
  once: ONCE, mode: ONE_SHOT_MODE, dir: ENABLE_DIR, path: ONE_SHOT_PATH, keep: RESOLVE_KEEP,
} = parseOneShotArgs(process.argv.slice(2));
if (ONE_SHOT_MODE === undefined && !ONCE && process.env["NOTION_SYNC_LIVE"] !== "1") {
  console.log("notion-sync: built ok — daemon gated OFF (set NOTION_SYNC_LIVE=1, or pass --once)");
  process.exit(0);
}

import {
  syncAttendeesOnce, syncWikiOnce, syncDeskPushOnce, syncPullOnce, syncApplyOnce,
  syncTranscriptsOnce, syncNotionBornOnce, syncPeopleOnce,
  runPassesContained, tickPasses, parseOneShotArgs,
  runReconcile, runEnableTwoWay, runFidelityOnce, syncDirPrefixes, resolveFrozenDoc,
  syncArchiveExcludedOnce, archiveExcludedDryRun,
  runAdoptionReportOnce, printAdoptionReport,
  approveProposal, rejectProposal, approveConsequence, rejectConsequence,
  type ResolveKeep,
} from "../lib/cli.js";
import { loadNotionSyncConfig } from "../lib/config.js";
import { DEFAULT_TOLERANCE_MINUTES } from "../lib/attendees.js";

const DRY_RUN = process.argv.includes("--dry-run") || process.env["NOTION_SYNC_DRY_RUN"] === "1";
// One source of truth for the default (lib/attendees.ts), shared with the commander CLI.
const TOLERANCE_MINUTES = Number(
  process.env["NOTION_SYNC_TOLERANCE_MINUTES"] ?? String(DEFAULT_TOLERANCE_MINUTES),
);
// Hourly. A no-op pass still re-scans the whole ~400-day calendar window in 30-day
// slices (~14 Google calls per mailbox), so a five-minute cadence spent thousands of
// API calls a day to do nothing in steady state.
const TICK_MS = Number(process.env["NOTION_SYNC_TICK_MS"] ?? "3600000");

if (!Number.isFinite(TOLERANCE_MINUTES) || TOLERANCE_MINUTES <= 0) {
  throw new Error(`NOTION_SYNC_TOLERANCE_MINUTES must be a positive number, got "${TOLERANCE_MINUTES}"`);
}

// parseOneShotArgs refuses `--resolve --dry-run`; the env variant can only be
// caught here, where the env is read. Same reason: `--resolve` carries out a
// decision that has already been made, so a "rehearsal" of it would either show
// the operator nothing or lie to them about what just happened. A box left with
// NOTION_SYNC_DRY_RUN=1 must fail this command loudly, not write behind it.
if (ONE_SHOT_MODE === "resolve" && DRY_RUN) {
  throw new Error(
    "notion-sync: --resolve is always live: it writes the side you named — " +
    "unset NOTION_SYNC_DRY_RUN (or drop --dry-run) and run it again",
  );
}

// Same posture, same reason, for the other two decisions a human has already made
// (LAR-64): parseOneShotArgs only catches a literal --dry-run flag (it is a pure
// function of argv), so a standing NOTION_SYNC_DRY_RUN=1 needs this second check.
if ((ONE_SHOT_MODE === "approve" || ONE_SHOT_MODE === "reject") && DRY_RUN) {
  throw new Error(
    `notion-sync: --${ONE_SHOT_MODE} is always live: it flips the proposal now — ` +
    "unset NOTION_SYNC_DRY_RUN (or drop --dry-run) and run it again",
  );
}

// The mirror-image refusal (fix round 1, Important 2): --no-dry-run is an
// EXPLICIT request to write, and a standing NOTION_SYNC_DRY_RUN=1 (or an
// explicit --dry-run) must not be silently overridden OR silently win either
// — the operator asked for something the environment refuses. Without this,
// the runbook's own expected "N trashed" output would print unchanged
// whether or not the command actually wrote anything, because DRY_RUN winning
// quietly (archiveExcludedDryRun's `||`) produces byte-identical wording
// otherwise (see runArchiveExcluded's dry-run/live summary distinction).
if (ONE_SHOT_MODE === "archive-excluded" && DRY_RUN && process.argv.includes("--no-dry-run")) {
  throw new Error(
    "notion-sync: --no-dry-run conflicts with --dry-run / NOTION_SYNC_DRY_RUN=1 — " +
    "unset the safety net (or drop --no-dry-run) and run it again",
  );
}

/** Returns the number of rows whose outcome never reached the state database. */
async function runAttendeePass(): Promise<number> {
  const result = await syncAttendeesOnce({
    dryRun: DRY_RUN,
    toleranceMinutes: TOLERANCE_MINUTES,
  });
  console.log(`notion-sync: ${result.summary}`);
  if (result.bookkeepingFailed > 0) {
    // Contained, not hidden: Notion is correct for these rows and the local record
    // is not, permanently — the next pass skips them because Attendees is no longer
    // empty. Nothing to retry, so the daemon logs loudly and carries on.
    console.error(
      `notion-sync: ${result.bookkeepingFailed} row(s) could not be recorded in the ` +
      `state database; see the errors above. Notion is correct, the local record is not.`,
    );
  }
  return result.bookkeepingFailed;
}

/** Same contract for the wiki pass; 0 when the pass is not configured (it logs its own skip). */
async function runWikiPass(): Promise<number> {
  const result = await syncWikiOnce({ dryRun: DRY_RUN });
  if (result === null) return 0;
  console.log(`notion-sync: wiki ${result.summary}`);
  if (result.bookkeepingFailed > 0) {
    // Higher stakes than the attendee variant: an unrecorded CREATE means the next
    // tick makes a duplicate page (see wiki-sync.ts). Still contained — the daemon
    // logs loudly and carries on.
    console.error(
      `notion-sync: ${result.bookkeepingFailed} doc(s) could not be recorded in the ` +
      `state database; see the errors above. Notion may be correct, the local record is not.`,
    );
  }
  return result.bookkeepingFailed;
}

/**
 * The Meetings transcripts Notion holds, proposed into the vault (T4). Writes
 * neither side itself; 0 when the pass is not configured (it logs its own skip).
 */
async function runTranscriptPass(): Promise<number> {
  const result = await syncTranscriptsOnce({ dryRun: DRY_RUN });
  if (result === null) return 0;
  for (const skip of result.skipped) {
    console.log(`notion-sync: transcripts: ${skip.vaultPath ?? skip.pageId} — ${skip.reason}`);
  }
  console.log(`notion-sync: transcripts ${result.summary}`);
  return result.bookkeepingFailed;
}

/**
 * T6: pages a human created in Notion, proposed into the vault as NEW FILES. Writes
 * neither side itself; 0 when the pass is not configured (it logs its own skip).
 */
async function runNotionBornPass(): Promise<number> {
  const result = await syncNotionBornOnce({ dryRun: DRY_RUN });
  if (result === null) return 0;
  for (const skip of result.skipped) {
    console.log(`notion-sync: notion-born: ${skip.vaultPath ?? skip.pageId} — ${skip.reason}`);
  }
  console.log(`notion-sync: notion-born ${result.summary}`);
  return result.bookkeepingFailed;
}

/**
 * T7: the people the Meetings rows name, projected from the source of truth, and
 * the relation between the two. Writes only Notion (the People database and two
 * Meetings properties), never the vault and never the store — so it has no
 * bookkeeping to fail and returns its ERROR count instead, which is the same
 * contract from the tick's point of view: "this pass did not finish what it set
 * out to do". 0 when the pass is not configured (it logs its own skip).
 */
async function runPeoplePass(): Promise<number> {
  const result = await syncPeopleOnce({ dryRun: DRY_RUN });
  if (result === null) return 0;
  for (const dup of result.duplicates) {
    console.log(`notion-sync: people: duplicate email ${dup.email} — rows ${dup.pageIds.join(", ")}`);
  }
  for (const skip of result.skipped) {
    console.log(`notion-sync: people: ${skip.name} (${skip.sourceId}) — ${skip.reason}`);
  }
  for (const clash of result.contestedAddresses) {
    console.log(
      `notion-sync: people: contested address ${clash.email} — stays with ${clash.boundTo} ` +
      `(${clash.boundBy}); also claimed by ${clash.alsoClaimedBy.join(", ")}`,
    );
  }
  for (const row of result.relabelled) {
    console.log(`notion-sync: people: row ${row.pageId} renamed "${row.from}" → "${row.to}"`);
  }
  for (const skip of result.meetingsSkipped) {
    console.log(`notion-sync: people: meeting ${skip.pageId} — ${skip.reason}`);
  }
  for (const late of result.lateLinks) {
    console.log(`notion-sync: people: meeting ${late.pageId} gained ${late.emails.join(", ")}`);
  }
  console.log(`notion-sync: people ${result.summary}`);
  return result.errored;
}

/** What Notion holds: mirror edits reverted, desk edits proposed, conflicts frozen. */
async function runPullPass(): Promise<number> {
  const result = await syncPullOnce({ dryRun: DRY_RUN });
  if (result === null) return 0;
  console.log(`notion-sync: pull ${result.summary}`);
  return result.bookkeepingFailed;
}

/** The decisions a human made on proposals — the only pass that writes the vault. */
async function runApplyPass(): Promise<number> {
  const result = await syncApplyOnce({ dryRun: DRY_RUN });
  if (result === null) return 0;
  console.log(`notion-sync: apply ${result.summary}`);
  return result.bookkeepingFailed;
}

/** Each configured desk folder, pushed md→Notion by the same engine as the wiki. */
async function runDeskPass(): Promise<number> {
  const result = await syncDeskPushOnce({ dryRun: DRY_RUN });
  if (result === null) return 0;
  for (const dir of result.perDir) console.log(`notion-sync: desk ${dir.dir}: ${dir.summary}`);
  // A dir whose pass threw is counted alongside bookkeeping drift so the tick
  // reports unclean: both mean "this tick did not finish what it set out to do".
  return result.bookkeepingFailed + result.dirsFailed;
}

/**
 * One tick, in the order lib/cli.ts's tickPasses fixes (pull before any push —
 * read its comment before changing anything here), each pass contained by
 * runPassesContained so a throwing attendee pass (bad principal, calendar
 * outage) can never starve the rest, or vice versa. Resolves true only when
 * every pass was clean.
 */
const runTick = (): Promise<boolean> => runPassesContained(tickPasses({
  attendees: runAttendeePass,
  transcripts: runTranscriptPass,
  notionBorn: runNotionBornPass,
  pull: runPullPass,
  apply: runApplyPass,
  wiki: runWikiPass,
  desk: runDeskPass,
  people: runPeoplePass,
}));

/**
 * The one-shot operator modes. Deliberately mutually exclusive and checked before
 * the tick: each is an operator action with its own report, and none of them is
 * something to run "as well as" a tick — `reconcile` in particular reads every
 * page and must not race the passes that would read them again, and `--resolve`
 * writes the side a human chose on a row a concurrent pull would otherwise be
 * re-freezing underneath them. All of them run against a quiesced daemon (see
 * the runbook's one-shot rule).
 */
async function runOneShot(): Promise<boolean> {
  // The three single-pass previews. Each reuses the SAME runner the tick uses, so
  // the output an operator reads here is byte-for-byte the output the daemon would
  // print — a second, prettier report for the box is a report that drifts. The exit
  // code follows the tick's own contract: the runner returns the count of things
  // that did not reach the state database (people has no store of its own, so it
  // returns its ERROR count), and anything other than zero is a non-zero exit.
  if (ONE_SHOT_MODE === "transcripts") return await runTranscriptPass() === 0;
  if (ONE_SHOT_MODE === "notion-born") return await runNotionBornPass() === 0;
  if (ONE_SHOT_MODE === "people") return await runPeoplePass() === 0;

  if (ONE_SHOT_MODE === "adoption-report") {
    // T5. Never opens a database connection — see runAdoptionReportOnce's own doc
    // comment for why that is a property of the function rather than a promise this
    // branch keeps, and cli.test.ts for the test that runs it with no Postgres
    // reachable at all. Nothing here may add one.
    const result = await runAdoptionReportOnce();
    if (result === null) return true;   // not configured — it logged the skip
    printAdoptionReport(result);
    // Always clean: every outcome, including "nothing matched", is a finding to read
    // rather than a failure. A non-zero exit would make an honest empty report look
    // like a broken command.
    return true;
  }

  if (ONE_SHOT_MODE === "fidelity-record") {
    const cfg = loadNotionSyncConfig();
    const run = await runFidelityOnce({
      vaultPath: cfg.vaultPath,
      eligiblePrefixes: syncDirPrefixes(cfg),
      // The whole point of this mode: the table `enable-two-way` consults lives in
      // the box's database, so the verdicts have to be recorded from the box.
      record: true,
    });
    console.log(`notion-sync: ${run.summary}`);
    for (const f of run.failed) {
      console.log(`  ${f.eligible ? "[eligible]" : "[report-only]"} ${f.path}: ${f.reason}`);
    }
    return run.eligibleFailedCount === 0;
  }

  if (ONE_SHOT_MODE === "resolve") {
    // The one operator action with no dry-run: the human has already decided
    // which side wins, and the command writes only that side (spec §6).
    // Deliberately not wrapped — resolveFrozenDoc throws with the failing step
    // for a row that is not frozen, a path with no row, or a Notion write that
    // did not land, and the row stays frozen. Letting that escape prints the
    // message and exits non-zero, which is exactly the report an operator wants.
    console.log(await resolveFrozenDoc(ONE_SHOT_PATH as string, RESOLVE_KEEP as ResolveKeep));
    return true;
  }

  // `--approve`/`--reject` (LAR-64): the runbook's fallback for when Saga is down,
  // now runnable where the vault, the database and the token actually are. Both
  // print the SAME consequence line as the commander `approve <path>` / `reject
  // <path>` commands below (approveConsequence/rejectConsequence, shared with
  // Saga's DM, her hand and the console card) — one sentence, not a seventh
  // author of it. Deliberately not wrapped, same reason as --resolve above:
  // approveProposal/rejectProposal throw when there is no open proposal for the
  // path, and that is exactly the report an operator wants to see.
  if (ONE_SHOT_MODE === "approve") {
    const row = await approveProposal(ONE_SHOT_PATH as string);
    console.log(`notion-sync: approved ${ONE_SHOT_PATH as string} — ${approveConsequence(row)}`);
    return true;
  }
  if (ONE_SHOT_MODE === "reject") {
    const row = await rejectProposal(ONE_SHOT_PATH as string);
    console.log(`notion-sync: rejected ${ONE_SHOT_PATH as string} — ${rejectConsequence(row)}`);
    return true;
  }

  if (ONE_SHOT_MODE === "archive-excluded") {
    // Extracted, pure and tested — see archiveExcludedDryRun's own doc comment
    // (lib/cli.ts) for the polarity table and why this line, not a bespoke
    // expression here, decides it (fix round 1, Important 1).
    const dryRun = archiveExcludedDryRun(process.argv, DRY_RUN);
    const result = await syncArchiveExcludedOnce({ dryRun });
    // "would trash" vs "trashed" (fix round 1, Important 2) — result.dryRun,
    // not the local `dryRun` const, is the source of truth: it is what the
    // engine actually did.
    const verb = result.dryRun ? "would trash" : "trashed";
    for (const row of result.trashed) console.log(`  ${verb}: ${row.vaultPath}  (${row.pageId})`);
    for (const row of result.alreadyDone) console.log(`  already done: ${row.vaultPath}  (${row.pageId})`);
    for (const row of result.skipped) console.log(`  skipped: ${row.vaultPath} — ${row.reason}`);
    for (const row of result.failed) console.log(`  FAILED: ${row.vaultPath} — ${row.reason}`);
    for (const row of result.orphanFailed) console.log(`  ORPHAN-FAILED: ${row.vaultPath} — ${row.reason}`);
    console.log(`notion-sync: ${result.summary}`);
    return result.failed.length === 0 && result.orphanFailed.length === 0;
  }

  if (ONE_SHOT_MODE === "reconcile") {
    const result = await runReconcile({ dryRun: DRY_RUN });
    if (result === null) return true; // not configured — runReconcile logged the skip
    console.log(`notion-sync: ${result.summary}`);
    return result.pull.bookkeepingFailed === 0 && result.stampFailed === 0
      && result.baselineFailed === 0;
  }

  const result = await runEnableTwoWay(ENABLE_DIR as string, { dryRun: DRY_RUN });
  for (const path of result.enabled) console.log(`  enabled  ${path}`);
  for (const skip of result.skipped) console.log(`  skipped  ${skip.vaultPath} — ${skip.reason}`);
  console.log(`notion-sync: ${result.summary}`);
  // A skip is the gate working, not a failure — the report is the output, and a
  // non-zero exit here would make the ordinary "3 of 4 files qualified" outcome
  // look like something went wrong.
  return true;
}

if (ONE_SHOT_MODE !== undefined) {
  process.exitCode = await runOneShot() ? 0 : 1;
} else if (ONCE) {
  // Same contract as the commander commands: a tick that logged a pass failure or
  // permanent drift must not report success, because the runbook's on-demand check
  // is scriptable. No process.exit() — each pass closes its own pool, so there is
  // nothing holding the loop open, and exiting here could truncate the summary line
  // on the pipe that `docker compose exec -T` reads it from.
  process.exitCode = await runTick() ? 0 : 1;
} else {
  // Ticks must not re-enter while a pass runs: a first live wiki pass (the
  // backfill) can take ~15-20 min, and an hourly interval firing into it would
  // interleave two engines over the same state rows.
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      // Per-pass failures are already contained inside runTick; this catch is the
      // daemon's last line against a bug in the tick plumbing itself, because a
      // rejection escaping `void tick()` would take the whole daemon down.
      await runTick();
    } catch (err) {
      console.error("notion-sync: tick failed", err);
    } finally {
      running = false;
    }
  };

  console.log(
    `notion-sync: daemon up — one tick ` +
    `(attendees → transcripts → notion-born → pull → apply → push wiki → push desks → people) ` +
    `every ${TICK_MS}ms, tolerance ${TOLERANCE_MINUTES} min` +
    `${DRY_RUN ? ", DRY-RUN (writes nothing)" : ""}`,
  );
  await tick();
  setInterval(() => { void tick(); }, TICK_MS);
}
