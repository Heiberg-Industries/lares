import { describe, it, expect } from "vitest";
import { isPlaceholderQuote, PLACEHOLDER_ASK } from "../src/markets/probability/placeholder.js";

describe("isPlaceholderQuote", () => {
  it("flags a stuck 1.00 ask with no real bid", () => {
    expect(isPlaceholderQuote(1.0, 0)).toBe(true);
    expect(isPlaceholderQuote(1.0, undefined)).toBe(true);
    expect(isPlaceholderQuote(0.999, undefined)).toBe(true);
  });
  it("keeps a real two-sided quote", () => {
    expect(isPlaceholderQuote(0.199, 0.197)).toBe(false);
    expect(isPlaceholderQuote(0.06, 0.05)).toBe(false);
  });
  it("flags a missing ask", () => {
    expect(isPlaceholderQuote(undefined, undefined)).toBe(true);
    expect(PLACEHOLDER_ASK).toBeGreaterThan(0.99);
  });
});
