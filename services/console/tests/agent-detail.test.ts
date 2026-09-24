import { describe, it, expect, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../lib/db", () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }));
vi.mock("../lib/agents", () => ({
  listAgents: async () => [{
    name: "helper", displayName: "Helper", role: "assistant", skills: [], doors: [], startedAt: "2026-10-01T06:00:00Z",
    grants: [{ capability: "gmail", scope: "write-with-confirm" }, { capability: "orakel", scope: "read" }, { capability: "twenty", scope: "none" }],
    autonomy: { gmail: "gated" },
    tools: null,
  }],
}));

import { getAgentDetail, resolveActionLevel } from "../lib/agent-detail";

describe("resolveActionLevel", () => {
  const rows = [
    { capability: "gmail", action: "", level: "autonomous" as const },
    { capability: "gmail", action: "send", level: "never" as const },
  ];
  it("action override wins; else capability default; else gated", () => {
    expect(resolveActionLevel(rows, "gmail", "send")).toEqual({ level: "never", overridden: true });
    expect(resolveActionLevel(rows, "gmail", "poll")).toEqual({ level: "autonomous", overridden: false });
    expect(resolveActionLevel(rows, "orakel", "x")).toEqual({ level: "gated", overridden: false });
  });
});

// Final review F5: the approval check reads only the capability-wide row (action = ''), so the page
// offers no per-action switches — they were saved and then ignored.
describe("getAgentDetail", () => {
  it("offers one capability-wide level per granted integration, and no per-action switches", async () => {
    queryMock.mockResolvedValue({ rows: [
      { capability: "gmail", action: "", level: "autonomous" },
      { capability: "gmail", action: "send", level: "never" },
    ] });
    const detail = await getAgentDetail("helper");
    expect(detail.capabilities).toEqual([
      { name: "gmail", scope: "write-with-confirm", defaultLevel: "autonomous" },
      { name: "orakel", scope: "read", defaultLevel: "gated" },
    ]);
  });
});
