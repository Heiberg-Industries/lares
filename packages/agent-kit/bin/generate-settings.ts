#!/usr/bin/env tsx
// bin/generate-settings.ts — writes the generated startup guard from the one settings list:
//
//   images/agent-runtime/required-settings.sh (shared strict guard)
//   images/agent-runtime/required-settings-chief-of-staff.sh (chief-only managed transport guard)
//
//   pnpm -C packages/agent-kit run generate:settings
//
// One list (`@lares/vault-format/settings`), one generator, two committed role guards: that is
// what stops the guard from drifting out of step with `SETTINGS` the way `images/agent-runtime/
// start.sh`'s hand-written `:?` list already has, twice (it missed two names the code reads
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
const CHIEF_OUT = join(ROOT, "images", "agent-runtime", "required-settings-chief-of-staff.sh");

writeFileSync(OUT, requiredSettingsShell(["chief-of-staff", "creative"]), "utf8");
writeFileSync(CHIEF_OUT, requiredSettingsShell(["chief-of-staff"], { managedChiefModelPurpose: true }), "utf8");
process.stdout.write(`${OUT}\n`);
process.stdout.write(`${CHIEF_OUT}\n`);
