/**
 * The comparison behind every service's "no built-in tool arrives undecided" check, proven
 * able to fail — a check that has only ever been seen green proves nothing.
 *
 * The services' own tool-harness tests feed it their real decisions; this file feeds it
 * made-up ones, including a tool the framework does not (yet) ship.
 */
import { describe, it, expect } from "vitest";
import {
  defaultToolNamesFromRegistry,
  frameworkToolDecisionProblems,
  installedFrameworkDefaultTools,
} from "../src/framework-default-tools.js";

const decided = {
  frameworkTools: ["ask_question", "bash", "write_file"],
  disabled: ["bash", "write_file"],
  accepted: { ask_question: "asks the owner a question and waits" },
};

describe("frameworkToolDecisionProblems", () => {
  it("is silent when every framework tool is switched off or accepted", () => {
    expect(frameworkToolDecisionProblems(decided)).toEqual([]);
  });

  it("fails on a made-up extra framework tool, naming it and saying it is an owner decision", () => {
    const problems = frameworkToolDecisionProblems({
      ...decided,
      frameworkTools: [...decided.frameworkTools, "made_up_file_editor"],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"made_up_file_editor"');
    expect(problems[0]).toContain("A new framework tool is an owner decision");
  });

  it("names every undecided tool, not just the first", () => {
    const problems = frameworkToolDecisionProblems({ ...decided, frameworkTools: [...decided.frameworkTools, "zeta", "alpha"] });
    expect(problems.map((p) => /"([a-z_]+)"/u.exec(p)?.[1])).toEqual(["alpha", "zeta"]);
  });

  it("fails when an accepted tool is no longer provided by the framework", () => {
    const problems = frameworkToolDecisionProblems({ ...decided, frameworkTools: ["bash", "write_file"] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"ask_question" is in the accepted list, but the installed framework no longer provides');
  });

  it("fails when a sentinel switches off a tool the framework does not provide", () => {
    const problems = frameworkToolDecisionProblems({ ...decided, disabled: [...decided.disabled, "bahs"] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("agent/tools/bahs.ts");
    expect(problems[0]).toContain("switches nothing off");
  });

  it("fails when a tool is both switched off and accepted", () => {
    const problems = frameworkToolDecisionProblems({ ...decided, accepted: { ...decided.accepted, bash: "contradiction" } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"bash" is both switched off');
  });

  it("fails when an accepted tool carries no reason", () => {
    const problems = frameworkToolDecisionProblems({ ...decided, accepted: { ask_question: "  " } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"ask_question" is in the accepted list without a reason');
  });
});

describe("frameworkToolDecisionProblems with defaultTools: false", () => {
  const frameworkTools = ["agent", "bash", "edit_file", "write_file"];
  const allOff = { frameworkTools, disabled: [], accepted: {}, defaultToolsOff: true, authored: ["catalogue", "public_doc"] };

  it("is silent when no file carries a framework tool's name: the definition switched every one off", () => {
    expect(frameworkToolDecisionProblems(allOff)).toEqual([]);
  });

  it("stays silent when the framework ships one more built-in tool: it cannot reach the agent", () => {
    expect(frameworkToolDecisionProblems({ ...allOff, frameworkTools: [...frameworkTools, "made_up_file_editor"] })).toEqual([]);
  });

  it("goes red the moment the definition no longer says defaultTools: false, naming every tool", () => {
    for (const defaultToolsOff of [false, undefined]) {
      const problems = frameworkToolDecisionProblems({ ...allOff, defaultToolsOff });
      expect(problems.map((p) => /"([a-z_]+)"/u.exec(p)?.[1])).toEqual(frameworkTools);
      expect(problems[0]).toContain("A new framework tool is an owner decision");
    }
  });

  it("fails on an authored file that takes a framework tool's name, because it keeps the slot", () => {
    const problems = frameworkToolDecisionProblems({ ...allOff, authored: [...allOff.authored, "bash"] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("agent/tools/bash.ts carries the name of the framework's built-in tool");
  });

  it("accepts such a file once it is named with a reason, and only then", () => {
    const kept = { ...allOff, authored: [...allOff.authored, "bash"] };
    expect(frameworkToolDecisionProblems({ ...kept, accepted: { bash: "the service's own narrow shell" } })).toEqual([]);
    expect(frameworkToolDecisionProblems({ ...kept, accepted: { bash: " " } })[0]).toContain("without a reason");
  });

  it("fails on an accepted tool the agent does not have", () => {
    const problems = frameworkToolDecisionProblems({ ...allOff, accepted: { edit_file: "left on" } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"edit_file" is in the accepted list, but defaultTools: false switches it off');
  });

  it("allows a sentinel beside defaultTools: false, and still fails one that matches nothing", () => {
    // Redundant, not wrong: the compiler keeps a default that an authored file shadows.
    expect(frameworkToolDecisionProblems({ ...allOff, disabled: ["bash"] })).toEqual([]);
    const problems = frameworkToolDecisionProblems({ ...allOff, disabled: ["task_cancel"] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("agent/tools/task_cancel.ts");
    expect(problems[0]).toContain("switches nothing off");
  });
});

describe("defaultToolNamesFromRegistry", () => {
  const registry = (...sources: string[][]) => ({
    registrations: sources.map((paths) => ({ source: { modules: paths.map((logicalPath) => ({ logicalPath })) } })),
  });

  it("collects tool slots from every registration and ignores non-tool modules", () => {
    const names = defaultToolNamesFromRegistry(
      registry(["agent.ts", "sandbox.ts", "tools/write_file.ts", "tools/bash.ts"], ["tools/agent.ts", "channels/home.ts"]),
    );
    expect(names).toEqual(["agent", "bash", "write_file"]);
  });

  it("reads a folder-form slot and a name the old text pattern would have missed", () => {
    expect(defaultToolNamesFromRegistry(registry(["tools/edit-file2/index.ts"]))).toEqual(["edit-file2"]);
  });

  it.each([
    ["no registrations list", {}],
    ["a registration without modules", { registrations: [{ source: {} }] }],
    ["a module without a logical path", { registrations: [{ source: { modules: [{}] } }] }],
    ["a nested tool path", { registrations: [{ source: { modules: [{ logicalPath: "tools/a/b.ts" }] } }] }],
    ["no tool at all", { registrations: [{ source: { modules: [{ logicalPath: "agent.ts" }] } }] }],
  ])("throws rather than return a partial list: %s", (_label, shape) => {
    expect(() => defaultToolNamesFromRegistry(shape, "made-up registry")).toThrow(/Cannot read the framework's default tools from made-up registry/u);
  });
});

describe("installedFrameworkDefaultTools", () => {
  it("reads a real list out of the installed framework package", async () => {
    const names = await installedFrameworkDefaultTools(import.meta.url);
    // Deliberately NOT the full list: a copied list cannot notice an upgrade, and the services'
    // tests are where a change in this list has to be decided. Two anchors are enough to show
    // the reader found the real registry rather than something tool-shaped.
    expect(names).toContain("bash");
    expect(names).toContain("write_file");
    // eve 1.0 also edits files through this one; switching `write_file` off no longer stops it.
    expect(names).toContain("edit_file");
    expect(names).toEqual([...new Set(names)].sort());
  });
});
