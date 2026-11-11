import { describe, it, expect, vi } from "vitest";
// The tool catalogue is not what this test reads; leaving it out keeps the test independent of the kit build.
vi.mock("../catalogue/index.js", () => ({ CATALOGUE: {} }));
const calls = vi.hoisted(() => ({ summary: vi.fn(), hydration: vi.fn(), order: [] as string[] }));
vi.mock("@lares/agent-kit/approval-summary", () => ({ registerApprovalSummary: (...args: unknown[]) => { calls.order.push("summary"); calls.summary(...args); } }));
vi.mock("@lares/agent-kit/attachment-hydration", () => ({ installAttachmentHydration: (...args: unknown[]) => { calls.order.push("hydration"); calls.hydration(...args); } }));
import instrumentation from "../agent/instrumentation.js";

describe("startup: what the framework patch and the approval cards need", () => {
  it("setup registers the approval summary and installs attachment hydration", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("LANGFUSE_KEY_FILE", "/nonexistent/langfuse-key");
    await (instrumentation.setup as (input: { agentName: string }) => unknown)({ agentName: "helper" });
    expect(calls.order).toEqual(["summary", "hydration"]);
  });

  it("the AI SDK's default model provider refuses every request once this module is loaded", () => {
    const provider = (globalThis as { AI_SDK_DEFAULT_PROVIDER?: { languageModel(id: string): { doGenerate(): unknown } } }).AI_SDK_DEFAULT_PROVIDER;
    expect(provider).toBeDefined();
    expect(() => provider!.languageModel("anthropic/some-model").doGenerate()).toThrow("outside the engine's gateway");
  });

  it("does not set the removed top-level content keys, and keeps its trace policy", () => {
    expect(Object.keys(instrumentation)).not.toContain("recordInputs");
    expect(typeof instrumentation.tracePolicy).toBe("function");
  });
});
