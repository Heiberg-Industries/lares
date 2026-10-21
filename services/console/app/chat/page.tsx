import { requireMember } from "../../lib/auth";
import { redirect } from "next/navigation";
import { listPrivateChatAgents } from "../../lib/agents";
import { EmptyState, PageHeader } from "@lares/ui/patterns";
export const dynamic = "force-dynamic";
export default async function ChatPage() {
  const member=await requireMember();
  const agents = await listPrivateChatAgents(member).catch(() => null);
  if (agents?.length) redirect(`/chat/${encodeURIComponent(agents[0].name)}`);
  return (
    <div className="lares-page">
      <PageHeader
        title="Chat"
        description="Talk things through. Your agents are here."
      />
      <EmptyState title={agents ? "No conversations available" : "Conversations are unavailable"}>
        {agents
          ? "An agent will appear here when you have permission to use it."
          : "Reload to try again."}
      </EmptyState>
    </div>
  );
}
