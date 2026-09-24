import Link from "next/link";
import { getAgentSummaries } from "../lib/queries";
import { AgentChip } from "../components/AgentChip";
import { StatePill } from "../components/StatePill";

export const dynamic = "force-dynamic";

export default async function FleetPage() {
  const agents = await getAgentSummaries();
  return (
    <>
      <h1 className="mono" style={{ fontSize: 18 }}>Fleet</h1>
      <p><Link href="/agents/new">Create an agent</Link></p>
      <table className="card" style={{ marginTop: 16 }}>
        <thead>
          <tr>
            <th>Agent</th>
            <th>Status</th>
            <th>Pending</th>
            <th>Capabilities</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.name}>
              <td>
                <Link href={`/agents/${a.name}`}>
                  <AgentChip name={a.name} role={a.role} />
                </Link>
              </td>
              <td><StatePill state={a.status} /></td>
              <td className="mono">{a.pendingApprovals || ""}</td>
              <td className="mono" style={{ color: "var(--mist)" }}>{a.capabilities.join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
