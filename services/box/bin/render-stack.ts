// services/box/bin/render-stack.ts — the installation's stack file, rendered from the
// release file `ops/install.sh` was given.
//
// WHY THIS IS A COMMAND AND NOT A HEREDOC. ops/update.sh does its own release read through a
// temp `.mts` program it writes into $WORK and runs with bare `node`. That works there because
// `lib/release-manifest.ts` imports nothing. It CANNOT work here: `lib/stack-compose.ts` imports
// `./release-manifest.js`, the project-wide spelling for a sibling module, and bare node does
// not resolve a `.js` specifier to the `.ts` file beside it — it fails with "Cannot find
// module … release-manifest.js". So the render goes through the box's own tsx, the same way
// `migrate`, `first-owner` and `doctor` already do, and install.sh calls it the same way it
// already calls those three: `pnpm -C "$BOX_DIR" render-stack -- …`.
//
// IT WRITES A FILE, NOT STDOUT, so a banner or a warning printed by any wrapper between the
// installer and this process can never end up inside a compose file. The caller gives the exact
// path; install.sh gives it a neighbouring `.partial` and moves it into place itself.
//
// NOTHING HERE TOUCHES A NETWORK, A REGISTRY OR A CONTAINER. It reads one file, validates it
// through the engine's own release rules, and writes one file.
import { readFileSync, writeFileSync, renameSync, rmSync, chmodSync, existsSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReleaseManifest } from "../lib/release-manifest.js";
import { assertDatabaseAuthDirectory, renderStackCompose } from "../lib/stack-compose.js";
import { validateMaintenanceAdmissionIdentity } from "./render-keeper-config.js";
import { renderGatewayConfig, gatewayAdmissionProfile } from "../lib/gateway-config.js";

/** The arguments, in order. Positional on purpose: install.sh passes paths it built itself, and
 *  a flag parser here would be one more place for the two to disagree about a name. `alias` and
 *  `providerModel` go at the end so every earlier caller's argument count still fails
 *  loudly instead of silently shifting a path into the wrong slot. */
const ARGUMENTS = [
  "releaseFile",
  "outFile",
  "secretsDir",
  "gatewayConfigFile",
  "caddyfile",
  "caddyDataDir",
  "dbDataDir",
  "network",
  "subnet",
  "domain",
  "pgDatabase",
  "alias",
  "providerModel",
  "gatewayStartScript",
  "consoleAllowedEmails",
  "socketDir",
  "ownerId",
  "ownerHomeTz",
  "tasteDir",
  "installationDir",
  "databaseAuthDir",
  "prefix",
] as const;

/** The gateway's start script, committed once at the repository root and installed verbatim —
 *  never re-generated here, and never a second copy to drift. Resolved from THIS module rather
 *  than from install.sh, which would have to climb out of services/box to reach it. */
const COMMITTED_GATEWAY_START = join(
  dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "images", "gateway-runtime", "start.sh",
);
const COMMITTED_GATEWAY_ADMISSION = join(dirname(COMMITTED_GATEWAY_START), "gateway_admission.py");

/** Vault custody is optional on installations updated by digest only. Inspect the named file
 *  without following symlinks or reading its value; invalid/missing custody omits only Vault. */
export function optionalRegularFile(path: string): string | null {
  try {
    const info = lstatSync(path);
    return info.isFile() && info.size > 0 ? path : null;
  } catch {
    return null;
  }
}

/** Missing is the legacy optional case. A present but unsafe path must stop rendering so a
 * configured signer can never silently become an unsigned Console path. */
function optionalConfiguredRegularFile(path: string): string | null {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size === 0) throw new Error("Console model-purpose signing key is present but is not a non-empty regular file");
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const HELP_TEXT = [
  `pnpm -C services/box render-stack ${ARGUMENTS.map((a) => `<${a}>`).join(" ")}`,
  "",
  "Renders this installation's stack compose file (db, console, lares-gateway, caddy) from a",
  "release file, and writes it to <outFile>. Also renders the gateway's own LiteLLM config,",
  "naming <alias> and <providerModel>, and writes it to <gatewayConfigFile>. Installs the",
  "gateway's committed start script at <gatewayStartScript>, where the compose file mounts it",
  "as that container's entrypoint. Refuses, naming what is wrong, when the release file is not",
  "readable, is not a release, names an image by anything but a digest, or when the committed",
  "start script is missing.",
  "",
  "Exit codes:",
  "  0  all three files were written",
  "  1  refused — nothing was written",
].join("\n");

export function main(argv: readonly string[], out: (s: string) => void): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    out(HELP_TEXT);
    return 0;
  }
  if (argv.length !== ARGUMENTS.length) {
    out(
      `render-stack needs ${ARGUMENTS.length} arguments and was given ${argv.length}.\n\n${HELP_TEXT}`,
    );
    return 1;
  }
  const at = (name: (typeof ARGUMENTS)[number]): string => argv[ARGUMENTS.indexOf(name)]!;

  const manifest = parseReleaseManifest(readFileSync(at("releaseFile"), "utf8"));
  assertDatabaseAuthDirectory(at("databaseAuthDir"), at("prefix"), at("subnet"));
  const maintenanceAdmission = validateMaintenanceAdmissionIdentity(at("prefix"), at("subnet"));

  // Read BEFORE the first write, so an engine tree that arrived without this file refuses by
  // name with nothing written, rather than bringing up a gateway whose entrypoint is a
  // directory Docker invented at the mount source.
  let gatewayStartText: string;
  const gatewayModules: Record<string, string> = {};
  try {
    gatewayStartText = readFileSync(COMMITTED_GATEWAY_START, "utf8");
    for (const name of ["admission_contract.py", "lares_gateway.py"])
      gatewayModules[name] = readFileSync(join(dirname(COMMITTED_GATEWAY_START), name), "utf8");
    gatewayModules["gateway_admission.py"] = readFileSync(COMMITTED_GATEWAY_ADMISSION, "utf8");
  } catch {
    throw new Error(
      `The gateway's start script is missing from this engine (${COMMITTED_GATEWAY_START}). ` +
        "It is the gateway container's entrypoint, so the stack cannot be rendered without it.",
    );
  }
  const calendarFile = join(at("installationDir"), "deadline-calendar.json");
  const text = renderStackCompose(manifest, {
    secretsDir: at("secretsDir"),
    consoleVaultSigningKeyFile: optionalRegularFile(join(at("secretsDir"), "console-vault-signing-key")),
    consoleModelPurposeSigningKeyFile: optionalConfiguredRegularFile(join(at("secretsDir"), "console-model-purpose-signing-key")),
    socketDir: at("socketDir"),
    tasteDir: at("tasteDir"),
    gatewayConfigFile: at("gatewayConfigFile"),
    gatewayStartScript: at("gatewayStartScript"),
    caddyfile: at("caddyfile"),
    caddyDataDir: at("caddyDataDir"),
    dbDataDir: at("dbDataDir"),
    databaseAuthDir: at("databaseAuthDir"),
    maintenanceAdmission,
    network: at("network"),
    subnet: at("subnet"),
    domain: at("domain"),
    consoleAllowedEmails: at("consoleAllowedEmails"),
    ownerId: at("ownerId"),
    ownerHomeTz: at("ownerHomeTz"),
    modelAlias: at("alias"),
    pgDatabase: at("pgDatabase"),
    // The calendar is mounted only when it is already there, so a stranger without one gets no
    // mount and an installation that added one keeps it on every re-run of the installer.
    deadlineCalendarFile: existsSync(calendarFile) ? calendarFile : null,
  });
  // THE DEFECT THIS SLICE CLOSES: nothing used to write this file, so Docker created a
  // DIRECTORY at the compose file's mount source and the gateway could never read a config.
  // Same neighbouring-temp-then-move discipline install.sh's own writes use, so an interrupted
  // run never leaves a half-written config a container would mount and read.
  //
  // 0644, NOT the compose file's 0640 — corrected during integration. The compose file's mode
  // reasons that "the fleet's own containers never read it", which is true of THAT file (the
  // Docker daemon reads it, as root, on the host) and false of this one: it exists to be
  // mounted into the gateway container and read by LiteLLM itself. LiteLLM publishes a
  // `-non_root` image variant (see lib/stack-compose.ts); the
  // image comes from the release manifest, and this engine does not get to assume which
  // variant an installation names — so a root-owned 0640 file is one an unprivileged LiteLLM
  // cannot read, which fails exactly the way the missing file did. Nothing here is secret: the
  // provider key is an `os.environ/…` REFERENCE, never a value (see lib/gateway-config.ts).
  const gatewayConfigFile = at("gatewayConfigFile");
  const gatewayConfigTmp = `${gatewayConfigFile}.partial`;
  const gatewayConfigText = renderGatewayConfig({
    alias: at("alias"),
    providerModel: at("providerModel"),
  });
  rmSync(gatewayConfigTmp, { force: true });
  writeFileSync(gatewayConfigTmp, gatewayConfigText, { mode: 0o644 });
  renameSync(gatewayConfigTmp, gatewayConfigFile);
  // chmod, not just the mode above: `mode:` is masked by the caller's umask, and install.sh
  // sets `umask 077`, so the file is BORN 0600 there whatever this asks for. install.sh chmods
  // it too (as it does the compose file and the Caddyfile), but the program that writes a file
  // is the one that should guarantee its mode — this one is also runnable by hand.
  chmodSync(gatewayConfigFile, 0o644);
  const profilePath = `${gatewayConfigFile}.profile.json`;
  writeFileSync(`${profilePath}.partial`, JSON.stringify(gatewayAdmissionProfile({alias: at("alias"), providerModel: at("providerModel")})), {mode: 0o644});
  renameSync(`${profilePath}.partial`, profilePath);
  chmodSync(profilePath, 0o644);

  // THE GATEWAY'S ENTRYPOINT, INSTALLED RATHER THAN BAKED INTO AN IMAGE. Nothing in this
  // repository builds a gateway image and nothing may — the official LiteLLM image carries its
  // own `enterprise/` tree, which its licence forbids publishing or distributing, and a derived
  // image would not be the artefact upstream's cosign signature covers (see lib/stack-compose.ts). So the committed script is copied
  // here verbatim and bind-mounted in as the entrypoint. Byte-identical on purpose: the copy is
  // never edited, so tests/gateway-start-script.test.ts is a test of the file that actually runs.
  //
  // 0755, and set HERE rather than left to install.sh: `mode:` is masked by the caller's umask
  // (install.sh sets 077, which would make this 0700), and install.sh's own `chmod` is a logging
  // stub under test — a mode only it set would be fiction no test could see. An entrypoint the
  // container cannot execute is a gateway that never starts while `up -d` exits 0.
  const gatewayStartScript = at("gatewayStartScript");
  const gatewayStartTmp = `${gatewayStartScript}.partial`;
  rmSync(gatewayStartTmp, { force: true });
  writeFileSync(gatewayStartTmp, gatewayStartText, { mode: 0o755 });
  renameSync(gatewayStartTmp, gatewayStartScript);
  chmodSync(gatewayStartScript, 0o755);
  for (const [name, contents] of Object.entries(gatewayModules)) {
    const destination = `${gatewayStartScript}.${name}`;
    writeFileSync(`${destination}.partial`, contents, {mode: 0o644});
    renameSync(`${destination}.partial`, destination);
    chmodSync(destination, 0o644);
  }
  // Publish Compose only after every Gateway bind source now referenced by it is installed.
  // The helper is a startup authority gate: a visible new service definition without its
  // read-only guard file could not start safely.
  writeFileSync(at("outFile"), text, { mode: 0o640 });
  return 0;
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
