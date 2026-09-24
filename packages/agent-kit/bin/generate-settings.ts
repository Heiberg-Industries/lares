#!/usr/bin/env tsx
// bin/generate-settings.ts — writes the generated startup guard from the one settings list:
//
//   images/agent-runtime/required-settings.sh
//
//   pnpm -C packages/agent-kit run generate:settings
//
// One list (`@lares/vault-format/settings`), one generator, one committed shell fragment: that is
// what stops the guard from drifting out of step with `SETTINGS` the way `images/agent-runtime/
// start.sh`'s hand-written `:?` list already has, twice (W8A-s2 found two names the code reads
// that nothing declared). Never hand-edit the generated file.
//
// Run BY HAND after a setting's `requiredFor` changes. `packages/agent-kit/tests/
// settings-generate.test.ts` renders the same thing in memory and fails when the committed file
// no longer matches, so forgetting to run this is caught by the test suite rather than on a box.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { requiredSettingsShell } from "@lares/vault-format/settings-check";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const OUT = join(ROOT, "images", "agent-runtime", "required-settings.sh");

writeFileSync(OUT, requiredSettingsShell(["chief-of-staff", "travel", "creative"]), "utf8");
process.stdout.write(`${OUT}\n`);
