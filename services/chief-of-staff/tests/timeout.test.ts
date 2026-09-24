import { describe, it, expect, vi } from "vitest";

import { withTimeout } from "../lib/timeout.js";

/**
 * ORB-209 — `withTimeout` had no unit test of its own while it lived in `lib/brief-content.ts`;
 * it was exercised only through the callers that wrap a Gmail, Slack or Postgres read in it.
 * Now that it is a leaf module every scheduled lane depends on, the three things those callers
 * actually rely on are pinned here directly.
 */
describe("withTimeout", () => {
  it("passes a value through when the promise settles inside the budget", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000, "test: fast")).resolves.toBe("ok");
  });

  it("passes a rejection through unchanged — the underlying error is not replaced by a timeout", async () => {
    const boom = new Error("gateway 500");
    await expect(withTimeout(Promise.reject(boom), 1000, "test: throws")).rejects.toBe(boom);
  });

  it("rejects with the LABEL and the budget when the promise never settles", async () => {
    vi.useFakeTimers();
    try {
      const pending = withTimeout(new Promise<never>(() => {}), 5000, "test: hung read");
      const settled = expect(pending).rejects.toThrow("test: hung read timed out after 5000ms");
      await vi.advanceTimersByTimeAsync(5001);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears its timer once the promise settles — a resolved call leaves nothing pending", async () => {
    vi.useFakeTimers();
    try {
      await withTimeout(Promise.resolve("ok"), 60_000, "test: cleanup");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
