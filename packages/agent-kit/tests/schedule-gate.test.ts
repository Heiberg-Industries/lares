import { describe, it, expect } from "vitest";

import { scheduleGate } from "../src/schedule-gate.js";

describe("scheduleGate", () => {
  it("is live only when EVE_SCHEDULES_LIVE is exactly \"1\"", () => {
    expect(scheduleGate({ EVE_SCHEDULES_LIVE: "1" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it.each([
    ["unset", {} as NodeJS.ProcessEnv],
    ["0", { EVE_SCHEDULES_LIVE: "0" } as NodeJS.ProcessEnv],
    ["truthy typo", { EVE_SCHEDULES_LIVE: "true" } as NodeJS.ProcessEnv],
    ["blank", { EVE_SCHEDULES_LIVE: "" } as NodeJS.ProcessEnv],
  ])("fails closed: %s", (_label, env) => {
    expect(scheduleGate(env)).toBe(false);
  });
});
