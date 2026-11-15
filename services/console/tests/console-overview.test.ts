import { beforeEach, describe, expect, it, vi } from "vitest";
const { query, list } = vi.hoisted(() => ({ query: vi.fn(), list: vi.fn() }));
vi.mock("../lib/db", () => ({ pool: { query } }));
vi.mock("../lib/agents", () => ({ listAgents: list, listSavedAgentsNotStarted: async () => [] }));
import { getFleetSnapshot, getPermissionEvents } from "../lib/console-overview";
import { workflowState } from "../lib/workflow-state";
beforeEach(() => vi.resetAllMocks());
describe("console source coverage", () => {
  it("keeps registry failure distinct from an empty fleet", async () => {
    list.mockRejectedValue(new Error("db offline"));
    query.mockResolvedValue({ rows: [] });
    expect((await getFleetSnapshot()).agents).toEqual({ available: false });
    list.mockResolvedValue([]);
    expect((await getFleetSnapshot()).agents).toEqual({
      available: true,
      value: [],
    });
  });
  it("does not report idle when the workflow source failed", async () => {
    list.mockResolvedValue([{ name: "agent-one" }]);
    query.mockRejectedValue(new Error("missing table"));
    expect(workflowState(await getFleetSnapshot(), "agent-one")).toBe("unavailable");
  });
  it("scopes work to its agent without translating waiting into approval", () => {
    const snapshot = {
      agents: { available: true as const, value: [] },
      workflows: {
        available: true as const,
        value: [
          { agent: "other", status: "failed", n: 2 },
          { agent: "agent-one", status: "waiting", n: 1 },
        ],
      },
    };
    expect(workflowState(snapshot, "agent-one")).toBe("waiting");
    expect(workflowState(snapshot, "empty")).toBe("idle");
  });
  /** The table as it would hold it, counted the way the reader's SQL asks (type filter included). */
  function workflowTable(table: { agent: string; type: string; status: string }[]) {
    list.mockResolvedValue([{ name: "agent-one" }, { name: "agent-two" }]);
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const excluded = /workflow_type <> \$1/.test(sql) ? params[0] : undefined;
      const counts = new Map<string, { agent: string; status: string; n: string }>();
      for (const r of table.filter((r) => r.type !== excluded)) {
        const key = `${r.agent}/${r.status}`;
        const c = counts.get(key) ?? { agent: r.agent, status: r.status, n: "0" };
        c.n = String(Number(c.n) + 1);
        counts.set(key, c);
      }
      return { rows: [...counts.values()] };
    });
  }
  it("a test brief that was not sent (kept as failed) leaves the agent idle", async () => {
    const { TEST_BRIEF_WORKFLOW_TYPE } = await import("@lares/agent-kit/delivery");
    workflowTable([
      { agent: "agent-one", type: TEST_BRIEF_WORKFLOW_TYPE, status: "failed" },
      { agent: "agent-two", type: "some-workflow", status: "failed" },
    ]);
    const snapshot = await getFleetSnapshot();
    expect(workflowState(snapshot, "agent-one")).toBe("idle");
    expect(workflowState(snapshot, "agent-two")).toBe("failed"); // other work still shows
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/WHERE workflow_type <> \$1/), [TEST_BRIEF_WORKFLOW_TYPE]);
  });
  it("a test brief nobody picked up (stale, still pending) leaves the agent idle", async () => {
    const { TEST_BRIEF_WORKFLOW_TYPE } = await import("@lares/agent-kit/delivery");
    workflowTable([
      { agent: "agent-one", type: TEST_BRIEF_WORKFLOW_TYPE, status: "pending" },
      { agent: "agent-two", type: "some-workflow", status: "pending" },
    ]);
    const snapshot = await getFleetSnapshot();
    expect(workflowState(snapshot, "agent-one")).toBe("idle");
    expect(workflowState(snapshot, "agent-two")).toBe("running");
  });
  it("filters in SQL before limiting, with a stable older-page cursor", async () => {
    query.mockResolvedValue({
      rows: [
        {
          id: "7",
          agent: "agent-one",
          tool: "mail.send",
          decision: "asked",
          capability: "mail",
          at: "2026-09-25T10:00:00Z",
        },
        { id: "6", agent: "agent-one", at: "2026-09-25T10:00:00Z" },
      ],
    });
    const result = await getPermissionEvents({
      agent: "agent-one",
      before: "10",
      limit: 1,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(
        /WHERE[\s\S]+agent=\$1[\s\S]+ORDER BY id DESC LIMIT \$3/,
      ),
      ["agent-one", "10", 2],
    );
    expect(result).toMatchObject({
      available: true,
      value: { rows: [{ id: "7" }], next: "7" },
    });
  });
  it("rejects malformed cursors and bounds the page size", async () => {
    query.mockResolvedValue({ rows: [] });
    await getPermissionEvents({
      before: "1;drop table approval_events",
      limit: 900,
    });
    expect(query.mock.calls[0][1]).toEqual([null, null, 101]);
  });
  it("shows unavailable for failed history, never a fabricated empty history", async () => {
    query.mockRejectedValue(new Error("offline"));
    expect(await getPermissionEvents()).toEqual({ available: false });
  });
});
