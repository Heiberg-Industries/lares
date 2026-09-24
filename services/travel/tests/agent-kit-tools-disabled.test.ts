import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isDisabledToolSentinel } from "eve/tools";

/**
 * Final-wave fix (whole-branch review of ORB-143 Task 3): proves Marcel's override files
 * under `agent/extensions/agent-kit/tools/` cover EXACTLY the set of tools `@lares/agent-kit`'s
 * eve extension contributes (`packages/agent-kit/extension/tools/*.ts`) — no more, no less.
 *
 * Before this test, nothing asserted that. A future ticket adding a tool to the extension
 * (e.g. a Twenty tool) would silently give Marcel that tool too — he'd inherit it by omission,
 * with no red test telling anyone a matching override file is missing. Mirrors
 * `services/chief-of-staff/tests/tool-harness.test.ts`'s "disables exactly the intended set — no
 * more, no less" test, which guards the same class of drift for eve's own built-in framework
 * tools; this does the equivalent comparison across two directories in two different packages
 * instead of one directory against a hardcoded map, since here BOTH sides can move.
 *
 * Directory-mount contract (docs/extensions.md's "Override a contribution"): eve resolves an
 * override by FILENAME, so a typo creates a stray file that overrides nothing (the original
 * tool stays live) rather than failing loudly — this test is the thing that catches that,
 * since a stray override file also shows up as a set-mismatch.
 *
 * ORB-144 CHANGED THE MECHANISM, NOT THE OUTCOME. An override file no longer *is* a
 * `disableTool()` call — every one of them is now the same
 * `resolveExtensionTool(manifest, capability, tool)` line eve-saga carries, byte for byte,
 * and it *resolves to* a disable sentinel here only because `services/travel/agent.json`
 * grants neither `orakel` nor `brain`. Under eve-saga's declaration the identical files
 * resolve to eleven live tools. So the third test below still asserts the property that
 * actually matters — which `agent-kit__*` tools Marcel ends up with — but it is now asserting
 * the RESULT of the declaration rather than a hard-coded fact about the file's contents. The
 * companion `tests/agent-declaration.test.ts` asserts the cause.
 *
 * ORB-168 CHANGED THE OUTCOME, for exactly one file, for one plan step. Marcel granted
 * `transit`, so `transit_plan.ts` resolved to a LIVE tool here from ORB-168 until ORB-278 step 2
 * Task 8 — the only time this directory has produced anything but sentinels.
 *
 * ORB-278 STEP 2, TASK 8 CHANGED IT BACK, for a different reason. `agent-kit__transit_plan` is
 * now emitted from Marcel's OWN catalogue (`catalogue/agent-kit__transit_plan.ts`, through
 * `agent/tools/catalogue.ts`) rather than from this mount, because a resolver-emitted tool
 * REPLACES an authored/mounted tool of the same name completely (Task 1, Q1c) and both trying to
 * answer the same prefixed key would collide. So `transit_plan.ts` here is now an UNCONDITIONAL
 * `disableTool()` — Marcel's agent.json still grants `transit`, but that grant no longer decides
 * this FILE's outcome, only the catalogue's. `GRANTED` below is therefore empty, and the third
 * test says the same absolute thing for every one of the twelve files: off. This file's title
 * was half a lie for a while; it is whole again now, and still deliberately not renamed, because
 * the git history of a file whose whole subject is "what Marcel does NOT get from the kit" is
 * worth more than an accurate filename.
 */

const EXTENSION_TOOLS_DIR = join(import.meta.dirname, "..", "..", "..", "packages", "agent-kit", "extension", "tools");
const MARCEL_OVERRIDES_DIR = join(import.meta.dirname, "..", "agent", "extensions", "agent-kit", "tools");

/** The kit contributions that resolve LIVE from THIS mount. Empty since ORB-278 step 2 Task 8:
 *  `transit_plan` used to be the one exception (ORB-168), but it now resolves from Marcel's own
 *  catalogue instead (see this file's header) — this mount answers `disableTool()` for it
 *  unconditionally, same as the other eleven, regardless of what agent.json grants. */
const GRANTED: ReadonlySet<string> = new Set<string>();

function toolSlugs(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.replace(/\.ts$/, ""))
    .sort();
}

describe("eve-marcel agent-kit override completeness", () => {
  it("packages/agent-kit's extension actually contributes tools (sanity check the comparison isn't vacuous)", () => {
    expect(toolSlugs(EXTENSION_TOOLS_DIR).length).toBeGreaterThan(0);
  });

  it("has exactly one override file per tool the extension contributes — no extra, no missing", () => {
    const contributed = toolSlugs(EXTENSION_TOOLS_DIR);
    const overridden = toolSlugs(MARCEL_OVERRIDES_DIR);
    expect(overridden).toEqual(contributed);
  });

  it("every override file resolves to a disabled sentinel — none of the twelve mounts live any more", async () => {
    // Eleven of these were always `resolveExtensionTool(manifest, capability, tool)` resolving to
    // a sentinel because Marcel grants neither `orakel` nor `brain`. `transit_plan.ts` is the
    // twelfth and the one whose STORY changed (see this file's header): from ORB-168 until
    // ORB-278 step 2 Task 8 it resolved LIVE here because Marcel grants `transit`; now it is a
    // plain, unconditional `disableTool()`, because that prefixed key is emitted from his own
    // catalogue instead. A stray or mistyped file still fails here (it would export something
    // that is not a sentinel, or fail to import at all), and so would this mount starting to
    // answer a kit tool again.
    const slugs = toolSlugs(MARCEL_OVERRIDES_DIR);
    // Sanity: an empty expectation set would make the loop below vacuous.
    expect(slugs).toContain("transit_plan");
    for (const slug of slugs) {
      const mod = await import(join(MARCEL_OVERRIDES_DIR, `${slug}.ts`));
      const shouldBeLive = GRANTED.has(slug);
      expect(
        isDisabledToolSentinel(mod.default),
        `${slug}.ts should resolve to ${shouldBeLive ? "a LIVE tool" : "a disabled tool"} under Marcel's agent.json`,
      ).toBe(!shouldBeLive);
    }
  });
});
