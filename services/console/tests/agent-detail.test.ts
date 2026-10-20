import { describe, it, expect, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../lib/db", () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }));
vi.mock("../lib/agents", () => ({
  listAgents: async () => [{
    name: "helper", displayName: "Helper", role: "assistant", skills: [], doors: [], startedAt: "2026-10-01T06:00:00Z",
    grants: [{ capability: "gmail", scope: "write-with-confirm" }, { capability: "read_url", scope: "read" }, { capability: "twenty", scope: "none" }],
    autonomy: { gmail: "gated" },
    tools: null,
  }],
}));

import { getAgentDetail, getPromptCacheLine, promptCacheLine, resolveActionLevel } from "../lib/agent-detail";

describe("resolveActionLevel", () => {
  const rows = [
    { capability: "gmail", action: "", level: "autonomous" as const },
    { capability: "gmail", action: "send", level: "never" as const },
  ];
  it("action override wins; else capability default; else gated", () => {
    expect(resolveActionLevel(rows, "gmail", "send")).toEqual({ level: "never", overridden: true });
    expect(resolveActionLevel(rows, "gmail", "poll")).toEqual({ level: "autonomous", overridden: false });
    expect(resolveActionLevel(rows, "read_url", "x")).toEqual({ level: "gated", overridden: false });
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
      { name: "read_url", scope: "read", defaultLevel: "gated" },
    ]);
  });
});

// The prompt-cache line. The aggregate runs in SQL, so the mocked pool answers with one summary row;
// these tests pin down the wording, the arithmetic, and that the query is scoped to this agent and
// to the last 7 days (the mock cannot filter rows itself).
describe("promptCacheLine", () => {
  it("says nothing was recorded rather than printing a percentage of nothing", () => {
    expect(promptCacheLine({ calls: 0, reporting: 0, input: 0, cacheRead: 0 })).toBe(
      "Prompt cache: no model calls recorded in the last 7 days",
    );
  });
  it("reports the share of input tokens read from cache, rounded to a whole percent", () => {
    expect(promptCacheLine({ calls: 4, reporting: 4, input: 3000, cacheRead: 2000 })).toBe(
      "Prompt cache: 67% of input tokens read from cache, last 7 days (4 model calls)",
    );
    expect(promptCacheLine({ calls: 1, reporting: 1, input: 100, cacheRead: 0 })).toBe(
      "Prompt cache: 0% of input tokens read from cache, last 7 days (1 model call)",
    );
  });
  it("says the provider did not report counts when rows exist but none carry input tokens", () => {
    expect(promptCacheLine({ calls: 3, reporting: 0, input: 0, cacheRead: 0 })).toBe(
      "Prompt cache: the provider did not report token counts for the 3 model calls in the last 7 days",
    );
  });
  it("counts only the calls that reported input tokens", () => {
    expect(promptCacheLine({ calls: 5, reporting: 2, input: 1000, cacheRead: 500 })).toBe(
      "Prompt cache: 50% of input tokens read from cache, last 7 days (2 model calls)",
    );
  });
});

describe("getPromptCacheLine", () => {
  it("reads one summary row for this agent over the last 7 days", async () => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [{ calls: "4", reporting: "4", input: "3000", cache_read: "2000" }] });
    const line = await getPromptCacheLine("helper");
    expect(line).toBe("Prompt cache: 67% of input tokens read from cache, last 7 days (4 model calls)");
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/FROM model_steps/);
    expect(sql).toMatch(/agent = \$1/);
    expect(sql).toMatch(/at >= now\(\) - interval '7 days'/);
    expect(params).toEqual(["helper"]);
  });
  it("treats a missing cache count as zero only on rows that reported input tokens", async () => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [{ calls: "2", reporting: "1", input: "800", cache_read: "0" }] });
    expect(await getPromptCacheLine("helper")).toBe(
      "Prompt cache: 0% of input tokens read from cache, last 7 days (1 model call)",
    );
    const [sql] = queryMock.mock.calls[0] as [string];
    expect(sql).toMatch(/CASE WHEN input_tokens IS NOT NULL THEN COALESCE\(cache_read_tokens, 0\)/);
  });
  it("no rows in the window gives the no-calls wording", async () => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [{ calls: "0", reporting: "0", input: null, cache_read: null }] });
    expect(await getPromptCacheLine("helper")).toBe("Prompt cache: no model calls recorded in the last 7 days");
  });
  it("shows nothing when the query fails (for example the table is missing)", async () => {
    queryMock.mockReset();
    queryMock.mockRejectedValue(new Error('relation "model_steps" does not exist'));
    expect(await getPromptCacheLine("helper")).toBeNull();
  });
});
