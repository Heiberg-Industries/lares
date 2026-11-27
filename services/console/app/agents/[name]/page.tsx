import { AgentAccess } from "../../../components/AgentAccess";
import { agentAccess } from "../../../lib/agent-access";
import { cookies } from "next/headers";
import { AgentMailbox } from "../../../components/AgentMailbox";
import { agentMailboxView, mailboxUnavailableView } from "../../../lib/agent-mailbox";
import { AgentProviderKey } from "../../../components/AgentProviderKey";
import { providerKeyStatusFor } from "../../../lib/provider-key";
import { mayUse, memberAuditAddress, members, requirePage } from "../../../lib/auth";
import { notFound } from "next/navigation";
import { Notice, PageHeader, Page } from "@lares/ui/patterns";
import { listAgents, savedAgentFolder } from "../../../lib/agents";
import { getBoardRows } from "../../../lib/board";
import { builderData } from "../../../lib/builder";
import { getPermissionEvents } from "../../../lib/console-overview";
import { checkOutsideUrl, outsideToolsInEffect } from "@lares/agent-kit/outside-tools";
import { AgentDetail } from "../../../components/AgentDetail";
import { getOutsideToolEvidence } from "../../../lib/outside-tools";
import { liveDangerTools } from "../../../lib/outside-connector-view";
import { connectApplicationStates } from "../../actions/outside-connect";
import { fallbackNotes } from "../../../lib/delivery-notes";
import { agentStatus, getPromptCacheLine } from "../../../lib/agent-detail";
import { readScheduleLastRuns } from "../../../lib/schedule-runs";
export const dynamic = "force-dynamic";
export default async function AgentPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const actor = await requirePage("admin");
  const { name } = await params;
  let agents;
  try {
    agents = await listAgents({ strict: true });
  } catch {
    return (
      <Page>
        <PageHeader title="Agent unavailable" />
        <Notice error>
          The list of agents could not be read. Reload to try again.
        </Notice>
      </Page>
    );
  }
  const [board, definition, events, promptCache] = await Promise.allSettled([
    getBoardRows({ strict: true }),
    builderData(name),
    getPermissionEvents({ agent: name, limit: 12 }),
    getPromptCacheLine(name),
  ]);
  const saved =
    definition.status === "fulfilled" ? definition.value.initial?.definition : undefined;
  const agent = agents.find((a) => a.name === name) ?? (saved ? savedAgentFolder(name, saved) : undefined);
  if (!agent) notFound();
  const outsideTools = saved
    ? {
        tools: (saved.outsideTools ?? []).map((t) => {
          const url = checkOutsideUrl(t.url);
          return { ...t, host: url.ok ? url.host : undefined };
        }),
        inEffect: outsideToolsInEffect(saved).length > 0,
        // Asked only when there is something to show; never throws (each half can be unavailable).
        evidence: saved.outsideTools?.length ? await getOutsideToolEvidence(name) : undefined,
        dangerLive: await liveDangerTools(name, saved.outsideTools ?? []),
        // Whether each connection reached the agent (the keeper's read), for its badge.
        applied: saved.outsideTools?.length
          ? await connectApplicationStates({ agents: [name] }).then((r) => (r.ok ? r.value[name] ?? null : null)).catch(() => null)
          : undefined,
      }
    : undefined;
  // The delivery grid belongs to agents that start messages on their own (the chief of staff).
  const routing =
    saved && saved.role === "chief-of-staff"
      ? {
          delivery: saved.delivery,
          connected: {
            slack: agent.doors.some((d) => d.kind === "slack" && d.enabled),
            telegram: agent.doors.some((d) => d.kind === "telegram" && d.enabled),
          },
          notes: await fallbackNotes(name),
          running: definition.status === "fulfilled" ? definition.value.initial?.runtime?.running : undefined,
        }
      : undefined;
  // Who may use or edit the agent, and the agent's own model key, are the owner's: an admin is not
  // shown them, and the member directory and the key state are not read for an admin at all.
  const owner = mayUse(actor, "owner");
  const access = owner ? await agentAccess.agentAccess(actor.id,name) : undefined;
  const directory = owner ? await members.listMembers(actor.id) : [];
  const sessionToken = (await cookies()).get("lares_session")?.value;
  const auditAddress = owner ? await memberAuditAddress(actor.id) : null;
  const providerKey = owner ? sessionToken && auditAddress ? await providerKeyStatusFor(sessionToken, name, auditAddress) : { kind: "unavailable" as const } : undefined;
  // Each schedule that is on, with its last run: the outcome record where the schedule writes one,
  // otherwise its heartbeat. Never fails the page: when it cannot be read, the tab shows the switches only.
  const savedSchedules = saved ? Object.entries(saved.schedules).map(([schedule, s]) => ({ name: schedule, on: s.on })) : [];
  const lastRuns = saved?.role
    ? await readScheduleLastRuns({ name, role: saved.role }, savedSchedules.filter((s) => s.on).map((s) => s.name),
        agents.filter((a) => a.role === agent.role).length).catch(() => undefined)
    : undefined;
  const mailbox = saved?.role === "chief-of-staff" ? await agentMailboxView(actor, name, saved).catch(() => mailboxUnavailableView(name)) : undefined;
  return (
    <Page>
    <AgentDetail
      owner={owner}
      accessSettings={owner && definition.status === "fulfilled" && definition.value.initial ? <AgentAccess name={name} hash={definition.value.initial.hash} access={access} members={directory.filter(entry=>entry.member.status==='active').map(entry=>({id:entry.member.id,displayName:entry.displayName}))}/> : owner ? undefined : <p className="lares-muted">Only the owner decides who may use or edit this agent, and sets the agent's own model key.</p>}
      mailboxSettings={mailbox ? <AgentMailbox name={name} initial={mailbox} /> : undefined}
      providerKeySettings={providerKey ? <AgentProviderKey name={name} initial={providerKey} /> : undefined}
      routing={routing}
      outsideTools={outsideTools}
      agent={agent}
      waiting={definition.status === "fulfilled" && definition.value.initial?.runtime?.pending === true}
      status={agentStatus(
        definition.status === "fulfilled" ? definition.value.initial?.runtime : undefined,
        definition.status === "fulfilled" ? definition.value.initial?.status : undefined,
        Boolean(agent.startedAt),
      )}
      promptCache={promptCache.status === "fulfilled" ? promptCache.value : null}
      board={
        board.status === "fulfilled"
          ? {
              available: true,
              value: board.value.filter((r) => r.agent === name),
            }
          : { available: false }
      }
      events={
        events.status === "fulfilled" ? events.value : { available: false }
      }
      schedules={
        definition.status === "fulfilled" && definition.value.initial
          ? {
              available: true,
              value: savedSchedules.map((s) => ({ ...s, ...(lastRuns ? { lastRun: lastRuns[s.name] ?? null } : {}) })),
            }
          : { available: false }
      }
    />
    </Page>
  );
}
