"use client";
import Link from "next/link";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@lares/ui/primitives/tabs";
import { Button } from "@lares/ui/primitives/button";
import {
  AgentAvatar,
  PageHeader,
  Notice,
  EmptyState,
} from "@lares/ui/patterns";
import type { AgentFolder } from "../lib/agents";
import type { BoardRowDTO } from "../lib/contracts";
import type { EventPage, Reading } from "../lib/console-overview";
import { AutonomyControl } from "./AutonomyControl";
import { PermissionEvents } from "./PermissionEvents";
import styles from "./AgentDetail.module.css";
export function AgentDetail({
  agent,
  board,
  events,
  schedules,
}: {
  agent: AgentFolder;
  board: Reading<BoardRowDTO[]>;
  events: Reading<EventPage>;
  schedules: Reading<Array<{ name: string; on: boolean }>>;
}) {
  const edit = `/agents/${encodeURIComponent(agent.name)}/edit`;
  const groups = [
    {
      title: "You decide",
      scope: "write-with-confirm",
      help: "Approval-controlled access. Changes save immediately and reach the agent at its next policy check.",
    },
    {
      title: "Acts without asking",
      scope: "write",
      help: "Plain write access from the definition. Change it in Edit agent.",
    },
    {
      title: "Reads",
      scope: "read",
      help: "Read access is allowed while granted.",
    },
  ];
  return (
    <div className="lares-page">
      <div className={styles.back}>
        <Link href="/agents">← Agents</Link>
      </div>
      <div className={styles.identity}>
        <AgentAvatar role={agent.role} />
        <PageHeader
          title={agent.displayName || agent.name}
          description={agent.role}
          actions={
            <>
              <Button asChild>
                <Link href={`/chat/${encodeURIComponent(agent.name)}`}>
                  Chat →
                </Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href={edit}>Edit agent</Link>
              </Button>
            </>
          }
        />
      </div>
      <Tabs defaultValue="overview">
        <TabsList variant="line" className={styles.tabs}>
          {["Overview", "Access", "Schedules", "Activity"].map((t) => (
            <TabsTrigger key={t} value={t.toLowerCase()}>
              {t}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview">
          <div className="lares-stack">
            <section className="lares-surface">
              <h2 className="lares-section-title">About this agent</h2>
              <p>
                {agent.role} · <span className="mono">{agent.name}</span>
              </p>
              <p className="lares-muted">
                Last registered:{" "}
                <time dateTime={agent.startedAt}>
                  {agent.startedAt.replace("T", " ").slice(0, 19)} UTC
                </time>
                . Registration is not a current health check.
              </p>
              <p>
                {agent.grants.filter((g) => g.scope !== "none").length} granted
                capabilities · {agent.skills.length} skills
              </p>
              <Link href={edit}>
                Edit instructions, personality and model →
              </Link>
            </section>
            <section className="lares-surface">
              <h2 className="lares-section-title">Recent permission checks</h2>
              <PermissionEvents events={events} />
            </section>
          </div>
        </TabsContent>
        <TabsContent value="access">
          {!board.available ? (
            <Notice error>
              Access controls are unavailable. Reload before changing
              permissions.
            </Notice>
          ) : (
            <div className="lares-stack">
              {groups.map((group) => {
                const rows = board.value.filter((r) => r.scope === group.scope);
                return (
                  <section key={group.scope} className="lares-surface">
                    <h2 className="lares-section-title">{group.title}</h2>
                    <p className="lares-muted">{group.help}</p>
                    {!rows.length ? (
                      <p>No access in this group.</p>
                    ) : (
                      <ul className="lares-data-list">
                        {rows.map((row) => (
                          <li key={`${row.capability}:${row.action}`}>
                            <div className={styles.accessRow}>
                              <strong>
                                {row.capability}
                                {row.actionLabel ? ` · ${row.actionLabel}` : ""}
                              </strong>
                              {row.controllable && (
                                <AutonomyControl
                                  agent={agent.name}
                                  capability={row.capability}
                                  action={row.action || undefined}
                                  level={row.level}
                                />
                              )}
                            </div>
                            {row.controllable && (
                              <>
                                <p className="lares-muted">
                                  {row.source.kind === "board"
                                    ? `Set by ${row.source.by}`
                                    : "Starting definition"}{" "}
                                  · {row.evidence.asked} asked,{" "}
                                  {row.evidence.autonomous} allowed by policy in
                                  30 days.
                                </p>
                                {row.lockedTools.length > 0 && (
                                  <details>
                                    <summary>Actions that still ask</summary>
                                    <ul>
                                      {row.lockedTools.map((t) => (
                                        <li key={t.tool}>
                                          {t.tool} — {t.reason}
                                        </li>
                                      ))}
                                    </ul>
                                  </details>
                                )}
                              </>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
              <Button variant="outline" asChild>
                <Link href="/meetings">Meeting follow-up controls →</Link>
              </Button>
            </div>
          )}
        </TabsContent>
        <TabsContent value="schedules">
          <section className="lares-surface">
            <h2 className="lares-section-title">Recurring work</h2>
            {!schedules.available ? (
              <Notice>
                Saved schedules are unavailable. Open Edit agent to inspect the
                definition.
              </Notice>
            ) : schedules.value.length ? (
              <ul className="lares-data-list">
                {schedules.value.map((s) => (
                  <li key={s.name}>
                    {s.name} · {s.on ? "Enabled" : "Disabled"}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No schedules configured">
                This definition has no recurring work.
              </EmptyState>
            )}
            <p className="lares-muted">
              Enabled is a saved setting, not confirmation of the next run.
            </p>
            <Button variant="outline" asChild>
              <Link href={edit}>Edit schedules</Link>
            </Button>
          </section>
        </TabsContent>
        <TabsContent value="activity">
          <section className="lares-surface">
            <p className="lares-muted">
              Permission policy evidence for this agent. It does not include
              every action or prove completion.
            </p>
            <PermissionEvents events={events} />
            <Link href={`/activity?agent=${encodeURIComponent(agent.name)}`}>
              View all checks →
            </Link>
          </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}
