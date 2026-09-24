import Database from "better-sqlite3";
import { existsSync, rmSync } from "node:fs";

/**
 * Channels whose interaction content is NEVER pushed to the box, regardless of
 * age. Workstream D: Meta DMs (Facebook Messenger + Instagram DM) are nearly
 * all of the GDPR exposure and nearly none of the utility Saga's obligation
 * tracking and person-360 actually draw on.
 */
export const ALWAYS_STRIPPED_CHANNELS = ["facebook", "instagram"] as const;

/**
 * Rolling window, in days, for which non-Meta interaction content is kept in
 * the replica. Bendik, 2026-09-01: the box may hold a rolling 90 days of
 * content (metadata is kept forever, unaffected by this window).
 */
export const CONTENT_WINDOW_DAYS = 90;

export interface StrippedReplicaResult {
  /** number of rows whose raw content was nulled out (Meta, or older than the window) */
  rowsStripped: number;
  /** number of rows that still carry raw content after stripping */
  rowsKept: number;
}

/**
 * Produce a content-stripped copy of `network.db` at `destPath`, suitable for
 * pushing to the agent box. The replica keeps everything agents need on the box
 * (identities, pulse/warmth, dates, signals, positions) and, per the 2026-09-01
 * ruling, a rolling 90 days of interaction content for every channel except
 * Meta — Facebook and Instagram content is always stripped, regardless of age.
 *
 * Implementation: `VACUUM INTO` makes a clean, WAL-consistent single-file copy;
 * the in-scope content is then nulled; a final `VACUUM` rebuilds the file so
 * the removed bytes leave no residue (verified by the byte-level test).
 */
export function exportStrippedReplica(
  sourcePath: string,
  destPath: string,
  now: Date = new Date(),
): StrippedReplicaResult {
  if (!existsSync(sourcePath)) {
    throw new Error(`Database not found: ${sourcePath}`);
  }
  // VACUUM INTO requires the destination not to exist; clear any stale replica + sidecars.
  for (const ext of ["", "-wal", "-shm"]) {
    if (existsSync(destPath + ext)) rmSync(destPath + ext);
  }

  const src = new Database(sourcePath, { readonly: true });
  try {
    src.prepare("VACUUM INTO ?").run(destPath);
  } finally {
    src.close();
  }

  const dest = new Database(destPath);
  try {
    const threshold = new Date(now.getTime() - CONTENT_WINDOW_DAYS * 86_400_000).toISOString();
    const metaPlaceholders = ALWAYS_STRIPPED_CHANNELS.map(() => "?").join(",");
    const res = dest
      .prepare(
        `UPDATE interactions SET content = NULL WHERE content IS NOT NULL AND (channel IN (${metaPlaceholders}) OR at < ?)`,
      )
      .run(...ALWAYS_STRIPPED_CHANNELS, threshold);
    const rowsStripped = res.changes;
    const rowsKept = (
      dest.prepare("SELECT COUNT(*) AS n FROM interactions WHERE content IS NOT NULL").get() as { n: number }
    ).n;
    // Rebuild the file so the freed pages (which still held the raw content) are gone.
    dest.exec("VACUUM");
    return { rowsStripped, rowsKept };
  } finally {
    dest.close();
  }
}
