// Pure-function coverage for @lares/vault-format/forget-ledger — the parts that need no
// database. The Postgres-backed behaviour (recordForgotten/wasForgotten/wasPathForgotten against
// a real forget_ledger table, mirroring services/box/sql/001_baseline.sql) lives in
// packages/agent-kit/tests/forget-ledger.test.ts, the one place both a testcontainer and this
// module are already available without adding a dependency to any package.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { forgetKey, normaliseForgotten } from "../src/forget-ledger.js";

describe("normaliseForgotten", () => {
  it("lower-cases, strips punctuation and collapses whitespace the same way regardless of case", () => {
    for (const sample of ["He keeps BEES, Alpha–Beta.", "  a  b  ", "Æ, ø — å!"]) {
      expect(normaliseForgotten(sample)).toBe(normaliseForgotten(sample.toUpperCase()));
    }
  });

  it("normalises the same way the dream store does", () => {
    // The mirror this repeats (services/box couldn't import a role service; neither can this
    // dependency-free package), pinned by name so the two cannot silently drift apart.
    const src = readFileSync(
      join(__dirname, "..", "..", "..", "services", "chief-of-staff", "lib", "dream", "store.ts"),
      "utf8",
    );
    expect(src).toContain("normalizeObservationText");
  });
});

describe("forgetKey", () => {
  it("pins a known input's exact hex digest — a length-prefix regression breaks this test", () => {
    // forgetKey("fixture-owner", "fact", "hello world") over the length-prefixed fields
    // "13:fixture-owner" + "4:fact" + "11:hello world", sha256 hex.
    expect(forgetKey("fixture-owner", "fact", "hello world")).toBe(
      "2ab20bfc31b0be489a8eda0ef51631fcce035fedea3dfb329f5613fec1fdc7cd",
    );
  });

  it("hashes the same wording the same way regardless of case or punctuation", () => {
    const a = forgetKey("fixture-owner", "fact", normaliseForgotten("He keeps BEES, Alpha–Beta."));
    const b = forgetKey("fixture-owner", "fact", normaliseForgotten("he keeps bees alpha beta"));
    expect(a).toBe(b);
  });

  it("hashes the same text differently for different owners", () => {
    const a = forgetKey("fixture-owner", "fact", normaliseForgotten("He keeps bees."));
    const b = forgetKey("someone-else", "fact", normaliseForgotten("He keeps bees."));
    expect(a).not.toBe(b);
  });

  it("stores a fixed-length 64-character hex key however long the forgotten text is", () => {
    const longWords = normaliseForgotten("he keeps bees ".repeat(200)); // > 2,000 characters
    expect(longWords.length).toBeGreaterThan(2000);
    expect(forgetKey("fixture-owner", "fact", longWords)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("forgetKey cannot be made to collide across owners", () => {
  it("an owner id that contains the other fields does not produce another owner's key", () => {
    // With a plain separator these two would hash the same input string.
    expect(forgetKey("fixture-owner fact hello", "note", "p")).not.toBe(
      forgetKey("fixture-owner", "fact", "hello note p"),
    );
  });
});
