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

/**
 * eve ships a default harness of 11 framework tools that an agent gets WITHOUT declaring
 * anything — including `bash`, `write_file` and unrestricted file reads, none of which
 * require approval, and none of which are sandboxed here (`sandbox: null`). eve's own docs
 * say to review them before production use.
 *
 * The standing constraint is "reads only", so these five are removed outright.
 * Discovered live: chief-of-staff answered a DM by correctly listing shell, file
 * search and web among its capabilities.
 */
// Static importers, not a template-literal `import()`: Vite cannot resolve a fully dynamic
// specifier, and a test that cannot import the thing it guards guards nothing.
const DISABLED: Record<string, () => Promise<{ default: unknown }>> = {
  bash: () => import("../agent/tools/bash.js"),
  write_file: () => import("../agent/tools/write_file.js"),
  web_fetch: () => import("../agent/tools/web_fetch.js"),
  web_search: () => import("../agent/tools/web_search.js"),
  agent: () => import("../agent/tools/agent.js"),
  // Fenced behind a path allowlist first, then removed: the
  // authored vault note tools cover note work, and these three could not work here anyway
  // — they proxy into a sandbox needing a writable .eve/sandbox-cache that a read-only
  // rootfs will not give it. Four framework tools remain: ask_question, todo, load_skill
  // and the harness's own bookkeeping.
  read_file: () => import("../agent/tools/read_file.js"),
  // glob and grep left eve's default tool set at 0.39.0, and 0.60.1 fails the build outright
  // on a disableTool() sentinel for a slot nothing provides ("disables a slot with no
  // lower-precedence source") — both sentinel files were retired. `defaultTools: false` was
  // considered and NOT added: on this build it silently drops ask_question, todo and
  // load_skill too (no sentinel authors those slots, so eve stops granting them once its
  // optional defaults are off), which would have violated the safety bar — see
  // packages/board-evals/snapshots/tools-chief-of-staff.txt, where all three are baselined.
  // task_cancel is new in eve 0.60.1: a new framework tool from a version bump is an
  // owner decision, not a side effect, so it is disabled the same as its `agent` neighbour.
  task_cancel: () => import("../agent/tools/task_cancel.js"),
};

/**
 * Built-in framework tools that are NOT switched off, each left in place on purpose. Together
 * with the sentinels above this has to account for every default tool the INSTALLED eve
 * provides — the last test in this file reads that list from the package and fails on any
 * tool found in neither. Adding a name here is an owner decision, not a way to get green.
 */
const ACCEPTED: Record<string, string> = {
  ask_question: "asks the owner a question and waits for the answer; reads no file, runs no command, reaches no network",
  todo: "a task list kept for the session; reads no file, runs no command, reaches no network",
  load_skill: "this slot holds the service's own agent/tools/load_skill.ts, which only loads the skills the agent declares",
  connection_search:
    "present before this check existed; owner to decide — eve refuses a disableTool() sentinel for this one, and it is not in the model-visible tool baseline",
};

const TOOLS_DIR = join(import.meta.dirname, "..", "agent", "tools");

/** The tools actually switched off: every `agent/tools/*.ts` whose default export is a sentinel. */
async function sentinelSlugs(): Promise<string[]> {
  const disabled: string[] = [];
  for (const file of readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".ts"))) {
    const mod = await import(join(TOOLS_DIR, file));
    if (isDisabledToolSentinel(mod.default)) disabled.push(file.replace(/\.ts$/, ""));
  }
  return disabled.sort();
}

// person_lookup.ts has a module graph (lib/person-sources.ts →
// googleapis, pg) is heavier than any other single tool
// file here — importing EVERY agent/tools/*.ts in one loop can exceed vitest's default
// 5000ms on a cold run. The assertion itself is unchanged; only the budget for compiling
// and loading the full tool directory grew.
const TOOLS_DIR_SCAN_BUDGET_MS = 15_000;

describe("tool harness lockdown", () => {
  for (const [slug, load] of Object.entries(DISABLED)) {
    it(`disables the built-in \`${slug}\` tool`, async () => {
      expect(isDisabledToolSentinel((await load()).default)).toBe(true);
    });
  }

  it(
    "disables exactly the intended set — no more, no less",
    async () => {
      // Guards both directions: a sixth disable file added without thought shows up here,
      // and so does one of these five being quietly deleted. eve resolves these by FILENAME,
      // so a typo would remove nothing (it fails the build) or the wrong tool.
      expect(await sentinelSlugs()).toEqual(Object.keys(DISABLED).sort());
    },
    TOOLS_DIR_SCAN_BUDGET_MS,
  );

  it(
    "accounts for every built-in tool the installed framework provides — a new one is an owner decision",
    async () => {
      // The other tests here only confirm that the tools already switched off stay off. This
      // one looks the other way: it reads eve's own default tool list out of the INSTALLED
      // package and fails on any tool that is neither switched off by a sentinel nor named in
      // ACCEPTED. An eve upgrade that adds a default tool therefore goes red here instead of
      // handing the agent a capability nobody chose to give it. The comparison is proven able
      // to fail in packages/agent-kit/tests/framework-default-tools.test.ts.
      const problems = frameworkToolDecisionProblems({
        frameworkTools: await installedFrameworkDefaultTools(import.meta.url),
        disabled: await sentinelSlugs(),
        accepted: ACCEPTED,
      });
      expect(problems, problems.join("\n")).toEqual([]);
    },
    TOOLS_DIR_SCAN_BUDGET_MS,
  );

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

  // The `atlas_search`/`atlas_read` entries this list used to name are gone — one set of
  // note tools takes an area now, and the two catalogue files below are that set's own copies.
  //
  // vault_search/vault_read/vault_backlinks moved out: they're mounted
  // from the @lares/agent-kit eve extension now (agent-kit__vault_*), so they no longer live
  // under agent/tools/ for this file's directory scan or its import-by-relative-path checks
  // to find. They were never at risk of the isDisabledToolSentinel check this block runs —
  // that sentinel exists only for eve's BUILT-IN framework tools an authored file overrides
  // (see the DISABLED map above); an authored `defineTool()` call, mounted or not, is never
  // a disable sentinel. Live-mount resolution under the new prefixed name is verified
  // against a running eve instance instead (see task-2-report.md).

  /**
   * The authored read tools are what the agent actually reads with. Listed explicitly so that
   * deleting one shows up here rather than as a quietly less capable agent.
   */
  const AUTHORED: Record<string, () => Promise<{ default: unknown }>> = {
    "agent-kit__vault_search": () => import("../catalogue/agent-kit__vault_search.js"),
    "agent-kit__vault_read": () => import("../catalogue/agent-kit__vault_read.js"),
    echo_note: () => import("../catalogue/echo_note.js"),
  };

  for (const [slug, load] of Object.entries(AUTHORED)) {
    it(`keeps the authored \`${slug}\` tool enabled`, async () => {
      expect(isDisabledToolSentinel((await load()).default)).toBe(false);
    });
  }
});
