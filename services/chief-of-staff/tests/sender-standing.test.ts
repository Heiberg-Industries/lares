/**
 * W7D-s2 — owner decision D3: the read says whether the sender is someone the owner has
 * written to before, in exactly one of three fixed sentences, never "trusted". `senderStanding`
 * is a pure-ish function over an injected lookup (`deps.known`), so these tests never touch
 * Gmail or the network db — `isKnownRecipient`'s own Gmail assumptions are covered by
 * `tests/live/contact-history-gmail.live.mts`, referenced from this file's header comment.
 */
import { describe, expect, it, vi } from "vitest";

import { senderStanding, SENDER_STANDING_TIMEOUT_MS } from "../lib/sender-standing.js";

describe("senderStanding", () => {
  it("answers 'you have written to them before' when the lookup finds prior contact", async () => {
    const known = vi.fn(async () => true);
    await expect(senderStanding("a@x.example", { known })).resolves.toBe("you have written to them before");
    expect(known).toHaveBeenCalledWith("a@x.example");
  });

  it("answers 'nobody you have written to' when the lookup finds none", async () => {
    const known = vi.fn(async () => false);
    await expect(senderStanding("a@x.example", { known })).resolves.toBe("nobody you have written to");
  });

  it("answers 'I could not check' when the lookup throws — never a false 'nobody you have written to'", async () => {
    const known = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(senderStanding("a@x.example", { known })).resolves.toBe("I could not check");
  });

  it("answers 'I could not check' within the timeout when the lookup never resolves, rather than hanging the read", async () => {
    vi.useFakeTimers();
    try {
      const known = vi.fn(() => new Promise<boolean>(() => {}));
      const result = senderStanding("a@x.example", { known });
      await vi.advanceTimersByTimeAsync(SENDER_STANDING_TIMEOUT_MS);
      await expect(result).resolves.toBe("I could not check");
    } finally {
      vi.useRealTimers();
    }
  });

  it("respects an injected timeoutMs, for a test that cannot wait the real five seconds", async () => {
    vi.useFakeTimers();
    try {
      const known = vi.fn(() => new Promise<boolean>(() => {}));
      const result = senderStanding("a@x.example", { known, timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(50);
      await expect(result).resolves.toBe("I could not check");
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers 'I could not check' for a non-string from, without calling the lookup at all", async () => {
    const known = vi.fn(async () => true);
    await expect(senderStanding(undefined, { known })).resolves.toBe("I could not check");
    expect(known).not.toHaveBeenCalled();
  });

  it("answers 'I could not check' for an empty from, without calling the lookup at all", async () => {
    const known = vi.fn(async () => true);
    await expect(senderStanding("", { known })).resolves.toBe("I could not check");
    expect(known).not.toHaveBeenCalled();
  });

  it("answers 'I could not check' for several addresses in one from, without calling the lookup at all", async () => {
    const known = vi.fn(async () => true);
    await expect(senderStanding("a@x.example, b@y.example", { known })).resolves.toBe("I could not check");
    expect(known).not.toHaveBeenCalled();
  });

  it("answers 'I could not check' for two display-named addresses in one from, without calling the lookup at all", async () => {
    const known = vi.fn(async () => true);
    await expect(senderStanding("Alice <a@x.example>, Bob <b@evil.example>", { known })).resolves.toBe("I could not check");
    expect(known).not.toHaveBeenCalled();
  });

  it("is judged on the address, not the display name — display-name spoofing", async () => {
    const known = vi.fn(async () => true);
    await senderStanding("Known Person <stranger@evil.example>", { known });
    expect(known).toHaveBeenCalledWith("stranger@evil.example");
    expect(known).not.toHaveBeenCalledWith(expect.stringContaining("Known Person"));
  });

  it("normalises case, the same way the existing first-contact check does", async () => {
    const known = vi.fn(async () => true);
    await senderStanding("Name <A@X.EXAMPLE>", { known });
    expect(known).toHaveBeenCalledWith("a@x.example");
  });
});
