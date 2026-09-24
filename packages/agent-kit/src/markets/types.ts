// Row + input shapes for the markets store. Prices are in probability space (0..1):
// the raw observed venue price (ask/bid/mid), NOT the derived fair probability.
// pg returns `numeric` as string and `timestamptz` as Date; the stores map those
// back to number / ISO string at the boundary so callers see clean JS values.
//
// THREE of the retired runtime's write-side input shapes are back (ORB-214 item 1): the watchlist
// refresh job in ./refresh.ts is their ONE writer, and there is no other. What stayed retired with
// the survey loop's LLM match judge is still absent on purpose — RecordMatchInput, RecordMissInput
// and RecordResolutionInput, because nothing in this package pairs venues, judges a match or reads
// a resolution feed. A dead input type is an invitation to add the missing half.
import type { OutcomeId, SourceId } from "./probability/types.js";

/** The narrow slice of `pg.Pool` the stores use. A real `Pool` satisfies it, and a test
 *  can hand in a fake without pulling in a driver. */
export interface MarketsPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}


/**
 * What the refresh job knows about a market from Polymarket alone — the input to
 * `upsertPmFields`, which is the only market write in this package.
 *
 * The retired runtime's `UpsertMarketInput` also carried `kalshiEventTicker` and
 * `outcomeAliases`, for an `upsertMarket` that wrote every column. Both are gone here, and their
 * absence is the point: the Kalshi link and the outcome aliases are entered BY HAND (ORB-214
 * item 2 — the LLM match judge was retired with the survey loop), so a discovery pass must be
 * incapable of setting or clearing them, not merely careful not to.
 */
export interface UpsertMarketInput {
  id: string;                                        // canonical market id (we choose it)
  label: string;                                     // human label for the question
  pmMarketId?: string | null;                        // Polymarket event slug
  endDateIso?: string | null;                        // resolution / kickoff time
  marketType?: "mutually_exclusive" | "independent"; // defaults to mutually_exclusive
}

/** One observed venue price, appended by the refresh job. Prices are probability space (0..1). */
export interface SnapshotInput {
  marketId: string;
  outcomeId: OutcomeId;
  venue: SourceId;
  label?: string | null; // human outcome name ("Spain") for read-back; outcomeId is the venue's own key
  bid?: number | null;
  ask?: number | null;
  mid?: number | null;
  liquidity?: number | null;
  ts?: string;           // ISO observation time; defaults to now() in the DB
}

/**
 * One measured edge, recorded by the refresh job. `alertedAtIso` exists because the column does,
 * and the job passes `null` to it every single time: nothing in this package announces anything,
 * and the COALESCE in `record` is what keeps a prior alert time from being erased by a re-quote.
 */
export interface RecordAlertInput {
  marketId: string;
  outcomeId: OutcomeId;
  edge?: number | null;         // latest edge in probability points (recorded every check)
  basis?: number | null;        // the de-vigged fair the edge was measured against
  alertedAtIso?: string | null; // set ONLY when an alert actually fired — never by this package
}

export interface MarketRow {
  id: string;
  label: string;
  pmMarketId: string | null;
  kalshiEventTicker: string | null;
  outcomeAliases: Record<string, string[]>;
  endDateIso: string | null;
  marketType: "mutually_exclusive" | "independent";
  matchSource?: string | null;
  matchResult?: string | null;
  matchCheckedAtIso?: string | null;
  matchConfidence?: number | null;
}

export interface SnapshotRow {
  id: number;
  marketId: string;
  outcomeId: OutcomeId;
  label: string | null;
  venue: SourceId;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  liquidity: number | null;
  tsIso: string;
}

export interface AlertState {
  marketId: string;
  outcomeId: OutcomeId;
  lastEdge: number | null;
  lastBasis: number | null;
  /** When an alert last actually fired — null for an outcome measured but never announced. */
  lastAlertedAtIso: string | null;
  /** The row's `updated_at`: when this edge was last RECORDED. Present on every row, so a
   *  card built from it can say "recorded <date>, not re-quoted" (ORB-189 Task 2). */
  recordedAtIso?: string | null;
}

