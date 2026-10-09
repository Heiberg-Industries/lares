/**
 * LAR-113 child (a) — every way the clipping fetch can fail gives its own outcome, opens a repair,
 * adds one digest line and leaves the watermark alone; success closes the repair; nothing in the
 * step ever reports "ok, 0 new" after a failure, and nothing in it calls a model.
 *
 * The REAL official SDK client runs against a fake `fetch` (tests/helpers/fake-notion.ts), so
 * the retry, the timeout and the error classes are the production ones. Fixture, not proof: the
 * live probe is what shows what Notion actually answers.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Pool } from "pg";

import { quietPool } from "./helpers/quiet-pool.js";
import { fakeNotion, memInbox, mkPage, type Fault } from "./helpers/fake-notion.js";
import { clippingPass } from "../lib/clipping/step.js";
import { classifyNotionError, makeNotionClient, readNotionToken, type KeyState } from "../lib/clipping/notion-reader.js";
import { renderDigest } from "../lib/digest/format.js";
import { runDigest } from "../lib/digest/runner.js";
import * as llm from "../lib/llm-complete.js";

const here = dirname(fileURLToPath(import.meta.url));
const sql = (name: string) => readFileSync(join(here, "..", "..", "box", "sql", name), "utf8");

let container: StartedPostgreSqlContainer;
let db: Pool;
let sourceId: string;
let fake: ReturnType<typeof fakeNotion>;
let inbox: ReturnType<typeof memInbox>;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  db = quietPool(container.getConnectionUri());
  await db.query(sql("079_repairs.sql"));
  await db.query(sql("091_clipping.sql"));
}, 180_000);
afterAll(async () => { await db?.end(); await container?.stop(); });

beforeEach(async () => {
  await db.query(`TRUNCATE clipping_items, clipping_sources, repairs CASCADE`);
  sourceId = (await db.query(
    `INSERT INTO clipping_sources (kind, data_source_id, url_property_id, note_property_id, tags_property_id, owner, visibility, import_since)
     VALUES ('notion', 'ds-1', 'u1', 'n1', 't1', 'organisation', 'shared', '2000-01-01T00:00:00Z') RETURNING id`,
  )).rows[0].id as string;
  fake = fakeNotion();
  inbox = memInbox();
});

const run = (o: { timeoutMs?: number; budgetMs?: number; key?: KeyState; maxRetries?: number } = {}) =>
  clippingPass({
    db, inbox,
    token: () => o.key ?? { kind: "key", token: "t" },
    makeClient: async () => fake.client({ timeoutMs: o.timeoutMs, maxRetries: o.maxRetries }),
    budgetMs: o.budgetMs,
  });

const stateRow = async () => (await db.query(`SELECT * FROM clipping_sources WHERE id = $1`, [sourceId])).rows[0];
const repair = async () =>
  (await db.query(`SELECT * FROM repairs WHERE kind = 'clipping' AND ref = $1`, [sourceId])).rows[0];

const NOT_FOUND = { object: "error", status: 404, code: "object_not_found", message: "x" };
const cases: { name: string; fault: Fault; outcome: string; opts?: Parameters<typeof run>[0] }[] = [
  { name: "a refused key (401)", fault: { match: /data_sources/, status: 401, body: { object: "error", status: 401, code: "unauthorized", message: "x" } }, outcome: "refused" },
  { name: "a key without permission (403)", fault: { match: /data_sources/, status: 403, body: { object: "error", status: 403, code: "restricted_resource", message: "x" } }, outcome: "refused" },
  { name: "a database that is not shared (404)", fault: { match: /GET .*data_sources/, status: 404, body: NOT_FOUND }, outcome: "not-shared" },
  { name: "a query Notion rejects as invalid (400)", fault: { match: /query$/, status: 400, body: { object: "error", status: 400, code: "validation_error", message: "x" } }, outcome: "schema-mismatch" },
  { name: "a rate limit beyond the retries (429)", fault: { match: /data_sources/, status: 429, headers: { "retry-after": "30" }, body: { object: "error", status: 429, code: "rate_limited", message: "x" } }, outcome: "rate-limited" },
  { name: "a server error on the query (500)", fault: { match: /query$/, status: 500 }, outcome: "unavailable" },
  { name: "a network error", fault: { match: /data_sources/, networkError: true }, outcome: "unavailable" },
  { name: "a request that never answers (SDK timeout)", fault: { match: /data_sources/, hang: true }, outcome: "timeout", opts: { timeoutMs: 40 } },
  { name: "a whole step that overruns its budget", fault: { match: /data_sources/, hang: true }, outcome: "timeout", opts: { timeoutMs: 60_000, budgetMs: 60 } },
];

describe("each failure has its own outcome, a repair, a digest line, and an unmoved watermark", () => {
  it.each(cases)("$name -> $outcome", async ({ fault, outcome, opts }) => {
    fake.setPages([mkPage(1)]);
    await run(); // a good pass first, so there is a watermark and a last good time to protect
    const before = await stateRow();
    expect(before.outcome).toBe("ok");
    fake.put(mkPage(2, { edited: "2026-10-02T10:00:00.000Z" }));
    fake.world.faults.push(fault);

    const r = await run(opts);
    expect(r.outcome).toBe(outcome);
    expect(r.imported).toBe(0);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toMatch(/Clipping from Notion did not run/);
    expect(r.notices[0]).toMatch(/Last good fetch: 20\d\d-/);

    const after = await stateRow();
    expect(after.outcome).toBe(outcome);
    expect(after.outcome).not.toBe("ok");
    expect(after.watermark.toISOString()).toBe(before.watermark.toISOString());
    expect(after.last_success_at.toISOString()).toBe(before.last_success_at.toISOString());
    expect(after.last_attempt_at.getTime()).toBeGreaterThanOrEqual(before.last_attempt_at.getTime());
    expect(inbox.files.size).toBe(1);

    const rep = await repair();
    expect(rep).toMatchObject({ severity: "warn", resolved_at: null });
    expect(rep.what).toMatch(/^Clipping from Notion:/);
    // Owner text only: no vendor body, no token.
    expect(rep.what + (rep.how_to_fix ?? "")).not.toMatch(/test-token|boom|Bearer/);
  }, 20_000);

  it("a rate limit is retried a bounded number of times, with a bounded wait", async () => {
    fake.world.faults.push({ match: /data_sources/, status: 429, headers: { "retry-after": "30" }, body: { object: "error", status: 429, code: "rate_limited", message: "x" } });
    const t0 = Date.now();
    const r = await run();
    expect(r.outcome).toBe("rate-limited");
    expect(fake.world.requests.filter((q) => /GET .*data_sources/.test(q.key))).toHaveLength(3); // 1 + 2 retries
    expect(Date.now() - t0).toBeLessThan(2_000); // Retry-After: 30 s was capped, not slept
  });

  it("a rate limit that clears within the retries is a success", async () => {
    fake.setPages([mkPage(1)]);
    fake.world.faults.push({ match: /GET .*data_sources/, status: 429, headers: { "retry-after": "1" }, body: { object: "error", status: 429, code: "rate_limited", message: "x" }, times: 1 });
    expect((await run()).outcome).toBe("ok");
    expect(inbox.files.size).toBe(1);
  });

  it("an incomplete answer fails the pass instead of being trusted", async () => {
    fake.setPages([mkPage(1)]);
    fake.world.incompleteQuery = true;
    const r = await run();
    expect(r.outcome).toBe("incomplete");
    expect(inbox.files.size).toBe(0);
    expect((await stateRow()).watermark).toBeNull();
  });

  it("a URL column that changed type refuses with a named reason", async () => {
    fake.setPages([mkPage(1)]);
    fake.world.properties = { ...fake.world.properties, Link: { id: "u1", name: "Link", type: "rich_text" } };
    const r = await run();
    expect(r.outcome).toBe("schema-mismatch");
    expect(r.notices[0]).toMatch(/URL column/);
    expect(inbox.files.size).toBe(0);
  });

  it("a failure never leaves an ok behind, even on the very first pass", async () => {
    fake.world.faults.push({ match: /data_sources/, status: 500 });
    const r = await run();
    expect(r.outcome).not.toBe("ok");
    const s = await stateRow();
    expect(s.last_success_at).toBeNull();
    expect(r.notices[0]).toMatch(/Last good fetch: never/);
  });
});

describe("recovery", () => {
  it("the next good pass resolves the repair, with no lost or doubled clips", async () => {
    fake.setPages([mkPage(1), mkPage(2)]);
    fake.world.faults.push({ match: /GET .*data_sources/, status: 404, body: NOT_FOUND });
    expect((await run()).outcome).toBe("not-shared");
    expect((await repair()).resolved_at).toBeNull();
    fake.world.faults.length = 0;
    const ok = await run();
    expect(ok).toMatchObject({ outcome: "ok", imported: 2, notices: [] });
    expect((await repair()).resolved_at).not.toBeNull();
    expect((await run()).imported).toBe(0);
    expect(inbox.files.size).toBe(2);
  });

  it("a repeat failure keeps one repair row, not a log", async () => {
    fake.world.faults.push({ match: /data_sources/, status: 500 });
    await run(); await run(); await run();
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM repairs WHERE kind = 'clipping'`);
    expect(rows[0].n).toBe(1);
  });
});

describe("not configured, and unsupported setups", () => {
  it("no source row: skipped silently, and says not-configured, not ok", async () => {
    await db.query(`DELETE FROM clipping_sources`);
    const r = await run();
    expect(r).toEqual({ outcome: "not-configured", imported: 0, detail: "No clipping source is saved yet.", notices: [] });
    expect(fake.world.requests).toHaveLength(0);
    expect((await db.query(`SELECT count(*)::int AS n FROM repairs`)).rows[0].n).toBe(0);
  });

  it("a source row but no key: the state says not-configured and Notion is never called", async () => {
    const r = await run({ key: { kind: "none" } });
    expect(r).toMatchObject({ outcome: "not-configured", notices: [] });
    expect((await stateRow()).outcome).toBe("not-configured");
    expect(fake.world.requests).toHaveLength(0);
  });

  it("not-configured never closes a repair that a real failure opened", async () => {
    fake.world.faults.push({ match: /data_sources/, status: 500 });
    await run();
    expect((await repair()).resolved_at).toBeNull();
    await run({ key: { kind: "none" } });
    expect((await repair()).resolved_at).toBeNull();
  });

  it("a key that is delivered but unreadable is a failure: outcome, repair, digest line", async () => {
    const r = await run({ key: { kind: "unreadable" } });
    expect(r.outcome).toBe("key-unreadable");
    expect(r.notices).toHaveLength(1);
    expect((await stateRow()).outcome).toBe("key-unreadable");
    expect((await repair()).resolved_at).toBeNull();
    expect(fake.world.requests).toHaveLength(0);
  });

  it("readNotionToken tells unset, unreadable and empty apart", () => {
    expect(readNotionToken({})).toEqual({ kind: "none" });
    expect(readNotionToken({ NOTION_TOKEN_FILE: "/nonexistent/key" })).toEqual({ kind: "unreadable" });
    const f = join(tmpdir(), `clip-key-${process.pid}`);
    writeFileSync(f, "  \n");
    expect(readNotionToken({ NOTION_TOKEN_FILE: f })).toEqual({ kind: "unreadable" });
    writeFileSync(f, "secret\n");
    expect(readNotionToken({ NOTION_TOKEN_FILE: f })).toEqual({ kind: "key", token: "secret" });
    expect(readNotionToken({ NOTION_TOKEN: "env-key" })).toEqual({ kind: "key", token: "env-key" });
  });

  it("a local database or disk error is its own outcome, not Notion being unavailable", () => {
    expect(classifyNotionError(Object.assign(new Error("x"), { code: "08006" })).outcome).toBe("local-error");
    expect(classifyNotionError(Object.assign(new Error("x"), { code: "ENOSPC" })).outcome).toBe("local-error");
    expect(classifyNotionError(new TypeError("fetch failed")).outcome).toBe("unavailable");
  });

  it("more than one source is refused with a plain reason, and none is read", async () => {
    await db.query(`INSERT INTO clipping_sources (kind, data_source_id, url_property_id, owner, visibility, import_since) VALUES ('notion', 'ds-2', 'u1', 'organisation', 'shared', now())`);
    const r = await run();
    expect(r.outcome).toBe("unsupported-source");
    expect(r.notices).toHaveLength(1);
    expect(fake.world.requests).toHaveLength(0);
    expect((await repair()).resolved_at).toBeNull();
  });

  it.each([
    ["a member-owned source", `owner = 'member-1'`],
    ["a private source", `visibility = 'private'`],
    ["a source with another credential", `credential_ref = 'notion:member:1'`],
  ])("%s is refused in slice 1", async (_name, set) => {
    await db.query(`UPDATE clipping_sources SET ${set}`);
    const r = await run();
    expect(r.outcome).toBe("unsupported-source");
    expect(fake.world.requests).toHaveLength(0);
  });
});

describe("the digest line", () => {
  it("a failed clipping step makes even an empty scheduled digest post, with one line", async () => {
    fake.world.faults.push({ match: /data_sources/, status: 500 });
    const { notices } = await run();
    const posted: string[] = [];
    const summary = await runDigest({
      agent: "a", mode: "scheduled", capturedAt: "2026-10-09", notices,
      listInbox: async () => [], alreadySkipped: async () => [], noteNames: async () => [], projects: async () => [],
      llm: async () => "", fileNote: async () => undefined as never, recordSkip: async () => undefined,
      post: async (v) => { posted.push(v.text); },
    });
    expect(summary.notices).toEqual(notices);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatch(/Clipping from Notion did not run/);
  });

  it("with no notice an empty scheduled digest stays silent, as before", async () => {
    const posted: string[] = [];
    await runDigest({
      agent: "a", mode: "scheduled", capturedAt: "2026-10-09", notices: [],
      listInbox: async () => [], alreadySkipped: async () => [], noteNames: async () => [], projects: async () => [],
      llm: async () => "", fileNote: async () => undefined as never, recordSkip: async () => undefined,
      post: async (v) => { posted.push(v.text); },
    });
    expect(posted).toHaveLength(0);
  });

  it("notices render beside a normal summary", () => {
    const view = renderDigest({
      filed: [{ title: "T", destination: "reads" }], asked: [], errors: [], notices: ["Clipping from Notion did not run: x."],
    });
    expect(view.text).toContain("Clipping from Notion did not run: x.");
    expect(view.report.sections.map((s) => s.label)).toContain("Notice");
  });
});

describe("wiring in the digest pass", () => {
  const src = readFileSync(join(here, "..", "agent", "schedules", "digest.ts"), "utf8");
  it("runs after the Karakeep pull and before the digest, and its notices reach the summary", () => {
    const karakeep = src.indexOf("await karakeepPass(log)");
    const clipping = src.indexOf("await clippingStep(log)");
    const digest = src.indexOf("await runDigest({");
    expect(karakeep).toBeGreaterThan(0);
    expect(clipping).toBeGreaterThan(karakeep);
    expect(digest).toBeGreaterThan(clipping);
    expect(src).toMatch(/runDigest\(\{\s+agent: AGENT,\s+mode,\s+notices,/);
  });
  it("never swallows a clipping failure the way the Karakeep catch does", () => {
    const body = src.slice(src.indexOf("async function clippingStep"), src.indexOf("export async function runDigestPass"));
    expect(body).toMatch(/return result\.notices/);
    expect(body).toMatch(/return \["Clipping from Notion could not be checked/);
  });
});

describe("no model call", () => {
  it("the clipping step never calls the gateway", async () => {
    const spy = vi.spyOn(llm, "gatewayComplete");
    fake.setPages([mkPage(1), mkPage(2, { url: null, title: "words" }), mkPage(3, { url: "https://example.com/p/1" })]);
    await run();
    fake.world.faults.push({ match: /data_sources/, status: 500 });
    await run();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("nothing under lib/clipping can reach a model", () => {
    const dir = join(here, "..", "lib", "clipping");
    for (const f of readdirSync(dir)) {
      expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(/llm-complete|gatewayComplete|gateway-provider|from "ai"/);
    }
  });
});

describe("the client", () => {
  it("is built with the pinned API version, a request timeout and bounded retries", async () => {
    fake.setPages([mkPage(1)]);
    const client = await makeNotionClient({ token: "t", fetch: fake.fetch as never });
    await client.dataSources.retrieve({ data_source_id: "ds-1" });
    expect(fake.world.requests[0]!.version).toBe("2026-03-11");
  });
});
