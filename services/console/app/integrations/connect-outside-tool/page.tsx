import { Notice, Page, PageHeader } from "@lares/ui/patterns";
import Link from "next/link";
import { requireConsolePage } from "../../../lib/auth";
import { connectListAgents } from "../../actions/outside-connect";
import { ConnectOutsideTool } from "../../../components/ConnectOutsideTool";

export const dynamic = "force-dynamic";
export default async function ConnectOutsideToolPage({ searchParams }: { searchParams: Promise<{ agent?: string | string[] }> }) {
  await requireConsolePage();
  const [{ agent }, agents] = await Promise.all([searchParams, connectListAgents()]);
  const from = Array.isArray(agent) ? agent[0] : agent;
  if (!agents.ok) return <Page width="narrow" className="lares-stack">
    <Link href="/integrations">← Integrations</Link>
    <PageHeader title="Connect an outside tool" />
    <Notice>{agents.message}</Notice>
  </Page>;
  return <Page width="narrow" className="lares-stack">
    <Link href="/integrations">← Integrations</Link>
    <PageHeader title="Connect an outside tool" description="Give an agent the tools of any MCP server: paste its address and, if it needs one, its token." />
    <ConnectOutsideTool agents={agents.value} initialAgent={from} />
  </Page>;
}
