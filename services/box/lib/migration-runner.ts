// The migration runner: what is on disk, what the ledger says, and what may therefore run
// (ADR-0021 rule 3). The ledger itself is lib/migration-ledger.ts + sql/062_schema_migrations.sql.
//
// WHAT THIS REPLACES. services/box/migrate.ts re-ran every *.sql file on every invocation and the
// only thing that made that safe was every migration being hand-written to be re-runnable. From
// the first public release that stops holding, so what ran is recorded rather than assumed.
//
// THE THREE REFUSALS, and why each one is a refusal rather than a guess:
//
//   out of order — a file NOT in the ledger whose number is strictly LESS than the highest number
//     in the ledger. Stated that precisely on purpose:
//       · equal numbers are fine. services/box/sql/ has two files numbered 019 (019_atlas_sync.sql
//         and 019_obligations.sql); a rule that refused duplicates would refuse today's tree.
//       · a GAP is not an error. 047 does not exist in services/box/sql/ at all. The runner never
//         demands a gapless sequence; it only refuses to slot a new file BENEATH work already done.
//       · the comparison is against the LEDGER, never against what else is on disk. A release that
//         adds 047 and 051 next to an untouched database applies them in number order like
//         anything else — they are only refused on a database that has already applied a HIGHER
//         number, where inserting a step underneath a finished one is exactly the ambiguity the
//         ledger exists to stop. The remedy is in the message: renumber above the highest applied.
//
//   changed since it was applied — a file in the ledger whose bytes no longer hash to what was
//     recorded. Re-running it might be harmless or might not, and the runner is not in a position
//     to know which. This is also what a legitimate regeneration looks like: for example
//     services/chief-of-staff/sql/001-eve-workflow.sql is GENERATED (see its header and
//     `pnpm -C services/chief-of-staff run regen:eve-sql:check`), so a @workflow/world-postgres
//     bump changes its bytes by design. Flagging that is correct behaviour, not a bug — the
//     operator decides, and W3D-s5's CLI prints the remedy.
//
//   no longer on disk — a ledger row with no matching file. This is what a bad rebase or a wrong
//     checkout looks like, which is precisely when a runner must stop rather than carry on.
//
// ALL-OR-NOTHING. If the plan holds ANY refusal, nothing is applied at all — not even the valid
// files before the refused one. "It applied the first four and then stopped" is the hardest state
// to reason about at 2am.
//
// THE FOURTH REFUSAL, and the only one that is not about a file: a database that already has a
// schema and an empty (or absent) ledger. That is what a database migrated by hand before this
// runner existed looks like, and applying to it would re-run every migration it already carries.
// The runner will not guess: it stops and asks for a one-time ADOPTION naming the last file that
// was really applied (`adoptMigrations`, below). A DRY RUN is exempt — it changes nothing, and
// looking is precisely how the operator works out what to name. See ADR-0021 and the plan's D1/D2.
//
// NO DOWN MIGRATIONS. This runner only ever moves forward — there is no "undo one migration"
// command and none is planned. ADR-0021 rule 3 asks for a migration that applies itself; a down
// migration is a second thing to write correctly for every change, and the rollback story is an
// image digest plus a restore (wave 8D), not SQL run backwards. Do not add one on your own
// initiative — see the plan's "D. Drop or move" for track 3D.
//
// HOW EACH FILE IS APPLIED, and the Postgres fact that shapes it. One file goes to the database as
// ONE simple query, `BEGIN; <ledger row>; <the file's bytes>; COMMIT;`, so a single connection
// runs the whole thing and a failure anywhere rolls back both the schema change and its ledger
// row. The ledger INSERT comes FIRST, before the file's own text, and that order is deliberate:
// Postgres has no nested transactions, so a migration that ships its own `BEGIN;…COMMIT;` — 20 of
// the 51 files in services/box/sql do, and it is the house style — ends the outer transaction at
// its own COMMIT. With the ledger row written first it is inside that transaction and commits with
// the schema change; written last it would be a second, separate commit, and a crash in between
// would leave a migration applied with nothing recording it, which is the single failure the
// ledger exists to prevent. tests/migration-runner.test.ts pins this with a ledger write made to
// fail. (Known residue, unavoidable without parsing SQL: statements placed AFTER a file's own
// COMMIT are in a transaction of their own. No file in services/box/sql does that today.)
import { isRetiredInstallationSeed } from "./migration-seed-cleanup.js";
import { isCommentOnlyMigration } from "./migration-comment-checksums.js";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Queryable } from "./db.js";
import { checksumOf, ensureLedger, listApplied, type AppliedMigration } from "./migration-ledger.js";

export interface MigrationFile {
  filename: string;
  number: number;
  path: string;
  bytes: string;
  checksum: string;
}

export type PlanStep =
  | { action: "apply"; file: MigrationFile }
  | { action: "skip"; file: MigrationFile; reason: "already applied" }
  | { action: "refuse"; file: MigrationFile; reason: string };

/** The refusing variant of PlanStep, so `refusals[0].reason` is readable without a narrowing. */
export type RefusedStep = Extract<PlanStep, { action: "refuse" }>;

export interface MigrationPlan {
  steps: PlanStep[];
  refusals: RefusedStep[];
}

export interface RunResult {
  applied: string[];
  skipped: string[];
  refused: Array<{ filename: string; reason: string }>;
}

/** `NNN_name.sql` (services/box/sql) and `NNN-name.sql` (the per-role sql folders) both count. */
const NUMBERED = /^(\d{3})[-_]/;

/** Reads a directory into ordered MigrationFiles. Accepts `NNN_name.sql` and `NNN-name.sql`. */
export function readMigrations(dir: string): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .map((filename) => {
      const matched = NUMBERED.exec(filename);
      if (!matched) {
        // A file the runner cannot order is not a file it may guess about.
        throw new Error(
          `migrations: ${filename} in ${dir} has no NNN_ or NNN- prefix, so there is no place to put it in the order — rename it`,
        );
      }
      const path = join(dir, filename);
      const bytes = readFileSync(path, "utf8");
      return { filename, number: Number(matched[1]), path, bytes, checksum: checksumOf(bytes) };
    });
  // Number first, then filename: the two 019s then have one stable order rather than readdir's.
  files.sort((x, y) => x.number - y.number || (x.filename < y.filename ? -1 : x.filename > y.filename ? 1 : 0));
  return files;
}

function when(appliedAt: Date): string {
  return appliedAt instanceof Date ? appliedAt.toISOString() : String(appliedAt);
}

/** Pure. Given what is on disk and what the ledger says, decide what would happen. */
export function planMigrations(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): MigrationPlan {
  const ledger = new Map(applied.map((row) => [row.filename, row]));
  // The highest NUMBER in the ledger, and the row that carries it, for the out-of-order message.
  // First one wins on a tie: any of them makes the same statement about the same number.
  const highest = applied.reduce<AppliedMigration | undefined>(
    (best, row) => (best === undefined || row.number > best.number ? row : best),
    undefined,
  );

  const steps: PlanStep[] = [];
  for (const file of files) {
    const already = ledger.get(file.filename);
    if (already) {
      if (already.checksum === file.checksum || isCommentOnlyMigration(file.filename, already.checksum, file.checksum) || isRetiredInstallationSeed(file.filename, already.checksum, file.checksum)) {
        steps.push({ action: "skip", file, reason: "already applied" });
      } else {
        steps.push({
          action: "refuse",
          file,
          reason:
            `changed since it was applied on ${when(already.appliedAt)}: ${file.filename}. ` +
            "A migration is a historical record; edit it only if you also intend to re-apply it by hand and correct the ledger.",
        });
      }
      continue;
    }
    if (highest !== undefined && file.number < highest.number) {
      steps.push({
        action: "refuse",
        file,
        reason:
          `out of order: ${file.filename} is numbered below ${highest.filename}, which has already been applied ` +
          `— renumber it above ${highest.number}`,
      });
      continue;
    }
    steps.push({ action: "apply", file });
  }

  // A ledger row with nothing on disk to match it. There is no MigrationFile to carry, so one is
  // synthesised from the row itself: `bytes` is empty because the bytes are exactly what is gone.
  const onDisk = new Set(files.map((file) => file.filename));
  const dir = files.length > 0 ? dirname(files[0]!.path) : "the migrations directory";
  for (const row of applied) {
    if (onDisk.has(row.filename)) continue;
    steps.push({
      action: "refuse",
      file: { filename: row.filename, number: row.number, path: join(dir, row.filename), bytes: "", checksum: row.checksum },
      reason:
        `no longer on disk: ${row.filename} was applied on ${when(row.appliedAt)} but is not in ${dir}. ` +
        "Restore it, or the runner cannot tell whether this database matches this release.",
    });
  }

  return { steps, refusals: steps.filter(isRefusal) };
}

function isRefusal(step: PlanStep): step is RefusedStep {
  return step.action === "refuse";
}

/** Doubles the quotes in a SQL string literal. The values are the runner's own, but the ledger
 *  INSERT has to travel inside a multi-statement query, where parameters are not available. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The same row `recordApplied` writes, as text — see the header for why it cannot be a separate
 *  parameterised call. `took_ms` starts at 0 and is corrected once the file has committed. */
function ledgerInsert(file: MigrationFile): string {
  return (
    "INSERT INTO schema_migrations (filename, number, checksum, how, took_ms) VALUES (" +
    `${literal(file.filename)}, ${file.number}, ${literal(file.checksum)}, 'applied', 0);`
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Postgres's `undefined_table` code — what `SELECT … FROM schema_migrations` raises when the
 *  ledger has never been created. */
function isMissingLedgerTable(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "42P01";
}

/** The read `runMigrations` does against the ledger. A real run needs the table to exist (see its
 *  own doc comment); a dry run does not — reading `schema_migrations` before it has ever been
 *  created is exactly what "what would happen, on a fresh install" looks like, so a dry run treats
 *  a missing table as an empty ledger rather than creating it or failing.
 *
 *  On a REAL run a missing table is not an error either when the database already has a schema:
 *  that is the unadopted case, and `UNADOPTED_DATABASE` is a far more useful thing to read than
 *  `relation "schema_migrations" does not exist`. */
async function ledgerFor(db: Queryable, dryRun: boolean): Promise<AppliedMigration[]> {
  try {
    return await listApplied(db);
  } catch (err) {
    if (isMissingLedgerTable(err)) {
      if (dryRun) return [];
      if (await looksAlreadyMigrated(db)) throw new Error(UNADOPTED_DATABASE);
    }
    throw err;
  }
}

/**
 * True when the ledger is empty but the database plainly already has a schema.
 *
 * Deliberately crude, and deliberately NOT a list of expected table names: a list would be a
 * second copy of the schema that has to be maintained in step with it, and the question here is
 * only "is this a fresh database or not". The ledger's own table does not count — `ensureLedger`
 * runs before the check on the CLI's path, and a ledger table with nothing in it is not a schema.
 */
export async function looksAlreadyMigrated(db: Queryable): Promise<boolean> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name <> 'schema_migrations'`,
  );
  return Number(rows[0]?.n ?? "0") > 0;
}

/**
 * What `runMigrations` throws rather than applying to a database that predates the runner.
 *
 * Exported so W3D-s5's CLI can also print it on a DRY RUN, where `runMigrations` deliberately does
 * not throw: without it a dry run against the live installation would print "51 to apply" and say
 * nothing about the fact that the real run will refuse.
 *
 * This is the one place the runner talks to a person in full sentences, because it is the one
 * place a person has to make a judgement.
 */
export const UNADOPTED_DATABASE = [
  "This database already has a schema but no migration ledger. That is what a database",
  "migrated before the runner existed looks like. Confirm which migrations have already been",
  "applied, then adopt them:",
  "",
  "    pnpm -C services/box migrate --adopt-through <filename> --dry-run",
  "    pnpm -C services/box migrate --adopt-through <filename>",
  "",
  "Nothing was applied.",
].join("\n");

/**
 * Applies the plan. Refuses to apply ANYTHING if the plan contains a refusal.
 *
 * The ledger table must already exist for a real run — call `ensureLedger` first. This function
 * never creates it, so that a dry run touches the database for nothing but the read (and, on a
 * database where the table does not exist yet, not even that succeeds — see `ledgerFor`).
 *
 * Throws `UNADOPTED_DATABASE` on a real run against a database that has a schema and an empty
 * ledger, without applying anything. See the header's fourth refusal.
 */
export async function runMigrations(
  db: Queryable,
  dir: string,
  opts: { dryRun?: boolean } = {},
): Promise<RunResult> {
  const dryRun = opts.dryRun ?? false;
  const files = readMigrations(dir);
  const applied0 = await ledgerFor(db, dryRun);
  // An empty ledger means one of two things and the runner cannot tell them apart by looking at
  // the ledger: a fresh database, or one migrated by hand before the ledger existed. The schema
  // is what separates them.
  if (!dryRun && applied0.length === 0 && (await looksAlreadyMigrated(db))) {
    throw new Error(UNADOPTED_DATABASE);
  }
  const plan = planMigrations(files, applied0);
  const skipped = plan.steps.filter((step) => step.action === "skip").map((step) => step.file.filename);

  if (plan.refusals.length > 0) {
    return {
      applied: [],
      skipped,
      refused: plan.refusals.map((step) => ({ filename: step.file.filename, reason: step.reason })),
    };
  }
  if (opts.dryRun) return { applied: [], skipped, refused: [] };

  const applied: string[] = [];
  for (const step of plan.steps) {
    if (step.action !== "apply") continue;
    const file = step.file;
    const body = file.bytes.trim();
    const statement = body.endsWith(";") ? body : `${body};`;
    const startedAt = Date.now();
    try {
      await db.query(`BEGIN;\n${ledgerInsert(file)}\n${statement}\nCOMMIT;\n`);
    } catch (err) {
      // Stop here: the files after this one are not attempted, and this one rolled back whole.
      throw new Error(`${file.filename}: ${messageOf(err)}`, { cause: err });
    }
    await db.query("UPDATE schema_migrations SET took_ms = $1 WHERE filename = $2", [
      Date.now() - startedAt,
      file.filename,
    ]);
    applied.push(file.filename);
  }
  return { applied, skipped, refused: [] };
}

/** `apply `, `skip  ` or `refuse` padded to one fixed width, so the filenames line up. */
const ACTION_LABEL: Record<PlanStep["action"], string> = {
  apply: "apply".padEnd(7),
  skip: "skip".padEnd(7),
  refuse: "refuse".padEnd(7),
};

/** Files the runner does not author — a changed checksum on one of these is a deliberate
 *  regeneration, not tampering, and the refusal should name the remedy rather than read like a
 *  bug report. services/chief-of-staff/sql/001-eve-workflow.sql is regenerated on every
 *  @workflow/world-postgres bump (see its own header and `regen:eve-sql:check`). A second
 *  generated file later is one more entry here, not a second branch in renderPlan. */
const GENERATED_FILES: ReadonlyMap<RegExp, string> = new Map([
  [
    /^001[-_]eve[-_]workflow\.sql$/,
    "this file is generated from @workflow/world-postgres — if you regenerated it deliberately, " +
      "first look in this directory for a companion *-eve-workflow-*-upgrade.sql for this exact " +
      "version jump: applying this file directly over an existing installation's OLD schema can " +
      "fail (e.g. beta.32→beta.42's primary-key rename raises \"multiple primary keys\"). Apply " +
      "that upgrade file, THEN this file, by hand, then update the ledger; see " +
      "pnpm -C services/chief-of-staff run regen:eve-sql:check",
  ],
]);

/** One line per file, plus a summary. Pure — takes a plan, returns text. */
export function renderPlan(plan: MigrationPlan, opts: { dir: string }): string {
  const lines: string[] = [`${opts.dir} — ${plan.steps.length} files`];

  for (const step of plan.steps) {
    const line = `${ACTION_LABEL[step.action]}${step.file.filename}`;
    lines.push(step.action === "skip" ? `${line}  (already applied)` : line);
  }

  const nApply = plan.steps.filter((step) => step.action === "apply").length;
  const nSkip = plan.steps.filter((step) => step.action === "skip").length;
  const nRefuse = plan.refusals.length;
  // The summary comes before any refusal detail, not after: a refusal is the thing a person needs
  // to act on, so it is the last thing read, not a count buried above it.
  lines.push(
    nApply === 0 && nRefuse === 0
      ? `nothing to apply — ${nSkip} already applied`
      : `${nApply} to apply, ${nSkip} already applied, ${nRefuse} refused`,
  );

  if (nRefuse > 0) {
    lines.push("", "REFUSED — nothing will be applied until these are resolved:");
    for (const refusal of plan.refusals) {
      lines.push(`  ${refusal.file.filename}: ${refusal.reason}`);
      for (const [pattern, remedy] of GENERATED_FILES) {
        if (pattern.test(refusal.file.filename)) lines.push(`    ${remedy}`);
      }
    }
  }

  return lines.join("\n");
}

/** 0 nothing to do · 1 there are refusals · 2 there is work to do. The installer branches on this. */
export function exitCodeFor(plan: MigrationPlan): 0 | 1 | 2 {
  if (plan.refusals.length > 0) return 1;
  if (plan.steps.some((step) => step.action === "apply")) return 2;
  return 0;
}

// ---------------------------------------------------------------------------------------------
// ADOPTION — the one-time act that lets the runner meet a database it did not build.
//
// WHAT IT DOES. Records every file up to and including `through` as applied, WITHOUT running any
// of them, with `how = 'adopted'` and the checksum of the file as it is on disk today — so W3D-s2's
// "changed since it was applied" rule still catches an edit made after the adoption.
//
// WHAT IT DOES NOT DO — the limit, stated where it cannot be missed: ADOPTION ASSERTS, IT DOES NOT
// VERIFY. The runner cannot check that 037_tyche.sql ever ran; it records the operator's word for
// it. Verifying would mean a hand-written "is this applied?" predicate per migration, 51 of them,
// each its own chance to be wrong. What adoption does guarantee, from that point on, is that
// nothing is silently re-run and nothing is silently edited.
//
// THE TWO WAYS THE OPERATOR CAN BE WRONG ABOUT `through`, and what happens in each:
//
//   TOO EARLY — a file that really was applied by hand is left unadopted, so the next run applies
//     it a second time. Whether that is harmless depends entirely on whether that one file is
//     re-runnable, and the runner cannot know. So it is DETECTABLE-BY-A-PERSON and treated that
//     way: adoption that leaves anything to run REFUSES unless `confirmWillRun` is set, and the
//     refusal lists by name exactly the files that will run. Read the list, then repeat with the
//     flag. `dryRun` shows the same list and writes nothing.
//
//   TOO LATE — a file that never ran is recorded as applied. This is NOT DETECTABLE, by this
//     runner or any other without the per-migration predicate above. Nothing will ever apply that
//     file; the cost appears later and far from here as a missing table or column. The report says
//     so in as many words, together with the remedy: delete that one row from schema_migrations
//     and apply the file by hand.
//
// `through` IS A FILENAME, never a number and never `--all`. A number is ambiguous against the two
// files numbered 019 in services/box/sql; `--all` would let someone adopt a tree they never looked
// at. ONCE PER DATABASE: a non-empty ledger refuses, whether the rows got there by applying or by
// a previous adoption.
//
// The installer (wave 8C) never adopts — it starts from an empty database and applies everything.
// ---------------------------------------------------------------------------------------------

export interface AdoptOptions {
  /** The exact filename of the LAST migration that was already applied by hand. */
  through: string;
  /** Required when adoption would leave files for the next run to apply. See the note above. */
  confirmWillRun?: boolean;
  /** Report what would be adopted and what would run next; write nothing, create nothing. */
  dryRun?: boolean;
}

export interface AdoptResult {
  /** Every file up to and including `through`, in order. */
  adopted: string[];
  /** What the next `runMigrations` will apply. Empty when adoption covers the whole directory. */
  willRunNext: string[];
  /** The text a person is meant to read, including the two limits above. */
  report: string;
}

function bullet(filenames: readonly string[]): string {
  return filenames.map((name) => `    ${name}`).join("\n");
}

/** The ledger's contents in one line, for the refusal. A live ledger holds ~51 rows; naming the
 *  first and the last says enough to recognise it without wrapping the sentence. */
function summarise(rows: readonly AppliedMigration[]): string {
  const names = rows.map((row) => row.filename);
  return names.length <= 3 ? names.join(", ") : `${names[0]} … ${names[names.length - 1]}`;
}

/**
 * Records files up to and including `through` as applied, WITHOUT running them.
 * Refuses when the ledger is not empty — adoption is a once-per-database act.
 *
 * Read the block above this function before changing anything here.
 */
export async function adoptMigrations(
  db: Queryable,
  dir: string,
  opts: AdoptOptions,
): Promise<AdoptResult> {
  const dryRun = opts.dryRun ?? false;
  const files = readMigrations(dir);

  const cut = files.findIndex((file) => file.filename === opts.through);
  if (cut < 0) {
    throw new Error(
      `adopt: ${opts.through} is not in ${dir}. --adopt-through takes the exact filename of the ` +
        "last migration that was already applied by hand — never a number (two files are numbered 019) " +
        "and never every file at once.",
    );
  }

  // A missing ledger table IS the expected state here: the database adoption exists for predates
  // the ledger. Treat it as empty, and (on a real adoption, never a dry run) create it below.
  const existing = await listApplied(db).catch((err: unknown) => {
    if (isMissingLedgerTable(err)) return [] as AppliedMigration[];
    throw err;
  });
  if (existing.length > 0) {
    throw new Error(
      `This database's migration ledger already holds ${existing.length} ` +
        `${existing.length === 1 ? "row" : "rows"} (${summarise(existing)}) — adoption is a one-time ` +
        "act, for a database migrated before the runner existed. Nothing was adopted.",
    );
  }

  const adopting = files.slice(0, cut + 1);
  const rows: AppliedMigration[] = adopting.map((file) => ({
    filename: file.filename,
    number: file.number,
    checksum: file.checksum,
    appliedAt: new Date(),
    how: "adopted",
    tookMs: 0,
  }));
  // Not "everything after the cut": ask the planner, so the answer obeys the same ordering and
  // checksum rules a real run will obey rather than a second, hand-rolled copy of them.
  const willRunNext = planMigrations(files, rows)
    .steps.filter((step) => step.action === "apply")
    .map((step) => step.file.filename);

  if (willRunNext.length > 0 && !dryRun && !opts.confirmWillRun) {
    throw new Error(
      [
        `Adopting through ${opts.through} would record ${adopting.length} ` +
          `${adopting.length === 1 ? "file" : "files"} as already applied and leave ` +
          `${willRunNext.length} to be applied by the next run:`,
        "",
        bullet(willRunNext),
        "",
        "Those files WILL RUN. If any of them was in fact already applied by hand, it will run a",
        "second time, and the runner cannot tell whether that is safe — only the file itself can.",
        "Check the list; if it is right, repeat the command with --confirm-will-run.",
        "",
        "Nothing was adopted.",
      ].join("\n"),
    );
  }

  const report = [
    `${dryRun ? "Would adopt" : "Adopted"} ${adopting.length} ` +
      `${adopting.length === 1 ? "file" : "files"} as already applied, through ${opts.through}:`,
    "",
    bullet(adopting.map((file) => file.filename)),
    "",
    "ADOPTION ASSERTS; IT DOES NOT VERIFY. The runner did not run these files and cannot check that",
    "they ever ran — it recorded your word for it. If one of them had NOT in fact been applied,",
    "nothing will ever apply it now, and the cost appears later and far from here as a missing",
    "table or column. The remedy then is to delete that row from schema_migrations and apply that",
    "one file by hand.",
    "",
    willRunNext.length === 0
      ? "Every file in the directory is adopted, so nothing is left to apply."
      : `${willRunNext.length} ${willRunNext.length === 1 ? "file" : "files"} will be applied by the next run:\n\n${bullet(willRunNext)}`,
  ].join("\n");

  if (dryRun) return { adopted: adopting.map((file) => file.filename), willRunNext, report };

  await ensureLedger(db);
  // One INSERT, so the whole adoption lands or none of it does even though `db` may be a pool and
  // hand out a different connection per query. `filename` is the primary key, so a second,
  // concurrent adoption collides here rather than merging into this one.
  const values = rows
    .map((row) => `(${literal(row.filename)}, ${row.number}, ${literal(row.checksum)}, 'adopted', 0)`)
    .join(",\n  ");
  await db.query(
    `INSERT INTO schema_migrations (filename, number, checksum, how, took_ms) VALUES\n  ${values}`,
  );

  return { adopted: adopting.map((file) => file.filename), willRunNext, report };
}
