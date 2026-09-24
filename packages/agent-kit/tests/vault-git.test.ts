import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commitNote, moveNote, removeNote, VaultPushFailedError } from "../src/vault-git.js";
import { NotePathEscapesStoreError } from "../src/notes-store.js";

/**
 * The git mechanics behind the Brain write tools, against a REAL fixture git repo (a working
 * clone + a bare "origin", both real `git init`/`git init --bare` repos) — proves the actual
 * git invocations (add/commit/push/mv/rm) land, that an escaping path is refused before any
 * git command runs, and the ORB-51 push-failure posture: a push failure throws
 * `VaultPushFailedError` (never a silent success) while the local commit remains durably
 * present in the working clone's `git log`.
 *
 * ORB-143 Task 2: relocated from `services/chief-of-staff/tests/brain-writes.test.ts`, which
 * exercised this same logic indirectly through `vault_write`/`vault_file`/`vault_drop`'s
 * `.execute()`. Those three tools now live mounted in the @lares/agent-kit eve extension
 * (`agent-kit__brain_*`), and — unlike this module — their approval check DOES depend on
 * extension config (`extension.config.brain.isApprovedPrincipal`), which only binds through
 * eve's own compiled-agent loader (see `extension/lib/approval-gate.ts` and
 * `tests/approval-gate.test.ts`, which now cover that half). `commitNote`/`moveNote`/
 * `removeNote` themselves have ZERO extension-config dependency — they're plain functions
 * taking a `vaultRoot` argument — so this file tests them directly, the honest and simpler
 * replacement for going through a tool wrapper that added nothing to this half of the
 * coverage. The gating/approval-refusal tests that also lived in the old file are NOT
 * duplicated here; see `tests/approval-gate.test.ts`.
 */

let tmp: string;
let bareDir: string;
let workDir: string;

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function commitCount(dir: string): number {
  return git(dir, "log", "--oneline").trim().split("\n").filter(Boolean).length;
}

/** Commit+push a note directly via raw git, bypassing the functions under test — used to
 *  seed pre-existing notes for the move/remove tests. */
function seedNote(dir: string, relPath: string, content: string): void {
  const abs = join(dir, relPath);
  execFileSync("mkdir", ["-p", join(abs, "..")]);
  writeFileSync(abs, content, "utf8");
  git(dir, "add", "--", relPath);
  git(dir, "commit", "-q", "-m", `seed ${relPath}`);
  git(dir, "push", "-q", "origin", "HEAD");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "agent-kit-vault-git-"));
  bareDir = join(tmp, "brain.git");
  workDir = join(tmp, "brain");

  execFileSync("git", ["init", "--quiet", "--bare", bareDir]);
  execFileSync("git", ["clone", "--quiet", bareDir, workDir]);
  git(workDir, "config", "user.email", "test-suite@example.com");
  git(workDir, "config", "user.name", "Test Suite");

  // Seed an initial commit so the branch exists (a brand-new bare repo has no ref yet).
  writeFileSync(join(workDir, ".gitkeep"), "");
  git(workDir, "add", "--", ".gitkeep");
  git(workDir, "commit", "-q", "-m", "seed");
  git(workDir, "push", "-q", "origin", "HEAD");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("commitNote", () => {
  it("creates the note with serialised frontmatter, commits, and pushes (verified on the bare remote)", async () => {
    const result = await commitNote({
      vaultRoot: workDir,
      path: "_inbox/hello-world.md",
      frontmatter: { title: "Hello World", type: "note", source: "saga", owner: "saga", created: null, tags: ["a", "b"] },
      body: "Some body text.",
    });

    expect(result.commit).toMatch(/^[0-9a-f]{7,}$/);

    const written = git(workDir, "show", "HEAD:_inbox/hello-world.md");
    expect(written).toContain("title: Hello World");
    expect(written).toContain("type: note");
    expect(written).toContain("source: saga");
    expect(written).toContain("owner: saga");
    expect(written).toContain("tags: [a, b]");
    expect(written).toContain("Some body text.");

    // The push actually landed on the BARE remote, not just the working clone.
    expect(commitCount(bareDir)).toBe(2);
    const onBare = git(bareDir, "show", "HEAD:_inbox/hello-world.md");
    expect(onBare).toBe(written);
  });

  it("refuses a path escaping the vault root before any git command runs", async () => {
    const before = commitCount(bareDir);
    await expect(
      commitNote({ vaultRoot: workDir, path: "../../etc/passwd", frontmatter: {}, body: "b" }),
    ).rejects.toThrow(NotePathEscapesStoreError);
    expect(commitCount(bareDir)).toBe(before);
  });

  it("defaults the commit message to a role-neutral note:, and lets a caller override it (ORB-135)", async () => {
    // The default is asserted rather than assumed. It carries no persona name — this repo ships
    // no persona (CLAUDE.md) — so every caller that names nobody still commits a message that
    // attributes the write to nobody in particular.
    await commitNote({ vaultRoot: workDir, path: "_inbox/default-msg.md", frontmatter: {}, body: "b" });
    expect(git(workDir, "log", "-1", "--pretty=%s").trim()).toBe("note: _inbox/default-msg.md");

    // The override exists because the kit is shared: a role's own write tool, or a scheduled job
    // like the dream cycle's, can name the run instead — the vault's git log is the only audit
    // trail those writes have.
    await commitNote({
      vaultRoot: workDir,
      path: "_inbox/custom-msg.md",
      frontmatter: {},
      body: "b",
      message: "learning: 2026-09-18 (1 added, 0 superseded, 0 not learned)",
    });
    expect(git(workDir, "log", "-1", "--pretty=%s").trim()).toBe(
      "learning: 2026-09-18 (1 added, 0 superseded, 0 not learned)",
    );
  });

  it("throws VaultPushFailedError, carrying the local commit hash, while the local commit remains in git log", async () => {
    // Point origin at a path that is not a git repository at all — the push must fail.
    const unreachable = join(tmp, "does-not-exist");
    git(workDir, "remote", "set-url", "origin", unreachable);

    await expect(
      commitNote({ vaultRoot: workDir, path: "_inbox/orphaned.md", frontmatter: { title: "Orphaned Locally" }, body: "b" }),
    ).rejects.toThrow(VaultPushFailedError);

    // The commit DID happen locally and is durably present — that's the whole point of the
    // typed error: it must not look like nothing happened.
    const written = git(workDir, "show", "HEAD:_inbox/orphaned.md");
    expect(written).toContain("title: Orphaned Locally");

    try {
      await commitNote({ vaultRoot: workDir, path: "_inbox/orphaned-2.md", frontmatter: { title: "Second Orphan" }, body: "b2" });
      expect.unreachable("expected VaultPushFailedError");
    } catch (err) {
      expect(err).toBeInstanceOf(VaultPushFailedError);
      const secondHash = git(workDir, "rev-parse", "--short", "HEAD").trim();
      expect((err as VaultPushFailedError).commit).toBe(secondHash);
    }
  });
});

describe("moveNote", () => {
  it("moves the note into the destination folder, preserving history via git mv", async () => {
    seedNote(workDir, "_inbox/existing.md", "---\ntitle: Existing\n---\n\nBody.");

    const result = await moveNote({
      vaultRoot: workDir,
      sourcePath: "_inbox/existing.md",
      destPath: "writing-seeds/existing.md",
      message: "file existing.md → writing-seeds",
    });

    expect(result.commit).toBeTruthy();
    expect(existsSync(join(workDir, "_inbox/existing.md"))).toBe(false);
    expect(existsSync(join(workDir, "writing-seeds/existing.md"))).toBe(true);

    // git mv preserves history — --follow across the rename finds the seed commit too.
    const log = git(workDir, "log", "--follow", "--oneline", "--", "writing-seeds/existing.md");
    expect(log.trim().split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(2);

    const onBare = git(bareDir, "ls-tree", "-r", "--name-only", "HEAD");
    expect(onBare).toContain("writing-seeds/existing.md");
    expect(onBare).not.toContain("_inbox/existing.md");
  });

  it("refuses a source path escaping the vault root before any git command runs", async () => {
    seedNote(workDir, "_inbox/existing.md", "body");
    const before = commitCount(bareDir);
    await expect(
      moveNote({ vaultRoot: workDir, sourcePath: "../../etc/passwd", destPath: "writing-seeds/passwd", message: "x" }),
    ).rejects.toThrow(NotePathEscapesStoreError);
    expect(commitCount(bareDir)).toBe(before);
  });

  it("refuses a destination path escaping the vault root before any git command runs", async () => {
    seedNote(workDir, "_inbox/existing.md", "body");
    const before = commitCount(bareDir);
    await expect(
      moveNote({ vaultRoot: workDir, sourcePath: "_inbox/existing.md", destPath: "../../etc/existing.md", message: "x" }),
    ).rejects.toThrow(NotePathEscapesStoreError);
    expect(commitCount(bareDir)).toBe(before);
    expect(existsSync(join(workDir, "_inbox/existing.md"))).toBe(true);
  });
});

describe("removeNote", () => {
  it("removes the note, committed and pushed", async () => {
    seedNote(workDir, "_inbox/existing.md", "body");

    const result = await removeNote({ vaultRoot: workDir, path: "_inbox/existing.md", message: "drop existing.md" });

    expect(result.commit).toBeTruthy();
    expect(existsSync(join(workDir, "_inbox/existing.md"))).toBe(false);

    const log = git(workDir, "log", "-1", "--pretty=%s");
    expect(log.trim()).toBe("drop existing.md");

    const onBare = git(bareDir, "ls-tree", "-r", "--name-only", "HEAD");
    expect(onBare).not.toContain("_inbox/existing.md");
  });

  it("refuses a path escaping the vault root before any git command runs", async () => {
    const before = commitCount(bareDir);
    await expect(
      removeNote({ vaultRoot: workDir, path: "../../etc/passwd", message: "x" }),
    ).rejects.toThrow(NotePathEscapesStoreError);
    expect(commitCount(bareDir)).toBe(before);
  });
});
