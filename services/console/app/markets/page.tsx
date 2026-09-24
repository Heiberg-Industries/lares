import { formatTimestamp, getMarketsView, MARKETS_ENGINE } from "../../lib/markets";
import { RefreshSwitch, WatchlistSizeControl } from "../../components/MarketsControls";

export const dynamic = "force-dynamic";

/**
 * ORB-214 — the owner's surface for the market-refresh schedule: the refresh switch, the
 * watchlist size, counts from the watchlist, when it last ran, and the last 20 recorded edges.
 *
 * Every Tyche read below DEGRADES ON ITS OWN (review fix): the `tyche_*` tables belong to the
 * market engine and need not exist on a box where the refresh was never installed. A failed read
 * shows a named line at the top and an empty section beneath it — never a 500 that takes the
 * refresh switch down with it, which is the one control an owner needs when the engine is broken.
 * `/proactivity` renders `view.errors` the same way.
 */
const lede = { color: "var(--mist)", fontSize: 12, marginTop: 4 } as const;

export default async function MarketsPage() {
  const view = await getMarketsView();

  return (
    <>
      <h1 className="mono" style={{ fontSize: 18 }}>Markets</h1>
      <p style={lede}>
        Proactive alerts stay OFF — this only refreshes what <span className="mono">market-edge</span> can
        answer when asked. Nothing here posts anywhere on its own.
      </p>

      {view.errors.length > 0 && (
        <div className="card" style={{ padding: 12, marginTop: 12, borderColor: "var(--bad)" }}>
          {view.errors.map((e) => <p key={e} className="mono" style={{ color: "var(--bad)", fontSize: 12, margin: 0 }}>{e}</p>)}
        </div>
      )}

      <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>Refresh</h2>
      <RefreshSwitch enabled={view.settings.refreshEnabled} />

      <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>Watchlist size</h2>
      <WatchlistSizeControl value={view.settings.watchlistMax} engineMax={MARKETS_ENGINE.watchlistMax} />

      <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>Watchlist</h2>
      <table className="card" style={{ marginTop: 8, maxWidth: 480 }}>
        <tbody>
          <tr><td>Open</td><td className="mono">{view.counts.open}</td></tr>
          <tr><td>Settled</td><td className="mono">{view.counts.settled}</td></tr>
          <tr><td>With a Kalshi link</td><td className="mono">{view.counts.withKalshiLink}</td></tr>
          <tr>
            <td>Last pass</td>
            <td className="mono">{formatTimestamp(view.lastPass)}</td>
          </tr>
          <tr>
            <td>Last observation</td>
            <td className="mono">{formatTimestamp(view.lastObservation)}</td>
          </tr>
        </tbody>
      </table>
      <p style={lede}>
        Last pass is the schedule proving it is alive — it stamps even when the switch is off or
        nothing was fetched. Last observation is the newest price a refresh actually recorded.
      </p>

      <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>
        Last 20 recorded edges <span style={{ color: "var(--mist)", fontSize: 12 }}>({view.recentAlerts.length} shown)</span>
      </h2>
      <table className="card" style={{ marginTop: 8 }}>
        <thead><tr><th>Market</th><th>Outcome</th><th>Edge</th><th>Recorded</th></tr></thead>
        <tbody>
          {view.recentAlerts.length === 0 && (
            <tr><td colSpan={4} style={{ color: "var(--mist)" }}>Nothing recorded yet.</td></tr>
          )}
          {view.recentAlerts.map((a) => (
            <tr key={`${a.marketId}:${a.outcomeId}`}>
              <td style={{ fontSize: 13 }}>{a.marketLabel ?? a.marketId}</td>
              <td className="mono" style={{ fontSize: 12, color: "var(--mist)" }}>{a.outcomeId}</td>
              <td className="mono" style={{ fontSize: 12 }}>{a.lastEdge === null ? "—" : a.lastEdge.toFixed(3)}</td>
              <td className="mono" style={{ fontSize: 12, color: "var(--mist)" }}>{a.updatedAt.toISOString().replace("T", " ").slice(0, 16)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
