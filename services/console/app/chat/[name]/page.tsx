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
  if (!agents.some(agent => agent.name === name)) notFound();
  return <Chat name={name} memberId={member.id} agents={agents} />;
}
