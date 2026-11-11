import { describe, expect, it } from "vitest";
import hook, { makeApprovalSupersede } from "../agent/hooks/approval-supersede.js";
import { eveSession } from "../../../packages/agent-kit/tests/helpers/eve-session.js";

const open = (requestId: string, toolName: string, input: unknown) => {
  const s = eveSession();
  s.call(`call-${requestId}`, toolName, input);
  return { event: s.open(requestId, `call-${requestId}`), view: s.view };
};
const ctx = (turn: number, view: unknown) => ({ agent: { name: "fixture-agent" }, session: { id: "s1", turn: { sequence: turn } }, view });

describe("the approval-supersede hook", () => {
  it("is registered for interaction.opened only", () => {
    expect(Object.keys((hook as unknown as { events: object }).events)).toEqual(["interaction.opened"]);
  });

  it("withdraws the older send card when a revised send arrives in a later turn", async () => {
    const denied: unknown[] = [];
    const h = makeApprovalSupersede({
      record: async () => undefined,
      openAsks: async () => [{ requestId: "old", tool: "gmail_send", turn: 1, targetHash: null }],
      markRevised: async () => true,
      deny: async (s, r) => void denied.push([s, r]),
      isOpen: () => true,
    });
    const c = open("new", "gmail_send", { to: ["a@x.example"] });
    await h["interaction.opened"](c.event, ctx(2, c.view));
    expect(denied).toEqual([["s1", "old"]]);
  });

  it("leaves a card from the same turn alone", async () => {
    const denied: unknown[] = [];
    const h = makeApprovalSupersede({
      record: async () => undefined,
      openAsks: async () => [{ requestId: "old", tool: "gmail_send", turn: 2, targetHash: null }],
      markRevised: async () => true,
      deny: async (s, r) => void denied.push([s, r]),
      isOpen: () => true,
    });
    const c = open("new", "gmail_send", { to: ["a@x.example"] });
    await h["interaction.opened"](c.event, ctx(2, c.view));
    expect(denied).toEqual([]);
  });

  it("never throws on an event shape it cannot read", async () => {
    const h = makeApprovalSupersede({});
    await expect(h["interaction.opened"]({}, {})).resolves.toBeUndefined();
    await expect(h["interaction.opened"](undefined, undefined)).resolves.toBeUndefined();
  });
});
