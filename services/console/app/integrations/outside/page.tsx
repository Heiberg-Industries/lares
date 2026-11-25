import Link from "next/link";
import { EmptyState, Notice, Page, PageHeader, StatusBadge } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { requireConsolePage } from "../../../lib/auth";
import { listConnectors } from "../../actions/outside-connectors";
import { agentUsesByConnector } from "../../../lib/outside-connector-view";
import { authWords, nextActionWords, stateTone, stateWords } from "../../../lib/outside-connector-words";

export const dynamic = "force-dynamic";

export default async function OutsideToolsDirectoryPage() {
  await requireConsolePage();
  const [result, uses] = await Promise.all([listConnectors(), agentUsesByConnector()]);
  const add = <Button asChild><Link href="/integrations/outside/new">Add custom connector</Link></Button>;
  return <Page className="lares-stack">
    <Link href="/integrations">← Integrations</Link>
    <PageHeader title="Outside tools" description="Tools from servers outside Lares. Choose which agents may use each one." actions={add} />
    {!result.ok && <Notice tone="error">{result.message}</Notice>}
    {uses === null && <Notice tone="needs-you">Which agents use each connector could not be read. Reload the page to try again.</Notice>}
    {result.ok && result.value.length === 0 && <EmptyState title="No outside tools yet">Add a connector with the address of its server.</EmptyState>}
    {result.ok && result.value.length > 0 && <ul className="lares-data-list">
      {result.value.map(c => {
        const agents = uses?.[c.slug] ?? [];
        const tools = c.toolCount ?? (agents.length ? new Set(agents.flatMap(a => a.tools.map(t => t.name))).size : null);
        return <li key={c.id} className="lares-stack">
          <div className="lares-actions">
            <strong><Link href={`/integrations/outside/${c.id}`}>{c.displayName}</Link></strong>
            <StatusBadge tone={stateTone(c.state, c.authKind, agents.length)}>{stateWords(c.state, c.authKind, agents.length)}</StatusBadge>
          </div>
          <p className="lares-muted">{authWords(c.authKind)} · {tools === null ? "tools not read yet" : `${tools} tool${tools === 1 ? "" : "s"}`} · {agents.length ? agents.map(a => a.displayName).join(", ") : "no agents"}</p>
          <p><Link href={`/integrations/outside/${c.id}`}>{nextActionWords(c.state, c.authKind, agents.length)} →</Link></p>
        </li>;
      })}
    </ul>}
  </Page>;
}
