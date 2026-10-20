import { describe, expect, it } from "vitest";
import {
  approvalTarget,
  selectSupersededAsks,
  targetFingerprint,
  type IncomingAsk,
  type OpenAsk,
} from "../src/approval-supersede.js";

const ask = (over: Partial<OpenAsk> = {}): OpenAsk => ({
  requestId: "old-1",
  tool: "gmail_send",
  turn: 1,
  targetHash: null,
  ...over,
});
const incoming = (over: Partial<IncomingAsk> = {}): IncomingAsk => ({
  tool: "gmail_send",
  turn: 2,
  targetHash: null,
  ...over,
});

describe("selectSupersededAsks", () => {
  it("withdraws an older card for the same tool raised in an earlier turn", () => {
    expect(selectSupersededAsks(incoming(), [ask()])).toEqual(["old-1"]);
  });

  it("withdraws every older matching card, not only the first", () => {
    const open = [ask({ requestId: "a" }), ask({ requestId: "b", turn: 0 })];
    expect(selectSupersededAsks(incoming({ turn: 3 }), open)).toEqual(["a", "b"]);
  });

  it("keeps both when the older card was raised in the same turn", () => {
    expect(selectSupersededAsks(incoming({ turn: 1 }), [ask({ turn: 1 })])).toEqual([]);
  });

  it("keeps a card from a later turn than the new one", () => {
    expect(selectSupersededAsks(incoming({ turn: 1 }), [ask({ turn: 5 })])).toEqual([]);
  });

  it("keeps both when the tool differs", () => {
    expect(selectSupersededAsks(incoming(), [ask({ tool: "gmail_draft" })])).toEqual([]);
  });

  it("does nothing when nothing is pending", () => {
    expect(selectSupersededAsks(incoming(), [])).toEqual([]);
  });

  it("keeps both when both have a target and the targets differ", () => {
    expect(selectSupersededAsks(incoming({ targetHash: "x" }), [ask({ targetHash: "y" })])).toEqual([]);
  });

  it("withdraws when both have the same target", () => {
    expect(selectSupersededAsks(incoming({ targetHash: "x" }), [ask({ targetHash: "x" })])).toEqual(["old-1"]);
  });

  it("does not let a missing target block: the new card has none", () => {
    expect(selectSupersededAsks(incoming({ targetHash: null }), [ask({ targetHash: "y" })])).toEqual(["old-1"]);
  });

  it("does not let a missing target block: the old card has none", () => {
    expect(selectSupersededAsks(incoming({ targetHash: "x" }), [ask({ targetHash: null })])).toEqual(["old-1"]);
  });

  it("leaves a card with no recorded turn alone (written before the session columns)", () => {
    expect(selectSupersededAsks(incoming(), [ask({ turn: null })])).toEqual([]);
  });

  it("compares extension tool names as given", () => {
    expect(
      selectSupersededAsks(incoming({ tool: "agent-kit__vault_write" }), [ask({ tool: "agent-kit__vault_write" })]),
    ).toEqual(["old-1"]);
  });
});

describe("approvalTarget", () => {
  it("mail: the thread when there is one", () => {
    expect(approvalTarget("gmail_send", { to: ["a@example.com"], threadId: "t1" })).toBe("thread:t1");
    expect(approvalTarget("gmail_draft", { to: ["a@example.com"], threadId: "t1" })).toBe("thread:t1");
  });

  it("mail: otherwise the recipients, whatever the order or case", () => {
    expect(approvalTarget("gmail_send", { to: ["B@example.com", "a@example.com"] })).toBe("to:a@example.com,b@example.com");
    expect(approvalTarget("gmail_send", { to: ["a@example.com", "b@example.com"] })).toBe(
      approvalTarget("gmail_send", { to: ["b@example.com", "A@example.com"] }),
    );
  });

  it("follow-up mail and its redraft: the meeting page", () => {
    expect(approvalTarget("meeting_followup_send", { notionPageId: "p1", to: ["a@example.com"] })).toBe("page:p1");
    expect(approvalTarget("meeting_followup_redraft", { notionPageId: "p1" })).toBe("page:p1");
  });

  it("calendar: the event id; create has none", () => {
    expect(approvalTarget("calendar_update_event", { eventId: "e1" })).toBe("event:e1");
    expect(approvalTarget("calendar_delete_event", { eventId: "e1" })).toBe("event:e1");
    expect(approvalTarget("calendar_create_event", { summary: "x" })).toBeUndefined();
  });

  it("proposals: the proposal id", () => {
    expect(approvalTarget("memory_resolve_proposal", { id: 7, decision: "approve" })).toBe("proposal:7");
  });

  it("vault notes: the area plus title or path, under either tool name", () => {
    expect(approvalTarget("vault_write", { area: "work", title: "A note", body: "b" })).toBe("note:work/A note");
    expect(approvalTarget("agent-kit__vault_write", { area: "work", title: "A note", body: "b" })).toBe("note:work/A note");
    expect(approvalTarget("agent-kit__vault_drop", { area: "work", path: "_inbox/a.md" })).toBe("note:work/_inbox/a.md");
  });

  it("an unknown tool has no target", () => {
    expect(approvalTarget("some_new_tool", { threadId: "t1", to: ["a@example.com"] })).toBeUndefined();
  });

  it("odd input has no target and never throws", () => {
    expect(approvalTarget("gmail_send", null)).toBeUndefined();
    expect(approvalTarget("gmail_send", "x")).toBeUndefined();
    expect(approvalTarget("gmail_send", { to: [] })).toBeUndefined();
    expect(approvalTarget("gmail_send", { to: [3] })).toBeUndefined();
    expect(approvalTarget("calendar_update_event", { eventId: "" })).toBeUndefined();
  });
});

describe("targetFingerprint", () => {
  it("is a hash that does not contain the target, and is null without one", () => {
    const h = targetFingerprint("gmail_send", { to: ["a@example.com"] });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(targetFingerprint("some_new_tool", { to: ["a@example.com"] })).toBeNull();
  });

  it("is equal for the same target and different for another", () => {
    expect(targetFingerprint("gmail_send", { to: ["a@example.com"], subject: "one" })).toBe(
      targetFingerprint("gmail_send", { to: ["a@example.com"], subject: "two" }),
    );
    expect(targetFingerprint("gmail_send", { to: ["a@example.com"] })).not.toBe(
      targetFingerprint("gmail_send", { to: ["b@example.com"] }),
    );
  });
});
