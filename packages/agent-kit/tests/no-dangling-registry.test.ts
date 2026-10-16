import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");

function grep(pattern: string, ...paths: string[]): string[] {
  try {
    return execFileSync("git", ["grep", "-n", "--", pattern, ...paths], { cwd: ROOT, encoding: "utf8" })
      .trim().split("\n").filter(Boolean);
  } catch { return []; }
}

describe("references to a registry that does not exist", () => {
  // This file names the pattern in order to look for it, so it is not a finding itself.
  const SELF = "packages/agent-kit/tests/no-dangling-registry.test.ts";

  it("no engine file points at lib/integrations/registry.ts any more", () => {
    const hits = grep("integrations/registry.ts", "packages", "services").filter((h) => !h.startsWith(SELF));
    expect(hits).toEqual([]);
  });

  // NOT checked here, on purpose: about 140 comments say "ported from services/agent-runtime/…".
  // They are history notes about where code came from, not pointers a reader is sent to follow;
  // sweeping them belongs with the naming sweep, not with this slice.

  it("the decision record may still describe the drift it was written about", () => {
    expect(grep("integrations/registry.ts", "docs").length).toBeGreaterThan(0);
  });
});
