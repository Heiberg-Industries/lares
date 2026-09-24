import { describe, it, expect } from "vitest";
import { parseNote, setFrontmatterKeys } from "../lib/frontmatter.js";

const NOTE = `---
brand: soma
status: exploration
one_liner: A design-led, activity-first hospitality concept.
canonical_sources: ["notion:2f5cc987-b457-8094-a784-cbcc9b67493f"]
last_synced: 2026-08-11
tags: [venture, hospitality]
---

## What it is

SOMA is a concept.
`;

describe("parseNote", () => {
  it("splits frontmatter from body", () => {
    const n = parseNote(NOTE);
    expect(n.frontmatter["brand"]).toBe("soma");
    expect(n.frontmatter["canonical_sources"]).toEqual(["notion:2f5cc987-b457-8094-a784-cbcc9b67493f"]);
    expect(n.body.trim().startsWith("## What it is")).toBe(true);
  });

  it("throws on a file with no frontmatter block", () => {
    expect(() => parseNote("# Just a heading\n")).toThrow(/frontmatter/i);
  });

  it("throws on an unterminated frontmatter block", () => {
    expect(() => parseNote("---\nbrand: x\n\n# body\n")).toThrow(/frontmatter/i);
  });
});

describe("setFrontmatterKeys", () => {
  it("is byte-identical when the update matches what is already there", () => {
    expect(setFrontmatterKeys(NOTE, { last_synced: "2026-08-11" })).toBe(NOTE);
  });

  it("rewrites only the named key; exactly one line differs", () => {
    const out = setFrontmatterKeys(NOTE, { last_synced: "2026-09-01" });
    const before = NOTE.split("\n");
    const after = out.split("\n");
    expect(after.length).toBe(before.length);
    expect(after.filter((l, i) => l !== before[i])).toEqual(["last_synced: 2026-09-01"]);
  });

  it("inserts a missing key as the first frontmatter line", () => {
    const out = setFrontmatterKeys(NOTE, { type: "venture" });
    expect(out.split("\n")[1]).toBe("type: venture");
    expect(parseNote(out).frontmatter["brand"]).toBe("soma");
  });

  it("inserts after type: when type is already present", () => {
    const withType = setFrontmatterKeys(NOTE, { type: "venture" });
    const out = setFrontmatterKeys(withType, { public_url: "—" });
    expect(out.split("\n")[2]).toBe("public_url: —");
  });

  it("never touches the body", () => {
    const out = setFrontmatterKeys(NOTE, { last_synced: "2026-09-01" });
    const tail = (s: string) => s.slice(s.indexOf("\n---\n") + 5);
    expect(tail(out)).toBe(tail(NOTE));
  });

  it("leaves a non-canonically-spaced line byte-identical when the value is unchanged", () => {
    const odd = "---\nbrand: soma\nstatus:   exploration\n---\n\nbody\n";
    expect(setFrontmatterKeys(odd, { status: "exploration" })).toBe(odd);
  });

  it("still rewrites a non-canonically-spaced line when the value REALLY changes", () => {
    const odd = "---\nbrand: soma\nstatus:   exploration\n---\n\nbody\n";
    expect(setFrontmatterKeys(odd, { status: "parked" })).toContain("status: parked");
    expect(setFrontmatterKeys(odd, { status: "parked" })).not.toContain("exploration");
  });
});
