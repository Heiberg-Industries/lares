import { describe, it, expect } from "vitest";
import { extractSummaryBlock } from "../agent/schedules/meeting-followup.js";

// The `<summary>` extractor decides what text reaches a customer's inbox — it must never
// leak the `<transcript>` block (or, per fix round 2, an unrelated `<details><summary>`
// disclosure elsewhere on the page), and it must degrade to "" (never throw, never guess)
// when the page has no summary block at all. These cases had no unit coverage of their own
// before this file (Task 8 fix round 1), and the extractor is now anchored inside
// `<meeting-notes>` rather than matching a bare `<summary>` anywhere on the page (fix round 2).
describe("extractSummaryBlock (ORB-156)", () => {
  it("extracts a normal <summary>…</summary> block", () => {
    const markdown = [
      "# Folkepuls",
      "",
      "<meeting-notes>",
      "<summary>",
      "### Handlingspunkter",
      "- Stefan: domener",
      "</summary>",
      "</meeting-notes>",
    ].join("\n");
    expect(extractSummaryBlock(markdown)).toBe("### Handlingspunkter\n- Stefan: domener");
  });

  it("returns \"\" for a page with no summary block at all", () => {
    const markdown = "# Folkepuls\n\nJust some notes, no meeting-notes block on this page.";
    expect(extractSummaryBlock(markdown)).toBe("");
  });

  it("handles a block containing nested angle brackets", () => {
    const markdown = [
      "<meeting-notes>",
      "<summary>",
      "Revenue estimate: <5% churn vs >10% target.",
      "Reference link: <https://example.com/deck>",
      "</summary>",
      "</meeting-notes>",
    ].join("\n");
    const result = extractSummaryBlock(markdown);
    expect(result).toContain("Revenue estimate: <5% churn vs >10% target.");
    expect(result).toContain("Reference link: <https://example.com/deck>");
  });

  it("handles the tags on the same line as the content", () => {
    const markdown = "<meeting-notes><summary>Quick recap: shipped v1, no blockers.</summary></meeting-notes>";
    expect(extractSummaryBlock(markdown)).toBe("Quick recap: shipped v1, no blockers.");
  });

  it("handles an attributed <summary lang=\"no\"> tag", () => {
    const markdown = [
      "<meeting-notes>",
      '<summary lang="no">',
      "Rask oppsummering på norsk.",
      "</summary>",
      "</meeting-notes>",
    ].join("\n");
    expect(extractSummaryBlock(markdown)).toBe("Rask oppsummering på norsk.");
  });

  it("ignores an unrelated <details><summary> disclosure earlier on the page", () => {
    // Ordinary markdown/HTML disclosure markup, not the meeting-notes feature's own tag —
    // a bare, unanchored /<summary>…<\/summary>/ would have matched this FIRST and composed
    // the decoy label into the email instead of the real recap (fix round 2, Important).
    const markdown = [
      "<details>",
      "<summary>Click to expand raw notes</summary>",
      "some collapsed scratch content, never meant to be read",
      "</details>",
      "",
      "<meeting-notes>",
      "<summary>",
      "The real recap — this is what may go out.",
      "</summary>",
      "</meeting-notes>",
    ].join("\n");
    const result = extractSummaryBlock(markdown);
    expect(result).toBe("The real recap — this is what may go out.");
    expect(result).not.toContain("Click to expand");
  });

  it("reads the FIRST <meeting-notes> block when a page carries more than one", () => {
    const markdown = [
      "<meeting-notes>",
      "<summary>First block — this one wins.</summary>",
      "</meeting-notes>",
      "",
      "<meeting-notes>",
      "<summary>Second block — must not be used.</summary>",
      "</meeting-notes>",
    ].join("\n");
    const result = extractSummaryBlock(markdown);
    expect(result).toBe("First block — this one wins.");
    expect(result).not.toContain("Second block");
  });

  it("NEVER returns the <transcript> block's contents — summary after transcript", () => {
    const markdown = [
      "<meeting-notes>",
      "<summary>",
      "The real recap — this is what may go out.",
      "</summary>",
      "<transcript>",
      "RAW WORD-FOR-WORD TRANSCRIPT — must never reach an external inbox.",
      "</transcript>",
      "</meeting-notes>",
    ].join("\n");
    const result = extractSummaryBlock(markdown);
    expect(result).toBe("The real recap — this is what may go out.");
    expect(result).not.toContain("RAW WORD-FOR-WORD TRANSCRIPT");
  });

  it("NEVER returns the <transcript> block's contents — transcript before summary", () => {
    const markdown = [
      "<meeting-notes>",
      "<transcript>",
      "RAW WORD-FOR-WORD TRANSCRIPT — must never reach an external inbox.",
      "</transcript>",
      "<summary>",
      "Clean recap only.",
      "</summary>",
      "</meeting-notes>",
    ].join("\n");
    const result = extractSummaryBlock(markdown);
    expect(result).toBe("Clean recap only.");
    expect(result).not.toContain("RAW WORD-FOR-WORD TRANSCRIPT");
  });
});
