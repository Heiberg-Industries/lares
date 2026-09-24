/**
 * Conformance (ORB-286): the INSTALLED eve carries the attachment-staging hunk from patches/eve.patch.
 *
 * Without it, eve 0.32 inlines any `image/*` (a HEIC photo reached the Anthropic API as
 * `image/heic`, which it refuses, and the session died — 2026-09-14), and every other staged file
 * reaches the model as a bare sandbox path. An eve bump that drops the hunk fails here, not in a
 * chat. The inline rule is evaluated from the installed file's own source, not restated.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

function eveRoot(): string {
  let dir = path.dirname(require.resolve("eve"));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, "package.json")) && path.basename(dir) === "eve") return dir;
    dir = path.dirname(dir);
  }
  throw new Error("could not locate the installed eve package root from require.resolve('eve')");
}

const staging = readFileSync(path.join(eveRoot(), "dist/src/harness/attachment-staging.js"), "utf8");

/** The installed `shouldInlineSandboxRefAsBytes`, compiled from its own source. */
function installedInlineRule(): (ref: { mediaType: string; size: number }) => boolean {
  const src = staging.match(/function shouldInlineSandboxRefAsBytes\(e\)\{[\s\S]*?\}(?=function )/)?.[0];
  if (!src) throw new Error("shouldInlineSandboxRefAsBytes not found in the installed eve");
  return new Function(`${src}; return shouldInlineSandboxRefAsBytes;`)() as (ref: { mediaType: string; size: number }) => boolean;
}

describe("eve attachment-staging patch (ORB-286)", () => {
  it("routes non-inlined files through the agent-kit hook", () => {
    expect(staging).toContain("globalThis.__laresHydrateSandboxRef");
    expect(staging).toContain("return laresHydrateSandboxRef(r,t)");
  });

  it("inlines only the image types the model accepts, within eve's size caps", () => {
    const inline = installedInlineRule();
    expect(inline({ mediaType: "image/jpeg", size: 1000 })).toBe(true);
    expect(inline({ mediaType: "image/png", size: 1000 })).toBe(true);
    expect(inline({ mediaType: "image/heic", size: 1000 })).toBe(false);
    expect(inline({ mediaType: "image/tiff", size: 1000 })).toBe(false);
    expect(inline({ mediaType: "image/jpeg", size: 4_000_000 })).toBe(false);
    expect(inline({ mediaType: "application/pdf", size: 1000 })).toBe(true);
    expect(inline({ mediaType: "application/pdf", size: 21_000_000 })).toBe(false);
    expect(inline({ mediaType: "text/plain", size: 10 })).toBe(false);
  });
});
