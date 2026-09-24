import { getAuditRows } from "../../lib/queries";

export const dynamic = "force-dynamic";

export default async function ActivityPage() {
  const rows = await getAuditRows(100);
  return (
    <>
      <h1 className="mono" style={{ fontSize: 18 }}>Activity</h1>
      <table className="card" style={{ marginTop: 16 }}>
        <thead>
          <tr>
            <th>When</th>
            <th>Agent</th>
            <th>Action</th>
            <th>Summary</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="mono">{r.at}</td>
              <td className="mono">{r.agent}</td>
              <td className="mono">{r.action}</td>
              <td style={{ color: "var(--mist)" }}>{r.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
