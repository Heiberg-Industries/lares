import { describe, it, expect } from "vitest";
import {
  assertStepAffordable, actualStepCost, UnpricedModelError, StepTooExpensiveError,
  DREAM_STEP_CAP_USD,
} from "../lib/dream/spend.js";

const env = { LARES_MODEL_PREFIX: "lares" };
const priced = "lares-brain";

describe("the spend cap", () => {
  it("prices the brain purpose whatever the installation's prefix, and nothing without one", () => {
    for (const prefix of ["lares", "home"])
      expect(assertStepAffordable({ model: `${prefix}-brain`, promptChars: 1000, maxOutputTokens: 1024 }, { LARES_MODEL_PREFIX: prefix }).estimateUsd)
        .toBeGreaterThan(0);
    expect(() => assertStepAffordable({ model: "home-brain", promptChars: 1000, maxOutputTokens: 1024 }, { LARES_MODEL_PREFIX: "lares" }))
      .toThrow(UnpricedModelError);
    expect(() => assertStepAffordable({ model: "lares-brain", promptChars: 1000, maxOutputTokens: 1024 }, {}))
      .toThrow(UnpricedModelError);
    expect(() => assertStepAffordable({ model: "lares-writer", promptChars: 1000, maxOutputTokens: 1024 }, env))
      .toThrow(UnpricedModelError);
  });

  it("refuses a model nobody has priced, rather than guessing it is cheap", () => {
    expect(() => assertStepAffordable({ model: "some-new-alias", promptChars: 1000, maxOutputTokens: 1024 }))
      .toThrow(UnpricedModelError);
  });

  it("names the model and the file to edit in the refusal", () => {
    try {
      assertStepAffordable({ model: "some-new-alias", promptChars: 1000, maxOutputTokens: 1024 });
    } catch (e) {
      expect((e as Error).message).toContain("some-new-alias");
      expect((e as Error).message).toMatch(/lib\/dream\/spend\.ts/);
    }
  });

  it("allows an ordinary run and reports what it expects it to cost", () => {
    const { estimateUsd } = assertStepAffordable({ model: priced, promptChars: 20_000, maxOutputTokens: 8192 }, env);
    expect(estimateUsd).toBeGreaterThan(0);
    expect(estimateUsd).toBeLessThan(DREAM_STEP_CAP_USD);
  });

  it("refuses a prompt whose worst case already exceeds the cap", () => {
    expect(() => assertStepAffordable({ model: priced, promptChars: 40_000_000, maxOutputTokens: 8192 }, env))
      .toThrow(StepTooExpensiveError);
  });

  it("prices against the cap the gateway will ACTUALLY apply, not the one the caller asked for", () => {
    // outputTokenBudget raises a `brain` call's 1024 to THINKING_MODEL_MIN_OUTPUT_TOKENS (8192),
    // so a cap computed from 1024 would understate the worst case eightfold.
    const small = assertStepAffordable({ model: priced, promptChars: 1000, maxOutputTokens: 8192 }, env);
    const asked = assertStepAffordable({ model: priced, promptChars: 1000, maxOutputTokens: 1024 }, env);
    expect(small.estimateUsd).toBeGreaterThan(asked.estimateUsd);
  });

  it("says nothing rather than zero when the provider reported no usage", () => {
    expect(actualStepCost(priced, undefined, env)).toBeUndefined();
    expect(actualStepCost(priced, { inputTokens: 1000, outputTokens: 100 }, env)).toBeGreaterThan(0);
    expect(actualStepCost("some-new-alias", { inputTokens: 1000, outputTokens: 100 })).toBeUndefined();
  });
});
