import Link from "next/link";
import { notFound } from "next/navigation";
import { Notice, Page, PageHeader, StatusBadge } from "@lares/ui/patterns";
import { isConsoleOwner, requireConsolePage } from "../../../../lib/auth";
import { listConnectors } from "../../../actions/outside-connectors";
import { listAgents } from "../../../../lib/agents";
import { getOutsideToolEvidence } from "../../../../lib/outside-tools";
import { agentUsesByConnector, knownToolNames } from "../../../../lib/outside-connector-view";
import { dangerCount, keyLine } from "../../../../lib/outside-tools-words";
import { authWords, foundSentence, stateTone, stateWords } from "../../../../lib/outside-connector-words";
import { ConnectorAccess } from "../../../../components/ConnectorAccess";
import { ConnectorActions } from "../../../../components/ConnectorActions";
import { DangerZone } from "../../../../components/DangerZone";

export const dynamic = "force-dynamic";

export default async function ConnectorPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ found?: string | string[] }> }) {
  const member = await requireConsolePage();
  const [{ id }, { found }] = await Promise.all([params, searchParams]);
  const [result, uses, agents] = await Promise.all([listConnectors(), agentUsesByConnector(), listAgents()]);
  if (!result.ok) return <Page width="narrow" className="lares-stack">
    <Link href="/integrations/outside">← Outside tools</Link>
    <Notice tone="error">{result.message}</Notice>
  </Page>;
  const c = result.value.find(x => x.id === id);
  if (!c) notFound();
  const mine = uses?.[c.slug] ?? [];
  const keyLines: Record<string, string> = {};
  await Promise.all(mine.filter(u => u.needsKey).map(async u => { keyLines[u.agent] = keyLine(true, (await getOutsideToolEvidence(u.agent)).keys, c.slug); }));
  const known = await knownToolNames(mine.map(u => u.agent), c.slug);
  const foundKind = (Array.isArray(found) ? found[0] : found) as "none" | "token" | "signin" | undefined;
  const tools = new Set(mine.flatMap(u => u.tools.map(t => t.name))).size;
  return <Page width="narrow" className="lares-stack">
    <Link href="/integrations/outside">← Outside tools</Link>
    <PageHeader title={c.displayName} description={<><span className="mono">{c.url}</span></>}
      actions={<StatusBadge tone={stateTone(c.state, c.authKind, mine.length)}>{stateWords(c.state, c.authKind, mine.length)}</StatusBadge>} />
    {foundKind && ["none", "token", "signin"].includes(foundKind) && <Notice tone={foundKind === "signin" ? "needs-you" : "success"}>{foundSentence(foundKind)}</Notice>}
    {uses === null && <Notice tone="needs-you">Could not read which agents use this connector, so changes are switched off here. Reload the page to try again.</Notice>}
    <p className="lares-muted">{authWords(c.authKind)} · {tools} tool{tools === 1 ? "" : "s"} · {mine.length} agent{mine.length === 1 ? "" : "s"}{dangerCount(mine) > 0 && <> · <StatusBadge tone="error">{dangerCount(mine)} run{dangerCount(mine) === 1 ? "s" : ""} without asking and change{dangerCount(mine) === 1 ? "s" : ""} something</StatusBadge></>}</p>
    {uses !== null && <ConnectorAccess known={known} conn={{ id: c.id, slug: c.slug, url: c.url, description: c.description, authKind: c.authKind }} uses={mine}
      allAgents={agents.map(a => ({ name: a.name, displayName: a.displayName }))} canWiden={isConsoleOwner(member)} keyLines={keyLines} />}
    <ConnectorActions id={c.id} displayName={c.displayName} authKind={c.authKind} />
    {uses !== null && <DangerZone slug={c.slug} uses={mine} isOwner={isConsoleOwner(member)} />}
  </Page>;
}
