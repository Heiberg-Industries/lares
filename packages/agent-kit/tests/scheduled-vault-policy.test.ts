import { describe, expect, it } from "vitest";

import {
  SCHEDULED_VAULT_MAX_BODY_BYTES, SCHEDULED_VAULT_POLICY, scheduledPathAllowed, scheduledPrefixAllowed, scheduledVaultRule, scheduledVerbatimRefusal,
} from "../src/scheduled-vault-policy.js";

const digest = scheduledVaultRule("digest", "private")!;
const md = "---\ntitle: A page\nlares_origin: third_party\nsources:\n  - resource: https://example.com/a\n---\n\nBody\n";

describe("the verbatim paths of a schedule", () => {
  it("only the digest names any, and they are articles and their text companions", () => {
    for (const [name, rules] of Object.entries(SCHEDULED_VAULT_POLICY)) {
      for (const rule of rules) expect(scheduledPathAllowed(rule, "verbatim", "articles/a.md")).toBe(name === "digest");
    }
    for (const path of ["articles/a.md", "articles/a-page-1f2e3d.md", "articles/a-page-1f2e3d.txt", "articles/x1.txt"]) expect(scheduledPathAllowed(digest, "verbatim", path)).toBe(true);
    for (const path of ["articles/A.md", "articles/a_b.md", "articles/-a.md", "articles/a--b.md", "articles/sub/a.md", "articles/a.md.txt", "articles/.a.md", "articles/a.json", "reads/a.md", "_inbox/clip-a.md", "articles/../a.md", "/articles/a.md"]) {
      expect(scheduledPathAllowed(digest, "verbatim", path)).toBe(false);
    }
  });

  it("the digest may read and list articles", () => {
    expect(scheduledPathAllowed(digest, "read", "articles/a.md")).toBe(true);
    expect(digest.listPrefixes).toContain("articles/");
  });
});

describe("what a verbatim file must say", () => {
  it("accepts an article carrying the rule's origin and a companion without front matter", () => {
    expect(scheduledVerbatimRefusal(digest, "articles/a.md", md)).toBeNull();
    expect(scheduledVerbatimRefusal(digest, "articles/a.md", "---\nlares_origin: third_party\n---")).toBeNull();
    expect(scheduledVerbatimRefusal(digest, "articles/a-1f2e3d.txt", "Plain text.\n--- a rule line, not front matter\n")).toBeNull();
  });

  it("refuses with a sentence", () => {
    const why = (path: string, content: unknown) => scheduledVerbatimRefusal(digest, path, content);
    expect(why("reads/a.md", md)).toMatch(/may not save a file at that path/);
    expect(why("articles/a.md", "plain")).toMatch(/front-matter block/);
    expect(why("articles/a.md", "---\ntitle: x\n---\nbody")).toMatch(/exactly one lares_origin/);
    expect(why("articles/a.md", md.replace("third_party", "agent"))).toMatch(/must be third_party/);
    expect(why("articles/a.md", md.replace("lares_origin: third_party", "lares_origin: third_party\nlares_origin: third_party"))).toMatch(/exactly one/);
    expect(why("articles/a.md", md.replaceAll("\n", "\r\n"))).toMatch(/front-matter block/);
    expect(why("articles/a.md", md.replace("title: A page", "title: A page\r"))).toMatch(/plain line endings/);
    const junk = "---\ntitle: x\n---junk\nlares_origin: third_party\n---\n";
    expect(why("articles/a.md", junk)).toMatch(/only ---/);
    expect(why("articles/a.md", "---\nlares_origin: third_party\n---x\nbody")).toMatch(/only ---/);
    expect(why("articles/a.md", "---\nlares_origin: third_party\n---  \nbody")).toMatch(/only ---/);
    expect(why("articles/a.txt", "---\nlares_origin: third_party\n---\n")).toMatch(/must not start with front matter/);
    expect(why("articles/a.txt", "a\u0000b")).toMatch(/NUL/);
    expect(why("articles/a.txt", "lone \ud800")).toMatch(/UTF-8/);
    expect(why("articles/a.txt", "x".repeat(SCHEDULED_VAULT_MAX_BODY_BYTES + 1))).toMatch(/too large/);
    expect(why("articles/a.txt", 5)).toMatch(/must be text/);
  });
});

describe("the digest in the shared area", () => {
  const shared = scheduledVaultRule("digest", "shared")!;

  it("may list articles/, read an article note and save an article and its companion, and nothing else", () => {
    expect(shared).toBeDefined();
    expect(scheduledPrefixAllowed(shared, "articles/")).toBe(true);
    for (const prefix of ["", "_inbox/", "reads/", "_meta/", "articles"]) expect(scheduledPrefixAllowed(shared, prefix)).toBe(false);
    expect(scheduledPathAllowed(shared, "read", "articles/a-page.md")).toBe(true);
    for (const path of ["articles/a-page.txt", "reads/a.md", "_inbox/clip-a.md", "articles/sub/a.md", "owner.md"]) expect(scheduledPathAllowed(shared, "read", path)).toBe(false);
    for (const path of ["articles/a-page.md", "articles/a-page-1f2e3d.txt"]) expect(scheduledPathAllowed(shared, "verbatim", path)).toBe(true);
    for (const path of ["reads/a.md", "articles/Not-A-Slug.md", "articles/sub/a.md", "articles/a.json", "_inbox/clip-a.md"]) expect(scheduledPathAllowed(shared, "verbatim", path)).toBe(false);
  });

  it("never writes a note, removes a file or lists the whole area", () => {
    for (const path of ["articles/a-page.md", "reads/a.md", "_inbox/clip-a.md", "_inbox/karakeep-a.md", "inspiration/a.md"]) {
      expect(scheduledPathAllowed(shared, "write", path)).toBe(false);
      expect(scheduledPathAllowed(shared, "remove", path)).toBe(false);
    }
    expect(shared.listAll).not.toBe(true);
  });

  it("holds a shared article to the same file rules as a private one", () => {
    expect(scheduledVerbatimRefusal(shared, "articles/a.md", md)).toBeNull();
    expect(scheduledVerbatimRefusal(shared, "articles/a.md", md.replace("third_party", "agent"))).toMatch(/must be third_party/);
    expect(scheduledVerbatimRefusal(shared, "articles/a.txt", "---\nx: y\n---\n")).toMatch(/front matter/);
  });

  it("no other schedule has a shared rule", () => {
    for (const [name, rules] of Object.entries(SCHEDULED_VAULT_POLICY)) expect(rules.some((r) => r.area === "shared")).toBe(name === "digest");
  });
});
