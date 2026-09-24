/**
 * ORB-214 — the read layer behind `/markets`.
 *
 * `MARKETS_ENGINE` mirrors `services/chief-of-staff/lib/markets-settings-store.ts`'s own constant of
 * the same name, which itself mirrors the `watchlist_max` CHECK on `sql/036_deadlines.sql`
 * (10–150). The console never imports the kit or eve-saga (ADR-0014 rule 12) — `tests/engine-
 * drift.test.ts` reads that store's source as TEXT and fails the day the two numbers disagree.
 *
 * Counts and the alert log come from Tyche's own tables (`tyche_markets`, `tyche_alert_state`),
 * shaped exactly as `packages/agent-kit/src/markets/markets-store.ts` and `edge-state.ts` read
 * them — this file is a second reader of the same rows, never a second writer of the watchlist
 * itself (the refresh job on the box owns that; the console owns only the two settings columns).
 */
import { pool } from "./db";
import { ownerId } from "./proactivity";

export const MARKETS_ENGINE = { watchlistMax: 150, watchlistDefault: 100 } as const;

export interface MarketsSettingsDTO {
  refreshEnabled: boolean;
  watchlistMax: number;
}

/** Defaults to `{ refreshEnabled: false, watchlistMax: MARKETS_ENGINE.watchlistDefault }` when no
 *  row exists, and clamps a hand-written value above the engine max on read — the same shape as
 *  `lib/proactivity.ts`'s `effectiveCeiling`. */
export async function readMarketsSettings(owner: string): Promise<MarketsSettingsDTO> {
  const { rows } = await pool.query<{ refresh_enabled: boolean; watchlist_max: number }>(
    `SELECT refresh_enabled, watchlist_max FROM markets_settings WHERE owner = $1`,
    [owner],
  );
  if (rows.length === 0) return { refreshEnabled: false, watchlistMax: MARKETS_ENGINE.watchlistDefault };
  return {
    refreshEnabled: rows[0]!.refresh_enabled,
    watchlistMax: Math.min(Number(rows[0]!.watchlist_max), MARKETS_ENGINE.watchlistMax),
  };
}

export interface MarketCounts {
  open: number;
  settled: number;
  withKalshiLink: number;
}

export async function readMarketCounts(): Promise<MarketCounts> {
  const { rows } = await pool.query<{ open: number; settled: number; with_kalshi_link: number }>(
    `SELECT
       count(*) FILTER (WHERE end_date IS NULL OR end_date > now())::int AS open,
       count(*) FILTER (WHERE end_date IS NOT NULL AND end_date <= now())::int AS settled,
       count(*) FILTER (WHERE kalshi_event_ticker IS NOT NULL)::int AS with_kalshi_link
     FROM tyche_markets`,
  );
  const r = rows[0];
  return { open: Number(r?.open ?? 0), settled: Number(r?.settled ?? 0), withKalshiLink: Number(r?.with_kalshi_link ?? 0) };
}

/**
 * `heartbeat.updated_at` for `saga/market-refresh` — "Last pass" on the page, NOT "last refresh".
 *
 * `sql/036_deadlines.sql` SEEDS this row at install (ORB-175's rule: a fresh install is green on
 * day one), and every completed pass stamps it again REGARDLESS of whether the refresh switch was
 * on — a schedule that finds itself off still runs and still needs to prove it is alive. Printing
 * this as "last refresh" would show an owner the migration's install timestamp, or a run in which
 * the switch was off and nothing was actually fetched, as evidence that a refresh happened.
 * {@link readLastObservation} is the number that can only be true when a refresh actually wrote
 * something.
 */
export async function readLastPass(): Promise<Date | null> {
  const { rows } = await pool.query<{ updated_at: Date }>(
    `SELECT updated_at FROM heartbeat WHERE agent = $1`,
    ["saga/market-refresh"],
  );
  return rows.length > 0 ? new Date(rows[0]!.updated_at) : null;
}

/**
 * `max(ts)` over `tyche_market_snapshots` — "Last observation": the newest instant the refresh job
 * actually recorded an observed venue price (`packages/agent-kit/src/markets/snapshots-store.ts`'s
 * `append`, its only writer). Unlike the heartbeat, this table is written ONLY when a refresh pass
 * observes something, so it is the honest answer to "did a refresh actually happen" — `null` when
 * no snapshot has ever been recorded, rendered as "never".
 */
export async function readLastObservation(): Promise<Date | null> {
  const { rows } = await pool.query<{ last_ts: Date | null }>(
    `SELECT max(ts) AS last_ts FROM tyche_market_snapshots`,
  );
  const v = rows[0]?.last_ts ?? null;
  return v === null ? null : new Date(v);
}

/** `"never"` for `null`; otherwise `YYYY-MM-DD HH:MM` (UTC) — the one format both timestamps on
 *  `/markets` share, since neither is owner-clock-significant the way a deadline's due date is. */
export function formatTimestamp(d: Date | null): string {
  return d === null ? "never" : d.toISOString().replace("T", " ").slice(0, 16);
}

export interface AlertStateRowDTO {
  marketId: string;
  marketLabel: string | null;
  outcomeId: string;
  lastEdge: number | null;
  lastBasis: number | null;
  updatedAt: Date;
}

/** The last N `tyche_alert_state` rows, newest first, joined to the market's label. A market
 *  deleted from the watchlist after the edge was recorded still shows its outcome id — the join
 *  is LEFT so a stale row is never dropped from the log. */
export async function readRecentAlertState(limit = 20): Promise<AlertStateRowDTO[]> {
  const { rows } = await pool.query<{
    market_id: string; market_label: string | null; outcome_id: string;
    last_edge: number | null; last_basis: number | null; updated_at: Date;
  }>(
    `SELECT a.market_id, m.label AS market_label, a.outcome_id, a.last_edge, a.last_basis, a.updated_at
     FROM tyche_alert_state a
     LEFT JOIN tyche_markets m ON m.id = a.market_id
     ORDER BY a.updated_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    marketId: r.market_id,
    marketLabel: r.market_label,
    outcomeId: r.outcome_id,
    lastEdge: r.last_edge === null ? null : Number(r.last_edge),
    lastBasis: r.last_basis === null ? null : Number(r.last_basis),
    updatedAt: new Date(r.updated_at),
  }));
}

export interface MarketsView {
  owner: string;
  settings: MarketsSettingsDTO;
  counts: MarketCounts;
  /** Heartbeat-only: the schedule ran, whether or not the switch was on or anything was fetched. */
  lastPass: Date | null;
  /** Only true when a refresh actually observed a price. */
  lastObservation: Date | null;
  recentAlerts: AlertStateRowDTO[];
  /** One line per read that failed, rendered at the top of the page — same contract as
   *  `ProactivityView.errors`. Empty on a healthy page. */
  errors: string[];
}

/** Each read is caught separately and reported by name — the `getProactivityView` pattern
 *  (`lib/proactivity.ts`). Adopted here for a reason this page has already met: the three
 *  `tyche_*` reads below touch tables the market engine owns, and on a box where the market
 *  refresh has never been installed those tables do not exist. `Promise.all` turned one missing
 *  table into a 500 on the whole page — including the REFRESH SWITCH, which is the one control an
 *  owner needs when the engine is in a bad state. */
async function attempt<T>(what: string, fallback: T, errors: string[], run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    console.error(`markets console: could not read ${what}`, e);
    errors.push(`${what} unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return fallback;
  }
}

export async function getMarketsView(): Promise<MarketsView> {
  const owner = ownerId();
  const errors: string[] = [];
  // The SETTINGS read is deliberately NOT wrapped: `markets_settings` ships in the same migration
  // as this page's own switch, so a failure there is not a degraded section — it is a console with
  // no controls, and a page that rendered a switch reading "off" on a failed read would be lying
  // about production, which is the one thing this surface must never do.
  const [settings, counts, lastPass, lastObservation, recentAlerts] = await Promise.all([
    readMarketsSettings(owner),
    attempt("watchlist", { open: 0, settled: 0, withKalshiLink: 0 } as MarketCounts, errors, readMarketCounts),
    attempt("last pass", null as Date | null, errors, readLastPass),
    attempt("last observation", null as Date | null, errors, readLastObservation),
    attempt("recorded edges", [] as AlertStateRowDTO[], errors, () => readRecentAlertState(20)),
  ]);
  return { owner, settings, counts, lastPass, lastObservation, recentAlerts, errors };
}
