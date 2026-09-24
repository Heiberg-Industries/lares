// The migration runner's CLI (ADR-0021 rule 3). The Compose stack normally applies
// sql/001_init.sql automatically on the database's first init (docker-entrypoint-initdb.d).
// This script is the manual path: an already-initialised database, CI, or — from the first
// public release — every update after the first. The actual rules (order, checksum, adoption)
// live in lib/migration-runner.ts; this file is only argument parsing and exit codes.
//
// Run with: pnpm -C services/box migrate [flags]   (PG* env + DATABASE_PASSWORD_FILE, default
// /run/secrets/database-password; falls back to /run/secrets/db_password for one older
// installation — see lib/db.ts)
//
// WHY THIS TALKS IN FULL SENTENCES. Whoever reads this output is often reading it at the exact
// moment something about the database is wrong, and is not necessarily a developer. So: a refusal
// says what happened and the exact next command to type, never a bare stack trace. `main` never
// throws — see its own comment.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { poolFromEnv, type Queryable } from "./lib/db.js";
import { ensureLedger, listApplied } from "./lib/migration-ledger.js";
import {
  adoptMigrations,
  exitCodeFor,
  looksAlreadyMigrated,
  planMigrations,
  readMigrations,
  renderPlan,
  runMigrations,
  UNADOPTED_DATABASE,
} from "./lib/migration-runner.js";

const here = dirname(fileURLToPath(import.meta.url));
const sqlDir = join(here, "sql");

export interface ParsedMigrateArgs {
  /** Look here instead of the box's own sql directory. */
  dir?: string;
  /** Show what would happen. Never writes to the database. */
  dryRun: boolean;
  /** One-time: record every file up to and including this one as already applied by hand. */
  adoptThrough?: string;
  /** Required alongside --adopt-through when adoption would leave files for the next run to apply. */
  confirmWillRun?: boolean;
  help: boolean;
}

const KNOWN_FLAGS = "--dir <path> · --dry-run · --adopt-through <filename> · --confirm-will-run · --help";

const HELP_TEXT = [
  "pnpm -C services/box migrate [--dir <path>] [--dry-run] [--adopt-through <filename> [--confirm-will-run]] [--help]",
  "",
  "  --dir <path>             Look for migration files here instead of services/box/sql.",
  "  --dry-run                Show what would happen. Changes nothing in the database.",
  "  --adopt-through <file>   One-time: record every file up to and including <file> as already",
  "                           applied, without running them — for a database that had migrations",
  "                           applied by hand before this tool existed.",
  "  --confirm-will-run       Required with --adopt-through when some files would still run after",
  "                           adoption. Read that list first, then add this flag.",
  "  --help                   Show this message.",
  "",
  "Exit codes:",
  "  0   nothing left to do — everything is already applied (or was just applied successfully).",
  "  1   refused. Nothing was applied. The message above says what to fix and what to run next.",
  "  2   dry run only — there is work to do. Nothing was applied; run again without --dry-run.",
].join("\n");

/**
 * Parses argv into flags. Refuses an unknown flag rather than silently ignoring it — a typo in a
 * flag name must never be read as "no flags", which on this command means "apply everything".
 */
export function parseArgs(argv: readonly string[]): ParsedMigrateArgs {
  let dir: string | undefined;
  let dryRun = false;
  let adoptThrough: string | undefined;
  let confirmWillRun: boolean | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--dry-run":
        dryRun = true;
        break;
      case "--confirm-will-run":
        confirmWillRun = true;
        break;
      case "--help":
        help = true;
        break;
      case "--dir": {
        const value = argv[++i];
        if (value === undefined) throw new Error("migrate: --dir needs a directory");
        dir = value;
        break;
      }
      case "--adopt-through": {
        const value = argv[++i];
        if (value === undefined) throw new Error("migrate: --adopt-through needs a filename");
        adoptThrough = value;
        break;
      }
      default:
        throw new Error(`migrate: unknown flag "${arg}". Known flags: ${KNOWN_FLAGS}`);
    }
  }

  return {
    ...(dir !== undefined ? { dir } : {}),
    dryRun,
    ...(adoptThrough !== undefined ? { adoptThrough } : {}),
    ...(confirmWillRun !== undefined ? { confirmWillRun } : {}),
    help,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs the CLI. Exported so a test drives it directly, without spawning a process — the same
 * shape services/atlas/lib/cli.ts uses.
 *
 * NEVER THROWS. Every error — a bad flag, an unadopted database, a migration that fails mid-apply
 * — is caught, written through `deps.out` as the sentence a person needs to read, and turned into
 * exit code 1. A CLI that throws prints a stack trace at the exact moment the reader most needs a
 * plain sentence, and the installer (wave 8C) branches on the exit code, not on an exception.
 */
export async function main(
  argv: readonly string[],
  deps: { db: Queryable; out: (s: string) => void },
): Promise<number> {
  let args: ParsedMigrateArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    deps.out(messageOf(err));
    return 1;
  }

  if (args.help) {
    deps.out(HELP_TEXT);
    return 0;
  }

  const dir = args.dir ?? sqlDir;

  try {
    await ensureLedger(deps.db);

    if (args.adoptThrough !== undefined) {
      const result = await adoptMigrations(deps.db, dir, {
        through: args.adoptThrough,
        dryRun: args.dryRun,
        ...(args.confirmWillRun !== undefined ? { confirmWillRun: args.confirmWillRun } : {}),
      });
      deps.out(result.report);
      return args.dryRun ? 2 : 0;
    }

    const files = readMigrations(dir);
    const appliedRows = await listApplied(deps.db);
    const plan = planMigrations(files, appliedRows);
    const rendered = renderPlan(plan, { dir });
    // The same "database with a schema but an empty ledger" case runMigrations refuses — checked
    // here too so a DRY RUN also mentions it. Without this, a dry run against the live
    // installation would print "51 to apply" and never say that the real run will refuse.
    const unadopted = appliedRows.length === 0 && (await looksAlreadyMigrated(deps.db));

    if (args.dryRun) {
      deps.out(unadopted ? `${rendered}\n\n${UNADOPTED_DATABASE}` : rendered);
      return plan.refusals.length > 0 || unadopted ? 1 : exitCodeFor(plan);
    }

    if (unadopted) {
      deps.out(UNADOPTED_DATABASE);
      return 1;
    }
    if (plan.refusals.length > 0) {
      deps.out(rendered);
      return 1;
    }

    // Nothing left unresolved, so what runMigrations actually applies matches `plan` exactly
    // (same files, same ledger) — the rendering already computed is an accurate report of it.
    await runMigrations(deps.db, dir);
    deps.out(rendered);
    return 0;
  } catch (err) {
    deps.out(messageOf(err));
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = poolFromEnv();
  main(process.argv.slice(2), { db: pool, out: (s) => process.stdout.write(`${s}\n`) })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
