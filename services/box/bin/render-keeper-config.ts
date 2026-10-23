// services/box/bin/render-keeper-config.ts — the file the keeper boots from, and the
// variables its compose file refuses to start without, both out of the release file
// `ops/install.sh` was given.
//
// WHY THIS IS A COMMAND AND NOT A HEREDOC — the same reason bin/render-stack.ts beside it is
// one, in its own words: the release rules and the configuration's shape are TypeScript, and
// restating either in shell would be two copies free to drift. `lib/keeper-config.ts` imports
// `./release-manifest.js`, the project-wide spelling for a sibling module, which bare `node`
// cannot resolve to the `.ts` file next to it — so this goes through the box's own tsx, exactly
// as `migrate`, `first-owner`, `doctor` and `render-stack` already do.
//
// IT WRITES TWO FILES, NOT STDOUT, so nothing a wrapper prints can end up inside either.
//   1. keeper.json — read by the keeper container at startup (loadKeeperConfig).
//   2. a compose env file — every `${…:?}` variable compose.lares-keeper.yaml names. Two of
//      them (the keeper's and the squid's images) can only come from the release file, which is
//      why they are rendered here rather than exported by install.sh; the rest are the
//      installation's own paths, handed in below, and are written into the same file so one
//      `--env-file` carries the whole set and `docker compose` has nothing left to guess.
//
// NOTHING HERE TOUCHES A NETWORK, A REGISTRY OR A CONTAINER.
import {financialCustodyConfigSchema,gatewayBudgetConfigSchema,nativeCustodyConfigSchema} from "../../keeper/lib/config.js";
import { credentialConfigSchema } from "../../keeper/lib/credential-state.js";
import { readFileSync, writeFileSync, chmodSync, lstatSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReleaseManifest, imageFor } from "../lib/release-manifest.js";
import { renderKeeperConfig } from "../lib/keeper-config.js";
import type { KeeperConfig } from "../../keeper/lib/config.js";

type KeeperMicrosoft = NonNullable<NonNullable<KeeperConfig["lifecycle"]>["runtime"]["microsoft"]>;
type KeeperGoogle = NonNullable<NonNullable<KeeperConfig["lifecycle"]>["runtime"]["google"]>;

/** Positional on purpose, like render-stack's: install.sh passes paths it built itself, and a
 *  flag parser here would be one more place for the two to disagree about a name. */
const ARGUMENTS = [
  "releaseFile",
  "outFile", // where keeper.json is written NOW (install.sh gives a neighbouring .partial)
  "envOutFile", // where the compose env file is written now (likewise)
  "keeperConfig", // where keeper.json will LIVE — what LARES_KEEPER_CONFIG must name
  "project",
  "root",
  "agentsDir",
  "retiredDir",
  "backupDir",
  "egressDir",
  "secretsDir",
  "socketDir",
  "hostSocketDir",
  "network",
  "subnet",
  "proxyAddress",
  "gatewayUrl",
  "pgDatabase",
  "ownerId",
  "credentialAdministrator",
  "domain", // the installation's public domain; becomes publicDoorOrigin (https://<domain>)
  "ownerHomeTz", // the owner's time zone, "" when unknown
] as const;

const HELP_TEXT = [
  `pnpm -C services/box render-keeper-config ${ARGUMENTS.map((a) => `<${a}>`).join(" ")}`,
  "",
  "Renders this installation's keeper configuration from a release file and writes it to",
  "<outFile>, together with the compose variables compose.lares-keeper.yaml requires, written",
  "to <envOutFile>. Refuses, naming what is wrong, when the release file is not readable, is",
  "not a release, names an image by anything but a digest, or names no image for the keeper,",
  "its egress proxy, its firewall helper or one of the three roles.",
  "",
  "The Notion slot starts unprepared. A host administrator must prepare keeper-only storage,",
  "review all shared consumers and set prepared/inventoryComplete in root-owned keeper.json.",
  "Existing external token files are never adopted; the installation secret mount stays read-only.",
  "",
  "Exit codes:",
  "  0  both files were written",
  "  1  refused — nothing was written (including an existing keeper.json that is not valid JSON)",
].join("\n");

export function main(argv: readonly string[], out: (s: string) => void): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    out(HELP_TEXT);
    return 0;
  }
  if (argv.length !== ARGUMENTS.length) {
    out(
      `render-keeper-config needs ${ARGUMENTS.length} arguments and was given ${argv.length}.\n\n${HELP_TEXT}`,
    );
    return 1;
  }
  const at = (name: (typeof ARGUMENTS)[number]): string => argv[ARGUMENTS.indexOf(name)]!;

  if (!credentialConfigSchema.shape.administrator.safeParse(at("credentialAdministrator")).success) {
    out("Configure one credential administrator email; nothing was written");
    return 1;
  }
  const manifest = parseReleaseManifest(readFileSync(at("releaseFile"), "utf8"));

  // An earlier keeper.json may hold settings the installer never renders and other commands
  // wrote (the Google mail and calendar block). Read it BEFORE anything is written. A file that
  // exists but cannot be read as JSON is refused outright: carrying nothing over would silently
  // wipe those settings, and the previous file is left untouched for the owner to repair.
  const previous = readPrevious(at("keeperConfig"));

  // The deadline calendar, bound for the chief of staff only when it is a plain file. The keeper
  // refuses a symlink in verifyBindingSources, which would block every later change to every
  // agent, so anything else is left out with a warning rather than bound.
  const calendarPath = join(at("root"), "installation", "deadline-calendar.json");
  let deadlineCalendarFile: string | undefined;
  if (existsSync(calendarPath) || isLink(calendarPath)) {
    if (lstatSync(calendarPath).isFile()) deadlineCalendarFile = calendarPath;
    else
      out(
        `Warning: ${calendarPath} is not a plain file (a link or a folder), so the chief of staff was NOT given the deadline calendar. Replace it with a regular file and run the installer again.`,
      );
  }

  const modelPurposeKeyFile = optionalModelPurposeKey(join(at("secretsDir"), "console-model-purpose-signing-key"));
  const config = renderKeeperConfig(manifest, {
    ...(previous.budgetFinancial?{previousBudgetFinancial:previous.budgetFinancial}:{}),
    ...(previous.budgetNative?{previousBudgetNative:previous.budgetNative}:{}),
    ...(previous.gatewayBudget?{previousGatewayBudget:previous.gatewayBudget}:{}),
    modelPurposeConsoleSigningKeyFile: modelPurposeKeyFile,
    modelPurposeRuntimeDir: modelPurposeKeyFile ? join(at("socketDir"), "model-purpose") : null,
    project: at("project"),
    network: at("network"),
    subnet: at("subnet"),
    proxyAddress: at("proxyAddress"),
    dir: at("root"),
    agentsDir: at("agentsDir"),
    retiredDir: at("retiredDir"),
    backupDir: at("backupDir"),
    egressDir: at("egressDir"),
    secretsDir: at("secretsDir"),
    pgDatabase: at("pgDatabase"),
    gatewayUrl: at("gatewayUrl"),
    ownerId: at("ownerId"),
    credentialAdministrator: at("credentialAdministrator"),
    publicDoorOrigin: `https://${at("domain")}`,
    ...(at("ownerHomeTz") ? { ownerHomeTz: at("ownerHomeTz") } : {}),
    ...(previous.schedulesLive !== undefined ? { previousSchedulesLive: previous.schedulesLive } : {}),
    ...(deadlineCalendarFile ? { deadlineCalendarFile } : {}),
  });
  if (previous.microsoft !== undefined) config.lifecycle!.runtime.microsoft = previous.microsoft;
  if (previous.google !== undefined) config.lifecycle!.runtime.google = previous.google;

  // Looked up BEFORE the first byte is written: a release missing the keeper's own image or
  // its egress proxy's must refuse with nothing on disk, not with a keeper.json already written
  // and an env file that never arrived.
  const keeperImage = imageFor(manifest, "lares-keeper");
  const squidImage = imageFor(manifest, "lares-egress-proxy");

  // 0600, and chmod'd as well as passed as a mode: `mode:` is masked by the caller's umask, and
  // install.sh sets `umask 077`, so a wider mode asked for here would silently not happen. This file names every path this installation keeps a secret at, and
  // the only process that reads it is the keeper container, which compose.lares-keeper.yaml
  // runs as `user: '0:0'`. Nothing but root has any use for it, so nothing but root gets it.
  writeFileSync(at("outFile"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(at("outFile"), 0o600);

  // The variables compose.lares-keeper.yaml names with `:?`. Every one of them is written
  // here, in one file, so `docker compose --env-file` carries the whole set: a variable left to
  // the shell's environment is one a later change can drop without anything noticing until an
  // install fails on a box.
  const env = [
    "# The keeper's compose variables, written by services/box/ops/install.sh.",
    "# Every name below is one compose.lares-keeper.yaml refuses to start without. The two",
    "# image digests come from the release file this installation was given; the paths are this",
    "# installation's own. Nothing here is a secret — no value, only names and paths.",
    `LARES_KEEPER_IMAGE=${keeperImage}`,
    `LARES_SQUID_IMAGE=${squidImage}`,
    `LARES_ROOT=${at("root")}`,
    `LARES_KEEPER_CONFIG=${at("keeperConfig")}`,
    `LARES_SOCKET_DIR=${at("socketDir")}`,
    `LARES_HOST_SOCKET_DIR=${at("hostSocketDir")}`,
    `LARES_EGRESS_DIR=${at("egressDir")}`,
    // Only exact credential files consumed by the keeper are mounted. The database operator
    // credential has a separate host-only directory and is never named here.
    `LARES_DATABASE_PASSWORD_FILE=${join(at("secretsDir"), "database-password")}`,
    `LARES_FINANCIAL_DATABASE_PASSWORD_FILE=${join(at("secretsDir"), "financial-database-password")}`,
    `LARES_WORKFLOW_PROVISIONER_PASSWORD_FILE=${join(at("secretsDir"), "workflow-provisioner-password")}`,
    `LARES_WORKFLOW_RUNTIME_PASSWORD_FILE=${join(at("secretsDir"), "workflow-password")}`,
    `LARES_GATEWAY_MASTER_KEY_FILE=${join(at("secretsDir"), "gateway-master-key")}`,
    `LARES_EVE_ROUTE_PASSWORD_FILE=${join(at("secretsDir"), "eve-route-password")}`,
    `LARES_VAULT_SIGNING_KEY_FILE=${join(at("secretsDir"), "console-vault-signing-key")}`,
    ...(config.modelPurposeConsoleSigningKeyFile ? [`LARES_MODEL_PURPOSE_SIGNING_KEY_FILE=${config.modelPurposeConsoleSigningKeyFile}`] : []),
    `LARES_PROXY_ADDRESS=${at("proxyAddress")}`,
    `LARES_NETWORK=${at("network")}`,
    "",
  ].join("\n");
  writeFileSync(at("envOutFile"), env, { mode: 0o640 });
  chmodSync(at("envOutFile"), 0o640);
  return 0;
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function optionalModelPurposeKey(path: string): string | null {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0)
      throw new Error("Console model-purpose signing key is present but is not a non-empty regular file");
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** What the keeper.json already on this host holds that the installer does not decide: the
 *  provider blocks (configured separately) and the schedules switch (the owner may have chosen). */
function readPrevious(path: string): { google?: KeeperGoogle; microsoft?: KeeperMicrosoft; schedulesLive?: boolean; budgetFinancial?:KeeperConfig["budgetFinancial"]; budgetNative?:KeeperConfig["budgetNative"]; gatewayBudget?:KeeperConfig["gatewayBudget"] } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`${path} exists but cannot be read (${messageOf(err)}). Nothing was written; fix or move it, then run the installer again.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `${path} is not valid JSON, so the provider settings in it cannot be carried over. Nothing was written and the file is untouched. Repair it, or move it aside if you accept losing those settings, then run the installer again.`,
    );
  }
  const financial=(parsed as {budgetFinancial?:unknown}|null)?.budgetFinancial;
  const budgetFinancial=financial===undefined?undefined:financialCustodyConfigSchema.parse(financial);
  const native=(parsed as {budgetNative?:unknown}|null)?.budgetNative;
  const budgetNative=native===undefined?undefined:nativeCustodyConfigSchema.parse(native);
  const gateway=(parsed as {gatewayBudget?:unknown}|null)?.gatewayBudget;
  const gatewayBudget=gateway===undefined?undefined:gatewayBudgetConfigSchema.parse(gateway);
  if (budgetNative && !budgetFinancial)
    throw new Error(`${path} has native custody without a financial custody binding. Nothing was written; restore the matching binding or use operator recovery before running the installer again.`);
  const runtime = (parsed as { lifecycle?: { runtime?: { google?: KeeperGoogle; microsoft?: KeeperMicrosoft; schedulesLive?: unknown } } } | null)
    ?.lifecycle?.runtime;
  return {
    ...(budgetFinancial?{budgetFinancial}:{}),
    ...(budgetNative?{budgetNative}:{}),
    ...(gatewayBudget?{gatewayBudget}:{}),
    ...(runtime?.microsoft ? { microsoft: runtime.microsoft } : {}),
    ...(runtime?.google ? { google: runtime.google } : {}),
    ...(typeof runtime?.schedulesLive === "boolean" ? { schedulesLive: runtime.schedulesLive } : {}),
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2), (s) => process.stdout.write(`${s}\n`));
  } catch (err: unknown) {
    // The refusal sentence is the engine's own (parseReleaseManifest, imageFor), printed as it
    // was written. install.sh never re-words it.
    process.stderr.write(`${messageOf(err)}\n`);
    process.exitCode = 1;
  }
}
