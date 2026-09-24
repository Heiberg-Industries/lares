import { describe, it, expect } from "vitest";
import {
  OKF_CORE_TYPES,
  OKF_TASTE_TYPES,
  OKF_OPTIONAL_FAMILIES,
  LARES_FIELDS,
  checkConformance,
  checkAreas,
} from "../src/okf.js";

const core = { types: OKF_CORE_TYPES };

describe("checkConformance — what it already did", () => {
  it("passes a file with a known type", () => {
    expect(checkConformance([{ path: "_projects/soma.md", raw: "---\ntype: venture\n---\n\nbody\n" }], core)).toEqual([]);
  });
  it("reports a file with no frontmatter at all", () => {
    expect(checkConformance([{ path: "icp/x.md", raw: "# heading\n" }], core))
      .toEqual([{ path: "icp/x.md", problem: "no-frontmatter" }]);
  });
  it("reports frontmatter with no type", () => {
    expect(checkConformance([{ path: "a.md", raw: "---\nbrand: m\n---\n\nbody\n" }], core))
      .toEqual([{ path: "a.md", problem: "no-type" }]);
  });
  it("reports an unknown type, naming it", () => {
    expect(checkConformance([{ path: "a.md", raw: "---\ntype: portfolio-map\n---\n\nb\n" }], core))
      .toEqual([{ path: "a.md", problem: "unknown-type", found: "portfolio-map" }]);
  });
});

describe("checkConformance — what it must now also do", () => {
  it("accepts OKF's optional provenance families instead of ignoring them", () => {
    const raw = `---\ntype: note\n${OKF_OPTIONAL_FAMILIES.map((k) => `${k}: x`).join("\n")}\n---\n\nb\n`;
    expect(checkConformance([{ path: "a.md", raw }], core)).toEqual([]);
  });

  it("accepts every lares_* extension field", () => {
    const raw = `---\ntype: note\n${LARES_FIELDS.map((k) => `${k}: ${k === "lares_origin" ? "owner" : "x"}`).join("\n")}\n---\n\nb\n`;
    expect(checkConformance([{ path: "a.md", raw }], core)).toEqual([]);
  });

  it("refuses an invented lares_ field rather than ignoring it", () => {
    const raw = "---\ntype: note\nlares_trustworthy: yes\n---\n\nb\n";
    expect(checkConformance([{ path: "a.md", raw }], core))
      .toEqual([{ path: "a.md", problem: "unknown-lares-field", found: "lares_trustworthy" }]);
  });

  it("refuses a lares_origin that is not one of the five classes", () => {
    const raw = "---\ntype: note\nlares_origin: hearsay\n---\n\nb\n";
    expect(checkConformance([{ path: "a.md", raw }], core))
      .toEqual([{ path: "a.md", problem: "bad-lares-origin", found: "hearsay" }]);
  });

  it("reads a CRLF-saved note the same as an LF one", () => {
    const raw = "---\ntype: note\nlares_origin: hearsay\n---\n\nb\n".replace(/\n/g, "\r\n");
    expect(checkConformance([{ path: "a.md", raw }], core))
      .toEqual([{ path: "a.md", problem: "bad-lares-origin", found: "hearsay" }]);
  });
});

describe("checkAreas", () => {
  it("checks each area against its own vocabulary and prefixes the path", () => {
    const findings = checkAreas([
      { name: "atlas", types: OKF_CORE_TYPES, files: [{ path: "a.md", raw: "---\ntype: place\n---\n\nb\n" }] },
      { name: "taste", types: OKF_TASTE_TYPES, files: [{ path: "b.md", raw: "---\ntype: place\n---\n\nb\n" }] },
    ]);
    expect(findings).toEqual([{ path: "atlas/a.md", problem: "unknown-type", found: "place" }]);
  });

  it("returns an empty array when every area conforms", () => {
    expect(checkAreas([{ name: "brain", types: OKF_CORE_TYPES, files: [{ path: "n.md", raw: "---\ntype: note\n---\n\nb\n" }] }])).toEqual([]);
  });
});
