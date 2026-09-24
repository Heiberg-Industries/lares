import { describe, it, expect } from "vitest";

const { captureTurn } = await import("../lib/turn-capture.js");

const base = {
  at: "2026-08-19T10:00:00.000Z",
  door: "slack",
  principal: "U_EXAMPLE_OWNER",
  sessionId: "s1",
  turnId: "t1",
  origin: "owner" as const,
  input: "hei",
  reply: "hei igjen",
  proposals: [],
};

describe("captureTurn — the conversation record (ADR-0020)", () => {
  it("hands the record an entry with the right shape", async () => {
    const appended: unknown[] = [];
    await captureTurn(
      { ...base, door: "slack", principal: "fixture-owner", turnId: "t1", sessionId: "s1", input: "hello", reply: "hi", proposals: [], origin: "owner" },
      {
        append: async (e: unknown) => {
          appended.push(e);
          return e as never;
        },
      },
    );
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ door: "slack", personKey: "fixture-owner", origin: "owner", lane: null });
  });

  it("does not call the record when the entry has no sessionId/turnId — nothing to correlate a row to", async () => {
    const appended: unknown[] = [];
    await captureTurn(
      { ...base, sessionId: undefined, turnId: undefined },
      {
        append: async (e: unknown) => {
          appended.push(e);
          return e as never;
        },
      },
    );
    expect(appended).toHaveLength(0);
  });

  it("NEVER throws when the record write fails — it warns and continues (the reply is unaffected)", async () => {
    const failing = {
      append: async () => {
        throw new Error("db unreachable");
      },
    };
    await expect(captureTurn(base, failing)).resolves.toBeUndefined();
  });
});
