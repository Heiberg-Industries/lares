import { describe, expect, it } from "vitest";
import { makeApprovalSupersede } from "../agent/hooks/approval-supersede.js";
import hook from "../agent/hooks/approval-supersede.js";

const card = (requestId: string, toolName: string, input: unknown) => ({
  kind: "tool-approval",
  requestId,
  action: { kind: "tool-call", callId: `call-${requestId}`, toolName, input },
});
const event = (...requests: unknown[]) => ({ type: "input.requested", data: { requests } });
const ctx = (turn: number) => ({ agent: { name: "fixture-agent" }, session: { id: "s1", turn: { sequence: turn } } });

describe("the approval-supersede hook", () => {
  it("is registered for input.requested only", () => {
    expect(Object.keys((hook as unknown as { events: object }).events)).toEqual(["input.requested"]);
  });

  it("withdraws the older send card when a revised send arrives in a later turn", async () => {
    const cancelled: unknown[] = [];
    const h = makeApprovalSupersede({
      record: async () => undefined,
      openAsks: async () => [{ requestId: "old", tool: "gmail_send", turn: 1, targetHash: null }],
      markRevised: async () => true,
      cancel: async (s, r) => void cancelled.push([s, r]),
    });
    await h["input.requested"](event(card("new", "gmail_send", { to: ["a@x.example"] })), ctx(2));
    expect(cancelled).toEqual([["s1", "old"]]);
  });

  it("leaves a card from the same turn alone", async () => {
    const cancelled: unknown[] = [];
    const h = makeApprovalSupersede({
      record: async () => undefined,
      openAsks: async () => [{ requestId: "old", tool: "gmail_send", turn: 2, targetHash: null }],
      markRevised: async () => true,
      cancel: async (s, r) => void cancelled.push([s, r]),
    });
    await h["input.requested"](event(card("new", "gmail_send", { to: ["a@x.example"] })), ctx(2));
    expect(cancelled).toEqual([]);
  });

  it("never throws on an event shape it cannot read", async () => {
    const h = makeApprovalSupersede({});
    await expect(h["input.requested"]({}, {})).resolves.toBeUndefined();
    await expect(h["input.requested"](undefined, undefined)).resolves.toBeUndefined();
  });
});
