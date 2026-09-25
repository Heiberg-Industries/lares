import { beforeEach, describe, expect, it, vi } from "vitest";
const { query, list } = vi.hoisted(() => ({ query: vi.fn(), list: vi.fn() }));
vi.mock("../lib/db", () => ({ pool: { query } }));
vi.mock("../lib/agents", () => ({ listAgents: list }));
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
    list.mockResolvedValue([{ name: "sage" }]);
    query.mockRejectedValue(new Error("missing table"));
    expect(workflowState(await getFleetSnapshot(), "sage")).toBe("unavailable");
  });
  it("scopes work to its agent without translating waiting into approval", () => {
    const snapshot = {
      agents: { available: true as const, value: [] },
      workflows: {
        available: true as const,
        value: [
          { agent: "other", status: "failed", n: 2 },
          { agent: "sage", status: "waiting", n: 1 },
        ],
      },
    };
    expect(workflowState(snapshot, "sage")).toBe("waiting");
    expect(workflowState(snapshot, "empty")).toBe("idle");
  });
  it("filters in SQL before limiting, with a stable older-page cursor", async () => {
    query.mockResolvedValue({
      rows: [
        {
          id: "7",
          agent: "sage",
          tool: "mail.send",
          decision: "asked",
          capability: "mail",
          at: "2026-09-25T10:00:00Z",
        },
        { id: "6", agent: "sage", at: "2026-09-25T10:00:00Z" },
      ],
    });
    const result = await getPermissionEvents({
      agent: "sage",
      before: "10",
      limit: 1,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(
        /WHERE[\s\S]+agent=\$1[\s\S]+ORDER BY id DESC LIMIT \$3/,
      ),
      ["sage", "10", 2],
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
