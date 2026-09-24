// The recorded-edge memory: one row per (market, outcome) in `tyche_alert_state`, holding the
// last edge and basis the survey loop measured, and when it last said so out loud.
//
// Copied from services/agent-runtime/lib/adapters/tyche/alert-state-store.ts (ORB-189 Task 1),
// which kept only the read half. ORB-214 item 1 brought `record` back, verbatim, for the
// watchlist refresh job (./refresh.ts) — its only caller.
//
// It records a MEASUREMENT, never an announcement. The refresh job passes `alertedAtIso: null`
// on every call, and the COALESCE below is what makes that safe: a nightly re-quote updates the
// edge and the basis and leaves `last_alerted_at` exactly as it was. Nothing in this package
// alerts, and the proactivity contract (ORB-193) is where any future announcement would live.
//
// `bestBets` ranks on this RECORDED edge, not on a live re-quote, so every row carries
// `recordedAtIso` (the row's `updated_at`) — the honest "recorded <date>, not re-quoted"
// timestamp. `lastAlertedAtIso` is narrower: it is set only when an alert actually fired,
// so it is null for every outcome that was measured but never announced.
import type { AlertState, MarketsPool, RecordAlertInput } from "./types.js";

function num(v: unknown): number | null {
  return v == null ? null : Number(v);
}

function toIso(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v as string).toISOString();
}

export function makeEdgeStateStore(db: MarketsPool) {
  return {
    /** Current recorded edge for one (market, outcome), or null if never recorded. */
    async get(args: { marketId: string; outcomeId: string }): Promise<AlertState | null> {
      const { rows } = await db.query(
        `SELECT market_id, outcome_id, last_edge, last_basis, last_alerted_at, updated_at
         FROM tyche_alert_state
         WHERE market_id = $1 AND outcome_id = $2`,
        [args.marketId, args.outcomeId],
      );
      if (rows.length === 0) return null;
      const r: any = rows[0];
      return {
        marketId: r.market_id,
        outcomeId: r.outcome_id,
        lastEdge: num(r.last_edge),
        lastBasis: num(r.last_basis),
        lastAlertedAtIso: toIso(r.last_alerted_at),
        recordedAtIso: toIso(r.updated_at),
      };
    },

    /**
     * Upsert the recorded edge for one (market, outcome). `edge` and `basis` overwrite on every
     * call, and `updated_at` advances — that is what makes `recordedAtIso` honest. `last_alerted_at`
     * is advanced ONLY when `alertedAtIso` is given; the COALESCE keeps the prior value otherwise,
     * so the refresh job (which always passes null) can re-measure nightly without ever erasing
     * the record of an alert that really fired. Proved against a real row in
     * tests/markets-edge-state.test.ts.
     */
    async record(input: RecordAlertInput): Promise<void> {
      await db.query(
        `INSERT INTO tyche_alert_state
           (market_id, outcome_id, last_edge, last_basis, last_alerted_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (market_id, outcome_id) DO UPDATE SET
           last_edge       = EXCLUDED.last_edge,
           last_basis      = EXCLUDED.last_basis,
           last_alerted_at = COALESCE(EXCLUDED.last_alerted_at, tyche_alert_state.last_alerted_at),
           updated_at      = now()`,
        [input.marketId, input.outcomeId, input.edge ?? null, input.basis ?? null, input.alertedAtIso ?? null],
      );
    },
  };
}
