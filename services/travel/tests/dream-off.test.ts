import { describe, it, expect, vi } from "vitest";
import { Dreamer } from "../lib/dream.js";

describe("the travel role does not learn unattended until it meets ADR-0018", () => {
  it("nightly writes nothing and calls no model", async () => {
    const distill = vi.fn();
    const store = { read: vi.fn(() => "what we knew"), write: vi.fn() };
    await new Dreamer({ distill, store } as never)
      .nightly({ name: "a trip", dir: "/tmp/x", end: "2026-09-20" } as never, "today's chat", "2026-09-18");
    expect(distill).not.toHaveBeenCalled();
    expect(store.write).not.toHaveBeenCalled();
  });

  it("promoteTaste appends nothing", async () => {
    const distill = vi.fn();
    await new Dreamer({ distill, store: { read: () => "", write: vi.fn() } } as never)
      .promoteTaste({ name: "a trip", dir: "/tmp/x", end: "2026-09-20" } as never);
    expect(distill).not.toHaveBeenCalled();
  });

  it("says why, once, in words an owner can act on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await new Dreamer({ distill: vi.fn(), store: { read: () => "", write: vi.fn() } } as never)
      .nightly({ name: "a trip", dir: "/tmp/x", end: "2026-09-20" } as never, "chat", "2026-09-18");
    expect(warn.mock.calls[0]![0]).toMatch(/rewrites the whole file/i);
    expect(warn.mock.calls[0]![0]).toMatch(/0018/);
    expect(warn.mock.calls[0]![0]).not.toMatch(/marcel|bendik/i);
  });
});
