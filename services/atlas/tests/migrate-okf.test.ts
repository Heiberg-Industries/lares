import { describe, it, expect } from "vitest";
import { migrateOkf } from "../lib/migrate-okf.js";
import { fakeWriter } from "./helpers/fake-writer.js";

const ARTICLE_NOTE = `---
type: article
title: "A neutral example article"
sources:
  - resource: "https://example.com/a/b"
reading: to-read
topics: [pricing, onboarding]
gathered_by: owner
captured: 2026-10-09
generated:
  by: "process:digest"
  at: "2026-10-09T10:00:00+00:00"
lares_origin: third_party
owner: organisation
scope: org
full_text: a-neutral-example-article.txt
---

Summary.

## Full text

[Full text](a-neutral-example-article.txt)
`;

const LIVE = () => ({
  "README.md": "# The Atlas\n",
  "SCHEMA.md": "# Atlas per-brand note schema\n",
  "_portfolio.md": "---\ntype: portfolio-map\nlast_synced: 2026-08-11\n---\n\n# map\n",
  "_entities.md": "---\ntype: entity-structure\nlast_synced: 2026-08-11\n---\n\n# entities\n",
  "_projects/soma.md": '---\nbrand: soma\nstatus: exploration\ncanonical_sources: ["notion:2f5cc987-b457-8094-a784-cbcc9b67493f"]\nlast_synced: 2026-08-11\n---\n\nbody\n',
  "_projects/murmur.md": "---\nbrand: murmur\nstatus: active\ncodebase: /workspace/murmur/\ncanonical_sources: [README.md]\nlast_synced: 2026-06-23\n---\n\nbody\n",
  "icp/zero7.md": "# Zero7 ICP\n",
  "articles/a-neutral-example-article.md": ARTICLE_NOTE,
  "_inbox/idea.md": "---\ntitle: An idea\ntype: note\n---\n\nbody\n",
});

describe("migrateOkf", () => {
  it("brings the whole bundle to conformance in one pass", async () => {
    const w = fakeWriter(LIVE());
    const res = await migrateOkf(w, "2026-08-12");
    expect(res.findings).toEqual([]);
    expect(w.files["README.md"]).toContain("type: index");
    expect(w.files["SCHEMA.md"]).toContain("type: reference");
    expect(w.files["_portfolio.md"]).toContain("type: index");
    expect(w.files["_entities.md"]).toContain("type: reference");
    expect(w.files["_projects/soma.md"]).toContain("type: venture");
    expect(w.files["icp/zero7.md"]).toContain("type: profile");
  });

  it("accepts an article note and leaves it byte-identical", async () => {
    const files = LIVE();
    const res = await migrateOkf(fakeWriter(files), "2026-08-12");
    expect(res.failures).toEqual([]);
    expect(res.findings).toEqual([]);
    expect(res.changed).not.toContain("articles/a-neutral-example-article.md");
    expect(files["articles/a-neutral-example-article.md"]).toBe(ARTICLE_NOTE);
  });

  it("leaves a file that was already conformant byte-identical", async () => {
    const files = LIVE();
    const before = files["_inbox/idea.md"];
    await migrateOkf(fakeWriter(files), "2026-08-12");
    expect(files["_inbox/idea.md"]).toBe(before);
  });

  it("normalises legacy bare canonical_sources at the same time", async () => {
    const files = LIVE();
    await migrateOkf(fakeWriter(files), "2026-08-12");
    expect(files["_projects/murmur.md"]).toContain('canonical_sources: ["repo:README.md"]');
  });

  it("does not touch any note BODY", async () => {
    // The brief's own assertion (`expect(raw).toContain("body")` for every file) doesn't hold
    // even before migration: only 3 of the 8 LIVE() fixtures literally contain the word
    // "body" — the other 5 (README.md, SCHEMA.md, _portfolio.md, _entities.md, icp/zero7.md)
    // do not. The claim under test is "the body is byte-identical before and after", so
    // that's what this compares — per file, not via a substring that happens to be true for
    // some of them.
    const files = LIVE();
    const bodyOf = (raw: string) => raw.replace(/^---\n[\s\S]*?\n---\n\n?/, "");
    const before = Object.fromEntries(Object.entries(files).map(([path, raw]) => [path, bodyOf(raw)]));
    await migrateOkf(fakeWriter(files), "2026-08-12");
    for (const [path, raw] of Object.entries(files)) expect(bodyOf(raw)).toBe(before[path]);
  });

  it("IS IDEMPOTENT — a second run changes nothing and commits nothing", async () => {
    const w = fakeWriter(LIVE());
    await migrateOkf(w, "2026-08-12");
    const snapshot = JSON.stringify(w.files);
    const commitsAfterFirst = w.commits.length;
    const second = await migrateOkf(w, "2027-01-01");
    expect(JSON.stringify(w.files)).toBe(snapshot);
    expect(w.commits.length).toBe(commitsAfterFirst);
    expect(second.changed).toEqual([]);
  });

  it("describes the STORE, not the function's intentions — the conformance check re-reads through the writer", async () => {
    // A writer whose writeNotes silently drops one file (as if a concurrent process reverted
    // it, or a partial write never landed) — the kind of gap only a RE-READ after the write
    // can see. If migrateOkf trusted the values it had just computed instead of asking the
    // writer again, this file's real (unmigrated) state would go unreported.
    const files = LIVE();
    const base = fakeWriter(files);
    const dropped = "README.md";
    const w = {
      ...base,
      writeNotes: (batch: Parameters<typeof base.writeNotes>[0], message: string) =>
        base.writeNotes(batch.filter((f) => f.path !== dropped), message),
    };
    const res = await migrateOkf(w, "2026-08-12");
    expect(res.findings.some((f) => f.path === dropped)).toBe(true);
  });

  it("isolates a per-file failure — an unmapped path does not abort the whole migration", async () => {
    const files: Record<string, string> = LIVE();
    files["orphan/mystery.md"] = "# mystery\n"; // no okfTypeFor mapping for "orphan/"
    const w = fakeWriter(files);
    const res = await migrateOkf(w, "2026-08-12");
    expect(res.failures).toEqual([
      { path: "orphan/mystery.md", error: expect.stringContaining("no OKF type is defined") },
    ]);
    // Every OTHER file still got migrated — one bad path doesn't take the run down with it.
    expect(w.files["README.md"]).toContain("type: index");
    expect(w.files["_projects/soma.md"]).toContain("type: venture");
  });
});
