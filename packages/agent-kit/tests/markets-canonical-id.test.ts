import { describe, it, expect } from "vitest";
import { canonicalMarketId } from "../src/markets/canonical-id.js";

describe("canonicalMarketId", () => {
  it("collapses known duplicate slugs to one id", () => {
    expect(canonicalMarketId("which-continent-will-win-the-world-cup")).toBe(
      canonicalMarketId("which-continent-will-win")
    );
  });
});
