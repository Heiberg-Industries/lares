/**
 * Postgres side of clipping (box/sql/091_clipping.sql): the list of sources, the per-source
 * state the console reads, and the ledger of imported items. Thin SQL, no judgement; the
 * rules live in `sync.ts`.
 */


import type { ClipSource } from "./record.js";
import type { ClippingOutcome } from "./notion-reader.js";

/** A database handle: a `pg` Pool satisfies it, and so does a test double. */
export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<R = any>(text: string, values?: readonly unknown[]): Promise<{ rows: R[]; rowCount?: number | null }>;
}

/** A source plus its state, as one row. */
export interface SourceRow extends ClipSource {
  credentialRef: string;
  importSince: Date;
  watermark: Date | null;
  watermarkCapped: boolean;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  outcome: ClippingOutcome | null;
}

export type ItemState = "imported" | "filed-unknown" | "trashed" | "skipped";

export interface LedgerItem {
  sourceId: string;
  sourceItemId: string;
  state: ItemState;
  skipReason: "no-link" | "duplicate" | null;
  sourceRevision: Date | null;
  inboxPath: string | null;
  urlKey: string | null;
}

export interface Counts {
  imported: number;
  updated: number;
  trashed: number;
  skipped: number;
  noLink: number;
  duplicates: number;
  editedAfterFiling: number;
}

export const emptyCounts = (): Counts => ({
  imported: 0, updated: 0, trashed: 0, skipped: 0, noLink: 0, duplicates: 0, editedAfterFiling: 0,
});

/** The 30-day window inside which the same link in the same inbox counts as a duplicate. */
export const DUPLICATE_WINDOW_DAYS = 30;

type Row = Record<string, unknown>;

function toSource(r: Row): SourceRow {
  return {
    id: String(r["id"]),
    kind: "notion",
    dataSourceId: String(r["data_source_id"]),
    urlPropertyId: String(r["url_property_id"]),
    notePropertyId: (r["note_property_id"] as string | null) ?? null,
    tagsPropertyId: (r["tags_property_id"] as string | null) ?? null,
    savedPropertyId: (r["saved_property_id"] as string | null) ?? null,
    owner: String(r["owner"]),
    visibility: r["visibility"] as "shared" | "private",
    credentialRef: String(r["credential_ref"]),
    importSince: r["import_since"] as Date,
    watermark: (r["watermark"] as Date | null) ?? null,
    watermarkCapped: r["watermark_capped"] === true,
    lastAttemptAt: (r["last_attempt_at"] as Date | null) ?? null,
    lastSuccessAt: (r["last_success_at"] as Date | null) ?? null,
    outcome: (r["outcome"] as ClippingOutcome | null) ?? null,
  };
}

/** Every Notion source, oldest first. (Karakeep ledger rows are never places to read from.) */
export async function loadNotionSources(db: Queryable): Promise<SourceRow[]> {
  const { rows } = await db.query(`SELECT * FROM clipping_sources WHERE kind = 'notion' ORDER BY created_at, id`);
  return (rows as Row[]).map(toSource);
}

export interface SourceStateUpdate {
  outcome: ClippingOutcome;
  detail: string | null;
  /** Present only on success: the new watermark. A failure leaves the watermark alone. */
  success?: { watermark: Date | null; capped: boolean; counts: Counts };
}

export async function recordSourceState(db: Queryable, sourceId: string, u: SourceStateUpdate): Promise<void> {
  const detail = u.detail === null ? null : u.detail.slice(0, 400);
  if (u.success) {
    await db.query(
      `UPDATE clipping_sources SET
         last_attempt_at = now(), last_success_at = now(), outcome = $2, outcome_detail = $3,
         watermark = COALESCE($4, watermark), watermark_capped = $5, last_counts = $6::jsonb,
         imported_total = imported_total + $7
       WHERE id = $1`,
      [sourceId, u.outcome, detail, u.success.watermark, u.success.capped,
        JSON.stringify(u.success.counts), u.success.counts.imported],
    );
    return;
  }
  await db.query(
    `UPDATE clipping_sources SET last_attempt_at = now(), outcome = $2, outcome_detail = $3 WHERE id = $1`,
    [sourceId, u.outcome, detail],
  );
}

function toItem(r: Row): LedgerItem {
  return {
    sourceId: String(r["source_id"]),
    sourceItemId: String(r["source_item_id"]),
    state: r["state"] as ItemState,
    skipReason: (r["skip_reason"] as "no-link" | "duplicate" | null) ?? null,
    sourceRevision: (r["source_revision"] as Date | null) ?? null,
    inboxPath: (r["inbox_path"] as string | null) ?? null,
    urlKey: (r["url_key"] as string | null) ?? null,
  };
}

export async function getItem(db: Queryable, sourceId: string, sourceItemId: string): Promise<LedgerItem | null> {
  const { rows } = await db.query(
    `SELECT * FROM clipping_items WHERE source_id = $1 AND source_item_id = $2`,
    [sourceId, sourceItemId],
  );
  return rows[0] ? toItem(rows[0] as Row) : null;
}

export interface ItemWrite {
  sourceId: string;
  sourceItemId: string;
  container: string;
  owner: string;
  visibility: "shared" | "private";
  urlKey: string | null;
  sourceRevision: string;
  state: ItemState;
  skipReason?: "no-link" | "duplicate" | null;
  inboxPath: string | null;
}

/** Insert or update the ledger row for (source, item). `first_seen_at` is kept on update. */
export async function putItem(db: Queryable, w: ItemWrite): Promise<void> {
  await db.query(
    `INSERT INTO clipping_items
       (source_id, source_item_id, source_container, owner, visibility, url_key, source_revision,
        state, skip_reason, inbox_path)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (source_id, source_item_id) DO UPDATE SET
       source_container = EXCLUDED.source_container, owner = EXCLUDED.owner,
       visibility = EXCLUDED.visibility, url_key = EXCLUDED.url_key,
       source_revision = EXCLUDED.source_revision, state = EXCLUDED.state,
       skip_reason = EXCLUDED.skip_reason, inbox_path = EXCLUDED.inbox_path, updated_at = now()`,
    [w.sourceId, w.sourceItemId, w.container, w.owner, w.visibility, w.urlKey, w.sourceRevision,
      w.state, w.skipReason ?? null, w.inboxPath],
  );
}

/** Change only the state (and optionally the recorded revision) of an existing row. */
export async function setItemState(
  db: Queryable, sourceId: string, sourceItemId: string, state: ItemState, revision?: string,
): Promise<void> {
  await db.query(
    `UPDATE clipping_items SET state = $3, source_revision = COALESCE($4, source_revision), updated_at = now()
     WHERE source_id = $1 AND source_item_id = $2`,
    [sourceId, sourceItemId, state, revision ?? null],
  );
}

/**
 * The same link already brought into the SAME inbox (same owner and visibility) in the last 30
 * days, from any source and any item other than this one. A link saved to two different inboxes
 * is not a duplicate.
 */
export async function findDuplicate(
  db: Queryable,
  q: { owner: string; visibility: string; urlKey: string; sourceId: string; sourceItemId: string },
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM clipping_items
     WHERE owner = $1 AND visibility = $2 AND url_key = $3
       AND state IN ('imported', 'filed-unknown')
       AND first_seen_at > now() - make_interval(days => $4)
       AND NOT (source_id = $5 AND source_item_id = $6)
     LIMIT 1`,
    [q.owner, q.visibility, q.urlKey, DUPLICATE_WINDOW_DAYS, q.sourceId, q.sourceItemId],
  );
  return rows.length > 0;
}

/** Clips of this source still believed to be waiting in the inbox, least recently checked first. */
export async function listWaiting(db: Queryable, sourceId: string): Promise<LedgerItem[]> {
  const { rows } = await db.query(
    `SELECT * FROM clipping_items WHERE source_id = $1 AND state = 'imported'
     ORDER BY last_checked_at NULLS FIRST, first_seen_at`,
    [sourceId],
  );
  return (rows as Row[]).map(toItem);
}

export async function markChecked(db: Queryable, sourceId: string, sourceItemId: string): Promise<void> {
  await db.query(
    `UPDATE clipping_items SET last_checked_at = now() WHERE source_id = $1 AND source_item_id = $2`,
    [sourceId, sourceItemId],
  );
}

/**
 * Record a Karakeep import in the same ledger, so a Notion clip of the same link is not brought
 * in twice. Karakeep keeps its own `karakeep_seen` table untouched. Owner and visibility are the
 * installation-wide ones (organisation, shared), as for the single Notion source.
 */
export async function recordKarakeepImport(
  db: Queryable, w: { bookmarkId: string; urlKey: string; inboxPath: string },
): Promise<void> {
  await db.query(
    `INSERT INTO clipping_sources (id, kind, data_source_id, url_property_id, credential_ref, owner, visibility, import_since)
     VALUES ('karakeep', 'karakeep', 'karakeep', 'karakeep', 'karakeep', 'organisation', 'shared', now())
     ON CONFLICT (id) DO NOTHING`,
  );
  await putItem(db, {
    sourceId: "karakeep", sourceItemId: w.bookmarkId, container: "karakeep",
    owner: "organisation", visibility: "shared", urlKey: w.urlKey,
    sourceRevision: new Date().toISOString(), state: "imported", inboxPath: w.inboxPath,
  });
}

// --- which source runs (box/sql/092_clipping_requests.sql) --------------------------------

export type ClippingMode = "notion" | "karakeep" | "both";

/**
 * The owner's choice of source, or null for "no choice recorded" (today's behaviour: each source
 * runs if it is set up). A missing table (migration 092 not applied) is also null; any other
 * error is a real fault and is thrown.
 */
export async function readClippingChoice(db: Queryable): Promise<ClippingMode | null> {
  try {
    const { rows } = await db.query(`SELECT mode FROM clipping_choice LIMIT 1`);
    const mode = (rows[0] as { mode?: string } | undefined)?.mode;
    return mode === "notion" || mode === "karakeep" || mode === "both" ? mode : null;
  } catch (e) {
    if ((e as { code?: string } | null)?.code === "42P01") return null;
    throw e;
  }
}

// --- where a filed article went (articles child 1b; no migration) ---------------------------

/**
 * The digest filed a clip as an article note: remember where it went.
 *
 * THE CHANGED MEANING OF `inbox_path`. While a clip waits, `inbox_path` is its place in the inbox
 * (`_inbox/...`). Once the digest files it as an article, nothing reads that place any more (the
 * note has left the inbox; `sync.ts` and the waiting-clip list only look at `imported` rows), so
 * this reuses the column for the article's own place, written `<area>:<path>`: `shared:articles/x.md`
 * or `private:articles/x.md`. The area is part of the value because the two areas are separate
 * stores and can each hold an article of the same name, so the path alone would not say which one
 * a row means. That is why no migration is needed. A row whose value starts with `_inbox/` is still
 * waiting or was filed by another route; one that starts with `shared:` or `private:` was filed as
 * an article. The state becomes `filed-unknown`, the state the ledger already uses for
 * "the digest took it", so a later edit in Notion is counted and never re-imports the clip.
 *
 * Accepts `filed-unknown` as well as `imported`: the console's "Import now" can run a sync between
 * the digest filing the note and this call, and that sync marks the row `filed-unknown` first.
 * Matches on the inbox path, so only a row whose path is still the inbox note's changes: a second
 * call for the same note, a note the ledger never saw (a clipper drop, a chat link) and a trashed
 * or skipped row all change nothing. Returns whether a row changed.
 */
export async function recordFiledArticle(
  db: Queryable, w: { inboxPath: string; area: "shared" | "private"; filedPath: string },
): Promise<boolean> {
  const res = await db.query(
    `UPDATE clipping_items
     SET state = 'filed-unknown', inbox_path = $2, updated_at = now()
     WHERE inbox_path = $1 AND state IN ('imported', 'filed-unknown')`,
    [w.inboxPath, `${w.area}:${w.filedPath}`],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * The digest's `onFiled` hook: records where each article went, and never fails the filing. The
 * article is already in the vault by the time this runs, so a database failure is logged and
 * dropped (the row then stays `imported` until the next sync notices the note is gone, which is
 * the behaviour before articles existed). A box without the clipping tables has nothing to record.
 */
export function makeLedgerOnFiled(
  db: Queryable, log: (message: string) => void,
): (inboxPath: string, filed: { area: "shared" | "private"; destPath: string }) => Promise<void> {
  return async (inboxPath, filed) => {
    try {
      await recordFiledArticle(db, { inboxPath, area: filed.area, filedPath: filed.destPath });
    } catch (e) {
      if ((e as { code?: string } | null)?.code === "42P01") return;
      log(`could not record in the clipping ledger where ${inboxPath} went (${String(e instanceof Error ? e.message : e)})`);
    }
  };
}
