import { describe, it, expect } from "vitest";
import { parseNote } from "../lib/frontmatter.js";
import { cardFor, renderPortfolio } from "../lib/portfolio.js";

const note = (over: Record<string, string>) => parseNote(
  `---\ntype: venture\nbrand: ${over.brand}\nstatus: ${over.status}\none_liner: ${over.one_liner}\ntags: [${over.tags ?? "product"}]\n---\n\n${over.body ?? "## What it is\n\nx\n"}`,
);

const EXISTING = `---
type: index
last_synced: 2026-08-11
canonical_sources: ["atlas:_projects/"]
---

# Heiberg Industries — portfolio map

<!-- BEGIN GENERATED -->
old content
<!-- END GENERATED -->

> Some hand-written footer.
`;

describe("cardFor", () => {
  it("reads the card straight out of the note's own frontmatter", () => {
    const c = cardFor("_projects/orakel.md", note({ brand: "orakel", status: "live", one_liner: "Nordic company data." }));
    expect(c).toEqual({
      brand: "orakel", status: "live", oneLiner: "Nordic company data.",
      notePath: "_projects/orakel.md", confidential: false,
    });
  });

  it("carries the confidentiality flag from the note BODY, where Part A put it", () => {
    const c = cardFor("_projects/soma.md", note({
      brand: "soma", status: "exploration", one_liner: "A hospitality concept.",
      body: "## What it is\n\n**Confidential — do not surface publicly.**\n\nSOMA is…\n",
    }));
    expect(c.confidential).toBe(true);
  });

  it("sees the confidentiality flag even when prose wrapping splits the phrase", () => {
    // House style hard-wraps prose at ~90 columns, so "do not surface publicly" can land
    // split across a line break. A regex anchored to a single line misses it — and the
    // consequence is a venture Bendik marked confidential rendering into the PUBLIC section
    // of `_portfolio.md`, itself an `atlas:` source other notes derive from.
    const c = cardFor("_projects/soma.md", note({
      brand: "soma", status: "exploration", one_liner: "A hospitality concept.",
      body: "## What it is\n\n**Confidential — do not surface\npublicly.**\n\nSOMA is…\n",
    }));
    expect(c.confidential).toBe(true);
  });

  it("does not read the phrase across a paragraph break", () => {
    // Collapsing ALL whitespace (the line-wrap fix's own regex, /\s+/g) also swallows blank
    // lines — the boundary between two UNRELATED paragraphs. "...we do not surface" ending
    // one paragraph and "Publicly available details are fine elsewhere..." starting the next
    // is plausible prose, and reading it as the confidentiality marker silently drops that
    // venture from the public portfolio section it belongs in.
    const c = cardFor("_projects/example.md", note({
      brand: "example", status: "active", one_liner: "A thing.",
      body: "## What it is\n\nWe do not surface\n\nPublicly available details are fine elsewhere.\n",
    }));
    expect(c.confidential).toBe(false);
  });

  it("sees the marker across a CRLF wrap", () => {
    // `parseNote` splits and joins on "\n" only, so a "\r" survives before each newline in a
    // CRLF-authored body (pasted from a Windows source, or some web surfaces) even though
    // the frontmatter fence itself is plain LF and the note parses fine. A collapse that only
    // strips `[ \t]*\n[ \t]*` leaves that "\r" behind and misses the marker.
    const c = cardFor("_projects/example.md", note({
      brand: "example", status: "exploration", one_liner: "A thing.",
      body: "## What it is\r\n\r\n**Confidential — do not surface\r\npublicly.**\r\n",
    }));
    expect(c.confidential).toBe(true);
  });

  it("sees the marker through doubled internal spaces", () => {
    // Doubled spaces after a sentence or an em-dash are ordinary in hand-written prose. The
    // pre-fix `/\s+/g` version caught this; the paragraph-safe narrowing must not regress it.
    const c = cardFor("_projects/example.md", note({
      brand: "example", status: "exploration", one_liner: "A thing.",
      body: "## What it is\n\n**Confidential — do not  surface   publicly.**\n",
    }));
    expect(c.confidential).toBe(true);
  });

  it("STILL does not read the phrase across a CRLF paragraph break", () => {
    // The case that stops this fix from simply reintroducing round 2's defect under CRLF:
    // collapsing whitespace more aggressively to catch the CRLF wrap must not also let the
    // paragraph boundary itself dissolve when it's CRLF-terminated.
    const c = cardFor("_projects/example.md", note({
      brand: "example", status: "active", one_liner: "A thing.",
      body: "## What it is\r\n\r\nWe do not surface\r\n\r\nPublicly available details are fine.\r\n",
    }));
    expect(c.confidential).toBe(false);
  });
});

describe("renderPortfolio", () => {
  const cards = [
    cardFor("_projects/orakel.md", note({ brand: "orakel", status: "live", one_liner: "Nordic company data." })),
    cardFor("_projects/soma.md", note({ brand: "soma", status: "exploration", one_liner: "A hospitality concept.", body: "**Confidential — do not surface publicly.**\n" })),
  ];

  it("regenerates only the marked block and leaves the rest of the file alone", () => {
    const out = renderPortfolio(cards, "2026-08-12", EXISTING);
    expect(out).toContain("> Some hand-written footer.");
    expect(out).not.toContain("old content");
    expect(out).toContain("**orakel** — Nordic company data. **live.** → `_projects/orakel.md`");
  });

  it("keeps a confidential venture in its own section and repeats the flag", () => {
    const out = renderPortfolio(cards, "2026-08-12", EXISTING);
    expect(out).toContain("## Not public (tracked internally)");
    expect(out).toContain("*Do not surface publicly.*");
  });

  it("is a FIXED POINT — re-rendering its own output changes nothing", () => {
    const once = renderPortfolio(cards, "2026-08-12", EXISTING);
    expect(renderPortfolio(cards, "2027-01-01", once)).toBe(once);
  });

  it("refuses a file with no generated block rather than overwriting a hand-written map", () => {
    expect(() => renderPortfolio(cards, "2026-08-12", "---\ntype: index\n---\n\n# map\n"))
      .toThrow(/BEGIN GENERATED/);
  });

  it("refuses a file where END appears before BEGIN", () => {
    const backwards =
      "---\ntype: index\n---\n\n<!-- END GENERATED -->\nold\n<!-- BEGIN GENERATED -->\n";
    expect(() => renderPortfolio(cards, "2026-08-12", backwards)).toThrow(/BEGIN GENERATED/);
  });

  it("sorts cards by brand regardless of input order", () => {
    // `[...cards].sort()` is stable but says nothing about ORDER unless the comparator does
    // the work — cards given reverse-alphabetical must still render alphabetical, or the
    // rendering would depend on whatever order the caller happened to hand them in.
    //
    // Both cards here are NON-confidential, and deliberately so: `orakel` and `soma` (the
    // fixture used elsewhere in this file) sit in different sections of the output — public
    // vs "Not public" — so ordering between them holds regardless of sorting and a mutation
    // that deletes the sort entirely would slip past unnoticed. Same-section cards are the
    // only pair that actually exercises the comparator.
    const zeta = cardFor("_projects/zeta.md", note({ brand: "zeta", status: "live", one_liner: "Z." }));
    const alpha = cardFor("_projects/alpha.md", note({ brand: "alpha", status: "live", one_liner: "A." }));
    const out = renderPortfolio([zeta, alpha], "2026-08-12", EXISTING);
    const alphaIdx = out.indexOf("**alpha**");
    const zetaIdx = out.indexOf("**zeta**");
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(zetaIdx).toBeGreaterThan(-1);
    expect(alphaIdx).toBeLessThan(zetaIdx);
  });

  it("breaks a tie on brand by notePath, so directory-read order never decides it", () => {
    // Two ventures with the same (here: unknown-marker "—") brand tie under a bare
    // `localeCompare(brand)`. A stable sort then falls back to INPUT order, which upstream
    // is directory-read order — ext4 on the box vs APFS on the Mac disagree on that order,
    // and that disagreement is exactly the churn this file's docstring claims immunity to.
    const untitledA = cardFor("_projects/aaa.md", note({ brand: "—", status: "live", one_liner: "A." }));
    const untitledB = cardFor("_projects/zzz.md", note({ brand: "—", status: "live", one_liner: "B." }));
    const forward = renderPortfolio([untitledA, untitledB], "2026-08-12", EXISTING);
    const backward = renderPortfolio([untitledB, untitledA], "2026-08-12", EXISTING);
    expect(forward).toBe(backward);
    expect(forward.indexOf("_projects/aaa.md")).toBeLessThan(forward.indexOf("_projects/zzz.md"));
  });
});
