import { describe, it, expect } from "vitest";
import { okfTypeFor } from "../lib/okf.js";

describe("okfTypeFor", () => {
  it("maps every live Atlas path to its type", () => {
    expect(okfTypeFor("_projects/soma.md")).toBe("venture");
    expect(okfTypeFor("_portfolio.md")).toBe("index");
    expect(okfTypeFor("README.md")).toBe("index");
    expect(okfTypeFor("_entities.md")).toBe("reference");
    expect(okfTypeFor("SCHEMA.md")).toBe("reference");
    expect(okfTypeFor("icp/zero7.md")).toBe("profile");
    expect(okfTypeFor("_inbox/some-idea.md")).toBe("note");
  });

  it("compares paths case- and NFC-insensitively (ext4 box vs APFS Mac)", () => {
    expect(okfTypeFor("_Projects/Soma.md")).toBe("venture");
    expect(okfTypeFor("ICP/zero7.md")).toBe("profile");
  });

  it("refuses an unknown location rather than guessing a type", () => {
    expect(() => okfTypeFor("scratch/whatever.md")).toThrow(/no OKF type/i);
  });
});
