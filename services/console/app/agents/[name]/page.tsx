import { notFound } from "next/navigation";
import { Notice, PageHeader } from "@lares/ui/patterns";
import { listAgents } from "../../../lib/agents";
import { getBoardRows } from "../../../lib/board";
import { builderData } from "../../../lib/builder";
import { getPermissionEvents } from "../../../lib/console-overview";
import { AgentDetail } from "../../../components/AgentDetail";
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
  const [board, definition, events] = await Promise.allSettled([
    getBoardRows({ strict: true }),
    builderData(name),
    getPermissionEvents({ agent: name, limit: 12 }),
  ]);
  return (
    <AgentDetail
      agent={agent}
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
