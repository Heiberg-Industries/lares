/**
 * LAR-113 child (a) — the clipping sync and ledger against a REAL Postgres (testcontainers) and
 * the REAL official SDK client over a fake Notion (tests/helpers/fake-notion.ts).
 *
 * `box/sql/079_repairs.sql` and `091_clipping.sql` are applied verbatim from disk, so the
 * migration itself is exercised before any box sees it. The fake Notion is a FIXTURE; the live
 * probe (tests/live/notion-clipping.live.mts) is what proves the shapes.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Pool } from "pg";

import { quietPool } from "./helpers/quiet-pool.js";
import { fakeNotion, memInbox, mkPage, pageId } from "./helpers/fake-notion.js";
import { clippingPass } from "../lib/clipping/step.js";
import { clipInboxPath } from "../lib/clipping/record.js";
import { runClippingSync } from "../lib/clipping/sync.js";
import { loadNotionSources, recordKarakeepImport } from "../lib/clipping/store.js";
import { parseFrontmatter } from "../lib/digest/extract.js";

const here = dirname(fileURLToPath(import.meta.url));
const sql = (name: string) => readFileSync(join(here, "..", "..", "box", "sql", name), "utf8");

let container: StartedPostgreSqlContainer;
let db: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  db = quietPool(container.getConnectionUri());
  await db.query(sql("079_repairs.sql"));
  await db.query(sql("091_clipping.sql"));
}, 180_000);

afterAll(async () => {
  await db?.end();
  await container?.stop();
});

let sourceId: string;
let fake: ReturnType<typeof fakeNotion>;
let inbox: ReturnType<typeof memInbox>;

async function addSource(o: { owner?: string; visibility?: string } = {}): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO clipping_sources (kind, data_source_id, url_property_id, note_property_id, tags_property_id, owner, visibility, import_since)
     VALUES ('notion', 'ds-1', 'u1', 'n1', 't1', $1, $2, '2000-01-01T00:00:00Z') RETURNING id`,
    [o.owner ?? "organisation", o.visibility ?? "shared"],
  );
  return rows[0].id as string;
}

beforeEach(async () => {
  await db.query(`TRUNCATE clipping_items, clipping_sources, repairs CASCADE`);
  sourceId = await addSource();
  fake = fakeNotion();
  inbox = memInbox();
});

function passWith(token: () => import("../lib/clipping/notion-reader.js").KeyState) {
  return clippingPass({ db, inbox, token, makeClient: async () => fake.client() });
}

function pass(o: { pageSize?: number; maxPages?: number; maxTrashChecks?: number } = {}) {
  return clippingPass({ db, inbox, token: () => ({ kind: "key", token: "t" }), makeClient: async () => fake.client(), ...o });
}

const stateRow = async () =>
  (await db.query(`SELECT * FROM clipping_sources WHERE id = $1`, [sourceId])).rows[0];
const itemState = async (n: number) =>
  (await db.query(`SELECT state, skip_reason FROM clipping_items WHERE source_item_id = $1 AND source_id = $2`, [pageId(n), sourceId])).rows[0];

describe("import and idempotent re-import", () => {
  it("a new row with a link becomes exactly one inbox note with the neutral frontmatter", async () => {
    fake.setPages([mkPage(1, { url: "https://Example.com/a/?utm_source=x", title: "Hello", note: "why" })]);
    const r = await pass();
    expect(r).toMatchObject({ outcome: "ok", imported: 1, notices: [] });
    const path = clipInboxPath(sourceId, pageId(1));
    expect([...inbox.files.keys()]).toEqual([path]);
    const fm = parseFrontmatter(inbox.files.get(path)!);
    expect(fm).toMatchObject({
      url: "https://Example.com/a/?utm_source=x", title: "Hello", source: "notion",
      owner: "organisation", visibility: "shared", lares_origin: "synced", notion_page: pageId(1),
    });
    const s = await stateRow();
    expect(s.outcome).toBe("ok");
    expect(s.imported_total).toBe(1);
    expect(s.last_success_at).not.toBeNull();
  });

  it("a second pass with nothing new writes nothing and reports ok with 0 imported", async () => {
    fake.setPages([mkPage(1), mkPage(2)]);
    await pass();
    const writesAfterFirst = inbox.writes.length;
    const r = await pass();
    expect(r).toMatchObject({ outcome: "ok", imported: 0 });
    expect(inbox.writes.length).toBe(writesAfterFirst);
    expect(inbox.files.size).toBe(2);
    expect((await stateRow()).imported_total).toBe(2);
  });

  it("every request pins the API version", async () => {
    fake.setPages([mkPage(1)]);
    await pass();
    expect(fake.world.requests.length).toBeGreaterThan(0);
    expect(new Set(fake.world.requests.map((q) => q.version))).toEqual(new Set(["2026-03-11"]));
  });

  it("a crash between the file write and the ledger row rewrites the same file, never a second", async () => {
    fake.setPages([mkPage(1)]);
    // The note was written by a pass that died before its ledger row.
    inbox.files.set(clipInboxPath(sourceId, pageId(1)), "stale");
    const r = await pass();
    expect(r.imported).toBe(1);
    expect(inbox.files.size).toBe(1);
    expect(inbox.files.get(clipInboxPath(sourceId, pageId(1)))).toContain("url: https://example.com/p/1");
    expect((await db.query(`SELECT count(*)::int AS n FROM clipping_items`)).rows[0].n).toBe(1);
  });

  it("a ledger write that fails leaves the pass failed and the next pass finishes cleanly", async () => {
    fake.setPages([mkPage(1)]);
    let failOnce = true;
    const flaky = {
      query: (text: string, params?: unknown[]) => {
        if (failOnce && /INSERT INTO clipping_items/.test(text)) { failOnce = false; return Promise.reject(Object.assign(new Error("db down"), { code: "08006" })); }
        return db.query(text, params);
      },
    };
    const first = await clippingPass({ db: flaky as never, inbox, token: () => ({ kind: "key", token: "t" }), makeClient: async () => fake.client() });
    expect(first.outcome).toBe("local-error");
    expect(first.notices).toHaveLength(1);
    const second = await pass();
    expect(second).toMatchObject({ outcome: "ok", imported: 1 });
    expect(inbox.files.size).toBe(1);
  });
});

describe("the first pass does not import the backlog", () => {
  it("3 old rows and 2 new rows: only the 2 rows edited since import_since are imported", async () => {
    await db.query(`UPDATE clipping_sources SET import_since = '2026-10-05T00:00:00Z' WHERE id = $1`, [sourceId]);
    fake.setPages([
      mkPage(1, { edited: "2026-09-01T10:00:00.000Z" }),
      mkPage(2, { edited: "2026-09-10T10:00:00.000Z" }),
      mkPage(3, { edited: "2026-10-04T23:59:00.000Z" }),
      mkPage(4, { edited: "2026-10-06T10:00:00.000Z" }),
      mkPage(5, { edited: "2026-10-07T10:00:00.000Z" }),
    ]);
    const r = await pass();
    expect(r.imported).toBe(2);
    expect([...inbox.files.keys()].sort()).toEqual([
      clipInboxPath(sourceId, pageId(4)), clipInboxPath(sourceId, pageId(5)),
    ].sort());
    expect((await db.query(`SELECT count(*)::int AS n FROM clipping_items`)).rows[0].n).toBe(2);
  });

  it("import_since is required, with no default", async () => {
    await expect(db.query(
      `INSERT INTO clipping_sources (kind, data_source_id, url_property_id, owner, visibility) VALUES ('notion', 'x', 'u', 'organisation', 'shared')`,
    )).rejects.toThrow(/import_since/);
  });

  it("owner and visibility have no implicit defaults", async () => {
    await expect(db.query(
      `INSERT INTO clipping_sources (kind, data_source_id, url_property_id, import_since) VALUES ('notion', 'x', 'u', now())`,
    )).rejects.toThrow(/null value/);
  });
});

describe("pagination over passes", () => {
  it("more rows than one pass reads are imported over passes without loss or duplicates", async () => {
    // Hours apart, so the 10-minute re-read behind the watermark never overlaps a neighbour.
    fake.setPages(Array.from({ length: 7 }, (_, i) => mkPage(i + 1, { edited: `2026-10-01T${String(10 + i)}:00:00.000Z` })));
    const first = await pass({ pageSize: 3, maxPages: 2 });
    expect(first.imported).toBe(6);
    const mid = await stateRow();
    expect(mid.watermark_capped).toBe(true);
    const second = await pass({ pageSize: 3, maxPages: 2 });
    expect(second.imported).toBe(1);
    expect(inbox.files.size).toBe(7);
    const third = await pass({ pageSize: 3, maxPages: 2 });
    expect(third.imported).toBe(0);
    expect((await stateRow()).watermark_capped).toBe(false);
    expect((await db.query(`SELECT count(*)::int AS n FROM clipping_items`)).rows[0].n).toBe(7);
  });

  it("a capped pass that cannot move forward fails visibly instead of looping", async () => {
    const same = "2026-10-01T10:00:00.000Z";
    fake.setPages([1, 2, 3, 4].map((n) => mkPage(n, { edited: same })));
    await pass({ pageSize: 2, maxPages: 1 });
    const stuck = await pass({ pageSize: 2, maxPages: 1 });
    expect(stuck.outcome).toBe("incomplete");
    expect(stuck.notices).toHaveLength(1);
  });

  it("the watermark moves only when the whole pass succeeded", async () => {
    fake.setPages([mkPage(1, { edited: "2026-10-01T10:05:00.000Z" })]);
    await pass();
    const before = (await stateRow()).watermark as Date;
    expect(before.toISOString()).toBe("2026-10-01T10:05:00.000Z");
    fake.put(mkPage(2, { edited: "2026-10-01T10:30:00.000Z" }));
    fake.world.faults.push({ match: /query$/, status: 500 });
    const failed = await pass();
    expect(failed.outcome).toBe("unavailable");
    expect(((await stateRow()).watermark as Date).toISOString()).toBe(before.toISOString());
    expect(inbox.files.size).toBe(1);
    fake.world.faults.length = 0;
    expect((await pass()).imported).toBe(1);
    expect(((await stateRow()).watermark as Date).toISOString()).toBe("2026-10-01T10:30:00.000Z");
  });
});

describe("edits", () => {
  it("an edit to an unfiled clip rewrites the same file", async () => {
    fake.setPages([mkPage(1, { title: "Old", edited: "2026-10-01T10:01:00.000Z" })]);
    await pass();
    const path = clipInboxPath(sourceId, pageId(1));
    fake.put(mkPage(1, { title: "New title", edited: "2026-10-01T10:20:00.000Z" }));
    await pass();
    expect([...inbox.files.keys()]).toEqual([path]);
    expect(inbox.files.get(path)).toContain("title: New title");
    expect((await stateRow()).last_counts).toMatchObject({ updated: 1, imported: 0 });
  });

  it("an edit after filing changes nothing in the vault and is counted", async () => {
    fake.setPages([mkPage(1, { title: "Old", edited: "2026-10-01T10:01:00.000Z" })]);
    await pass();
    inbox.filed(clipInboxPath(sourceId, pageId(1))); // the digest filed it
    const writes = inbox.writes.length;
    fake.put(mkPage(1, { title: "Edited later", edited: "2026-10-01T10:20:00.000Z" }));
    const r = await pass();
    expect(r.outcome).toBe("ok");
    expect(inbox.writes.length).toBe(writes);
    expect(inbox.files.size).toBe(0);
    expect((await stateRow()).last_counts).toMatchObject({ editedAfterFiling: 1, updated: 0 });
    expect((await itemState(1)).state).toBe("filed-unknown");
  });
});

describe("trash", () => {
  it("a trashed unfiled clip's inbox note is removed", async () => {
    fake.setPages([mkPage(1)]);
    await pass();
    fake.world.pages.get(pageId(1))!.in_trash = true;
    const r = await pass();
    expect(r.outcome).toBe("ok");
    expect(inbox.files.size).toBe(0);
    expect((await itemState(1)).state).toBe("trashed");
    expect((await stateRow()).last_counts).toMatchObject({ trashed: 1 });
  });

  it("a page deleted outright (404) is treated the same", async () => {
    fake.setPages([mkPage(1)]);
    await pass();
    fake.world.pages.delete(pageId(1));
    await pass();
    expect(inbox.files.size).toBe(0);
    expect((await itemState(1)).state).toBe("trashed");
  });

  it("a trashed filed clip is untouched", async () => {
    fake.setPages([mkPage(1)]);
    await pass();
    inbox.filed(clipInboxPath(sourceId, pageId(1)));
    fake.world.pages.get(pageId(1))!.in_trash = true;
    const removes = inbox.files.size;
    const r = await pass();
    expect(r.outcome).toBe("ok");
    expect(inbox.files.size).toBe(removes);
    expect((await itemState(1)).state).toBe("filed-unknown");
    expect((await stateRow()).last_counts).toMatchObject({ trashed: 0 });
  });

  it("a trashed page that the query still returns is handled by its in_trash flag", async () => {
    fake.world.queryIncludesTrashed = true;
    fake.setPages([mkPage(1)]);
    await pass();
    fake.put(mkPage(1, { trash: true, edited: "2026-10-01T10:40:00.000Z" }));
    await pass();
    expect(inbox.files.size).toBe(0);
    expect((await itemState(1)).state).toBe("trashed");
    // and it does not come back on the next pass
    await pass();
    expect(inbox.files.size).toBe(0);
  });

  it("restored in Notion, it is imported again under the same key", async () => {
    fake.setPages([mkPage(1, { edited: "2026-10-01T10:01:00.000Z" })]);
    await pass();
    fake.world.pages.get(pageId(1))!.in_trash = true;
    await pass();
    fake.put(mkPage(1, { edited: "2026-10-01T11:00:00.000Z" }));
    const r = await pass();
    expect(r.imported).toBe(1);
    expect([...inbox.files.keys()]).toEqual([clipInboxPath(sourceId, pageId(1))]);
    expect((await itemState(1)).state).toBe("imported");
  });

  it("at most the trash-check budget of pages are looked up per pass", async () => {
    fake.setPages([mkPage(1), mkPage(2), mkPage(3)]);
    await pass({ maxTrashChecks: 1 });
    const before = fake.world.requests.filter((q) => /GET \/v1\/pages\//.test(q.key)).length;
    await pass({ maxTrashChecks: 1 });
    await pass({ maxTrashChecks: 1 });
    await pass({ maxTrashChecks: 1 });
    const looked = fake.world.requests.filter((q) => /GET \/v1\/pages\//.test(q.key)).length - before;
    expect(looked).toBe(3); // one per pass, rotating through the least recently checked
  });
});

describe("rows without a link, and duplicates", () => {
  it("an empty URL and a plain title is skipped, counted once, and not imported as junk", async () => {
    fake.setPages([mkPage(1, { url: null, title: "just a thought" }), mkPage(2)]);
    const first = await pass();
    expect(first.imported).toBe(1);
    expect((await stateRow()).last_counts).toMatchObject({ noLink: 1, skipped: 1 });
    expect((await itemState(1))).toMatchObject({ state: "skipped", skip_reason: "no-link" });
    await pass();
    expect((await stateRow()).last_counts).toMatchObject({ noLink: 0 });
    expect(inbox.files.size).toBe(1);
  });

  it("a skipped row that later gets a link is imported", async () => {
    fake.setPages([mkPage(1, { url: null, title: "later", edited: "2026-10-01T10:01:00.000Z" })]);
    await pass();
    fake.put(mkPage(1, { url: "https://example.com/now", edited: "2026-10-01T10:30:00.000Z" }));
    const r = await pass();
    expect(r.imported).toBe(1);
    expect((await itemState(1)).state).toBe("imported");
  });

  it("the same link saved twice makes one note", async () => {
    fake.setPages([mkPage(1, { url: "https://example.com/same" }), mkPage(2, { url: "https://EXAMPLE.com/same/?utm_source=a" })]);
    const r = await pass();
    expect(r.imported).toBe(1);
    expect(inbox.files.size).toBe(1);
    expect((await stateRow()).last_counts).toMatchObject({ duplicates: 1 });
    expect((await itemState(2))).toMatchObject({ state: "skipped", skip_reason: "duplicate" });
  });

  it("a Karakeep import of the same link counts, so it is imported once", async () => {
    await recordKarakeepImport(db, { bookmarkId: "kk1", urlKey: "https://example.com/p/1", inboxPath: "_inbox/karakeep-kk1.md" });
    fake.setPages([mkPage(1)]);
    const r = await pass();
    expect(r.imported).toBe(0);
    expect(inbox.files.size).toBe(0);
    expect((await stateRow()).last_counts).toMatchObject({ duplicates: 1 });
    // and the Karakeep ledger row is never read as a source to import from
    expect((await loadNotionSources(db)).map((s) => s.id)).toEqual([sourceId]);
  });

  it("the same link in a DIFFERENT inbox is not a duplicate", async () => {
    fake.setPages([mkPage(1, { url: "https://example.com/same" })]);
    const mine = memInbox();
    // Import into the shared inbox first (one source, as slice 1 requires), then add a second,
    // private source and read it directly.
    await pass();
    const other = await addSource({ owner: "member-1", visibility: "private" });
    const src = (await loadNotionSources(db)).find((s) => s.id === other)!;
    const r = await runClippingSync({ db, client: await fake.client(), source: src, inbox: mine });
    expect(r.counts.imported).toBe(1);
    expect(r.counts.duplicates).toBe(0);
    const note = [...mine.files.values()][0]!;
    expect(parseFrontmatter(note)).toMatchObject({ owner: "member-1", visibility: "private" });
  });

  it("the same page seen through two sources is two records", async () => {
    fake.setPages([mkPage(1)]);
    await pass();
    const other = await addSource({ owner: "member-1", visibility: "private" });
    const src = (await loadNotionSources(db)).find((s) => s.id === other)!;
    await runClippingSync({ db, client: await fake.client(), source: src, inbox: memInbox() });
    const { rows } = await db.query(`SELECT source_id FROM clipping_items WHERE source_item_id = $1 ORDER BY source_id`, [pageId(1)]);
    expect(rows).toHaveLength(2);
  });
});

describe("the ledger", () => {
  it("is unique on (source, item) and carries owner and visibility", async () => {
    fake.setPages([mkPage(1)]);
    await pass();
    const { rows } = await db.query(`SELECT owner, visibility FROM clipping_items`);
    expect(rows).toEqual([{ owner: "organisation", visibility: "shared" }]);
    await expect(
      db.query(
        `INSERT INTO clipping_items (source_id, source_item_id, source_container, owner, visibility, state)
         VALUES ($1, $2, 'ds-1', 'organisation', 'shared', 'imported')`,
        [sourceId, pageId(1)],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("the migration is idempotent", async () => {
    await db.query(sql("091_clipping.sql"));
    await db.query(sql("091_clipping.sql"));
  });

  it("removing a source removes its ledger rows", async () => {
    fake.setPages([mkPage(1)]);
    await pass();
    await db.query(`DELETE FROM clipping_sources WHERE id = $1`, [sourceId]);
    expect((await db.query(`SELECT count(*)::int AS n FROM clipping_items`)).rows[0].n).toBe(0);
  });
});
