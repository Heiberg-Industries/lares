/**
 * ORB-133 Tasks 4 + 5 — the digest queue's consumer half, the skip ledger, and the Karakeep sync.
 *
 * The SQL text is the contract with the untouched producer (`lib/digest-client.ts`, which
 * `agent/tools/digest_run.ts` already calls), so asserting on it is the point rather than a
 * shortcut: if these two disagree about a column name, an on-demand digest silently never runs.
 */
import { describe, it, expect } from "vitest";

import { claimDigestRequests, recordDigestSkip, listSkippedPaths } from "../lib/digest-store.js";
import { bookmarkToInboxNote, syncKarakeep, type KarakeepBookmark } from "../lib/karakeep.js";

function fakePool(rows: unknown[] = []) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const db = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      return { rows };
    },
  };
  return { db: db as never, calls };
}

describe("claimDigestRequests", () => {
  it("claims by DELETE … RETURNING — the claim IS the consumption", async () => {
    const { db, calls } = fakePool([{ id: "r1", door: "slack", thread_ref: "U1" }]);
    const out = await claimDigestRequests(db, "saga");
    expect(out).toEqual([{ id: "r1", door: "slack", threadRef: "U1" }]);
    expect(calls[0].sql).toMatch(/DELETE FROM digest_requests/i);
    expect(calls[0].sql).toMatch(/RETURNING id, door, thread_ref/i);
  });

  it("scopes to the agent and to pending rows", async () => {
    const { db, calls } = fakePool();
    await claimDigestRequests(db, "saga");
    expect(calls[0].sql).toMatch(/agent=\$1/);
    expect(calls[0].sql).toMatch(/status='pending'/);
    expect(calls[0].params).toEqual(["saga"]);
  });

  it("maps thread_ref onto threadRef — the column and the field differ", async () => {
    const { db } = fakePool([{ id: "r2", door: "telegram", thread_ref: "716" }]);
    expect((await claimDigestRequests(db, "saga"))[0].threadRef).toBe("716");
  });

  it("returns [] when nothing is pending", async () => {
    const { db } = fakePool([]);
    expect(await claimDigestRequests(db, "saga")).toEqual([]);
  });
});

describe("the skip ledger — why the digest does not re-ask about the same note forever", () => {
  it("upserts on (agent, path) and refreshes asked_at", async () => {
    const { db, calls } = fakePool();
    await recordDigestSkip(db, { agent: "saga", path: "_inbox/x.md", reason: "unsure" });
    expect(calls[0].sql).toMatch(/INSERT INTO digest_skips/i);
    expect(calls[0].sql).toMatch(/ON CONFLICT \(agent, path\) DO UPDATE/i);
    expect(calls[0].sql).toMatch(/asked_at=now\(\)/);
    expect(calls[0].params).toEqual(["saga", "_inbox/x.md", "unsure"]);
  });

  it("lists the already-asked paths for the next pass to skip", async () => {
    const { db, calls } = fakePool([{ path: "_inbox/a.md" }, { path: "_inbox/b.md" }]);
    expect(await listSkippedPaths(db, "saga")).toEqual(["_inbox/a.md", "_inbox/b.md"]);
    expect(calls[0].params).toEqual(["saga"]);
  });
});

const bookmark = (over: Partial<KarakeepBookmark> = {}): KarakeepBookmark => ({
  id: "abc123",
  createdAt: "2026-08-21T09:00:00.000Z",
  title: "A Saved Thing",
  note: null,
  content: { type: "link", url: "https://example.com/x" },
  ...over,
});

describe("bookmarkToInboxNote", () => {
  it("writes a metadata-only note into _inbox, keyed by the Karakeep id", () => {
    const note = bookmarkToInboxNote(bookmark())!;
    expect(note.relPath).toBe("_inbox/karakeep-abc123.md");
    expect(note.body).toContain("url: https://example.com/x");
    expect(note.body).toContain("source: karakeep");
    expect(note.body).toContain("karakeep_id: abc123");
  });

  // The frontmatter `url:` is exactly what makeEnrich prefers over a body scan — these two
  // modules meet here, and this is the join.
  it("puts the url in frontmatter, which is what the enricher reads", () => {
    expect(bookmarkToInboxNote(bookmark())!.body.startsWith("---\nurl: ")).toBe(true);
  });

  it("ignores a non-link bookmark", () => {
    expect(bookmarkToInboxNote(bookmark({ content: { type: "text" } }))).toBeNull();
  });

  it("ignores a link with no url", () => {
    expect(bookmarkToInboxNote(bookmark({ content: { type: "link" } }))).toBeNull();
  });

  it("falls back to the url as title when nothing better exists", () => {
    const note = bookmarkToInboxNote(bookmark({ title: null, content: { type: "link", url: "https://u.test" } }))!;
    expect(note.body).toContain("title: https://u.test");
  });
});

describe("syncKarakeep", () => {
  function harness(pages: { bookmarks: KarakeepBookmark[]; nextCursor: string | null }[], seenIds: string[] = []) {
    const seen = new Set(seenIds);
    const written: string[] = [];
    let page = 0;
    return {
      written,
      seen,
      deps: {
        client: { listBookmarks: async () => pages[Math.min(page++, pages.length - 1)] },
        seen: {
          isSeen: async (id: string) => seen.has(id),
          markSeen: async (id: string) => { seen.add(id); },
        },
        writeNote: async (o: { relPath: string }) => { written.push(o.relPath); },
        log: () => {},
      },
    };
  }

  it("writes only previously-unseen bookmarks, and marks them", async () => {
    const h = harness([{ bookmarks: [bookmark({ id: "old" }), bookmark({ id: "new" })], nextCursor: null }], ["old"]);
    const n = await syncKarakeep(h.deps as never);
    expect(n).toBe(1);
    expect(h.written).toEqual(["_inbox/karakeep-new.md"]);
    expect(h.seen.has("new")).toBe(true);
  });

  it("writes nothing when everything is already seen", async () => {
    const h = harness([{ bookmarks: [bookmark({ id: "old" })], nextCursor: null }], ["old"]);
    expect(await syncKarakeep(h.deps as never)).toBe(0);
    expect(h.written).toEqual([]);
  });

  it("skips non-link bookmarks without marking them written", async () => {
    const h = harness([{ bookmarks: [bookmark({ id: "txt", content: { type: "text" } })], nextCursor: null }]);
    expect(await syncKarakeep(h.deps as never)).toBe(0);
    expect(h.written).toEqual([]);
  });

  it("respects maxPages so a broken cursor cannot loop forever", async () => {
    // Every page reports another cursor and a fresh bookmark — without the cap this never ends.
    let i = 0;
    const deps = {
      client: { listBookmarks: async () => ({ bookmarks: [bookmark({ id: `b${i++}` })], nextCursor: "more" }) },
      seen: { isSeen: async () => false, markSeen: async () => {} },
      writeNote: async () => {},
      log: () => {},
    };
    const n = await syncKarakeep(deps as never, { maxPages: 3 });
    expect(n).toBe(3);
  });
});
