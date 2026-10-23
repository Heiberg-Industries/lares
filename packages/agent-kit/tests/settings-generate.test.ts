import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requiredSettingsShell } from "@lares/vault-format/settings-check";

const REPO = join(import.meta.dirname, "..", "..", "..");

describe("the generated startup guard", () => {
  it("is what the generator would write today", () => {
    const onDisk = readFileSync(join(REPO, "images/agent-runtime/required-settings.sh"), "utf8");
    expect(onDisk).toBe(requiredSettingsShell(["chief-of-staff", "creative"]));
    const chiefOnDisk = readFileSync(join(REPO, "images/agent-runtime/required-settings-chief-of-staff.sh"), "utf8");
    expect(chiefOnDisk).toBe(requiredSettingsShell(["chief-of-staff"], { managedChiefModelPurpose: true }));
    expect(() => requiredSettingsShell(["chief-of-staff", "creative"], { managedChiefModelPurpose: true })).toThrow();
  });
});
