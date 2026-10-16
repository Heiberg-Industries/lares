import { describe, it, expect } from "vitest";
import { parseNote } from "../lib/frontmatter.js";
import { parseSourceRef, sourceRefsFor, normaliseCanonicalSources } from "../lib/sources.js";

/** A note's `codebase:`. Only `repo:` refs carry it; the other three stores are single-rooted. */
const CB = "/workspace/example-app";

describe("parseSourceRef", () => {
  it("reads each of the four prefixes", () => {
    expect(parseSourceRef("repo:docs/CURRENT_STATUS.md", { codebase: CB }))
      .toEqual({
        prefix: "repo", locator: "docs/CURRENT_STATUS.md",
        declared: "repo:docs/CURRENT_STATUS.md", codebase: CB,
      });
    expect(parseSourceRef("vault:Example Company/brand/voice.md", { codebase: CB }).prefix).toBe("vault");
    expect(parseSourceRef("notion:00000000-0000-4000-8000-000000000002", { codebase: null }).prefix).toBe("notion");
    expect(parseSourceRef("atlas:icp/example.md", { codebase: CB }).prefix).toBe("atlas");
  });

  it("treats a legacy bare path as repo: when the note has a codebase", () => {
    expect(parseSourceRef("docs/CURRENT_STATUS.md", { codebase: CB }))
      .toEqual({
        prefix: "repo", locator: "docs/CURRENT_STATUS.md",
        declared: "docs/CURRENT_STATUS.md", codebase: CB,
      });
  });

  it("refuses an explicit repo: ref on a note with no codebase", () => {
    // The prefix says "a repository", the note names none, and a bare locator is meaningless
    // without one — so this must fail loudly rather than resolve against some default repo.
    expect(() => parseSourceRef("repo:docs/CURRENT_STATUS.md", { codebase: null }))
      .toThrow(/no codebase/i);
  });

  it("carries the codebase on repo: refs only — the other three stores are single-rooted", () => {
    expect(parseSourceRef("vault:brand/voice.md", { codebase: CB }).codebase).toBeUndefined();
    expect(parseSourceRef("atlas:icp/example.md", { codebase: CB }).codebase).toBeUndefined();
    expect(parseSourceRef("notion:00000000-0000-4000-8000-000000000002", { codebase: CB }).codebase)
      .toBeUndefined();
  });

  it("refuses a bare path on a note with no codebase", () => {
    expect(() => parseSourceRef("README.md", { codebase: null })).toThrow(/no codebase/i);
  });

  it("refuses an unknown prefix rather than guessing a fifth store", () => {
    expect(() => parseSourceRef("gdrive:abc", { codebase: CB })).toThrow(/unknown store prefix/i);
  });

  it("refuses an empty locator", () => {
    expect(() => parseSourceRef("repo:", { codebase: CB })).toThrow(/empty/i);
  });

  it("refuses a locator that escapes its store root", () => {
    expect(() => parseSourceRef("repo:../secrets.md", { codebase: CB })).toThrow(/escape/i);
    expect(() => parseSourceRef("vault:/etc/passwd", { codebase: CB })).toThrow(/escape/i);
  });

  it("refuses a notion locator that is not a page id", () => {
    expect(() => parseSourceRef("notion:not-a-uuid", { codebase: null })).toThrow(/page id/i);
  });

  it("accepts a Notion id in either the hyphenated or the bare 32-hex form", () => {
    expect(parseSourceRef("notion:00000000-0000-4000-8000-000000000002", { codebase: null }).locator)
      .toBe("00000000-0000-4000-8000-000000000002");
    expect(parseSourceRef("notion:00000000000040008000000000000002", { codebase: null }).locator)
      .toBe("00000000000040008000000000000002");
  });

  it("refuses a half-hyphenated Notion id — it is neither form", () => {
    expect(() => parseSourceRef("notion:000000000000-4000-8000000000000002", { codebase: null }))
      .toThrow(/page id/i);
  });

  it("refuses an empty bare entry, the same as an empty prefixed one", () => {
    expect(() => parseSourceRef("", { codebase: CB })).toThrow(/empty/i);
    expect(() => parseSourceRef("   ", { codebase: CB })).toThrow(/empty/i);
  });

  it("refuses a backslash-joined traversal", () => {
    expect(() => parseSourceRef("repo:a\\..\\secrets.md", { codebase: CB })).toThrow(/escape/i);
  });

  it("refuses a percent-encoded traversal", () => {
    expect(() => parseSourceRef("repo:a/%2e%2e/secrets.md", { codebase: CB })).toThrow(/escape/i);
    expect(() => parseSourceRef("repo:a/%2E%2E/secrets.md", { codebase: CB })).toThrow(/escape/i);
  });

  it("still accepts legitimate paths that merely LOOK like traversal", () => {
    expect(parseSourceRef("repo:a/..b/c.md", { codebase: CB }).locator).toBe("a/..b/c.md");
    expect(parseSourceRef("repo:./a/b.md", { codebase: CB }).locator).toBe("./a/b.md");
  });
});

describe("sourceRefsFor", () => {
  const note = parseNote(`---
brand: example-app
codebase: /workspace/example-app/
canonical_sources: [README.md, docs/CURRENT_STATUS.md, atlas:icp/example-service.md]
---

body
`);

  it("parses every declared source, legacy and prefixed alike", () => {
    expect(sourceRefsFor(note).map((r) => `${r.prefix}:${r.locator}`))
      .toEqual(["repo:README.md", "repo:docs/CURRENT_STATUS.md", "atlas:icp/example-service.md"]);
  });

  it("returns an empty list when the key is absent, and does not throw", () => {
    expect(sourceRefsFor(parseNote("---\nbrand: x\n---\n\nbody\n"))).toEqual([]);
  });

  it("treats codebase: — as no codebase", () => {
    const harbor = parseNote("---\nbrand: harbor\ncodebase: —\ncanonical_sources: [README.md]\n---\n\nbody\n");
    expect(() => sourceRefsFor(harbor)).toThrow(/no codebase/i);
  });
});

describe("normaliseCanonicalSources", () => {
  it("rewrites legacy bare paths to repo: and quotes every entry", () => {
    const note = parseNote(`---
brand: example-app
codebase: /workspace/example-app/
canonical_sources: [README.md, atlas:icp/example-service.md]
---

body
`);
    expect(normaliseCanonicalSources(note)).toBe('["repo:README.md", "atlas:icp/example-service.md"]');
  });

  it("is a fixed point — normalising an already-normalised list changes nothing", () => {
    const note = parseNote(`---
brand: harbor
codebase: —
canonical_sources: ["notion:00000000-0000-4000-8000-000000000002"]
---

body
`);
    expect(normaliseCanonicalSources(note)).toBe('["notion:00000000-0000-4000-8000-000000000002"]');
  });
});
