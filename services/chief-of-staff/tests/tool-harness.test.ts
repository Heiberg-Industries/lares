import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isDisabledToolSentinel } from "eve/tools";

/**
 * eve ships a default harness of 11 framework tools that an agent gets WITHOUT declaring
 * anything — including `bash`, `write_file` and unrestricted file reads, none of which
 * require approval, and none of which are sandboxed here (`sandbox: null`). eve's own docs
 * say to review them before production use.
 *
 * The shadow's standing constraint is "reads only", so these five are removed outright.
 * Discovered live on 2026-08-13: eve-saga answered a DM by correctly listing shell, file
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
  // Added 2026-08-13. Fenced behind a path allowlist first (ORB-52), then removed: the
  // authored Brain/Atlas hands cover note work, and these three could not work here anyway
  // — they proxy into a sandbox needing a writable .eve/sandbox-cache that a read-only
  // rootfs will not give it. Four framework tools remain: ask_question, todo, load_skill
  // and the harness's own bookkeeping.
  read_file: () => import("../agent/tools/read_file.js"),
  // glob and grep left eve's default tool set at 0.39.0, and 0.60.1 fails the build outright
  // on a disableTool() sentinel for a slot nothing provides ("disables a slot with no
  // lower-precedence source") — W2-s8 retired both sentinel files. `defaultTools: false` was
  // considered and NOT added: on this build it silently drops ask_question, todo and
  // load_skill too (no sentinel authors those slots, so eve stops granting them once its
  // optional defaults are off), which would have violated the wave's safety bar — see
  // packages/board-evals/snapshots/tools-chief-of-staff.txt, where all three are baselined.
  // task_cancel is new in eve 0.60.1 (W2-s8b): a new framework tool from a version bump is an
  // owner decision, not a side effect, so it is disabled the same as its `agent` neighbour.
  task_cancel: () => import("../agent/tools/task_cancel.js"),
};

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
      const dir = join(import.meta.dirname, "..", "agent", "tools");
      const disabled: string[] = [];
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
        const mod = await import(join(dir, file));
        if (isDisabledToolSentinel(mod.default)) disabled.push(file.replace(/\.ts$/, ""));
      }
      expect(disabled.sort()).toEqual(Object.keys(DISABLED).sort());
    },
    // Task 8 added person_lookup.ts, whose module graph (lib/person-sources.ts →
    // @lares/network, googleapis, pg, better-sqlite3) is heavier than any other single tool
    // file here — importing EVERY agent/tools/*.ts in one loop can exceed vitest's default
    // 5000ms on a cold run. The assertion itself is unchanged; only the budget for compiling
    // and loading the full tool directory grew.
    15_000,
  );

  // W5C-s3: the `atlas_search`/`atlas_read` entries this list used to name are gone — one set of
  // note tools takes an area now, and the two catalogue files below are that set's own copies.
  //
  // vault_search/vault_read/vault_backlinks moved out under ORB-143 Task 2: they're mounted
  // from the @lares/agent-kit eve extension now (agent-kit__vault_*), so they no longer live
  // under agent/tools/ for this file's directory scan or its import-by-relative-path checks
  // to find. They were never at risk of the isDisabledToolSentinel check this block runs —
  // that sentinel exists only for eve's BUILT-IN framework tools an authored file overrides
  // (see the DISABLED map above); an authored `defineTool()` call, mounted or not, is never
  // a disable sentinel. Live-mount resolution under the new prefixed name is verified
  // against a running eve instance instead (see task-2-report.md).

  /**
   * The authored hands are what she actually reads with. Listed explicitly so that
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
