/**
 * agent/tools/read_url.ts — W3A-s5 (beyond the slice's own file list; see catalogue/read_url.ts's
 * own header and services/chief-of-staff/tests/origin-taint-reads.test.ts's register-completeness
 * audit, which is what found this tool unwired). Structurally identical to
 * services/chief-of-staff/catalogue/read_url.ts's web branch — a successful read brings back an
 * arbitrary page's text, which taints the turn `third_party`
 * (docs/specs/2026-09-18-origin-model-design.md, "The in-turn taint rule").
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const ctx = { session: { id: "s1", turn: { id: "t1" } } } as never;
const key = { sessionId: "s1", turnId: "t1" };

beforeEach(() => { vi.resetModules(); });

// `vi.resetModules()` clears vitest's module registry, so a tool re-imported dynamically after
// it gets a FRESH copy of `@lares/agent-kit/origin-taint` with its own, separate `taints` Map —
// never the one a file-level static import would be bound to. Re-importing the taint module
// itself, dynamically, after each reset keeps the assertion on the same instance the tool wrote
// to (see services/chief-of-staff/tests/origin-taint-reads.test.ts's own header for the full
// story — this bug surfaced there first).
async function freshTaint() {
  return import("@lares/agent-kit/origin-taint");
}

describe("read_url taints third_party on a successful call", () => {
  it("taints after a page is read", async () => {
    vi.doMock("@lares/agent-kit/readability-client", () => ({
      readUrl: async () => ({ title: "t", text: "x" }),
      readUrlModelOutput: (r: unknown) => r,
    }));
    const tool = (await import("../catalogue/read_url.js")).default;
    await tool.execute({ url: "https://example.test/a" }, ctx);
    expect((await freshTaint()).currentTaint(key)).toBe("third_party");
  });

  it("a failed read taints nothing", async () => {
    vi.doMock("@lares/agent-kit/readability-client", () => ({
      readUrl: async () => { throw new Error("unreachable"); },
      readUrlModelOutput: (r: unknown) => r,
    }));
    const tool = (await import("../catalogue/read_url.js")).default;
    await expect(tool.execute({ url: "https://example.test/a" }, ctx)).rejects.toThrow("unreachable");
    expect((await freshTaint()).currentTaint(key)).toBeUndefined();
  });
});
