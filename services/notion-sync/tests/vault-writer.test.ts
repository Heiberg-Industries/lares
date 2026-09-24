// Real git, real filesystem, no mocks — mirroring services/box's own
// brain-source.test.ts (a bare "origin" plus a working clone in a tmpdir). The
// whole point of this adapter is the git/lock side effects, so faking them would
// test nothing.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, symlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { makeVaultWriter } from "../lib/adapters/vault-writer.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args]).toString().trim();
}

let root: string;
let bare: string;
let vault: string;

function seed(relPath: string, content: string): void {
  const abs = join(vault, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  git(vault, "add", "--", relPath);
  git(vault, "commit", "-q", "-m", `seed ${relPath}`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "notion-sync-vault-"));
  bare = join(root, "brain.git");
  vault = join(root, "brain");
  execFileSync("git", ["init", "--bare", "-b", "main", bare]);
  execFileSync("git", ["clone", "-q", bare, vault]);
  git(vault, "config", "user.email", "sync@lares.test");
  git(vault, "config", "user.name", "notion-sync");
  seed("README.md", "seed\n");
  git(vault, "push", "-q", "origin", "main");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("makeVaultWriter — writeVaultFile", () => {
  it("writes the bytes verbatim, commits them, and pushes to the bare remote", async () => {
    seed("desks/orakel/note.md", "---\ntitle: Note\n---\n\nold body\n");
    const writer = makeVaultWriter({ vaultPath: vault });
    const content = "---\ntitle: Note\n---\n\nny tekst — æøå 🎧\n";

    await writer.writeVaultFile("desks/orakel/note.md", content);

    expect(readFileSync(join(vault, "desks/orakel/note.md"), "utf8")).toBe(content);
    expect(git(vault, "log", "-1", "--pretty=%s")).toBe("notion-sync: apply desks/orakel/note.md");
    expect(git(vault, "status", "--porcelain")).toBe("");
    const bareHead = execFileSync("git", ["--git-dir", bare, "rev-parse", "main"]).toString().trim();
    expect(bareHead).toBe(git(vault, "rev-parse", "HEAD"));
  });

  it("creates missing parent directories for a new file", async () => {
    const writer = makeVaultWriter({ vaultPath: vault });
    await writer.writeVaultFile("desks/new/deep/note.md", "body\n");
    expect(readFileSync(join(vault, "desks/new/deep/note.md"), "utf8")).toBe("body\n");
    expect(git(vault, "log", "-1", "--pretty=%s")).toBe("notion-sync: apply desks/new/deep/note.md");
  });

  it("keeps the local commit when the push fails", async () => {
    rmSync(bare, { recursive: true, force: true });
    const writer = makeVaultWriter({ vaultPath: vault });

    await expect(writer.writeVaultFile("desks/orakel/note.md", "body\n")).resolves.toBeUndefined();
    expect(git(vault, "log", "-1", "--pretty=%s")).toBe("notion-sync: apply desks/orakel/note.md");
  });

  it("succeeds without committing when the content is already what the file holds", async () => {
    // An approved proposal can reassemble to exactly the bytes on disk (a Notion
    // edit that only touched something the translation drops). `git commit` exits
    // non-zero on an empty commit, which would surface as a failed apply — the
    // proposal retrying forever and the row walking to 'error'. The vault already
    // holds the content: that IS the applied state.
    const content = "---\ntitle: Note\n---\n\nunchanged\n";
    seed("desks/orakel/same.md", content);
    const before = git(vault, "rev-list", "--count", "HEAD");
    const writer = makeVaultWriter({ vaultPath: vault });

    await expect(writer.writeVaultFile("desks/orakel/same.md", content)).resolves.toBeUndefined();

    expect(git(vault, "rev-list", "--count", "HEAD")).toBe(before);
    expect(readFileSync(join(vault, "desks/orakel/same.md"), "utf8")).toBe(content);
    expect(git(vault, "status", "--porcelain")).toBe("");
  });

  it("never sweeps someone else's staged work into its own commit", async () => {
    // The vault clone is shared with humans and other writers; whatever they have
    // staged is none of this adapter's business, in either direction — it must
    // neither commit it nor let its presence turn a no-op apply into a commit.
    const content = "---\ntitle: Note\n---\n\nunchanged\n";
    seed("desks/orakel/same.md", content);
    writeFileSync(join(vault, "unrelated.md"), "someone else's work in progress\n", "utf8");
    git(vault, "add", "--", "unrelated.md");
    const before = git(vault, "rev-list", "--count", "HEAD");
    const writer = makeVaultWriter({ vaultPath: vault });

    await expect(writer.writeVaultFile("desks/orakel/same.md", content)).resolves.toBeUndefined();

    expect(git(vault, "rev-list", "--count", "HEAD")).toBe(before);
    expect(git(vault, "status", "--porcelain")).toBe("A  unrelated.md");

    // And when there IS something of its own to commit, the commit is scoped to
    // that file — the unrelated staged work stays staged and uncommitted.
    await writer.writeVaultFile("desks/orakel/same.md", "---\ntitle: Note\n---\n\nchanged\n");
    expect(git(vault, "log", "-1", "--pretty=%s")).toBe("notion-sync: apply desks/orakel/same.md");
    expect(git(vault, "show", "--name-only", "--pretty=format:", "HEAD")).toBe("desks/orakel/same.md");
    expect(git(vault, "status", "--porcelain")).toBe("A  unrelated.md");
  });

  it("refuses a path that escapes the vault", async () => {
    const writer = makeVaultWriter({ vaultPath: vault });
    await expect(writer.writeVaultFile("../escape.md", "nope")).rejects.toThrow(/traversal/i);
    expect(existsSync(join(root, "escape.md"))).toBe(false);
  });
});

// The authoritative half of the create guard (T3b). These are not the engine's
// checks with fakes — this is the real filesystem, real symlinks, and the real
// O_EXCL write, because "never overwrite" and "never escape the vault" are
// properties of the syscall, not of the code that decided to call it.
describe("makeVaultWriter — createVaultFile", () => {
  it("creates the file with its parent directories, commits it, and pushes", async () => {
    const writer = makeVaultWriter({ vaultPath: vault });
    const content = "---\ntitle: Standup\n---\n\nny fil — æøå 🎧\n";

    await writer.createVaultFile("zero7/transcripts/2026-08-05-standup.md", content);

    expect(readFileSync(join(vault, "zero7/transcripts/2026-08-05-standup.md"), "utf8")).toBe(content);
    expect(git(vault, "log", "-1", "--pretty=%s"))
      .toBe("notion-sync: create zero7/transcripts/2026-08-05-standup.md");
    expect(git(vault, "status", "--porcelain")).toBe("");
    const bareHead = execFileSync("git", ["--git-dir", bare, "rev-parse", "main"]).toString().trim();
    expect(bareHead).toBe(git(vault, "rev-parse", "HEAD"));
  });

  // THE guard, at the only place it cannot be bypassed. The engine checks "does it
  // exist?" a moment earlier so it can refuse cleanly and say why; this is what
  // holds when a human saves a file in the microseconds between that check and this
  // write. O_EXCL makes it a property of the open(2) call — there is no window.
  it("refuses to overwrite a file that already exists, and leaves its bytes alone", async () => {
    seed("zero7/notes/keep.md", "hand-written, not to be lost\n");
    const writer = makeVaultWriter({ vaultPath: vault });

    await expect(writer.createVaultFile("zero7/notes/keep.md", "from notion\n"))
      .rejects.toThrow(/already exists/i);
    expect(readFileSync(join(vault, "zero7/notes/keep.md"), "utf8")).toBe("hand-written, not to be lost\n");
  });

  it("refuses an existing file even when it is untracked — git has nothing to do with it", async () => {
    mkdirSync(join(vault, "zero7/notes"), { recursive: true });
    writeFileSync(join(vault, "zero7/notes/draft.md"), "unsaved draft\n", "utf8");
    const writer = makeVaultWriter({ vaultPath: vault });

    await expect(writer.createVaultFile("zero7/notes/draft.md", "from notion\n"))
      .rejects.toThrow(/already exists/i);
    expect(readFileSync(join(vault, "zero7/notes/draft.md"), "utf8")).toBe("unsaved draft\n");
  });

  // resolve() — what the traversal guard has always used — does NOT resolve
  // symlinks, so a symlinked directory inside the vault pointing outside it passes
  // every string check while writing somewhere else entirely. Closing that needs the
  // real path of the deepest EXISTING ancestor of the target.
  it("refuses a target reached through a symlinked directory that leaves the vault", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(vault, "escape"));
    const writer = makeVaultWriter({ vaultPath: vault });

    await expect(writer.createVaultFile("escape/payload.md", "nope\n"))
      .rejects.toThrow(/symlink/i);
    expect(existsSync(join(outside, "payload.md"))).toBe(false);
  });

  // The check has to climb to the deepest EXISTING ancestor: the immediate parent of
  // a nested target does not exist yet, so a naive "realpath the parent" would find
  // nothing to inspect and let the whole branch be created through the link.
  it("refuses a target whose deeper, not-yet-created parent sits under an escaping symlink", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(vault, "escape"));
    const writer = makeVaultWriter({ vaultPath: vault });

    await expect(writer.createVaultFile("escape/deep/nested/payload.md", "nope\n"))
      .rejects.toThrow(/symlink/i);
    expect(existsSync(join(outside, "deep"))).toBe(false);
  });

  // Strict on purpose, even though this one does not escape: a link that stays
  // inside the vault today can be re-pointed outside it tomorrow, and `git add`
  // refuses a pathspec "beyond a symbolic link" outright — so a file created here
  // would be written and then fail to commit, leaving an uncommitted file the store
  // already believes is synced.
  it("refuses a symlinked directory even when it stays inside the vault", async () => {
    mkdirSync(join(vault, "real/desk"), { recursive: true });
    symlinkSync(join(vault, "real/desk"), join(vault, "link"));
    const writer = makeVaultWriter({ vaultPath: vault });

    await expect(writer.createVaultFile("link/note.md", "inside\n")).rejects.toThrow(/symlink/i);
    expect(existsSync(join(vault, "real/desk/note.md"))).toBe(false);
  });

  // An EXISTING symlink at the target path is a file as far as O_EXCL is concerned,
  // dangling or not — so a link planted at the target cannot be followed to write
  // through it.
  it("refuses a target that is itself a symlink pointing out of the vault", async () => {
    const outside = join(root, "outside.md");
    writeFileSync(outside, "someone else's file\n", "utf8");
    mkdirSync(join(vault, "zero7"), { recursive: true });
    symlinkSync(outside, join(vault, "zero7/linked.md"));
    const writer = makeVaultWriter({ vaultPath: vault });

    await expect(writer.createVaultFile("zero7/linked.md", "from notion\n"))
      .rejects.toThrow(/already exists/i);
    expect(readFileSync(outside, "utf8")).toBe("someone else's file\n");
  });

  it("refuses the shape the pure guard refuses — one definition, enforced here too", async () => {
    const writer = makeVaultWriter({ vaultPath: vault });

    await expect(writer.createVaultFile("wiki/note.md", "x\n")).rejects.toThrow(/mirror/i);
    await expect(writer.createVaultFile("_archive/note.md", "x\n")).rejects.toThrow(/_archive/);
    await expect(writer.createVaultFile(".git/hooks/note.md", "x\n")).rejects.toThrow(/dot-directory/i);
    await expect(writer.createVaultFile("../escape.md", "x\n")).rejects.toThrow(/walks the tree/i);
    await expect(writer.createVaultFile("zero7/payload.sh", "x\n")).rejects.toThrow(/markdown/i);
    expect(existsSync(join(root, "escape.md"))).toBe(false);
    expect(git(vault, "status", "--porcelain")).toBe("");
  });
});

describe("makeVaultWriter — archiveVaultFile", () => {
  it("git-mvs the file under _archive/ and commits the move", async () => {
    seed("desks/orakel/gone.md", "body\n");
    const writer = makeVaultWriter({ vaultPath: vault });

    await writer.archiveVaultFile("desks/orakel/gone.md");

    expect(existsSync(join(vault, "desks/orakel/gone.md"))).toBe(false);
    expect(readFileSync(join(vault, "_archive/desks/orakel/gone.md"), "utf8")).toBe("body\n");
    expect(git(vault, "log", "-1", "--pretty=%s")).toBe("notion-sync: archive desks/orakel/gone.md");
    expect(git(vault, "status", "--porcelain")).toBe("");
    const bareHead = execFileSync("git", ["--git-dir", bare, "rev-parse", "main"]).toString().trim();
    expect(bareHead).toBe(git(vault, "rev-parse", "HEAD"));
  });

  it("refuses a path that escapes the vault", async () => {
    const writer = makeVaultWriter({ vaultPath: vault });
    await expect(writer.archiveVaultFile("../../etc/passwd")).rejects.toThrow(/traversal/i);
  });
});
