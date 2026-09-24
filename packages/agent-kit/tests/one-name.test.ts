// W5C-s9 — the last slice of the vault rename: delete the three retired names from
// `KNOWN_CAPABILITIES` and prove, by grep, that nothing in the tree still spells one of them as
// a capability. `brain`, `atlas` and `memory` already left the array at W5C-s5/s6
// (WAVE-3-NOTES's 5C point 13); what is left here is this file itself, the golden list in
// `manifest.test.ts`, and the removal of `grantedVaultAreas`' legacy mapping
// (`AREA_OF_LEGACY_CAPABILITY`, manifest.ts) — the last place a `brain`/`atlas`/`memory` grant
// still did anything.
//
// Adapted from the plan's own snippet (`.claude/plans/2026-09-19-prelaunch-wave-5.md`,
// W5C-s9), corrected against the real code rather than the brief:
//   - there is no `base` manifest fixture in this package — the fixture is built inline below,
//     the same minimal shape `vault-areas.test.ts`'s own `declaration()` helper uses;
//   - the "not in KNOWN_CAPABILITIES" membership check lives in `assertDeclarationIntegrity`,
//     NOT in `parseManifest` (manifest.ts:436-457; `parseManifest` only runs the zod schema) —
//     so the "an old grant now fails closed, loudly" case below calls
//     `assertDeclarationIntegrity`, not `parseManifest`, or it would not throw at all;
//   - two CAPABILITY_SHAPES the plan could not have known about are added: `explicitLevel(...,
//     "brain"|"atlas"|"memory")` (the ratchet's own capability argument) and
//     `capabilityOfTool(...).toBe("brain"|"atlas"|"memory")` (a test asserting the OLD answer).
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MODEL_ALIAS_RE } from "../src/definition.js";
import { assertDeclarationIntegrity, grantedVaultAreas, KNOWN_CAPABILITIES, parseManifest } from "../src/manifest.js";
import { storeForArea } from "../src/notes-store.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const CAPABILITY_SHAPES = [
  // Added after the rename nearly shipped with these two: a CONDITION on a dead capability is
  // false for ever, and neither shape names it as `capability: "…"`. The first one refused every
  // note write the chief of staff was asked to make.
  /\bisGranted\([^,]+,\s*"(brain|atlas|memory)"/,
  /\bresolveExtensionTool\([^,]+,\s*"(brain|atlas|memory)"/,
  /capability:\s*"(brain|atlas|memory)"/,
  /"capability":\s*"(brain|atlas|memory)"/,
  /\bgrantFor\([^,]+,\s*"(brain|atlas|memory)"/,
  /\bautonomyOf\([^,]+,\s*"(brain|atlas|memory)"/,
  /CAPABILITY_DOCS\["(brain|atlas|memory)"\]/,
  // Not in the plan's snippet: the ratchet's own board-level lookup, and a test pinning the OLD
  // `capabilityOfTool` answer — both name one of the three just as directly as `grantFor` does.
  /explicitLevel\([^)]*"(brain|atlas|memory)"/,
  /capabilityOfTool\([^)]*\)\s*\)?\.toBe\("(brain|atlas|memory)"\)/,
];

// `.json` matters as much as `.ts` here: the `"capability":\s*"..."` shape is exactly what a real
// `agent.json` (or `integrations/*/integration.json`) grant looks like on disk, not only what a
// JSON literal quoted inside a TS comment looks like.
const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".sql", ".json"]);

/** A tripwire over source text, the same shape `write-shape-lint.ts` and
 *  `integration-secret-lint.ts` already use in this package: walk `dirs` (repo-root-relative)
 *  under `REPO_ROOT`, skip anything matching `opts.skip`, and report every `file:line: text`
 *  that matches one of `patterns`. Synchronous and read-only — a lint, not a build step. */
function grepRepo(patterns: readonly RegExp[], dirs: readonly string[], opts: { skip: readonly RegExp[] } = { skip: [] }): string[] {
  const hits: string[] = [];
  const stack = dirs.map((d) => join(REPO_ROOT, d));
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const rel = relative(REPO_ROOT, dir).split("\\").join("/");
    if (opts.skip.some((re) => re.test(`${rel}/`))) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // a listed dir that does not exist (yet) finds nothing, rather than throwing
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const entryRel = relative(REPO_ROOT, full).split("\\").join("/");
      if (opts.skip.some((re) => re.test(entryRel))) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !TEXT_EXTENSIONS.has(extname(entry.name))) continue;
      const text = readFileSync(full, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        for (const pattern of patterns) {
          if (pattern.test(lines[i]!)) hits.push(`${entryRel}:${i + 1}: ${lines[i]!.trim()}`);
        }
      }
    }
  }
  return hits;
}

describe("the vault rename is finished — one capability, not three", () => {
  it("no file names brain, atlas or memory as a capability", () => {
    const hits = grepRepo(CAPABILITY_SHAPES, ["packages", "services"], {
      skip: [
        /node_modules/,
        /\/dist\//,
        // eve's own gitignored dev copies of the source tree — stale by nature, never shipped.
        /\/\.eve\//,
        /\/\.output\//,
        /\/\.next\//,
        /one-name\.test\.ts$/,
        // The chief of staff's wiring test quotes the dead condition in order to forbid it.
        /vault-write-approver-wiring\.test\.ts$/,
        // Box 077 is a MIGRATION over data this box already recorded under the three retired
        // names (ADR-0017 rule 1) — its own text, and the test that proves it forward/back/
        // forward, must go on naming them; that is history being moved, not a leftover capability
        // declaration. Excluded here, not fixed there.
        /services\/box\/sql\/077_capability_rename\.sql$/,
        /services\/box\/tests\/capability-rename\.test\.ts$/,
      ],
    });
    expect(hits).toEqual([]);
  });

  it("the capability set holds vault and neither of the three", () => {
    expect(KNOWN_CAPABILITIES).toContain("vault");
    for (const gone of ["brain", "atlas", "memory"]) expect(KNOWN_CAPABILITIES).not.toContain(gone);
    expect(new Set(KNOWN_CAPABILITIES).size).toBe(KNOWN_CAPABILITIES.length);
  });

  it("an old grant now fails closed, loudly", () => {
    // `parseManifest` only runs the zod schema — the membership check is
    // `assertDeclarationIntegrity`'s (manifest.ts:436-457), so THAT is what must be called for
    // this to throw at all.
    expect(() =>
      assertDeclarationIntegrity({
        name: "fixture-agent",
        model: "fixture-brain",
        grants: [{ capability: "brain", scope: "read" }],
      }),
    ).toThrow(/capability "brain" is not in KNOWN_CAPABILITIES/);
  });

  it("an old grant, short of that throw, simply grants nothing — no alias, no shim", () => {
    // `grantedVaultAreas` only ever reads the declaration's OWN `vault` grant
    // (manifest.ts's `AREA_OF_LEGACY_CAPABILITY` is gone). A manifest built through the bare
    // zod schema (`parseManifest`, which does not check capability membership) and still
    // carrying `brain` therefore opens no area at all — it is not merely refused loudly, it is
    // refused silently too, the moment anyone stops asking `assertDeclarationIntegrity` first.
    const manifest = parseManifest({
      name: "fixture-agent",
      model: "fixture-brain",
      grants: [{ capability: "brain", scope: "write-with-confirm" }],
    });
    expect(grantedVaultAreas(manifest)).toEqual([]);
  });

  it("leaves the four places the word is NOT a capability exactly as they were", () => {
    expect(MODEL_ALIAS_RE.test("x-brain")).toBe(true); // a model purpose
    expect(storeForArea("private")).toBe("brain"); // the store axis
    expect(readFileSync(join(REPO_ROOT, "packages/compose-contract/src/index.ts"), "utf8")).toContain('store: "atlas"');
    expect(readFileSync(join(REPO_ROOT, "packages/vault-format/src/okf.ts"), "utf8")).toContain("taste");
  });
});
