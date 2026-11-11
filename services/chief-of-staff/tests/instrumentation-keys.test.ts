import { describe, it, expect, vi } from "vitest";
// The tool catalogue is not what this test reads; leaving it out keeps the test independent of the kit build.
vi.mock("../catalogue/index.js", () => ({ CATALOGUE: {} }));
import instrumentation from "../agent/instrumentation.js";

// eve 1.0's `defineInstrumentation` has no top-level `recordInputs` / `recordOutputs`: what a trace
// carries is decided by `tracePolicy` alone (docs/guides/instrumentation/instrumentation.mdx,
// "Control inputs and outputs"). eve's own docstring warns that excess-property checking on
// defineInstrumentation is weak, so a leftover key could reach `eve build` rather than failing at
// tsc. This test pins that the removed keys are gone and that the policy still does its job: a
// private console conversation exports nothing; every other channel exports inputs and outputs.
describe("the instrumentation config uses only what eve 1.0 honours", () => {
  it("does not set the removed top-level content keys", () => {
    const keys = Object.keys(instrumentation);
    expect(keys).not.toContain("recordInputs");
    expect(keys).not.toContain("recordOutputs");
  });

  it("declares a tracePolicy, so a private conversation is not silently content-free", () => {
    expect(typeof instrumentation.tracePolicy).toBe("function");
  });

  it("emits nothing for the private console channel, under either spelling", () => {
    const policy = instrumentation.tracePolicy as (t: { channel: { kind: string } }) => unknown;
    expect(policy({ channel: { kind: "channel:eve" } })).toEqual({ emit: false });
    expect(policy({ channel: { kind: "http" } })).toEqual({ emit: false });
  });

  it("exports inputs and outputs for the doors and everything else", () => {
    const policy = instrumentation.tracePolicy as (t: { channel: { kind: string } }) => unknown;
    for (const kind of ["channel:slack", "channel:telegram", "schedule", "subagent", "unknown"]) {
      expect(policy({ channel: { kind } })).toEqual({ emit: true, recordInputs: true, recordOutputs: true });
    }
  });
});
