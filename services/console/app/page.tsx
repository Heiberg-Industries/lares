import { AgentsList } from "../components/AgentsList";
import { getAgentSummaries } from "../lib/queries";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const agents = await getAgentSummaries();
  return <AgentsList agents={agents} />;
}
