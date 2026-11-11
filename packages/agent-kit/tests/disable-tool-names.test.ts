/**
 * Every eve service turns the framework's default tools away, and does it in a way that works.
 *
 * eve hands every agent a set of built-in tools it never declared: on 1.0 `bash`, `read_file`,
 * `write_file`, `edit_file`, `web_fetch` and `web_search`, plus the delegating `agent` tool on a
 * root agent. None is sandboxed away from the container here and none asks for approval. A
 * service has two ways to refuse them, and this test walks the whole fleet for both:
 *
 *  - `defaultTools: false` in `agent/agent.ts`, which drops every default tool that has no file
 *    under `agent/tools/` (`dist/src/compiler/default-tool-policy.js`). This is what both role
 *    services do now. Then the thing to watch is a file under `agent/tools/` that carries a
 *    default tool's NAME: it keeps that slot. Each service's own `tests/tool-harness.test.ts`
 *    reads the evaluated definition; this file is the fast check across the fleet, from source.
 *  - a `disableTool()` sentinel file per tool. A sentinel whose filename matches no default
 *    tool fails `eve build` (`compiler/source-graph.js`: `Source "..." disables a slot with no
 *    lower-precedence source.`), which is why the `task_cancel.ts` sentinels had to go when that
 *    slot left eve's defaults. This test is the no-build confirmation of the same fact.
 *
 * A service that does neither has every default tool, and fails here.
 *
 * WHERE THE LIST COMES FROM. `dist/src/framework/sources/registry.js` in the installed eve, the
 * module the compiler itself reads to build the framework-default candidate set
 * (`eve:defaults` / `eve:root-defaults`). A directory listing of `dist/src/tools/` is not a
 * substitute: it holds every tool eve SHIPS, default or not. It is read as text here; the
 * kit's `framework-default-tools.ts` imports the same module as an object, and
 * `framework-default-tools.test.ts` pins that reader.
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
 * listing. Names already match `agent/tools/<name>.ts` exactly: the registry's logical paths are
 * snake_case.
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

/** `defaultTools: false` as a property of the definition, not a mention in a comment. */
function setsDefaultToolsOff(serviceDir: string): boolean {
  const source = readFileSync(join(serviceDir, "agent", "agent.ts"), "utf8");
  return source.split("\n").some((line) => /^\s*defaultTools:\s*false\s*,?\s*$/u.test(line));
}

function toolFiles(serviceDir: string): string[] {
  const toolsDir = join(serviceDir, "agent", "tools");
  return existsSync(toolsDir) ? readdirSync(toolsDir).filter((f) => f.endsWith(".ts")) : [];
}

describe("every eve service turns the framework's default tools away", () => {
  it("found the fleet — this test must never pass vacuously", () => {
    expect(eveServices.length).toBeGreaterThanOrEqual(2);
    for (const service of eveServices) expect(frameworkToolNames(join(SERVICES_DIR, service)).size).toBeGreaterThanOrEqual(5);
  });

  for (const service of eveServices) {
    const serviceDir = join(SERVICES_DIR, service);

    it(`${service}: either defaultTools: false, or a sentinel for every default tool`, () => {
      if (setsDefaultToolsOff(serviceDir)) return;
      const disabled = new Set(disableToolFiles(serviceDir).map((f) => f.replace(/\.ts$/u, "")));
      const left = [...frameworkToolNames(serviceDir)].filter((name) => !disabled.has(name)).sort();
      expect(left, `${service} neither sets defaultTools: false nor switches these off: ${left.join(", ")}`).toEqual([]);
    });

    it(`${service}: with defaultTools: false, no file under agent/tools/ takes a default tool's name`, () => {
      if (!setsDefaultToolsOff(serviceDir)) return;
      const available = frameworkToolNames(serviceDir);
      const sentinels = new Set(disableToolFiles(serviceDir));
      // A sentinel by that name is harmless (it switches off what is already off). Any other
      // file by that name IS that tool as far as eve is concerned, and keeps the slot.
      const keeps = toolFiles(serviceDir).filter((f) => !sentinels.has(f) && available.has(f.replace(/\.ts$/u, "")));
      expect(keeps, `${service}/agent/tools: ${keeps.join(", ")} keep a framework default slot alive`).toEqual([]);
    });

    it(`${service}: every disabled name is a tool the installed eve actually ships`, () => {
      const files = disableToolFiles(serviceDir);
      if (files.length === 0) return; // an agent with no sentinels is legitimate
      const available = frameworkToolNames(serviceDir);
      for (const file of files) {
        const name = file.replace(/\.ts$/u, "");
        expect(
          available.has(name),
          `${service}/agent/tools/${file}: no framework-default tool "${name}" in the installed ` +
            `eve (checked eve:defaults/eve:root-defaults in framework/sources/registry.js) — this ` +
            `disable switches nothing off and fails \`eve build\` outright`,
        ).toBe(true);
      }
    });
  }
});
