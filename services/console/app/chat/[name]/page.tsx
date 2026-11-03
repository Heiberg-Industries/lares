import { EmptyState, Page, PageHeader } from "@lares/ui/patterns";
import { requireMember } from "../../../lib/auth";
import { listPrivateChatAgents } from "../../../lib/agents";
import { requireConsoleAgentUse } from "@lares/agent-kit/console-turn-authority";
import { pool } from "../../../lib/db";
import { Chat } from "../../../components/Chat";
import { notFound } from "next/navigation";
export const dynamic = "force-dynamic";
export default async function ChatAgentPage({ params }: { params: Promise<{ name: string }> }) {
  const member = await requireMember();
  const { name } = await params;
  try { await requireConsoleAgentUse(name, member.id, pool); } catch { notFound(); }
  const agents = await listPrivateChatAgents(member);
  // Creating an agent lands here before anyone has started it: say what comes next, not "not found".
  if (!agents.some(agent => agent.name === name)) return <Page width="narrow">
    <PageHeader title="Chat" />
    <EmptyState title={`${name} is not started yet`}>
      Run <code>sudo lares agent start {name}</code> on the server, then reload this page.
    </EmptyState>
  </Page>;
  return <Page width="narrow" className="lares-stack">
    <Chat name={name} memberId={member.id} agents={agents} />
  </Page>;
}
