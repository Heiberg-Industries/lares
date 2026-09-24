// services/box/bin/export-person.ts — the read-only twin of bin/erase-person.ts.
//
// THERE IS NO `--apply`. An export changes nothing: it reads the database, reads the vaults, and
// writes files into a directory of its own. So unlike the erase next to it, this command always
// runs for real — a "practice export" would be a report about files nobody can read, which is
// less useful than the files themselves.
//
// Run with:
//   pnpm -C services/box run export-person -- <who> --out /var/tmp/their-export
//   pnpm -C services/box run export-person -- <who> --out <dir> --vault /srv/brain --vault /srv/atlas
//
// <who> is whatever you have: the person's id in the register, an old chat handle, an email
// address. Anybody the register does not hold is refused — this exports what an installation
// holds about its MEMBERS, never about a third party somebody's notes happen to mention.
//
// WHY THIS TALKS IN FULL SENTENCES, like erase-person.ts and migrate.ts next to it: whoever reads
// this output is handing somebody a copy of everything about them, and is not necessarily a
// developer. `main` never throws.

import { poolFromEnv } from "../lib/db.js";
import { exportPerson, renderExportReport } from "../lib/export-person.js";
import type { Pool } from "pg";

export interface ParsedExportArgs {
  person?: string;
  outDir?: string;
  help: boolean;
  vaults: string[];
}

const HELP_TEXT = [
  "pnpm -C services/box run export-person -- <who> --out <dir> [--vault <path> ...] [--help]",
  "",
  "Writes out everything this installation holds about one of its members: one file per place in",
  "the database, plus their notes from every vault given, plus a manifest. Saved sign-ins are",
  "never written — they are secrets, and the report says where one was held back.",
  "",
  "  <who>          The person: their id in the register, an old chat handle, or an email address.",
  "  --out <dir>    Where to write the export. Created for you, readable only by you, and it must",
  "                 not already have anything in it.",
  "  --vault <path> A vault to also read, on this filesystem. Repeatable. Without at least one, no",
  "                 notes are read at all, and the report says so.",
  "  --help         Show this message.",
  "",
  "Exit codes:",
  "  0   written.",
  "  1   refused. Nothing was written. The message above says what to fix.",
].join("\n");

/** Refuses an unknown flag rather than ignoring it, the same rule erase-person.ts follows: a
 *  misread flag here is an export written somewhere nobody meant it to go. */
export function parseArgs(argv: readonly string[]): ParsedExportArgs {
  let person: string | undefined;
  let outDir: string | undefined;
  let help = false;
  const vaults: string[] = [];

  const valueAfter = (argv_: readonly string[], i: number, flag: string, example: string): string => {
    const value = argv_[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`export-person: ${flag} needs a path, e.g. ${flag} ${example}`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    // `pnpm run <script> -- <args>` hands the bare separator through; it carries no meaning.
    if (arg === "--") continue;
    if (arg === "--help") help = true;
    else if (arg === "--out") {
      outDir = valueAfter(argv, i, "--out", "/var/tmp/their-export");
      i += 1;
    } else if (arg === "--vault") {
      vaults.push(valueAfter(argv, i, "--vault", "/srv/brain"));
      i += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(
        `export-person: unknown flag "${arg}". Known flags: --out · --vault · --help`,
      );
    } else if (person === undefined) person = arg;
    else {
      throw new Error(
        `export-person: this command exports one person at a time, and "${person}" was already ` +
          `given. Run it again for "${arg}" separately.`,
      );
    }
  }

  return {
    ...(person !== undefined ? { person } : {}),
    ...(outDir !== undefined ? { outDir } : {}),
    help,
    vaults,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Exported so a test can drive it without spawning a process — erase-person.ts's shape. */
export async function main(
  argv: readonly string[],
  deps: { db: Pool; out: (s: string) => void },
): Promise<number> {
  let args: ParsedExportArgs;
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
  if (!args.person) {
    deps.out("export-person: say who. \n\n" + HELP_TEXT);
    return 1;
  }
  if (!args.outDir) {
    deps.out("export-person: say where to write it, with --out <dir>. \n\n" + HELP_TEXT);
    return 1;
  }

  let report;
  try {
    report = await exportPerson(deps.db, {
      person: args.person,
      outDir: args.outDir,
      vaults: args.vaults,
    });
  } catch (err) {
    deps.out(
      "This export stopped, because the database could not be reached or answered " +
        `unexpectedly: ${messageOf(err)}`,
    );
    return 1;
  }

  deps.out(renderExportReport(report));
  return report.refusals.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const db = poolFromEnv();
  main(process.argv.slice(2), { db, out: (s) => process.stdout.write(s + "\n") })
    .then(async (code) => {
      await db.end();
      process.exit(code);
    })
    .catch(async (err) => {
      process.stdout.write(messageOf(err) + "\n");
      await db.end().catch(() => undefined);
      process.exit(1);
    });
}
