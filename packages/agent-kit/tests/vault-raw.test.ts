import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { writeRawNote } from "../src/vault-raw.js";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "raw-vault-"));
  execFileSync("git", ["init", "-q", vault]);
  execFileSync("git", ["-C", vault, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", vault, "config", "user.name", "t"]);
  writeFileSync(join(vault, "README.md"), "seed\n");
  execFileSync("git", ["-C", vault, "add", "README.md"]);
  execFileSync("git", ["-C", vault, "commit", "-q", "-m", "seed"]);
});

afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe("writeRawNote", () => {
  it("writes the file, creating nested directories", async () => {
    await writeRawNote({
      vaultRoot: vault,
      relPath: "_meta/conversations/2026-08-19/2026-08-19T10-00-00-000Z-slack.md",
      bytes: Buffer.from("hello", "utf8"),
    });
    const abs = join(vault, "_meta/conversations/2026-08-19/2026-08-19T10-00-00-000Z-slack.md");
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, "utf8")).toBe("hello");
  });

  // THE POINT OF THIS FILE: no commit, no push. One per turn would be unbearable.
  it("does NOT commit — the file stays untracked", async () => {
    const before = execFileSync("git", ["-C", vault, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim();
    await writeRawNote({ vaultRoot: vault, relPath: "_meta/conversations/x.md", bytes: Buffer.from("x") });
    const after = execFileSync("git", ["-C", vault, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim();
    expect(after).toBe(before);
    // -uall: without it, git collapses a wholly-untracked directory to "?? _meta/" instead of
    // listing the file inside it, and the assertion below would pass even if the write failed.
    const status = execFileSync("git", ["-C", vault, "status", "--porcelain", "-uall"], { encoding: "utf8" });
    expect(status).toContain("_meta/conversations");
  });

  it("rejects a path that escapes the vault", async () => {
    await expect(writeRawNote({
      vaultRoot: vault, relPath: "../escape.md", bytes: Buffer.from("x"),
    })).rejects.toThrow();
  });

  it("overwrites an existing file rather than appending", async () => {
    const p = "_meta/conversations/dup.md";
    await writeRawNote({ vaultRoot: vault, relPath: p, bytes: Buffer.from("first") });
    await writeRawNote({ vaultRoot: vault, relPath: p, bytes: Buffer.from("second") });
    expect(readFileSync(join(vault, p), "utf8")).toBe("second");
  });
});
