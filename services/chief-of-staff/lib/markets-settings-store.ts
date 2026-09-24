/**
 * Markets settings store — ORB-214. Backs `sql/036_deadlines.sql`'s `markets_settings` table,
 * the one per-owner switch + watchlist ceiling the market-refresh schedule reads. Shaped like
 * every sibling store in this package: a plain function taking `db: Pool` first.
 *
 * `MARKETS_ENGINE.watchlistMax` is the ceiling of the ceiling, mirroring the CHECK constraint
 * on `markets_settings.watchlist_max` (10–150) — a stored value above it is clamped on read,
 * never trusted whole, the same shape as `proactivity.ts`'s engine-default clamp.
 */
import type { Pool } from "pg";

export interface MarketsSettings {
  refreshEnabled: boolean;
  watchlistMax: number;
}

export const MARKETS_ENGINE = { watchlistMax: 150, watchlistDefault: 100 } as const;

/** Defaults to `{ refreshEnabled: false, watchlistMax: MARKETS_ENGINE.watchlistDefault }` when
 *  no row exists. THROWS on a query error — the schedule that reads this must never see a
 *  query failure as a settled "off" answer. */
export async function readMarketsSettings(db: Pool, owner: string): Promise<MarketsSettings> {
  const { rows } = await db.query<{ refresh_enabled: boolean; watchlist_max: number }>(
    `SELECT refresh_enabled, watchlist_max FROM markets_settings WHERE owner = $1`,
    [owner],
  );
  if (rows.length === 0) {
    return { refreshEnabled: false, watchlistMax: MARKETS_ENGINE.watchlistDefault };
  }
  return {
    refreshEnabled: rows[0]!.refresh_enabled,
    watchlistMax: Math.min(rows[0]!.watchlist_max, MARKETS_ENGINE.watchlistMax),
  };
}
