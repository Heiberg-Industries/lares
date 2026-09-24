import { describe, it, expect } from "vitest";
import { mechanicalRefresh } from "../lib/mechanical.js";

const LEGACY = `---
brand: murmur
status: active
one_liner: Local-first transcription.
public_url: —
codebase: /workspace/murmur/
canonical_sources: [README.md, docs/CURRENT_STATUS.md]
last_synced: 2026-06-23
tags: [product]
---

## What it is

Murmur is a transcript-first audio pipeline.
`;

describe("mechanicalRefresh", () => {
  it("adds the OKF type and normalises canonical_sources, stamping last_synced", () => {
    const out = mechanicalRefresh({ path: "_projects/murmur.md", raw: LEGACY, today: "2026-08-12" });
    expect(out.changed).toBe(true);
    expect(out.raw).toContain("type: venture");
    expect(out.raw).toContain('canonical_sources: ["repo:README.md", "repo:docs/CURRENT_STATUS.md"]');
    expect(out.raw).toContain("last_synced: 2026-08-12");
    expect(out.fields.sort()).toEqual(["canonical_sources", "last_synced", "type"]);
  });

  it("leaves the body completely untouched", () => {
    const out = mechanicalRefresh({ path: "_projects/murmur.md", raw: LEGACY, today: "2026-08-12" });
    expect(out.raw.slice(out.raw.indexOf("\n---\n") + 5)).toBe(LEGACY.slice(LEGACY.indexOf("\n---\n") + 5));
  });

  it("IS A NO-OP on an already-refreshed note — the steady-state contract", () => {
    const once = mechanicalRefresh({ path: "_projects/murmur.md", raw: LEGACY, today: "2026-08-12" });
    const twice = mechanicalRefresh({ path: "_projects/murmur.md", raw: once.raw, today: "2026-08-12" });
    expect(twice.changed).toBe(false);
    expect(twice.raw).toBe(once.raw);
    expect(twice.fields).toEqual([]);
  });

  it("DOES NOT move last_synced on a later day when nothing else changed", () => {
    // The steady-state defect in its purest form. If the wall clock alone could rewrite a
    // note, every tick would commit, every commit would change an `atlas:` source, and the
    // store would churn forever with nobody watching.
    const once = mechanicalRefresh({ path: "_projects/murmur.md", raw: LEGACY, today: "2026-08-12" });
    const later = mechanicalRefresh({ path: "_projects/murmur.md", raw: once.raw, today: "2027-01-01" });
    expect(later.changed).toBe(false);
    expect(later.raw).toContain("last_synced: 2026-08-12");
  });

  it("stamps last_synced only when something else genuinely changed", () => {
    const once = mechanicalRefresh({ path: "_projects/murmur.md", raw: LEGACY, today: "2026-08-12" });
    const edited = once.raw.replace("type: venture", "type: note");   // drift, however introduced
    const fixed = mechanicalRefresh({ path: "_projects/murmur.md", raw: edited, today: "2027-01-01" });
    expect(fixed.changed).toBe(true);
    expect(fixed.raw).toContain("type: venture");
    expect(fixed.raw).toContain("last_synced: 2027-01-01");
  });

  it("migrates the two legacy type values", () => {
    const portfolio = "---\ntype: portfolio-map\nlast_synced: 2026-08-11\n---\n\n# map\n";
    expect(mechanicalRefresh({ path: "_portfolio.md", raw: portfolio, today: "2026-08-12" }).raw)
      .toContain("type: index");
    const entities = "---\ntype: entity-structure\nlast_synced: 2026-08-11\n---\n\n# entities\n";
    expect(mechanicalRefresh({ path: "_entities.md", raw: entities, today: "2026-08-12" }).raw)
      .toContain("type: reference");
  });

  it("adds frontmatter to a file that has none at all (the icp/ files)", () => {
    const out = mechanicalRefresh({ path: "icp/zero7.md", raw: "# Zero7 ICP\n\nNordic agencies.\n", today: "2026-08-12" });
    expect(out.changed).toBe(true);
    expect(out.raw.startsWith("---\ntype: profile\n---\n")).toBe(true);
    expect(out.raw).toContain("# Zero7 ICP");
  });

  it("is a no-op on a second pass over a file it just gave frontmatter to", () => {
    const once = mechanicalRefresh({ path: "icp/zero7.md", raw: "# Zero7 ICP\n", today: "2026-08-12" });
    expect(mechanicalRefresh({ path: "icp/zero7.md", raw: once.raw, today: "2026-08-13" }).changed).toBe(false);
  });

  it("does not add last_synced or canonical_sources to a non-venture file", () => {
    const out = mechanicalRefresh({ path: "icp/zero7.md", raw: "# Zero7 ICP\n", today: "2026-08-12" });
    expect(out.raw).not.toContain("last_synced");
    expect(out.raw).not.toContain("canonical_sources");
  });

  // Counts fence-marker lines tolerantly (a leading BOM or trailing \r stays PART of the
  // rendered line — this task's fix only makes DETECTION tolerant, it never rewrites bytes
  // elsewhere in the file — so a plain `/^---$/` line match would undercount a BOM'd fence).
  const fenceLineCount = (raw: string) =>
    raw.split("\n").filter((l) => l.replace(/^﻿/, "").replace(/\r$/, "") === "---").length;

  it("recognises frontmatter behind a leading BOM instead of duplicating it", () => {
    // A file saved by a Windows-flavoured editor can carry a leading byte-order mark. A
    // strict `raw.startsWith("---\n")` check would miss it, treat the note as having no
    // frontmatter at all, and PREPEND a second block — demoting the real one (brand, status,
    // canonical_sources, last_synced) into the body, silently and permanently (the result is
    // idempotent afterwards, so it never self-corrects).
    const bomRaw =
      "﻿---\nbrand: acme\nstatus: active\none_liner: Thing.\ncodebase: /x/\n" +
      "canonical_sources: [README.md]\nlast_synced: 2026-06-01\n---\n\nBody.\n";
    const out = mechanicalRefresh({ path: "_projects/acme.md", raw: bomRaw, today: "2026-08-12" });
    expect(fenceLineCount(out.raw)).toBe(2);
    expect(out.raw).toContain("brand: acme");
    expect(out.raw).toContain("Body.");
  });

  it("recognises a CRLF-terminated opening fence instead of duplicating it", () => {
    // Same failure mode, different cause: a note whose opening fence line ends `\r\n` does
    // not match a bare `"---\n"` check either. (The closing fence here stays LF-terminated —
    // full CRLF-throughout parsing is a pre-existing, separate limit of `frontmatterEnd` in
    // frontmatter.ts, out of this task's scope; this test isolates exactly the opening-fence
    // detection this fix targets.)
    const crlfRaw = "---\r\nbrand: acme\r\nstatus: active\r\n---\n\nBody.\n";
    const out = mechanicalRefresh({ path: "_projects/acme.md", raw: crlfRaw, today: "2026-08-12" });
    expect(fenceLineCount(out.raw)).toBe(2);
    expect(out.raw).toContain("Body.");
  });
});
