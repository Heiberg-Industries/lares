import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAtlasWriter } from "../lib/adapters/atlas-writer.js";

let atlasPath: string;

beforeEach(() => {
  atlasPath = mkdtempSync(join(tmpdir(), "atlas-writer-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: atlasPath });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: atlasPath });
  execFileSync("git", ["config", "user.name", "t"], { cwd: atlasPath });
  // Isolation from the developer's ambient git config (review round 1, MINOR 9): a global
  // `commit.gpgsign=true` would hang or fail every commit in this suite waiting on a key that
  // doesn't exist for `t@example.com`, and a global `core.hooksPath` would run someone's real
  // hooks against a throwaway temp repo. Both are pinned per-repo so neither can reach in.
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: atlasPath });
  execFileSync("git", ["config", "core.hooksPath", "/dev/null"], { cwd: atlasPath });
  mkdirSync(join(atlasPath, "_projects"), { recursive: true });
  mkdirSync(join(atlasPath, "icp"), { recursive: true });
  writeFileSync(join(atlasPath, "_projects", "soma.md"), "---\ntype: venture\nbrand: soma\n---\n\nbody\n");
  writeFileSync(join(atlasPath, "icp", "zero7.md"), "# Zero7 ICP\n");
  writeFileSync(join(atlasPath, "README.md"), "# Atlas\n");
  execFileSync("git", ["add", "-A"], { cwd: atlasPath });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: atlasPath });
});

afterEach(() => { rmSync(atlasPath, { recursive: true, force: true }); });

describe("makeAtlasWriter", () => {
  it("lists every markdown file, Atlas-relative, in a stable order", () => {
    expect(makeAtlasWriter({ atlasPath }).listNotes())
      .toEqual(["README.md", "_projects/soma.md", "icp/zero7.md"]);
  });

  it("sorts explicitly — proven by a fixture whose creation order is NOT sorted order", () => {
    // Review round 1, IMPORTANT 4: the earlier version of this fixture happened to already
    // enumerate in sorted order on APFS, so deleting `.sort()` from `listNotes` left every
    // test green. This fixture is built in reverse-of-sorted order, with a nested file
    // created before its earlier-sorting flat sibling, so a pass can only mean the explicit
    // sort ran — not that the filesystem's own readdir order happened to agree with it.
    const p = mkdtempSync(join(tmpdir(), "atlas-sort-"));
    mkdirSync(join(p, "a"), { recursive: true });
    writeFileSync(join(p, "z.md"), "z");
    writeFileSync(join(p, "a", "z.md"), "az");
    writeFileSync(join(p, "a", "a.md"), "aa");
    writeFileSync(join(p, "a.md"), "a");
    expect(makeAtlasWriter({ atlasPath: p }).listNotes())
      .toEqual(["a.md", "a/a.md", "a/z.md", "z.md"]);
    rmSync(p, { recursive: true, force: true });
  });

  it("never lists anything inside .git or .locks", () => {
    mkdirSync(join(atlasPath, ".locks"), { recursive: true });
    writeFileSync(join(atlasPath, ".locks", "stray.md"), "x");
    expect(makeAtlasWriter({ atlasPath }).listNotes()).not.toContain(".locks/stray.md");
  });

  it("does not descend into a symlinked directory", () => {
    // MINOR 7: `statSync` follows links, so a symlinked directory used to be walked as if it
    // were a real one — listing files outside the store, which `readNote`/`writeNotes` then
    // correctly refuse, aborting whatever was iterating the list. `lstatSync` sees the link
    // itself, not what it points to, so the walk never enters it.
    const outside = mkdtempSync(join(tmpdir(), "atlas-outside-"));
    mkdirSync(join(outside, "sub"), { recursive: true });
    writeFileSync(join(outside, "sub", "external.md"), "x");
    symlinkSync(join(outside, "sub"), join(atlasPath, "linked"));
    expect(makeAtlasWriter({ atlasPath }).listNotes()).not.toContain("linked/external.md");
    rmSync(outside, { recursive: true, force: true });
  });

  it("reads a note by its Atlas-relative path", () => {
    expect(makeAtlasWriter({ atlasPath }).readNote("_projects/soma.md")).toContain("brand: soma");
  });

  it("refuses to read a note that is a symlink escaping the store", () => {
    // CRITICAL 1: the directory-escape guard realpaths `dirname(abs)` but never the target
    // itself, so a plain FILE symlink (not a symlinked directory) sailed straight through it.
    const outside = mkdtempSync(join(tmpdir(), "atlas-outside-"));
    const secretPath = join(outside, "secret.txt");
    writeFileSync(secretPath, "TOP SECRET");
    symlinkSync(secretPath, join(atlasPath, "leak.md"));
    expect(() => makeAtlasWriter({ atlasPath }).readNote("leak.md")).toThrow(/escape/i);
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses to write through a symlinked note, and never touches the file outside the store", async () => {
    const outside = mkdtempSync(join(tmpdir(), "atlas-outside-"));
    const secretPath = join(outside, "secret.txt");
    writeFileSync(secretPath, "TOP SECRET");
    symlinkSync(secretPath, join(atlasPath, "leak.md"));
    await expect(makeAtlasWriter({ atlasPath }).writeNotes([{ path: "leak.md", raw: "PWNED" }], "atlas: nope"))
      .rejects.toThrow(/escape/i);
    expect(readFileSync(secretPath, "utf8")).toBe("TOP SECRET");
    rmSync(outside, { recursive: true, force: true });
  });

  it("writes and commits, and reports what it did", async () => {
    const w = makeAtlasWriter({ atlasPath });
    const res = await w.writeNotes([{ path: "_projects/soma.md", raw: "---\ntype: venture\nbrand: soma\n---\n\nNEW\n" }], "atlas: test");
    expect(res.committed).toBe(true);
    expect(readFileSync(join(atlasPath, "_projects", "soma.md"), "utf8")).toContain("NEW");
    expect(execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: atlasPath, encoding: "utf8" }).trim())
      .toBe("atlas: test");
  });

  it("COMMITS NOTHING when the bytes are unchanged — no empty commits, ever", async () => {
    const w = makeAtlasWriter({ atlasPath });
    const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: atlasPath, encoding: "utf8" }).trim();
    const res = await w.writeNotes([{ path: "_projects/soma.md", raw: readFileSync(join(atlasPath, "_projects", "soma.md"), "utf8") }], "atlas: noop");
    expect(res.committed).toBe(false);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: atlasPath, encoding: "utf8" }).trim()).toBe(before);
  });

  it("commits even when the push fails, and says the push failed", async () => {
    // The box's bare remote can be briefly unavailable. Losing the COMMIT because of that
    // would mean re-deriving and re-proposing the same note next tick.
    const w = makeAtlasWriter({
      atlasPath,
      run: (cmd, args, cwd) => {
        if (args[0] === "push") throw new Error("remote unreachable");
        return execFileSync(cmd, args, { cwd, encoding: "utf8" });
      },
    });
    const res = await w.writeNotes([{ path: "_projects/soma.md", raw: "---\ntype: venture\n---\n\nNEW\n" }], "atlas: test");
    expect(res).toEqual({ committed: true, pushed: false });
  });

  it("refuses a path that escapes the store", async () => {
    await expect(makeAtlasWriter({ atlasPath }).writeNotes([{ path: "../evil.md", raw: "x" }], "atlas: nope"))
      .rejects.toThrow(/escape/i);
  });

  it("refuses an absolute path", async () => {
    // MINOR 6: `join(root, "/etc/evil.md")` lands INSIDE the root as a string (Node's `join`
    // doesn't treat a leading slash on the second argument as absolute), so it used to pass
    // the escape check, get written to `<root>/etc/evil.md`, and then fail at `git add --
    // /etc/evil.md` — because THAT string, the raw relPath, is what got handed to git, and
    // git reads a leading slash as an absolute pathspec outside the repo. The write landed,
    // the commit didn't: untracked garbage in the store. Rejected explicitly, before either.
    await expect(makeAtlasWriter({ atlasPath }).writeNotes([{ path: "/etc/evil.md", raw: "x" }], "atlas: nope"))
      .rejects.toThrow(/absolute/i);
  });

  it("validates every path in the batch before writing any of them", async () => {
    // IMPORTANT 2 (part one): a batch is validated whole, up front. Previously the bad path
    // in a mixed batch was only discovered when the loop reached it, by which point an
    // earlier, perfectly good file in the same batch had already been written to disk with
    // no commit to show for it.
    const before = readFileSync(join(atlasPath, "icp", "zero7.md"), "utf8");
    await expect(makeAtlasWriter({ atlasPath }).writeNotes(
      [{ path: "icp/zero7.md", raw: "CHANGED\n" }, { path: "../evil.md", raw: "x" }],
      "atlas: nope",
    )).rejects.toThrow(/escape/i);
    expect(readFileSync(join(atlasPath, "icp", "zero7.md"), "utf8")).toBe(before);
  });

  it("recovers an orphaned write — bytes already on disk from a run whose commit failed still get committed on retry", async () => {
    // IMPORTANT 2 (part two): the OTHER way a write can be orphaned — not a bad path
    // elsewhere in the batch, but `git commit` itself failing (a hook, a full disk, whatever)
    // AFTER the file was already written. A retry with the identical content used to compare
    // memory to disk, see the bytes already match, and conclude "nothing to do" — HEAD never
    // moved and the change was silently lost.
    const w1 = makeAtlasWriter({
      atlasPath,
      run: (cmd, args, cwd) => {
        if (args[0] === "commit") throw new Error("commit hook rejected");
        return execFileSync(cmd, args, { cwd, encoding: "utf8" });
      },
    });
    const raw = "---\ntype: venture\nbrand: soma\n---\n\nORPHANED\n";
    await expect(w1.writeNotes([{ path: "_projects/soma.md", raw }], "atlas: test")).rejects.toThrow();
    expect(readFileSync(join(atlasPath, "_projects", "soma.md"), "utf8")).toBe(raw); // written...
    expect(execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: atlasPath, encoding: "utf8" }).trim())
      .toBe("seed"); // ...but never committed

    const w2 = makeAtlasWriter({ atlasPath });
    const res = await w2.writeNotes([{ path: "_projects/soma.md", raw }], "atlas: test (retry)");
    expect(res.committed).toBe(true);
    expect(execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: atlasPath, encoding: "utf8" }).trim())
      .toBe("atlas: test (retry)");
  });

  it("commits only the given paths — an unrelated file staged by someone else is left alone", async () => {
    // IMPORTANT 3: `git add` was already path-scoped, but the `git commit` that followed it
    // was not, so anything ELSE staged in the shared clone — a human's in-progress edit, a
    // concurrent writer's half-finished batch — rode along into this service's commit under
    // this service's message.
    writeFileSync(join(atlasPath, "README.md"), "# Atlas\n\nSTAGED BY SOMEONE ELSE\n");
    execFileSync("git", ["add", "README.md"], { cwd: atlasPath });

    const w = makeAtlasWriter({ atlasPath });
    const raw = "---\ntype: venture\nbrand: soma\n---\n\nNEW\n";
    const res = await w.writeNotes([{ path: "_projects/soma.md", raw }], "atlas: test");
    expect(res.committed).toBe(true);

    const commitFiles = execFileSync("git", ["show", "--name-only", "--pretty=", "HEAD"], { cwd: atlasPath, encoding: "utf8" })
      .trim().split("\n").filter(Boolean);
    expect(commitFiles).toEqual(["_projects/soma.md"]);

    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: atlasPath, encoding: "utf8" }).trim();
    expect(staged).toBe("README.md");
  });

  it("does nothing at all for an empty batch, even when someone else has staged something", async () => {
    // Review round 2, new IMPORTANT: `git status --porcelain --` with NO pathspec after `--`
    // means "the whole tree", not "these zero paths". Every guard this round added assumes
    // the pathspec scopes to files THIS BATCH is responsible for — an empty batch broke that
    // assumption and reintroduced the IMPORTANT-3 hijack (plus a commit for zero changes,
    // the churn defect this whole plan exists to prevent) through the one door those fixes
    // didn't cover.
    writeFileSync(join(atlasPath, "README.md"), "# Edited by someone else\n");
    execFileSync("git", ["add", "README.md"], { cwd: atlasPath });
    const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: atlasPath, encoding: "utf8" }).trim();
    const res = await makeAtlasWriter({ atlasPath }).writeNotes([], "atlas: empty batch");
    expect(res).toEqual({ committed: false, pushed: false });
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: atlasPath, encoding: "utf8" }).trim()).toBe(before);
    // …and the other actor's staged change is still theirs, still uncommitted.
    expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: atlasPath, encoding: "utf8" }).trim())
      .toBe("README.md");
  });

  it("refuses to silently report {committed:false} when a written file is invisible to git", async () => {
    // MINOR (deferred from round 1, closed now): the Atlas has no .gitignore today, so this
    // isn't live yet, but "I wrote your bytes and then told you nothing happened" is the
    // wrong answer from a write boundary regardless. If we wrote a file and git then reports
    // NOTHING dirty for that exact path, that's a contradiction — not a no-op — and must be
    // loud, not silent.
    writeFileSync(join(atlasPath, ".gitignore"), "_inbox/\n");
    const w = makeAtlasWriter({ atlasPath });
    await expect(w.writeNotes([{ path: "_inbox/idea.md", raw: "# idea\n" }], "atlas: test"))
      .rejects.toThrow(/gitignore|no change|not track/i);
    // The write boundary doesn't pretend the write didn't happen just because it can't commit it.
    expect(readFileSync(join(atlasPath, "_inbox", "idea.md"), "utf8")).toBe("# idea\n");
  });

  it("commits a note whose path contains a space", async () => {
    // Review round 3, new IMPORTANT: the round-2 fix parsed default `git status --porcelain`
    // output with `line.slice(3)`, but git C-QUOTES paths it considers unusual in that
    // output — and a plain space is enough (`?? "note with space.md"`, quotes included). The
    // quoted string then never matched the unquoted entry in `touched`, so a genuinely new,
    // untracked file was wrongly classified "invisible to git" and the call threw the
    // gitignore-shaped error for a file that isn't ignored at all.
    const w = makeAtlasWriter({ atlasPath });
    const res = await w.writeNotes([{ path: "_projects/vol de nuit.md", raw: "---\ntype: venture\n---\n\nbody\n" }], "atlas: spaced path");
    expect(res.committed).toBe(true);
    expect(execFileSync("git", ["show", "--name-only", "--pretty=format:", "HEAD"], { cwd: atlasPath, encoding: "utf8" }))
      .toContain("_projects/vol de nuit.md");
  });

  it("commits a note whose path contains non-ASCII characters", async () => {
    // Same defect, different trigger: `core.quotePath` defaults to true, so git quotes
    // non-ASCII bytes in porcelain output too.
    const w = makeAtlasWriter({ atlasPath });
    const res = await w.writeNotes([{ path: "_projects/vøl-de-nuit.md", raw: "---\ntype: venture\n---\n\nbody\n" }], "atlas: non-ascii path");
    expect(res.committed).toBe(true);
  });
});
