#!/usr/bin/env tsx
// bin/write-shape-lint.ts — the write-shape lint as a standalone gate (ORB-199).
//
//   tsx bin/write-shape-lint.ts <serviceDir> [<serviceDir> …]
//
// `<serviceDir>` is the folder holding an `agent.json` — `services/chief-of-staff`, say.
//
// WHY THIS EXISTS AS A CLI. The lint's primary home is each service's own conformance suite
// (`services/eve-*/tests/agent-declaration.test.ts`), which is where every other ORB-144 check
// lives. But `pnpm test` is NOT a build gate today: neither `services/eve-*/Dockerfile` nor
// `.github/workflows/eve-*-image.yml` runs it — the Dockerfiles run `pnpm run assemble:check`
// and `pnpm exec eve build`, and the workflow goes checkout -> buildx -> push. So an image can
// be published over a red suite. This CLI is the hook that makes wiring the gate a one-line
// change to whichever of the two the owner picks; it deliberately does not wire itself.
//
// Exit codes:
//   0 — no findings.
//   1 — at least one finding; every one is printed to stderr, grouped by service.
//   2 — usage error, or a service directory with no readable `agent.json`.
import { join } from "node:path";

import { loadManifest } from "../src/manifest.js";
import { lintWriteShape, type WriteShapeFinding } from "../src/write-shape-lint.js";

function usage(message: string): never {
  console.error(`write-shape-lint: ${message}`);
  console.error("usage: write-shape-lint <serviceDir> [<serviceDir> …]");
  console.error("  <serviceDir> is the folder holding agent.json, e.g. services/chief-of-staff");
  process.exit(2);
}

function render(finding: WriteShapeFinding): string {
  if (finding.kind === "unmapped-tool") {
    return `  ${finding.tool}: no capability doc lists this tool — add it to CAPABILITY_DOCS (or to a skill's tool list), or delete the tool`;
  }
  return (
    `  ${finding.tool} (${finding.capability} @ ${finding.scope}): ${finding.rule} — ${finding.match}\n` +
    `      ${finding.file}:${finding.line}`
  );
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) usage("name at least one service directory");

let total = 0;
for (const dir of dirs) {
  let findings: WriteShapeFinding[];
  try {
    findings = lintWriteShape({ agentDir: dir, manifest: loadManifest(join(dir, "agent.json")) });
  } catch (err) {
    usage((err as Error).message);
  }
  if (findings.length === 0) {
    console.log(`${dir}: no write-shaped tool under a read grant`);
    continue;
  }
  total += findings.length;
  console.error(`${dir}: ${findings.length} finding(s) — write-shaped code under a grant below "write-with-confirm":`);
  for (const f of findings) console.error(render(f));
}

if (total > 0) {
  console.error(
    "\nEither the tool must not mutate, or agent.json must declare the capability at a write scope.\n" +
      "See packages/agent-kit/src/write-shape-lint.ts for what counts as write-shape and what is exempt.",
  );
  process.exit(1);
}
