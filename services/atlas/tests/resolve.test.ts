import { describe, it, expect } from "vitest";
import type { SourceRef } from "../lib/sources.js";
import { resolveAll, verdictFor, type ReaderMap, type ResolvedSource } from "../lib/resolve.js";

const ref = (prefix: SourceRef["prefix"], locator: string): SourceRef =>
  ({ prefix, locator, declared: `${prefix}:${locator}` });

function readers(): ReaderMap {
  const mk = (id: string) => ({
    id,
    read: async (r: SourceRef) => ({ ref: r, outcome: "found" as const, content: `${id}:${r.locator}` }),
  });
  return { repo: mk("repo"), vault: mk("vault"), notion: mk("notion"), atlas: mk("atlas") };
}

describe("resolveAll", () => {
  it("dispatches each ref to the reader for its prefix, preserving declared order", async () => {
    const out = await resolveAll([ref("repo", "a.md"), ref("atlas", "icp/x.md")], readers());
    expect(out.map((r) => r.content)).toEqual(["repo:a.md", "atlas:icp/x.md"]);
  });

  it("turns a THROWN reader error into `failed`, never into `missing`", async () => {
    const map = readers();
    map.repo = { id: "repo", read: async () => { throw new Error("ECONNREFUSED"); } };
    const [r] = await resolveAll([ref("repo", "a.md")], map);
    expect(r!.outcome).toBe("failed");
    expect(r!.reason).toMatch(/ECONNREFUSED/);
    expect(r!.content).toBeUndefined();
  });

  it("refuses a reader map missing a prefix rather than skipping the source", async () => {
    // Deleting `notion` and then asking for a `repo:` ref only fails if resolveAll checks
    // ALL FOUR prefixes up front — asking for a `notion:` ref here would also pass a
    // weaker implementation that only checks the reader for the ref it was handed.
    const map = readers();
    delete (map as Record<string, unknown>)["notion"];
    await expect(resolveAll([ref("repo", "a.md")], map))
      .rejects.toThrow(/no reader/i);
  });
});

describe("verdictFor", () => {
  const found = (l: string): ResolvedSource => ({ ref: ref("repo", l), outcome: "found", content: "x" });
  const missing = (l: string): ResolvedSource => ({ ref: ref("repo", l), outcome: "missing", reason: "404" });
  const failed = (l: string): ResolvedSource => ({ ref: ref("repo", l), outcome: "failed", reason: "timeout" });

  it("is ok when everything resolved", () => {
    expect(verdictFor([found("a.md"), found("b.md")])).toEqual({ outcome: "ok", reason: null });
  });

  it("is ok when there are no sources at all — a note may legitimately declare none", () => {
    expect(verdictFor([])).toEqual({ outcome: "ok", reason: null });
  });

  it("reports sources_failed when ANY source could not be read", () => {
    const v = verdictFor([found("a.md"), failed("b.md")]);
    expect(v.outcome).toBe("sources_failed");
    expect(v.reason).toContain("repo:b.md");
  });

  it("prefers sources_failed over sources_missing when both are present", () => {
    // A failed read may be HIDING a file that is present. Reporting 'missing' first would
    // send a human hunting for a deleted file that never went anywhere.
    expect(verdictFor([missing("a.md"), failed("b.md")]).outcome).toBe("sources_failed");
  });

  it("reports sources_missing when a source is genuinely gone", () => {
    const v = verdictFor([found("a.md"), missing("b.md")]);
    expect(v.outcome).toBe("sources_missing");
    expect(v.reason).toContain("repo:b.md");
  });

  it("names EVERY unhealthy source, not just the first", () => {
    expect(verdictFor([missing("a.md"), missing("b.md")]).reason).toContain("repo:a.md");
    expect(verdictFor([missing("a.md"), missing("b.md")]).reason).toContain("repo:b.md");
  });
});
