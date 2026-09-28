import Link from "next/link";
import { getRecentSignals } from "../../lib/signals";
import { Notice, PageHeader } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";

export const dynamic = "force-dynamic";
const ICON = { error: "🔴", warn: "🟠", info: "⚪" } as const;
const isHttpUrl = (u: string) => /^https?:\/\//i.test(u);

export default async function SignalsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const r = await getRecentSignals({ severity: q.severity, project: q.project, kind: q.kind, state: q.state, since: q.since });
  return (
    <div className="lares-page lares-operational">
      <PageHeader title="Signals" description="Recent recorded alerts, events and reports." />
      <nav className="lares-actions" aria-label="Signals sections">
        <Link href="/signals" aria-current="page">Recent</Link>
        <Link href="/signals/rules">Routes</Link>
        <Link href="/signals/catalogue">Catalogue</Link>
      </nav>
      {"unavailable" in r ? (
        <Notice error>Signals could not be loaded because the record service is unavailable. Check its service status, then reload this page. Routes and catalogue remain available above.</Notice>
      ) : <>
      <form method="get" className="lares-inline-form lares-operational-filter">
        <label className="lares-field-label">Severity<select className="lares-field" name="severity" defaultValue={q.severity ?? ""}><option value="">Any severity</option><option>error</option><option>warn</option><option>info</option></select></label>
        <label className="lares-field-label">Kind<select className="lares-field" name="kind" defaultValue={q.kind ?? ""}><option value="">Any kind</option><option>alert</option><option>event</option><option>report</option></select></label>
        <label className="lares-field-label">State<select className="lares-field" name="state" defaultValue={q.state ?? ""}><option value="">Any state</option><option>open</option><option>recovered</option><option>closed</option></select></label>
        <label className="lares-field-label">Project<input className="lares-field" name="project" placeholder="All projects" defaultValue={q.project ?? ""} /></label>
        <Button type="submit" variant="outline">Filter</Button>
      </form>
      {r.signals.length === 0 ? (
        <Notice>Nothing recorded for these filters.</Notice>
      ) : (
        <div className="lares-table-scroll"><table className="card" style={{ marginTop: 12, borderCollapse: "collapse", width: "100%" }}>
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
        </table></div>
      )}</>}
    </div>
  );
}
