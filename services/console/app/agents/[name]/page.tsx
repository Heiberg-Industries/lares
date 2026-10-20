import { notFound } from "next/navigation";
import { Notice, PageHeader } from "@lares/ui/patterns";
import { listAgents } from "../../../lib/agents";
import { getBoardRows } from "../../../lib/board";
import { builderData } from "../../../lib/builder";
import { getPermissionEvents } from "../../../lib/console-overview";
import { checkOutsideUrl, outsideToolsInEffect } from "@lares/agent-kit/outside-tools";
import { AgentDetail } from "../../../components/AgentDetail";
import { getOutsideToolEvidence } from "../../../lib/outside-tools";
import { fallbackNotes } from "../../../lib/delivery-notes";
import { getPromptCacheLine } from "../../../lib/agent-detail";
export const dynamic = "force-dynamic";
export default async function AgentPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  let agents;
  try {
    agents = await listAgents({ strict: true });
  } catch {
    return (
      <div className="lares-page">
        <PageHeader title="Agent unavailable" />
        <Notice error>
          The agent registry could not be read. Reload to try again.
        </Notice>
      </div>
    );
  }
  const agent = agents.find((a) => a.name === name);
  if (!agent) notFound();
  const [board, definition, events, promptCache] = await Promise.allSettled([
    getBoardRows({ strict: true }),
    builderData(name),
    getPermissionEvents({ agent: name, limit: 12 }),
    getPromptCacheLine(name),
  ]);
  const saved =
    definition.status === "fulfilled" ? definition.value.initial?.definition : undefined;
  const outsideTools = saved
    ? {
        tools: (saved.outsideTools ?? []).map((t) => {
          const url = checkOutsideUrl(t.url);
          return { ...t, host: url.ok ? url.host : undefined };
        }),
        inEffect: outsideToolsInEffect(saved).length > 0,
        // Asked only when there is something to show; never throws (each half can be unavailable).
        evidence: saved.outsideTools?.length ? await getOutsideToolEvidence(name) : undefined,
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
        }
      : undefined;
  return (
    <AgentDetail
      routing={routing}
      outsideTools={outsideTools}
      agent={agent}
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
              value: Object.entries(
                definition.value.initial.definition.schedules,
              ).map(([name, s]) => ({ name, on: s.on })),
            }
          : { available: false }
      }
    />
  );
}
