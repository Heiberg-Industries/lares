// services/box/tests/erase-person-vault.test.ts — W5B-s7: the vault half of erasing a person.
//
// WHY A REAL GIT REPOSITORY AND NOT A MOCK. The two things this code can get wrong are both
// things a mock would agree with: a file that `git rm` cannot see because it was never tracked
// (the conversation logs `writeRawNote` leaves behind), and a commit that claims to have removed
// files it did not. So every test below runs against a real `git init` in a throwaway directory,
// and reads the real `git log`.
//
// THE ROOT IS DELIBERATELY NOT REALPATH'D. `mkdtempSync` under macOS's temp directory hands back
// a path through the `/var` → `/private/var` symlink. A containment check that compares a
// resolved candidate against an UNRESOLVED root denies everything, which is the bug
// `notes-store.ts`'s `resolvesWithin` header describes. Passing the unresolved path here is what
// proves we did not reintroduce it.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ERASE_COMMIT_NOTE,
  erasePersonFiles,
  findPersonFiles,
  type VaultHit,
} from "../lib/erase-person-vault.js";

/** The person being erased, under both the spelling they have now and one they used to have. */
const SPELLINGS = ["fixture-owner", "fixture-old-handle"] as const;
/** Another member of the same installation. Their data is not this routine's to touch. */
const SECOND = "fixture-second";

let root: string;
let outside: string;

function write(relPath: string, body: string): void {
  const abs = join(root, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

function git(...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "erase-vault-"));
  outside = mkdtempSync(join(tmpdir(), "erase-outside-"));

  // ── Tracked files: committed before the untracked ones exist. ──
  write("people/ada.md", "---\nowner: fixture-owner\nscope: private\n---\n\nA note.\n");
  write("people/old.md", "---\nowner: fixture-old-handle\nscope: private\n---\n\nWritten under the old spelling.\n");
  write("people/quoted-owner.md", '---\nowner: "fixture-owner"\nscope: private\n---\n\nQuoted scalar.\n');
  write("people/crlf.md", "---\r\nowner: fixture-owner\r\nscope: private\r\n---\r\n\r\nSaved on Windows.\r\n");
  write("people/other.md", `---\nowner: ${SECOND}\nscope: private\n---\n\nSomebody else's.\n`);
  write(
    "projects/shared.md",
    `---\nscope: participants\nparticipants: [fixture-owner, ${SECOND}]\n---\n\nBoth of them.\n`,
  );
  write(
    "projects/pair.md",
    "---\nscope: participants\nparticipants: [fixture-owner, fixture-old-handle]\n---\n\nOne person, two spellings.\n",
  );
  write(
    "projects/block-sole.md",
    "---\nscope: participants\nparticipants:\n  - fixture-owner\ntitle: a block list\n---\n\nOne person.\n",
  );
  write(
    "projects/block-shared.md",
    `---\nscope: participants\nparticipants:\n  - "fixture-owner"\n  - ${SECOND}\n---\n\nQuoted, in a block list.\n`,
  );
  write("_meta/dream/2026-09-01.md", "---\nowner: fixture-owner\n---\n\nA dream note, under _meta.\n");

  git("init", "-q");
  git("config", "user.name", "Fixture Operator");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "the vault as it stood");

  // ── Untracked: what `writeRawNote` leaves behind, which `git rm` cannot see. ──
  write("_meta/scratch.md", "---\nowner: fixture-owner\n---\n\nAn untracked conversation log.\n");
  // An excluded directory that happens to name the person: never walked, never removed.
  write(".obsidian/notes.md", "---\nowner: fixture-owner\n---\n\nEditor state.\n");

  // ── A symlink out of the root, pointing at a file that WOULD match. ──
  writeFileSync(join(outside, "secret.md"), "---\nowner: fixture-owner\n---\n\nNot in this vault.\n");
  symlinkSync(join(outside, "secret.md"), join(root, "escape.md"));
  symlinkSync(outside, join(root, "escape-dir"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("findPersonFiles — a full walk, because the vault has no person index", () => {
  it("finds a note by its owner: key, by an OLD spelling, and by its participants: list", () => {
    const hits = findPersonFiles(root, SPELLINGS);
    expect(hits.map((h) => [h.path, h.why])).toEqual([
      ["_meta/dream/2026-09-01.md", "meta"],
      ["_meta/scratch.md", "meta"],
      ["people/ada.md", "owner"],
      ["people/crlf.md", "owner"],
      ["people/old.md", "owner"],
      ["people/quoted-owner.md", "owner"],
      ["projects/block-shared.md", "shared"],
      ["projects/block-sole.md", "sole-participant"],
      ["projects/pair.md", "sole-participant"],
      ["projects/shared.md", "shared"],
    ]);
  });

  it("walks _meta, which the notes store's list and search deliberately exclude", () => {
    const hits = findPersonFiles(root, SPELLINGS);
    expect(hits.some((h) => h.path === "_meta/dream/2026-09-01.md")).toBe(true);
    expect(hits.some((h) => h.path === "_meta/scratch.md")).toBe(true);
  });

  it("knows which hits git can see and which it cannot", () => {
    const byPath = new Map(findPersonFiles(root, SPELLINGS).map((h) => [h.path, h.tracked]));
    expect(byPath.get("people/ada.md")).toBe(true);
    expect(byPath.get("_meta/dream/2026-09-01.md")).toBe(true);
    expect(byPath.get("_meta/scratch.md")).toBe(false);
  });

  it("leaves another member's note alone, and never walks an excluded directory", () => {
    const paths = findPersonFiles(root, SPELLINGS).map((h) => h.path);
    expect(paths).not.toContain("people/other.md");
    expect(paths).not.toContain(".obsidian/notes.md");
  });

  it("does not follow a symlink out of the root", () => {
    const paths = findPersonFiles(root, SPELLINGS).map((h) => h.path);
    expect(paths).not.toContain("escape.md");
    expect(paths.some((p) => p.startsWith("escape-dir"))).toBe(false);
  });

  it("refuses an empty spelling list rather than matching everything", () => {
    expect(() => findPersonFiles(root, [])).toThrow(/spelling/i);
    expect(() => findPersonFiles(root, ["  "])).toThrow(/spelling/i);
  });
});

describe("erasePersonFiles — what it removes, and what it refuses to decide", () => {
  it("removes tracked files with git rm and untracked ones with rm, in one commit", async () => {
    const hits = findPersonFiles(root, SPELLINGS);
    const out = await erasePersonFiles({ vaultRoot: root, hits, dryRun: false });

    expect(out.removed).toEqual([
      "_meta/dream/2026-09-01.md",
      "people/ada.md",
      "people/crlf.md",
      "people/old.md",
      "people/quoted-owner.md",
      "projects/block-sole.md",
      "projects/pair.md",
    ]);
    expect(out.untracked).toEqual(["_meta/scratch.md"]);
    expect(out.commit).not.toBe(null);

    for (const p of [...out.removed, ...out.untracked]) {
      expect(existsSync(join(root, p))).toBe(false);
    }
    expect(git("log", "--oneline").split("\n")[0]).toContain("erase: 7 file(s) for one person");
    // Nothing tracked is left half-removed: the commit holds every deletion it made. (Untracked
    // files the walk ignored — the editor's own directory, the symlinks — are still there.)
    expect(git("status", "--porcelain", "--untracked-files=no")).toBe("");
  });

  it("leaves a note that names somebody else untouched, byte for byte, and reports it", async () => {
    const before = readFileSync(join(root, "projects/shared.md"));
    const hits = findPersonFiles(root, SPELLINGS);

    const out = await erasePersonFiles({ vaultRoot: root, hits, dryRun: false });

    expect(out.leftShared).toEqual(["projects/block-shared.md", "projects/shared.md"]);
    expect(existsSync(join(root, "projects/shared.md"))).toBe(true);
    expect(readFileSync(join(root, "projects/shared.md")).equals(before)).toBe(true);
    expect(out.removed).not.toContain("projects/shared.md");
    expect(out.untracked).not.toContain("projects/shared.md");
  });

  it("names nobody in the commit message — not the id, not an old spelling", async () => {
    const hits = findPersonFiles(root, SPELLINGS);
    await erasePersonFiles({ vaultRoot: root, hits, dryRun: false });

    const message = git("log", "-1", "--format=%B");
    for (const spelling of [...SPELLINGS, SECOND]) expect(message).not.toContain(spelling);
    expect(message).toContain(ERASE_COMMIT_NOTE);
  });

  it("says in the commit message itself what it does not undo", () => {
    expect(ERASE_COMMIT_NOTE).toMatch(/history/i);
    expect(ERASE_COMMIT_NOTE).toMatch(/git log -p/);
    expect(ERASE_COMMIT_NOTE).not.toMatch(/\b(Saga|Marcel|Calliope|bendik|orbis|heiberg)\b/i);
  });

  it("never pushes: the commit stays local, for a person to send deliberately", async () => {
    const hits = findPersonFiles(root, SPELLINGS);
    await erasePersonFiles({ vaultRoot: root, hits, dryRun: false });
    // No remote was ever configured; a push would have thrown. This asserts the absence stays.
    expect(git("remote").trim()).toBe("");
  });

  it("a dry run touches nothing and commits nothing", async () => {
    const hits = findPersonFiles(root, SPELLINGS);
    const head = git("rev-parse", "HEAD").trim();

    const out = await erasePersonFiles({ vaultRoot: root, hits, dryRun: true });

    expect(out.commit).toBe(null);
    expect(out.removed).toContain("people/ada.md");
    expect(out.untracked).toEqual(["_meta/scratch.md"]);
    expect(out.leftShared).toEqual(["projects/block-shared.md", "projects/shared.md"]);
    expect(existsSync(join(root, "people/ada.md"))).toBe(true);
    expect(existsSync(join(root, "_meta/scratch.md"))).toBe(true);
    expect(git("rev-parse", "HEAD").trim()).toBe(head);
    expect(git("status", "--porcelain")).not.toBe("");
  });

  it("removes a person's note even when it has an uncommitted local edit", async () => {
    write("people/ada.md", readFileSync(join(root, "people/ada.md"), "utf8") + "\nan unsaved line\n");
    const hits = findPersonFiles(root, SPELLINGS);

    const out = await erasePersonFiles({ vaultRoot: root, hits, dryRun: false });

    expect(out.removed).toContain("people/ada.md");
    expect(existsSync(join(root, "people/ada.md"))).toBe(false);
    expect(out.commit).not.toBe(null);
  });

  it("refuses, before touching a file, when somebody else's change is already staged", async () => {
    write("projects/unrelated.md", "---\nowner: " + SECOND + "\n---\nstaged by somebody else\n");
    git("add", "projects/unrelated.md");
    const head = git("rev-parse", "HEAD").trim();
    const hits = findPersonFiles(root, SPELLINGS);

    await expect(erasePersonFiles({ vaultRoot: root, hits, dryRun: false })).rejects.toThrow(/staged/);

    expect(existsSync(join(root, "people/ada.md"))).toBe(true);
    expect(git("rev-parse", "HEAD").trim()).toBe(head);
  });

  it("nothing to remove means no commit at all", async () => {
    const head = git("rev-parse", "HEAD").trim();
    const shared: VaultHit[] = findPersonFiles(root, SPELLINGS).filter((h) => h.why === "shared");

    const out = await erasePersonFiles({ vaultRoot: root, hits: shared, dryRun: false });

    expect(out.commit).toBe(null);
    expect(out.removed).toEqual([]);
    expect(out.untracked).toEqual([]);
    expect(git("rev-parse", "HEAD").trim()).toBe(head);
  });

  it("refuses a hit whose path would land outside the vault", async () => {
    const escape: VaultHit[] = [{ path: "../escaped.md", why: "owner", tracked: false }];
    await expect(erasePersonFiles({ vaultRoot: root, hits: escape, dryRun: true })).rejects.toThrow(
      /outside/i,
    );
  });

  it("a vault that is not a git repository still loses its files, and reports no commit", async () => {
    const plain = mkdtempSync(join(tmpdir(), "erase-plain-"));
    try {
      mkdirSync(join(plain, "people"));
      writeFileSync(join(plain, "people/ada.md"), "---\nowner: fixture-owner\n---\n\nA note.\n");

      const hits = findPersonFiles(plain, SPELLINGS);
      expect(hits).toEqual([{ path: "people/ada.md", why: "owner", tracked: false }]);

      const out = await erasePersonFiles({ vaultRoot: plain, hits, dryRun: false });
      expect(out.commit).toBe(null);
      expect(out.untracked).toEqual(["people/ada.md"]);
      expect(existsSync(join(plain, "people/ada.md"))).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
