import { describe, it, expect, afterEach } from "vitest";

import { cardTitle, registerApprovalSummary, summarizeApproval, withCardTitle } from "@lares/agent-kit/approval-summary";

// Pure summarizeApproval() formatting coverage lives in
// packages/agent-kit/tests/approval-summary.test.ts — this file keeps only the half that is
// chief-of-staff's own: the card title eve 1.0 shows, which is the `prompt` of a gated tool's
// object-form `approval` (it replaces the framework patch that used to edit eve's title line).
describe("the card title — eve's approval `prompt` USES the summary", () => {
  afterEach(() => {
    delete globalThis.__eveApprovalSummary;
  });

  /** What eve passes the callback for a call awaiting approval. */
  const ask = (toolName: string, input: unknown) => ({ callId: "call_1", toolName, input });
  const prompt = (withCardTitle(() => "user-approval") as unknown as { prompt: (c: unknown) => unknown }).prompt;

  it("renders our summary as the card title", () => {
    registerApprovalSummary();
    expect(prompt(ask("gmail_send", { to: ["tor@ledgerly.example"], subject: "Re: Acme" }))).toBe('Send email to tor@ledgerly.example — "Re: Acme"');
  });

  it("is the same function whether or not a clock was registered, and uses the home clock until one is", () => {
    expect(prompt).toBe(cardTitle);
    expect(prompt(ask("gmail_send", { to: ["tor@ledgerly.example"], subject: "Re: Acme" }))).toBe('Send email to tor@ledgerly.example — "Re: Acme"');
  });

  it("gives a tool with no dedicated formatter the generic title, which is never worse than eve's own", () => {
    expect(prompt(ask("gmail_send_unknown", {}))).toBe("Approve tool call: gmail_send_unknown");
  });

  it("returns undefined, and never throws into eve, when the formatter cannot cope", () => {
    // A formatter that threw would stop the card being drawn, and eve has no try/catch around the
    // callback. The title function swallows it and answers nothing, so eve uses its own title.
    const hostile = { get to(): never { throw new Error("formatter blew up"); } };
    expect(() => prompt(ask("gmail_send", hostile))).not.toThrow();
    const out = prompt(ask("gmail_send", hostile));
    expect(out === undefined || typeof out === "string").toBe(true);
    expect(prompt(ask(undefined as never, {}))).toBeUndefined();
  });
});

describe("meeting_followup_send card", () => {
  it("names the meeting and every recipient, so a wrong match is visible before sending", () => {
    const summary = summarizeApproval("meeting_followup_send", {
      meetingTitle: "Weekly Sync",
      meetingWhen: "2026-08-24T10:00:00.000+02:00",
      to: ["sam@example.com", "taylor@example.com"],
      subject: "Oppsummering — Weekly Sync, 24. august",
    });
    expect(summary).toContain("Weekly Sync");
    expect(summary).toContain("sam@example.com");
    expect(summary).toContain("taylor@example.com");
  });

  it("never renders 'Invalid Date' when the model supplies something unparseable", () => {
    const summary = summarizeApproval("meeting_followup_send", {
      meetingTitle: "Weekly Sync", meetingWhen: "sometime tuesday",
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

describe("meeting_followup_auto card", () => {
  it("names both the meeting and the level on a well-formed call", () => {
    const summary = summarizeApproval("meeting_followup_auto", {
      seriesKey: "s1",
      level: "autonomous",
      meetingName: "Weekly Sync",
    });
    expect(summary).toContain("Weekly Sync");
    expect(summary).toContain("autonomous");
  });

  it("falls back to the generic dump rather than render the level as silently missing", () => {
    // `level` is not a nice-to-have on this card — it IS the decision, and `autonomous` vs
    // `never` are opposites. Dropping it the way `line()` drops any other absent field would
    // render "Set meeting follow-ups for "the sync meeting" to" with the actual choice missing, so
    // the formatter must refuse to render at all rather than hand a human a half sentence.
    const summary = summarizeApproval("meeting_followup_auto", { meetingName: "Weekly Sync" });
    expect(summary).not.toMatch(/to\s*$/);
    expect(summary).toBe("meeting_followup_auto — meetingName: Weekly Sync");
  });

  it("falls back on a non-string level, same reasoning — a wrong type is not a level", () => {
    // `str()` (this file's own field-validity check) stringifies numbers/booleans same as
    // every other formatter does — so a level like 42 is not the interesting non-string
    // case, it is genuinely un-coercible input (an object, here) that `str()` correctly
    // refuses. `generic()`'s own per-field filter then drops that same field entirely, so
    // the fallback reads identically to the missing-level case — the point under test is
    // that the half-rendered SENTENCE never appears either way.
    const summary = summarizeApproval("meeting_followup_auto", { meetingName: "Weekly Sync", level: { oops: true } });
    expect(summary).not.toContain("Set meeting follow-ups for");
    // The dropped `level` is a field the title left out, and the title now says so.
    expect(summary).toBe("meeting_followup_auto — meetingName: Weekly Sync (shortened)");
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
