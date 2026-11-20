import { describe, it, expect } from "vitest";
import { contractClauses, noCommitmentsClause } from "@lares/compose-contract";
import { extractConfirmMarkers } from "@lares/agent-kit/confirm-markers";
import { buildReplyPrompt } from "../lib/reply-prompt.js";
import { buildFollowupPrompt } from "../lib/meeting-followup.js";
import { EXTENSION_THREAD, gradeDraft } from "./support/draft-promises.js";

// The eval case behind "a draft never promises what nobody agreed": an invented customer thread
// asking to extend a delivery and add a segment. The deterministic half is here (the prompt carries
// the rule and the grader is right about good and bad drafts); the half that needs a real model is
// tests/live/draft-promises.live.mts, run by hand.

const BAD_DRAFTS = [
  // the shape of the original failure: a date promise, a later-confirmation promise, a price offer
  "Hi Jordan,\n\nI'll confirm as soon as possible whether Monday is realistic. We can add the north-region segment and settle the price on a call.\n",
  "Hi Jordan,\n\nYes, two weeks is fine. The new delivery date is 14 March and the extra segment is 2,000 EUR.\n",
  "Hi Jordan,\n\nWe can extend it. I will confirm the price for the extra segment tomorrow.\n",
];

const GOOD_DRAFT =
  "Hi Jordan,\n\nThanks for letting me know. On the extension: [confirm: new delivery date]. " +
  "On the north-region segment: [confirm: price and scope for the extra segment]. " +
  "Could you tell me which fields you need in it?\n";

describe("the extension-thread eval case", () => {
  it("fails every draft that promises a date, a price or a later confirmation", () => {
    for (const d of BAD_DRAFTS) expect(gradeDraft(d).pass, d).toBe(false);
  });

  it("passes a draft that leaves markers and asks the customer something that commits to nothing", () => {
    const g = gradeDraft(GOOD_DRAFT);
    expect(g.pass, g.problems.join("; ")).toBe(true);
    expect(g.markers).toEqual(["new delivery date", "price and scope for the extra segment"]);
  });

  it("fails a draft that is vague but leaves nothing for the owner to answer", () => {
    expect(gradeDraft("Hi Jordan,\n\nThanks, we will look at it.\n").problems).toContain("leaves no [confirm: …] marker");
  });

  it("does not mistake text inside a marker for a promise", () => {
    expect(gradeDraft("Hi,\n\n[confirm: delivery date, Monday or later?]\n").pass).toBe(true);
  });
});

describe("the reply prompt carries the rule for the extension thread", () => {
  const prompt = buildReplyPrompt({
    account: "owner@project.example", lang: "en", voiceBlock: "", examples: [], contextBlocks: "", closing: "End with the first name only.",
    original: { from: EXTENSION_THREAD.from, subject: EXTENSION_THREAD.subject, body: EXTENSION_THREAD.body },
  });

  it("has the no-promises clause and the marker spelling", () => {
    expect(prompt).toContain(noCommitmentsClause());
    expect(prompt).toContain("[confirm: <what the owner must decide>]");
  });

  it("lets the format line allow a marker (so 'no placeholders' cannot cancel it)", () => {
    expect(prompt).toMatch(/only bracket allowed is a \[confirm: …\] marker/);
  });

  it("quotes the customer's ask inside the outside-text block, after the rule", () => {
    expect(prompt.indexOf(noCommitmentsClause())).toBeLessThan(prompt.indexOf("extend the delivery by two weeks"));
  });

  it("the meeting follow-up drafter gets the same rule from the same clause", () => {
    const p = buildFollowupPrompt({
      lang: "en", ownerName: "Owner", voiceBlock: "", title: "Sync", whenIso: "2026-11-02T10:00:00Z",
      recipients: ["a@example.com"], summaryBlock: "We talked.", actionItems: ["Send notes"],
    });
    expect(p).toContain(noCommitmentsClause());
  });

  it("every drafter's stack is exactly the compose contract's", () => {
    expect(prompt).toContain(contractClauses({ lang: "en", noCommitments: true }));
  });
});

describe("the marker a drafter writes is the marker the card and ping read", () => {
  it("the clause's own example spellings parse", () => {
    expect(extractConfirmMarkers("[confirm: new delivery date] and [confirm: price for the extra segment]"))
      .toEqual(["new delivery date", "price for the extra segment"]);
  });
});
