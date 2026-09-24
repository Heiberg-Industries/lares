import { describe, it, expect } from "vitest";
import { runFidelity } from "../lib/fidelity.js";

/** In-memory readFile: throws ENOENT-shaped errors for paths not in the map. */
function makeReader(files: Record<string, string>): (path: string) => Promise<string> {
  return async (path: string) => {
    if (!(path in files)) throw new Error(`ENOENT: no such file, open '${path}'`);
    return files[path];
  };
}

// W4D-s3: the gate now also refuses any file that carries no lares_origin stamp (a
// pull would otherwise leave it with no origin at all — see the describe block
// below). The fixtures above that predate that rule get a stamp prefixed so each
// keeps testing the ONE property it was written for (a wikilink, a safety rail, a
// body mismatch) rather than tripping the new, unrelated stamp check.
const STAMP = "---\nlares_origin: synced\n---\n\n";

describe("runFidelity — pure round trip", () => {
  it("passes a plain file with a bare wikilink (no alias; carries a stamp)", async () => {
    const files = { "wiki/a.md": `${STAMP}# A\n\nSee [[other-page]] for more.\n` };
    const result = await runFidelity(["wiki/a.md"], makeReader(files));
    expect(result.passed).toBe(1);
    expect(result.failed).toEqual([]);
    expect(result.report.scanned).toBe(1);
    expect(result.report.results).toEqual([{ path: "wiki/a.md", passed: true }]);
  });

  it("passes a file with frontmatter — the frontmatter survives verbatim (property, not translated)", async () => {
    const files = {
      "wiki/b.md": "---\ntitle: Hello\ntags: [a, b]\nlares_origin: synced\n---\n\n# Hello\n\nBody text.\n",
    };
    const result = await runFidelity(["wiki/b.md"], makeReader(files));
    expect(result.passed).toBe(1);
    expect(result.failed).toEqual([]);
  });

  it("fails an aliased wikilink — pull always reconstructs a bare target, dropping the alias (exactly the gate's job)", async () => {
    const files = { "wiki/c.md": `${STAMP}See [[other-page|a friendly name]] here.\n` };
    const result = await runFidelity(["wiki/c.md"], makeReader(files));
    expect(result.passed).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].path).toBe("wiki/c.md");
    expect(result.failed[0].reason).toMatch(/body mismatch at line 1/);
  });

  it("fails a file whose vault source carries a live <page> tag inside a code fence (assertPushSafe)", async () => {
    // Ordinary prose `<` is escaped by escapeAngles before assertPushSafe ever sees
    // it; only code-fence content passes through untranslated, so that's the only
    // place a genuinely live <page>/<database> tag construct can originate from.
    const files = {
      "wiki/d.md": "Some text.\n\n```\nlook: <page url=\"x\">\n```\n",
    };
    const result = await runFidelity(["wiki/d.md"], makeReader(files));
    expect(result.passed).toBe(0);
    expect(result.failed[0].reason).toMatch(/refusing to push/);
    expect(result.failed[0].reason).toMatch(/<page>/);
  });

  it("fails a file whose reconstructed pull body contains a live <transcript> (assertPullSafe)", async () => {
    // Plain prose mentioning the tag name gets escaped on push (`\<transcript`),
    // then the general-prose unescaper on pull faithfully restores the bare `<`
    // — which is indistinguishable from a genuine live transcript block, so the
    // pull-safety rail refuses it. Over-blocking here is deliberate (see
    // translate-pull.ts's assertPullSafe doc comment).
    const files = {
      "wiki/e.md": "See the <transcript tag mentioned here.\n",
    };
    const result = await runFidelity(["wiki/e.md"], makeReader(files));
    expect(result.passed).toBe(0);
    expect(result.failed[0].reason).toMatch(/refusing to pull/);
    expect(result.failed[0].reason).toMatch(/<transcript>/);
  });

  it("fails a callout with an inline title — push flattens title+body into one <br>-joined child, pull can't tell them apart", async () => {
    const files = {
      "wiki/f.md": `${STAMP}> [!warning] Careful here\n> more body text\n`,
    };
    const result = await runFidelity(["wiki/f.md"], makeReader(files));
    expect(result.passed).toBe(0);
    expect(result.failed[0].reason).toMatch(/body mismatch at line 1/);
  });

  it("surfaces a read failure as a per-file failure, never a thrown exception", async () => {
    const result = await runFidelity(["wiki/missing.md"], makeReader({}));
    expect(result.passed).toBe(0);
    expect(result.failed).toEqual([{ path: "wiki/missing.md", reason: expect.stringContaining("read failed") }]);
  });

  it("one bad file does not hide the verdict on the others; results are sorted for determinism", async () => {
    const files = {
      "wiki/z.md": `${STAMP}ok text\n`,
      "wiki/a.md": `${STAMP}See [[x|aliased]]\n`,
      "wiki/m.md": `${STAMP}also ok\n`,
    };
    const result = await runFidelity(Object.keys(files), makeReader(files));
    expect(result.passed).toBe(2);
    expect(result.failed.map((f) => f.path)).toEqual(["wiki/a.md"]);
    expect(result.report.scanned).toBe(3);
    expect(result.report.results.map((r) => r.path)).toEqual(["wiki/a.md", "wiki/m.md", "wiki/z.md"]);
  });

  it("returns an empty, well-formed report for an empty file list", async () => {
    const result = await runFidelity([], makeReader({}));
    expect(result).toEqual({ passed: 0, failed: [], report: { scanned: 0, results: [] } });
  });
});

describe("the gate refuses a pull that would lose a stamp", () => {
  const read = (files: Record<string, string>) => async (p: string) => files[p]!;

  it("passes a file whose stamp would survive a pull unchanged", async () => {
    // The slice's own snippet checked `passed` against an array of paths; the real
    // RunFidelityResult.passed is a count (see fidelity.ts's runFidelity), so this
    // asserts the count instead.
    const { passed, failed } = await runFidelity(["a.md"], read({
      "a.md": "---\ntype: note\nlares_origin: synced\n---\n\nplain body\n",
    }));
    expect(failed).toEqual([]);
    expect(passed).toBe(1);
  });

  it("passes a file the owner wrote — its stamp is kept, not widened", async () => {
    const { failed } = await runFidelity(["a.md"], read({
      "a.md": "---\ntype: note\nlares_origin: owner\n---\n\nplain body\n",
    }));
    expect(failed).toEqual([]);
  });

  it("refuses a file with no frontmatter at all, naming what would be lost", async () => {
    const { failed } = await runFidelity(["a.md"], read({ "a.md": "# heading\n\nbody\n" }));
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toMatch(/no origin at all/i);
  });

  it("refuses a file whose stamp is not one of the five classes", async () => {
    const { failed } = await runFidelity(["a.md"], read({
      "a.md": "---\ntype: note\nlares_origin: hearsay\n---\n\nbody\n",
    }));
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toMatch(/no origin at all|hearsay/i);
  });

  it("still reports a body mismatch as a body mismatch, not as a stamp problem", async () => {
    // The slice's own fixture (a "broken table") round-trips cleanly in this
    // codebase's real translate.ts/translate-pull.ts and never fails — an aliased
    // wikilink is the fixture already proven elsewhere in this file to produce a
    // genuine body mismatch, so it is used here instead to exercise the same intent.
    const { failed } = await runFidelity(["a.md"], read({
      "a.md": "---\nlares_origin: synced\n---\n\nSee [[other-page|a friendly name]] here.\n",
    }));
    expect(failed[0]!.reason).toMatch(/body mismatch|frontmatter/i);
  });

  it("checks every file and never aborts on the first refusal", async () => {
    // Same correction as above: `passed` is a count, not a path list.
    const { passed, failed } = await runFidelity(["a.md", "b.md"], read({
      "a.md": "# no frontmatter\n",
      "b.md": "---\nlares_origin: synced\n---\n\nbody\n",
    }));
    expect(failed.map((f) => f.path)).toEqual(["a.md"]);
    expect(passed).toBe(1);
  });

  // WAVE-3-NOTES: upsertOriginFrontmatter/readOriginFrontmatter close a block on a
  // line that merely startsWith("---"); this service's own splitters need trim() to
  // be exactly "---". A "----" line closes the block for the former but not the
  // latter, so the two disagree about which bytes the frontmatter even is.
  it("refuses a file whose frontmatter block ends ambiguously (a \"----\" line)", async () => {
    const { failed } = await runFidelity(["a.md"], read({
      "a.md": "---\nlares_origin: owner\n----\nbody\n",
    }));
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toMatch(/ambiguously|ambiguous/i);
  });
});
