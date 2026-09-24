import { describe, it, expect } from "vitest";
import {
  ORIGIN_CLASSES,
  ORIGIN_TRUST_ORDER,
  isOrigin,
  narrowest,
  ORIGIN_FRONTMATTER_KEY,
  originFrontmatterLine,
  readOriginFrontmatter,
  originAfterWrite,
  upsertOriginFrontmatter,
} from "../src/origin.js";

describe("the five classes", () => {
  it("is exactly the spec's five, in the spec's spelling", () => {
    expect([...ORIGIN_CLASSES]).toEqual(["owner", "agent", "synced", "third_party", "system"]);
  });

  it("recognises only those five", () => {
    for (const c of ORIGIN_CLASSES) expect(isOrigin(c)).toBe(true);
    for (const bad of ["Owner", "third-party", "thirdParty", "", null, 3, undefined]) {
      expect(isOrigin(bad)).toBe(false);
    }
  });
});

describe("narrowest — the least-trusted class present wins", () => {
  it("orders owner → agent → synced → system → third_party", () => {
    expect([...ORIGIN_TRUST_ORDER]).toEqual(["owner", "agent", "synced", "system", "third_party"]);
  });

  it("a mixed write takes the least trusted member", () => {
    expect(narrowest(["owner", "third_party"])).toBe("third_party");
    expect(narrowest(["owner", "agent"])).toBe("agent");
    expect(narrowest(["agent", "synced"])).toBe("synced");
    expect(narrowest(["synced", "system"])).toBe("system");
    expect(narrowest(["owner"])).toBe("owner");
  });

  it("is order-independent", () => {
    expect(narrowest(["third_party", "owner"])).toBe(narrowest(["owner", "third_party"]));
  });

  it("refuses an empty input rather than inventing a class", () => {
    expect(() => narrowest([])).toThrow(/no origins/i);
  });
});

describe("frontmatter", () => {
  it("renders one way", () => {
    expect(ORIGIN_FRONTMATTER_KEY).toBe("lares_origin");
    expect(originFrontmatterLine("synced")).toBe("lares_origin: synced");
  });

  it("reads its own rendering back, LF and CRLF alike", () => {
    const lf = `---\ntitle: x\n${originFrontmatterLine("agent")}\n---\n\nbody\n`;
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(readOriginFrontmatter(lf)).toBe("agent");
    expect(readOriginFrontmatter(crlf)).toBe("agent");
  });

  it("returns undefined rather than guessing", () => {
    expect(readOriginFrontmatter("no frontmatter here")).toBeUndefined();
    expect(readOriginFrontmatter("---\nlares_origin: hearsay\n---\n")).toBeUndefined();
    expect(readOriginFrontmatter("---\ntitle: x\n---\n")).toBeUndefined();
  });
});

describe("originAfterWrite", () => {
  it("keeps what the file already says", () => {
    expect(originAfterWrite("owner", "synced")).toBe("owner");
    expect(originAfterWrite("agent", "synced")).toBe("agent");
  });
  it("stamps the incoming class when the file says nothing", () => {
    expect(originAfterWrite(undefined, "synced")).toBe("synced");
  });
  it("never becomes more trusted than what is already there", () => {
    expect(originAfterWrite("third_party", "owner")).toBe("third_party");
    expect(originAfterWrite("synced", "owner")).toBe("synced");
  });
});

describe("upsertOriginFrontmatter", () => {
  it("replaces the one line, leaving every other byte alone", () => {
    const raw = "---\ntitle: a note\nlares_origin: owner\nnotion_page: p1\n---\n\nbody\n";
    expect(upsertOriginFrontmatter(raw, "synced"))
      .toBe("---\ntitle: a note\nlares_origin: synced\nnotion_page: p1\n---\n\nbody\n");
  });

  it("inserts after type: when the key is absent", () => {
    const raw = "---\ntype: note\ntitle: a note\n---\n\nbody\n";
    expect(upsertOriginFrontmatter(raw, "synced"))
      .toBe("---\ntype: note\nlares_origin: synced\ntitle: a note\n---\n\nbody\n");
  });

  it("inserts as the first line when there is no type:", () => {
    const raw = "---\ntitle: a note\n---\n\nbody\n";
    expect(upsertOriginFrontmatter(raw, "synced"))
      .toBe("---\nlares_origin: synced\ntitle: a note\n---\n\nbody\n");
  });

  it("creates a block for a file that has none — the case that loses stamps today", () => {
    expect(upsertOriginFrontmatter("# heading\n\nbody\n", "synced"))
      .toBe("---\nlares_origin: synced\n---\n\n# heading\n\nbody\n");
  });

  it("treats an unterminated block as no block, rather than writing into the body", () => {
    expect(upsertOriginFrontmatter("---\ntitle: x\nbody with no fence\n", "synced"))
      .toBe("---\nlares_origin: synced\n---\n\n---\ntitle: x\nbody with no fence\n");
  });

  it("round-trips through the reader, at every class", () => {
    for (const c of ORIGIN_CLASSES) {
      expect(readOriginFrontmatter(upsertOriginFrontmatter("---\ntype: note\n---\n\nb\n", c))).toBe(c);
      expect(readOriginFrontmatter(upsertOriginFrontmatter("no frontmatter\n", c))).toBe(c);
    }
  });

  it("keeps a CRLF file on CRLF", () => {
    const raw = "---\r\ntype: note\r\n---\r\n\r\nbody\r\n";
    const out = upsertOriginFrontmatter(raw, "synced");
    expect(out).toContain("\r\nlares_origin: synced\r\n");
    expect(out).not.toMatch(/[^\r]\n/);
  });

  it("is idempotent", () => {
    const once = upsertOriginFrontmatter("---\ntype: note\n---\n\nb\n", "synced");
    expect(upsertOriginFrontmatter(once, "synced")).toBe(once);
  });
});
