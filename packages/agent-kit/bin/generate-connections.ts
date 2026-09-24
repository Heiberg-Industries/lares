#!/usr/bin/env tsx
// bin/generate-connections.ts — writes BOTH generated integration files from the integration
// manifests and integrations/installation.json:
//
//   src/connections.ts         — what the console shows (W6A-s3)
//   src/integration-secrets.ts — what the keeper may MOUNT (LAR-76)
//
//   pnpm -C packages/agent-kit run generate:connections
//
// One command, one source, two outputs: that is what stops the two lists from drifting apart
// again, which is the whole of LAR-76.
//
// Run BY HAND after editing a manifest or the installation file. Deliberately NOT wired into
// `prepare`/`postinstall`: those run inside every image build, and an image does not contain
// `integrations/` — a generator that cannot find its input would fail every build.
//
// `packages/agent-kit/tests/integration-generate.test.ts` renders the same thing in memory and
// fails when the committed file no longer matches, so forgetting to run this is caught by the
// test suite rather than on a box.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  renderConnectionsModule,
  renderIntegrationSecretsModule,
  type InstallationConnections,
} from "../src/integration-generate.js";
import { loadIntegrationManifests } from "../src/integration-manifest.js";
import { KNOWN_CAPABILITIES } from "../src/manifest.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SRC = join(import.meta.dirname, "..", "src");

const installation = JSON.parse(
  readFileSync(join(ROOT, "integrations", "installation.json"), "utf8"),
) as InstallationConnections;

const outputs: [string, string][] = [
  [
    join(SRC, "connections.ts"),
    renderConnectionsModule(
      loadIntegrationManifests(join(ROOT, "integrations")),
      installation,
      KNOWN_CAPABILITIES,
    ),
  ],
  [join(SRC, "integration-secrets.ts"), renderIntegrationSecretsModule(installation)],
];

for (const [path, text] of outputs) {
  writeFileSync(path, text, "utf8");
  process.stdout.write(`${path}\n`);
}
