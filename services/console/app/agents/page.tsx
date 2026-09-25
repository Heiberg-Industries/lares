import { AgentsList } from "../../components/AgentsList";
import { getFleetSnapshot } from "../../lib/console-overview";
export const dynamic = "force-dynamic";
export default async function AgentsPage() {
  return <AgentsList snapshot={await getFleetSnapshot()} />;
}
