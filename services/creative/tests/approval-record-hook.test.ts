import { describe, expect, it } from "vitest";
import { makeApprovalRecord } from "../agent/hooks/approval-record.js";
import { payloadFingerprint } from "@lares/agent-kit/approval-ledger";
import { eveSession } from "../../../packages/agent-kit/tests/helpers/eve-session.js";

const base = { agent: { name: "fixture-agent" }, session: { id: "s1" } };

describe("the approval-record hook (eve 1.0 interaction events)", () => {
  it("writes down a tool-approval card, with a hash of exactly what was shown", async () => {
    const asked: unknown[] = [];
    const h = makeApprovalRecord({ record: (a) => { asked.push(a); } });
    const s = eveSession();
    s.call("call-1", "gmail_send", { to: ["a@x.example"] });
    await h["interaction.opened"](s.open("req-1", "call-1"), { ...base, view: s.view });
    expect(asked).toEqual([{
      requestId: "req-1", callId: "call-1", agent: "fixture-agent", tool: "gmail_send",
      payloadHash: payloadFingerprint("gmail_send", { to: ["a@x.example"] }),
    }]);
  });

  it("ignores a question or a sign-in — only a tool approval is a card", async () => {
    const asked: unknown[] = [];
    const h = makeApprovalRecord({ record: (a) => { asked.push(a); } });
    const s = eveSession();
    s.call("call-q", "ask_question", {});
    await h["interaction.opened"](s.open("q-1", "call-q", "question"), { ...base, view: s.view });
    await h["interaction.opened"](s.open("q-2", "call-q", "sign-in"), { ...base, view: s.view });
    expect(asked).toEqual([]);
  });

  it("records nothing for a card whose tool the session view does not know", async () => {
    const asked: unknown[] = [];
    const h = makeApprovalRecord({ record: (a) => { asked.push(a); } });
    const s = eveSession();
    const opened = s.open("req-1", "call-never-requested");
    await h["interaction.opened"](opened, { ...base, view: s.view });
    await h["interaction.opened"](opened, base);
    expect(asked).toEqual([]);
  });

  it("only a person's Approve is an approval; a Deny is cancelled; nobody-decided endings are ignored", async () => {
    const answers: Array<Record<string, unknown>> = [];
    const h = makeApprovalRecord({ answer: (a) => { answers.push(a); } });
    const s = eveSession();
    const settle = async (id: string, outcome: Parameters<typeof s.settle>[1], option?: string) => {
      s.call(`call-${id}`, "gmail_send", { to: ["a@x.example"] });
      s.open(id, `call-${id}`);
      await h["interaction.settled"](s.settle(id, outcome, option), { ...base, view: s.view });
    };
    await settle("accepted-approve", "accepted", "approve");
    await settle("declined", "declined", "deny");
    await settle("withdrawn", "withdrawn");
    await settle("interrupted", "interrupted");
    await settle("expired", "expired");
    await settle("invalid", "invalid");
    await settle("accepted-but-deny", "accepted", "deny");
    await settle("accepted-no-option", "accepted");
    expect(answers).toEqual([
      { requestId: "accepted-approve", outcome: "approved" },
      { requestId: "declined", outcome: "cancelled" },
      { requestId: "withdrawn", outcome: "ignored", answeredVia: "nobody-decided" },
      { requestId: "interrupted", outcome: "ignored", answeredVia: "nobody-decided" },
      { requestId: "expired", outcome: "ignored", answeredVia: "nobody-decided" },
      { requestId: "invalid", outcome: "invalid", answeredVia: "nobody-decided" },
      { requestId: "accepted-but-deny", outcome: "invalid", answeredVia: "nobody-decided" },
      { requestId: "accepted-no-option", outcome: "invalid", answeredVia: "nobody-decided" },
    ]);
    // Nothing that happened without a person's Approve was recorded as approved.
    expect(answers.filter((a) => a["outcome"] === "approved").map((a) => a["requestId"])).toEqual(["accepted-approve"]);
  });

  it("does not record the end of a question", async () => {
    const answers: unknown[] = [];
    const h = makeApprovalRecord({ answer: (a) => { answers.push(a); } });
    const s = eveSession();
    s.call("call-q", "ask_question", {});
    s.open("q-1", "call-q", "question");
    await h["interaction.settled"](s.settle("q-1", "accepted", "yes"), { ...base, view: s.view });
    expect(answers).toEqual([]);
  });

  it("never throws on an event shape it cannot read", async () => {
    const h = makeApprovalRecord({});
    await expect(h["interaction.opened"]({}, {})).resolves.toBeUndefined();
    await expect(h["interaction.opened"](null, undefined)).resolves.toBeUndefined();
    await expect(h["interaction.settled"]({ data: { outcome: 7 } }, undefined)).resolves.toBeUndefined();
  });
});
