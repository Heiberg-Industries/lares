/**
 * Articles child 1b: when the digest files a saved link as an article, the clipping ledger keeps
 * where it went. Against a REAL Postgres (testcontainers), with `box/sql` 079, 091 and 092
 * applied verbatim from disk.
 *
 * 093 (the heartbeat row for the request drain) is not applied: it only seeds a row in a table
 * (`heartbeat`, sql/031) that no clipping test creates, and it touches nothing this function reads.
 * No migration is part of this change; the ledger's `inbox_path` column is reused after filing.
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
import { makeLedgerOnFiled, recordFiledArticle } from "../lib/clipping/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const sql = (name: string) => readFileSync(join(here, "..", "..", "box", "sql", name), "utf8");

let container: StartedPostgreSqlContainer;
let db: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  db = quietPool(container.getConnectionUri());
  await db.query(sql("079_repairs.sql"));
  await db.query(sql("091_clipping.sql"));
  await db.query(sql("092_clipping_requests.sql"));
}, 180_000);

afterAll(async () => {
  await db?.end();
  await container?.stop();
});

let sourceId: string;
let fake: ReturnType<typeof fakeNotion>;
let inbox: ReturnType<typeof memInbox>;

beforeEach(async () => {
  await db.query(`TRUNCATE clipping_items, clipping_sources, repairs CASCADE`);
  const { rows } = await db.query(
    `INSERT INTO clipping_sources (kind, data_source_id, url_property_id, note_property_id, tags_property_id, owner, visibility, import_since)
     VALUES ('notion', 'ds-1', 'u1', 'n1', 't1', 'organisation', 'shared', '2000-01-01T00:00:00Z') RETURNING id`,
  );
  sourceId = rows[0].id as string;
  fake = fakeNotion();
  inbox = memInbox();
});

const pass = () => clippingPass({ db, inbox, token: () => ({ kind: "key", token: "t" }), makeClient: async () => fake.client() });
const row = async (n: number) =>
  (await db.query(`SELECT state, inbox_path FROM clipping_items WHERE source_id = $1 AND source_item_id = $2`, [sourceId, pageId(n)])).rows[0] as
    { state: string; inbox_path: string | null };

describe("recordFiledArticle", () => {
  it("an imported clip becomes filed-unknown and keeps the article's path", async () => {
    fake.setPages([mkPage(1)]);
    await pass();
    const inboxPath = clipInboxPath(sourceId, pageId(1));
    expect((await row(1)).state).toBe("imported");

    expect(await recordFiledArticle(db, { inboxPath, filedPath: "articles/a-title.md" })).toBe(true);

    expect(await row(1)).toEqual({ state: "filed-unknown", inbox_path: "articles/a-title.md" });
  });

  it("a clip already filed-unknown (the console's Import now race) still gets the path", async () => {
    fake.setPages([mkPage(1)]);
    await pass();
    const inboxPath = clipInboxPath(sourceId, pageId(1));
    await db.query(`UPDATE clipping_items SET state = 'filed-unknown' WHERE source_id = $1`, [sourceId]);

    expect(await recordFiledArticle(db, { inboxPath, filedPath: "articles/a-title.md" })).toBe(true);

    expect(await row(1)).toEqual({ state: "filed-unknown", inbox_path: "articles/a-title.md" });
  });

  it("a path the ledger does not know changes nothing", async () => {
    fake.setPages([mkPage(1)]);
    await pass();
    const before = await row(1);

    expect(await recordFiledArticle(db, { inboxPath: "_inbox/never-seen.md", filedPath: "articles/x.md" })).toBe(false);

    expect(await row(1)).toEqual(before);
  });

  it("does not touch a trashed or skipped clip that happens to carry the same path", async () => {
    fake.setPages([mkPage(1)]);
    await pass();
    const inboxPath = clipInboxPath(sourceId, pageId(1));
    await db.query(`UPDATE clipping_items SET state = 'trashed' WHERE source_id = $1`, [sourceId]);

    expect(await recordFiledArticle(db, { inboxPath, filedPath: "articles/x.md" })).toBe(false);

    expect(await row(1)).toEqual({ state: "trashed", inbox_path: inboxPath });
  });

  it("a later sync that sees an edit keeps the recorded path", async () => {
    fake.setPages([mkPage(1, { title: "Old", edited: "2026-10-01T10:01:00.000Z" })]);
    await pass();
    const inboxPath = clipInboxPath(sourceId, pageId(1));
    await recordFiledArticle(db, { inboxPath, filedPath: "articles/old.md" });
    inbox.filed(inboxPath); // the digest retired the inbox note

    fake.put(mkPage(1, { title: "Edited later", edited: "2026-10-01T10:20:00.000Z" }));
    const r = await pass();

    expect(r.outcome).toBe("ok");
    expect(inbox.files.size).toBe(0);
    expect(await row(1)).toEqual({ state: "filed-unknown", inbox_path: "articles/old.md" });
  });

  it("a second record for the same inbox path is a no-op: the path is already the article's", async () => {
    fake.setPages([mkPage(1)]);
    await pass();
    const inboxPath = clipInboxPath(sourceId, pageId(1));
    await recordFiledArticle(db, { inboxPath, filedPath: "articles/first.md" });

    expect(await recordFiledArticle(db, { inboxPath, filedPath: "articles/second.md" })).toBe(false);

    expect((await row(1)).inbox_path).toBe("articles/first.md");
  });
});

describe("makeLedgerOnFiled: best effort, never fails the filing", () => {
  it("records the destination path of a filed article", async () => {
    fake.setPages([mkPage(1)]);
    await pass();
    const inboxPath = clipInboxPath(sourceId, pageId(1));
    const logs: string[] = [];

    await makeLedgerOnFiled(db, (m) => logs.push(m))(inboxPath, { area: "private", destPath: "articles/t.md" });

    expect(await row(1)).toEqual({ state: "filed-unknown", inbox_path: "articles/t.md" });
    expect(logs).toEqual([]);
  });

  it("swallows a database failure and logs it", async () => {
    const broken = { query: () => Promise.reject(new Error("db down")) };
    const logs: string[] = [];

    await expect(
      makeLedgerOnFiled(broken as never, (m) => logs.push(m))("_inbox/a.md", { area: "shared", destPath: "articles/a.md" }),
    ).resolves.toBeUndefined();

    expect(logs.join("\n")).toContain("db down");
  });

  it("treats a box without the clipping tables (migration 091 not applied) as nothing to record, quietly", async () => {
    const missing = { query: () => Promise.reject(Object.assign(new Error('relation "clipping_items" does not exist'), { code: "42P01" })) };
    const logs: string[] = [];

    await makeLedgerOnFiled(missing as never, (m) => logs.push(m))("_inbox/a.md", { area: "private", destPath: "articles/a.md" });

    expect(logs).toEqual([]);
  });
});
