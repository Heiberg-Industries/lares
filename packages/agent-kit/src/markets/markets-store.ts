// The canonical market registry — the watchlist the `markets` capability reads.
//
// Copied from services/agent-runtime/lib/adapters/tyche/markets-store.ts (ORB-189 Task 1),
// which kept ONLY the read half. ORB-214 item 1 brought back exactly two writes for the watchlist
// refresh job (./refresh.ts, its only caller): `upsertPmFields` and `deleteMarket` (the retired
// loop's `dropMarket`, renamed for what it does to a row).
//
// The PAIRING half stayed retired and is not coming back: upsertMarket (which wrote every column,
// links included), loadMatchMap, listMatchEligible, recordMatch, recordMiss and
// backfillSeedSource all belonged to the LLM match judge. Kalshi links and outcome aliases are
// entered by hand (ORB-214 item 2), so nothing here can write them — which is also what keeps
// `lib/matching/match-map.js` out of this package.
//
// `market_type` drives whether a book may be de-vigged: 'mutually_exclusive' (one winner)
// de-vigs, 'independent' does not. A row whose column is null reads as mutually_exclusive,
// which is the historical default the survey wrote.
import type { MarketRow, MarketsPool, UpsertMarketInput } from "./types.js";

/** timestamptz (Date from pg) or ISO string → ISO string; null passthrough. */
function toIso(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v as string).toISOString();
}

/** jsonb (object from pg) or JSON string → object; null/empty → {}. */
function toAliases(v: unknown): Record<string, string[]> {
  if (v == null) return {};
  return typeof v === "string"
    ? (JSON.parse(v) as Record<string, string[]>)
    : (v as Record<string, string[]>);
}

export function makeMarketsStore(db: MarketsPool) {
  return {
    /** All registered markets, newest update first. */
    async listMarkets(): Promise<MarketRow[]> {
      const { rows } = await db.query(
        `SELECT id, label, pm_market_id, kalshi_event_ticker, outcome_aliases, end_date, market_type, match_source, match_checked_at, match_result, match_confidence
         FROM tyche_markets
         ORDER BY updated_at DESC`,
      );
      return rows.map((r: any) => ({
        id: r.id,
        label: r.label,
        pmMarketId: r.pm_market_id ?? null,
        kalshiEventTicker: r.kalshi_event_ticker ?? null,
        outcomeAliases: toAliases(r.outcome_aliases),
        endDateIso: toIso(r.end_date),
        marketType: (r.market_type ?? "mutually_exclusive") as "mutually_exclusive" | "independent",
        matchSource: r.match_source ?? null,
        matchResult: r.match_result ?? null,
        matchCheckedAtIso: toIso(r.match_checked_at),
        matchConfidence: r.match_confidence ?? null,
      }));
    },

    /**
     * Discovery-safe upsert — the refresh job's ONE market write. Verbatim from the retired
     * runtime's own `upsertPmFields`, which is the version that already had this property.
     *
     * On conflict it sets label / pm_market_id / market_type / end_date and nothing else. The
     * columns it never names are the load-bearing part: `kalshi_event_ticker` and
     * `outcome_aliases` are entered by hand (ORB-214 item 2) and a nightly discovery pass must
     * not be able to touch them, and the match bookkeeping columns belonged to a judge that no
     * longer exists. Proved against a real row in tests/markets-store.test.ts — a fake pool can
     * show the parameters going in, never what the row keeps.
     */
    async upsertPmFields(m: UpsertMarketInput): Promise<void> {
      await db.query(
        `INSERT INTO tyche_markets
           (id, label, pm_market_id, market_type, end_date)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           label        = EXCLUDED.label,
           pm_market_id = EXCLUDED.pm_market_id,
           market_type  = EXCLUDED.market_type,
           end_date     = EXCLUDED.end_date,
           updated_at   = now()`,
        [m.id, m.label, m.pmMarketId ?? null, m.marketType ?? "mutually_exclusive", m.endDateIso ?? null],
      );
    },

    /** Remove a market from the watchlist. The refresh job calls this only for a row that
     *  settled long ago and carries no Kalshi link — see ./refresh.ts for why "long ago". */
    async deleteMarket(id: string): Promise<void> {
      await db.query(`DELETE FROM tyche_markets WHERE id = $1`, [id]);
    },
  };
}
