// The ownership vocabulary (Phase 4, T3b fix round 1). These are small, but they
// are the tests that stop the whole class of bug they were written for: every
// branch point used to ask `=== "two_way"` and treat the else-branch as "mirror",
// which silently gave `notion_to_md` the mirror's behaviour on every pass.
import { describe, it, expect } from "vitest";
import {
  MD_TO_NOTION, TWO_WAY, NOTION_TO_MD,
  vaultOwns, notionOwns, notionOwnedPaths, pushHoldBack,
} from "../lib/direction.js";
import type { DeskRow } from "../lib/store.js";

function row(direction: string): DeskRow {
  return {
    pageId: "p", mdHash: "m", notionHash: "n",
    notionLastEdited: null, state: "synced", direction,
  };
}

describe("vaultOwns — the ONLY direction that may write Notion from the vault", () => {
  it("is true for a mirror and false for everything else", () => {
    expect(vaultOwns(MD_TO_NOTION)).toBe(true);
    expect(vaultOwns(TWO_WAY)).toBe(false);
    expect(vaultOwns(NOTION_TO_MD)).toBe(false);
  });

  // The whole point of the positive phrasing: the old `!== "two_way"` said true
  // here, and that one wrong answer is what reverted a Notion-owned page from the
  // vault and recreated it after a human trashed it.
  it("is NOT the negation of two_way", () => {
    const oldTest = (direction: string): boolean => direction !== TWO_WAY;
    expect(oldTest(NOTION_TO_MD)).toBe(true);        // the old code's answer…
    expect(vaultOwns(NOTION_TO_MD)).toBe(false);     // …and the correct one
  });

  it("treats an unknown value as not-a-mirror — the safe direction", () => {
    // A value the schema does not allow can only arrive from a hand-edited row.
    // Refusing to write Notion for it is the failure mode that loses nothing.
    expect(vaultOwns("something-new")).toBe(false);
  });
});

describe("notionOwns", () => {
  it("is true only for notion_to_md", () => {
    expect(notionOwns(NOTION_TO_MD)).toBe(true);
    expect(notionOwns(MD_TO_NOTION)).toBe(false);
    expect(notionOwns(TWO_WAY)).toBe(false);
  });

  it("is never true at the same time as vaultOwns", () => {
    for (const d of [MD_TO_NOTION, TWO_WAY, NOTION_TO_MD, "unknown"]) {
      expect(notionOwns(d) && vaultOwns(d)).toBe(false);
    }
  });
});

describe("pushHoldBack — what NO push may write (Phase 4, review round 1)", () => {
  const linked = (direction: string, target: "docs" | "meetings") =>
    ({ ...row(direction), target });

  it("holds back a path a MEETINGS row owns — the push cannot see that row at all", () => {
    // `getDocRows` is target='docs', so the push reads "no row for this path" as
    // "adopt it": a second Notion page, and an adoption write that repoints the
    // Meetings row at the page it just invented. Config's `exclude` normally keeps
    // the file out of the listing — but that is a line an operator can delete, and
    // this set is derived from the state row, which cannot go missing.
    const rows = new Map([
      ["zero7/a.md", linked(MD_TO_NOTION, "docs")],
      ["zero7/transcripts/2026-08-05-x.md", linked(NOTION_TO_MD, "meetings")],
    ]);
    expect(pushHoldBack(rows)).toEqual(new Set(["zero7/transcripts/2026-08-05-x.md"]));
  });

  it("still holds back a Notion-owned DOCS row — it widens the old set, never replaces it", () => {
    const rows = new Map([
      ["zero7/a.md", linked(MD_TO_NOTION, "docs")],
      ["zero7/b.md", linked(TWO_WAY, "docs")],
      ["zero7/c.md", linked(NOTION_TO_MD, "docs")],
      ["zero7/transcripts/d.md", linked(NOTION_TO_MD, "meetings")],
    ]);
    expect(pushHoldBack(rows)).toEqual(new Set(["zero7/c.md", "zero7/transcripts/d.md"]));
  });

  it("would hold back a meetings row of ANY direction — ownership of the path is the question", () => {
    // Not reachable today (a Meetings row is always notion_to_md), asserted so the
    // guard cannot narrow to a direction check later and silently lose the target half.
    const rows = new Map([["zero7/transcripts/e.md", linked(MD_TO_NOTION, "meetings")]]);
    expect(pushHoldBack(rows)).toEqual(new Set(["zero7/transcripts/e.md"]));
  });
});

describe("notionOwnedPaths — the push pass's hold-back set", () => {
  it("collects exactly the Notion-owned rows", () => {
    const rows = new Map<string, DeskRow>([
      ["zero7/a.md", row(MD_TO_NOTION)],
      ["zero7/b.md", row(TWO_WAY)],
      ["zero7/c.md", row(NOTION_TO_MD)],
      ["orakel/d.md", row(NOTION_TO_MD)],
    ]);
    expect(notionOwnedPaths(rows)).toEqual(new Set(["zero7/c.md", "orakel/d.md"]));
  });

  it("is empty for a snapshot with none — the wiki mirror's case", () => {
    expect(notionOwnedPaths(new Map([["wiki/a.md", row(MD_TO_NOTION)]]))).toEqual(new Set());
  });
});
