"use client";
import Link from "next/link";
import { useState } from "react";
import {
  AgentAvatar,
  Col,
  EmptyState,
  PageHeader,
  Notice,
  Row,
  Rows,
} from "@lares/ui/patterns";
import { Badge } from "@lares/ui/primitives/badge";
import { Button } from "@lares/ui/primitives/button";
import { Card, CardHeader, CardTitle } from "@lares/ui/primitives/card";
import { Input } from "@lares/ui/primitives/input";
import { Plus, ArrowRight } from "@lares/ui/icons";
import type { FleetSnapshot } from "../lib/console-overview";
import { workflowState } from "../lib/workflow-state";
import styles from "./AgentsList.module.css";

// The work an agent has on record, in the owner's words. This is recorded work, not whether the agent is running.
const WORK: Record<ReturnType<typeof workflowState>, { words: string; variant: "neutral" | "warning" | "error" }> = {
  idle: { words: "No active work", variant: "neutral" },
  running: { words: "Active", variant: "neutral" },
  waiting: { words: "Waiting", variant: "warning" },
  failed: { words: "Failed work", variant: "error" },
  unavailable: { words: "Unavailable", variant: "neutral" },
};

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
  const header = !compact && (
    <PageHeader
      title="Agents"
      description="Give each agent a purpose. Keep their work and access in one place."
      actions={create}
    />
  );
  if (!snapshot.agents.available)
    return (
      <>
        {header}
        <Notice error>
          Agents are unavailable. Reload to try again; this does not mean your
          agents have been removed.
        </Notice>
      </>
    );
  return (
    <>
      {header}
      {!compact && (
        <Col span={4}>
          <Input
            aria-label="Find an agent"
            type="search"
            placeholder="Find an agent…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </Col>
      )}
      {!snapshot.workflows.available && (
        <Notice>
          The work each agent has on record could not be loaded. Names and
          access below are still correct.
        </Notice>
      )}
      {visible.length === 0 ? (
        <EmptyState
          title={agents.length === 0 ? "No agents yet" : "No agents found"}
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
            ? "Create an agent to give it a purpose and set its access. A new agent appears here once it is saved."
            : "Try another name or role."}
        </EmptyState>
      ) : (
        <Card>
          {!compact && (
            <CardHeader>
              <CardTitle aria-live="polite">
                {visible.length} {visible.length === 1 ? "agent" : "agents"}
              </CardTitle>
            </CardHeader>
          )}
          <Rows label="Agents">
            {visible.map((agent) => {
              const work = WORK[workflowState(snapshot, agent.name)];
              const capabilities = agent.grants
                .filter((g) => g.scope !== "none")
                .map((g) => g.capability);
              const shown = agent.displayName || agent.name;
              return (
                <Row
                  key={agent.name}
                  title={
                    <span className={styles.identity}>
                      <AgentAvatar role={agent.role} src={agent.avatarVersion ? `/api/agents/${encodeURIComponent(agent.name)}/avatar?v=${agent.avatarVersion}` : undefined} />
                      <span>
                        <Link href={`/agents/${encodeURIComponent(agent.name)}`}>
                          {shown}
                        </Link>
                        <span className={styles.role}>{agent.role}</span>
                  {capabilities.length ? (
                    <details className={styles.access}>
                      <summary>
                        Access to {capabilities.length}{" "}
                        {capabilities.length === 1 ? "integration" : "integrations"}
                      </summary>
                      <ul>
                        {capabilities.map((c) => (
                          <li key={c}>{c}</li>
                        ))}
                      </ul>
                    </details>
                  ) : (
                    <span className={styles.role}>No access set up</span>
                  )}
                      </span>
                    </span>
                  }
                  control={
                    <>
                      <Badge variant={work.variant}>{work.words}</Badge>
                      {agent.startedAt ? (
                        <Button variant="ghost" asChild>
                          <Link
                            href={`/chat/${encodeURIComponent(agent.name)}`}
                            aria-label={`Chat with ${shown}`}
                          >
                            Chat <ArrowRight aria-hidden="true" />
                          </Link>
                        </Button>
                      ) : (
                        <Badge>Not started</Badge>
                      )}
                    </>
                  }
                />
              );
            })}
          </Rows>
        </Card>
      )}
      <p className="lares-muted">
        The badge shows the work an agent has on record, not whether it is
        running right now. Work that is waiting may be waiting for you: answer
        it in the conversation where the agent asked.
      </p>
    </>
  );
}
