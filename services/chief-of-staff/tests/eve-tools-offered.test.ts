/**
 * The `eve__…` tools a conversation is really offered, held to a list.
 *
 * eve 1.0 adds tools of its own to a conversation, in the reserved `eve__` namespace. They have
 * no file under agent/tools/ and no switch: `defaultTools: false` does not remove them, a
 * `disableTool()` file cannot name them (the compiler rejects a name starting `eve__`), and
 * tests/tool-harness.test.ts, which reads files, cannot see them
 * (node_modules/eve/docs/concepts/built-in-tools.md, "Reserved `eve` names"):
 *
 *  - `eve__skill` comes with any skill the conversation has;
 *  - `eve__search` and `eve__tool` come with any connection or deferred tool it has;
 *  - `eve__task_wait` and `eve__task_cancel` come with any tool that runs as a task (the
 *    built-in `agent` tool, a subagent, a workflow tool);
 *  - `eve__reply` comes with an output schema.
 *
 * A new one is a new capability nobody chose to give the agent. So the only honest check is
 * what the MODEL is offered: the `tools` array of a model request the agent really sent, for a
 * conversation that really started, on each door.
 *
 * WHY THE CONVERSATION CASES BELOW DO NOT RUN YET. eve has no in-process way to start a
 * conversation: an eval target is the URL of a running agent server
 * (node_modules/eve/docs/evals/targets.mdx), and `mockModel` is part of a built agent's
 * definition. A running agent needs `eve build` (or `eve dev`) and a Postgres workflow world.
 * Until the upgrade branch builds, neither exists, so those cases are skipped unless a capture
 * is supplied, and nothing here is derived from reading the agent's files instead.
 *
 * WHAT A CAPTURE IS. Run the built agent with its model gateway (`GATEWAY_URL`) pointed at a
 * recorder, send one message through each door, and save the JSON body of a model request it
 * sent as `<door>.json` in a directory. Set `LARES_EVE_TOOLS_CAPTURE_DIR` to that directory and
 * the cases below run against it. Both gateway lanes are read (`offeredToolNames`).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Door = "slack" | "telegram" | "web" | "console";

/**
 * The `eve__` tools each door may be offered, and why. Everything else in that namespace fails.
 *
 * TO CONFIRM AFTER THE SKILLS AND APPROVALS PACKETS MERGE: these entries are what the code on
 * the upgrade branch implies today, before skills move onto eve 1.0's own skill loading and
 * before the outside-tools connection is ported. No built agent has shown them yet.
 */
const ALLOWED: Record<Door, Record<string, string>> = {
  slack: {
    eve__skill: "the agent declares skills (signals, sales-outreach, lares-docs); eve__skill is how eve 1.0 loads one",
    eve__search: "the outside-tools connection: eve__search finds a connected outside tool. Absent when the definition connects none",
    eve__tool: "the outside-tools connection: eve__tool calls a connected outside tool, behind its approval. Absent when the definition connects none",
  },
  telegram: {
    eve__skill: "the agent declares skills (signals, sales-outreach, lares-docs); eve__skill is how eve 1.0 loads one",
    eve__search: "the outside-tools connection: eve__search finds a connected outside tool. Absent when the definition connects none",
    eve__tool: "the outside-tools connection: eve__tool calls a connected outside tool, behind its approval. Absent when the definition connects none",
  },
  web: {
    eve__skill: "the agent declares skills (signals, sales-outreach, lares-docs); eve__skill is how eve 1.0 loads one",
    eve__search: "the outside-tools connection: eve__search finds a connected outside tool. Absent when the definition connects none",
    eve__tool: "the outside-tools connection: eve__tool calls a connected outside tool, behind its approval. Absent when the definition connects none",
  },
  // A private console conversation is the bounded surface: one skill, no outside tools.
  console: {
    eve__skill: "the lares-docs skill, the only one a private conversation has",
  },
};

/** Never, on any door: what each would mean is in the reason. */
const NEVER: Record<string, string> = {
  eve__task_wait: "the agent has a tool that runs as a task: the delegating `agent` tool, a subagent or a workflow tool",
  eve__task_cancel: "the agent has a tool that runs as a task: the delegating `agent` tool, a subagent or a workflow tool",
  eve__reply: "the conversation was given an output schema; no door asks for a structured reply",
};

/** Every `eve__` name in `offered` that `allowed` does not list. Other names are not its business. */
function unexpectedEveTools(offered: readonly string[], allowed: readonly string[]): string[] {
  return [...new Set(offered)].filter((name) => name.startsWith("eve__") && !allowed.includes(name)).sort();
}

/**
 * The tool names in one model request body, on either gateway lane: Anthropic Messages
 * (`tools: [{ name }]`) or OpenAI-compatible chat (`tools: [{ type: "function", function: { name } }]`).
 * Throws on a body it cannot read; an unreadable capture must not pass as "no eve tools".
 */
function offeredToolNames(requestBody: unknown): string[] {
  const tools = (requestBody as { tools?: unknown } | null)?.tools;
  if (tools === undefined) return []; // a request with no tools at all offers none
  if (!Array.isArray(tools)) throw new Error("The captured model request has a `tools` field that is not a list");
  return tools.map((tool, index) => {
    const name = (tool as { name?: unknown; function?: { name?: unknown } } | null)?.name
      ?? (tool as { function?: { name?: unknown } } | null)?.function?.name;
    if (typeof name !== "string" || name === "") throw new Error(`Tool ${index} of the captured model request has no name`);
    return name;
  });
}

describe("the eve__ allow list itself", () => {
  it("never allows a task tool or a structured reply on any door", () => {
    for (const [door, allowed] of Object.entries(ALLOWED)) {
      for (const never of Object.keys(NEVER)) expect(Object.keys(allowed), door).not.toContain(never);
      for (const [name, reason] of Object.entries(allowed)) {
        expect(name.startsWith("eve__"), `${door}: ${name}`).toBe(true);
        expect(reason.trim(), `${door}: ${name}`).not.toBe("");
      }
    }
  });

  it("a private console conversation is offered nothing that reaches an outside tool", () => {
    expect(Object.keys(ALLOWED.console)).toEqual(["eve__skill"]);
  });

  it("fails on any eve__ name that is not listed, and only on those", () => {
    const allowed = ["eve__skill"];
    expect(unexpectedEveTools(["echo_note", "eve__skill", "set_language"], allowed)).toEqual([]);
    expect(unexpectedEveTools(["eve__skill", "eve__made_up_tool", "eve__task_wait"], allowed)).toEqual(["eve__made_up_tool", "eve__task_wait"]);
    // An agent's own tool cannot take the namespace, and a look-alike is not in it.
    expect(unexpectedEveTools(["eve_skill", "my_eve__tool"], allowed)).toEqual([]);
    expect(unexpectedEveTools(["eve__search", "eve__search"], [])).toEqual(["eve__search"]);
  });

  it("reads the offered tool names off a model request on either gateway lane", () => {
    expect(offeredToolNames({ model: "m", tools: [{ name: "echo_note", input_schema: {} }, { name: "eve__skill", input_schema: {} }] }))
      .toEqual(["echo_note", "eve__skill"]);
    expect(offeredToolNames({ model: "m", tools: [{ type: "function", function: { name: "eve__tool", parameters: {} } }] })).toEqual(["eve__tool"]);
    expect(offeredToolNames({ model: "m", messages: [] })).toEqual([]);
    expect(() => offeredToolNames({ tools: "eve__skill" })).toThrow("not a list");
    expect(() => offeredToolNames({ tools: [{ description: "nameless" }] })).toThrow("has no name");
  });
});

const captureDir = process.env["LARES_EVE_TOOLS_CAPTURE_DIR"];

// NOT RUN without a capture: see this file's header. Needs a built, running agent, which the
// upgrade branch cannot produce yet.
describe.skipIf(!captureDir)("the eve__ tools a started conversation is really offered", () => {
  const DOORS: Record<Door, string> = {
    slack: "a Slack conversation",
    telegram: "a Telegram conversation",
    web: "an ordinary web chat",
    console: "a private console conversation",
  };

  for (const [door, what] of Object.entries(DOORS) as [Door, string][]) {
    it(`${what}: offers no eve__ tool that is not on the list, and never a task tool or eve__reply`, () => {
      const file = join(captureDir!, `${door}.json`);
      // A missing capture is a failure, not a pass: every door has to be shown.
      expect(existsSync(file), `no captured model request for the ${door} door at ${file}`).toBe(true);
      const offered = offeredToolNames(JSON.parse(readFileSync(file, "utf8")));
      // A conversation with no tools at all is not what any door produces; the capture is wrong.
      expect(offered.length, `the ${door} capture offers no tools at all`).toBeGreaterThan(0);
      expect(unexpectedEveTools(offered, Object.keys(ALLOWED[door]))).toEqual([]);
      for (const never of Object.keys(NEVER)) expect(offered, `${door}: ${NEVER[never]}`).not.toContain(never);
    });
  }
});
