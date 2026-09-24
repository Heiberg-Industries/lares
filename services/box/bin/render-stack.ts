// services/box/bin/render-stack.ts — W8F-F7a: the installation's stack file, rendered from the
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
import { readFileSync, writeFileSync, renameSync, rmSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReleaseManifest } from "../lib/release-manifest.js";
import { renderStackCompose } from "../lib/stack-compose.js";
import { renderGatewayConfig } from "../lib/gateway-config.js";

/** The arguments, in order. Positional on purpose: install.sh passes paths it built itself, and
 *  a flag parser here would be one more place for the two to disagree about a name. `alias` and
 *  `providerModel` (F7a-2) go at the end so every earlier caller's argument count still fails
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
  "pgUser",
  "pgDatabase",
  "alias",
  "providerModel",
  "gatewayStartScript",
] as const;

/** The gateway's start script, committed once at the repository root and installed verbatim —
 *  never re-generated here, and never a second copy to drift. Resolved from THIS module rather
 *  than from install.sh, which would have to climb out of services/box to reach it. */
const COMMITTED_GATEWAY_START = join(
  dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "images", "gateway-runtime", "start.sh",
);

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

  // Read BEFORE the first write, so an engine tree that arrived without this file refuses by
  // name with nothing written, rather than bringing up a gateway whose entrypoint is a
  // directory Docker invented at the mount source.
  let gatewayStartText: string;
  try {
    gatewayStartText = readFileSync(COMMITTED_GATEWAY_START, "utf8");
  } catch {
    throw new Error(
      `The gateway's start script is missing from this engine (${COMMITTED_GATEWAY_START}). ` +
        "It is the gateway container's entrypoint, so the stack cannot be rendered without it.",
    );
  }
  const text = renderStackCompose(manifest, {
    secretsDir: at("secretsDir"),
    gatewayConfigFile: at("gatewayConfigFile"),
    gatewayStartScript: at("gatewayStartScript"),
    caddyfile: at("caddyfile"),
    caddyDataDir: at("caddyDataDir"),
    dbDataDir: at("dbDataDir"),
    network: at("network"),
    subnet: at("subnet"),
    domain: at("domain"),
    modelAlias: at("alias"),
    pgUser: at("pgUser"),
    pgDatabase: at("pgDatabase"),
  });
  // 0640: the compose file names every secret's PATH (never a value), and the fleet's own
  // containers never read it — only root and the installation's group have any use for it.
  writeFileSync(at("outFile"), text, { mode: 0o640 });

  // THE DEFECT THIS SLICE CLOSES: nothing used to write this file, so Docker created a
  // DIRECTORY at the compose file's mount source and the gateway could never read a config.
  // Same neighbouring-temp-then-move discipline install.sh's own writes use, so an interrupted
  // run never leaves a half-written config a container would mount and read.
  //
  // 0644, NOT the compose file's 0640 — corrected during integration. The compose file's mode
  // reasons that "the fleet's own containers never read it", which is true of THAT file (the
  // Docker daemon reads it, as root, on the host) and false of this one: it exists to be
  // mounted into the gateway container and read by LiteLLM itself. LiteLLM publishes a
  // `-non_root` image variant (docs/research/2026-09-18-prelaunch/08-litellm-okf.md), the
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

  // F7c: THE GATEWAY'S ENTRYPOINT, INSTALLED RATHER THAN BAKED INTO AN IMAGE. Nothing in this
  // repository builds a gateway image and nothing may — the official LiteLLM image carries its
  // own `enterprise/` tree, which its licence forbids publishing or distributing, and a derived
  // image would not be the artefact upstream's cosign signature covers (see lib/stack-compose.ts
  // and docs/research/2026-09-18-prelaunch/08-litellm-okf.md). So the committed script is copied
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
