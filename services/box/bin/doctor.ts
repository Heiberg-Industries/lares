// services/box/bin/doctor.ts — `lares doctor`: what is wrong with this installation, and what to
// type, in one page. Follows migrate.ts's shape next to it: `main` never throws, exit code is the
// only signal an installer needs, and the argument parser lives here while every check lives in
// `../lib/doctor.ts` so it can be driven from a test with no process and no real database.
//
// READ-ONLY, except for the one call `--test-model` asks for. This file changes no setting, no
// file, no database row, and restarts nothing. It also makes NO network call by default —
// `--test-model` (only when you ask) is the one flag that does. Two shapes:
//   - with `--gateway <url>`, `--alias <name>` and `--key-file <path>` (all three), it spends one
//     tiny completion on that gateway. This file bakes in no default hostname, alias or key path;
//     each is the caller's own value.
//   - with none of the three, on an installation with the built-in gateway (`lares doctor` passes
//     `--gateway-profile-file` and `--provider-key-file`), it asks the model provider for its free
//     model list with the installation's provider key. The built-in gateway takes only calls the
//     spending limits have approved, and this command cannot ask for that approval.
// Nothing in the installer calls `--test-model`.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { operatorPoolFromFile, poolFromEnv } from "../lib/db.js";
import { parseReleaseManifest } from "../lib/release-manifest.js";
import { parseProvenanceRecord, type ContainerRow, type ParityInput } from "../lib/doctor-parity.js";
import { runDoctor, doctorReport, doctorExitCode, testModel as probeModel, type ModelTestDeps, type ProviderKeyTestDeps } from "../lib/doctor.js";

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "sql");

const HELP_TEXT = [
  "lares doctor [--help] [--test-model [--gateway <url> --alias <name> --key-file <path>]]",
  "",
  "Reads this installation's settings and database and says, in plain sentences, what is wrong",
  "and what to type to fix it. It changes nothing: no setting, no file and no database row.",
  "",
  "  --help                Show this message.",
  "  --test-model          Test the model connection. Makes no outside call unless you pass it.",
  "                        On an installation with the built-in gateway, and with none of the",
  "                        three flags below, it asks your model provider whether it accepts this",
  "                        installation's provider key (a free call that does no model work).",
  "                        With all three flags below, it asks that gateway for one real, tiny",
  "                        completion instead (a paid call, a fraction of a cent).",
  "  --model-only          Check only that completion, before migrations. Needs the three flags.",
  "  --gateway <url>       A gateway's own URL.",
  "  --alias <name>        The model alias to test.",
  "  --key-file <path>     Path to that gateway's key file.",
  "                        Read once; its contents are never printed, logged or repeated back.",
  "",
  "Exit codes:",
  "  0   nothing failed (a WARN alone still exits 0).",
  "  1   at least one check failed, or --test-model could not run as asked.",
].join("\n");

export interface ParsedDoctorArgs {
  help: boolean;
  testModel: boolean;
  modelOnly: boolean;
  installedSettingsFile: string | undefined;
  ledgerPasswordFile: string | undefined;
  gatewayUrl: string | undefined;
  alias: string | undefined;
  keyFile: string | undefined;
  gatewayProfileFile: string | undefined;
  providerKeyFile: string | undefined;
  releaseFile: string | undefined;
  containersFile: string | undefined;
  keeperConfigFile: string | undefined;
  keeperRenderedFile: string | undefined;
  outsideRoute: "ready" | "not-ready" | undefined;
  laresProjects: string[];
}

const VALUE_FLAGS = new Set([
  "--gateway", "--alias", "--key-file", "--installed-settings-file", "--ledger-password-file",
  "--release-file", "--containers-file", "--keeper-config-file", "--keeper-rendered-file", "--outside-route", "--lares-project",
  "--gateway-profile-file", "--provider-key-file",
]);

/** Refuses an unknown flag rather than silently ignoring it. `--gateway`/`--alias`/`--key-file`
 *  each consume the argument that follows them. */
export function parseArgs(argv: readonly string[]): ParsedDoctorArgs {
  let help = false;
  let testModel = false;
  let modelOnly = false;
  let installedSettingsFile: string | undefined;
  let ledgerPasswordFile: string | undefined;
  let gatewayUrl: string | undefined;
  let alias: string | undefined;
  let keyFile: string | undefined;
  let gatewayProfileFile: string | undefined;
  let providerKeyFile: string | undefined;
  let releaseFile: string | undefined;
  let containersFile: string | undefined;
  let keeperConfigFile: string | undefined;
  let keeperRenderedFile: string | undefined;
  let outsideRoute: "ready" | "not-ready" | undefined;
  const laresProjects: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // `pnpm run <script> -- <args>` hands the bare separator through; it carries no meaning.
    if (arg === "--") continue;
    else if (arg === "--help") help = true;
    else if (arg === "--test-model") testModel = true;
    else if (arg === "--model-only") modelOnly = true;
    else if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`doctor: ${arg} needs a value.`);
      if (arg === "--gateway") gatewayUrl = value;
      else if (arg === "--alias") alias = value;
      else if (arg === "--key-file") keyFile = value;
      else if (arg === "--ledger-password-file") ledgerPasswordFile = value;
      else if (arg === "--release-file") releaseFile = value;
      else if (arg === "--containers-file") containersFile = value;
      else if (arg === "--keeper-config-file") keeperConfigFile = value;
      else if (arg === "--keeper-rendered-file") keeperRenderedFile = value;
      else if (arg === "--outside-route") {
        if (value !== "ready" && value !== "not-ready") throw new Error('doctor: --outside-route must be "ready" or "not-ready".');
        outsideRoute = value;
      }
      else if (arg === "--lares-project") laresProjects.push(value);
      else if (arg === "--gateway-profile-file") gatewayProfileFile = value;
      else if (arg === "--provider-key-file") providerKeyFile = value;
      else installedSettingsFile = value;
      i++;
    } else {
      throw new Error(
        `doctor: unknown flag "${arg}". Known flags: --test-model · --gateway · --alias · --key-file · --help`,
      );
    }
  }

  if (modelOnly && !testModel) throw new Error("doctor: --model-only requires --test-model.");
  return {
    help, testModel, modelOnly, installedSettingsFile, ledgerPasswordFile, gatewayUrl, alias, keyFile,
    gatewayProfileFile, providerKeyFile, releaseFile, containersFile, keeperConfigFile, keeperRenderedFile, outsideRoute, laresProjects,
  };
}

function readJson(path: string | undefined): unknown | undefined {
  if (path === undefined) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Reads the files the host side of `lares doctor` handed over. A part that is missing or
 *  unreadable becomes null, and the parity check says it could not look. Runs only on an
 *  installed server, which is the one that passes `--release-file`. */
export function readParityInput(args: ParsedDoctorArgs): ParityInput | undefined {
  if (args.releaseFile === undefined) return undefined;
  let release: ParityInput["release"] = null;
  try {
    release = parseReleaseManifest(readFileSync(args.releaseFile, "utf8"));
  } catch {
    release = null;
  }
  let containers: ContainerRow[] | null = null;
  if (args.containersFile !== undefined) {
    try {
      const rows: ContainerRow[] = [];
      for (const line of readFileSync(args.containersFile, "utf8").split(/\r?\n/)) {
        if (line.trim() === "") continue;
        const row = JSON.parse(line) as Partial<ContainerRow>;
        const replaced = (row as { replacedFiles?: unknown }).replacedFiles;
        rows.push({
          name: String(row.name ?? "").replace(/^\//, ""),
          project: String(row.project ?? ""),
          service: String(row.service ?? ""),
          image: String(row.image ?? ""),
          // An array when the host looked, null when it could not; anything else counts as not looked.
          replacedFiles: Array.isArray(replaced) ? replaced.map(String) : null,
        });
      }
      containers = rows;
    } catch {
      containers = null;
    }
  }
  const keeperConfig = readJson(args.keeperConfigFile);
  let rendered: ParityInput["rendered"] = null;
  if (args.keeperRenderedFile !== undefined) {
    try {
      rendered = parseProvenanceRecord(readFileSync(args.keeperRenderedFile, "utf8"));
    } catch {
      rendered = null;
    }
  }
  return {
    release,
    containers,
    projects: args.laresProjects,
    keeperConfig,
    keeperConfigPresent: keeperConfig !== undefined,
    rendered,
    ...(args.outsideRoute !== undefined ? { outsideRoute: args.outsideRoute } : {}),
  };
}

/** Read one value from install.sh's data-only installation.env format. Never evaluate it as
 *  shell; values are either restricted bare text or single-quoted with embedded quotes encoded
 *  as the four-character sequence `'\\''`. */
export function readInstalledSetting(file: string, name: string): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const line = contents.split(/\r?\n/).find((candidate) => candidate.startsWith(`${name}=`));
  if (line === undefined) return undefined;
  const raw = line.slice(name.length + 1);
  if (/^[A-Za-z0-9@._:/=-]*$/.test(raw)) return raw;
  if (!raw.startsWith("'") || !raw.endsWith("'")) return undefined;
  const inner = raw.slice(1, -1);
  let decoded = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner.startsWith("'\\''", i)) {
      decoded += "'";
      i += 3;
    } else if (inner[i] === "'") {
      return undefined;
    } else {
      decoded += inner[i];
    }
  }
  return decoded;
}

/** The provider the built-in gateway pays, from its profile (`lib/gateway-config.ts`,
 *  `gatewayAdmissionProfile`): the same provider and base address the gateway itself calls. */
export function readGatewayProfile(profile: unknown): { provider: "anthropic" | "openai"; baseUrl: string } | undefined {
  if (typeof profile !== "object" || profile === null) return undefined;
  const { provider, providerBaseUrl } = profile as { provider?: unknown; providerBaseUrl?: unknown };
  if ((provider !== "anthropic" && provider !== "openai") || typeof providerBaseUrl !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(providerBaseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || providerBaseUrl.endsWith("/")) return undefined;
  return { provider, baseUrl: providerBaseUrl };
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
    env?: NodeJS.ProcessEnv;
    readKeyFile?: (path: string) => string;
    fetch?: typeof globalThis.fetch;
    openLedger?: (passwordFile: string) => Promise<Pick<Pool, "query" | "end">>;
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

  const readKeyFile = deps.readKeyFile ?? ((path: string) => readFileSync(path, "utf8").trim());
  const builtInGateway = args.gatewayProfileFile !== undefined;
  const explicitGateway = args.gatewayUrl !== undefined || args.alias !== undefined || args.keyFile !== undefined;
  let testModel: ModelTestDeps | undefined;
  let testProviderKey: ProviderKeyTestDeps | undefined;
  if (args.testModel && !explicitGateway && builtInGateway && !args.modelOnly) {
    // The path is not a secret; the key file's contents are, and are never read into a line.
    const profile = readGatewayProfile(readJson(args.gatewayProfileFile));
    if (!profile) {
      deps.out(`doctor: the gateway's provider settings at "${args.gatewayProfileFile}" could not be read, so the provider key cannot be tested.`);
      return 1;
    }
    let key: string;
    try {
      if (args.providerKeyFile === undefined) throw new Error("no file");
      key = readKeyFile(args.providerKeyFile);
    } catch {
      deps.out(`doctor: the provider key file${args.providerKeyFile === undefined ? "" : ` at "${args.providerKeyFile}"`} could not be read, so the provider key cannot be tested.`);
      return 1;
    }
    testProviderKey = { ...profile, key, fetch: deps.fetch };
  } else if (args.testModel) {
    if (!args.gatewayUrl || !args.alias || !args.keyFile) {
      deps.out("doctor: --test-model requires --gateway <url>, --alias <name> and --key-file <path>, all three.");
      return 1;
    }
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

  if (args.modelOnly && testModel) {
    const result = await probeModel(testModel);
    deps.out(`Model connection: ${result.say}`);
    return result.verdict === "ok" ? 0 : 1;
  }

  // Unreadable or refused: the migrations check says so; every other check still runs.
  const ledger = args.ledgerPasswordFile === undefined || !deps.openLedger ? undefined
    : await deps.openLedger(args.ledgerPasswordFile).catch(() => undefined);
  const results = await runDoctor({
    db: deps.db,
    ledgerDb: ledger,
    installed: args.installedSettingsFile !== undefined,
    env: (() => {
      const env = { ...(deps.env ?? process.env) };
      if (args.installedSettingsFile !== undefined) {
        delete env.CONSOLE_ALLOWED_EMAILS;
        const allowedEmails = readInstalledSetting(args.installedSettingsFile, "CONSOLE_ALLOWED_EMAILS");
        if (allowedEmails !== undefined) env.CONSOLE_ALLOWED_EMAILS = allowedEmails;
      }
      return env;
    })(),
    sqlDir: SQL_DIR,
    now: new Date(),
    testModel,
    builtInGateway,
    testProviderKey,
    parity: readParityInput(args),
  }).finally(() => ledger?.end());
  deps.out(doctorReport(results));
  return doctorExitCode(results);
}


if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = poolFromEnv();
  const openLedger = (passwordFile: string) => operatorPoolFromFile(passwordFile, {
    host: process.env.PGHOST ?? "db", port: Number(process.env.PGPORT ?? 5432), database: process.env.PGDATABASE ?? "lares_state",
  });
  main(process.argv.slice(2), { db: pool, openLedger, out: (s) => process.stdout.write(`${s}\n`) })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stdout.write(`${messageOf(err)}\n`);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
