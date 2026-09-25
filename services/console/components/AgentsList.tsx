"use client";

import Link from "next/link";
import { useState } from "react";
import type { AgentSummaryDTO } from "../lib/contracts";
import { StatePill } from "./StatePill";
import styles from "./AgentsList.module.css";

function capabilitiesLabel(capabilities: string[]): string {
  if (capabilities.length === 0) return "No access configured";
  if (capabilities.length <= 2) return capabilities.join(", ");
  return `${capabilities.slice(0, 2).join(", ")} +${capabilities.length - 2} more`;
}

export function AgentsList({ agents }: { agents: AgentSummaryDTO[] }) {
  const [search, setSearch] = useState("");
  const term = search.trim().toLocaleLowerCase();
  const visible = term
    ? agents.filter((agent) => `${agent.name} ${agent.role}`.toLocaleLowerCase().includes(term))
    : agents;

  return (
    <section className={styles.page} aria-labelledby="agents-title">
      <header className={styles.header}>
        <div>
          <h1 id="agents-title">Agents</h1>
          <p>Give each agent a purpose. Keep their work and access in one place.</p>
        </div>
        <Link className={styles.primaryAction} href="/agents/new">Create agent <span aria-hidden="true">＋</span></Link>
      </header>

      <div className={styles.toolbar}>
        <input
          aria-label="Find an agent"
          type="search"
          placeholder="Find an agent…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <span className={styles.count} aria-live="polite">{visible.length} {visible.length === 1 ? "agent" : "agents"}</span>
      </div>

      {visible.length === 0 ? (
        <div className={styles.empty}>
          <h2>{agents.length === 0 ? "No agents yet" : "No agents found"}</h2>
          <p>{agents.length === 0 ? "Create an agent to give it a purpose and set its access." : "Try another name or role."}</p>
          {agents.length === 0 && <Link className={styles.primaryAction} href="/agents/new">Create agent</Link>}
        </div>
      ) : (
        <div className={styles.frame}>
          <table className={styles.table}>
            <thead><tr><th>Agent</th><th>Status</th><th>Needs you</th><th>Access</th><th><span className={styles.srOnly}>Actions</span></th></tr></thead>
            <tbody>
              {visible.map((agent) => (
                <tr key={agent.name}>
                  <td>
                    <Link className={styles.agentName} href={`/agents/${encodeURIComponent(agent.name)}`}>{agent.name}</Link>
                    <span className={styles.role}>{agent.role}</span>
                  </td>
                  <td><StatePill state={agent.status} /></td>
                  <td>{agent.pendingApprovals > 0 ? `${agent.pendingApprovals} pending` : "—"}</td>
                  <td className={styles.capabilities} title={agent.capabilities.join(", ")}>{capabilitiesLabel(agent.capabilities)}</td>
                  <td><Link className={styles.chatAction} href={`/chat/${encodeURIComponent(agent.name)}`}>Chat <span aria-hidden="true">→</span></Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className={styles.hint}>Choose an agent to see its permissions and recent activity.</p>
    </section>
  );
}
