// services/box/bin/first-owner.ts — W8C-s7: the owner becomes a real member, with a real id.
//
// THE MOST DANGEROUS COMMAND IN THE INSTALLER (see ../lib/first-owner.ts's own header). Mirrors
// bin/erase-person.ts's shape: a PRACTICE RUN IS THE DEFAULT — with no `--apply`, this only reads
// the register and says what a real run would do, and changes nothing. `--apply` is the only
// thing that writes, and it writes through `createFirstOwner` alone — this file never issues a
// query of its own beyond the read-only preview.
//
// WHO THE OWNER IS comes from three environment variables — `LARES_OWNER_ID`,
// `LARES_OWNER_EMAIL`, `LARES_OWNER_NAME` — never a command-line flag: `ops/install.sh` is the
// only caller today, and it already has all three (the id it computed and printed itself, and the
// e-mail/name it read back out of `installation.env` with `read_setting`), so passing them as
// argv would only put an address and a name into this process's argument list and this shell's
// history for no reason. All three must be set and non-blank, or this refuses outright.
//
// `main` never throws — migrate.ts's and doctor.ts's shape, next to it.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Pool } from "pg";
import { poolFromEnv } from "../lib/db.js";
import {
  createFirstOwner,
  decideFirstOwner,
  readEngineSeed,
  type EngineSeed,
} from "../lib/first-owner.js";

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "sql");

const HELP_TEXT = [
  "pnpm -C services/box first-owner [--apply] [--help]",
  "",
  "Creates this installation's real owner in the identity register, taking the engine's own",
  "seed row with it when that is safe. Reads who the owner is from three environment",
  "variables — LARES_OWNER_ID, LARES_OWNER_EMAIL, LARES_OWNER_NAME — never a flag.",
  "",
  "  --apply    Actually do it. Without this flag nothing is changed and you get a practice run.",
  "  --help     Show this message.",
  "",
  "Exit codes:",
  "  0   done (or, without --apply, a practice run that found nothing in the way).",
  "  1   refused. Nothing was changed. The message above says what to fix.",
].join("\n");

export interface ParsedFirstOwnerArgs {
  apply: boolean;
  help: boolean;
}

/** Refuses an unknown flag rather than ignoring it — the same reasoning bin/erase-person.ts's
 *  own parser gives: on this command a misread flag could be the difference between a practice
 *  run and a real one. */
export function parseArgs(argv: readonly string[]): ParsedFirstOwnerArgs {
  let apply = false;
  let help = false;
  for (const arg of argv) {
    // `pnpm run <script> -- <args>` hands the bare separator through; it carries no meaning.
    if (arg === "--") continue;
    else if (arg === "--apply") apply = true;
    else if (arg === "--help") help = true;
    else throw new Error(`first-owner: unknown flag "${arg}". Known flags: --apply · --help`);
  }
  return { apply, help };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isBlank(v: string | undefined): boolean {
  return v === undefined || v.trim() === "";
}

/** Doubles a value into the same undo shape `../lib/first-owner.ts`'s `createFirstOwner` writes,
 *  so a mistaken `--apply` run is reversible by pasting exactly this back — the plan's own
 *  requirement. Never runs on a practice run, since nothing has been removed yet to undo. */
function undoScriptFor(seed: EngineSeed): string {
  const literal = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const lines = [
    "BEGIN;",
    `INSERT INTO users (id, display_name, primary_email) VALUES (${literal(seed.id)}, ` +
      `${literal(seed.displayName)}, ${literal(seed.email)});`,
  ];
  if (seed.aliases.length > 0) {
    const values = seed.aliases
      .map((a) => `  (${literal(a.system)}, ${literal(a.alias)}, ${literal(seed.id)})`)
      .join(",\n");
    lines.push(
      "INSERT INTO user_aliases (system, alias, user_id) VALUES",
      `${values}`,
      "ON CONFLICT (system, alias) DO NOTHING;",
    );
  }
  lines.push(
    `INSERT INTO org_member_policy (user_id) VALUES (${literal(seed.id)}) ON CONFLICT (user_id) DO NOTHING;`,
    "COMMIT;",
  );
  return lines.join("\n");
}

/** Exported so a test can drive it without spawning a process — migrate.ts's and doctor.ts's
 *  shape. */
export async function main(
  argv: readonly string[],
  deps: { db: Pool; env: NodeJS.ProcessEnv; out: (s: string) => void },
): Promise<number> {
  let args: ParsedFirstOwnerArgs;
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

  const id = deps.env.LARES_OWNER_ID;
  const email = deps.env.LARES_OWNER_EMAIL;
  const displayName = deps.env.LARES_OWNER_NAME;
  if (isBlank(id) || isBlank(email) || isBlank(displayName)) {
    deps.out(
      "first-owner: LARES_OWNER_ID, LARES_OWNER_EMAIL and LARES_OWNER_NAME must all be set, and " +
        "none of them blank. Nothing was read from the database and nothing was changed.\n\n" +
        HELP_TEXT,
    );
    return 1;
  }

  if (!args.apply) {
    // THE SAME DECISION THE REAL RUN MAKES, not a second reading of the same tables: a preview
    // that reasons for itself is a preview that can promise something `--apply` then does not do.
    let decision;
    try {
      decision = await decideFirstOwner(deps.db, {
        id: id!.trim(),
        displayName: displayName!,
        email: email!,
      });
    } catch (err) {
      deps.out(
        `This is a practice run. Nothing was changed. The identity register could not even be ` +
          `read: ${messageOf(err)}`,
      );
      return 1;
    }
    if (decision.kind === "already") {
      deps.out(
        `This is a practice run. Nothing was changed: "${decision.id}" is already the owner.`,
      );
      return 0;
    }
    if (decision.kind === "refused") {
      deps.out(
        `This is a practice run. Nothing was changed. A real run (--apply) would REFUSE:\n\n` +
          decision.why,
      );
      return 0;
    }
    deps.out(
      `This is a practice run. Nothing was changed. A real run (--apply) would create ` +
        `"${decision.id}" as this installation's owner` +
        (decision.removeSeedId === null
          ? ` — the identity register is empty.`
          : `, and take the engine's own seed row ("${decision.removeSeedId}") away with it.`),
    );
    return 0;
  }

  const seedBefore = readEngineSeed(SQL_DIR);
  let outcome;
  try {
    outcome = await createFirstOwner(deps.db, {
      id: id!.trim(),
      displayName: displayName!,
      email: email!,
    });
  } catch (err) {
    deps.out(
      `This stopped before anything was changed, because the database could not be reached or ` +
        `answered unexpectedly: ${messageOf(err)}`,
    );
    return 1;
  }

  if (outcome.kind === "refused") {
    deps.out(`Refused. Nothing was changed.\n\n${outcome.why}`);
    return 1;
  }
  if (outcome.kind === "already") {
    deps.out(`Nothing was needed: "${outcome.id}" is already this installation's owner.`);
    return 0;
  }

  deps.out(`Done. "${outcome.id}" is now this installation's owner.`);
  if (outcome.removedEngineSeed && seedBefore) {
    deps.out(
      "\nThe engine's own seed row went with it. If this was a mistake, paste this to put it " +
        "back exactly as it was:\n\n" +
        undoScriptFor(seedBefore),
    );
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = poolFromEnv();
  main(process.argv.slice(2), { db: pool, env: process.env, out: (s) => process.stdout.write(`${s}\n`) })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stdout.write(`${messageOf(err)}\n`);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
