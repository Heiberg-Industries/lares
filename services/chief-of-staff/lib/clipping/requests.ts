/**
 * The clipping request queue (LAR-113 child b): what the console's Clipping card asks the chief
 * of staff to do, because only the chief of staff holds the Notion key.
 *
 * Four kinds, each answered into `clipping_requests` (box/sql/092_clipping_requests.sql):
 *   schema          read a pasted database: its data sources and their columns, with a suggestion
 *   test            try the saved (or proposed) mapping on one page of rows; writes nothing
 *   import          run one clipping pass now (the same code the digest runs)
 *   add-properties  add only the missing Status, For and Origin columns; never change an existing one
 *
 * Same discipline as the digest's step: every failure keeps its own outcome and a one-line owner
 * sentence (never a vendor body, never a token), a request is never left "claimed" for ever, and
 * nothing here calls a model. `result` holds names, ids and counts only.
 */
import {
  ClippingFailure, OVERLAP_MS, PAGE_SIZE, STEP_BUDGET_MS, classifyNotionError, parseDatabaseRef,
  queryChangedPages, readSchema, withBudget, type ClippingOutcome, type NotionLike,
} from "./notion-reader.js";
import { linkOrigin, mapPageToClip, type ClipSource } from "./record.js";
import { clippingPass, type ClippingStepDeps } from "./step.js";
import {
  findDuplicate, getItem, loadNotionSources, readClippingChoice, type Queryable,
} from "./store.js";

export type RequestKind = "schema" | "test" | "import" | "add-properties";

export interface ClippingRequest {
  id: string;
  kind: RequestKind;
  params: Record<string, unknown>;
}

/** A claimed request that nobody finished is failed after this long, so it never spins for ever. */
export const CLAIM_STALE_MS = 10 * 60_000;
/** Requests answered per tick. */
export const MAX_PER_TICK = 3;
/** Data sources read per database (a database has one today; this is a bound, not a promise). */
const MAX_DATA_SOURCES = 10;

export interface RequestOutcome {
  status: "done" | "failed";
  outcome: ClippingOutcome;
  detail: string | null;
  result: Record<string, unknown>;
}

// --- the queue -------------------------------------------------------------------------------

/** Fail claims whose worker is gone (a restart mid-request). Returns how many. */
export async function failStaleClaims(db: Queryable, olderThanMs = CLAIM_STALE_MS): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE clipping_requests
        SET status = 'failed', outcome = 'unavailable', finished_at = now(),
            outcome_detail = 'The chief of staff stopped before finishing this request.'
      WHERE status = 'claimed' AND claimed_at < now() - make_interval(secs => $1)`,
    [olderThanMs / 1000],
  );
  return rowCount ?? 0;
}

/** Take the oldest pending request. Two workers never get the same one. */
export async function claimRequest(db: Queryable): Promise<ClippingRequest | null> {
  const { rows } = await db.query(
    `UPDATE clipping_requests SET status = 'claimed', claimed_at = now()
      WHERE id = (SELECT id FROM clipping_requests WHERE status = 'pending'
                   ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, kind, params`,
  );
  const r = rows[0] as { id: string; kind: RequestKind; params: unknown } | undefined;
  if (!r) return null;
  const params = r.params && typeof r.params === "object" && !Array.isArray(r.params)
    ? (r.params as Record<string, unknown>) : {};
  return { id: r.id, kind: r.kind, params };
}

export async function finishRequest(db: Queryable, id: string, o: RequestOutcome): Promise<void> {
  await db.query(
    `UPDATE clipping_requests
        SET status = $2, outcome = $3, outcome_detail = $4, result = $5::jsonb, finished_at = now()
      WHERE id = $1`,
    [id, o.status, o.outcome, o.detail === null ? null : o.detail.slice(0, 400), JSON.stringify(o.result)],
  );
}

// --- helpers ---------------------------------------------------------------------------------

const str = (v: unknown, max = 2048): string | null =>
  typeof v === "string" && v.trim() !== "" && v.length <= max ? v.trim() : null;

interface RawProp { id?: string; name?: string; type?: string }

function propsOf(dataSource: unknown): [string, RawProp][] {
  const props = (dataSource as { properties?: Record<string, RawProp> } | null)?.properties;
  if (!props || typeof props !== "object") {
    throw new ClippingFailure(
      "schema-mismatch", "Notion did not describe the database's columns.",
      "Try again; if it keeps happening, check the database is shared with your Lares connection.",
    );
  }
  return Object.entries(props).filter(([, p]) => p && typeof p === "object" && typeof p.id === "string" && typeof p.type === "string");
}

const NO_KEY = new ClippingFailure(
  "not-configured", "The chief of staff has no Notion key yet.",
  "Add the Notion key and switch clipping on first.",
);

function keyFor(deps: ClippingStepDeps): string {
  const key = deps.token();
  if (key.kind === "none") throw NO_KEY;
  if (key.kind === "unreadable") {
    throw new ClippingFailure(
      "key-unreadable", "The Notion key is delivered but cannot be read.",
      "Check the Notion key on the Integrations page and apply it again.",
    );
  }
  return key.token;
}

// --- schema ----------------------------------------------------------------------------------

async function runSchema(client: NotionLike, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const link = str(params["link"]);
  const databaseId = link ? parseDatabaseRef(link) : null;
  if (!databaseId) {
    throw new ClippingFailure(
      "schema-mismatch", "That is not a Notion database link or id.",
      "Paste the database's link from Notion (Share, then Copy link), or its 32-character id.",
    );
  }
  let database: unknown;
  try { database = await client.databases.retrieve({ database_id: databaseId }); }
  catch (e) { throw classifyNotionError(e); }
  const listed = ((database as { data_sources?: { id?: unknown; name?: unknown }[] } | null)?.data_sources ?? [])
    .filter((d) => typeof d?.id === "string").slice(0, MAX_DATA_SOURCES);
  if (listed.length === 0) {
    throw new ClippingFailure(
      "schema-mismatch", "Notion listed no data in that database.",
      "Check the link points at a database, not a page.",
    );
  }
  const dataSources: { id: string; name: string; columns: { id: string; name: string; type: string }[] }[] = [];
  for (const d of listed) {
    let ds: unknown;
    try { ds = await client.dataSources.retrieve({ data_source_id: d.id as string }); }
    catch (e) { throw classifyNotionError(e); }
    dataSources.push({
      id: d.id as string,
      name: typeof d.name === "string" && d.name ? d.name : "Untitled",
      columns: propsOf(ds).map(([key, p]) => ({ id: p.id!, name: p.name || key, type: p.type! })),
    });
  }
  const first = dataSources[0]!.columns;
  const urls = first.filter((c) => c.type === "url");
  const urlPick = urls.length === 1 ? urls[0] : urls.find((c) => /^(url|link)$/i.test(c.name));
  return {
    databaseId,
    dataSources,
    suggested: { titleId: first.find((c) => c.type === "title")?.id ?? null, urlId: urlPick?.id ?? null },
  };
}

// --- test ------------------------------------------------------------------------------------

function mappingFromParams(params: Record<string, unknown>): ClipSource | null {
  const dataSourceId = str(params["dataSourceId"]);
  const urlPropertyId = str(params["urlPropertyId"]);
  if (!dataSourceId || !urlPropertyId) return null;
  return {
    id: "test", kind: "notion", dataSourceId, urlPropertyId,
    notePropertyId: str(params["notePropertyId"]), tagsPropertyId: str(params["tagsPropertyId"]),
    savedPropertyId: str(params["savedPropertyId"]),
    owner: "organisation", visibility: "shared",
  };
}

async function runTest(
  deps: ClippingStepDeps, client: NotionLike, params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const saved = (await loadNotionSources(deps.db))[0] ?? null;
  const proposed = mappingFromParams(params);
  const source: ClipSource | null = proposed ?? saved;
  if (!source) {
    throw new ClippingFailure(
      "not-configured", "No clipping source is saved yet.",
      "Read a database and save its columns first.",
    );
  }
  // The ledger and the start point belong to the SAVED source, and only when it is the same data source.
  const ledger = saved && saved.dataSourceId === source.dataSourceId ? saved : null;
  const since = ledger?.watermark
    ? new Date(ledger.watermark.getTime() - (ledger.watermarkCapped ? 0 : OVERLAP_MS))
    : ledger?.importSince ?? new Date();

  const { warnings } = await readSchema(client, source);
  const { pages, capped } = await queryChangedPages(client, source, since, { maxPages: 1, pageSize: PAGE_SIZE });

  let wouldImport = 0, fromUrlColumn = 0, fromTitle = 0, withoutLink = 0, alreadyImported = 0;
  for (const page of pages) {
    const mapped = mapPageToClip(page as never, source);
    if (mapped.kind === "trashed") continue;
    if (mapped.kind === "skip") { withoutLink++; continue; }
    const { clip } = mapped;
    const existing = ledger ? await getItem(deps.db, ledger.id, clip.sourceItemId) : null;
    const known = existing?.state === "imported" || existing?.state === "filed-unknown";
    const dup = !known && await findDuplicate(deps.db, {
      owner: clip.owner, visibility: clip.visibility, urlKey: clip.urlKey,
      sourceId: ledger?.id ?? source.id, sourceItemId: clip.sourceItemId,
    });
    if (known || dup) { alreadyImported++; continue; }
    wouldImport++;
    if (linkOrigin(page as never, source) === "column") fromUrlColumn++; else fromTitle++;
  }
  return { wouldImport, fromUrlColumn, fromTitle, withoutLink, alreadyImported, more: capped, warnings,
    recent: await recentLinkOrigins(client, source) };
}

/** Test also needs to say which column the clipper fills even when nothing is newer than the start
 *  point (a mapping saved a minute ago): look at the most recently edited rows, whatever their age. */
const RECENT_SAMPLE = 20;
async function recentLinkOrigins(
  client: NotionLike, source: ClipSource,
): Promise<{ checked: number; fromUrlColumn: number; fromTitle: number; withoutLink: number }> {
  let res: { results?: unknown[] };
  try {
    res = (await client.dataSources.query({
      data_source_id: source.dataSourceId, page_size: RECENT_SAMPLE,
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    })) as typeof res;
  } catch (e) {
    throw classifyNotionError(e);
  }
  const recent = { checked: 0, fromUrlColumn: 0, fromTitle: 0, withoutLink: 0 };
  for (const page of res.results ?? []) {
    if ((page as { object?: string })?.object !== "page") continue;
    const mapped = mapPageToClip(page as never, source);
    if (mapped.kind === "trashed") continue;
    recent.checked++;
    if (mapped.kind === "skip") recent.withoutLink++;
    else if (linkOrigin(page as never, source) === "column") recent.fromUrlColumn++;
    else recent.fromTitle++;
  }
  return recent;
}

// --- import ----------------------------------------------------------------------------------

async function runImport(deps: ClippingStepDeps): Promise<RequestOutcome> {
  if ((await readClippingChoice(deps.db)) === "karakeep") {
    throw new ClippingFailure(
      "not-configured", "Clipping is set to Karakeep only, so Notion was not read.",
      "Change the source to Notion or Both, then import.",
    );
  }
  const r = await clippingPass(deps);
  if (r.outcome === "ok") {
    return { status: "done", outcome: "ok", detail: r.detail, result: { imported: r.imported, ...(r.counts ?? {}) } };
  }
  return { status: "failed", outcome: r.outcome, detail: r.detail, result: {} };
}

// --- add properties --------------------------------------------------------------------------

const WANTED = [
  { name: "Status", type: "select", def: { select: {} } },
  { name: "For", type: "multi_select", def: { multi_select: {} } },
  { name: "Origin", type: "select", def: { select: { options: [{ name: "Owner" }, { name: "Lares" }] } } },
] as const;

export interface AddPropertiesResult {
  added: string[];
  present: string[];
  conflicts: { name: string; found: string; wanted: string }[];
}

/**
 * Add only the Status, For and Origin columns that are missing. A same-named column of another
 * type is reported and left alone. With nothing to add, nothing is written. Exported for the live
 * probe, which runs this exact code against a real data source.
 */
export async function addMissingProperties(client: NotionLike, dataSourceId: string): Promise<AddPropertiesResult> {
  let ds: unknown;
  try { ds = await client.dataSources.retrieve({ data_source_id: dataSourceId }); }
  catch (e) { throw classifyNotionError(e); }
  const existing = propsOf(ds).map(([key, p]) => ({ name: (p.name || key).toLowerCase(), type: p.type! }));

  const added: string[] = [], present: string[] = [];
  const conflicts: AddPropertiesResult["conflicts"] = [];
  const properties: Record<string, unknown> = {};
  for (const w of WANTED) {
    const found = existing.find((e) => e.name === w.name.toLowerCase());
    if (!found) { properties[w.name] = w.def; added.push(w.name); }
    else if (found.type === w.type) present.push(w.name);
    else conflicts.push({ name: w.name, found: found.type, wanted: w.type });
  }
  if (added.length > 0) {
    try { await client.dataSources.update({ data_source_id: dataSourceId, properties }); }
    catch (e) { throw classifyNotionError(e); }
  }
  return { added, present, conflicts };
}

async function runAddProperties(
  deps: ClippingStepDeps, client: NotionLike, params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const dataSourceId = str(params["dataSourceId"]) ?? (await loadNotionSources(deps.db))[0]?.dataSourceId ?? null;
  if (!dataSourceId) {
    throw new ClippingFailure(
      "not-configured", "No clipping source is saved yet.", "Read a database and save its columns first.",
    );
  }
  return { ...(await addMissingProperties(client, dataSourceId)) };
}

// --- one request, and the drain --------------------------------------------------------------

/** Run one claimed request to an outcome. Never throws: every failure is an outcome. */
export async function runRequest(deps: ClippingStepDeps, req: ClippingRequest): Promise<RequestOutcome> {
  try {
    if (req.kind === "import") return await runImport(deps);
    const result = await withBudget(deps.budgetMs ?? STEP_BUDGET_MS, async () => {
      const client = await deps.makeClient(keyFor(deps));
      switch (req.kind) {
        case "schema": return runSchema(client, req.params);
        case "test": return runTest(deps, client, req.params);
        case "add-properties": return runAddProperties(deps, client, req.params);
      }
    });
    return { status: "done", outcome: "ok", detail: null, result: result ?? {} };
  } catch (e) {
    const f = classifyNotionError(e);
    deps.log?.(`clipping request ${req.kind}: ${f.outcome} — ${f.ownerText}`);
    return { status: "failed", outcome: f.outcome, detail: f.ownerText, result: {} };
  }
}

/** Answer up to `max` pending requests, oldest first. Returns how many were answered. */
export async function drainRequests(deps: ClippingStepDeps, max = MAX_PER_TICK): Promise<number> {
  await failStaleClaims(deps.db);
  let handled = 0;
  while (handled < max) {
    const req = await claimRequest(deps.db);
    if (!req) break;
    handled++;
    await finishRequest(deps.db, req.id, await runRequest(deps, req));
  }
  return handled;
}
