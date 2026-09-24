import { describe, it, expect, afterEach } from "vitest";

import { registerApprovalSummary, summarizeApproval } from "@lares/agent-kit/approval-summary";

// Deep import into eve's dist — an INTERNAL, reached on purpose. This is the half of the
// suite that pins our pnpm patch on eve@0.60.1 (patches/eve.patch, third hunk). If an eve
// upgrade moves or renames this module, the import fails and THAT is the signal to
// re-derive the patch — the same convention as tests/eve-hitl-expiry-notice.test.ts.
// @ts-expect-error — no types shipped for eve internals
import { extractToolApprovalInputRequests } from "eve-internals/input-extraction";

// Pure summarizeApproval() formatting coverage lives in
// packages/agent-kit/tests/approval-summary.test.ts (ORB-142 Task C) — this file keeps only
// the half that is genuinely eve-saga's own: proving the eve patch actually wires the shared
// formatter into the approval-card title, which depends on eve-internals and the pnpm patch
// that only exists in this workspace member.
describe("the eve patch — the card actually USES the summary", () => {
  afterEach(() => {
    delete globalThis.__eveApprovalSummary;
  });

  /** The shape eve's harness parses out of a turn's content: the tool call, plus the
   *  approval request that references it by id. */
  const content = (toolName: string, input: unknown) => [
    { type: "tool-call", toolCallId: "call_1", toolName, input },
    { type: "tool-approval-request", approvalId: "appr_1", toolCallId: "call_1" },
  ];

  it("renders our summary as the card title once registered", () => {
    registerApprovalSummary();
    const [request] = extractToolApprovalInputRequests({
      content: content("gmail_send", { to: ["jonas@finago.com"], subject: "Re: Orakel" }),
    });
    expect(request.prompt).toBe('Send email to jonas@finago.com — "Re: Orakel"');
    // The approve/cancel affordance must be untouched by the patch.
    expect(request.options.map((o: { id: string }) => o.id)).toEqual(["approve", "cancel"]);
  });

  it("falls back to eve's own title when the global is absent", () => {
    // Not hypothetical: patches/eve.patch covers every workspace member, and eve-marcel
    // never registers a formatter. Its cards must keep working, unchanged.
    const [request] = extractToolApprovalInputRequests({
      content: content("gmail_send", { to: ["jonas@finago.com"], subject: "Re: Orakel" }),
    });
    expect(request.prompt).toBe("Approve tool call: gmail_send");
  });

  it("falls back when a formatter throws, rather than losing the card", () => {
    globalThis.__eveApprovalSummary = () => {
      throw new Error("formatter blew up");
    };
    expect(() =>
      extractToolApprovalInputRequests({ content: content("gmail_send", { to: ["a@x.com"] }) }),
    ).toThrow();
    // ^ Documents the boundary honestly: the patch does NOT catch. Safety comes from
    // summarizeApproval never throwing (proven above), which is why the global must only
    // ever be set to that function — registerApprovalSummary is the only writer.
  });
});

describe("meeting_followup_send card (ORB-156)", () => {
  it("names the meeting and every recipient, so a wrong match is visible before sending", () => {
    const summary = summarizeApproval("meeting_followup_send", {
      meetingTitle: "Folkepuls",
      meetingWhen: "2026-08-24T10:00:00.000+02:00",
      to: ["sam@example.com", "taylor@example.com"],
      subject: "Oppsummering — Folkepuls, 24. august",
    });
    expect(summary).toContain("Folkepuls");
    expect(summary).toContain("sam@example.com");
    expect(summary).toContain("taylor@example.com");
  });

  it("never renders 'Invalid Date' when the model supplies something unparseable", () => {
    const summary = summarizeApproval("meeting_followup_send", {
      meetingTitle: "Folkepuls", meetingWhen: "sometime tuesday",
      to: ["a@b.co"], subject: "x",
    });
    expect(summary).not.toContain("Invalid Date");
  });

  it("does not throw on missing or wrong-typed fields", () => {
    // Input is model-supplied and only schema-validated AFTER approval. A formatter that
    // throws takes the approval card with it — a cosmetic feature becoming a gate outage.
    expect(() => summarizeApproval("meeting_followup_send", { to: 42, meetingTitle: null })).not.toThrow();
  });
});

describe("meeting_followup_auto card (ORB-156 Task 12 fix round 1)", () => {
  it("names both the meeting and the level on a well-formed call", () => {
    const summary = summarizeApproval("meeting_followup_auto", {
      seriesKey: "s1",
      level: "autonomous",
      meetingName: "Folkepuls",
    });
    expect(summary).toContain("Folkepuls");
    expect(summary).toContain("autonomous");
  });

  it("falls back to the generic dump rather than render the level as silently missing", () => {
    // `level` is not a nice-to-have on this card — it IS the decision, and `autonomous` vs
    // `never` are opposites. Dropping it the way `line()` drops any other absent field would
    // render "Set meeting follow-ups for "Folkepuls" to" with the actual choice missing, so
    // the formatter must refuse to render at all rather than hand a human a half sentence.
    const summary = summarizeApproval("meeting_followup_auto", { meetingName: "Folkepuls" });
    expect(summary).not.toMatch(/to\s*$/);
    expect(summary).toBe("meeting_followup_auto — meetingName: Folkepuls");
  });

  it("falls back on a non-string level, same reasoning — a wrong type is not a level", () => {
    // `str()` (this file's own field-validity check) stringifies numbers/booleans same as
    // every other formatter does — so a level like 42 is not the interesting non-string
    // case, it is genuinely un-coercible input (an object, here) that `str()` correctly
    // refuses. `generic()`'s own per-field filter then drops that same field entirely, so
    // the fallback reads identically to the missing-level case — the point under test is
    // that the half-rendered SENTENCE never appears either way.
    const summary = summarizeApproval("meeting_followup_auto", { meetingName: "Folkepuls", level: { oops: true } });
    expect(summary).not.toContain("Set meeting follow-ups for");
    expect(summary).toBe("meeting_followup_auto — meetingName: Folkepuls");
  });

  it("falls back when meetingName is missing, even with a well-formed level", () => {
    // The mirror case: a card naming a level but no meeting is just as useless to whoever is
    // about to authorise it — they cannot tell WHICH series is being switched.
    const summary = summarizeApproval("meeting_followup_auto", { level: "never" });
    expect(summary).toBe("meeting_followup_auto — level: never");
  });

  it("does not throw on missing or wrong-typed fields", () => {
    expect(() => summarizeApproval("meeting_followup_auto", { level: 42, meetingName: null })).not.toThrow();
  });
});
