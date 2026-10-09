/**
 * Filing an article against REAL repositories: a private one (where the inbox lives) and a shared
 * one, each with its own bare remote. The behaviour under test is the git invocations (what lands
 * in which commit, what reaches the remote, what happens to the inbox note), so a mock would
 * prove nothing. Compare `digest-file.test.ts`, the same idea for ordinary notes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VaultPushFailedError } from "@lares/agent-kit/vault-git";
import { renderClipNote, type ClipRecord } from "../lib/clipping/record.js";
import type { ArticleClassification } from "../lib/digest/classifier.js";
import { assertSharedWritesInArticles, makeArticleFiler, resolveSharedRoot } from "../lib/digest/article-file.js";

let tmp: string;
let privateRoot: string;
let privateBare: string;
let sharedRoot: string;
let sharedBare: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function makeRepo(name: string): { root: string; bare: string } {
  const bare = join(tmp, `${name}.git`);
  const root = join(tmp, name);
  execFileSync("git", ["init", "--bare", "-q", bare]);
  execFileSync("git", ["init", "-q", root]);
  git(root, "config", "user.email", "t@t.t");
  git(root, "config", "user.name", "t");
  git(root, "remote", "add", "origin", bare);
  writeFileSync(join(root, "README.md"), "seed\n");
  git(root, "add", "README.md");
  git(root, "commit", "-q", "-m", "seed");
  git(root, "push", "-q", "origin", "HEAD");
  return { root, bare };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "article-file-"));
  ({ root: privateRoot, bare: privateBare } = makeRepo("private"));
  ({ root: sharedRoot, bare: sharedBare } = makeRepo("shared"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const clip = (over: Partial<ClipRecord> = {}): ClipRecord => ({
  sourceId: "src1",
  sourceKind: "notion",
  sourceContainer: "ds1",
  sourceItemId: "0a1b2c3d-0000-4000-8000-000000000001",
  sourceRevision: "2026-10-01T10:00:00.000Z",
  url: "https://example.com/posts/pricing-pages",
  urlKey: "https://example.com/posts/pricing-pages",
  title: "Pricing pages that convert",
  note: "Check the section on anchoring.",
  tags: ["Pricing"],
  capturedAt: "2026-10-01T09:30:00.000Z",
  owner: "organisation",
  visibility: "shared",
  ...over,
});

const TEXT = "Pricing pages work best when the middle plan is the obvious choice, and clear plan names matter.";

/** Put an inbox note in the private repo, tracked (committed) or loose (like a clipper drop). */
function inbox(name: string, c: ClipRecord, tracked: boolean): { path: string; body: string } {
  const path = `_inbox/${name}.md`;
  const body = renderClipNote(c);
  mkdirSync(join(privateRoot, "_inbox"), { recursive: true });
  writeFileSync(join(privateRoot, path), body);
  if (tracked) {
    git(privateRoot, "add", "--", path);
    git(privateRoot, "commit", "-q", "-m", `seed ${name}`);
    git(privateRoot, "push", "-q", "origin", "HEAD");
  }
  return { path, body };
}

const classification: ArticleClassification = {
  summary: "Pricing pages convert when one plan is the default.",
  topics: ["conversion"],
  excerpts: [],
  links: [],
};

/** `null` means the shared area is not connected. */
function filer(shared: string | null = sharedRoot, articleArea?: "shared" | "private") {
  return makeArticleFiler({
    privateRoot,
    sharedRoot: () => shared ?? undefined,
    ...(articleArea ? { articleArea } : {}),
    now: () => new Date("2026-10-09T10:00:00Z"),
  });
}

function run(
  fileArticle: ReturnType<typeof filer>,
  item: { path: string; body: string },
  opts: { title?: string; url?: string; text?: string } = {},
) {
  let calls = 0;
  const promise = fileArticle({
    inboxPath: item.path,
    inboxBody: item.body,
    article: { url: opts.url ?? "https://example.com/posts/pricing-pages", title: opts.title ?? "How pricing pages convert", text: opts.text ?? TEXT },
    classify: async () => {
      calls += 1;
      return classification;
    },
    today: "2026-10-09",
  });
  return { promise, calls: () => calls };
}

const count = (root: string): number => Number(git(root, "rev-list", "--count", "HEAD").trim());
const filesOfHead = (root: string): string[] =>
  git(root, "show", "--name-status", "--format=", "HEAD").trim().split("\n").filter(Boolean).sort();

describe("a shared article", () => {
  it("lands as note and text in ONE shared commit, pushed, and the inbox note is retired in the private repo", async () => {
    const item = inbox("clip-a", clip(), true);
    const before = { shared: count(sharedRoot), priv: count(privateRoot) };

    const r = run(filer(), item);
    const out = await r.promise;

    expect(out).toMatchObject({ area: "shared", duplicate: false, fellBack: false, destPath: "articles/how-pricing-pages-convert.md" });
    expect(r.calls()).toBe(1);

    expect(count(sharedRoot)).toBe(before.shared + 1);
    expect(filesOfHead(sharedRoot)).toEqual([
      "A\tarticles/how-pricing-pages-convert.md",
      "A\tarticles/how-pricing-pages-convert.txt",
    ]);
    expect(git(sharedRoot, "log", "-1", "--format=%s").trim()).toBe("digest: file article how-pricing-pages-convert → articles");
    const onBare = git(sharedBare, "ls-tree", "-r", "--name-only", "HEAD");
    expect(onBare).toContain("articles/how-pricing-pages-convert.md");
    expect(onBare).toContain("articles/how-pricing-pages-convert.txt");

    const note = readFileSync(join(sharedRoot, "articles/how-pricing-pages-convert.md"), "utf8");
    expect(note).toContain("scope: org");
    expect(note).toContain("## Note\nCheck the section on anchoring.");
    expect(readFileSync(join(sharedRoot, "articles/how-pricing-pages-convert.txt"), "utf8")).toBe(TEXT);

    expect(existsSync(join(privateRoot, item.path))).toBe(false);
    expect(count(privateRoot)).toBe(before.priv + 1);
    expect(filesOfHead(privateRoot)).toEqual([`D\t${item.path}`]);
    expect(git(privateBare, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain(item.path);
    expect(existsSync(join(privateRoot, "articles"))).toBe(false);
  });

  it("an inbox note that was never committed is simply removed, with no empty commit", async () => {
    const item = inbox("clip-loose", clip(), false);
    const before = count(privateRoot);
    await run(filer(), item).promise;
    expect(existsSync(join(privateRoot, item.path))).toBe(false);
    expect(count(privateRoot)).toBe(before);
  });
});

describe("a private article", () => {
  it("is one private commit: the note, its text and the inbox removal together", async () => {
    const item = inbox("clip-p", clip({ owner: "fixture-member", visibility: "private" }), true);
    const before = count(privateRoot);

    const out = await run(filer(), item).promise;

    expect(out).toMatchObject({ area: "private", fellBack: false });
    expect(count(privateRoot)).toBe(before + 1);
    expect(filesOfHead(privateRoot)).toEqual([
      `D\t${item.path}`,
      "A\tarticles/how-pricing-pages-convert.md",
      "A\tarticles/how-pricing-pages-convert.txt",
    ].sort());
    expect(git(privateBare, "ls-tree", "-r", "--name-only", "HEAD")).toContain("articles/how-pricing-pages-convert.txt");
    const note = readFileSync(join(privateRoot, "articles/how-pricing-pages-convert.md"), "utf8");
    expect(note).toContain("scope: private");
    expect(note).toContain("owner: fixture-member");
    expect(existsSync(join(sharedRoot, "articles"))).toBe(false);
  });
});

/**
 * A link pasted in chat, as the `vault_write` tool leaves it in the private inbox: `source: agent`,
 * no visibility, no owner, the link in the body. `frontmatter` replaces the frontmatter lines.
 */
function chatLink(frontmatter = "title: Pricing pages\ntype: note\nsource: agent\nlares_origin: owner\ncreated:\ntags: []"): { path: string; body: string } {
  const path = "_inbox/chat-link.md";
  const body = `---\n${frontmatter}\n---\n\nhttps://example.com/posts/pricing-pages\n\nWorth reading.\n`;
  mkdirSync(join(privateRoot, "_inbox"), { recursive: true });
  writeFileSync(join(privateRoot, path), body);
  git(privateRoot, "add", "--", path);
  git(privateRoot, "commit", "-q", "-m", "seed chat link");
  return { path, body };
}

describe("shared writes are confined to articles/", () => {
  it("accepts a note and its text inside articles/", () => {
    expect(() => assertSharedWritesInArticles(["articles/a.md", "articles/a.txt"])).not.toThrow();
  });

  it("refuses anything outside articles/, however it is spelled", () => {
    for (const bad of ["README.md", "notes/a.md", "articles/../README.md", "/etc/passwd", "articles", "articles/", "_inbox/a.md", "articles/sub/a.md"]) {
      expect(() => assertSharedWritesInArticles([bad]), bad).toThrow(/articles/);
    }
  });

  it("a real shared filing touches nothing else in the shared repository", async () => {
    await run(filer(sharedRoot, "shared"), inbox("clip-a", clip(), true)).promise;
    const changed = git(sharedRoot, "diff", "--name-only", "HEAD~1", "HEAD").trim().split("\n").sort();
    expect(changed).toEqual(["articles/how-pricing-pages-convert.md", "articles/how-pricing-pages-convert.txt"]);
  });
});

describe("the article area setting", () => {
  it("defaults to shared when no setting is given", async () => {
    const out = await run(filer(sharedRoot), inbox("clip-a", clip(), true)).promise;
    expect(out).toMatchObject({ area: "shared", fellBack: false });
  });

  it("private files a shared source's link privately, with no fall-back to report and the shared repository untouched", async () => {
    const item = inbox("clip-a", clip(), true);
    const sharedBefore = count(sharedRoot);

    const out = await run(filer(sharedRoot, "private"), item).promise;

    expect(out).toMatchObject({ area: "private", fellBack: false, destPath: "articles/how-pricing-pages-convert.md" });
    expect(count(sharedRoot)).toBe(sharedBefore);
    expect(existsSync(join(sharedRoot, "articles"))).toBe(false);
    expect(readFileSync(join(privateRoot, out.destPath), "utf8")).toContain("scope: private");
    expect(existsSync(join(privateRoot, item.path))).toBe(false);
  });

  it("private needs no shared area at all: an unconnected shared area is not a fall-back", async () => {
    const out = await run(filer(null, "private"), inbox("clip-a", clip(), true)).promise;
    expect(out).toMatchObject({ area: "private", fellBack: false });
  });

  it("shared with a shared area that cannot be used is a fall-back to report", async () => {
    const out = await run(filer(null, "shared"), inbox("clip-a", clip(), true)).promise;
    expect(out).toMatchObject({ area: "private", fellBack: true });
  });

  it("a note with no source at all is private whatever the setting, and that is not a fall-back", async () => {
    const out = await run(filer(sharedRoot, "shared"), chatLink("title: Pricing pages")).promise;
    expect(out).toMatchObject({ area: "private", fellBack: false });
  });

  it("a link pasted in chat (source: agent) follows the setting: shared when shared", async () => {
    const out = await run(filer(sharedRoot, "shared"), chatLink()).promise;
    expect(out).toMatchObject({ area: "shared", fellBack: false });
  });

  it("a link pasted in chat follows the setting: private when private", async () => {
    const out = await run(filer(sharedRoot, "private"), chatLink()).promise;
    expect(out).toMatchObject({ area: "private", fellBack: false });
  });

  it("a private source never goes shared, whatever the setting, and that is not a fall-back", async () => {
    const item = inbox("clip-p", clip({ owner: "fixture-member", visibility: "private" }), true);
    const sharedBefore = count(sharedRoot);
    const out = await run(filer(sharedRoot, "shared"), item).promise;
    expect(out).toMatchObject({ area: "private", fellBack: false });
    expect(count(sharedRoot)).toBe(sharedBefore);
  });
});

describe("the same link twice", () => {
  it("makes no model call, writes nothing new, and retires the second inbox note", async () => {
    await run(filer(), inbox("clip-1", clip(), true)).promise;
    const sharedBefore = count(sharedRoot);

    const second = inbox("clip-2", clip({ url: "https://example.com/posts/pricing-pages?utm_source=newsletter" }), true);
    const r = run(filer(), second, { url: "https://example.com/posts/pricing-pages?utm_source=newsletter" });
    const out = await r.promise;

    expect(out.duplicate).toBe(true);
    expect(r.calls()).toBe(0);
    expect(count(sharedRoot)).toBe(sharedBefore);
    expect(existsSync(join(privateRoot, second.path))).toBe(false);
  });
});

describe("a link whose page title changed since it was filed", () => {
  it("is still recognised as filed: no model call, nothing written, the existing path comes back", async () => {
    const first = await run(filer(), inbox("clip-1", clip(), true)).promise;
    const sharedBefore = count(sharedRoot);

    const second = inbox("clip-2", clip(), true);
    const r = run(filer(), second, { title: "A completely different title this week" });
    const out = await r.promise;

    expect(out).toMatchObject({ duplicate: true, destPath: first.destPath, area: "shared" });
    expect(r.calls()).toBe(0);
    expect(count(sharedRoot)).toBe(sharedBefore);
    expect(existsSync(join(privateRoot, second.path))).toBe(false);
  });
});

describe("the model is told where the article is going", () => {
  it("passes the decided area to classify", async () => {
    const seen: string[] = [];
    const f = filer();
    await f({
      inboxPath: "_inbox/a.md",
      inboxBody: inbox("a", clip(), true).body,
      article: { url: "https://example.com/posts/pricing-pages", title: "T", text: TEXT },
      classify: async (ctx) => {
        seen.push(ctx.area);
        return classification;
      },
      today: "2026-10-09",
    });
    const privateItem = inbox("b", clip({ url: "https://example.com/other", owner: "fixture-member", visibility: "private" }), true);
    await f({
      inboxPath: privateItem.path,
      inboxBody: privateItem.body,
      article: { url: "https://example.com/other", title: "Other", text: TEXT },
      classify: async (ctx) => {
        seen.push(ctx.area);
        return classification;
      },
      today: "2026-10-09",
    });
    expect(seen).toEqual(["shared", "private"]);
  });
});

describe("a commit never sweeps in what somebody else staged", () => {
  it("shared: the article commit holds the note and its text only", async () => {
    writeFileSync(join(sharedRoot, "unrelated.txt"), "someone else's work\n");
    git(sharedRoot, "add", "unrelated.txt");
    await run(filer(), inbox("clip-a", clip(), true)).promise;
    expect(filesOfHead(sharedRoot)).toEqual([
      "A\tarticles/how-pricing-pages-convert.md",
      "A\tarticles/how-pricing-pages-convert.txt",
    ]);
    expect(git(sharedRoot, "diff", "--cached", "--name-only").trim()).toBe("unrelated.txt");
  });

  it("shared: retiring the inbox note commits that note only", async () => {
    const item = inbox("clip-a", clip(), true);
    writeFileSync(join(privateRoot, "unrelated.txt"), "someone else's work\n");
    git(privateRoot, "add", "unrelated.txt");
    await run(filer(), item).promise;
    expect(filesOfHead(privateRoot)).toEqual([`D\t${item.path}`]);
    expect(git(privateRoot, "diff", "--cached", "--name-only").trim()).toBe("unrelated.txt");
  });

  it("private: the article commit holds the note, its text and the inbox removal only", async () => {
    const item = inbox("clip-p", clip({ owner: "fixture-member", visibility: "private" }), true);
    writeFileSync(join(privateRoot, "unrelated.txt"), "someone else's work\n");
    git(privateRoot, "add", "unrelated.txt");
    await run(filer(), item).promise;
    expect(filesOfHead(privateRoot)).toEqual(
      [`D\t${item.path}`, "A\tarticles/how-pricing-pages-convert.md", "A\tarticles/how-pricing-pages-convert.txt"].sort(),
    );
    expect(git(privateRoot, "diff", "--cached", "--name-only").trim()).toBe("unrelated.txt");
  });
});

describe("a failed private commit", () => {
  it("puts a tracked inbox note back exactly as it was and leaves no article files behind", async () => {
    const item = inbox("clip-p", clip({ owner: "fixture-member", visibility: "private" }), true);
    const hook = join(privateRoot, ".git/hooks/pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    await expect(run(filer(), item).promise).rejects.toThrow();

    expect(readFileSync(join(privateRoot, item.path), "utf8")).toBe(item.body);
    expect(git(privateRoot, "status", "--porcelain")).toBe("");
    expect(git(privateRoot, "diff", "--cached", "--name-only")).toBe("");
    const left = existsSync(join(privateRoot, "articles")) ? readdirSync(join(privateRoot, "articles")) : [];
    expect(left).toEqual([]);
  });
});

describe("a failed private filing when the tracked inbox note has unsaved edits", () => {
  it("keeps the edited bytes, stages nothing and leaves no article files", async () => {
    const item = inbox("clip-p", clip({ owner: "fixture-member", visibility: "private" }), true);
    const edited = item.body + "\nA line the owner added by hand, not committed yet.\n";
    writeFileSync(join(privateRoot, item.path), edited);
    writeFileSync(join(privateRoot, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    await expect(run(filer(), item).promise).rejects.toThrow();

    expect(readFileSync(join(privateRoot, item.path), "utf8")).toBe(edited);
    expect(git(privateRoot, "diff", "--cached", "--name-only")).toBe("");
    const left = existsSync(join(privateRoot, "articles")) ? readdirSync(join(privateRoot, "articles")) : [];
    expect(left).toEqual([]);
  });
});

describe("a push that fails after the inbox note is already gone", () => {
  it("private: reports the failure beside the result, so the caller still learns where the article went", async () => {
    const item = inbox("clip-p", clip({ owner: "fixture-member", visibility: "private" }), true);
    git(privateRoot, "remote", "set-url", "origin", join(tmp, "missing.git"));

    const out = await run(filer(), item).promise;

    expect(out.pushFailure).toBeInstanceOf(VaultPushFailedError);
    expect(out).toMatchObject({ area: "private", duplicate: false });
    expect(existsSync(join(privateRoot, item.path))).toBe(false);
    expect(existsSync(join(privateRoot, out.destPath))).toBe(true);
  });

  it("shared: a failed push of the inbox retirement is reported beside the result too", async () => {
    const item = inbox("clip-a", clip(), true);
    git(privateRoot, "remote", "set-url", "origin", join(tmp, "missing.git"));

    const out = await run(filer(), item).promise;

    expect(out.pushFailure).toBeInstanceOf(VaultPushFailedError);
    expect(out.area).toBe("shared");
    expect(git(sharedBare, "ls-tree", "-r", "--name-only", "HEAD")).toContain(out.destPath);
    expect(existsSync(join(privateRoot, item.path))).toBe(false);
  });
});

describe("a different link with the same title", () => {
  it("gets its own name with six hex characters of the link's hash, and its own companion", async () => {
    await run(filer(), inbox("clip-1", clip(), true)).promise;
    const other = inbox("clip-2", clip({ url: "https://example.com/posts/another", urlKey: "https://example.com/posts/another" }), true);

    const out = await run(filer(), other, { url: "https://example.com/posts/another" }).promise;

    expect(out.duplicate).toBe(false);
    expect(out.destPath).toMatch(/^articles\/how-pricing-pages-convert-[0-9a-f]{6}\.md$/);
    const companion = out.destPath.replace(/\.md$/, ".txt");
    expect(existsSync(join(sharedRoot, companion))).toBe(true);
    expect(readFileSync(join(sharedRoot, out.destPath), "utf8")).toContain(`full_text: ${companion.replace("articles/", "")}`);
    expect(existsSync(join(sharedRoot, "articles/how-pricing-pages-convert.md"))).toBe(true);
  });
});

describe("when the shared area cannot be used", () => {
  it("files in the private area, says so, and never writes an owner on a private note", async () => {
    const item = inbox("clip-a", clip(), true);
    const out = await run(filer(null), item).promise;
    expect(out).toMatchObject({ area: "private", fellBack: true });
    const note = readFileSync(join(privateRoot, out.destPath), "utf8");
    expect(note).toContain("scope: private");
    expect(note).not.toMatch(/^owner:/m);
  });

  it("treats a folder that is not a repository as unusable", async () => {
    const plain = join(tmp, "plain");
    mkdirSync(plain);
    const out = await run(filer(plain), inbox("clip-a", clip(), true)).promise;
    expect(out).toMatchObject({ area: "private", fellBack: true });
    expect(existsSync(join(plain, "articles"))).toBe(false);
  });

  it("treats a missing folder as unusable", async () => {
    const out = await run(filer(join(tmp, "nope")), inbox("clip-a", clip(), true)).promise;
    expect(out).toMatchObject({ area: "private", fellBack: true });
  });
});

describe("when the push fails", () => {
  it("reports it, keeps the inbox note, and the next pass finishes without a second model call", async () => {
    const item = inbox("clip-a", clip(), true);
    git(sharedRoot, "remote", "set-url", "origin", join(tmp, "missing.git"));

    await expect(run(filer(), item).promise).rejects.toBeInstanceOf(VaultPushFailedError);
    expect(existsSync(join(privateRoot, item.path))).toBe(true);
    expect(existsSync(join(sharedRoot, "articles/how-pricing-pages-convert.md"))).toBe(true);

    git(sharedRoot, "remote", "set-url", "origin", sharedBare);
    const retry = run(filer(), item);
    const out = await retry.promise;

    expect(out.duplicate).toBe(true);
    expect(retry.calls()).toBe(0);
    expect(git(sharedBare, "ls-tree", "-r", "--name-only", "HEAD")).toContain("articles/how-pricing-pages-convert.txt");
    expect(existsSync(join(privateRoot, item.path))).toBe(false);
  });
});

/** A commit made in the shared clone by another writer and NOT pushed. */
function unpushedCommit(path: string, text = "x\n"): void {
  mkdirSync(join(sharedRoot, path, ".."), { recursive: true });
  writeFileSync(join(sharedRoot, path), text);
  git(sharedRoot, "add", "--", path);
  git(sharedRoot, "commit", "-q", "-m", `other writer: ${path}`);
}
const onRemote = (): string => git(sharedBare, "ls-tree", "-r", "--name-only", "HEAD");

describe("the standing approval covers articles/ only: nothing else is ever pushed", () => {
  it("only articles ahead of the remote: pushes them all, as before", async () => {
    unpushedCommit("articles/earlier.md");
    const out = await run(filer(), inbox("clip-a", clip(), true)).promise;

    expect(out.pushFailure).toBeUndefined();
    expect(onRemote()).toContain("articles/earlier.md");
    expect(onRemote()).toContain("articles/how-pricing-pages-convert.md");
  });

  it("an unrelated commit ahead of the remote: nothing is pushed, the article is still reported as filed, with a held-push report", async () => {
    unpushedCommit("notes/plan.md");
    const item = inbox("clip-a", clip(), true);

    const out = await run(filer(), item).promise;

    expect(out).toMatchObject({ area: "shared", duplicate: false, destPath: "articles/how-pricing-pages-convert.md" });
    expect(out.pushFailure).toBeInstanceOf(VaultPushFailedError);
    expect(out.pushFailure!.message).toMatch(/not pushed|held/i);
    expect(out.pushFailure!.message).toContain("notes/plan.md");
    // Nothing reached the remote, not even the article; the commits stay local for their own writer.
    expect(onRemote()).not.toContain("notes/plan.md");
    expect(onRemote()).not.toContain("articles/how-pricing-pages-convert");
    expect(existsSync(join(sharedRoot, "articles/how-pricing-pages-convert.md"))).toBe(true);
    expect(git(sharedRoot, "log", "--format=%s", "-3")).toContain("other writer: notes/plan.md");
    // The inbox note is retired, as for a push failure that happens after filing.
    expect(existsSync(join(privateRoot, item.path))).toBe(false);
  });

  it("a second pass over the same link makes no model call, loses nothing and does not loop: the inbox note goes, the report repeats", async () => {
    unpushedCommit("notes/plan.md");
    await run(filer(), inbox("clip-a", clip(), true)).promise;

    const again = inbox("clip-b", clip(), true);
    const r = run(filer(), again);
    const out = await r.promise;

    expect(out.duplicate).toBe(true);
    expect(r.calls()).toBe(0);
    expect(out.pushFailure).toBeInstanceOf(VaultPushFailedError);
    expect(existsSync(join(privateRoot, again.path))).toBe(false);
    expect(onRemote()).not.toContain("notes/plan.md");
  });

  it("once the other writer has published its commit, the next pass pushes the article too", async () => {
    unpushedCommit("notes/plan.md");
    await run(filer(), inbox("clip-a", clip(), true)).promise;
    git(sharedRoot, "push", "-q", "origin", "HEAD"); // the shared area's own writer publishes (articles included)

    const out = await run(filer(), inbox("clip-b", clip(), true)).promise;

    expect(out.duplicate).toBe(true);
    expect(out.pushFailure).toBeUndefined();
  });

  it("a duplicate whose article is already published says nothing about someone else's unpushed commit and pushes nothing", async () => {
    await run(filer(), inbox("clip-a", clip(), true)).promise;
    unpushedCommit("notes/plan.md");

    const out = await run(filer(), inbox("clip-b", clip(), true)).promise;

    expect(out.duplicate).toBe(true);
    expect(out.pushFailure).toBeUndefined();
    expect(onRemote()).not.toContain("notes/plan.md");
  });

  it("an unrelated commit that changes a file in a subfolder of articles/ is also not pushed", async () => {
    unpushedCommit("articles/sub/deep.md");
    const out = await run(filer(), inbox("clip-a", clip(), true)).promise;
    expect(out.pushFailure).toBeInstanceOf(VaultPushFailedError);
    expect(onRemote()).not.toContain("articles/sub/deep.md");
  });
});

describe("a link that cannot be filed", () => {
  it("refuses an inbox note whose link is not a web link, before any model call or write", async () => {
    const body = "---\nurl: ftp://example.com/file\ntitle: Not a page\n---\n\n";
    const bad = run(filer(), { path: "_inbox/clip-bad.md", body }, { url: "ftp://example.com/file" });
    await expect(bad.promise).rejects.toThrow(/web link/i);
    expect(bad.calls()).toBe(0);
  });
});

describe("resolveSharedRoot", () => {
  it("answers undefined when the shared area is not configured", () => {
    expect(resolveSharedRoot({})).toBeUndefined();
  });
  it("answers the configured path", () => {
    expect(resolveSharedRoot({ ATLAS_PATH: "/some/where" })).toBe("/some/where");
  });
});
