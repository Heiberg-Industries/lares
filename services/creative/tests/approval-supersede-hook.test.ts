import { describe, expect, it } from "vitest";
import hook, { makeApprovalSupersede } from "../agent/hooks/approval-supersede.js";

const card = (requestId: string, input: unknown) => ({
  kind: "tool-approval",
  requestId,
  action: { kind: "tool-call", callId: `call-${requestId}`, toolName: "vault_write", input },
});
const event = (...requests: unknown[]) => ({ type: "input.requested", data: { requests } });
const ctx = (turn: number) => ({ agent: { name: "fixture-agent" }, session: { id: "s1", turn: { sequence: turn } } });
const note = (title: string) => ({ area: "work", title, body: "words" });

describe("the creative approval-supersede hook", () => {
  it("is registered for input.requested only", () => {
    expect(Object.keys((hook as unknown as { events: object }).events)).toEqual(["input.requested"]);
  });

  it("records the new card with its session and turn, and withdraws the older note card", async () => {
    const recorded: unknown[] = [];
    const cancelled: unknown[] = [];
    const h = makeApprovalSupersede({
      record: async (a) => void recorded.push(a),
      openAsks: async () => [{ requestId: "old", tool: "vault_write", turn: 1, targetHash: null }],
      markRevised: async () => true,
      cancel: async (s, r) => void cancelled.push([s, r]),
    });
    await h["input.requested"](event(card("new", note("T"))), ctx(2));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ requestId: "new", sessionId: "s1", turn: 2, tool: "vault_write" });
    expect(cancelled).toEqual([["s1", "old"]]);
  });

  it("keeps a card for a different note", async () => {
    const { targetFingerprint } = await import("@lares/agent-kit/approval-supersede");
    const cancelled: unknown[] = [];
    const h = makeApprovalSupersede({
      record: async () => undefined,
      openAsks: async () => [{ requestId: "old", tool: "vault_write", turn: 1, targetHash: targetFingerprint("vault_write", note("Other")) }],
      markRevised: async () => true,
      cancel: async (s, r) => void cancelled.push([s, r]),
    });
    await h["input.requested"](event(card("new", note("T"))), ctx(2));
    expect(cancelled).toEqual([]);
  });
});
