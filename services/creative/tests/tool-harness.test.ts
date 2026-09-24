/**
 * eve 0.32 hands every agent a default harness it never declared. Eight of those tools are
 * removed here; three are deliberately left enabled. eve's own docs say to review the harness
 * before production use — this file is that review, written down so it survives the next
 * refactor.
 *
 * Done BEFORE her authored tools exist (Task 5), so there is never a build in which Calliope
 * has `bash` and `write_file` on a box with an Atlas mount.
 *
 * WHY THIS FILE CARRIED MORE WEIGHT THAN THE BRIEF EXPECTED, ON 0.32. eve's docs stated that a
 * disable filename matching no framework tool "fails ... at build time rather than removing the
 * wrong tool", and eve-saga's and eve-marcel's tool files repeat that claim in a comment. It was
 * NOT true of `eve build` on eve 0.32, and I checked rather than assuming: dropping a bogus
 * `agent/tools/bahs.ts` into this app produced a CLEAN build — exit 0, 0 errors, 0 warnings —
 * with `"bahs"` sitting in `.output/.eve/compile/compiled-agent-manifest.json`'s
 * `disabledFrameworkTools`. The name check lived in `resolveRuntimeAgentGraph`
 * (eve/dist/src/runtime/resolve-agent-graph.js), which threw only at RUNTIME graph resolution —
 * on the box that meant a typo surfaced as a container that could not resolve its agent, not as
 * a red build, the expensive end of the feedback loop.
 *
 * UPDATE, eve 0.60.1 (W2-s8b). That claim eve's docs made is now TRUE: a disableTool() sentinel
 * whose name matches no framework-default candidate now fails `eve build` itself
 * (`compiler/source-graph.js`: `Source "..." disables a slot with no lower-precedence source.`
 * — the exact CI blocker W2-s8 retired the glob.ts/grep.ts sentinels for). So a bogus
 * `agent/tools/bahs.ts` would now be a RED BUILD, not a clean one. This test is not made
 * redundant by that — it is the fast, no-build confirmation of the same fact, useful in a plain
 * `pnpm test` run long before anyone pays for `eve build`'s ~40s.
 *
 * So the loudness the comment promised — now doubly true, once from eve itself and once from
 * here — comes from the last test: it reads eve's real framework-tool name set out of the
 * installed package and asserts that the eight disabled plus the three enabled account for ALL
 * of it. That catches a typo, and it also catches an eve upgrade that adds a twelfth default
 * tool — which would otherwise arrive silently enabled (task_cancel, on 0.60.1, until W2-s8b
 * gave it a sentinel of its own).
 *
 * THE 0.60.1 SOURCE OF TRUTH CHANGED TOO. `getAllFrameworkToolNames()` — what this file read
 * before — no longer exists anywhere in the installed package; `dist/src/runtime/framework-tools/`
 * is gone. There is no public replacement, and reading `dist/src/tools/framework/` +
 * `dist/src/tools/provided/` by directory listing (the obvious next guess) is now WRONG: that
 * directory holds every tool eve SHIPS, default or not — `glob`/`grep` live right next to
 * `bash`/`web_search`, and only the latter are still framework-DEFAULTS a disableTool() sentinel
 * can shadow. The one place that draws that exact line is `dist/src/framework/sources/
 * registry.js` — the literal module the COMPILER itself reads to build the framework-default
 * candidate set (`eve:defaults`/`eve:root-defaults`). `frameworkToolNames()` below reads that
 * file's own two default-source blocks directly, verified against a real `eve build`'s compiled
 * manifest for all three roles (bash, read_file, write_file, todo, web_fetch, load_skill,
 * connection_search, ask_question, task_cancel, web_search, agent — 11 names, glob/grep
 * correctly absent). It is a deep import in spirit but a plain text read in practice — no public
 * API exists to ask this question at all, so there is no cleaner way to resolve the module and
 * inspect its internal registration objects without depending on eve's own compiler internals
 * (`createAgentSourceRegistry`'s returned shape), which is no more stable than the file it
 * would be reading anyway.
 *
 * ONE THING THIS FILE CANNOT SEE, and it is a real hole rather than a nitpick (ORB-135 Task 6).
 * `connection_search` IS one of registry.js's `eve:defaults` entries (so it is not invisible to
 * `frameworkToolNames()` the way it was to the old `getAllFrameworkToolNames()`), but it is also
 * eve's one REQUIRED framework tool (`compiler/default-tool-policy.js`'s
 * `REQUIRED_FRAMEWORK_TOOL_SLOTS`) — a disableTool() sentinel for it fails the build with its own
 * dedicated error, so it can never appear as a disabled sentinel here regardless. It is absent
 * from Calliope's compiled tool list today only because she declares no eve connections
 * (`connections: []`), not because anything here turns it off.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { isDisabledToolSentinel } from "eve/tools";

// Static importers, not a template-literal `import()`: Vite cannot resolve a fully dynamic
// specifier, and a test that cannot import the thing it guards guards nothing.
const DISABLED: Record<string, () => Promise<{ default: unknown }>> = {
  bash: () => import("../agent/tools/bash.js"),
  write_file: () => import("../agent/tools/write_file.js"),
  read_file: () => import("../agent/tools/read_file.js"),
  web_fetch: () => import("../agent/tools/web_fetch.js"),
  web_search: () => import("../agent/tools/web_search.js"),
  agent: () => import("../agent/tools/agent.js"),
  // glob and grep left eve's default tool set at 0.39.0, and 0.60.1 fails the build outright
  // on a disableTool() sentinel for a slot nothing provides ("disables a slot with no
  // lower-precedence source") — W2-s8 retired both sentinel files. `defaultTools: false` was
  // considered and NOT added: on this build it silently drops ask_question, todo and
  // load_skill too (no sentinel authors those slots, so eve stops granting them once its
  // optional defaults are off), which would have violated the wave's safety bar — see
  // packages/board-evals/snapshots/tools-creative.txt, where all three are baselined.
  // task_cancel is new in eve 0.60.1 (W2-s8b): a new framework tool from a version bump is an
  // owner decision, not a side effect, so it is disabled the same as its `agent` neighbour.
  task_cancel: () => import("../agent/tools/task_cancel.js"),
};

// Left enabled, and each for its own reason — none of the three can read a file, run a
// command, or reach the network, so none of them widens the surface the eight above close:
//
//   ask_question — a real park-and-wait primitive. Her persona tells her to run the studio on
//                  a terse brief with a stated assumption rather than interrogating first,
//                  but it also says to ask BEFORE running when a brief is truly unparseable.
//                  This is the tool for that one case.
//   todo         — durable per-session bookkeeping in app state. Harmless, and the harness
//                  re-injects it across compaction, so removing it would cost context on long
//                  sessions for no gain.
//   load_skill   — pulls a declared skill's instructions into the turn. It adds NO execution
//                  surface (behaviour still comes from the tools she already has), and eve
//                  only registers it when the agent declares skills — Calliope declares none
//                  today, so it is currently absent anyway. Leaving it undisabled means a
//                  future skill works without first deleting a file nobody remembers.
const ENABLED = ["ask_question", "todo", "load_skill"] as const;

// `connection_search` is neither disabled nor a free choice to enable: it is eve's one REQUIRED
// framework tool (`compiler/default-tool-policy.js`'s `REQUIRED_FRAMEWORK_TOOL_SLOTS`) — a
// disableTool() sentinel for it fails `eve build` with its own dedicated error, so it can never
// join DISABLED. It is a real `eve:defaults` registration (W2-s8b's `frameworkToolNames()` below
// sees it, unlike the old `getAllFrameworkToolNames()` this file used before eve 0.60.1 — see
// this file's header), so the "covers eve's whole harness" union below must name it explicitly
// or go red on every build. Harmless for Calliope today because it contributes no dynamic tool
// without a declared eve connection (`connections: []`).
const REQUIRED = ["connection_search"] as const;

const TOOLS_DIR = join(import.meta.dirname, "..", "agent", "tools");

function toolFileSlugs(): string[] {
  return readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.replace(/\.ts$/, ""));
}

/**
 * eve's real framework-DEFAULT tool name set — the exact set a disableTool() sentinel can
 * shadow, both at `eve build` (`compiler/source-graph.js`) and here. Read out of the installed
 * package rather than copied into a literal, because a copied literal cannot notice an eve
 * upgrade — see this file's header for why this reads `framework/sources/registry.js` rather
 * than a directory listing.
 *
 * A plain text read, not a module import: `registry.js`'s `modules` arrays are closures inside
 * `defineProgrammaticAgentSource()` calls, not exposed on any exported value, so importing the
 * module and inspecting it would still need to reverse-engineer the same internal shape this
 * avoids depending on. If a future eve moves this file or drops the `logicalPath:` literal
 * syntax this regex reads, this test fails outright — which is the right failure, because the
 * harness contract has moved and this file's assumptions need re-reading.
 */
function frameworkToolNames(): ReadonlySet<string> {
  const eveRoot = dirname(createRequire(import.meta.url).resolve("eve/package.json"));
  const registryPath = join(eveRoot, "dist", "src", "framework", "sources", "registry.js");
  const source = readFileSync(registryPath, "utf8");
  const names = new Set<string>();
  for (const m of source.matchAll(/logicalPath:`tools\/([a-z_]+)\.ts`/gu)) names.add(m[1]!);
  if (names.size === 0) throw new Error(`no tools/*.ts logicalPath found in ${registryPath} — the registry format has changed`);
  return names;
}

describe("tool harness lockdown", () => {
  for (const [slug, load] of Object.entries(DISABLED)) {
    it(`disables the built-in \`${slug}\` tool`, async () => {
      // Asserts the file IS a disable sentinel, not merely that a file by that name exists.
      // A `bash.ts` edited into a working bash tool would pass a directory listing and fail
      // here, which is the whole difference.
      expect(isDisabledToolSentinel((await load()).default)).toBe(true);
    });
  }

  it("disables exactly the intended set — no more, no less", async () => {
    // Guards both directions: a ninth disable file added without thought shows up here, and
    // so does one of these eight being quietly deleted — deleting one silently restores eve's
    // unrestricted version of that tool, with no error anywhere.
    const disabled: string[] = [];
    for (const file of readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".ts"))) {
      const mod = await import(join(TOOLS_DIR, file));
      if (isDisabledToolSentinel(mod.default)) disabled.push(file.replace(/\.ts$/, ""));
    }
    expect(disabled.sort()).toEqual(Object.keys(DISABLED).sort());
  });

  it("ask_question / todo / load_skill are NOT disabled — they are the useful three", () => {
    // eve disables by FILENAME, so "enabled" is proven by the ABSENCE of a file. Task 5 will
    // add authored tools to this directory; none of them may be named after these three.
    const slugs = toolFileSlugs();
    for (const keep of ENABLED) {
      expect(slugs, `${keep}.ts must NOT exist — its presence would remove a tool she uses`)
        .not.toContain(keep);
    }
  });

  it("every disable names a real framework tool, and the DISABLED+ENABLED+REQUIRED split covers eve's whole harness", () => {
    const names = frameworkToolNames();

    // Direction 1 — no typos. On eve 0.60.1 this is no longer the ONLY thing catching a typo —
    // `eve build` itself now fails the same way (see this file's header) — but it is the fast
    // one, and it still catches a name that used to be a real framework tool and stopped being
    // one (glob, grep: gone from `names` since they left the default set at 0.39.0, which is
    // exactly why W2-s8 had to retire their sentinel files rather than just leave them be).
    for (const slug of Object.keys(DISABLED)) {
      expect(
        [...names],
        `agent/tools/${slug}.ts disables nothing — "${slug}" is not an eve framework-default tool`,
      ).toContain(slug);
    }

    // Direction 2 — nothing arrives silently enabled. If an eve upgrade adds another default
    // tool, it is in none of DISABLED/ENABLED/REQUIRED and this goes red, forcing a decision
    // instead of handing Calliope a capability nobody chose to give her (task_cancel was
    // exactly this, on 0.60.1, until W2-s8b gave it a sentinel of its own).
    expect([...names].sort()).toEqual([...Object.keys(DISABLED), ...ENABLED, ...REQUIRED].sort());
  });
});
