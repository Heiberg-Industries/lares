import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { imageFor, parseReleaseManifest } from "../lib/release-manifest.js";
import { assertDatabaseAuthDirectory, renderDatabaseBootstrapCompose } from "../lib/stack-compose.js";

const HELP = [
  "pnpm -C services/box render-database-bootstrap <release> <out-file> <operator-password-file> <db-data-dir> <network> <subnet> <database-auth-dir> <prefix>",
  "",
  "Renders a temporary database-only Compose file for first initialization. The password value",
  "is never read; the file names the host-only password path, which install.sh removes from the",
  "running database container before it starts the normal stack.",
].join("\n");

export function main(argv: readonly string[], out: (text: string) => void): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    out(HELP);
    return 0;
  }
  if (argv.length !== 8) {
    out(`render-database-bootstrap needs 8 arguments and was given ${argv.length}.\n\n${HELP}`);
    return 1;
  }
  const [release, output, operatorPasswordFile, dbDataDir, network, subnet, databaseAuthDir, prefix] = argv as [string, string, string, string, string, string, string, string];
  const manifest = parseReleaseManifest(readFileSync(release, "utf8"));
  assertDatabaseAuthDirectory(databaseAuthDir, prefix, subnet);
  // Refuse incomplete releases before the database is initialized. The same release will later
  // render these images into the normal stack and Keeper role configuration.
  for (const service of ["db", "console", "lares-gateway", "caddy", "lares-keeper", "lares-egress-proxy", "lares-firewall-helper", "chief-of-staff", "creative"]) {
    imageFor(manifest, service);
  }
  const contents = renderDatabaseBootstrapCompose(manifest, { operatorPasswordFile, dbDataDir, databaseAuthDir, network, subnet });
  writeFileSync(output, contents, { mode: 0o600 });
  chmodSync(output, 0o600);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2), (text) => process.stdout.write(`${text}\n`));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
