// services/box/lib/update-history.ts — what was running before an update (box 087).
//
// WHY THIS EXISTS. Nothing on disk recorded which image digests were live before an update
// overwrote the rendered compose file. "One command puts the previous version back" (ADR-0021
// rule 4) had no data behind it — this module and its table are that data, nothing more. It
// records what was running; `lares rollback` (a later slice) is what acts on `previousImages`.
//
// THE DATABASE ENFORCES THE SHAPE, NOT THIS MODULE. `images` must be full digest references
// (`update_history_images_are_digests`, box 087) and `outcome` must be one of the four known
// values (the column's own CHECK) — both constraints live in the migration, so a caller that
// passes a tag or an unknown outcome gets a rejection straight from Postgres. This module does
// not re-validate either: two copies of the same rule drift, and the one in SQL is the one that
// also protects a row written by anything other than this module.
//
// NOT BEST-EFFORT. Unlike packages/agent-kit/src/approval-ledger.ts's writer (evidence about a
// gate, where a lost row must never turn a pass into a refusal), a lost update record is exactly
// the failure this table exists to prevent — `beginUpdate` failing is `update.sh`'s signal to
// refuse the whole update rather than proceed with no way back (see the plan's deploy note for
// W8D-s2/s3/s4). Throwing here is the correct behaviour, not an omission.
import type { Queryable } from "./db.js";

/** The outcomes an update run can end in. `started` is the only one a row is ever created with;
 *  `finishUpdate` moves it to one of the other three. */
export type UpdateOutcome = "started" | "ok" | "failed" | "rolled-back";

export interface UpdateRecord {
  readonly id: number;
  readonly startedAt: Date;
  readonly fromRelease: string | null;
  readonly toRelease: string;
  readonly images: Readonly<Record<string, string>>; // what was running BEFORE
  readonly snapshotId: string | null; // the restic snapshot taken first
  readonly outcome: UpdateOutcome;
  readonly detail: string | null;
}

/** How many rows `finishUpdate` keeps, newest first — enough to see what happened, never a
 *  reason to keep more than one step of rollback data usable (owner decision D3: a rollback only
 *  ever goes back one step; the history is for visibility). */
export const UPDATE_HISTORY_KEEP = 10;

interface UpdateHistoryRow {
  id: string | number;
  started_at: Date;
  finished_at: Date | null;
  from_release: string | null;
  to_release: string;
  images: Record<string, string>;
  snapshot_id: string | null;
  outcome: UpdateOutcome;
  detail: string | null;
}

function toUpdateRecord(row: UpdateHistoryRow): UpdateRecord {
  return {
    id: Number(row.id),
    startedAt: row.started_at,
    fromRelease: row.from_release,
    toRelease: row.to_release,
    images: row.images,
    snapshotId: row.snapshot_id,
    outcome: row.outcome,
    detail: row.detail,
  };
}

/** Writes down what is running BEFORE an update touches anything. Returns the new row's id, for
 *  `finishUpdate` to close later. Throws — see the module header — when `images` is not full
 *  digest references, or when the database is unreachable: either way `update.sh` must refuse
 *  the update rather than proceed with nothing written down. */
export async function beginUpdate(
  db: Queryable,
  input: {
    fromRelease: string | null;
    toRelease: string;
    images: Readonly<Record<string, string>>;
    snapshotId: string | null;
  },
): Promise<number> {
  const { rows } = await db.query<{ id: string | number }>(
    `INSERT INTO update_history (from_release, to_release, images, snapshot_id)
     VALUES ($1, $2, $3::jsonb, $4)
     RETURNING id`,
    [input.fromRelease, input.toRelease, JSON.stringify(input.images), input.snapshotId],
  );
  return Number(rows[0]!.id);
}

/** Closes an update run with its final outcome. Throws on an outcome the column's own CHECK does
 *  not know, or on a database error — an update script that cannot close its own record has
 *  bigger problems than this call failing loudly. */
export async function finishUpdate(
  db: Queryable,
  id: number,
  outcome: UpdateRecord["outcome"],
  detail?: string,
): Promise<void> {
  await db.query(
    `UPDATE update_history SET finished_at = now(), outcome = $2, detail = $3 WHERE id = $1`,
    [id, outcome, detail ?? null],
  );
  await trimHistory(db);
}

/** The digests that were running before the newest update that finished `ok` — what
 *  `lares rollback` puts back. `null` when no update has ever finished successfully, rather than
 *  guessing at a digest nobody recorded. */
export async function previousImages(
  db: Queryable,
): Promise<Readonly<Record<string, string>> | null> {
  const { rows } = await db.query<{ images: Record<string, string> }>(
    `SELECT images FROM update_history WHERE outcome = 'ok' ORDER BY started_at DESC LIMIT 1`,
  );
  return rows[0]?.images ?? null;
}

/** The most recent update runs, newest first, bounded by `limit` (default `UPDATE_HISTORY_KEEP`). */
export async function recentUpdates(db: Queryable, limit = UPDATE_HISTORY_KEEP): Promise<UpdateRecord[]> {
  const { rows } = await db.query<UpdateHistoryRow>(
    `SELECT id, started_at, finished_at, from_release, to_release, images, snapshot_id, outcome, detail
     FROM update_history ORDER BY started_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map(toUpdateRecord);
}

/** Keeps the table bounded to `UPDATE_HISTORY_KEEP` rows, oldest dropped first. Called after
 *  every `finishUpdate` rather than on a schedule, so the table never grows unbounded even on an
 *  installation that is never otherwise tended. */
async function trimHistory(db: Queryable): Promise<void> {
  await db.query(
    `DELETE FROM update_history WHERE id IN (
       SELECT id FROM update_history ORDER BY started_at DESC OFFSET $1
     )`,
    [UPDATE_HISTORY_KEEP],
  );
}
