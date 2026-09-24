/**
 * ORB-152 — the never-list's missing enforcement.
 *
 * Seventeen files across the fleet contain `export default disableTool()` and a comment
 * claiming "a name matching no framework tool fails the build". That claim was FALSE on eve
 * 0.32: eve did not validate `disableTool()` filenames at build time, so a typo'd filename
 * silently removed nothing and the tool it meant to kill stayed live. For files that exist to
 * keep `bash`, `write_file` and `web_fetch` out of a production agent's hands, silent inertness
 * was the worst available failure mode.
 *
 * UPDATE, eve 0.60.1 (W2-s8b). The claim is now TRUE: a disableTool() sentinel whose name
 * matches no framework-default candidate now fails `eve build` itself
 * (`compiler/source-graph.js`: `Source "..." disables a slot with no lower-precedence source.`
 * — the exact CI blocker W2-s8 retired the glob.ts/grep.ts sentinels for, once those two left
 * eve's default tool set at 0.39.0 and had nothing left to shadow). This test is not made
 * redundant by that: it is the fast, no-build confirmation of the same fact, catching a typo or
 * a dropped default in a plain `pnpm test` run long before anyone pays for `eve build`.
 *
 * This test IS the enforcement, in the same spirit as the compose drift guard and Saga's
 * schema drift alarm against Marcel: it walks every eve service's `agent/tools/`, finds the
 * `disableTool()` files, and asserts each filename corresponds to a real framework-DEFAULT tool
 * in the INSTALLED eve — resolved through the service's own dependency graph, so an eve upgrade
 * that renames or removes a builtin turns this red instead of turning a disable inert.
 *
 * THE SOURCE OF TRUTH CHANGED ON 0.60.1. `getAllFrameworkToolNames()` (via
 * `dist/src/runtime/framework-tools/`) no longer exists anywhere in the installed package —
 * that whole directory is gone, and there is no public replacement. Nor is a directory listing
 * of `dist/src/tools/framework/` + `dist/src/tools/provided/` a safe substitute: that directory
 * holds every tool eve SHIPS, default or not — `glob`/`grep` sit right next to `bash`/
 * `web_search`, and only the latter are still framework-DEFAULTS a disableTool() sentinel can
 * shadow. The one place that draws exactly that line is `dist/src/framework/sources/
 * registry.js` — the literal module the COMPILER itself reads to build the framework-default
 * candidate set (`eve:defaults`/`eve:root-defaults`). `frameworkToolNames()` below reads that
 * file's own two default-source blocks directly (a plain text read, not a module import: the
 * `modules` arrays are closures with no public accessor, so importing and inspecting them would
 * still mean depending on the same internal shape a text read already depends on, with none of
 * the robustness). Verified against a real `eve build`'s compiled manifest for all three roles:
 * bash, read_file, write_file, todo, web_fetch, load_skill, connection_search, ask_question,
 * task_cancel, web_search, agent — 11 names, glob/grep correctly absent.
 *
 * It lives in agent-kit because the kit is the fleet's shared layer and the one place a
 * fleet-wide invariant has a single home.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const SERVICES_DIR = join(import.meta.dirname, "..", "..", "..", "services");

function disableToolFiles(serviceDir: string): string[] {
  const toolsDir = join(serviceDir, "agent", "tools");
  if (!existsSync(toolsDir)) return [];
  return readdirSync(toolsDir)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => /export default disableTool\(\)/u.test(readFileSync(join(toolsDir, f), "utf8")));
}

/**
 * eve's real framework-DEFAULT tool names for the SERVICE's own installed eve (not the
 * workspace root's) — see this file's header for why `registry.js` rather than a directory
 * listing. Names already match `agent/tools/<name>.ts` exactly; eve 0.60.1's logical paths are
 * snake_case, so — unlike the old kebab-cased `framework-tools/*.js` filenames this test used to
 * convert against — no case conversion is needed any more.
 */
function frameworkToolNames(serviceDir: string): ReadonlySet<string> {
  const req = createRequire(join(serviceDir, "package.json"));
  const eveRoot = dirname(req.resolve("eve/package.json"));
  const registryPath = join(eveRoot, "dist", "src", "framework", "sources", "registry.js");
  const source = readFileSync(registryPath, "utf8");
  const names = new Set<string>();
  for (const m of source.matchAll(/logicalPath:`tools\/([a-z_]+)\.ts`/gu)) names.add(m[1]!);
  if (names.size === 0) throw new Error(`no tools/*.ts logicalPath found in ${registryPath} — the registry format has changed`);
  return names;
}

const eveServices = readdirSync(SERVICES_DIR).filter((d) => existsSync(join(SERVICES_DIR, d, "agent", "agent.ts")));

describe("disableTool() filenames resolve to real framework tools (ORB-152)", () => {
  it("found the fleet and the disable files — this test must never pass vacuously", () => {
    expect(eveServices.length).toBeGreaterThanOrEqual(3);
    const total = eveServices.flatMap((s) => disableToolFiles(join(SERVICES_DIR, s))).length;
    expect(total).toBeGreaterThanOrEqual(10);
  });

  for (const service of eveServices) {
    it(`${service}: every disabled name is a tool the installed eve actually ships`, () => {
      const serviceDir = join(SERVICES_DIR, service);
      const files = disableToolFiles(serviceDir);
      if (files.length === 0) return; // an agent with no disables is legitimate
      const available = frameworkToolNames(serviceDir);
      for (const file of files) {
        const name = file.replace(/\.ts$/u, "");
        expect(
          available.has(name),
          `${service}/agent/tools/${file}: no framework-default tool "${name}" in the installed ` +
            `eve (checked eve:defaults/eve:root-defaults in framework/sources/registry.js) — this ` +
            `disable is INERT and, on eve 0.60.1+, would also fail \`eve build\` outright`,
        ).toBe(true);
      }
    });
  }
});
