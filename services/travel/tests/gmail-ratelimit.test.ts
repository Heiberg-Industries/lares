import { describe, it, expect, beforeEach } from "vitest";
import {
  parseRateLimit,
  withGmailRateLimit,
  isGated,
  __resetGmailGatesForTest,
} from "../lib/gmail-ratelimit.js";

// Ported verbatim from services/marcel/tests/gmail-ratelimit.test.ts — lib/gmail-ratelimit.ts
// is itself a verbatim port of services/marcel/lib/gmail-ratelimit.ts (Task 4 brief).

const T0 = Date.parse("2026-07-20T08:26:00.000Z");

function rateLimitError(iso: string) {
  return Object.assign(new Error(`User-rate limit exceeded.  Retry after ${iso}`), { code: 429 });
}

describe("eve-marcel gmail-ratelimit", () => {
  beforeEach(() => __resetGmailGatesForTest());

  it("parses Google's Retry-after hint and ignores non-rate-limit errors", () => {
    expect(parseRateLimit(rateLimitError("2026-07-20T08:26:04.000Z"), T0)).toBe(4000);
    expect(parseRateLimit(new Error("network down"), T0)).toBeNull();
  });

  it("honours the retry-after then succeeds, and marks the mailbox gated", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const out = await withGmailRateLimit("marcel-reise", async () => {
      calls++;
      if (calls === 1) throw rateLimitError("2026-07-20T08:26:05.000Z");
      return "ok";
    }, { now: () => T0, sleep: async (ms) => { sleeps.push(ms); }, rand: () => 0 });
    expect(out).toBe("ok");
    expect(sleeps).toEqual([5000]);
    expect(isGated("marcel-reise", T0)).toBe(true);   // loop can skip ticks while gated
    expect(isGated("marcel-reise", T0 + 6000)).toBe(false);
  });

  it("rethrows a non-rate-limit error immediately", async () => {
    let calls = 0;
    await expect(withGmailRateLimit("marcel-reise", async () => {
      calls++;
      throw new Error("boom");
    }, { now: () => T0, sleep: async () => {}, rand: () => 0 })).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });
});
