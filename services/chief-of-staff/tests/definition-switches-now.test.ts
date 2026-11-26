// A conversation keeps the definition it started on, but the owner's "run without asking" switches for outside
// tools reach it at the next step: they are read fresh, and only when the folder still holds the same definition.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { loadDefinition } from "@lares/agent-kit/definition";
import { isDangerRun } from "@lares/agent-kit/outside-tools";

import neutral from "../agent.json";
import { withSwitchesNow } from "../lib/definition.js";

const pin = "a".repeat(64);
const tools = (danger: boolean) => ({ allow: ["lookup", "create_note"], read: ["lookup"],
  ...(danger ? { danger: [{ tool: "create_note", pin, by: "member-a", at: "2026-11-20T10:00:00.000Z" }] } : {}) });
const agent = (danger: boolean, description = "Looks up companies by name.") => ({ ...neutral,
  outsideTools: [{ name: "registry", url: "https://tools.example.org/mcp", description, token: false, tools: tools(danger) }] });
let dir: string | undefined;
function mount(agentJson: unknown): void {
  dir ??= mkdtempSync(join(tmpdir(), "switches-now-"));
  writeFileSync(join(dir, "agent.json"), typeof agentJson === "string" ? agentJson : JSON.stringify(agentJson));
  writeFileSync(join(dir, "voice.md"), "Plain and brief.\n");
  writeFileSync(join(dir, "duties.md"), "");
  vi.stubEnv("LARES_DEFINITION_DIR", dir);
}
const started = () => loadDefinition({ serviceDir: process.cwd() });
const runsFree = async (loaded: Awaited<ReturnType<typeof started>>) => isDangerRun((await withSwitchesNow(loaded)).outsideTools![0]!, "create_note", pin);
afterEach(() => { vi.unstubAllEnvs(); if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

it("a switch flipped while the conversation is open is seen at its next step, both ways", async () => {
  mount(agent(false));
  const off = await started();
  expect(await runsFree(off)).toBe(false);
  mount(agent(true));
  expect(await runsFree(off)).toBe(true);
  const on = await started();
  mount(agent(false));
  expect(await runsFree(on)).toBe(false);
});

it("keeps what the conversation started on when the folder holds a different definition, or cannot be read", async () => {
  mount(agent(true));
  const on = await started();
  mount(agent(false, "Edited since."));
  expect(await runsFree(on)).toBe(true);
  expect((await withSwitchesNow(on)).outsideTools![0]!.description).toBe("Looks up companies by name.");
  mount("{ not json");
  expect(await runsFree(on)).toBe(true);
});

it("keeps the last valid switches when a hand edit breaks their rules", async () => {
  mount(agent(false));
  const off = await started();
  const grant = { tool: "lookup", pin, by: "member-a", at: "2026-11-20T10:00:00.000Z" };
  // A lookup put in the danger zone, and the same tool listed twice: both are refused by the definition check.
  for (const danger of [[grant], [{ ...grant, tool: "create_note" }, { ...grant, tool: "create_note" }]]) {
    mount({ ...neutral, outsideTools: [{ name: "registry", url: "https://tools.example.org/mcp", description: "Looks up companies by name.", token: false,
      tools: { allow: ["lookup", "create_note"], read: ["lookup"], danger } }] });
    expect((await withSwitchesNow(off)).outsideTools![0]!.tools.danger).toBeUndefined();
  }
});
