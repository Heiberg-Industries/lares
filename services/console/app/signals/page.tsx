import Link from "next/link";
import { getRecentSignals } from "../../lib/signals";

export const dynamic = "force-dynamic";
const ICON = { error: "🔴", warn: "🟠", info: "⚪" } as const;
const isHttpUrl = (u: string) => /^https?:\/\//i.test(u);

export default async function SignalsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const r = await getRecentSignals({ severity: q.severity, project: q.project, kind: q.kind, state: q.state, since: q.since });
  return (
    <>
      <h1 className="mono" style={{ fontSize: 18 }}>Signals</h1>
      <p className="mono" style={{ fontSize: 12, marginTop: 4 }}>
        <Link href="/signals">Recent</Link> · <Link href="/signals/rules">Routes</Link> · <Link href="/signals/catalogue">Catalogue</Link>
      </p>
      <form method="get" className="mono" style={{ marginTop: 12, display: "flex", gap: 8, fontSize: 12 }}>
        <select name="severity" defaultValue={q.severity ?? ""}><option value="">any severity</option><option>error</option><option>warn</option><option>info</option></select>
        <select name="kind" defaultValue={q.kind ?? ""}><option value="">any kind</option><option>alert</option><option>event</option><option>report</option></select>
        <select name="state" defaultValue={q.state ?? ""}><option value="">any state</option><option>open</option><option>recovered</option><option>closed</option></select>
        <input name="project" placeholder="project" defaultValue={q.project ?? ""} />
        <button type="submit">filter</button>
      </form>
      {"unavailable" in r ? (
        <p className="mono" style={{ marginTop: 12, color: "var(--bad)" }}>Spine unavailable — the record could not be read.</p>
      ) : r.signals.length === 0 ? (
        <p className="mono" style={{ marginTop: 12, color: "var(--mist)" }}>Nothing in this window.</p>
      ) : (
        <table className="mono" style={{ marginTop: 12, fontSize: 12, borderCollapse: "collapse", width: "100%" }}>
          <thead><tr><th align="left">when</th><th align="left">what</th><th align="left">count</th><th align="left">state</th><th align="left">source</th></tr></thead>
          <tbody>
            {r.signals.map((s) => (
              <tr key={`${s.fingerprint}:${s.occurrence}`} style={{ borderTop: "1px solid var(--rule)" }}>
                <td>{s.lastSeen.slice(0, 16).replace("T", " ")}</td>
                <td>{s.kind === "report" ? "🔵" : s.state === "recovered" ? "🟢" : s.kind === "event" ? "⚪" : ICON[s.severity]} <b>{s.project}</b> · {s.title}
                  {s.description && <div style={{ color: "var(--mist)" }}>{s.description}</div>}
                  {s.url && isHttpUrl(s.url) && <> · <a href={s.url} rel="noopener noreferrer">details</a></>}{s.linearRef && <> · {s.linearRef}</>}</td>
                <td>{s.count}</td><td>{s.state}</td><td>{s.source} · {s.type}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
