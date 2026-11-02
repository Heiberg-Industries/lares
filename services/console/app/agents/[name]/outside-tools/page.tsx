import { Notice, Page, PageHeader } from "@lares/ui/patterns";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMember } from "../../../../lib/auth";
import { getOutsideConnections } from "../../../actions/outside-connections";
import { OutsideConnectionsEditor } from "../../../../components/OutsideConnectionsEditor";

export const dynamic = "force-dynamic";
export default async function OutsideConnectionsPage({ params }: { params: Promise<{ name: string }> }) {
  await requireMember();
  const { name } = await params;
  const result = await getOutsideConnections(name);
  if (!result.ok) return <Page width="narrow" className="lares-stack">
    <Link href="/chat">← Your agents</Link>
    <PageHeader title="Connection settings unavailable" />
    <Notice>{result.message}</Notice>
  </Page>;
  return <Page width="narrow" className="lares-stack">
    <Link href={`/agents/${encodeURIComponent(name)}`}>← Agent details</Link>
    <OutsideConnectionsEditor initial={result.result} />
  </Page>;
}
