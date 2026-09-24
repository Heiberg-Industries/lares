// services/box/bin/erase-person.ts — the ONLY way to run an erase (owner ruling D7).
//
// NEVER A TOOL, NEVER A SCHEDULE, NEVER A BUTTON IN THE CONSOLE. Erasing a person is not
// something an agent should be able to decide to do, or be talked into doing, and it is not
// something a nightly job should ever do unattended. It is a command somebody types, at a
// terminal, on the server they own.
//
// DRY RUN IS THE DEFAULT. Run with no flags and nothing is changed: the report says what a real
// run would remove and what it would not reach. `--apply` is the only thing that writes.
//
// Run with:
//   pnpm -C services/box erase-person -- <who>                                # practice run
//   pnpm -C services/box erase-person -- <who> --vault /srv/brain --apply     # does it
//
// <who> is whatever you have: the person's id in the register, an old chat handle, an email
// address. Anybody the register does not hold is refused — this erases MEMBERS of this
// installation, never a third party somebody's notes happen to mention.
//
// `--vault <path>` (repeatable) is this installation's vault(s) — a note store on the same
// filesystem, checked out as a git working tree. Without at least one, this command only ever
// touches the database; the report says so plainly rather than pretending nothing was left in a
// vault to check. All of the actual ordering (resolve the person once; a database dry run first;
// then the vault; then the real database erase, with the exact paths the vault pass removed) is
// `../lib/run-erase.ts`'s job — this file only reads argv and prints what comes back.
//
// WHY THIS TALKS IN FULL SENTENCES, like migrate.ts next to it: whoever reads this output is
// doing something irreversible, and is not necessarily a developer. `main` never throws.

import { poolFromEnv } from "../lib/db.js";
import { runErase, renderRunEraseReport } from "../lib/run-erase.js";
import type { Pool } from "pg";

export interface ParsedEraseArgs {
  person?: string;
  apply: boolean;
  help: boolean;
  vaults: string[];
}

const HELP_TEXT = [
  "pnpm -C services/box erase-person -- <who> [--vault <path> ...] [--apply] [--help]",
  "",
  "Removes one member of this installation from every table in this database that names them,",
  "and — for every --vault given — from that vault's notes too. It happens all at once or not at",
  "all: if any part of it cannot run, nothing is changed.",
  "",
  "  <who>          The person: their id in the register, an old chat handle, or an email address.",
  "  --vault <path> A vault to also check, on this filesystem. Repeatable. Without at least one,",
  "                 no vault is looked at at all, and the report says so.",
  "  --apply        Actually do it. Without this flag nothing is changed and you get a practice run.",
  "  --help         Show this message.",
  "",
  "Exit codes:",
  "  0   done (or, without --apply, a practice run that found nothing in the way).",
  "  1   refused, or stopped partway. Nothing further was changed. The message above says what to fix.",
].join("\n");

/** Refuses an unknown flag rather than ignoring it: on this command a misread flag could be the
 *  difference between a practice run and an irreversible one. */
export function parseArgs(argv: readonly string[]): ParsedEraseArgs {
  let person: string | undefined;
  let apply = false;
  let help = false;
  const vaults: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    // `pnpm run <script> -- <args>` hands the bare separator through; it carries no meaning.
    if (arg === "--") continue;
    if (arg === "--apply") apply = true;
    else if (arg === "--help") help = true;
    else if (arg === "--vault") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("erase-person: --vault needs a path, e.g. --vault /srv/brain");
      }
      vaults.push(value);
      i += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(
        `erase-person: unknown flag "${arg}". Known flags: --vault · --apply · --help`,
      );
    } else if (person === undefined) person = arg;
    else {
      throw new Error(
        `erase-person: this command erases one person at a time, and "${person}" was already ` +
          `given. Run it again for "${arg}" separately.`,
      );
    }
  }

  return { ...(person !== undefined ? { person } : {}), apply, help, vaults };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Exported so a test can drive it without spawning a process — migrate.ts's shape. */
export async function main(
  argv: readonly string[],
  deps: { db: Pool; out: (s: string) => void },
): Promise<number> {
  let args: ParsedEraseArgs;
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
    deps.out("erase-person: say who. \n\n" + HELP_TEXT);
    return 1;
  }

  let result;
  try {
    result = await runErase({ db: deps.db, person: args.person, vaults: args.vaults, apply: args.apply });
  } catch (err) {
    deps.out(
      "This erase stopped before anything was changed, because the database could not be " +
        `reached or answered unexpectedly: ${messageOf(err)}`,
    );
    return 1;
  }

  deps.out(renderRunEraseReport(result));
  return result.dbReport.refusals.length > 0 || result.vaultError !== undefined ? 1 : 0;
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
