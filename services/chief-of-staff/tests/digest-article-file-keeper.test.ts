/**
 * Filing an article through keeper (an install with no Vault folder). The fake vault below applies
 * the digest's REAL path and file rules (`scheduled-vault-policy`) the way keeper does, so a filer that
 * asks for something keeper would refuse fails here too. Every operation is logged in order, which is
 * what the crash-order tests read.
 */
import { describe, expect, it } from "vitest";

import {
  SCHEDULED_VAULT_MAX_BODY_BYTES, scheduledPathAllowed, scheduledPrefixAllowed, scheduledVaultRule, scheduledVerbatimRefusal,
} from "@lares/agent-kit/scheduled-vault-policy";
import { renderClipNote, type ClipRecord } from "../lib/clipping/record.js";
import { makeKeeperArticleFiler } from "../lib/digest/article-file-keeper.js";
import type { ArticleClassification } from "../lib/digest/classifier.js";
import { runDigest } from "../lib/digest/runner.js";
import { ScheduledVaultError, ScheduledVaultTooLargeError, type ScheduledVault } from "../lib/scheduled-vault.js";

type Log = string[];

function fakeVault(area: "private" | "shared", log: Log, opts: { granted?: boolean; failOn?: (op: string, path: string) => boolean } = {}) {
  const files = new Map<string, string>();
  const calls = { list: 0, read: 0 };
  const rule = scheduledVaultRule("digest", area)!;
  const gate = (op: string, path: string) => {
    if (opts.granted === false) throw new ScheduledVaultError(`the Vault refused the digest schedule (${op})`);
    if (opts.failOn?.(op, path)) throw new ScheduledVaultError(`the Vault could not be reached (${op})`);
  };
  const vault: ScheduledVault = {
    async list(prefix) {
      calls.list += 1;
      gate("list", prefix);
      if (!scheduledPrefixAllowed(rule, prefix)) throw new ScheduledVaultError("prefix refused");
      return [...files.keys()].filter((p) => p.startsWith(prefix) && p.endsWith(".md")).sort();
    },
    async read(path) {
      calls.read += 1;
      gate("read", path);
      if (!scheduledPathAllowed(rule, "read", path)) throw new ScheduledVaultError(`read refused: ${path}`);
      return files.get(path);
    },
    async exists(path) { return (await vault.read(path)) !== undefined; },
    async write() { throw new ScheduledVaultError("not used by the article filer"); },
    async writeRaw() { throw new ScheduledVaultError("not used by the article filer"); },
    async writeVerbatim(path, content) {
      if (Buffer.byteLength(content, "utf8") > SCHEDULED_VAULT_MAX_BODY_BYTES) throw new ScheduledVaultTooLargeError(`The note ${path}`);
      gate("write", path);
      const why = scheduledVerbatimRefusal(rule, path, content);
      if (why) throw new ScheduledVaultError(why);
      const unchanged = files.get(path) === content;
      files.set(path, content);
      log.push(`${area}:write:${path}${unchanged ? ":unchanged" : ""}`);
      return { commit: unchanged ? null : "c", unchanged };
    },
    async remove(path) {
      gate("remove", path);
      if (!scheduledPathAllowed(rule, "remove", path)) throw new ScheduledVaultError(`remove refused: ${path}`);
      log.push(`${area}:remove:${path}`);
      return files.delete(path);
    },
    async move() { throw new ScheduledVaultError("not used by the article filer"); },
  };
  return { vault, files, calls };
}

const clip = (over: Partial<ClipRecord> = {}): ClipRecord => ({
  sourceId: "src1", sourceKind: "notion", sourceContainer: "ds1", sourceItemId: "0a1b2c3d-0000-4000-8000-000000000001",
  sourceRevision: "2026-10-01T10:00:00.000Z", url: "https://example.com/posts/pricing-pages", urlKey: "https://example.com/posts/pricing-pages",
  title: "Pricing pages that convert", note: "Check the section on anchoring.", tags: ["Pricing"], capturedAt: "2026-10-01T09:30:00.000Z",
  owner: "organisation", visibility: "shared", ...over,
});
const TEXT = "Pricing pages work best when the middle plan is the obvious choice, and clear plan names matter.";
const classification: ArticleClassification = { summary: "Pricing pages convert when one plan is the default.", topics: ["conversion"], excerpts: [], links: [] };

function setup(over: { sharedGranted?: boolean | "none"; failPrivate?: (op: string, path: string) => boolean; failShared?: (op: string, path: string) => boolean;
  articleArea?: "shared" | "private"; mayWritePrivate?: boolean } = {}) {
  const log: Log = [];
  const priv = fakeVault("private", log, { failOn: over.failPrivate });
  const shared = fakeVault("shared", log, { granted: over.sharedGranted !== false, failOn: over.failShared });
  const fileArticle = makeKeeperArticleFiler({
    privateVault: priv.vault,
    sharedVault: over.sharedGranted === "none" ? undefined : shared.vault,
    articleArea: over.articleArea,
    mayWritePrivate: over.mayWritePrivate ?? true,
    now: () => new Date("2026-10-09T10:00:00Z"),
  });
  const addInbox = (name: string, c: ClipRecord) => {
    const path = `_inbox/${name}.md`, body = renderClipNote(c);
    priv.files.set(path, body);
    return { path, body };
  };
  let calls = 0;
  const run = (item: { path: string; body: string }, o: { title?: string; url?: string; text?: string } = {}) =>
    fileArticle({
      inboxPath: item.path, inboxBody: item.body,
      article: { url: o.url ?? "https://example.com/posts/pricing-pages", title: o.title ?? "How pricing pages convert", text: o.text ?? TEXT },
      classify: async () => { calls += 1; return classification; }, today: "2026-10-09",
    });
  return { log, priv, shared, addInbox, run, calls: () => calls };
}

const NOTE = "articles/how-pricing-pages-convert.md", TXT = "articles/how-pricing-pages-convert.txt";

describe("a private article through keeper", () => {
  it("writes the text, then the note, then removes the inbox note, and the note carries the origin keeper requires", async () => {
    const s = setup({ articleArea: "private" });
    const item = s.addInbox("clip-a", clip());
    const out = await s.run(item);
    expect(out).toMatchObject({ area: "private", destPath: NOTE, duplicate: false, fellBack: false });
    expect(s.log).toEqual([`private:write:${TXT}`, `private:write:${NOTE}`, `private:remove:${item.path}`]);
    expect(s.priv.files.get(TXT)).toBe(TEXT);
    expect(s.priv.files.get(NOTE)).toMatch(/lares_origin: third_party/);
    expect(s.priv.files.has(item.path)).toBe(false);
    expect(s.shared.files.size).toBe(0);
    expect(s.calls()).toBe(1);
  });

  it("a private source is never shared, whatever the setting, and that is not a fall-back", async () => {
    const s = setup();
    const out = await s.run(s.addInbox("clip-a", clip({ visibility: "private", owner: "alice" })));
    expect(out).toMatchObject({ area: "private", fellBack: false });
    expect(s.shared.files.size).toBe(0);
  });
});

describe("a shared article through keeper", () => {
  it("is written to the shared area only, and the inbox note is removed from the private one", async () => {
    const s = setup();
    const item = s.addInbox("clip-a", clip());
    const out = await s.run(item);
    expect(out).toMatchObject({ area: "shared", destPath: NOTE, fellBack: false });
    expect(s.log).toEqual([`shared:write:${TXT}`, `shared:write:${NOTE}`, `private:remove:${item.path}`]);
    expect(s.shared.files.get(NOTE)).toMatch(/scope: org/);
    expect(s.priv.files.size).toBe(0);
  });

  it("falls back to private, and says so, when the agent has no shared grant", async () => {
    const s = setup({ sharedGranted: "none" });
    const out = await s.run(s.addInbox("clip-a", clip()));
    expect(out).toMatchObject({ area: "private", fellBack: true });
    expect(s.priv.files.has(NOTE)).toBe(true);
  });

  it("falls back to private, and says so, when keeper refuses the shared area", async () => {
    const s = setup({ sharedGranted: false });
    const out = await s.run(s.addInbox("clip-a", clip()));
    expect(out).toMatchObject({ area: "private", fellBack: true });
    expect(s.shared.files.size).toBe(0);
    expect(s.priv.files.has(NOTE)).toBe(true);
    expect(s.calls()).toBe(1);
  });

  it("the private setting never touches the shared area and is not a fall-back", async () => {
    const s = setup({ articleArea: "private" });
    const out = await s.run(s.addInbox("clip-a", clip()));
    expect(out).toMatchObject({ area: "private", fellBack: false });
    expect(s.log.some((l) => l.startsWith("shared:"))).toBe(false);
  });
});

describe("a link that is already filed", () => {
  it("makes no model call, writes nothing, and removes the inbox note", async () => {
    const s = setup();
    await s.run(s.addInbox("clip-a", clip()));
    const second = s.addInbox("clip-b", clip({ sourceItemId: "0a1b2c3d-0000-4000-8000-000000000002" }));
    s.log.length = 0;
    const before = s.calls();
    const out = await s.run(second);
    expect(out).toMatchObject({ duplicate: true, area: "shared", destPath: NOTE });
    expect(s.calls()).toBe(before);
    expect(s.log).toEqual([`private:remove:${second.path}`]);
  });

  it("is recognised under the name it was filed with, even when the page title has changed", async () => {
    const s = setup();
    await s.run(s.addInbox("clip-a", clip()));
    const again = s.addInbox("clip-b", clip());
    const out = await s.run(again, { title: "A completely different title" });
    expect(out).toMatchObject({ duplicate: true, destPath: NOTE });
    expect([...s.shared.files.keys()].filter((p) => p.endsWith(".md"))).toEqual([NOTE]);
  });

  it("a different link with the same title gets six hex characters of its hash", async () => {
    const s = setup();
    await s.run(s.addInbox("clip-a", clip()));
    const other = s.addInbox("clip-b", clip({ url: "https://example.org/other", urlKey: "https://example.org/other" }));
    const out = await s.run(other, { url: "https://example.org/other" });
    expect(out.duplicate).toBe(false);
    expect(out.destPath).toMatch(/^articles\/how-pricing-pages-convert-[0-9a-f]{6}\.md$/);
    expect(s.shared.files.has(out.destPath.replace(/\.md$/, ".txt"))).toBe(true);
  });
});

describe("a crash between two keeper operations never files the same link twice", () => {
  it("before anything is written: nothing exists, the inbox note stays, the next pass files it", async () => {
    let fail = true;
    const s = setup({ failShared: (op) => fail && op === "write" });
    const item = s.addInbox("clip-a", clip());
    await expect(s.run(item)).rejects.toThrow(/could not be reached/);
    expect(s.shared.files.size).toBe(0);
    expect(s.priv.files.has(item.path)).toBe(true);
    fail = false;
    expect(await s.run(item)).toMatchObject({ duplicate: false, area: "shared" });
    expect(s.priv.files.has(item.path)).toBe(false);
  });

  it("after the text and before the note: only the text exists; the next pass writes the same text unchanged, then the note, then removes the inbox note", async () => {
    let fail = true;
    const s = setup({ failShared: (op, path) => fail && op === "write" && path.endsWith(".md") });
    const item = s.addInbox("clip-a", clip());
    await expect(s.run(item)).rejects.toThrow();
    expect(s.shared.files.has(TXT)).toBe(true);
    expect(s.shared.files.has(NOTE)).toBe(false);
    expect(s.priv.files.has(item.path)).toBe(true);
    fail = false;
    s.log.length = 0;
    await s.run(item);
    expect(s.log).toEqual([`shared:write:${TXT}:unchanged`, `shared:write:${NOTE}`, `private:remove:${item.path}`]);
    expect([...s.shared.files.keys()].filter((p) => p.endsWith(".md"))).toEqual([NOTE]);
  });

  it("after the note and before the removal: the next pass sees it is filed, makes no model call, and only removes the inbox note", async () => {
    let fail = true;
    const s = setup({ failPrivate: (op) => fail && op === "remove" });
    const item = s.addInbox("clip-a", clip());
    await expect(s.run(item)).rejects.toThrow();
    expect(s.shared.files.has(NOTE) && s.shared.files.has(TXT)).toBe(true);
    expect(s.priv.files.has(item.path)).toBe(true);
    fail = false;
    const before = s.calls();
    s.log.length = 0;
    expect(await s.run(item)).toMatchObject({ duplicate: true });
    expect(s.calls()).toBe(before);
    expect(s.log).toEqual([`private:remove:${item.path}`]);
  });

  it("the same holds in the private area", async () => {
    let fail = true;
    const s = setup({ articleArea: "private", failPrivate: (op, path) => fail && op === "write" && path.endsWith(".md") });
    const item = s.addInbox("clip-a", clip());
    await expect(s.run(item)).rejects.toThrow();
    fail = false;
    await s.run(item);
    expect([...s.priv.files.keys()].filter((p) => p.startsWith("articles/") && p.endsWith(".md"))).toEqual([NOTE]);
    expect(s.priv.files.has(item.path)).toBe(false);
  });
});

describe("the index of filed articles", () => {
  const seedNote = (s: ReturnType<typeof setup>, stem: string, url: string) =>
    s.shared.files.set(`articles/${stem}.md`, `---\ntype: article\nsources:\n  - resource: "${url}"\nlares_origin: third_party\n---\n\nx\n`);

  it("three links in one pass cost one listing and one read per existing note, per area", async () => {
    const s = setup();
    seedNote(s, "old-one", "https://example.com/old-1");
    seedNote(s, "old-two", "https://example.com/old-2");
    for (const n of [1, 2, 3]) {
      const url = `https://example.com/new-${n}`;
      await s.run(s.addInbox(`clip-${n}`, clip({ url, urlKey: url })), { url, title: `New page ${n}` });
    }
    expect(s.shared.calls).toEqual({ list: 1, read: 2 });
    expect(s.priv.calls).toEqual({ list: 0, read: 0 });
    expect([...s.shared.files.keys()].filter((p) => p.endsWith(".md"))).toHaveLength(5);
  });

  it("a link filed earlier in the same pass is a duplicate for a later link with the same URL", async () => {
    const s = setup();
    await s.run(s.addInbox("clip-a", clip()));
    const before = s.calls();
    const again = s.addInbox("clip-b", clip());
    expect(await s.run(again, { title: "Another title" })).toMatchObject({ duplicate: true, destPath: NOTE });
    expect(s.calls()).toBe(before);
    expect(s.shared.calls.list).toBe(1);
  });

  it("a failed build is not kept: the next link builds it again", async () => {
    let fail = true;
    const s = setup({ failShared: (op) => fail && op === "list" });
    const first = s.addInbox("clip-a", clip());
    expect(await s.run(first)).toMatchObject({ area: "private", fellBack: true });
    fail = false;
    const second = s.addInbox("clip-b", clip({ url: "https://example.org/x", urlKey: "https://example.org/x" }));
    expect(await s.run(second, { url: "https://example.org/x", title: "Other" })).toMatchObject({ area: "shared", fellBack: false });
  });
});

describe("limits and grants", () => {
  it("text over the keeper's limit is refused before anything is written: the item fails, the inbox note stays", async () => {
    const s = setup();
    const item = s.addInbox("clip-a", clip());
    await expect(s.run(item, { text: "x".repeat(SCHEDULED_VAULT_MAX_BODY_BYTES + 1) })).rejects.toThrow(/too large/);
    expect(s.log).toEqual([]);
    expect(s.priv.files.has(item.path)).toBe(true);
  });

  it("in a pass it is reported as an error, the inbox note is kept, and the other items still go through", async () => {
    const s = setup();
    const big = s.addInbox("clip-a", clip());
    const fine = s.addInbox("clip-b", clip({ url: "https://example.org/fine", urlKey: "https://example.org/fine", title: "Fine page" }));
    const summary = await runDigest({
      agent: "assistant", mode: "on-demand", capturedAt: "2026-10-09",
      listInbox: async () => [big, fine],
      alreadySkipped: async () => [], noteNames: async () => [], projects: async () => [],
      llm: async () => JSON.stringify(classification), fileNote: async () => ({ commit: "x" }),
      recordSkip: async () => {}, post: async () => ({}),
      enrich: async (i) => i.path === big.path
        ? { ...i, enriched: true, article: { url: "https://example.com/posts/pricing-pages", title: "Big", text: "x".repeat(SCHEDULED_VAULT_MAX_BODY_BYTES + 1) } }
        : { ...i, enriched: true, article: { url: "https://example.org/fine", title: "Fine page", text: TEXT } },
      fileArticle: (input) => s.run({ path: input.inboxPath, body: input.inboxBody }, { url: input.article.url, title: input.article.title, text: input.article.text }),
    });
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toMatchObject({ path: big.path });
    expect(summary.filed).toHaveLength(1);
    expect(s.priv.files.has(big.path)).toBe(true);
    expect(s.priv.files.has(fine.path)).toBe(false);
  });

  it("without a write grant on the private area nothing is filed and no model call is made", async () => {
    const s = setup({ mayWritePrivate: false });
    const item = s.addInbox("clip-a", clip());
    await expect(s.run(item)).rejects.toThrow(/no write grant on the private area/);
    expect(s.calls()).toBe(0);
    expect(s.log).toEqual([]);
  });

  it("a link that is not a web link is refused before any call", async () => {
    const s = setup();
    const item = { path: "_inbox/clip-a.md", body: "---\nurl: not a link\n---\n\nnote\n" };
    s.priv.files.set(item.path, item.body);
    await expect(s.run(item, { url: "not a link" })).rejects.toThrow(/not a web link/);
    expect(s.calls()).toBe(0);
  });
});
