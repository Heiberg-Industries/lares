import { describe, expect, it } from "vitest";
import { makeApprovalRecord } from "../agent/hooks/approval-record.js";
import { payloadFingerprint } from "@lares/agent-kit/approval-ledger";

const ctx = { agent: { name: "fixture-agent" }, session: { id: "s1" } };

describe("the approval-record hook", () => {
  it("writes down a tool-approval card, with a hash of exactly what was shown", async () => {
    const asked: unknown[] = [];
    const h = makeApprovalRecord({ record: (a) => asked.push(a) });
    await h["input.requested"]({
      type: "input.requested",
      data: {
        turnId: "t1", sequence: 1, stepIndex: 0,
        requests: [{
          kind: "tool-approval", requestId: "req-1", prompt: "Send email to a@x.example",
          action: { kind: "tool-call", callId: "call-1", toolName: "gmail_send", input: { to: ["a@x.example"] } },
        }],
      },
    }, ctx);
    expect(asked).toEqual([{
      requestId: "req-1", callId: "call-1", agent: "fixture-agent", tool: "gmail_send",
      payloadHash: payloadFingerprint("gmail_send", { to: ["a@x.example"] }),
    }]);
  });

  it("ignores a question — only a tool approval is a card", async () => {
    const asked: unknown[] = [];
    const h = makeApprovalRecord({ record: (a) => asked.push(a) });
    await h["input.requested"]({
      type: "input.requested",
      data: { turnId: "t1", sequence: 1, stepIndex: 0,
        requests: [{ kind: "question", requestId: "q-1", prompt: "Which one?" }] },
    }, ctx);
    expect(asked).toEqual([]);
  });

  it("records the answer, mapping eve's outcome onto ours", async () => {
    const answers: unknown[] = [];
    const h = makeApprovalRecord({ answer: (a) => answers.push(a) });
    await h["input.resolved"]({
      type: "input.resolved",
      data: { turnId: "t1", sequence: 2, stepIndex: 0,
        resolutions: [
          { kind: "tool-approval", requestId: "req-1", outcome: "approved" },
          { kind: "tool-approval", requestId: "req-2", outcome: "denied" },
          { kind: "tool-approval", requestId: "req-3", outcome: "ignored" },
          { kind: "question", requestId: "q-1", outcome: "answered" },
        ] },
    }, ctx);
    expect(answers).toEqual([
      { requestId: "req-1", outcome: "approved" },
      { requestId: "req-2", outcome: "cancelled" },
      { requestId: "req-3", outcome: "ignored" },
    ]);
  });

  it("never throws on an event shape it cannot read", async () => {
    const h = makeApprovalRecord({});
    await expect(h["input.requested"]({}, {})).resolves.toBeUndefined();
    await expect(h["input.resolved"]({ data: { resolutions: "nope" } }, undefined)).resolves.toBeUndefined();
  });
});
