import Link from "next/link";
import { EmptyState, Notice, Page, PageHeader, Row, Rows, StatusBadge } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Card } from "@lares/ui/primitives/card";
import { requirePage } from "../../lib/auth";
import { listConnectors } from "../actions/outside-connectors";
import { agentUsesByConnector } from "../../lib/outside-connector-view";
import { DANGER_BADGE, dangerCount } from "../../lib/outside-tools-words";
import { authWords, connectorReach, nextActionWords, stateTone, stateWords } from "../../lib/outside-connector-words";
import { connectApplicationStates } from "../actions/outside-connect";

export const dynamic = "force-dynamic";

export default async function OutsideToolsDirectoryPage() {
  await requirePage("admin");
  const [result, uses] = await Promise.all([listConnectors(), agentUsesByConnector()]);
  // Connected means the change reached the agent (the keeper's own read), not that an agent has it saved.
  const users = [...new Set(Object.values(uses ?? {}).flat().map(u => u.agent))];
  const applied = users.length ? await connectApplicationStates({ agents: users }) : { ok: true as const, value: {} };
  const states = applied.ok ? applied.value : null;
  const add = <Button asChild><Link href="/outside-tools/new">Add custom connector</Link></Button>;
  return <Page className="lares-stack">
    <PageHeader title="Outside tools" description="Tools from servers outside Lares. Choose which agents may use each one." actions={add} />
    {!result.ok && <Notice tone="error">{result.message}</Notice>}
    {uses === null && <Notice tone="needs-you">Which agents use each connector could not be read. Reload the page to try again.</Notice>}
    {result.ok && result.value.length === 0 && <EmptyState title="No outside tools yet">Add a connector with the address of its server.</EmptyState>}
    {result.ok && result.value.length > 0 && <Card><Rows label="Outside tools">
      {result.value.map(c => {
        const agents = uses?.[c.slug] ?? [];
        const tools = c.toolCount ?? (agents.length ? new Set(agents.flatMap(a => a.tools.map(t => t.name))).size : null);
        const reach = connectorReach(c.slug, agents, states);
        return <Row key={c.id} title={c.displayName}
          description={<>{authWords(c.authKind)} · {tools === null ? "tools not read yet" : `${tools} tool${tools === 1 ? "" : "s"}`} · {agents.length ? agents.map(a => a.displayName).join(", ") : "no agents"}{c.authKind !== "signin" && agents.length > 0 && reach.why ? <> · {reach.why}</> : null}</>}
          control={<>
            <StatusBadge tone={stateTone(c.state, c.authKind, agents.length, reach)}>{stateWords(c.state, c.authKind, agents.length, reach)}</StatusBadge>
            {dangerCount(agents) > 0 && <StatusBadge tone="error">{DANGER_BADGE}</StatusBadge>}
            <Button variant="outline" size="sm" asChild><Link href={`/outside-tools/${c.id}`} aria-label={`${nextActionWords(c.state, c.authKind, agents.length)}: ${c.displayName}`}>{nextActionWords(c.state, c.authKind, agents.length)}</Link></Button>
          </>} />;
      })}
    </Rows></Card>}
  </Page>;
}
