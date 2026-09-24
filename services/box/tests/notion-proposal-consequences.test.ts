// The ONE place a decision's consequence becomes a sentence (Phase 4, fix round 3).
//
// Why this file exists: six human-facing surfaces each wrote their own version of
// "what does Reject do", and when the engine changed what Reject does for a
// Notion-owned document, five of them went on promising a revert that no longer
// happened. A sentence written in one place can be wrong once and fixed once.
//
// These tests are pure — no database, no container — because the functions are.
import { describe, it, expect } from "vitest";
import {
  rejectOutcome, rejectConsequence, approveConsequence,
} from "../lib/notion-proposals.js";

const UPDATE_MIRROR = { kind: "update" as const, notionOwned: false };
const UPDATE_OWNED = { kind: "update" as const, notionOwned: true };
const CREATE = { kind: "create" as const, notionOwned: false };

describe("rejectOutcome — three outcomes, not two", () => {
  it("maps each shape to its own outcome", () => {
    expect(rejectOutcome(UPDATE_MIRROR)).toBe("notion-reverted");
    expect(rejectOutcome(UPDATE_OWNED)).toBe("notion-untouched");
    expect(rejectOutcome(CREATE)).toBe("not-created");
  });

  // `kind` settles it first: a create has no "before" side on either end, so there
  // is no row whose direction could matter. A create proposal's `notionOwned` is
  // false purely because no docs row exists yet, and that must not leak into the
  // answer.
  it("ignores notionOwned for a create, whichever way it is set", () => {
    expect(rejectOutcome({ kind: "create", notionOwned: false })).toBe("not-created");
    expect(rejectOutcome({ kind: "create", notionOwned: true })).toBe("not-created");
  });
});

describe("rejectConsequence — the sentence every surface renders", () => {
  it("promises a Notion revert ONLY for a mirror or two-way edit", () => {
    expect(rejectConsequence(UPDATE_MIRROR)).toMatch(/reverted back to it/);
  });

  // The regression the whole round exists to prevent. Round 2 stopped the engine
  // reverting Notion for these rows; six strings kept saying it did.
  it("NEVER promises a revert for a Notion-owned document", () => {
    const text = rejectConsequence(UPDATE_OWNED);
    expect(text).not.toMatch(/revert/i);
    expect(text).toMatch(/left as it is/);
    expect(text).toMatch(/nothing is written on either side/);
  });

  it("NEVER promises a revert for a create", () => {
    const text = rejectConsequence(CREATE);
    expect(text).not.toMatch(/revert/i);
    expect(text).toMatch(/not created/);
    expect(text).toMatch(/nothing in Notion changes/);
  });

  it("gives all three shapes distinct sentences — none can be mistaken for another", () => {
    const all = [UPDATE_MIRROR, UPDATE_OWNED, CREATE].map(rejectConsequence);
    expect(new Set(all).size).toBe(3);
  });
});

describe("approveConsequence", () => {
  it("says CREATED for a create and WRITTEN for an edit", () => {
    expect(approveConsequence(CREATE)).toMatch(/the file is created in the vault/);
    expect(approveConsequence(UPDATE_MIRROR)).toMatch(/the edit is written into the vault file/);
    // Approve is the same act whichever side owns the document — only Reject differs.
    expect(approveConsequence(UPDATE_OWNED)).toBe(approveConsequence(UPDATE_MIRROR));
  });

  it("always says the write is on the NEXT tick, never that it has happened", () => {
    for (const row of [UPDATE_MIRROR, UPDATE_OWNED, CREATE]) {
      expect(approveConsequence(row)).toMatch(/next sync tick/);
    }
  });
});
