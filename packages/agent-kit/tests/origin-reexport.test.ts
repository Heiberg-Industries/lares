import { describe, it, expect } from "vitest";
import { ORIGIN_CLASSES, narrowest, readOriginFrontmatter } from "../src/origin.js";
import { checkConformance, checkAreas } from "../src/okf.js";

describe("@lares/agent-kit/origin and /okf re-export @lares/vault-format", () => {
  it("exposes the origin vocabulary", () => {
    expect(ORIGIN_CLASSES).toBeDefined();
    expect(typeof narrowest).toBe("function");
    expect(typeof readOriginFrontmatter).toBe("function");
  });

  it("exposes the OKF conformance check", () => {
    expect(typeof checkConformance).toBe("function");
    expect(typeof checkAreas).toBe("function");
  });
});
