import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../lib/db", () => ({ pool: { query: mocks.query } }));
import {
  NOT_FINISHED, NOT_PICKED_UP, enqueueRequest, getClippingView, saveMapping, setChoice, toRequestView,
} from "../lib/clipping";

const NOW = new Date("2026-10-09T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;

const sourceRow = (over: Record<string, unknown> = {}) => ({
  id: "src-1", kind: "notion", data_source_id: "ds-1", url_property_id: "u1", note_property_id: null,
  tags_property_id: null, saved_property_id: null, import_since: ago(3600_000), outcome: "ok", outcome_detail: null,
  last_attempt_at: ago(MIN), last_success_at: ago(MIN), imported_total: 7, last_counts: { imported: 2, updated: 0 },
  created_at: ago(7200_000), ...over,
});
const schemaResult = {
  databaseId: "d", suggested: { titleId: "title", urlId: "u1" },
  dataSources: [{ id: "ds-1", name: "Clips", columns: [
    { id: "title", name: "Name", type: "title" }, { id: "u1", name: "Link", type: "url" },
    { id: "n1", name: "Note", type: "rich_text" }, { id: "t1", name: "Tags", type: "multi_select" },
    { id: "d1", name: "Saved", type: "date" }, { id: "x1", name: "Count", type: "number" },
  ] }],
};
const reqRow = (kind: string, over: Record<string, unknown> = {}) => ({
  id: `r-${kind}`, kind, params: {}, status: "done", outcome: "ok", outcome_detail: null, result: {},
  requested_by: "owner@example.test", created_at: ago(2 * MIN), claimed_at: ago(MIN), finished_at: ago(MIN), ...over,
});

/** Answers each read by its table; a test overrides one with a function that throws. */
function db(tables: { sources?: unknown[]; requests?: unknown[]; choice?: unknown[]; agents?: unknown[]; schema?: unknown } = {}) {
  mocks.query.mockImplementation(async (sql: string) => {
    if (/FROM clipping_sources/.test(sql)) return { rows: tables.sources ?? [], rowCount: (tables.sources ?? []).length };
    if (/DISTINCT ON \(kind\)/.test(sql)) return { rows: tables.requests ?? [] };
    if (/FROM clipping_choice/.test(sql)) return { rows: tables.choice ?? [] };
    if (/FROM agent_definitions/.test(sql)) return { rows: tables.agents ?? [{ name: "chief" }] };
    return { rows: [], rowCount: 0 };
  });
}
beforeEach(() => { vi.clearAllMocks(); db(); });

describe("getClippingView", () => {
  it("an installation with nothing set up: no source, no requests, no choice, one chief of staff", async () => {
    expect(await getClippingView(NOW)).toEqual({
      unavailable: false, source: null, sourceCount: 0, requests: {}, choice: null,
      chiefOfStaff: { kind: "one", name: "chief" }, busy: false,
    });
  });

  it("reads the source with its state, dates as text, and counts", async () => {
    db({ sources: [sourceRow()] });
    const v = await getClippingView(NOW);
    expect(v).toMatchObject({ unavailable: false, sourceCount: 1, source: {
      id: "src-1", dataSourceId: "ds-1", urlPropertyId: "u1", notePropertyId: null, outcome: "ok", importedTotal: 7,
      lastCounts: { imported: 2, updated: 0 }, lastSuccessAt: ago(MIN).toISOString(),
    } });
  });

  it("a state outcome the console does not know reads as no outcome, never as a made-up one", async () => {
    db({ sources: [sourceRow({ outcome: "exploded" })] });
    expect((await getClippingView(NOW) as { source: { outcome: unknown } }).source.outcome).toBeNull();
  });

  it("the latest request per kind, with its parsed result", async () => {
    db({ requests: [
      reqRow("schema", { result: schemaResult }),
      reqRow("test", { result: { wouldImport: 3, fromUrlColumn: 2, fromTitle: 1, withoutLink: 0, alreadyImported: 0, more: false } }),
      reqRow("import", { status: "failed", outcome: "refused", outcome_detail: "Notion refused the connection key.", result: {} }),
    ] });
    const v = await getClippingView(NOW);
    if (v.unavailable) throw new Error("unavailable");
    expect(v.requests.schema).toMatchObject({ status: "done", result: { databaseId: "d" } });
    expect(v.requests.test).toMatchObject({ status: "done", result: { wouldImport: 3 } });
    expect(v.requests.import).toMatchObject({ status: "failed", outcome: "refused", detail: "Notion refused the connection key.", result: null });
    expect(v.requests["add-properties"]).toBeUndefined();
    expect(v.busy).toBe(false);
  });

  it("a finished request whose result is not the shape expected has no result, not a half-read one", async () => {
    db({ requests: [reqRow("test", { result: { wouldImport: "many" } }), reqRow("schema", { result: { token: "x" } })] });
    const v = await getClippingView(NOW);
    if (v.unavailable) throw new Error("unavailable");
    expect(v.requests.test?.result).toBeNull();
    expect(v.requests.schema?.result).toBeNull();
  });

  it("pending or claimed (and recent) means busy: the card polls", async () => {
    db({ requests: [reqRow("test", { status: "pending", outcome: null, claimed_at: null, finished_at: null, created_at: ago(30_000) })] });
    expect((await getClippingView(NOW) as { busy: boolean }).busy).toBe(true);
    db({ requests: [reqRow("import", { status: "claimed", outcome: null, finished_at: null, claimed_at: ago(30_000) })] });
    expect((await getClippingView(NOW) as { busy: boolean }).busy).toBe(true);
  });

  it("a claim older than ten minutes is shown as not finished, and no longer polls", async () => {
    db({ requests: [reqRow("import", { status: "claimed", outcome: null, finished_at: null, claimed_at: ago(11 * MIN) })] });
    const v = await getClippingView(NOW);
    if (v.unavailable) throw new Error("unavailable");
    expect(v.requests.import).toMatchObject({ status: "unavailable", detail: NOT_FINISHED });
    expect(NOT_FINISHED).toBe("The chief of staff did not finish this.");
    expect(v.busy).toBe(false);
  });

  it("a pending request older than ten minutes is shown as not picked up", async () => {
    db({ requests: [reqRow("schema", { status: "pending", outcome: null, claimed_at: null, finished_at: null, created_at: ago(11 * MIN) })] });
    const v = await getClippingView(NOW);
    if (v.unavailable) throw new Error("unavailable");
    expect(v.requests.schema).toMatchObject({ status: "unavailable", detail: NOT_PICKED_UP });
    expect(NOT_PICKED_UP).toBe("The chief of staff did not pick this up.");
    expect(v.busy).toBe(false);
  });

  it("exactly ten minutes is still waiting; a finished request is never turned into unavailable by age", () => {
    expect(toRequestView(reqRow("import", { status: "claimed", claimed_at: ago(10 * MIN), finished_at: null }), NOW).status).toBe("claimed");
    expect(toRequestView(reqRow("import", { created_at: ago(99 * MIN) }), NOW).status).toBe("done");
    expect(toRequestView(reqRow("import", { status: "failed", outcome: "timeout", created_at: ago(99 * MIN) }), NOW).status).toBe("failed");
  });

  it("the source choice", async () => {
    db({ choice: [{ mode: "both", set_by: "owner@example.test", set_at: ago(MIN) }] });
    expect(await getClippingView(NOW)).toMatchObject({ choice: { mode: "both", setBy: "owner@example.test", setAt: ago(MIN).toISOString() } });
  });

  it.each([
    [0, { kind: "none" }],
    [2, { kind: "several" }],
  ])("%i chiefs of staff -> %j (no guessing which one)", async (n, expected) => {
    db({ agents: Array.from({ length: n }, (_, i) => ({ name: `chief-${i}` })) });
    expect(await getClippingView(NOW)).toMatchObject({ chiefOfStaff: expected });
  });

  it("looks for the chief of staff by role among agents that are not retired", async () => {
    await getClippingView(NOW);
    const sql = mocks.query.mock.calls.map((c) => c[0] as string).find((s) => /agent_definitions/.test(s))!;
    expect(sql).toMatch(/definition->>'role' = 'chief-of-staff'/);
    expect(sql).toMatch(/status <> 'retired'/);
  });

  it.each(["clipping_sources", "DISTINCT ON", "clipping_choice", "agent_definitions"])(
    "ANY failed read (%s) is unavailable, never an empty view", async (which) => {
      const ok = mocks.query.getMockImplementation()!;
      mocks.query.mockImplementation(async (sql: string, p?: unknown[]) => {
        if (sql.includes(which)) throw new Error("relation missing");
        return ok(sql, p);
      });
      expect(await getClippingView(NOW)).toEqual({ unavailable: true });
    });
});

describe("enqueueRequest", () => {
  it("writes the kind, params and who asked, and says busy when one of that kind is already waiting", async () => {
    mocks.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    expect(await enqueueRequest("schema", { link: "https://x.example/db" }, "owner@example.test")).toEqual({ ok: true });
    const [sql, params] = mocks.query.mock.calls[0]!;
    expect(sql).toMatch(/INSERT INTO clipping_requests/);
    expect(sql).toMatch(/NOT EXISTS/);
    expect(params.slice(0, 3)).toEqual(["schema", JSON.stringify({ link: "https://x.example/db" }), "owner@example.test"]);
    mocks.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    expect(await enqueueRequest("schema", {}, "owner@example.test")).toEqual({ ok: false, code: "busy" });
  });

  it("a failed write is unavailable, not success", async () => {
    mocks.query.mockRejectedValueOnce(new Error("down"));
    expect(await enqueueRequest("test", {}, "owner@example.test")).toEqual({ ok: false, code: "unavailable" });
  });
});

describe("saveMapping", () => {
  const writes = () => mocks.query.mock.calls.filter((c) => /^\s*(INSERT|UPDATE)/.test(c[0] as string));
  function dbFor(o: { schema?: unknown; existing?: unknown[]; inserted?: number }) {
    mocks.query.mockImplementation(async (sql: string) => {
      if (/FROM clipping_requests WHERE kind = 'schema'/.test(sql)) return { rows: o.schema === undefined ? [{ result: schemaResult }] : o.schema ? [{ result: o.schema }] : [] };
      if (/SELECT id, data_source_id FROM clipping_sources/.test(sql)) return { rows: o.existing ?? [] };
      if (/INSERT INTO clipping_sources/.test(sql)) return { rowCount: o.inserted ?? 1, rows: [] };
      return { rowCount: 1, rows: [] };
    });
  }

  it("a first save inserts the one shared organisation source, with every ownership column explicit", async () => {
    dbFor({});
    expect(await saveMapping({ dataSourceId: "ds-1", urlPropertyId: "u1", notePropertyId: "n1", tagsPropertyId: "t1", savedPropertyId: "d1" })).toEqual({ ok: true });
    const [sql, params] = writes()[0]!;
    expect(sql).toMatch(/INSERT INTO clipping_sources/);
    expect(sql).toMatch(/'notion:shared', 'organisation', 'shared', now\(\)/);
    expect(params).toEqual(["ds-1", "u1", "n1", "t1", "d1"]);
  });

  it("only the url column is needed; the others are stored as null", async () => {
    dbFor({});
    await saveMapping({ dataSourceId: "ds-1", urlPropertyId: "u1" });
    expect(writes()[0]![1]).toEqual(["ds-1", "u1", null, null, null]);
  });

  it("same data source, new columns: columns change, watermark and start point stay", async () => {
    dbFor({ existing: [{ id: "src-1", data_source_id: "ds-1" }] });
    expect(await saveMapping({ dataSourceId: "ds-1", urlPropertyId: "u1", notePropertyId: "n1" })).toEqual({ ok: true });
    const [sql, params] = writes()[0]!;
    expect(sql).toMatch(/UPDATE clipping_sources SET url_property_id/);
    expect(sql).not.toMatch(/watermark|import_since/);
    expect(params).toEqual(["src-1", "u1", "n1", null, null]);
  });

  it("a changed data source resets the watermark, the start point and the old source's state", async () => {
    dbFor({
      existing: [{ id: "src-1", data_source_id: "ds-OLD" }],
      schema: { ...schemaResult, dataSources: [{ ...schemaResult.dataSources[0], id: "ds-1" }] },
    });
    expect(await saveMapping({ dataSourceId: "ds-1", urlPropertyId: "u1" })).toEqual({ ok: true });
    const [sql, params] = writes()[0]!;
    expect(sql).toMatch(/watermark = NULL, watermark_capped = false/);
    expect(sql).toMatch(/import_since = now\(\)/);
    expect(sql).toMatch(/outcome = NULL/);
    expect(sql).not.toMatch(/imported_total/); // the cumulative count of clips brought in is history
    expect(params).toEqual(["src-1", "ds-1", "u1", null, null, null]);
  });

  it("refuses a second Notion source: more than one row exists, or another save won the race", async () => {
    dbFor({ existing: [{ id: "a", data_source_id: "ds-1" }, { id: "b", data_source_id: "ds-2" }] });
    expect(await saveMapping({ dataSourceId: "ds-1", urlPropertyId: "u1" })).toEqual({ ok: false, code: "more-than-one-source" });
    expect(writes()).toHaveLength(0);
    dbFor({ inserted: 0 });
    expect(await saveMapping({ dataSourceId: "ds-1", urlPropertyId: "u1" })).toEqual({ ok: false, code: "more-than-one-source" });
  });

  it.each([
    ["no schema answer yet", { schema: null }, { dataSourceId: "ds-1", urlPropertyId: "u1" }, "no-schema"],
    ["a schema answer in the wrong shape", { schema: { nope: 1 } }, { dataSourceId: "ds-1", urlPropertyId: "u1" }, "no-schema"],
    ["a data source the schema answer did not list", {}, { dataSourceId: "ds-ELSE", urlPropertyId: "u1" }, "mapping-mismatch"],
    ["a url column that is not in the data source", {}, { dataSourceId: "ds-1", urlPropertyId: "nope" }, "mapping-mismatch"],
    ["a url column that is not a url column", {}, { dataSourceId: "ds-1", urlPropertyId: "n1" }, "mapping-mismatch"],
    ["a note column that is not text", {}, { dataSourceId: "ds-1", urlPropertyId: "u1", notePropertyId: "x1" }, "mapping-mismatch"],
    ["a tags column that is not a select", {}, { dataSourceId: "ds-1", urlPropertyId: "u1", tagsPropertyId: "n1" }, "mapping-mismatch"],
    ["a saved-at column that is not a date", {}, { dataSourceId: "ds-1", urlPropertyId: "u1", savedPropertyId: "n1" }, "mapping-mismatch"],
  ])("refuses %s and writes nothing", async (_n, db0, input, code) => {
    dbFor(db0 as never);
    expect(await saveMapping(input)).toEqual({ ok: false, code });
    expect(writes()).toHaveLength(0);
  });

  it("accepts a select or a multi-select for tags, and a date or a created-time for saved-at", async () => {
    const schema = { ...schemaResult, dataSources: [{ ...schemaResult.dataSources[0], columns: [
      ...schemaResult.dataSources[0]!.columns, { id: "s1", name: "Kind", type: "select" }, { id: "c1", name: "Created", type: "created_time" },
    ] }] };
    dbFor({ schema });
    expect(await saveMapping({ dataSourceId: "ds-1", urlPropertyId: "u1", tagsPropertyId: "s1", savedPropertyId: "c1" })).toEqual({ ok: true });
  });

  it("a failed read or write is unavailable", async () => {
    mocks.query.mockRejectedValue(new Error("down"));
    expect(await saveMapping({ dataSourceId: "ds-1", urlPropertyId: "u1" })).toEqual({ ok: false, code: "unavailable" });
  });
});

describe("setChoice", () => {
  it("upserts the one row with who chose", async () => {
    mocks.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    expect(await setChoice("both", "owner@example.test")).toEqual({ ok: true });
    const [sql, params] = mocks.query.mock.calls[0]!;
    expect(sql).toMatch(/ON CONFLICT \(id\) DO UPDATE/);
    expect(params).toEqual(["both", "owner@example.test"]);
  });
  it("a failed write is unavailable", async () => {
    mocks.query.mockRejectedValueOnce(new Error("down"));
    expect(await setChoice("notion", "owner@example.test")).toEqual({ ok: false, code: "unavailable" });
  });
});
