import Link from "next/link";
import { listAgents } from "../../lib/agents";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const agents = await listAgents();
  return (
    <>
      <h1 className="mono" style={{ fontSize: 18 }}>Chat</h1>
      {agents.length === 0 ? (
        <p style={{ color: "var(--mist)", marginTop: 16 }}>No agent has registered itself yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, marginTop: 16 }}>
          {agents.map((agent) => (
            <li key={agent.name} className="card" style={{ padding: "10px 12px", marginBottom: 8 }}>
              <Link href={`/chat/${encodeURIComponent(agent.name)}`} className="mono" style={{ fontSize: 14 }}>
                {agent.displayName}
              </Link>
              <span className="mono" style={{ marginLeft: 8, fontSize: 12, color: "var(--mist)" }}>
                {agent.role}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
