/**
 * ORB-133 Task 6 — the schedule's two decisions that are not the runner's: whether it may run
 * at all, and where the result goes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { digestGate, chooseTarget } from "../agent/schedules/digest.js";

const saved = { ...process.env };
beforeEach(() => { process.env = { ...saved }; });
afterEach(() => { process.env = { ...saved }; });

describe("digestGate — fails closed, and is independent of the service-wide gate", () => {
  it("is off when its own gate is unset, even with schedules live", () => {
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    delete process.env["EVE_DIGEST_LIVE"];
    expect(digestGate()).toBe(false);
  });

  it('is off for anything other than exactly "1"', () => {
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    for (const v of ["0", "true", "yes", "", " 1", "1 "]) {
      process.env["EVE_DIGEST_LIVE"] = v;
      expect(digestGate(), `EVE_DIGEST_LIVE=${JSON.stringify(v)} must not enable the digest`).toBe(false);
    }
  });

  it("is on only when BOTH gates are exactly 1", () => {
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    process.env["EVE_DIGEST_LIVE"] = "1";
    expect(digestGate()).toBe(true);
  });

  // The whole point of the second gate: it must be possible to ship the code to the box with
  // schedules already live, and still have the digest dark until saga-digest is stopped.
  it("stays off when the service gate is off but its own is on", () => {
    process.env["EVE_SCHEDULES_LIVE"] = "0";
    process.env["EVE_DIGEST_LIVE"] = "1";
    expect(digestGate()).toBe(false);
  });
});

describe("chooseTarget — a scheduled pass DMs Bendik; an on-demand pass replies where it was asked", () => {
  const req = (threadRef: string) => ({ id: "r", door: "slack", threadRef });

  it("a scheduled pass goes to the DM, ignoring any request that rode along in the same tick", () => {
    expect(chooseTarget(true, [req("C_THREAD")], "U_DM")).toBe("U_DM");
  });

  it("an on-demand pass replies in the requesting thread, not the DM", () => {
    expect(chooseTarget(false, [req("C_THREAD")], "U_DM")).toBe("C_THREAD");
  });

  it("an on-demand pass with no threadRef falls back to the DM rather than going nowhere", () => {
    expect(chooseTarget(false, [], "U_DM")).toBe("U_DM");
  });

  it("takes the FIRST request's thread when several were claimed at once", () => {
    expect(chooseTarget(false, [req("FIRST"), req("SECOND")], "U_DM")).toBe("FIRST");
  });
});

/**
 * LAR-17-s3 — PIN, asserted against the source: the digest's slots come from the setting
 * (`scheduleHours("digest")`), read before `dueScheduledSlot` is ever called, and no hardcoded
 * `[9, 17]` default rides along inside this file (the removed default belonged to
 * `lib/digest/schedule.ts`'s `dueScheduledSlot`, whose own tests in digest-modules.test.ts cover
 * that it now REQUIRES an hours array).
 */
describe("digest.ts reads its slots from the setting (LAR-17-s3)", () => {
  it("calls scheduleHours before dueScheduledSlot, and passes no literal [9, 17]", async () => {
    const src = await (await import("node:fs/promises")).readFile(
      new URL("../agent/schedules/digest.ts", import.meta.url),
      "utf8",
    );
    expect(src.indexOf('scheduleHours("digest")')).toBeGreaterThan(-1);
    expect(src.indexOf('scheduleHours("digest")')).toBeLessThan(src.indexOf("dueScheduledSlot("));
    expect(src).not.toContain("[9, 17]");
  });
});
