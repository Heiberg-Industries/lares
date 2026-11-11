import { describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
// By relative path: the kit's package exports name runtime modules, and this one is test
// support only (the same way services/box's tests reach kit sources).
import {
  frameworkToolDecisionProblems,
  installedFrameworkDefaultTools,
} from "../../../packages/agent-kit/src/framework-default-tools.js";

/**
 * eve hands every agent a set of built-in tools it never declared, none of which asks for
 * approval. eve's own docs say to review them before production use. The standing constraint
 * here is that the agent can do what Lares adds and nothing else, so NONE of them reaches it.
 *
 * HOW, SINCE EVE 1.0. `defaultTools: false` in agent/agent.ts. eve's compiler then drops every
 * framework default tool except a slot the author also has a file for
 * (node_modules/eve/dist/src/compiler/default-tool-policy.js, `applyDefaultToolPolicy`), and
 * nothing is exempt. The one-file-per-tool `disableTool()` sentinels this service used to carry
 * are gone: they were redundant under that setting, and `task_cancel.ts` had become a build
 * error, because eve 1.0 has no `task_cancel` slot for it to switch off ("disables a slot with
 * no lower-precedence source"). One sentinel per tool also could not have kept up: 1.0 added
 * `edit_file`, which edits files with `write_file` switched off.
 *
 * So what this file guards is the other direction: the definition really says
 * `defaultTools: false`, and no file under agent/tools/ carries a default tool's name, which is
 * the one thing that would keep such a tool.
 *
 * WHAT THIS FILE CANNOT SEE. The `eve__…` tools eve adds per conversation have no slot and no
 * switch; tests/eve-tools-offered.test.ts is where those are held to a list.
 */

// The definition as eve evaluates it, not a search of its source text. agent.ts's graph reaches
// `eve/context` (session state) only through the model resolver, which this file never calls.
vi.mock("eve/context", () => ({ defineState: () => ({ get: () => undefined, update: () => undefined }) }));
const agentDefinition = async () => (await import("../agent/agent.js")).default as { defaultTools?: unknown; tool?: unknown };

/**
 * Every default tool the installed eve 1.0 would hand this agent, and why none is wanted.
 * `defaultTools: false` already turns away a tool this list does not name; the list is here so
 * that a framework upgrade that changes the set is seen and decided by a person, not absorbed.
 */
const TURNED_AWAY: Record<string, string> = {
  agent: "root-only delegation to a fresh copy of itself; delegation here is an explicit grant, never an implicit framework tool",
  bash: "shell execution in the agent's sandbox; the agent has no use for a shell and no approval card in front of one",
  edit_file: "new in eve 1.0: edits files in the sandbox, and does so even with write_file off",
  read_file: "reads any path the sandbox can reach; this agent reads what it is handed in the conversation and through its granted tools",
  web_fetch: "fetches arbitrary URLs with no approval; this agent has no grant to reach the web",
  web_search: "provider-side web search with no approval and no record",
  write_file: "writes files in the sandbox; anything this agent writes goes through a granted tool, behind an approval card",
};

const TOOLS_DIR = join(import.meta.dirname, "..", "agent", "tools");
const toolFiles = () => readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".ts"));
// Classified from source, not by importing: a slot is its FILENAME, and that is all this needs.
const isSentinelFile = (file: string) => /export default disableTool\(\)/u.test(readFileSync(join(TOOLS_DIR, file), "utf8"));
const slug = (file: string) => file.replace(/\.ts$/u, "");

describe("tool harness lockdown", () => {
  it("the agent definition turns every framework default tool away", async () => {
    const agent = await agentDefinition();
    expect(agent.defaultTools).toBe(false);
    // ...and the delegating `agent` tool by name as well, so it stays off if the line above is
    // ever relaxed. With it off and no subagents, eve adds no task tools either.
    expect(agent.tool).toBe(false);
  });

  it("declares no subagent, so nothing here runs as a task", () => {
    expect(existsSync(join(TOOLS_DIR, "..", "subagents"))).toBe(false);
  });

  it("the list of tools turned away is exactly what the installed framework would have handed over", async () => {
    expect(await installedFrameworkDefaultTools(import.meta.url)).toEqual(Object.keys(TURNED_AWAY).sort());
    for (const [tool, reason] of Object.entries(TURNED_AWAY)) expect(reason.trim(), tool).not.toBe("");
  });

  it("no file under agent/tools/ carries a default tool's name, so not one of them is kept", async () => {
    const defaults = new Set(await installedFrameworkDefaultTools(import.meta.url));
    expect(toolFiles().map(slug).filter((name) => defaults.has(name))).toEqual([]);
  });

  it("carries no sentinel files: none is needed, and one for a slot eve does not have fails the build", () => {
    expect(toolFiles().filter(isSentinelFile)).toEqual([]);
    expect(existsSync(join(TOOLS_DIR, "task_cancel.ts"))).toBe(false);
  });

  it("accounts for every built-in tool the installed framework provides", async () => {
    // The comparison is proven able to fail in packages/agent-kit/tests/framework-default-tools.test.ts.
    const files = toolFiles();
    const problems = frameworkToolDecisionProblems({
      frameworkTools: await installedFrameworkDefaultTools(import.meta.url),
      disabled: files.filter(isSentinelFile).map(slug),
      accepted: {},
      defaultToolsOff: (await agentDefinition()).defaultTools === false,
      authored: files.filter((f) => !isSentinelFile(f)).map(slug),
    });
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("would fail, naming all seven, if the definition stopped saying defaultTools: false", async () => {
    // The check above has only been seen green. Same inputs, with the one setting withdrawn.
    const files = toolFiles();
    const problems = frameworkToolDecisionProblems({
      frameworkTools: await installedFrameworkDefaultTools(import.meta.url),
      disabled: files.filter(isSentinelFile).map(slug),
      accepted: {},
      defaultToolsOff: false,
      authored: files.filter((f) => !isSentinelFile(f)).map(slug),
    });
    expect(problems.map((p) => /"([a-z_]+)"/u.exec(p)?.[1])).toEqual(Object.keys(TURNED_AWAY).sort());
    expect(problems.join("\n")).toContain('"edit_file"');
  });

  it("would fail if a file under agent/tools/ took a default tool's name", async () => {
    const problems = frameworkToolDecisionProblems({
      frameworkTools: await installedFrameworkDefaultTools(import.meta.url),
      disabled: [],
      accepted: {},
      defaultToolsOff: true,
      authored: [...toolFiles().map(slug), "edit_file"],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("agent/tools/edit_file.ts carries the name of the framework's built-in tool");
  });

});
