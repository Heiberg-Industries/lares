import { describe, expect, it } from "vitest";
import { DEADLINE_SCAN_CARRIER, DEADLINE_SCAN_SKIPS, deadlineScanJob } from "../src/deadline-scan-outcome.js";

describe("the deadline scan's shared words", () => {
  it("one record per agent, under its definition name", () => {
    expect(deadlineScanJob("chief-of-staff")).toBe("chief-of-staff/deadline-scan");
    expect(deadlineScanJob("second-cos")).toBe("second-cos/deadline-scan");
    expect(() => deadlineScanJob("Not A Name")).toThrow();
  });
  it("its skip codes are ones the outcome record accepts, and its carrier is the morning brief", () => {
    for (const code of Object.values(DEADLINE_SCAN_SKIPS)) expect(code).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(DEADLINE_SCAN_CARRIER).toBe("morning-brief");
  });
});
