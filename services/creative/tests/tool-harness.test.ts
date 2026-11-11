/**
 * eve 0.32 hands every agent a default harness it never declared. Eight of those tools are
 * removed here; three are deliberately left enabled. eve's own docs say to review the harness
 * before production use — this file is that review, written down so it survives the next
 * refactor.
 *
 * Done BEFORE the authored tools exist, so there is never a build in which the creative agent
 * has `bash` and `write_file` on a box with an Atlas mount.
 *
 * WHY THIS FILE CARRIES MORE WEIGHT THAN IT SEEMS TO NEED, ON 0.32. eve's docs stated that a
 * disable filename matching no framework tool "fails ... at build time rather than removing the
 * wrong tool", and chief-of-staff's tool files repeat that claim in a comment. It was
 * NOT true of `eve build` on eve 0.32, verified rather than assumed: dropping a bogus
 * `agent/tools/bahs.ts` into this app produced a CLEAN build — exit 0, 0 errors, 0 warnings —
 * with `"bahs"` sitting in `.output/.eve/compile/compiled-agent-manifest.json`'s
 * `disabledFrameworkTools`. The name check lived in `resolveRuntimeAgentGraph`
 * (eve/dist/src/runtime/resolve-agent-graph.js), which threw only at RUNTIME graph resolution —
 * on the box that meant a typo surfaced as a container that could not resolve its agent, not as
 * a red build, the expensive end of the feedback loop.
 *
 * UPDATE, eve 0.60.1. That claim eve's docs made is now TRUE: a disableTool() sentinel
 * whose name matches no framework-default candidate now fails `eve build` itself
 * (`compiler/source-graph.js`: `Source "..." disables a slot with no lower-precedence source.`
 * — the exact CI blocker that retired the old glob.ts/grep.ts sentinels). So a bogus
 * `agent/tools/bahs.ts` would now be a RED BUILD, not a clean one. This test is not made
 * redundant by that — it is the fast, no-build confirmation of the same fact, useful in a plain
 * `pnpm test` run long before anyone pays for `eve build`'s ~40s.
 *
 * So the loudness the comment promised — now doubly true, once from eve itself and once from
 * here — comes from the last test: it reads eve's real framework-tool name set out of the
 * installed package and asserts that the eight disabled plus the three enabled account for ALL
 * of it. That catches a typo, and it also catches an eve upgrade that adds a twelfth default
 * tool — which would otherwise arrive silently enabled (task_cancel, on 0.60.1, until it got
 * a sentinel of its own).
 *
 * THE 0.60.1 SOURCE OF TRUTH CHANGED TOO. `getAllFrameworkToolNames()` — what this file read
 * before — no longer exists anywhere in the installed package; `dist/src/runtime/framework-tools/`
 * is gone. There is no public replacement, and reading `dist/src/tools/framework/` +
 * `dist/src/tools/provided/` by directory listing (the obvious next guess) is now WRONG: that
 * directory holds every tool eve SHIPS, default or not — `glob`/`grep` live right next to
 * `bash`/`web_search`, and only the latter are still framework-DEFAULTS a disableTool() sentinel
 * can shadow. The one place that draws that exact line is `dist/src/framework/sources/
 * registry.js` — the literal module the COMPILER itself reads to build the framework-default
 * candidate set (`eve:defaults`/`eve:root-defaults`). The last test reads that module through
 * `installedFrameworkDefaultTools()` (packages/agent-kit/src/framework-default-tools.ts, shared
 * with chief-of-staff), verified against a real `eve build`'s compiled manifest for all three
 * roles (bash, read_file, write_file, todo, web_fetch, load_skill, connection_search,
 * ask_question, task_cancel, web_search, agent — 11 names, glob/grep correctly absent). This
 * file used to pattern-match the module's text; the shared reader imports its exported
 * `frameworkAgentSourceRegistry` object instead — the data the compiler itself uses — because a
 * text pattern can silently miss an entry it did not anticipate. No public API exists to ask
 * this question, so it is still a deep import, and it throws if eve moves or reshapes it.
 *
 * ONE THING THIS FILE CANNOT SEE, and it is a real hole rather than a nitpick.
 * `connection_search` IS one of registry.js's `eve:defaults` entries (so it is not invisible to
 * `installedFrameworkDefaultTools()` the way it was to the old `getAllFrameworkToolNames()`), but it is also
 * eve's one REQUIRED framework tool (`compiler/default-tool-policy.js`'s
 * `REQUIRED_FRAMEWORK_TOOL_SLOTS`) — a disableTool() sentinel for it fails the build with its own
 * dedicated error, so it can never appear as a disabled sentinel here regardless. It is absent
 * from the creative agent's compiled tool list today only because it declares no eve connections
 * (`connections: []`), not because anything here turns it off.
 */
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isDisabledToolSentinel } from "eve/tools";
// By relative path: the kit's package exports name runtime modules, and this one is test
// support only (the same way services/box's tests reach kit sources).
import {
  frameworkToolDecisionProblems,
  installedFrameworkDefaultTools,
} from "../../../packages/agent-kit/src/framework-default-tools.js";

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
  // lower-precedence source") — both sentinel files were retired. `defaultTools: false` was
  // considered and NOT added: on this build it silently drops ask_question, todo and
  // load_skill too (no sentinel authors those slots, so eve stops granting them once its
  // optional defaults are off), which would have violated the safety bar — see
  // packages/board-evals/snapshots/tools-creative.txt, where all three are baselined.
  // task_cancel is new in eve 0.60.1: a new framework tool from a version bump is an
  // owner decision, not a side effect, so it is disabled the same as its `agent` neighbour.
  task_cancel: () => import("../agent/tools/task_cancel.js"),
};

// Left enabled, and each for its own reason — none of the three can read a file, run a
// command, or reach the network, so none of them widens the surface the eight above close:
//
//   ask_question — a real park-and-wait primitive. The persona tells the agent to run the studio on
//                  a terse brief with a stated assumption rather than interrogating first,
//                  but it also says to ask BEFORE running when a brief is truly unparseable.
//                  This is the tool for that one case.
//   todo — durable per-session bookkeeping in app state. Harmless, and the harness
//                  re-injects it across compaction, so removing it would cost context on long
//                  sessions for no gain.
//   load_skill — pulls a declared skill's instructions into the turn. It adds NO execution
//                  surface (behaviour still comes from the tools the agent already has). Creative
//                  authors a narrow wrapper so its dynamic public-docs skill works without a
//                  filesystem sandbox; the wrapper preserves Eve's loader for other native skills.
//
// `connection_search` is neither disabled nor a free choice to enable: it is eve's one REQUIRED
// framework tool (`compiler/default-tool-policy.js`'s `REQUIRED_FRAMEWORK_TOOL_SLOTS`) — a
// disableTool() sentinel for it fails `eve build` with its own dedicated error, so it can never
// join DISABLED. It is a real `eve:defaults` registration (`installedFrameworkDefaultTools()`
// sees it, unlike the old `getAllFrameworkToolNames()` this file used before eve 0.60.1 — see
// this file's header), so the accepted list must name it explicitly or the last test goes red
// on every run. Harmless for the creative agent today because it contributes no dynamic tool
// without a declared eve connection (`connections: []`).
//
// The accepted list: every built-in framework tool that is NOT switched off, each with its
// one-line reason (the paragraphs above are the long form). Together with the sentinels this
// has to account for every default tool the INSTALLED eve provides — see the last test. Adding
// a name here is an owner decision, not a way to get green.
const ACCEPTED: Record<string, string> = {
  ask_question: "asks the owner a question and waits for the answer; reads no file, runs no command, reaches no network",
  todo: "a task list kept for the session; reads no file, runs no command, reaches no network",
  load_skill: "this slot holds the service's own agent/tools/load_skill.ts, which only loads the skills the agent declares",
  connection_search: "eve's one required tool — it refuses a disableTool() sentinel for it; adds nothing while the agent declares no eve connection",
};

const TOOLS_DIR = join(import.meta.dirname, "..", "agent", "tools");

function toolFileSlugs(): string[] {
  return readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.replace(/\.ts$/, ""));
}

/** The tools actually switched off: every `agent/tools/*.ts` whose default export is a sentinel. */
async function sentinelSlugs(): Promise<string[]> {
  const disabled: string[] = [];
  for (const file of readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".ts"))) {
    const mod = await import(join(TOOLS_DIR, file));
    if (isDisabledToolSentinel(mod.default)) disabled.push(file.replace(/\.ts$/, ""));
  }
  return disabled.sort();
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
    expect(await sentinelSlugs()).toEqual(Object.keys(DISABLED).sort());
  });

  it("keeps ask_question and todo on framework defaults and guards the authored load_skill", async () => {
    const slugs = toolFileSlugs();
    for (const keep of ["ask_question", "todo"]) {
      expect(slugs, `${keep}.ts must NOT exist — its presence would remove a tool the agent uses`)
        .not.toContain(keep);
    }
    expect(slugs).toContain("load_skill");
    const authored = (await import("../agent/tools/load_skill.js")).default;
    expect(isDisabledToolSentinel(authored)).toBe(false);
    expect(authored.events).toHaveProperty("session.started");
  });

  it("accounts for every built-in tool the installed framework provides — a new one is an owner decision", async () => {
    // Reads eve's own default tool list out of the INSTALLED package and compares it with what
    // this service has decided. The comparison reports three things, and any one fails here:
    //
    //   - a framework tool that is neither switched off by a sentinel nor named in ACCEPTED.
    //     If an eve upgrade adds another default tool, this goes red, forcing a decision
    //     instead of handing the creative agent a capability nobody chose to give it
    //     (task_cancel was exactly this, on 0.60.1, until it got a sentinel of its own);
    //   - a sentinel for a name the framework does not provide. `eve build` fails the same way
    //     on 0.60.1 (see this file's header), but this is the fast one, and it still catches a
    //     name that used to be a real framework tool and stopped being one (glob, grep: gone
    //     since they left the default set at 0.39.0, which is exactly why their sentinel files
    //     had to be retired rather than left in place);
    //   - an ACCEPTED name the framework no longer provides, so the list cannot go stale.
    //
    // The comparison is proven able to fail in
    // packages/agent-kit/tests/framework-default-tools.test.ts.
    const problems = frameworkToolDecisionProblems({
      frameworkTools: await installedFrameworkDefaultTools(import.meta.url),
      disabled: await sentinelSlugs(),
      accepted: ACCEPTED,
    });
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("would fail if the framework shipped one more built-in tool than this file knows about", () => {
    // The check above has only ever been seen green on the installed eve. This feeds the same
    // comparison this service's real decisions plus one made-up tool, to show it goes red.
    const problems = frameworkToolDecisionProblems({
      frameworkTools: [...Object.keys(DISABLED), ...Object.keys(ACCEPTED), "made_up_file_editor"],
      disabled: Object.keys(DISABLED),
      accepted: ACCEPTED,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"made_up_file_editor"');
    expect(problems[0]).toContain("A new framework tool is an owner decision");
  });
});
