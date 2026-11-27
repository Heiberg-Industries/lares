"use client";
import type { ReactNode } from "react";
import Link from "next/link";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@lares/ui/primitives/tabs";
import { Button } from "@lares/ui/primitives/button";
import { Badge } from "@lares/ui/primitives/badge";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@lares/ui/primitives/card";
import {
  AgentAvatar,
  PageHeader,
  Notice,
  Row,
  Rows,
  RunStatus,
} from "@lares/ui/patterns";
import type { AgentFolder } from "../lib/agents";
import type { BoardRowDTO } from "../lib/contracts";
import type { EventPage, Reading } from "../lib/console-overview";
import { AutonomyControl } from "./AutonomyControl";
import { PermissionEvents } from "./PermissionEvents";
import { OutsideToolsSection, type OutsideToolView } from "./OutsideToolsSection";
import type { ConnectionApplication } from "../lib/outside-connector-words";
import { DeliveryGrid, type DeliveryGridProps } from "./DeliveryGrid";
import type { OutsideToolEvidence } from "../lib/outside-tools";
import type { AgentStatus } from "../lib/agent-detail";
import { scheduleExplanation, scheduleLabel } from "../lib/schedule-labels";
import type { ScheduleLastRun } from "../lib/schedule-runs";
import { RefreshWhileRunning } from "./RefreshWhileRunning";
import styles from "./AgentDetail.module.css";

// One badge and one sentence per status. "Running" is only said when the server reports the agent as started and answering.
const STATUS: Record<AgentStatus, { words: string; variant: "neutral" | "success" | "warning"; detail: string }> = {
  running: { words: "Running", variant: "success", detail: "Started and answering." },
  starting: { words: "Starting", variant: "warning", detail: "Started, not answering yet. A first start after an upgrade can take several minutes; reload to check." },
  stopped: { words: "Stopped", variant: "neutral", detail: "This agent is not running. Edit agent shows why and how to start it." },
  "changes-waiting": { words: "Changes waiting", variant: "warning", detail: "Saved changes have not been applied yet. Apply them in Edit agent." },
  "not-started": { words: "Not started", variant: "neutral", detail: "This agent has not been started yet." },
  retired: { words: "Retired", variant: "neutral", detail: "This agent is retired and stopped." },
  unknown: { words: "Status unavailable", variant: "neutral", detail: "Whether this agent is running could not be read. Reload to try again." },
};
export function AgentDetail({
  agent,
  board,
  events,
  schedules,
  routing,
  outsideTools = { tools: [], inEffect: true },
  promptCache = null,
  accessSettings,
  providerKeySettings,
  mailboxSettings,
  waiting = false,
  status = "unknown",
  owner,
}: {
  agent: AgentFolder;
  board: Reading<BoardRowDTO[]>;
  events: Reading<EventPage>;
  /** Each schedule's switch and, for one that is on, its last run (`lib/schedule-runs.ts`); null when nothing is recorded. */
  schedules: Reading<Array<{ name: string; on: boolean; lastRun?: ScheduleLastRun | null }>>;
  /** The delivery grid's inputs; absent when the definition could not be read or the agent sends nothing on its own. */
  routing?: Omit<DeliveryGridProps, "agent">;
  outsideTools?: { tools: OutsideToolView[]; inEffect: boolean; evidence?: OutsideToolEvidence; dangerLive?: Record<string, string[]>;
    /** Per connection, whether it reached the agent; null when that could not be read. */
    applied?: Record<string, ConnectionApplication> | null };
  /** The finished prompt-cache sentence; null when it could not be read (the line is then left out). */
  promptCache?: string | null;
  /** Who may use or edit this agent, shown first on the Access tab; absent when the definition could not be read. */
  accessSettings?: ReactNode;
  /** The agent's own model key section, shown after the access settings. */
  providerKeySettings?: ReactNode;
  /** Which Google mailbox the agent works on; only chief-of-staff agents have one. */
  mailboxSettings?: ReactNode;
  /** The agent has saved changes that are not applied yet. */
  waiting?: boolean;
  /** What the agent is doing, from the state the server reports; `unknown` when it could not be read. */
  status?: AgentStatus;
  /** True for the owner. Editing the agent and changing how freely it acts are the owner's. */
  owner: boolean;
}) {
  const edit = `/agents/${encodeURIComponent(agent.name)}/edit`;
  const state = STATUS[status];
  const access = agent.grants.filter((g) => g.scope !== "none").length;
  const groups = [
    {
      title: "You decide",
      scope: "write-with-confirm",
      help: "The agent asks you first, unless you choose otherwise here. A change saves at once and applies from the agent’s next action.",
    },
    {
      title: "Acts without asking",
      scope: "write",
      help: "The agent may change these without asking. To change that, open Edit agent.",
    },
    {
      title: "Reads",
      scope: "read",
      help: "The agent may read these.",
    },
  ];
  const scheduleRows = (on: boolean) =>
    schedules.available &&
    schedules.value.filter((s) => s.on === on).map((s) => (
      <Row
        key={s.name}
        title={scheduleLabel(s.name)}
        description={scheduleExplanation(s.name) || undefined}
        control={<Badge variant={on ? "success" : "neutral"}>{on ? "On" : "Off"}</Badge>}
      >
        {on && s.lastRun !== undefined && (s.lastRun
          ? <RunStatus label={`${scheduleLabel(s.name)}, last run`} state={s.lastRun.state} when={s.lastRun.when} why={s.lastRun.why} />
          : <p className="lares-muted">No run recorded yet.</p>)}
      </Row>
    ));
  return (
    <>
      <div>
        <Link href="/agents">← Agents</Link>
      </div>
      <div className={styles.identity}>
        <AgentAvatar role={agent.role} src={agent.avatarVersion ? `/api/agents/${encodeURIComponent(agent.name)}/avatar?v=${agent.avatarVersion}` : undefined} />
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
        <TabsContent value="overview" className="lares-stack">
          {waiting && (
            <Notice tone="needs-you">
              Changes are waiting: <Link href={edit}>open Edit agent</Link> to apply them.
            </Notice>
          )}
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={2}>About this agent</CardTitle>
            </CardHeader>
            <Rows label="About this agent">
              <Row
                title="Status"
                description={
                  status === "not-started" ? (
                    <>
                      Not started yet. Take ownership of it on the Access tab, then run{" "}
                      <code>sudo lares agent start {agent.name}</code> on the server.
                    </>
                  ) : (
                    state.detail
                  )
                }
                control={<Badge variant={state.variant}>{state.words}</Badge>}
              />
              <Row
                title={agent.role}
                description={<>Permanent name: <span className="mono">{agent.name}</span></>}
              />
              {agent.startedAt && (
                <Row
                  title="Last started"
                  description={
                    <>
                      <time dateTime={agent.startedAt}>
                        {agent.startedAt.replace("T", " ").slice(0, 19)} UTC
                      </time>
                      . This is when it last started, not a check that it is running now.
                    </>
                  }
                />
              )}
              <Row
                title="Access and skills"
                description={`Access to ${access} ${access === 1 ? "integration" : "integrations"} · ${agent.skills.length} ${agent.skills.length === 1 ? "skill" : "skills"}`}
              />
              {promptCache && <Row title="Model use" description={promptCache} />}
            </Rows>
            <CardFooter>
              <Link href={edit}>
                Edit instructions, personality and model →
              </Link>
            </CardFooter>
          </Card>
          <section>
            <h2 className="lares-section-title">Recent permission checks</h2>
            <PermissionEvents events={events} />
          </section>
        </TabsContent>
        <TabsContent value="access" className="lares-stack">
          {accessSettings}
          {mailboxSettings}
          {providerKeySettings}
          <OutsideToolsSection agent={agent.name} tools={outsideTools.tools} inEffect={outsideTools.inEffect} evidence={outsideTools.evidence} dangerLive={outsideTools.dangerLive} applied={outsideTools.applied} />
          {!board.available ? (
            <Notice error>
              Access controls could not be loaded. Reload before changing
              permissions.
            </Notice>
          ) : (
            <>
              {groups.map((group) => {
                const rows = board.value.filter((r) => r.scope === group.scope);
                return (
                  <Card key={group.scope}>
                    <CardHeader>
                      <CardTitle role="heading" aria-level={2}>{group.title}</CardTitle>
                      <CardDescription>{group.help}</CardDescription>
                    </CardHeader>
                    {!rows.length ? (
                      <CardContent className="lares-muted">No access in this group.</CardContent>
                    ) : (
                      <Rows label={group.title}>
                        {rows.map((row) => (
                          <Row
                            key={`${row.capability}:${row.action}`}
                            title={`${row.capability}${row.actionLabel ? ` · ${row.actionLabel}` : ""}`}
                            description={
                              row.controllable
                                ? `${row.source.kind === "board" ? `Set by ${row.source.by}` : "From its starting setup"} · asked you ${row.evidence.asked} ${row.evidence.asked === 1 ? "time" : "times"}, went ahead without asking ${row.evidence.autonomous} ${row.evidence.autonomous === 1 ? "time" : "times"} in the last 30 days.`
                                : undefined
                            }
                            control={
                              row.controllable ? (
                                <AutonomyControl
                                  agent={agent.name}
                                  capability={row.capability}
                                  action={row.action || undefined}
                                  level={row.level}
                                  canChange={owner}
                                />
                              ) : undefined
                            }
                          >
                            {row.controllable && row.lockedTools.length > 0 && (
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
                          </Row>
                        ))}
                      </Rows>
                    )}
                  </Card>
                );
              })}
              <Button variant="outline" asChild>
                <Link href="/meeting-follow-ups">Meeting follow-up controls →</Link>
              </Button>
            </>
          )}
        </TabsContent>
        <TabsContent value="schedules" className="lares-stack">
          {/* A schedule that is running now: the page follows it until its run is recorded as done. */}
          {schedules.available && schedules.value.some((s) => s.on && s.lastRun?.state === "running") && <RefreshWhileRunning active />}
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={2}>Recurring work</CardTitle>
              <CardDescription>
                {schedules.available && schedules.value.some((s) => s.on && s.lastRun !== undefined)
                  ? "Each schedule that is on shows when it last ran, from what it recorded."
                  : "On means the setting is saved. It does not confirm the next run."}
              </CardDescription>
            </CardHeader>
            {!schedules.available ? (
              <CardContent>
                <Notice>
                  The saved schedules could not be loaded. Open Edit agent to
                  see them.
                </Notice>
              </CardContent>
            ) : schedules.value.length ? (
              <>
                {schedules.value.some((s) => s.on) ? (
                  <Rows label="Recurring work that is on">{scheduleRows(true)}</Rows>
                ) : (
                  <CardContent className="lares-muted">No recurring work is on.</CardContent>
                )}
                {schedules.value.some((s) => !s.on) && (
                  <CardContent>
                    <details>
                      <summary>Schedules that are off ({schedules.value.filter((s) => !s.on).length})</summary>
                      <Rows label="Schedules that are off">{scheduleRows(false)}</Rows>
                    </details>
                  </CardContent>
                )}
              </>
            ) : (
              <CardContent className="lares-muted">
                No schedules yet. This agent has no recurring work.
              </CardContent>
            )}
            <CardFooter>
              <Button variant="outline" asChild>
                <Link href={edit}>Edit schedules</Link>
              </Button>
            </CardFooter>
          </Card>
          {routing && (
            <Card>
              <CardHeader>
                <CardTitle role="heading" aria-level={2}>Where messages go</CardTitle>
              </CardHeader>
              <CardContent>
                <DeliveryGrid agent={agent.name} {...routing} />
              </CardContent>
            </Card>
          )}
        </TabsContent>
        <TabsContent value="activity" className="lares-stack">
          <p className="lares-muted">
            Each time this agent checked whether it was allowed to do
            something. This is not a list of everything it did, and it does
            not show that a task was finished.
          </p>
          <PermissionEvents events={events} />
          <Link href={`/permission-checks?agent=${encodeURIComponent(agent.name)}`}>
            View all checks →
          </Link>
        </TabsContent>
      </Tabs>
    </>
  );
}
