import { describe, it, expect } from "vitest";

import { inboxNotePath, slug } from "../src/note-paths.js";

/**
 * The title → `_inbox/<slug>.md` derivation (ORB-135 fix round 1).
 *
 * This module carries a SECURITY property, not just a formatting one: because a write tool
 * derives its path instead of accepting one, a traversal argument is unrepresentable rather
 * than merely refused. The kit's `resolveInStore` containment refuses absolute paths, `..` and
 * symlink escape — but it does NOT exclude in-store dotfile directories, so a model-supplied
 * `.git/config` would have clobbered the file on disk before `git add --` rejected it. These
 * tests pin the escape hatches shut at the only place they can be.
 */
describe("slug", () => {
  it("lowercases and hyphenates, collapsing runs of punctuation", () => {
    expect(slug("Zero7 positioning")).toBe("zero7-positioning");
    expect(slug("Vol de Nuit — launch angles!")).toBe("vol-de-nuit-launch-angles");
  });

  it("trims leading and trailing hyphens rather than leaving a dotfile-ish name", () => {
    expect(slug("  spaced  ")).toBe("spaced");
    expect(slug("!!!shouting!!!")).toBe("shouting");
  });

  it("never returns an empty string", () => {
    // An empty slug would produce `_inbox/.md` — a dotfile, invisible to the store walker's
    // `.md` check only by accident.
    for (const title of ["", "   ", "!!!", "—", "..."]) {
      expect(slug(title), JSON.stringify(title)).toBe("note");
    }
  });
});

describe("inboxNotePath — traversal is unrepresentable", () => {
  it("puts every note under _inbox/ with a .md extension", () => {
    expect(inboxNotePath("Zero7 positioning")).toBe("_inbox/zero7-positioning.md");
  });

  it("flattens a path-shaped title instead of honouring it", () => {
    expect(inboxNotePath("../../etc/passwd")).toBe("_inbox/etc-passwd.md");
    expect(inboxNotePath("/etc/shadow")).toBe("_inbox/etc-shadow.md");
    expect(inboxNotePath("..\\..\\windows\\system32")).toBe("_inbox/windows-system32.md");
  });

  it("flattens the dotfile directories `resolveInStore` does NOT exclude", () => {
    // The concrete reachable case: `.git/config` clobbered on disk before git ever sees it,
    // and `.locks/` breaking the cross-process note lock. Both are in-store, so containment
    // alone would have allowed them.
    expect(inboxNotePath(".git/config")).toBe("_inbox/git-config.md");
    expect(inboxNotePath(".locks/ventures_soma.md.lock")).toBe("_inbox/locks-ventures-soma-md-lock.md");
  });

  it("produces a path with exactly one separator, whatever the title", () => {
    // The structural statement behind all of the above: the result can only ever name a file
    // directly inside _inbox.
    for (const title of ["a/b/c", "../..", ".git/config", "Zero7", "", "æøå ideas"]) {
      const path = inboxNotePath(title);
      expect(path.split("/"), JSON.stringify(title)).toHaveLength(2);
      expect(path.startsWith("_inbox/")).toBe(true);
      expect(path.endsWith(".md")).toBe(true);
    }
  });

  it("drops non-ASCII letters rather than smuggling them through", () => {
    // Recorded, not celebrated: `slug` is ASCII-only (ported verbatim from the old runtime), so
    // a Norwegian title loses its æøå. "Årsmøte" → "rsm-te" is ugly but safe and stable; the
    // frontmatter `title` keeps the real text, which is what a reader sees.
    expect(inboxNotePath("Årsmøte 2026")).toBe("_inbox/rsm-te-2026.md");
  });
});
