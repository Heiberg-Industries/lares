"use client";
import Link from "next/link";
import { useState } from "react";
import {
  AgentAvatar,
  EmptyState,
  PageHeader,
  Notice,
  StatusBadge,
} from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Input } from "@lares/ui/primitives/input";
import { Plus, ArrowRight } from "@lares/ui/icons";
import type { FleetSnapshot } from "../lib/console-overview";
import { workflowState } from "../lib/workflow-state";
import styles from "./AgentsList.module.css";
export function AgentsList({
  snapshot,
  compact = false,
}: {
  snapshot: FleetSnapshot;
  compact?: boolean;
}) {
  const [search, setSearch] = useState("");
  const agents = snapshot.agents.available ? snapshot.agents.value : [];
  const term = search.trim().toLocaleLowerCase();
  const visible = agents.filter((a) =>
    `${a.name} ${a.displayName} ${a.role}`.toLocaleLowerCase().includes(term),
  );
  const create = (
    <Button asChild>
      <Link href="/agents/new">
        <Plus aria-hidden="true" />
        Create agent
      </Link>
    </Button>
  );
  return (
    <section className="lares-page">
      {!compact && (
        <PageHeader
          title="Agents"
          description="Give each agent a purpose. Keep their work and access in one place."
          actions={create}
        />
      )}
      {!snapshot.agents.available ? (
        <Notice error>
          Agents are unavailable. Reload to try again; this does not mean your
          agents have been removed.
        </Notice>
      ) : (
        <>
          {!compact && (
            <div className={styles.toolbar}>
              <Input
                aria-label="Find an agent"
                type="search"
                placeholder="Find an agent…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <span className={styles.count} aria-live="polite">
                {visible.length} {visible.length === 1 ? "agent" : "agents"}
              </span>
            </div>
          )}
          {!snapshot.workflows.available && (
            <Notice>
              Workflow status is unavailable. Agent identities and access below
              are from the registry.
            </Notice>
          )}
          {visible.length === 0 ? (
            <EmptyState
              title={
                agents.length === 0
                  ? "No agents registered yet"
                  : "No agents found"
              }
              action={
                agents.length === 0 ? (
                  create
                ) : (
                  <Button variant="outline" onClick={() => setSearch("")}>
                    Clear search
                  </Button>
                )
              }
            >
              {agents.length === 0
                ? "Create an agent to give it a purpose and set its access. A new agent appears here after it starts and registers."
                : "Try another name or role."}
            </EmptyState>
          ) : (
            <div className={styles.frame}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Workflows</th>
                    <th>Access</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((agent) => {
                    const state = workflowState(snapshot, agent.name);
                    const capabilities = agent.grants
                      .filter((g) => g.scope !== "none")
                      .map((g) => g.capability);
                    return (
                      <tr key={agent.name}>
                        <td>
                          <div className={styles.identity}>
                            <AgentAvatar role={agent.role} />
                            <div>
                              <Link
                                className={styles.agentName}
                                href={`/agents/${encodeURIComponent(agent.name)}`}
                              >
                                {agent.displayName || agent.name}
                              </Link>
                              <span className={styles.role}>{agent.role}</span>
                            </div>
                          </div>
                        </td>
                        <td data-label="Workflows">
                          <StatusBadge
                            tone={
                              state === "failed"
                                ? "error"
                                : state === "waiting"
                                  ? "attention"
                                  : "quiet"
                            }
                          >
                            {state === "idle"
                              ? "No active work"
                              : state === "failed"
                                ? "Failed work"
                                : state === "waiting"
                                  ? "Waiting"
                                  : state === "running"
                                    ? "Active"
                                    : "Unavailable"}
                          </StatusBadge>
                        </td>
                        <td data-label="Access" className={styles.capabilities}>
                          {capabilities.length ? (
                            <details>
                              <summary>
                                {capabilities.length}{" "}
                                {capabilities.length === 1
                                  ? "capability"
                                  : "capabilities"}
                              </summary>
                              <ul>
                                {capabilities.map((c) => (
                                  <li key={c}>{c}</li>
                                ))}
                              </ul>
                            </details>
                          ) : (
                            "No access configured"
                          )}
                        </td>
                        <td>
                          <Button variant="ghost" asChild>
                            <Link
                              href={`/chat/${encodeURIComponent(agent.name)}`}
                              aria-label={`Chat with ${agent.displayName || agent.name}`}
                            >
                              Chat <ArrowRight aria-hidden="true" />
                            </Link>
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className={styles.hint}>
            Workflow state is recorded work, not a runtime health check. Waiting
            jobs may be waiting on events; review approvals in the original
            conversation.
          </p>
        </>
      )}
    </section>
  );
}
