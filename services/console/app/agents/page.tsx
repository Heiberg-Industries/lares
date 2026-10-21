import { requireConsolePage } from "../../lib/auth";
import { AgentsList } from "../../components/AgentsList";
import { getFleetSnapshot } from "../../lib/console-overview";
export const dynamic = "force-dynamic";
export default async function AgentsPage() {
  await requireConsolePage();
  return <AgentsList snapshot={await getFleetSnapshot()} />;
}
