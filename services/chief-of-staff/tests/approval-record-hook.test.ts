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

  it("ignores a sign-in; a question is written as a card of its own kind, not as an approval", async () => {
    const asked: unknown[] = [];
    const questions: unknown[] = [];
    const h = makeApprovalRecord({ record: (a) => { asked.push(a); }, question: (a) => { questions.push(a); } });
    const s = eveSession();
    s.call("call-q", "ask_question", {});
    await h["interaction.opened"](s.open("q-1", "call-q", "question"), { ...base, view: s.view });
    await h["interaction.opened"](s.open("q-2", "call-q", "sign-in"), { ...base, view: s.view });
    expect(asked).toEqual([]);
    expect(questions).toEqual([expect.objectContaining({ requestId: "q-1", agent: "fixture-agent" })]);
  });

  it("writes down the door a card was raised on and the person it was put to, from who started the conversation", async () => {
    const origins: unknown[] = [];
    const h = makeApprovalRecord({ record: () => {}, origin: (a) => { origins.push(a); } });
    const s = eveSession();
    s.call("call-1", "gmail_send", { to: ["a@x.example"] });
    const slack = { authenticator: "slack-webhook", principalType: "user", attributes: { author_type: "user", user_id: "U1" } };
    await h["interaction.opened"](s.open("req-1", "call-1"), { ...base, session: { id: "s1", auth: { initiator: slack } }, view: s.view });
    s.call("call-2", "gmail_send", { to: ["a@x.example"] });
    await h["interaction.opened"](s.open("req-2", "call-2"), { ...base, view: s.view });
    // A card with no door initiator (a scheduled job) gets no door.
    expect(origins).toEqual([{ requestId: "req-1", door: "slack", putTo: "U1" }]);
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

  it("records the end of a question as answered or not, and never as an approval", async () => {
    const answers: unknown[] = [];
    const ends: unknown[] = [];
    const h = makeApprovalRecord({ answer: (a) => { answers.push(a); }, questionEnd: (a) => { ends.push(a); } });
    const s = eveSession();
    s.call("call-q", "ask_question", {});
    s.open("q-1", "call-q", "question");
    await h["interaction.settled"](s.settle("q-1", "accepted", "yes"), { ...base, view: s.view });
    s.open("q-2", "call-q", "question");
    await h["interaction.settled"](s.settle("q-2", "withdrawn"), { ...base, view: s.view });
    expect(answers).toEqual([]);
    expect(ends).toEqual([{ requestId: "q-1", answered: true }, { requestId: "q-2", answered: false }]);
  });

  it("never throws on an event shape it cannot read", async () => {
    const h = makeApprovalRecord({});
    await expect(h["interaction.opened"]({}, {})).resolves.toBeUndefined();
    await expect(h["interaction.opened"](null, undefined)).resolves.toBeUndefined();
    await expect(h["interaction.settled"]({ data: { outcome: 7 } }, undefined)).resolves.toBeUndefined();
  });
});
