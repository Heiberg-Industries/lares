import { describe, it, expect } from "vitest";
import instrumentation from "../agent/instrumentation.js";

// eve 0.60.0 removed `recordInputs`/`recordOutputs` from OTel DESTINATION options
// (otelIntegration/managedOtelIntegration/agentRunsIntegration, which call
// assertNoRemovedContentOptions and throw). It did NOT remove them from
// defineInstrumentation's own config, which is the layout this service uses — they are still
// documented at dist/src/public/instrumentation/index.d.ts:133,139.
//
// This test exists because eve's own docstring warns that excess-property checking on
// defineInstrumentation is weak: "a misspelled key can reach `eve build` rather than failing at
// tsc". A typo here would silently ship content-free traces. If a future eve really does remove
// these keys, this test is where it surfaces — loudly, at the bump, not months later.
describe("the instrumentation config keeps the keys eve still honours", () => {
  it("records inputs and outputs", () => {
    expect(instrumentation.recordInputs).toBe(true);
    expect(instrumentation.recordOutputs).toBe(true);
  });

  it("declares a tracePolicy, so a private conversation is not silently content-free", () => {
    expect(typeof instrumentation.tracePolicy).toBe("function");
  });
});
