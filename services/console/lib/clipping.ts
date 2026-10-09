// services/console/lib/clipping.ts
// The Clipping card's data (LAR-113 child b): the saved Notion source and its state, the latest
// answer to each kind of request, the owner's source choice, and the chief of staff to switch on.
//
// READS. Any failure to read ANY of it is `{ unavailable: true }` (the PR #91 pattern in
// connections.ts): the card then says "Clipping status unavailable." and never an empty
// "nothing yet".
//
// WRITES. The console cannot reach Notion (only the chief of staff holds the key). Buttons write
// a row to `clipping_requests`; the chief of staff answers it within a minute. The one table the
// console writes directly is `clipping_sources` (the saved mapping) and `clipping_choice`.
import {
  clippingAddPropertiesResult, clippingImportResult, clippingSchemaResult, clippingTestResult,
  type ClippingAddPropertiesResult, type ClippingImportResult, type ClippingMode,
  type ClippingSchemaResult, type ClippingTestResult,
} from "@lares/agent-kit/clipping-console";
import { pool } from "./db";

// --- mirrored from the chief of staff (pinned by tests/engine-drift.test.ts) -------------------
// The console does not import the engine; these are the two-place truths.

/** services/chief-of-staff/lib/clipping/notion-reader.ts `ClippingOutcome`; also box/sql/091 and 092. */
export const CLIPPING_OUTCOMES = [
  "ok", "not-configured", "unsupported-source", "refused", "not-shared",
  "schema-mismatch", "rate-limited", "unavailable", "timeout", "incomplete",
  "key-unreadable", "local-error",
] as const;
export type ClippingOutcome = (typeof CLIPPING_OUTCOMES)[number];

/** services/chief-of-staff/lib/clipping/requests.ts `RequestKind`. */
export const CLIPPING_REQUEST_KINDS = ["schema", "test", "import", "add-properties"] as const;
export type ClippingRequestKind = (typeof CLIPPING_REQUEST_KINDS)[number];

/** services/chief-of-staff/lib/clipping/requests.ts `CLAIM_STALE_MS`. */
export const REQUEST_STALE_MS = 10 * 60_000;

// --- the view ---------------------------------------------------------------------------------

export interface ClippingSourceView {
  id: string;
  dataSourceId: string;
  urlPropertyId: string;
  notePropertyId: string | null;
  tagsPropertyId: string | null;
  savedPropertyId: string | null;
  importSince: string;
  outcome: ClippingOutcome | null;
  detail: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  importedTotal: number;
  /** Counts of the LAST SUCCESSFUL pass; the card shows them only when the latest outcome is ok. */
  lastCounts: Record<string, number>;
}

export type RequestStatus = "pending" | "claimed" | "done" | "failed" | "unavailable";

export interface ClippingRequestView {
  id: string;
  kind: ClippingRequestKind;
  status: RequestStatus;
  outcome: ClippingOutcome | null;
  detail: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** Parsed result of a finished request, or null when it is absent or not the shape expected. */
  result: ClippingSchemaResult | ClippingTestResult | ClippingImportResult | ClippingAddPropertiesResult | null;
}

export type ChiefOfStaff =
  | { kind: "one"; name: string }
  | { kind: "none" }
  | { kind: "several" };

export interface ClippingChoiceView { mode: ClippingMode; setBy: string; setAt: string }

export type ClippingView =
  | { unavailable: true }
  | {
      unavailable: false;
      source: ClippingSourceView | null;
      /** More than one Notion source row exists (a host edit); the engine reads none of them. */
      sourceCount: number;
      requests: Partial<Record<ClippingRequestKind, ClippingRequestView>>;
      choice: ClippingChoiceView | null;
      chiefOfStaff: ChiefOfStaff;
      /** True while any request is pending or claimed and not yet overdue: the card polls. */
      busy: boolean;
    };

const iso = (d: unknown): string | null => (d instanceof Date ? d.toISOString() : typeof d === "string" ? d : null);
const isOutcome = (v: unknown): v is ClippingOutcome => (CLIPPING_OUTCOMES as readonly string[]).includes(v as string);

const RESULT_SCHEMAS = {
  schema: clippingSchemaResult, test: clippingTestResult, import: clippingImportResult,
  "add-properties": clippingAddPropertiesResult,
} as const;

export const NOT_PICKED_UP = "The chief of staff did not pick this up.";
export const NOT_FINISHED = "The chief of staff did not finish this.";

type Row = Record<string, unknown>;

/** Pure: one request row as the card sees it. Overdue pending/claimed rows read as unavailable. */
export function toRequestView(r: Row, now: Date): ClippingRequestView {
  const kind = r["kind"] as ClippingRequestKind;
  let status = r["status"] as RequestStatus;
  let detail = typeof r["outcome_detail"] === "string" ? (r["outcome_detail"] as string) : null;
  const created = r["created_at"] instanceof Date ? (r["created_at"] as Date) : null;
  const claimed = r["claimed_at"] instanceof Date ? (r["claimed_at"] as Date) : null;
  if (status === "claimed" && claimed && now.getTime() - claimed.getTime() > REQUEST_STALE_MS) {
    status = "unavailable"; detail = NOT_FINISHED;
  } else if (status === "pending" && created && now.getTime() - created.getTime() > REQUEST_STALE_MS) {
    status = "unavailable"; detail = NOT_PICKED_UP;
  }
  const parsed = status === "done" ? RESULT_SCHEMAS[kind]?.safeParse(r["result"]) : undefined;
  return {
    id: String(r["id"]), kind, status,
    outcome: isOutcome(r["outcome"]) ? r["outcome"] : null,
    detail,
    createdAt: iso(r["created_at"]) ?? "",
    finishedAt: iso(r["finished_at"]),
    result: parsed?.success ? (parsed.data as ClippingRequestView["result"]) : null,
  };
}

function toSourceView(r: Row): ClippingSourceView {
  const counts = r["last_counts"] && typeof r["last_counts"] === "object" ? (r["last_counts"] as Record<string, unknown>) : {};
  return {
    id: String(r["id"]),
    dataSourceId: String(r["data_source_id"]),
    urlPropertyId: String(r["url_property_id"]),
    notePropertyId: (r["note_property_id"] as string | null) ?? null,
    tagsPropertyId: (r["tags_property_id"] as string | null) ?? null,
    savedPropertyId: (r["saved_property_id"] as string | null) ?? null,
    importSince: iso(r["import_since"]) ?? "",
    outcome: isOutcome(r["outcome"]) ? r["outcome"] : null,
    detail: (r["outcome_detail"] as string | null) ?? null,
    lastAttemptAt: iso(r["last_attempt_at"]),
    lastSuccessAt: iso(r["last_success_at"]),
    importedTotal: Number(r["imported_total"] ?? 0),
    lastCounts: Object.fromEntries(Object.entries(counts).filter(([, v]) => typeof v === "number")) as Record<string, number>,
  };
}

async function findChiefOfStaff(): Promise<ChiefOfStaff> {
  const { rows } = await pool.query<{ name: string }>(
    "SELECT name FROM agent_definitions WHERE definition->>'role' = 'chief-of-staff' AND status <> 'retired' ORDER BY name");
  if (rows.length === 0) return { kind: "none" };
  if (rows.length > 1) return { kind: "several" };
  return { kind: "one", name: rows[0]!.name };
}

export async function getClippingView(now: Date = new Date()): Promise<ClippingView> {
  try {
    const [sources, requests, choice, chiefOfStaff] = await Promise.all([
      pool.query("SELECT * FROM clipping_sources WHERE kind = 'notion' ORDER BY created_at, id"),
      pool.query("SELECT DISTINCT ON (kind) * FROM clipping_requests ORDER BY kind, created_at DESC, id"),
      pool.query("SELECT mode, set_by, set_at FROM clipping_choice LIMIT 1"),
      findChiefOfStaff(),
    ]);
    const byKind: Partial<Record<ClippingRequestKind, ClippingRequestView>> = {};
    for (const r of requests.rows as Row[]) {
      if ((CLIPPING_REQUEST_KINDS as readonly string[]).includes(r["kind"] as string)) {
        byKind[r["kind"] as ClippingRequestKind] = toRequestView(r, now);
      }
    }
    const c = choice.rows[0] as Row | undefined;
    const mode = c?.["mode"];
    return {
      unavailable: false,
      source: sources.rows[0] ? toSourceView(sources.rows[0] as Row) : null,
      sourceCount: sources.rows.length,
      requests: byKind,
      choice: c && (mode === "notion" || mode === "karakeep" || mode === "both")
        ? { mode, setBy: String(c["set_by"]), setAt: iso(c["set_at"]) ?? "" } : null,
      chiefOfStaff,
      busy: Object.values(byKind).some((r) => r.status === "pending" || r.status === "claimed"),
    };
  } catch {
    return { unavailable: true };
  }
}

// --- writes -----------------------------------------------------------------------------------

export type WriteResult = { ok: true } | { ok: false; code: string };

/**
 * Ask the chief of staff to do something. One request of a kind at a time: pressing a button again
 * while the last one of that kind is still waiting (and not overdue) is refused as `busy`.
 */
export async function enqueueRequest(
  kind: ClippingRequestKind, params: Record<string, unknown>, actor: string,
): Promise<WriteResult> {
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO clipping_requests (kind, params, requested_by)
       SELECT $1::text, $2::jsonb, $3::text
        WHERE NOT EXISTS (
          SELECT 1 FROM clipping_requests
           WHERE kind = $1::text AND status IN ('pending', 'claimed')
             AND created_at > now() - make_interval(secs => $4))`,
      [kind, JSON.stringify(params), actor, REQUEST_STALE_MS / 1000],
    );
    return rowCount === 1 ? { ok: true } : { ok: false, code: "busy" };
  } catch {
    return { ok: false, code: "unavailable" };
  }
}

export interface MappingInput {
  dataSourceId: string;
  urlPropertyId: string;
  notePropertyId?: string | null;
  tagsPropertyId?: string | null;
  savedPropertyId?: string | null;
}

/**
 * The column types each mapped role accepts. Mirrors checkSchema in the chief of staff's
 * notion-reader.ts (the url rule, NOTE_TYPES, TAG_TYPES, SAVED_TYPES); pinned by engine-drift.
 */
export const MAPPING_COLUMN_TYPES = {
  url: ["url"],
  note: ["rich_text"],
  tags: ["select", "multi_select"],
  saved: ["date", "created_time"],
} as const;
const OPTIONAL_ROLES = [
  ["notePropertyId", MAPPING_COLUMN_TYPES.note],
  ["tagsPropertyId", MAPPING_COLUMN_TYPES.tags],
  ["savedPropertyId", MAPPING_COLUMN_TYPES.saved],
] as const;

/**
 * Save the mapping. Accepted ONLY when it matches the latest successful `schema` answer: that data
 * source, and columns of the right type in it. Always writes the one organisation-wide shared
 * source; the owner, visibility, credential and start point are written explicitly, never from a
 * default. A changed data source resets the watermark, the start point and the state of the old one.
 */
export async function saveMapping(input: MappingInput): Promise<WriteResult> {
  try {
    const { rows } = await pool.query(
      `SELECT result FROM clipping_requests WHERE kind = 'schema' AND status = 'done'
        ORDER BY created_at DESC, id LIMIT 1`);
    const schema = clippingSchemaResult.safeParse(rows[0]?.result);
    if (!schema.success) return { ok: false, code: "no-schema" };
    const ds = schema.data.dataSources.find((d) => d.id === input.dataSourceId);
    if (!ds) return { ok: false, code: "mapping-mismatch" };
    const typeOf = (colId: string) => ds.columns.find((c) => c.id === colId)?.type;
    if (!(MAPPING_COLUMN_TYPES.url as readonly string[]).includes(typeOf(input.urlPropertyId) ?? "")) return { ok: false, code: "mapping-mismatch" };
    for (const [key, types] of OPTIONAL_ROLES) {
      const colId = input[key];
      if (colId && !(types as readonly string[]).includes(typeOf(colId) ?? "")) return { ok: false, code: "mapping-mismatch" };
    }
    const cols = [input.notePropertyId ?? null, input.tagsPropertyId ?? null, input.savedPropertyId ?? null];

    const existing = await pool.query("SELECT id, data_source_id FROM clipping_sources WHERE kind = 'notion' ORDER BY created_at, id");
    if (existing.rows.length > 1) return { ok: false, code: "more-than-one-source" };
    if (existing.rows.length === 0) {
      const ins = await pool.query(
        `INSERT INTO clipping_sources
           (kind, data_source_id, url_property_id, note_property_id, tags_property_id, saved_property_id,
            credential_ref, owner, visibility, import_since)
         SELECT 'notion', $1, $2, $3, $4, $5, 'notion:shared', 'organisation', 'shared', now()
          WHERE NOT EXISTS (SELECT 1 FROM clipping_sources WHERE kind = 'notion')`,
        [input.dataSourceId, input.urlPropertyId, ...cols]);
      return ins.rowCount === 1 ? { ok: true } : { ok: false, code: "more-than-one-source" };
    }
    const row = existing.rows[0] as { id: string; data_source_id: string };
    if (row.data_source_id === input.dataSourceId) {
      await pool.query(
        `UPDATE clipping_sources SET url_property_id = $2, note_property_id = $3, tags_property_id = $4, saved_property_id = $5
          WHERE id = $1`, [row.id, input.urlPropertyId, ...cols]);
    } else {
      await pool.query(
        `UPDATE clipping_sources SET data_source_id = $2, url_property_id = $3, note_property_id = $4,
                tags_property_id = $5, saved_property_id = $6, import_since = now(),
                watermark = NULL, watermark_capped = false, last_attempt_at = NULL, last_success_at = NULL,
                outcome = NULL, outcome_detail = NULL, last_counts = '{}'::jsonb
          WHERE id = $1`, [row.id, input.dataSourceId, input.urlPropertyId, ...cols]);
    }
    return { ok: true };
  } catch {
    return { ok: false, code: "unavailable" };
  }
}

export async function setChoice(mode: ClippingMode, actor: string): Promise<WriteResult> {
  try {
    await pool.query(
      `INSERT INTO clipping_choice (id, mode, set_by) VALUES (true, $1, $2)
       ON CONFLICT (id) DO UPDATE SET mode = EXCLUDED.mode, set_by = EXCLUDED.set_by, set_at = now()`,
      [mode, actor]);
    return { ok: true };
  } catch {
    return { ok: false, code: "unavailable" };
  }
}

/** The saved source's existence, for the buttons that need one. */
export async function hasSavedSource(): Promise<boolean | null> {
  try {
    const { rows } = await pool.query("SELECT 1 FROM clipping_sources WHERE kind = 'notion' LIMIT 1");
    return rows.length > 0;
  } catch {
    return null;
  }
}

/** The chief of staff to switch on, resolved on the server so the browser never names an agent. */
export async function chiefOfStaffForSwitch(): Promise<ChiefOfStaff | null> {
  try { return await findChiefOfStaff(); } catch { return null; }
}
