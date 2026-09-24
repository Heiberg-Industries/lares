// The time-series of raw observed venue prices (0..1), one row per
// (market, outcome, venue, ts). This store only returns rows — it derives nothing.
// node-postgres returns numeric as string and bigserial as string, so the mappers
// coerce to number.
//
// Copied from services/agent-runtime/lib/adapters/tyche/snapshots-store.ts (ORB-189 Task 1),
// which kept only the read half. ORB-214 item 1 brought `append` back, verbatim, for the
// watchlist refresh job (./refresh.ts) — its only caller. Nothing else in this package writes.
import type { SnapshotRow, SnapshotInput, MarketsPool } from "./types.js";

function num(v: unknown): number | null {
  return v == null ? null : Number(v);
}

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(v as string).toISOString();
}

export function makeSnapshotsStore(db: MarketsPool) {
  return {
    /** Append one observed snapshot. `ts` defaults to now() in the DB when omitted — but the
     *  refresh job always passes one, because every write of a single run must share ONE instant
     *  for the read path to group a book by instant. */
    async append(s: SnapshotInput): Promise<{ id: number }> {
      const { rows } = await db.query(
        `INSERT INTO tyche_market_snapshots
           (market_id, outcome_id, label, venue, bid, ask, mid, liquidity, ts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, now()))
         RETURNING id`,
        [
          s.marketId,
          s.outcomeId,
          s.label ?? null,
          s.venue,
          s.bid ?? null,
          s.ask ?? null,
          s.mid ?? null,
          s.liquidity ?? null,
          s.ts ?? null,
        ],
      );
      return { id: Number((rows[0] as { id: number | string }).id) };
    },

    /** Most-recent snapshots for one (market, outcome, venue), newest first. */
    async recentForOutcome(args: {
      marketId: string;
      outcomeId: string;
      venue: string;
      limit: number;
    }): Promise<SnapshotRow[]> {
      const { rows } = await db.query(
        `SELECT id, market_id, outcome_id, label, venue, bid, ask, mid, liquidity, ts
         FROM tyche_market_snapshots
         WHERE market_id = $1 AND outcome_id = $2 AND venue = $3
         ORDER BY ts DESC
         LIMIT $4`,
        [args.marketId, args.outcomeId, args.venue, args.limit],
      );
      return rows.map((r: any) => ({
        id: Number(r.id),
        marketId: r.market_id,
        outcomeId: r.outcome_id,
        label: r.label ?? null,
        venue: r.venue,
        bid: num(r.bid),
        ask: num(r.ask),
        mid: num(r.mid),
        liquidity: num(r.liquidity),
        tsIso: toIso(r.ts),
      }));
    },

    /** Most-recent snapshots across ALL outcomes of one (market, venue), newest first.
     *  Callers group by ts to reconstruct per-instant probability via de-vig. */
    async recentByMarketVenue(args: {
      marketId: string;
      venue: string;
      limit: number;
    }): Promise<SnapshotRow[]> {
      const { rows } = await db.query(
        `SELECT id, market_id, outcome_id, label, venue, bid, ask, mid, liquidity, ts
         FROM tyche_market_snapshots
         WHERE market_id = $1 AND venue = $2
         ORDER BY ts DESC
         LIMIT $3`,
        [args.marketId, args.venue, args.limit],
      );
      return rows.map((r: any) => ({
        id: Number(r.id),
        marketId: r.market_id,
        outcomeId: r.outcome_id,
        label: r.label ?? null,
        venue: r.venue,
        bid: num(r.bid),
        ask: num(r.ask),
        mid: num(r.mid),
        liquidity: num(r.liquidity),
        tsIso: toIso(r.ts),
      }));
    },
  };
}
