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
  if (!result.ok) return <div className="lares-page lares-stack">
    <Link href="/chat">← Your agents</Link>
    <h1>Connection settings unavailable</h1>
    <p role="status">{result.message}</p>
  </div>;
  return <div className="lares-page lares-stack">
    <Link href={`/agents/${encodeURIComponent(name)}`}>← Agent details</Link>
    <OutsideConnectionsEditor initial={result.result} />
  </div>;
}
