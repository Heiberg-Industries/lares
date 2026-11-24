import { Notice, Page, PageHeader } from "@lares/ui/patterns";
import Link from "next/link";
import { isConsoleOwner, requireConsolePage } from "../../../lib/auth";
import { connectListAgents } from "../../actions/outside-connect";
import { declaredOutsideTools } from "../../../lib/outside-tools";
import { ConnectOutsideTool } from "../../../components/ConnectOutsideTool";

export const dynamic = "force-dynamic";
export default async function ConnectOutsideToolPage({ searchParams }: { searchParams: Promise<{ agent?: string | string[] }> }) {
  const member = await requireConsolePage();
  const [{ agent }, agents, declared] = await Promise.all([searchParams, connectListAgents(), declaredOutsideTools()]);
  const takenNames = [...new Set((declared ?? []).flatMap(d => d.servers.map(s => s.name)))];
  const from = Array.isArray(agent) ? agent[0] : agent;
  if (!agents.ok) return <Page width="narrow" className="lares-stack">
    <Link href="/integrations">← Integrations</Link>
    <PageHeader title="Connect an outside tool" />
    <Notice>{agents.message}</Notice>
  </Page>;
  return <Page width="narrow" className="lares-stack">
    <Link href="/integrations">← Integrations</Link>
    <PageHeader title="Connect an outside tool" description="Give an agent the tools of any MCP server: paste its address and, if it needs one, its token." />
    <ConnectOutsideTool agents={agents.value} initialAgent={from} takenNames={takenNames} canWiden={isConsoleOwner(member)} />
  </Page>;
}
