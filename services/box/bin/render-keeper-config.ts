// services/box/bin/render-keeper-config.ts — W8F-F7b: the file the keeper boots from, and the
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
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseReleaseManifest, imageFor } from "../lib/release-manifest.js";
import { renderKeeperConfig } from "../lib/keeper-config.js";

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
  "pgUser",
  "pgDatabase",
  "ownerId",
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
  "Exit codes:",
  "  0  both files were written",
  "  1  refused — nothing was written",
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

  const manifest = parseReleaseManifest(readFileSync(at("releaseFile"), "utf8"));
  const config = renderKeeperConfig(manifest, {
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
    pgUser: at("pgUser"),
    pgDatabase: at("pgDatabase"),
    gatewayUrl: at("gatewayUrl"),
    ownerId: at("ownerId"),
  });

  // Looked up BEFORE the first byte is written: a release missing the keeper's own image or
  // its egress proxy's must refuse with nothing on disk, not with a keeper.json already written
  // and an env file that never arrived.
  const keeperImage = imageFor(manifest, "lares-keeper");
  const squidImage = imageFor(manifest, "lares-egress-proxy");

  // 0600, and chmod'd as well as passed as a mode: `mode:` is masked by the caller's umask, and
  // install.sh sets `umask 077`, so a wider mode asked for here would silently not happen — the
  // defect F7a-2 shipped. This file names every path this installation keeps a secret at, and
  // the only process that reads it is the keeper container, which compose.lares-keeper.yaml
  // runs as `user: '0:0'`. Nothing but root has any use for it, so nothing but root gets it.
  writeFileSync(at("outFile"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(at("outFile"), 0o600);

  // The variables compose.lares-keeper.yaml names with `:?`. Every one of them is written
  // here, in one file, so `docker compose --env-file` carries the whole set: a variable left to
  // the shell's environment is one a later change can drop without anything noticing until an
  // install fails on a box.
  const env = [
    "# The keeper's compose variables, written by services/box/ops/install.sh (W8F-F7b).",
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
    // The keeper READS the database password itself, eagerly, before it serves anything
    // (bin/keeper.ts → keeperPool → readFileSync), so the directory keeper.json points at has
    // to be inside the container too. It is mounted read-only; this names the path, never a
    // value.
    `LARES_SECRETS_DIR=${at("secretsDir")}`,
    `LARES_PROXY_ADDRESS=${at("proxyAddress")}`,
    `LARES_NETWORK=${at("network")}`,
    "",
  ].join("\n");
  writeFileSync(at("envOutFile"), env, { mode: 0o640 });
  chmodSync(at("envOutFile"), 0o640);
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
