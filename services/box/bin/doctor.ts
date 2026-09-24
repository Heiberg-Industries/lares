// services/box/bin/doctor.ts — `lares doctor`: what is wrong with this installation, and what to
// type, in one page. Follows migrate.ts's shape next to it: `main` never throws, exit code is the
// only signal an installer needs, and the argument parser lives here while every check lives in
// `../lib/doctor.ts` so it can be driven from a test with no process and no real database.
//
// READ-ONLY, except for the one call `--test-model` asks for. This file changes no setting, no
// file, no database row, and restarts nothing. It also makes NO network call by default —
// `--test-model` (W8A-s7, owner decision A2: only when you ask) is the one flag that does, and it
// spends this installation's own money on this installation's own gateway to do it. It requires
// `--gateway <url>`, `--alias <name>` and `--key-file <path>` all three, exactly the shape
// W8C-s5's installer wizard calls it with (`lares-doctor --test-model --gateway "$GATEWAY_URL"
// --alias "$LARES_MODEL_ALIAS" --key-file "$SECRETS/model-provider-key"`) — this file bakes in no
// default hostname, alias or key path of its own; every one of the three is the caller's own
// value, read from THIS installation's settings, never this repository's.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { poolFromEnv } from "../lib/db.js";
import { runDoctor, doctorReport, doctorExitCode, type ModelTestDeps } from "../lib/doctor.js";

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "sql");

const HELP_TEXT = [
  "pnpm -C services/box doctor [--help] [--test-model --gateway <url> --alias <name> --key-file <path>]",
  "",
  "Reads this installation's settings and database and says, in plain sentences, what is wrong",
  "and what to type to fix it. It changes nothing: no setting, no file and no database row.",
  "",
  "  --help                Show this message.",
  "  --test-model          Ask the model gateway for one real, tiny completion (a paid call —",
  "                        a fraction of a cent). Makes no call unless you pass this flag.",
  "                        Requires all three of the following:",
  "  --gateway <url>       The gateway's own URL (this installation's GATEWAY_URL).",
  "  --alias <name>        The model alias to test.",
  "  --key-file <path>     Path to the gateway key file (this installation's GATEWAY_KEY_FILE).",
  "                        Read once; its contents are never printed, logged or repeated back.",
  "",
  "Exit codes:",
  "  0   nothing failed (a WARN alone still exits 0).",
  "  1   at least one check failed, or --test-model was asked for without all three of its flags.",
].join("\n");

export interface ParsedDoctorArgs {
  help: boolean;
  testModel: boolean;
  gatewayUrl: string | undefined;
  alias: string | undefined;
  keyFile: string | undefined;
}

const VALUE_FLAGS = new Set(["--gateway", "--alias", "--key-file"]);

/** Refuses an unknown flag rather than silently ignoring it. `--gateway`/`--alias`/`--key-file`
 *  each consume the argument that follows them. */
export function parseArgs(argv: readonly string[]): ParsedDoctorArgs {
  let help = false;
  let testModel = false;
  let gatewayUrl: string | undefined;
  let alias: string | undefined;
  let keyFile: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // `pnpm run <script> -- <args>` hands the bare separator through; it carries no meaning.
    if (arg === "--") continue;
    else if (arg === "--help") help = true;
    else if (arg === "--test-model") testModel = true;
    else if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`doctor: ${arg} needs a value.`);
      if (arg === "--gateway") gatewayUrl = value;
      else if (arg === "--alias") alias = value;
      else keyFile = value;
      i++;
    } else {
      throw new Error(
        `doctor: unknown flag "${arg}". Known flags: --test-model · --gateway · --alias · --key-file · --help`,
      );
    }
  }

  return { help, testModel, gatewayUrl, alias, keyFile };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Exported so a test can drive it without spawning a process — migrate.ts's shape. `readKeyFile`
 *  and `fetch` are injectable for the same reason: a test proves this file wires `--test-model`
 *  correctly without ever making a real network call or reading a real file. */
export async function main(
  argv: readonly string[],
  deps: {
    db: Pool;
    out: (s: string) => void;
    readKeyFile?: (path: string) => string;
    fetch?: typeof globalThis.fetch;
  },
): Promise<number> {
  let args: ParsedDoctorArgs;
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

  let testModel: ModelTestDeps | undefined;
  if (args.testModel) {
    if (!args.gatewayUrl || !args.alias || !args.keyFile) {
      deps.out("doctor: --test-model requires --gateway <url>, --alias <name> and --key-file <path>, all three.");
      return 1;
    }
    const readKeyFile = deps.readKeyFile ?? ((path: string) => readFileSync(path, "utf8").trim());
    let key: string;
    try {
      key = readKeyFile(args.keyFile);
    } catch {
      // The path is not a secret — the file's contents are, and are never read into this line.
      deps.out(`doctor: the key file at "${args.keyFile}" could not be read.`);
      return 1;
    }
    testModel = { gatewayUrl: args.gatewayUrl, key, alias: args.alias, fetch: deps.fetch };
  }

  const results = await runDoctor({
    db: deps.db,
    env: process.env,
    sqlDir: SQL_DIR,
    now: new Date(),
    testModel,
  });
  deps.out(doctorReport(results));
  return doctorExitCode(results);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = poolFromEnv();
  main(process.argv.slice(2), { db: pool, out: (s) => process.stdout.write(`${s}\n`) })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stdout.write(`${messageOf(err)}\n`);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
