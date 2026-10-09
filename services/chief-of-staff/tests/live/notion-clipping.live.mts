/**
 * tests/live/notion-clipping.live.mts — the LIVE check for Notion saved-link import (LAR-113).
 *
 * NOT part of `pnpm test`. Run by hand, by the owner, once before the import is trusted, and again
 * whenever the pinned Notion API version (lib/clipping/notion-reader.ts) or the SDK changes.
 * A fixture is what we believe Notion does; this is what it does. It is READ-ONLY: it never writes
 * to Notion, the vault or the database. It prints names, types, counts and PASS/FAIL lines, never
 * the content of a saved link.
 *
 * USAGE (from the repository root, with the clipping database shared with your Lares connection):
 *
 *   NOTION_TOKEN=<the connection's key> \
 *   NOTION_CLIPPING_DATABASE_ID=<the database id or the id at the end of its Notion link> \
 *   pnpm -C services/chief-of-staff exec tsx tests/live/notion-clipping.live.mts
 *
 * Both values come from the environment only; the probe reads no file and the key is never
 * printed or stored. Optional, to cover more shapes:
 *
 *   NOTION_CLIPPING_DATA_SOURCE_ID    when the database has more than one data source
 *   NOTION_CLIPPING_TRASHED_PAGE_ID   a row you moved to the trash from this database (id of the
 *                                     page; open it from Notion's trash to copy the link)
 *
 * BEFORE YOU RUN IT, to answer "does Notion's own clipper fill a URL column?": save one link into
 * the database from your phone's share sheet or the browser clipper, the way you really will. The
 * probe lists, for the newest rows, which columns are filled (yes/no only) and their types.
 *
 * What it checks, in order (each is a shape the import code branches on):
 *   1. the key works and belongs to the workspace (users.me)
 *   2. databases.retrieve lists the data sources; dataSources.retrieve lists the columns with
 *      their ids and types, and whether a URL-typed column exists
 *   3. dataSources.query with a last-edited-time filter and ascending sort, page_size 1: paging
 *      (has_more, next_cursor), request_status, and the fields read from each page
 *   4. a filter that matches nothing: an empty, complete answer, not an error
 *   5. a row with an empty URL cell, if one exists
 *   6. a trashed row: omitted from the query, in_trash true on retrieve, no `archived` needed
 *   7. 404 on an id that is not shared (wrong database id), 401 on a bad key, 400 on a wrong
 *      column in the filter: each mapped to the same outcome the import reports
 *   8. 429 handling and timeout: Notion cannot be made to rate-limit or hang on demand, so these two
 *      run the PRODUCTION client settings against a local stub and check the wait and the bound
 *      (they take up to about 20 s and 15 s)
 */
import { Client } from "@notionhq/client";

import {
  NOTION_API_VERSION, RETRY, REQUEST_TIMEOUT_MS, checkSchema, classifyNotionError, makeNotionClient,
  queryChangedPages, ClippingFailure,
} from "../../lib/clipping/notion-reader.js";
import { mapPageToClip, type ClipSource } from "../../lib/clipping/record.js";

const token = process.env["NOTION_TOKEN"];
const databaseId = process.env["NOTION_CLIPPING_DATABASE_ID"];
if (!token || !databaseId) {
  console.error("set NOTION_TOKEN and NOTION_CLIPPING_DATABASE_ID in the environment (see the header)");
  process.exit(2);
}

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` -> ${detail}` : ""}`);
}
const info = (m: string) => console.log(`INFO ${m}`);
const skip = (m: string) => console.log(`SKIP ${m}`);

type Props = Record<string, { id?: string; type?: string; [k: string]: unknown }>;
const idOf = (raw: string): string => raw.replace(/-/g, "").match(/[0-9a-f]{32}/i)?.[0] ?? raw;

info(`API version pinned: ${NOTION_API_VERSION}; request timeout ${REQUEST_TIMEOUT_MS} ms; retries ${JSON.stringify(RETRY)}`);
const client = await makeNotionClient({ token });

// 1. the key
try {
  const me = (await client.users.me({})) as { type?: string; bot?: { owner?: { type?: string } } };
  check("users.me is a bot owned by the workspace", me.type === "bot" && me.bot?.owner?.type === "workspace", `type=${me.type} owner=${me.bot?.owner?.type}`);
} catch (e) {
  check("users.me answers", false, classifyNotionError(e).outcome);
}

// 2. database -> data sources -> columns
let dataSourceId = process.env["NOTION_CLIPPING_DATA_SOURCE_ID"] ?? "";
try {
  const db = (await client.databases.retrieve({ database_id: idOf(databaseId) })) as { data_sources?: { id: string }[] };
  const list = db.data_sources ?? [];
  check("databases.retrieve lists data_sources[] with ids", list.length > 0 && list.every((d) => typeof d.id === "string"), `${list.length} data source(s)`);
  if (list.length > 1) info("more than one data source: set NOTION_CLIPPING_DATA_SOURCE_ID (the import refuses to guess)");
  if (!dataSourceId) dataSourceId = list[0]?.id ?? "";
} catch (e) {
  check("databases.retrieve answers", false, classifyNotionError(e).outcome);
}
if (!dataSourceId) {
  console.log("\nNo data source to read; stopping here.");
  process.exit(1);
}

let props: Props = {};
try {
  const ds = (await client.dataSources.retrieve({ data_source_id: dataSourceId })) as { properties?: Props };
  props = ds.properties ?? {};
  const rows = Object.entries(props).map(([name, p]) => `${name} [${p.id}] ${p.type}`);
  check("dataSources.retrieve returns a column map with ids and types", rows.length > 0 && Object.values(props).every((p) => p.id && p.type));
  info(`columns:\n  ${rows.join("\n  ")}`);
  const urlCols = Object.entries(props).filter(([, p]) => p.type === "url").map(([n]) => n);
  check("a URL-typed column exists", urlCols.length > 0, urlCols.join(", ") || "none: the import would fall back to a link in the title");
  const titleCols = Object.values(props).filter((p) => p.type === "title").length;
  check("exactly one title column", titleCols === 1, String(titleCols));
} catch (e) {
  check("dataSources.retrieve answers", false, classifyNotionError(e).outcome);
}

// What the import would map, by property id (pre-selecting the only URL column, or URL/Link).
const urlEntries = Object.entries(props).filter(([, p]) => p.type === "url");
const urlPick = urlEntries.find(([n]) => /^(url|link)$/i.test(n)) ?? (urlEntries.length === 1 ? urlEntries[0] : undefined);
const source: ClipSource = {
  id: "probe", kind: "notion", dataSourceId,
  urlPropertyId: urlPick?.[1].id ?? "", notePropertyId: null, tagsPropertyId: null, savedPropertyId: null,
  owner: "organisation", visibility: "shared",
};
if (urlPick) {
  try { check("checkSchema accepts the live column map", checkSchema({ properties: props }, source).warnings.length === 0); }
  catch (e) { check("checkSchema accepts the live column map", false, (e as ClippingFailure).outcome); }
}

// 3. query: filter, sort, paging, request_status, page fields
type Page = { object?: string; id?: string; created_time?: string; last_edited_time?: string; in_trash?: boolean; archived?: boolean; properties?: Props };
const baseQuery = {
  data_source_id: dataSourceId,
  sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
  filter: { timestamp: "last_edited_time", last_edited_time: { on_or_after: "2000-01-01T00:00:00.000Z" } },
};
let firstPage: Page | undefined;
try {
  const r1 = (await client.dataSources.query({ ...baseQuery, page_size: 1 } as never)) as {
    results: Page[]; has_more: boolean; next_cursor: string | null; request_status?: { type?: string; incomplete_reason?: string };
  };
  firstPage = r1.results[0];
  check("query returns a list of pages", r1.results.length <= 1 && r1.results.every((p) => p.object === "page"));
  check("request_status is present and says complete", r1.request_status?.type === "complete", JSON.stringify(r1.request_status ?? null));
  if (r1.has_more) {
    check("page_size 1 with more rows gives has_more true and a next_cursor", typeof r1.next_cursor === "string");
    const r2 = (await client.dataSources.query({ ...baseQuery, page_size: 1, start_cursor: r1.next_cursor as string } as never)) as { results: Page[]; has_more: boolean };
    check("the cursor returns a different row", r2.results[0]?.id !== r1.results[0]?.id);
  } else {
    skip("only one row in the database: add a second row to check paging (has_more / next_cursor)");
  }
  if (firstPage) {
    check("a page has id, created_time, last_edited_time", !!firstPage.id && !!firstPage.created_time && !!firstPage.last_edited_time);
    check("a page has a boolean in_trash (API version 2026-03-11)", typeof firstPage.in_trash === "boolean", `in_trash=${String(firstPage.in_trash)} archived=${String(firstPage.archived)}`);
    const sec = firstPage.last_edited_time?.slice(17, 19);
    info(`last_edited_time granularity: seconds field is "${sec}" (00 would mean Notion rounds to the minute)`);
    const t = Object.values(firstPage.properties ?? {}).find((p) => p.type === "title") as { title?: { plain_text?: string }[] } | undefined;
    check("the title is rich text with plain_text", Array.isArray(t?.title));
    if (urlPick) {
      const u = Object.values(firstPage.properties ?? {}).find((p) => p.id === source.urlPropertyId) as { type?: string; url?: string | null } | undefined;
      check("the URL cell is { type: 'url', url: string | null }", u?.type === "url" && (typeof u.url === "string" || u.url === null));
    }
  } else {
    skip("the database has no rows: save one link and run again");
  }
} catch (e) {
  check("query answers", false, classifyNotionError(e).outcome);
}

// The import's own reader over the live data: pages, mapping, skip counts.
try {
  const { pages, capped } = await queryChangedPages(client, source, null, { maxPages: 2, pageSize: 25 });
  const mapped = pages.map((p) => mapPageToClip(p as never, source));
  const clips = mapped.filter((m) => m.kind === "clip").length;
  const noLink = mapped.filter((m) => m.kind === "skip").length;
  check("queryChangedPages + mapPageToClip run over live rows", true, `${pages.length} row(s), ${clips} would import, ${noLink} without a link, capped=${capped}`);
  if (noLink === 0) skip("no row with an empty URL (and a title that is not a link): add one to see the skip path");
} catch (e) {
  check("queryChangedPages runs over live rows", false, (e as ClippingFailure).outcome ?? String(e));
}

// What the clipper filled, newest rows first (yes/no only, never content).
try {
  const recent = (await client.dataSources.query({
    data_source_id: dataSourceId, page_size: 5,
    sorts: [{ timestamp: "created_time", direction: "descending" }],
  } as never)) as { results: Page[] };
  info(`newest ${recent.results.length} row(s): which columns the clipper filled`);
  for (const p of recent.results) {
    const cells = Object.entries(p.properties ?? {}).map(([name, v]) => {
      const x = v as Record<string, unknown>;
      const val = x[String(v.type)];
      const filled = Array.isArray(val) ? val.length > 0 : val !== null && val !== undefined && val !== "";
      return `${name}(${v.type})=${filled ? "filled" : "empty"}`;
    });
    info(`  created ${p.created_time}: ${cells.join(", ")}`);
  }
} catch (e) {
  info(`could not list the newest rows: ${classifyNotionError(e).outcome}`);
}

// 4. a filter matching nothing
try {
  const none = (await client.dataSources.query({
    data_source_id: dataSourceId, page_size: 5,
    filter: { timestamp: "last_edited_time", last_edited_time: { on_or_after: "2999-01-01T00:00:00.000Z" } },
  } as never)) as { results: unknown[]; has_more: boolean; request_status?: { type?: string } };
  check("a filter that matches nothing is an empty, complete answer", none.results.length === 0 && none.has_more === false && none.request_status?.type !== "incomplete");
} catch (e) {
  check("empty filter answers", false, classifyNotionError(e).outcome);
}

// 6. trashed
const trashedId = process.env["NOTION_CLIPPING_TRASHED_PAGE_ID"];
if (trashedId) {
  try {
    const q = (await client.dataSources.query({ ...baseQuery, page_size: 100 } as never)) as { results: Page[] };
    const listed = q.results.some((p) => idOf(p.id ?? "") === idOf(trashedId));
    check("the default query omits a trashed row", !listed, listed ? "it IS returned: the import then relies on in_trash" : "omitted");
    const page = (await client.pages.retrieve({ page_id: idOf(trashedId) })) as Page;
    check("pages.retrieve on a trashed row shows in_trash true", page.in_trash === true, `in_trash=${String(page.in_trash)} archived=${String(page.archived)}`);
  } catch (e) {
    const f = classifyNotionError(e);
    check("pages.retrieve on a trashed row answers", false, f.outcome);
  }
} else {
  skip("set NOTION_CLIPPING_TRASHED_PAGE_ID to a row you moved to the trash, to check the trash shapes");
}

// 7. errors
try {
  await client.dataSources.retrieve({ data_source_id: "00000000-0000-4000-8000-000000000000" });
  check("an id that is not shared is refused with 404", false, "it answered");
} catch (e) {
  const f = classifyNotionError(e);
  check("an id that is not shared maps to not-shared (404 object_not_found)", f.outcome === "not-shared", f.outcome);
}
try {
  const bad = new Client({ auth: "ntn_invalid_key_for_probe", notionVersion: NOTION_API_VERSION, retry: false, logger: () => {} });
  await bad.users.me({});
  check("a bad key is refused with 401", false, "it answered");
} catch (e) {
  const f = classifyNotionError(e);
  check("a bad key maps to refused (401 unauthorized)", f.outcome === "refused", f.outcome);
}
try {
  await client.dataSources.query({
    data_source_id: dataSourceId, page_size: 1,
    filter: { property: "no such column for the probe", url: { is_not_empty: true } },
  } as never);
  check("a filter on a missing column is a 400", false, "it answered");
} catch (e) {
  const f = classifyNotionError(e);
  check("a filter on a missing column maps to schema-mismatch (400 validation_error)", f.outcome === "schema-mismatch", f.outcome);
}

// 8. 429 and timeout, against a local stub, with the production client settings
{
  let calls = 0;
  const stub429 = async () => {
    calls++;
    return new Response(JSON.stringify({ object: "error", status: 429, code: "rate_limited", message: "x" }), {
      status: 429, headers: { "content-type": "application/json", "retry-after": "30" },
    });
  };
  const c = await makeNotionClient({ token, fetch: stub429 as never });
  const t0 = Date.now();
  try { await c.users.me({}); check("429 ends in a failure", false, "it answered"); }
  catch (e) {
    const ms = Date.now() - t0;
    const f = classifyNotionError(e);
    check("429 beyond the retries maps to rate-limited", f.outcome === "rate-limited", f.outcome);
    check("429: 1 request plus at most the configured retries", calls === 1 + RETRY.maxRetries, `${calls} request(s)`);
    check("429: a Retry-After of 30 s is capped, not slept", ms <= RETRY.maxRetries * RETRY.maxRetryDelayMs + 2_000, `${ms} ms`);
  }
}
{
  const stubHang = () => new Promise<never>(() => undefined);
  const c = await makeNotionClient({ token, fetch: stubHang as never });
  const t0 = Date.now();
  try { await c.users.me({}); check("a hung request ends in a failure", false, "it answered"); }
  catch (e) {
    const ms = Date.now() - t0;
    const f = classifyNotionError(e);
    check("a request that never answers maps to timeout", f.outcome === "timeout", f.outcome);
    check("timeout: bounded by the request timeout", ms <= REQUEST_TIMEOUT_MS + 2_000, `${ms} ms`);
  }
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
