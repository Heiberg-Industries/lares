import { getAgentDetail } from "../../../lib/agent-detail";
import { getAuditRows } from "../../../lib/queries";
import { AgentChip } from "../../../components/AgentChip";
import { PermissionsBoard } from "../../../components/PermissionsBoard";

export const dynamic = "force-dynamic";

export default async function AgentPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const detail = await getAgentDetail(name);
  const audit = (await getAuditRows(200)).filter((r) => r.agent === name).slice(0, 12);
  return (
    <>
      <h1 style={{ fontSize: 18 }}>
        <AgentChip name={detail.name} role={detail.role} />
      </h1>
      <p><a href={`/agents/${encodeURIComponent(name)}/edit`}>Edit definition</a></p>
      <h2 className="mono" style={{ fontSize: 13, color: "var(--mist)", margin: "20px 0 8px" }}>
        PERMISSIONS
      </h2>
      <PermissionsBoard detail={detail} />
      <h2 className="mono" style={{ fontSize: 13, color: "var(--mist)", margin: "24px 0 8px" }}>
        RECENT ACTIVITY
      </h2>
      <table className="card">
        <tbody>
          {audit.map((r, i) => (
            <tr key={i}>
              <td className="mono">{r.at}</td>
              <td className="mono">{r.action}</td>
              <td style={{ color: "var(--mist)" }}>{r.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
