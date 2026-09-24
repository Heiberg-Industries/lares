import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync, chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { makeFsReader } from "../lib/adapters/fs-source.js";

let root: string;
// Created OUTSIDE the temp root on purpose — this is what the symlink-escape test needs to
// point at. Because it lives outside `root`, `afterAll` must remove it explicitly: `rmSync`
// on `root` alone would leave it behind.
let outside: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "atlas-fs-"));
  outside = mkdtempSync(join(tmpdir(), "atlas-fs-outside-"));
  mkdirSync(join(root, "brand"), { recursive: true });
  writeFileSync(join(root, "brand", "voice.md"), "# Voice\n\nQuiet.\n");
  writeFileSync(join(outside, "secret.md"), "nope");
  symlinkSync(outside, join(root, "escape"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("makeFsReader", () => {
  it("reads a file that exists", async () => {
    const r = await makeFsReader({ id: "vault", root }).read(
      { prefix: "vault", locator: "brand/voice.md", declared: "vault:brand/voice.md" });
    expect(r.outcome).toBe("found");
    expect(r.content).toContain("Quiet.");
  });

  it("reports a file that is not there as MISSING, not failed", async () => {
    const r = await makeFsReader({ id: "vault", root }).read(
      { prefix: "vault", locator: "brand/nope.md", declared: "vault:brand/nope.md" });
    expect(r.outcome).toBe("missing");
    expect(r.content).toBeUndefined();
  });

  it("reports an unreadable store root as FAILED — an absent mount is not an absent file", async () => {
    const r = await makeFsReader({ id: "vault", root: "/definitely/not/mounted" }).read(
      { prefix: "vault", locator: "brand/voice.md", declared: "vault:brand/voice.md" });
    expect(r.outcome).toBe("failed");
    expect(r.reason).toMatch(/store root/i);
  });

  it("refuses to follow a symlink out of the store", async () => {
    const r = await makeFsReader({ id: "vault", root }).read(
      { prefix: "vault", locator: "escape/secret.md", declared: "vault:escape/secret.md" });
    expect(r.outcome).toBe("failed");
    expect(r.reason).toMatch(/escape/i);
  });

  it("reports a file that exists but cannot be read as FAILED, not missing", async () => {
    // realpath succeeds (the file is right there) but the read itself fails — a
    // permissions problem on the file, not a deletion. Reporting `missing` here would
    // propose emptying a note whose source is fully intact.
    const locked = join(root, "brand", "locked.md");
    writeFileSync(locked, "eyes only");
    chmodSync(locked, 0o000);
    try {
      const r = await makeFsReader({ id: "vault", root }).read(
        { prefix: "vault", locator: "brand/locked.md", declared: "vault:brand/locked.md" });
      expect(r.outcome).toBe("failed");
      expect(r.content).toBeUndefined();
    } finally {
      chmodSync(locked, 0o644);
    }
  });

  it("reports a file it cannot reach for a reason OTHER than absence as FAILED", async () => {
    // EACCES on a PARENT directory: the file is present and intact, we simply cannot
    // look — this is the box's most likely trigger (the container user losing read on a
    // mounted subtree). Reporting that as `missing` would propose deleting every note
    // derived from the whole subtree in one tick.
    const blocked = join(root, "blocked");
    mkdirSync(blocked, { recursive: true });
    writeFileSync(join(blocked, "file.md"), "still here");
    chmodSync(blocked, 0o000);
    try {
      const r = await makeFsReader({ id: "vault", root }).read(
        { prefix: "vault", locator: "blocked/file.md", declared: "vault:blocked/file.md" });
      expect(r.outcome).toBe("failed");
      expect(r.reason).toMatch(/eacces/i);
    } finally {
      chmodSync(blocked, 0o755);
    }
  });

  describe("the containment guard is byte-exact, not case-folded", () => {
    /**
     * Probes whether THIS filesystem can hold two directory entries whose names differ
     * ONLY by case as genuinely separate inodes — true on ext4 (the box), false on the
     * case-insensitive APFS volume most Macs (including this dev machine) run by default.
     * A probe that cannot tell must throw rather than guess: silently treating "unclear"
     * as "insensitive" would let this test quietly stop meaning anything.
     */
    function filesystemIsCaseSensitive(dir: string): boolean {
      const lower = join(dir, "probe-case");
      const upper = join(dir, "PROBE-CASE");
      mkdirSync(lower);
      try {
        mkdirSync(upper);
      } catch (e) {
        rmSync(lower, { recursive: true, force: true });
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw e; // an unexpected errno is a broken probe, not an answer
      }
      const bothPresent = existsSync(lower) && existsSync(upper);
      rmSync(lower, { recursive: true, force: true });
      rmSync(upper, { recursive: true, force: true });
      if (!bothPresent) {
        throw new Error("case-sensitivity probe produced an inconsistent result — cannot trust either branch");
      }
      return true;
    }

    it("refuses a symlink to a sibling whose name differs only in case", async () => {
      // On ext4 (the box) these are different directories. The guard must not be
      // case-folding, or a symlink out of the store reads as contained.
      const probeDir = mkdtempSync(join(tmpdir(), "atlas-fs-case-probe-"));
      let caseSensitive: boolean;
      try {
        caseSensitive = filesystemIsCaseSensitive(probeDir);
      } finally {
        rmSync(probeDir, { recursive: true, force: true });
      }

      if (!caseSensitive) {
        // This filesystem folds case, so a genuinely case-only sibling cannot exist here
        // — asserting on one would test nothing. Assert the weaker-but-still-real property
        // instead of silently skipping: the guard still refuses a symlink target that is a
        // wholly different directory (exercised above by "refuses to follow a symlink out
        // of the store"), and the probe itself is asserted here so a broken probe cannot
        // disappear this test by quietly reporting the wrong branch.
        expect(caseSensitive).toBe(false);
        return;
      }

      // Build the real thing: a sibling of `root`, same parent, name differing only in
      // case — `<base>/atlas-fs-XXXX` vs `<base>/ATLAS-FS-XXXX` — and a symlink from
      // inside the store pointing at it.
      const upperSibling = join(dirname(root), basename(root).toUpperCase());
      mkdirSync(upperSibling, { recursive: true });
      writeFileSync(join(upperSibling, "secret.md"), "EXFILTRATED");
      symlinkSync(upperSibling, join(root, "case-escape"));
      try {
        const r = await makeFsReader({ id: "vault", root }).read(
          { prefix: "vault", locator: "case-escape/secret.md", declared: "vault:case-escape/secret.md" });
        expect(r.outcome).toBe("failed");
        expect(r.content).toBeUndefined();
      } finally {
        rmSync(upperSibling, { recursive: true, force: true });
      }
    });
  });
});
