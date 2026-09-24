// The kit's note-WRITE tools ask the mounted extension "who may approve a write?"
// (`extension.config.brain?.isApprovedPrincipal`). This role hands that answer over only when its
// declaration holds the Vault's `private` area. When the three old capabilities became `vault`,
// the condition still asked about a capability called "brain" — false for ever — and every note
// write would have been refused, the owner's included. No test saw it, because every write-gate
// test passes the config in by hand. This one reads the real wiring and the real declaration.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { assertDeclarationIntegrity, grantedVaultAreas } from "@lares/agent-kit/manifest";

import manifest from "../agent.json";

const WIRING = readFileSync(
  join(__dirname, "..", "agent", "extensions", "agent-kit", "extension.ts"),
  "utf8",
);

describe("who may approve a note write is wired to the Vault area, not to a name that is gone", () => {
  it("this role really holds the private area, so the approver check must be handed over", () => {
    expect(grantedVaultAreas(assertDeclarationIntegrity(manifest))).toContain("private");
  });

  it("the condition asks about the private area", () => {
    expect(WIRING).toMatch(/brain:\s*grantedVaultAreas\(declaration\)\.includes\("private"\)/);
  });

  it("no condition in the wiring asks about a capability that no longer exists", () => {
    expect(WIRING).not.toMatch(/isGranted\(\s*declaration\s*,\s*"(brain|atlas|memory)"\s*\)/);
  });
});
