import { describe, it, expect } from "vitest";
import { rollupStatus } from "../lib/queries";

describe("rollupStatus", () => {
  it("waiting beats running beats idle", () => {
    expect(rollupStatus({ waiting: 1, running: 2 })).toBe("waiting");
    expect(rollupStatus({ waiting: 0, running: 2 })).toBe("running");
    expect(rollupStatus({ waiting: 0, running: 0 })).toBe("idle");
  });
});
