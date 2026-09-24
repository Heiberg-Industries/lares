/**
 * ORB-133 Task 3 — the `fileNote` seam, the one place this port can break silently.
 *
 * `fileDecision` needs a `FileNoteFn`. The old implementation
 * (`services/box/lib/brain-source.ts:175-197`) does FOUR things in ONE commit: write the
 * destination, `git add` it, **remove the `_inbox` source**, and commit with the caller's own
 * message. eve-saga's nearest helper, `commitNote`, does none of the removal and hardcodes its
 * message.
 *
 * Reuse `commitNote` naively and every filed clip stays in `_inbox`, to be re-classified,
 * re-filed and re-posted on the next pass — a duplicate-filing loop that grows daily and looks
 * exactly like the digest working. That is what these tests exist to prevent, which is why they
 * run against a REAL temp git repo: the behaviour under test IS the git invocations, so a mock
 * would prove nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { makeDigestFileNote } from "../lib/digest-file.js";

let vault: string;
let bare: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

beforeEach(() => {
  bare = mkdtempSync(join(tmpdir(), "digest-bare-"));
  execFileSync("git", ["init", "--bare", "-q", bare]);
  vault = mkdtempSync(join(tmpdir(), "digest-vault-"));
  execFileSync("git", ["init", "-q", vault]);
  git(vault, "config", "user.email", "t@t.t");
  git(vault, "config", "user.name", "t");
  git(vault, "remote", "add", "origin", bare);
  writeFileSync(join(vault, "README.md"), "seed\n");
  git(vault, "add", "README.md");
  git(vault, "commit", "-q", "-m", "seed");
  git(vault, "push", "-q", "origin", "HEAD");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
});

describe("writing the destination note", () => {
  it("writes it with serialised frontmatter and returns a commit", async () => {
    const fileNote = makeDigestFileNote(vault);
    const { commit } = await fileNote({
      destPath: "reads/a-note.md",
      frontmatter: { title: "A Note", type: "reference" },
      body: "the body",
      message: "digest: file A Note → reads",
    });
    expect(commit).toMatch(/^[0-9a-f]{7,}$/);
    const written = readFileSync(join(vault, "reads/a-note.md"), "utf8");
    expect(written).toContain("title: A Note");
    expect(written).toContain("the body");
  });

  it("creates nested destination directories", async () => {
    const fileNote = makeDigestFileNote(vault);
    await fileNote({
      destPath: "zero7/transcripts/deep/call.md",
      frontmatter: {}, body: "b", message: "m",
    });
    expect(existsSync(join(vault, "zero7/transcripts/deep/call.md"))).toBe(true);
  });

  it("uses the CALLER'S commit message — the vault history says what the digest did", async () => {
    const fileNote = makeDigestFileNote(vault);
    await fileNote({
      destPath: "reads/b.md", frontmatter: {}, body: "b",
      message: "digest: file B → reads",
    });
    expect(git(vault, "log", "-1", "--pretty=%s").trim()).toBe("digest: file B → reads");
  });

  it("pushes to the bare remote, not just locally", async () => {
    const fileNote = makeDigestFileNote(vault);
    await fileNote({ destPath: "reads/p.md", frontmatter: {}, body: "p", message: "m" });
    expect(git(bare, "log", "-1", "--pretty=%s").trim()).toBe("m");
  });
});

describe("retiring the _inbox source — THE regression this file exists for", () => {
  it("removes a TRACKED source note, in the SAME commit as the write", async () => {
    mkdirSync(join(vault, "_inbox"), { recursive: true });
    writeFileSync(join(vault, "_inbox/clip.md"), "clip\n");
    git(vault, "add", "_inbox/clip.md");
    git(vault, "commit", "-q", "-m", "add clip");

    const before = Number(git(vault, "rev-list", "--count", "HEAD").trim());
    const fileNote = makeDigestFileNote(vault);
    await fileNote({
      destPath: "reads/c.md", sourcePath: "_inbox/clip.md",
      frontmatter: {}, body: "c", message: "digest: file C → reads",
    });

    expect(existsSync(join(vault, "_inbox/clip.md"))).toBe(false);
    // ONE commit, not two: a write-then-remove pair leaves a window where the note exists in
    // both places, and a crash inside it leaves it there permanently.
    expect(Number(git(vault, "rev-list", "--count", "HEAD").trim())).toBe(before + 1);
    const touched = git(vault, "show", "--name-status", "--pretty=", "HEAD");
    expect(touched).toContain("reads/c.md");
    expect(touched).toContain("_inbox/clip.md");
  });

  it("removes an UNTRACKED source note too — a clipper drop is not in the index", async () => {
    mkdirSync(join(vault, "_inbox"), { recursive: true });
    writeFileSync(join(vault, "_inbox/untracked.md"), "clip\n");

    const fileNote = makeDigestFileNote(vault);
    await fileNote({
      destPath: "reads/d.md", sourcePath: "_inbox/untracked.md",
      frontmatter: {}, body: "d", message: "digest: file D → reads",
    });

    // `git rm --ignore-unmatch` is a NO-OP for an untracked path, so without the explicit
    // unlink the file survives and gets re-classified on every future pass.
    expect(existsSync(join(vault, "_inbox/untracked.md"))).toBe(false);
  });

  it("files normally when no source is given (a Karakeep import has none)", async () => {
    const fileNote = makeDigestFileNote(vault);
    await fileNote({ destPath: "_inbox/new.md", frontmatter: {}, body: "n", message: "m" });
    expect(existsSync(join(vault, "_inbox/new.md"))).toBe(true);
  });

  it("a missing source path is not an error — the item may already be gone", async () => {
    const fileNote = makeDigestFileNote(vault);
    await expect(fileNote({
      destPath: "reads/e.md", sourcePath: "_inbox/never-existed.md",
      frontmatter: {}, body: "e", message: "m",
    })).resolves.toBeTruthy();
  });
});

describe("containment — both paths are judged before any git call", () => {
  it("rejects a destination that escapes the vault", async () => {
    const fileNote = makeDigestFileNote(vault);
    await expect(fileNote({
      destPath: "../escape.md", frontmatter: {}, body: "x", message: "m",
    })).rejects.toThrow();
  });

  it("rejects an absolute destination", async () => {
    const fileNote = makeDigestFileNote(vault);
    await expect(fileNote({
      destPath: "/etc/passwd", frontmatter: {}, body: "x", message: "m",
    })).rejects.toThrow();
  });

  it("rejects a SOURCE path that escapes the vault, and writes nothing", async () => {
    const fileNote = makeDigestFileNote(vault);
    await expect(fileNote({
      destPath: "reads/f.md", sourcePath: "../../etc/passwd",
      frontmatter: {}, body: "x", message: "m",
    })).rejects.toThrow();
    expect(existsSync(join(vault, "reads/f.md"))).toBe(false);
  });
});

describe("push failure", () => {
  it("THROWS, carrying the durable local commit", async () => {
    git(vault, "remote", "set-url", "origin", join(tmpdir(), `gone-${Date.now()}`));
    const fileNote = makeDigestFileNote(vault);
    await expect(fileNote({
      destPath: "reads/g.md", frontmatter: {}, body: "g", message: "m",
    })).rejects.toThrow(/push/i);
    // The note is not lost — the throw reports a SYNC gap, and runDigest's per-item catch
    // turns it into a reported error while the rest of the pass continues.
    expect(existsSync(join(vault, "reads/g.md"))).toBe(true);
    expect(git(vault, "log", "-1", "--pretty=%s").trim()).toBe("m");
  });
});
