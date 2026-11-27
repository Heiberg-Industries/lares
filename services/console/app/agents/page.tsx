import { Page } from "@lares/ui/patterns";
import { requirePage } from "../../lib/auth";
import { AgentsList } from "../../components/AgentsList";
import { getFleetSnapshot } from "../../lib/console-overview";
export const dynamic = "force-dynamic";
export default async function AgentsPage() {
  await requirePage("admin");
  return <Page><AgentsList snapshot={await getFleetSnapshot()} /></Page>;
}
