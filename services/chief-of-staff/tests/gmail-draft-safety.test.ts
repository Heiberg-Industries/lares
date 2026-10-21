import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  draft: vi.fn(), readThread: vi.fn(), aliases: vi.fn(), mailboxes: vi.fn(),
}));
vi.mock("../lib/google.js", () => ({
  googleClients: () => ({ gmail: async () => ({ draft: mocks.draft, readThread: mocks.readThread }) }),
  listEnrolledMailboxes: mocks.mailboxes,
}));
vi.mock("../lib/identity-client.js", () => ({ configuredOwnerId: () => "owner", listAliases: mocks.aliases }));
vi.mock("@lares/agent-kit/db", () => ({ getPool: () => ({}) }));
import gmailDraft from "../catalogue/gmail_draft.js";
import { currentTaint, resetTaintForTests } from "@lares/agent-kit/origin-taint";

const context = { session: { id: "s1", turn: { id: "t1" } } } as never;
const key = { sessionId: "s1", turnId: "t1" };
const input = { from: "owner@example.com", to: ["other@example.com"], cc: ["copy@example.com"], subject: "Re: question", bodyText: "Thanks", threadId: "t1", inReplyTo: "<original>" };
const original = { messageId: "<original>", from: "Sender <sender@example.com>", to: ["other@example.com"], cc: ["copy@example.com"], headers: { "reply-to": "list@example.com" } };

beforeEach(() => {
  vi.clearAllMocks();
  resetTaintForTests();
  mocks.aliases.mockResolvedValue(["owner@example.com", "alias@example.com"]);
  mocks.mailboxes.mockResolvedValue(["owner@example.com"]);
  mocks.readThread.mockResolvedValue([original]);
  mocks.draft.mockResolvedValue({ gmailDraftId: "d1", gmailMessageId: "m1", gmailThreadId: "t1" });
});

describe("gmail_draft reply recipient safety", () => {
  it("forces a hidden owner reply to the sender alone and explains why", async () => {
    const result = await gmailDraft.execute(input, context);
    expect(mocks.draft).toHaveBeenCalledWith({ ...input, to: ["Sender <sender@example.com>"], cc: [] });
    expect(result).toMatchObject({ draftNote: expect.stringContaining("Private sender-only") });
    expect(currentTaint(key)).toBe("third_party");
  });
  it("uses registry aliases and preserves explicit recipients for a visible owner", async () => {
    mocks.readThread.mockResolvedValue([{ ...original, cc: ["Alias <ALIAS@EXAMPLE.COM>"] }]);
    await gmailDraft.execute(input, context);
    expect(mocks.draft).toHaveBeenCalledWith(input);
  });
  it("cannot treat a caller-supplied From address as proof the owner was visible", async () => {
    await gmailDraft.execute({ ...input, from: "other@example.com" }, context);
    expect(mocks.draft).toHaveBeenCalledWith(expect.objectContaining({ to: ["Sender <sender@example.com>"], cc: [] }));
  });
  it("fails closed when aliases cannot be read", async () => {
    mocks.aliases.mockRejectedValue(new Error("registry unavailable"));
    await expect(gmailDraft.execute(input, context)).rejects.toThrow("registry unavailable");
    expect(mocks.draft).not.toHaveBeenCalled();
  });
  it("refuses an unverifiable original, and still taints the successful outside read", async () => {
    mocks.readThread.mockResolvedValue([]);
    await expect(gmailDraft.execute(input, context)).rejects.toThrow("original message could not be found");
    expect(mocks.draft).not.toHaveBeenCalled();
    expect(currentTaint(key)).toBe("third_party");
  });
  it("refuses a hidden reply with a malformed sender", async () => {
    mocks.readThread.mockResolvedValue([{ ...original, from: "bad\r\nCc: exposed@example.com" }]);
    await expect(gmailDraft.execute(input, context)).rejects.toThrow("safe reply address");
    expect(mocks.draft).not.toHaveBeenCalled();
  });
  it("refuses partial threading rather than creating an unchecked reply", async () => {
    await expect(gmailDraft.execute({ ...input, inReplyTo: undefined }, context)).rejects.toThrow("both threadId and inReplyTo");
    expect(mocks.draft).not.toHaveBeenCalled();
  });
  it("keeps new-message drafts independent of reply checks", async () => {
    const fresh = { ...input, threadId: undefined, inReplyTo: undefined };
    await gmailDraft.execute(fresh, context);
    expect(mocks.draft).toHaveBeenCalledWith(fresh);
    expect(mocks.aliases).not.toHaveBeenCalled();
    expect(mocks.readThread).not.toHaveBeenCalled();
  });
});
