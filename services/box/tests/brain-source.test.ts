import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { makeBrainDeps } from "../lib/brain-source.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args]).toString().trim();
}

describe("commitNote push-to-bare", () => {
  let root: string;
  let bare: string;
  let work: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "brain-"));
    bare = join(root, "brain.git");
    work = join(root, "brain");
    execFileSync("git", ["init", "--bare", "-b", "main", bare]);
    execFileSync("git", ["clone", bare, work]);
    git(work, "config", "user.email", "saga@lares.test");
    git(work, "config", "user.name", "Saga");
    // an initial commit so `main` exists on both sides
    execFileSync("bash", ["-c", `echo seed > ${join(work, "seed.md")}`]);
    git(work, "add", "seed.md");
    git(work, "commit", "-q", "-m", "seed");
    git(work, "push", "-q", "origin", "main");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("pushes the note commit to the bare remote", async () => {
    const deps = makeBrainDeps(work);
    const { commit } = await deps.commitNote({
      path: "_inbox/hello.md",
      frontmatter: { title: "Hello", type: "note" },
      body: "world",
    });
    // The bare repo's main now contains the same commit.
    // Use --git-dir instead of -C to work with bare repos (safe.bareRepository=explicit).
    const bareHead = execFileSync("git", ["--git-dir", bare, "rev-parse", "--short", "main"])
      .toString()
      .trim();
    expect(bareHead).toBe(commit);
  });
});

function initGitVault(root: string) {
  execFileSync("git", ["init", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
}

describe("makeBrainDeps", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "brain-vault-"));
    initGitVault(vault);
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  // ── 1. list() ─────────────────────────────────────────────────────────────

  it("list() returns .md notes, excludes .git/ and .locks/ entries", async () => {
    mkdirSync(join(vault, "wiki"), { recursive: true });
    writeFileSync(join(vault, "wiki", "note-a.md"), "hello");
    writeFileSync(join(vault, "root.md"), "world");

    // Files that must be excluded
    mkdirSync(join(vault, ".git", "info"), { recursive: true });
    writeFileSync(join(vault, ".git", "info", "hidden.md"), "should not appear");
    mkdirSync(join(vault, ".locks"), { recursive: true });
    writeFileSync(join(vault, ".locks", "some.lock"), "lock");

    const brain = makeBrainDeps(vault);
    const files = await brain.list();

    expect(files).toContain("wiki/note-a.md");
    expect(files).toContain("root.md");
    expect(files.some((f) => f.startsWith(".git/"))).toBe(false);
    expect(files.some((f) => f.startsWith(".locks/"))).toBe(false);
  });

  // ── 2. read() ─────────────────────────────────────────────────────────────

  it("read() returns the note's content", async () => {
    writeFileSync(join(vault, "hello.md"), "# Hello\nworld");
    const brain = makeBrainDeps(vault);
    const content = await brain.read("hello.md");
    expect(content).toBe("# Hello\nworld");
  });

  it("read() throws on path traversal (../escape)", async () => {
    const brain = makeBrainDeps(vault);
    await expect(brain.read("../escape")).rejects.toThrow();
  });

  // ── 3. search() ───────────────────────────────────────────────────────────

  it("search() finds a note containing the query (case-insensitive)", async () => {
    mkdirSync(join(vault, "companies"), { recursive: true });
    writeFileSync(join(vault, "companies", "acme.md"), "# Acme Corp\nGreat company");
    writeFileSync(join(vault, "other.md"), "Nothing relevant here");

    const brain = makeBrainDeps(vault);
    const results = await brain.search("acme");

    expect(results).toContain("companies/acme.md");
    expect(results).not.toContain("other.md");
  });

  it("search() is case-insensitive", async () => {
    writeFileSync(join(vault, "note.md"), "This mentions ACME in uppercase");
    const brain = makeBrainDeps(vault);
    const results = await brain.search("acme");
    expect(results).toContain("note.md");
  });

  // ── 4. backlinks() ────────────────────────────────────────────────────────

  it("backlinks() returns notes containing [[basename]] wikilinks", async () => {
    mkdirSync(join(vault, "wiki", "companies"), { recursive: true });
    writeFileSync(join(vault, "wiki", "companies", "acme.md"), "# Acme");
    writeFileSync(join(vault, "linking.md"), "I work with [[acme]] often.");
    writeFileSync(join(vault, "unrelated.md"), "No links here.");

    const brain = makeBrainDeps(vault);
    const links = await brain.backlinks("wiki/companies/acme.md");

    expect(links).toContain("linking.md");
    expect(links).not.toContain("unrelated.md");
    // The target note itself should not appear (no self-link)
    expect(links).not.toContain("wiki/companies/acme.md");
  });

  // ── 5. commitNote() ───────────────────────────────────────────────────────

  it("commitNote() writes frontmatter+body, makes a git commit, returns a hash", async () => {
    const brain = makeBrainDeps(vault);
    const result = await brain.commitNote({
      path: "wiki/people/alice.md",
      frontmatter: { owner: "saga", tags: ["person", "vip"], priority: 1, extra: null },
      body: "Alice is a key contact.",
    });

    // File was written
    const content = readFileSync(join(vault, "wiki", "people", "alice.md"), "utf8");
    expect(content).toContain("owner: saga");
    expect(content).toContain("tags: [person, vip]");
    expect(content).toContain("priority: 1");
    expect(content).toContain("Alice is a key contact.");
    expect(content).toMatch(/^---\n/); // starts with frontmatter delimiter

    // Commit hash is returned and non-empty
    expect(typeof result.commit).toBe("string");
    expect(result.commit.length).toBeGreaterThan(0);

    // git log shows the commit
    const log = execFileSync("git", ["-C", vault, "log", "--oneline"]).toString();
    expect(log).toContain("wiki/people/alice.md");
  });

  it("moveNote() relocates a note as-is (git mv) and removes the source", async () => {
    mkdirSync(join(vault, "_inbox"), { recursive: true });
    writeFileSync(join(vault, "_inbox", "radar.md"), "---\ntitle: Radar\n---\nkeep me verbatim");
    execFileSync("git", ["-C", vault, "add", "-A"]);
    execFileSync("git", ["-C", vault, "commit", "-q", "-m", "seed"]);

    const brain = makeBrainDeps(vault);
    const { commit } = await brain.moveNote({
      sourcePath: "_inbox/radar.md", destPath: "writing-seeds/radar.md",
      message: "move Radar → writing-seeds",
    });

    expect(readFileSync(join(vault, "writing-seeds", "radar.md"), "utf8")).toBe("---\ntitle: Radar\n---\nkeep me verbatim");
    expect(() => readFileSync(join(vault, "_inbox", "radar.md"), "utf8")).toThrow();
    expect(execFileSync("git", ["-C", vault, "log", "-1", "--oneline"]).toString()).toContain("move Radar");
    expect(commit.length).toBeGreaterThan(0);
  });

  it("removeNote() deletes a note in one commit", async () => {
    mkdirSync(join(vault, "_inbox"), { recursive: true });
    writeFileSync(join(vault, "_inbox", "junk.md"), "transient");
    execFileSync("git", ["-C", vault, "add", "-A"]);
    execFileSync("git", ["-C", vault, "commit", "-q", "-m", "seed junk"]);

    const brain = makeBrainDeps(vault);
    const { commit } = await brain.removeNote({ path: "_inbox/junk.md", message: "drop junk" });
    expect(() => readFileSync(join(vault, "_inbox", "junk.md"), "utf8")).toThrow();
    expect(execFileSync("git", ["-C", vault, "log", "-1", "--oneline"]).toString()).toContain("drop junk");
    expect(commit.length).toBeGreaterThan(0);
  });

  // ── 6. writeRaw() ────────────────────────────────────────────────────────

  it("writeRaw() writes bytes to vault path (no git commit)", async () => {
    const brain = makeBrainDeps(vault);
    const bytes = Buffer.from("raw attachment bytes");
    await brain.writeRaw({ relPath: "_inbox/attachments/2026-06-18-doc.pdf", bytes });
    const content = readFileSync(join(vault, "_inbox/attachments/2026-06-18-doc.pdf"));
    expect(content).toEqual(bytes);
    // git log won't fail (vault may have no commits), just ensure the file is there
    expect(content.length).toBeGreaterThan(0);
  });

  it("writeRaw() rejects path traversal", async () => {
    const brain = makeBrainDeps(vault);
    await expect(brain.writeRaw({ relPath: "../escape.bin", bytes: Buffer.from("x") })).rejects.toThrow();
  });

  it("writeRaw() rejects a filename containing ../ segments", async () => {
    const brain = makeBrainDeps(vault);
    await expect(brain.writeRaw({ relPath: "_inbox/attachments/../../escape.bin", bytes: Buffer.from("x") })).rejects.toThrow();
  });

  it("fileNote() writes the destination, removes the source, in one commit", async () => {
    // seed an _inbox item to be filed
    mkdirSync(join(vault, "_inbox"), { recursive: true });
    writeFileSync(join(vault, "_inbox", "raw.md"), "original article text");
    execFileSync("git", ["-C", vault, "add", "-A"]);
    execFileSync("git", ["-C", vault, "commit", "-q", "-m", "seed inbox"]);

    const brain = makeBrainDeps(vault);
    const { commit } = await brain.fileNote({
      destPath: "inspiration/cool-article.md",
      sourcePath: "_inbox/raw.md",
      frontmatter: { title: "Cool Article", type: "inspiration", filed_by: "digest" },
      body: "## Summary\nshort\n\n## Source\noriginal article text",
      message: "digest: file Cool Article → inspiration",
    });

    // destination exists with content
    const dest = readFileSync(join(vault, "inspiration", "cool-article.md"), "utf8");
    expect(dest).toContain("title: Cool Article");
    expect(dest).toContain("filed_by: digest");
    expect(dest).toContain("## Source");

    // source is gone
    expect(() => readFileSync(join(vault, "_inbox", "raw.md"), "utf8")).toThrow();

    // single commit with our message, hash returned
    const log = execFileSync("git", ["-C", vault, "log", "-1", "--oneline"]).toString();
    expect(log).toContain("digest: file Cool Article");
    expect(commit.length).toBeGreaterThan(0);
  });

  it("fileNote() files an UNTRACKED source note (clipper/sync drops aren't git-tracked yet)", async () => {
    // A freshly-dropped _inbox note that was never `git add`ed — e.g. the Karakeep sync's
    // writeRaw, or a hand-dropped clip. fileNote must still file it (git rm would otherwise
    // fail with "pathspec did not match any files").
    mkdirSync(join(vault, "_inbox"), { recursive: true });
    writeFileSync(join(vault, "_inbox", "karakeep-x.md"), "---\nurl: https://x.io/a\n---\n\nnote");

    const brain = makeBrainDeps(vault);
    const { commit } = await brain.fileNote({
      destPath: "reference/x.md",
      sourcePath: "_inbox/karakeep-x.md",
      frontmatter: { url: "https://x.io/a", filed_by: "digest" },
      body: "## Source\nhttps://x.io/a",
      message: "digest: file untracked clip",
    });

    expect(readFileSync(join(vault, "reference", "x.md"), "utf8")).toContain("url: https://x.io/a");
    // untracked source removed from disk too
    expect(() => readFileSync(join(vault, "_inbox", "karakeep-x.md"), "utf8")).toThrow();
    expect(commit.length).toBeGreaterThan(0);
  });

  // ── 7. search() — tokenized (W4b) ──────────────────────────────────────────

  describe("search — tokenized (W4b)", () => {
    let vault: string;
    beforeEach(() => {
      vault = mkdtempSync(join(tmpdir(), "brain-search-"));
      mkdirSync(join(vault, "_projects"), { recursive: true });
      writeFileSync(join(vault, "_projects", "vol-de-nuit.md"), "# Vol de Nuit\n\n## Positioning / wedge\nNorwegian wine importer.");
      writeFileSync(join(vault, "_projects", "zero7.md"), "# Zero7\nPositioning: agent platform.");
      writeFileSync(join(vault, "notes.md"), "Nothing relevant here.");
    });
    afterEach(() => { rmSync(vault, { recursive: true, force: true }); });

    it("multi-word query matches when ALL tokens appear (path or content)", async () => {
      const deps = makeBrainDeps(vault);
      const hits = await deps.search("Vol de Nuit positioning");
      expect(hits).toContain("_projects/vol-de-nuit.md");
      expect(hits).not.toContain("notes.md");
    });

    it("falls back to ANY-token ranking when no file has all tokens", async () => {
      const deps = makeBrainDeps(vault);
      const hits = await deps.search("positioning quarterly-nonexistent-token");
      expect(hits[0]).toMatch(/vol-de-nuit|zero7/); // both mention positioning; ranked hits, capped
      expect(hits.length).toBeLessThanOrEqual(20);
    });

    it("single-word query behaves like before (substring, path or content)", async () => {
      const deps = makeBrainDeps(vault);
      expect(await deps.search("zero7")).toContain("_projects/zero7.md");
    });

    it("apostrophes and hyphens tokenize away (Vol de Nuit's positioning)", async () => {
      const deps = makeBrainDeps(vault);
      expect(await deps.search("Vol de Nuit's positioning")).toContain("_projects/vol-de-nuit.md");
    });

    it("empty and sub-2-char queries return []", async () => {
      const deps = makeBrainDeps(vault);
      expect(await deps.search("")).toEqual([]);
      expect(await deps.search("a !")).toEqual([]);
    });
  });
});
