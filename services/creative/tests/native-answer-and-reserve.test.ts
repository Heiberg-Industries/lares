/**
 * Two things the creative role's approval rules do differently from the chief of staff's, pinned so
 * that moving the rules into the kit cannot change them unnoticed.
 *
 * 1. The answer check on a native card (Slack). Only the owner may answer, Approve and Deny alike.
 *    Unlike the chief of staff, this role keeps no record of who answered, so it never refuses an
 *    answer for being "not tied to a card" or because "too many answers are waiting".
 * 2. A web chat reservation that cannot be made THROWS here (eve then parks the conversation); the
 *    chief of staff turns the same refusal into a denial with a reason.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { catalogueApprovalRequest, catalogueApprovalResponse, nativeAnswerDecision } from "../lib/approvals.js";

const OWNER = "U0EXAMPLEOWNER";
const OTHER = "U0EXAMPLEOTHER";
const slack = (user: string) => ({ authenticator: "slack-webhook", principalType: "user", principalId: user, attributes: { user_id: user } });
const answer = (principal: unknown, decision: unknown = "approve", interactionId?: string, sessionId?: string) => ({
  request: { ...(interactionId ? { interactionId } : {}), callId: "call-1", toolName: "studio_ideate", toolInput: {} },
  response: { decision, principal },
  session: { ...(sessionId ? { id: sessionId } : {}), turn: { id: "turn-1", sequence: 1 } },
});

beforeEach(() => { process.env["SLACK_ALLOWED_USER_IDS"] = `${OWNER},${OTHER}`; });
afterEach(() => { delete process.env["SLACK_ALLOWED_USER_IDS"]; });

describe("the native answer check", () => {
  it("lets the owner Approve and Deny", () => {
    expect(nativeAnswerDecision(answer(slack(OWNER), "approve", "int-1", "s-1"))).toEqual({ status: "allowed" });
    expect(nativeAnswerDecision(answer(slack(OWNER), "deny", "int-2", "s-1"))).toEqual({ status: "allowed" });
  });

  it("refuses an allowed person who is not the owner, an unknown door, no identity, and anything but Approve or Deny", () => {
    const owner = { status: "rejected", reason: "only the agent's owner can answer this card" };
    expect(nativeAnswerDecision(answer(slack(OTHER)))).toEqual(owner);
    expect(nativeAnswerDecision(answer({ authenticator: "telegram-webhook", attributes: { user_id: OWNER } }))).toEqual(owner);
    expect(nativeAnswerDecision(answer(null))).toEqual(owner);
    expect(nativeAnswerDecision(answer(slack(OWNER), "maybe"))).toEqual({ status: "rejected", reason: "this answer is neither Approve nor Deny" });
  });

  it("refuses everyone when the allow-list is unset", () => {
    delete process.env["SLACK_ALLOWED_USER_IDS"];
    expect(nativeAnswerDecision(answer(slack(OWNER)))).toMatchObject({ status: "rejected" });
  });

  it("keeps no answerer: an answer with no card or conversation id, and many answers in one conversation, are all allowed", () => {
    expect(nativeAnswerDecision(answer(slack(OWNER)))).toEqual({ status: "allowed" });
    for (let i = 0; i < 40; i++) expect(nativeAnswerDecision(answer(slack(OWNER), "approve", `int-${i}`, "s-busy"))).toEqual({ status: "allowed" });
  });

  it("is the response policy for a native card", async () => {
    await expect(catalogueApprovalResponse("studio_ideate", answer(slack(OWNER), "approve", "int-r", "s-r"))).resolves.toEqual({ status: "allowed" });
    await expect(catalogueApprovalResponse("studio_ideate", answer(slack(OTHER)))).resolves.toMatchObject({ status: "rejected" });
  });
});

describe("a web chat reservation that cannot be made", () => {
  it("throws rather than answering with a denial", async () => {
    // A web chat (tagged) request for the one tool this role offers in web chat. This role has no
    // exact-approval adapter, so the reservation is refused before any database read.
    const member = { authenticator: "lares-console", principalId: "member-a", principalType: "user",
      attributes: { lares_member_id: "member-a", lares_admission_nonce: "a".repeat(43), lares_purpose: "human" } };
    const ctx = { callId: "call-1", toolInput: {}, session: { id: "s-web", turn: { id: "turn-1", sequence: 0 }, auth: { current: member, initiator: member } } };
    await expect(catalogueApprovalRequest("lares_read_public_doc", ctx, () => "user-approval"))
      .rejects.toThrow("Exact approval is unavailable for this action target");
  });
});
