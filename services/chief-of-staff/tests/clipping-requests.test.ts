/**
 * LAR-113 child (b) — the clipping request queue: each kind of request, each failure outcome, an
 * exclusive claim, a claim that nobody finished, and a result that never carries a token.
 *
 * The REAL official SDK client runs against a fake `fetch` (tests/helpers/fake-notion.ts), as in
 * clipping-failure.test.ts. Fixture, not proof: the live probe is what shows what Notion answers.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Pool } from "pg";

import { quietPool } from "./helpers/quiet-pool.js";
import { DATABASE_ID, fakeNotion, memInbox, mkPage } from "./helpers/fake-notion.js";
import {
  claimRequest, drainRequests, failStaleClaims, finishRequest, runRequest, CLAIM_STALE_MS,
  type RequestKind,
} from "../lib/clipping/requests.js";
import { parseDatabaseRef, type KeyState } from "../lib/clipping/notion-reader.js";
import { clippingPass, withClippingLock } from "../lib/clipping/step.js";
import { readClippingChoice } from "../lib/clipping/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const sql = (name: string) => readFileSync(join(here, "..", "..", "box", "sql", name), "utf8");

let container: StartedPostgreSqlContainer;
let db: Pool;
let fake: ReturnType<typeof fakeNotion>;
let inbox: ReturnType<typeof memInbox>;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  db = quietPool(container.getConnectionUri());
  await db.query(sql("079_repairs.sql"));
  await db.query(sql("091_clipping.sql"));
  await db.query(sql("092_clipping_requests.sql"));
}, 180_000);
afterAll(async () => { await db?.end(); await container?.stop(); });

async function seedSource(): Promise<string> {
  return (await db.query(
    `INSERT INTO clipping_sources (kind, data_source_id, url_property_id, note_property_id, tags_property_id, owner, visibility, import_since)
     VALUES ('notion', 'ds-1', 'u1', 'n1', 't1', 'organisation', 'shared', '2000-01-01T00:00:00Z') RETURNING id`,
  )).rows[0].id as string;
}

beforeEach(async () => {
  await db.query(`TRUNCATE clipping_items, clipping_sources, clipping_requests, clipping_choice, repairs CASCADE`);
  fake = fakeNotion();
  inbox = memInbox();
});

const deps = (o: { key?: KeyState; timeoutMs?: number; budgetMs?: number } = {}) => ({
  db, inbox,
  token: () => o.key ?? ({ kind: "key", token: "t" } as KeyState),
  makeClient: async () => fake.client({ timeoutMs: o.timeoutMs ?? 2_000, maxRetries: 0 }),
  budgetMs: o.budgetMs,
});

async function enqueue(kind: RequestKind, params: Record<string, unknown> = {}): Promise<string> {
  return (await db.query(
    `INSERT INTO clipping_requests (kind, params, requested_by) VALUES ($1, $2::jsonb, 'owner@example.test') RETURNING id`,
    [kind, JSON.stringify(params)],
  )).rows[0].id as string;
}
async function answer(kind: RequestKind, params: Record<string, unknown> = {}, d = deps()) {
  const id = await enqueue(kind, params);
  await drainRequests(d);
  return (await db.query(`SELECT * FROM clipping_requests WHERE id = $1`, [id])).rows[0];
}

describe("parseDatabaseRef", () => {
  const hex = "11111222333344445555666677778888";
  const dashed = "11111222-3333-4444-5555-666677778888";
  it.each([
    [hex, dashed],
    [dashed, dashed],
    [dashed.toUpperCase(), dashed],
    [`  ${hex}  `, dashed],
    [`https://www.notion.so/${hex}`, dashed],
    [`https://www.notion.so/${hex}?v=99999222333344445555666677778888`, dashed],
    [`https://www.notion.so/My-Clips-${hex}?v=99999222333344445555666677778888&pvs=4`, dashed],
    [`https://www.notion.so/workspace/Read-later-${hex}`, dashed],
    [`https://www.notion.so/workspace/${hex}/`, dashed],
    [`https://team.notion.site/Read-later-${hex}`, dashed],
    [`https://notion.so/${dashed}`, dashed],
  ])("accepts %s", (input, expected) => {
    expect(parseDatabaseRef(input)).toBe(expected);
  });
  it.each([
    "", "   ", "not a link", hex.slice(1), `${hex}0`, "g".repeat(32),
    `https://example.com/My-Clips-${hex}`, `https://notion.so.evil.example/${hex}`,
    `ftp://www.notion.so/${hex}`, "https://www.notion.so/", "https://www.notion.so/My-Clips",
    `https://www.notion.so/Clips${hex}x`, "https://www.notion.so/%E0%A4%A",
  ])("rejects %j", (input) => {
    expect(parseDatabaseRef(input)).toBeNull();
  });
});

describe("the queue", () => {
  it("a claim is exclusive: two workers never get the same request, the oldest goes first", async () => {
    const a = await enqueue("schema");
    await new Promise((r) => setTimeout(r, 5));
    const b = await enqueue("test");
    const [x, y, z] = await Promise.all([claimRequest(db), claimRequest(db), claimRequest(db)]);
    const got = [x, y, z].filter(Boolean).map((r) => r!.id).sort();
    expect(got).toEqual([a, b].sort());
    expect([x, y, z].filter((r) => r === null)).toHaveLength(1);
    const rows = (await db.query(`SELECT status, claimed_at FROM clipping_requests`)).rows;
    expect(rows.every((r) => r.status === "claimed" && r.claimed_at)).toBe(true);
    expect(await claimRequest(db)).toBeNull();
  });

  it("claims the oldest pending request first", async () => {
    const first = await enqueue("schema");
    await new Promise((r) => setTimeout(r, 5));
    await enqueue("test");
    expect((await claimRequest(db))?.id).toBe(first);
  });

  it("finish writes status, outcome, a detail capped at 400 characters, and the result", async () => {
    const id = await enqueue("schema");
    await claimRequest(db);
    await finishRequest(db, id, { status: "failed", outcome: "refused", detail: "x".repeat(900), result: { a: 1 } });
    const row = (await db.query(`SELECT * FROM clipping_requests WHERE id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ status: "failed", outcome: "refused", result: { a: 1 } });
    expect(row.outcome_detail).toHaveLength(400);
    expect(row.finished_at).toBeInstanceOf(Date);
  });

  it("a claim nobody finished is failed after ten minutes and a fresh claim is left alone", async () => {
    const stale = await enqueue("import");
    const fresh = await enqueue("test");
    await db.query(`UPDATE clipping_requests SET status = 'claimed', claimed_at = now() - interval '11 minutes' WHERE id = $1`, [stale]);
    await db.query(`UPDATE clipping_requests SET status = 'claimed', claimed_at = now() - interval '1 minute' WHERE id = $1`, [fresh]);
    expect(CLAIM_STALE_MS).toBe(10 * 60_000);
    expect(await failStaleClaims(db)).toBe(1);
    const rows = Object.fromEntries((await db.query(`SELECT * FROM clipping_requests`)).rows.map((r) => [r.id, r]));
    expect(rows[stale]).toMatchObject({ status: "failed", outcome: "unavailable" });
    expect(rows[stale].outcome_detail).toMatch(/stopped before finishing/);
    expect(rows[stale].finished_at).toBeInstanceOf(Date);
    expect(rows[fresh].status).toBe("claimed");
  });

  it("a drain answers at most three requests per tick and the rest wait", async () => {
    for (let i = 0; i < 5; i++) await enqueue("schema", { link: DATABASE_ID });
    expect(await drainRequests(deps())).toBe(3);
    const counts = (await db.query(`SELECT status, count(*)::int AS n FROM clipping_requests GROUP BY status`)).rows;
    expect(Object.fromEntries(counts.map((r) => [r.status, r.n]))).toEqual({ done: 3, pending: 2 });
  });

  it("the table refuses a kind, status, outcome or second choice row it does not know", async () => {
    await expect(db.query(`INSERT INTO clipping_requests (kind, requested_by) VALUES ('delete-everything', 'x')`)).rejects.toThrow();
    await expect(db.query(`INSERT INTO clipping_requests (kind, status, requested_by) VALUES ('schema', 'lost', 'x')`)).rejects.toThrow();
    await expect(db.query(`INSERT INTO clipping_requests (kind, outcome, requested_by) VALUES ('schema', 'great', 'x')`)).rejects.toThrow();
    await db.query(`INSERT INTO clipping_choice (mode, set_by) VALUES ('notion', 'owner@example.test')`);
    await expect(db.query(`INSERT INTO clipping_choice (id, mode, set_by) VALUES (false, 'both', 'x')`)).rejects.toThrow();
    await expect(db.query(`INSERT INTO clipping_choice (mode, set_by) VALUES ('both', 'x')`)).rejects.toThrow();
  });
});

describe("schema", () => {
  it("reads a database from a pasted link: data sources, columns with ids and types, and a suggestion", async () => {
    const link = `https://www.notion.so/Read-later-${DATABASE_ID.replace(/-/g, "")}?v=99999222333344445555666677778888`;
    const row = await answer("schema", { link });
    expect(row).toMatchObject({ status: "done", outcome: "ok", outcome_detail: null });
    expect(row.result).toEqual({
      databaseId: DATABASE_ID,
      dataSources: [{
        id: "ds-1", name: "Clips",
        columns: [
          { id: "title", name: "Name", type: "title" },
          { id: "u1", name: "Link", type: "url" },
          { id: "n1", name: "Note", type: "rich_text" },
          { id: "t1", name: "Tags", type: "multi_select" },
        ],
      }],
      suggested: { titleId: "title", urlId: "u1" },
    });
    expect(row.finished_at).toBeInstanceOf(Date);
  });

  it("with two url columns, pre-selects the one named URL or Link; with no clear choice, none", async () => {
    fake.world.properties["Source"] = { id: "u2", name: "Source", type: "url" };
    expect((await answer("schema", { link: DATABASE_ID })).result.suggested).toEqual({ titleId: "title", urlId: "u1" }); // Link
    delete fake.world.properties["Link"];
    expect((await answer("schema", { link: DATABASE_ID })).result.suggested).toEqual({ titleId: "title", urlId: "u2" }); // the only one left
    fake.world.properties["Other"] = { id: "u3", name: "Other", type: "url" };
    expect((await answer("schema", { link: DATABASE_ID })).result.suggested).toEqual({ titleId: "title", urlId: null });
  });

  it("a database with no URL column is still read; nothing is pre-selected", async () => {
    delete fake.world.properties["Link"];
    const row = await answer("schema", { link: DATABASE_ID });
    expect(row.status).toBe("done");
    expect(row.result.suggested.urlId).toBeNull();
  });

  it.each([
    ["a link that is not a database link", { link: "https://example.com/x" }, "schema-mismatch", /not a Notion database link/],
    ["no link at all", {}, "schema-mismatch", /not a Notion database link/],
    ["a database not shared with the connection", { link: "99999222-3333-4444-5555-666677778888" }, "not-shared", /not shared/],
  ])("%s", async (_name, params, outcome, detail) => {
    const row = await answer("schema", params);
    expect(row).toMatchObject({ status: "failed", outcome, result: {} });
    expect(row.outcome_detail).toMatch(detail);
  });

  it("a database with no data sources is named, not shown as empty", async () => {
    fake.world.databases.set(DATABASE_ID, []);
    const row = await answer("schema", { link: DATABASE_ID });
    expect(row).toMatchObject({ status: "failed", outcome: "schema-mismatch" });
  });
});

describe("every failure keeps its own outcome and a plain sentence", () => {
  const cases: { name: string; kind: RequestKind; fault: Parameters<typeof fake.world.faults.push>[0]; outcome: string; opts?: Parameters<typeof deps>[0] }[] = [
    { name: "a refused key", kind: "schema", fault: { match: /databases/, status: 401, body: { object: "error", status: 401, code: "unauthorized", message: "boom" } }, outcome: "refused" },
    { name: "a rate limit", kind: "schema", fault: { match: /databases/, status: 429, body: { object: "error", status: 429, code: "rate_limited", message: "boom" } }, outcome: "rate-limited" },
    { name: "a server error", kind: "schema", fault: { match: /data_sources/, status: 500 }, outcome: "unavailable" },
    { name: "a network error", kind: "schema", fault: { match: /databases/, networkError: true }, outcome: "unavailable" },
    { name: "a request that never answers", kind: "schema", fault: { match: /databases/, hang: true }, outcome: "timeout", opts: { timeoutMs: 40 } },
    { name: "a whole request that overruns its budget", kind: "schema", fault: { match: /databases/, hang: true }, outcome: "timeout", opts: { timeoutMs: 60_000, budgetMs: 60 } },
    { name: "a 404 on the data source", kind: "test", fault: { match: /GET .*data_sources/, status: 404, body: { object: "error", status: 404, code: "object_not_found", message: "x" } }, outcome: "not-shared" },
    { name: "a query Notion rejects", kind: "test", fault: { match: /query$/, status: 400, body: { object: "error", status: 400, code: "validation_error", message: "x" } }, outcome: "schema-mismatch" },
    { name: "a refused key on add-properties", kind: "add-properties", fault: { match: /data_sources/, status: 403, body: { object: "error", status: 403, code: "restricted_resource", message: "x" } }, outcome: "refused" },
    { name: "a refused key on import", kind: "import", fault: { match: /data_sources/, status: 401, body: { object: "error", status: 401, code: "unauthorized", message: "x" } }, outcome: "refused" },
  ];
  it.each(cases)("$name -> $kind: $outcome", async ({ kind, fault, outcome, opts }) => {
    await seedSource();
    fake.setPages([mkPage(1)]);
    fake.world.faults.push(fault);
    const row = await answer(kind, { link: DATABASE_ID }, deps(opts));
    expect(row).toMatchObject({ status: "failed", outcome, result: {} });
    expect(row.outcome_detail).toBeTruthy();
    expect(row.outcome_detail.length).toBeLessThanOrEqual(400);
    expect(row.outcome_detail).not.toMatch(/test-token|boom|Bearer/);
    expect(row.finished_at).toBeInstanceOf(Date);
  }, 20_000);

  it("no key delivered, and a key that cannot be read, are told apart", async () => {
    const none = await answer("schema", { link: DATABASE_ID }, deps({ key: { kind: "none" } }));
    expect(none).toMatchObject({ status: "failed", outcome: "not-configured" });
    expect(none.outcome_detail).toMatch(/no Notion key/i);
    const unreadable = await answer("schema", { link: DATABASE_ID }, deps({ key: { kind: "unreadable" } }));
    expect(unreadable).toMatchObject({ status: "failed", outcome: "key-unreadable" });
    expect(fake.world.requests).toHaveLength(0); // nothing was sent to Notion
  });

  it("a database failure on our side is a local error, not 'Notion is down'", async () => {
    const id = await enqueue("test");
    const req = await claimRequest(db);
    const broken = { query: async () => { throw Object.assign(new Error("relation missing"), { code: "42P01" }); } };
    const o = await runRequest({ ...deps(), db: broken as never }, req!);
    expect(o).toMatchObject({ status: "failed", outcome: "local-error" });
    expect(id).toBe(req!.id);
  });
});

describe("test", () => {
  it("counts what the saved mapping would import, where the link came from, and what it would not", async () => {
    await seedSource();
    fake.setPages([
      mkPage(1),                                              // link in the URL column
      mkPage(2),                                              // link in the URL column
      mkPage(3, { url: null, title: "https://example.com/from-title" }), // link only in the title
      mkPage(4, { url: null, title: "no link here" }),        // nothing to import
      mkPage(5, { trash: true }),                             // trashed: not counted at all
    ]);
    const row = await answer("test");
    expect(row).toMatchObject({ status: "done", outcome: "ok" });
    expect(row.result).toEqual({
      wouldImport: 3, fromUrlColumn: 2, fromTitle: 1, withoutLink: 1, alreadyImported: 0, more: false, warnings: [],
    });
    // Writes nothing: no inbox file, no ledger row, no state change on the source.
    expect(inbox.files.size).toBe(0);
    expect((await db.query(`SELECT count(*)::int AS n FROM clipping_items`)).rows[0].n).toBe(0);
    const src = (await db.query(`SELECT outcome, last_attempt_at, watermark FROM clipping_sources`)).rows[0];
    expect(src).toMatchObject({ outcome: null, last_attempt_at: null, watermark: null });
    expect(fake.world.requests.every((r) => r.key.startsWith("GET") || /query$/.test(r.key))).toBe(true);
  });

  it("an item already imported, or whose link is already in the inbox, is counted as already imported", async () => {
    await seedSource();
    fake.setPages([mkPage(1), mkPage(2, { url: "https://example.com/p/1" })]); // 2 repeats 1's link
    await answer("import");
    expect(inbox.files.size).toBe(1);
    fake.put(mkPage(3));
    fake.put(mkPage(2, { url: "https://example.com/p/1", edited: "2026-10-03T10:00:00.000Z" }));
    const row = await answer("test");
    expect(row.result).toMatchObject({ wouldImport: 1, alreadyImported: expect.any(Number) });
    expect(row.result.alreadyImported).toBeGreaterThanOrEqual(1);
    expect(inbox.files.size).toBe(1);
  });

  it("says when there is more than one page of rows", async () => {
    await seedSource();
    fake.setPages(Array.from({ length: 101 }, (_, i) => mkPage(i + 1)));
    const row = await answer("test");
    expect(row.result).toMatchObject({ wouldImport: 100, more: true });
  });

  it("a proposed mapping in the request is tested before it is saved; with nothing saved it starts from now", async () => {
    fake.setPages([mkPage(1)]);
    const proposal = { dataSourceId: "ds-1", urlPropertyId: "u1" };
    const none = await answer("test", proposal);
    expect(none).toMatchObject({ status: "done", result: { wouldImport: 0 } }); // nothing is older than 'now'
    fake.put(mkPage(2, { edited: new Date(Date.now() + 60_000).toISOString() }));
    const some = await answer("test", proposal);
    expect(some.result).toMatchObject({ wouldImport: 1, fromUrlColumn: 1 });
  });

  it("a proposed URL column that is not a URL column is a schema mismatch", async () => {
    const row = await answer("test", { dataSourceId: "ds-1", urlPropertyId: "n1" });
    expect(row).toMatchObject({ status: "failed", outcome: "schema-mismatch" });
    expect(row.outcome_detail).toMatch(/URL column/);
  });

  it("an optional column that changed type is reported as a warning, not a stop", async () => {
    await seedSource();
    fake.world.properties["Tags"] = { id: "t1", name: "Tags", type: "number" };
    fake.setPages([mkPage(1)]);
    const row = await answer("test");
    expect(row.status).toBe("done");
    expect(row.result.warnings).toEqual([expect.stringMatching(/tags column/)]);
  });

  it("with nothing saved and nothing proposed, it says so", async () => {
    const row = await answer("test");
    expect(row).toMatchObject({ status: "failed", outcome: "not-configured" });
    expect(row.outcome_detail).toMatch(/No clipping source is saved/);
  });
});

describe("import", () => {
  it("runs one clipping pass and reports its counts", async () => {
    const sourceId = await seedSource();
    fake.setPages([mkPage(1), mkPage(2), mkPage(3, { url: null, title: "plain words" })]);
    const row = await answer("import");
    expect(row).toMatchObject({ status: "done", outcome: "ok" });
    expect(row.result).toMatchObject({ imported: 2, updated: 0, trashed: 0, skipped: 1, noLink: 1, duplicates: 0 });
    expect(inbox.files.size).toBe(2);
    const src = (await db.query(`SELECT outcome, imported_total FROM clipping_sources WHERE id = $1`, [sourceId])).rows[0];
    expect(src).toMatchObject({ outcome: "ok", imported_total: 2 });
    // Run again: nothing new, and it says 0 because it is true.
    const again = await answer("import");
    expect(again.result).toMatchObject({ imported: 0 });
  });

  it("with no source saved, it fails as not-configured and never reads as 'imported 0'", async () => {
    const row = await answer("import");
    expect(row).toMatchObject({ status: "failed", outcome: "not-configured", result: {} });
    expect(row.outcome_detail).toMatch(/No clipping source is saved/);
  });

  it("refuses with a plain sentence while the source choice is Karakeep, and reads nothing", async () => {
    await seedSource();
    await db.query(`INSERT INTO clipping_choice (mode, set_by) VALUES ('karakeep', 'owner@example.test')`);
    fake.setPages([mkPage(1)]);
    const row = await answer("import");
    expect(row).toMatchObject({ status: "failed", outcome: "not-configured" });
    expect(row.outcome_detail).toMatch(/Karakeep only/);
    expect(fake.world.requests).toHaveLength(0);
    expect(inbox.files.size).toBe(0);
  });

  it.each(["notion", "both"])("is allowed while the source choice is %s", async (mode) => {
    await seedSource();
    await db.query(`INSERT INTO clipping_choice (mode, set_by) VALUES ($1, 'owner@example.test')`, [mode]);
    fake.setPages([mkPage(1)]);
    expect((await answer("import")).status).toBe("done");
  });

  it("two passes never overlap: the second waits for the first", async () => {
    const order: string[] = [];
    const slow = withClippingLock(async () => { order.push("a-start"); await new Promise((r) => setTimeout(r, 40)); order.push("a-end"); });
    const next = withClippingLock(async () => { order.push("b-start"); order.push("b-end"); });
    await Promise.all([slow, next]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
    // A failing first pass does not block the next one.
    await withClippingLock(async () => { throw new Error("x"); }).catch(() => undefined);
    await expect(withClippingLock(async () => "ok")).resolves.toBe("ok");
  });

  it("Import now and a digest pass over the same source import each page once", async () => {
    await seedSource();
    fake.setPages([mkPage(1), mkPage(2)]);
    const pass = () => clippingPass({
      db, inbox, token: () => ({ kind: "key", token: "t" }), makeClient: async () => fake.client(),
    });
    const id = await enqueue("import");
    const [digestPass] = await Promise.all([pass(), drainRequests(deps())]);
    expect(digestPass.outcome).toBe("ok");
    const rows = (await db.query(`SELECT * FROM clipping_requests WHERE id = $1`, [id])).rows;
    expect(rows[0].status).toBe("done");
    expect(inbox.writes).toHaveLength(2);
    expect((await db.query(`SELECT count(*)::int AS n FROM clipping_items WHERE state = 'imported'`)).rows[0].n).toBe(2);
  });
});

describe("add-properties", () => {
  const present = () => Object.fromEntries(
    Object.entries(fake.world.properties as Record<string, { type: string }>).map(([k, v]) => [k, v.type]),
  );

  it("adds Status, For and Origin, and a second run adds nothing", async () => {
    await seedSource();
    const first = await answer("add-properties");
    expect(first).toMatchObject({ status: "done", outcome: "ok", result: { added: ["Status", "For", "Origin"], present: [], conflicts: [] } });
    expect(present()).toMatchObject({ Status: "select", For: "multi_select", Origin: "select" });
    const patches = fake.world.requests.filter((r) => r.key.startsWith("PATCH"));
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toEqual({ properties: {
      Status: { select: {} },
      For: { multi_select: {} },
      Origin: { select: { options: [{ name: "Owner" }, { name: "Lares" }] } },
    } });
    const second = await answer("add-properties");
    expect(second.result).toEqual({ added: [], present: ["Status", "For", "Origin"], conflicts: [] });
    expect(fake.world.requests.filter((r) => r.key.startsWith("PATCH"))).toHaveLength(1); // no second write
  });

  it("a same-named column of another type is a conflict and is NOT changed; the others are still added", async () => {
    await seedSource();
    fake.world.properties["status"] = { id: "x1", name: "status", type: "rich_text" }; // matches case-insensitively
    const row = await answer("add-properties");
    expect(row.status).toBe("done");
    expect(row.result).toEqual({
      added: ["For", "Origin"], present: [],
      conflicts: [{ name: "Status", found: "rich_text", wanted: "select" }],
    });
    expect(present()["status"]).toBe("rich_text");
    expect(present()["Status"]).toBeUndefined();
    const body = fake.world.requests.find((r) => r.key.startsWith("PATCH"))!.body as { properties: Record<string, unknown> };
    expect(Object.keys(body.properties)).toEqual(["For", "Origin"]);
  });

  it("only conflicts and present columns: nothing is written at all", async () => {
    await seedSource();
    fake.world.properties["Status"] = { id: "s", name: "Status", type: "select" };
    fake.world.properties["For"] = { id: "f", name: "For", type: "number" };
    fake.world.properties["Origin"] = { id: "o", name: "Origin", type: "select" };
    const row = await answer("add-properties");
    expect(row.result).toEqual({
      added: [], present: ["Status", "Origin"], conflicts: [{ name: "For", found: "number", wanted: "multi_select" }],
    });
    expect(fake.world.requests.filter((r) => r.key.startsWith("PATCH"))).toHaveLength(0);
  });

  it("works on a data source named in the request when nothing is saved yet, and says so when neither exists", async () => {
    const named = await answer("add-properties", { dataSourceId: "ds-1" });
    expect(named.result.added).toEqual(["Status", "For", "Origin"]);
    const neither = await answer("add-properties");
    expect(neither).toMatchObject({ status: "failed", outcome: "not-configured" });
  });
});

describe("a result never carries a token or a vendor body", () => {
  it("across every kind, success and failure", async () => {
    await seedSource();
    fake.setPages([mkPage(1)]);
    await answer("schema", { link: DATABASE_ID }, deps());
    await answer("test");
    await answer("import");
    await answer("add-properties");
    fake.world.faults.push({ match: /data_sources/, status: 500, body: { object: "error", status: 500, code: "internal_server_error", message: "vendor-body-text Bearer abc" } });
    await answer("test");
    await answer("import");
    const all = JSON.stringify((await db.query(`SELECT kind, params, result, outcome_detail FROM clipping_requests`)).rows);
    expect(all).not.toMatch(/test-token|Bearer|vendor-body-text/);
    expect((await db.query(`SELECT count(*)::int AS n FROM clipping_requests WHERE status IN ('pending', 'claimed')`)).rows[0].n).toBe(0);
  });
});

describe("the source choice", () => {
  it("reads none, then the saved mode; a missing table is also none", async () => {
    expect(await readClippingChoice(db)).toBeNull();
    await db.query(`INSERT INTO clipping_choice (mode, set_by) VALUES ('both', 'owner@example.test')`);
    expect(await readClippingChoice(db)).toBe("both");
    const missing = { query: async () => { throw Object.assign(new Error("no table"), { code: "42P01" }); } };
    expect(await readClippingChoice(missing as never)).toBeNull();
    const broken = { query: async () => { throw Object.assign(new Error("down"), { code: "57P01" }); } };
    await expect(readClippingChoice(broken as never)).rejects.toThrow("down");
  });
});

describe("the digest honours the choice (wiring)", () => {
  const src = readFileSync(join(here, "..", "agent", "schedules", "digest.ts"), "utf8");
  it("reads the choice first; Notion skips the Karakeep pull, Karakeep skips the clipping step, a failed read changes nothing", () => {
    const read = src.indexOf("await readClippingChoice(db)");
    const karakeep = src.indexOf("await karakeepPass(log)");
    const clipping = src.indexOf("await clippingStep(log)");
    expect(read).toBeGreaterThan(0);
    expect(karakeep).toBeGreaterThan(read);
    expect(clipping).toBeGreaterThan(karakeep);
    expect(src).toMatch(/if \(choice === "notion"\) log\([^\n]*\);\s+else \{\s+try \{ await karakeepPass\(log\); \}/);
    expect(src).toMatch(/if \(choice === "karakeep"\) log\([^\n]*\);\s+else notices = await clippingStep\(log\);/);
    expect(src).toMatch(/readClippingChoice\(db\)\.catch\([\s\S]*?return null;/);
  });
});

describe("the drain schedule (wiring)", () => {
  const src = readFileSync(join(here, "..", "agent", "schedules", "clipping-requests.ts"), "utf8");
  it("is gated by its own definition switch and the service gate, not the digest's gate", () => {
    expect(src).toMatch(/if \(!scheduleEnabled\(loaded\.definition, "clipping-requests"\)\) return;/);
    expect(src).toMatch(/if \(!scheduleGate\(\)\) return;/);
    expect(src).not.toMatch(/env\["EVE_DIGEST_LIVE"\]|digestGate\(/);
    expect(src).toMatch(/cron: "\* \* \* \* \*"/);
  });
  it("logs a missing request table once and stamps nothing", () => {
    expect(src).toMatch(/42P01/);
    expect(src).toMatch(/warnedMissingTable/);
    const stamp = src.indexOf("recordSchedulePass(db, HEARTBEAT_KEY)");
    const missing = src.indexOf("42P01");
    expect(stamp).toBeGreaterThan(0);
    expect(missing).toBeGreaterThan(stamp); // the catch comes after the only stamp: a failed pass never stamps
  });
});
