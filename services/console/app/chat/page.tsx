import { redirect } from "next/navigation";
import { listAgents } from "../../lib/agents";
import { EmptyState, PageHeader } from "@lares/ui/patterns";
export const dynamic = "force-dynamic";
export default async function ChatPage() {
  const agents = await listAgents({ strict: true }).catch(() => null);
  if (agents?.length) redirect(`/chat/${encodeURIComponent(agents[0].name)}`);
  return (
    <div className="lares-page">
      <PageHeader
        title="Chat"
        description="Talk things through. Your agents are here."
      />
      <EmptyState title={agents ? "No agents yet" : "Agents are unavailable"}>
        {agents
          ? "Create an agent to start a conversation."
          : "Reload to try again."}
      </EmptyState>
    </div>
  );
}
