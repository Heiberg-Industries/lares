import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ keeper: vi.fn(), agents: vi.fn() }));
vi.mock("../lib/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock("../lib/keeper-client", () => ({ keeper: mocks.keeper }));
vi.mock("../lib/agents", () => ({ listAgents: mocks.agents }));

import { loadConflictInputs } from "../lib/delivery-check";

const def = (schedules: Record<string, { on: boolean }>) =>
  ({ definition: JSON.stringify({ doors: [{ kind: "telegram", enabled: true }], schedules }) });

beforeEach(() => {
  mocks.keeper.mockReset();
  mocks.agents.mockReset();
});

describe("which agents the quiet-hours check looks at", () => {
  it("those whose definition runs an hour-based schedule - whatever their role is called", async () => {
    mocks.agents.mockResolvedValue([
      { name: "chief", role: "My right hand" },
      { name: "writer", role: "Chief of Staff" },
      { name: "idle", role: "Chief of Staff" },
    ]);
    mocks.keeper.mockImplementation(async (_a: string, input: { name: string }) =>
      input.name === "chief" ? def({ "morning-brief": { on: true } })
        : input.name === "writer" ? def({ reminders: { on: true } })
        : def({ "morning-brief": { on: false } }));
    const data = await loadConflictInputs("owner-1", "owner@owner.example");
    expect(data?.facts.map((f) => f.agent)).toEqual(["chief"]);
  });
});
