import { describe, it, expect } from "vitest";
import { sourcesHash, bodyHash } from "../lib/fingerprint.js";
import type { ResolvedSource } from "../lib/resolve.js";

const found = (locator: string, content: string): ResolvedSource =>
  ({ ref: { prefix: "repo", locator, declared: `repo:${locator}` }, outcome: "found", content });
const missing = (locator: string): ResolvedSource =>
  ({ ref: { prefix: "repo", locator, declared: `repo:${locator}` }, outcome: "missing", reason: "404" });

describe("sourcesHash", () => {
  it("is stable across runs for identical input", () => {
    const a = [found("a.md", "one"), found("b.md", "two")];
    expect(sourcesHash(a)).toBe(sourcesHash([found("a.md", "one"), found("b.md", "two")]));
  });

  it("changes when a source's CONTENT changes", () => {
    expect(sourcesHash([found("a.md", "one")])).not.toBe(sourcesHash([found("a.md", "ONE")]));
  });

  it("changes when a source is ADDED or REMOVED", () => {
    expect(sourcesHash([found("a.md", "one")])).not.toBe(sourcesHash([found("a.md", "one"), found("b.md", "two")]));
  });

  it("depends on ORDER, because the declared order is part of the contract", () => {
    expect(sourcesHash([found("a.md", "one"), found("b.md", "two")]))
      .not.toBe(sourcesHash([found("b.md", "two"), found("a.md", "one")]));
  });

  it("includes each source's LOCATOR, so a renamed file with identical content is a change", () => {
    expect(sourcesHash([found("a.md", "one")])).not.toBe(sourcesHash([found("b.md", "one")]));
  });

  it("REFUSES to hash a list containing a source that did not resolve", () => {
    // Hashing an unhealthy set is how "I could not read it" becomes "there is nothing to
    // say": the hash would differ from last time, a proposal would be raised, and the draft
    // would be written from a shrunken source set.
    expect(() => sourcesHash([found("a.md", "one"), missing("b.md")])).toThrow(/did not resolve/i);
  });

  it("does not let the LOCATOR/CONTENT boundary shift — 'ab'+'c' must differ from 'a'+'bc'", () => {
    // Without any framing, concatenating locator and content would make these two lists
    // indistinguishable ("repo:ab" + "c" === "repo:a" + "bc"). This is what the per-part
    // length prefix exists to prevent.
    expect(sourcesHash([found("ab", "c")])).not.toBe(sourcesHash([found("a", "bc")]));
  });

  it("does not collide across an ENTRY boundary when content embeds a fake locator", () => {
    // The exact collision the old NUL-separator-only scheme was vulnerable to: one entry
    // whose content contains "\0repo:q\0z" hashed identically to two entries "q"→"z" split
    // out of it, because a flat byte stream with a fixed separator carries no information
    // about how many entries it encodes. A length-prefixed encoding cannot be fooled this
    // way — the reader (conceptually) never searches for a separator inside the data, it
    // consumes an exact, pre-declared byte count, so there is no byte sequence content can
    // contain that gets mistaken for "one more entry".
    expect(sourcesHash([found("a", "p\0repo:q\0z")]))
      .not.toBe(sourcesHash([found("a", "p"), found("q", "z")]));
  });
});

describe("bodyHash", () => {
  it("ignores trailing whitespace differences that no human made", () => {
    expect(bodyHash("## What it is\n\nText.\n")).toBe(bodyHash("## What it is\n\nText.\n\n\n"));
  });

  it("is sensitive to real prose changes", () => {
    expect(bodyHash("## What it is\n\nText.\n")).not.toBe(bodyHash("## What it is\n\nOther text.\n"));
  });

  it("is sensitive to a markdown hard line break (trailing double-space)", () => {
    // Two trailing spaces at the end of a line is a `<br>` in markdown — real authored
    // content, not editor churn. Folding it away would let an edit through undetected.
    const noBreak = "Line one\nLine two\n";
    const hardBreak = "Line one  \nLine two\n";
    expect(bodyHash(noBreak)).not.toBe(bodyHash(hardBreak));
  });
});
