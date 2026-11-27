import Link from "next/link";
import { notFound } from "next/navigation";
import { mayUse, requirePage } from "../../../lib/auth";
import { Notice, Page } from "@lares/ui/patterns";
import { getConnectionRows } from "../../../lib/connections";
import { getBoardRows } from "../../../lib/board";
import { getCredentialView } from "../../../lib/credentials";
import { getClippingView } from "../../../lib/clipping";
import { getNotionSyncStatus } from "../../../lib/queries";
import { getNotionProposalsView } from "../../../lib/notion-proposals";
import { getNotionSyncView } from "../../../lib/notion-sync";
import { notionAgents } from "../../../lib/notion-agents";
import type { NotionAgent } from "../../../lib/notion-connection";
import { anyOutsideToolsInUse } from "../../../lib/outside-tools";
import { getGatewayStatusView } from "../../../lib/gateway-status";
import { listAgents } from "../../../lib/agents";
import { agentNames } from "../../../lib/connection-words";
import { gatewayAgents, integrationCard } from "../../../lib/integrations-grid";
import { IntegrationDetail } from "../../../components/IntegrationDetail";
import { NotionConnection } from "../../../components/NotionConnection";
import { NotionProposalsCard } from "../../../components/NotionProposalsCard";
import { ClippingCard } from "../../../components/ClippingCard";
import { NotionSyncControl } from "../../../components/NotionSyncControl";

export const dynamic = "force-dynamic";

type Credential = Awaited<ReturnType<typeof getCredentialView>>;
type NotionSettings = {
  people: Awaited<ReturnType<typeof getNotionSyncView>>;
  clipping: Awaited<ReturnType<typeof getClippingView>>;
  documents: Awaited<ReturnType<typeof getNotionSyncStatus>>;
  proposals: Awaited<ReturnType<typeof getNotionProposalsView>>;
  /** null when the agents could not be read: step 2 then lists none. */
  agents: NotionAgent[] | null;
};

const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** The Notion page, in the order a person meets it: one sentence on where things stand, 1. Connect,
 *  2. Which agents may use Notion, then Clipping and People sync, folded until both steps are done.
 *  Nothing about meetings: the meetings database is chosen on the Meetings page. Document sync and
 *  the changes waiting for a decision belong to a sync service a standard install does not run, so
 *  they show only when there is something in them. */
function NotionExtras({ credential, notion, owner, names }: { credential: Credential; notion: NotionSettings; owner: boolean; names: Record<string, string> }) {
  const { documents, proposals } = notion;
  const documentsHere = !documents.unavailable && (documents.lastRunAt !== null ||
    documents.synced + documents.needsYou + documents.retrying + documents.unmatched > 0);
  const proposalsHere = !proposals.unavailable && (proposals.proposals.length > 0 || proposals.frozen.length > 0);
  return (
    <>
      <NotionConnection initial={credential} agents={notion.agents ?? []} names={names}>
        <ClippingCard initial={notion.clipping} credential={credential} />
        {/* Null also means this installation offers no people sync, so nothing is shown rather than an error. */}
        {notion.people && <NotionSyncControl initial={notion.people} />}
      </NotionConnection>
      {notion.agents === null && <Notice tone="needs-you">The agents that may use Notion could not be read. Reload the page to try again.</Notice>}
      {documentsHere && (
        <Notice tone={documents.needsYou > 0 ? "needs-you" : "info"}>
          Document sync last ran {documents.lastRunAt ? when(documents.lastRunAt) : "never"}: {documents.synced} synced
          {documents.needsYou > 0 && <>, {documents.needsYou} need you</>}
          {documents.retrying > 0 && <>, {documents.retrying} retrying</>}
          {documents.unmatched > 0 && <>, {documents.unmatched} unmatched</>}.
        </Notice>
      )}
      {proposalsHere && <NotionProposalsCard proposals={proposals.proposals} frozen={proposals.frozen} canDecide={owner} />}
    </>
  );
}

export default async function IntegrationPage({ params }: { params: Promise<{ id: string }> }) {
  const member = await requirePage("admin");
  const { id } = await params;
  const [rows, credential, outsideToolsInUse, gateway] = await Promise.all([getConnectionRows(), getCredentialView(), anyOutsideToolsInUse(), getGatewayStatusView()]);
  const input = { rows, credential, outsideToolsInUse, gateway };
  const card = integrationCard(id, input);
  // Outside tools is listed here as a row but lives at /outside-tools; it has no page under Integrations.
  if (!card || id === "outside") notFound();

  // Clipping is a Notion setting, so it sits on the Notion page. Only an installation with no Notion page keeps it here.
  const clippingHere = card.id === "readability" && integrationCard("notion", input) === null;
  const [board, notion, clipping, agents] = await Promise.all([
    getBoardRows({ strict: true }).catch(() => null),
    card.id === "notion"
      ? Promise.all([getNotionSyncView(), getClippingView(), getNotionSyncStatus(), getNotionProposalsView(), notionAgents().catch(() => null)])
        .then(([people, clip, documents, proposals, chiefs]): NotionSettings => ({ people, clipping: clip, documents, proposals, agents: chiefs }))
      : null,
    clippingHere ? getClippingView() : null,
    listAgents(),
  ]);
  const shown = rows.filter((r) => r.connectionId === card.id).map((r) => {
    const ids = card.id === "gateway" && r.usedBy.length === 0 ? gatewayAgents(gateway) : r.usedBy;
    return { ...r, usedBy: agentNames(ids, agents) };
  });
  return (
    <Page className="lares-stack">
      <IntegrationDetail card={card} rows={shown} board={board} owner={mayUse(member, "owner")} usage={!notion}>
        {notion && <NotionExtras credential={credential} notion={notion} owner={mayUse(member, "owner")}
          names={Object.fromEntries([...agents.map((a) => [a.name, a.displayName] as const), ...(notion.agents ?? []).map((a) => [a.name, a.displayName] as const)])} />}
      </IntegrationDetail>
      {clipping && <ClippingCard initial={clipping} credential={credential} />}
      {card.id === "readability" && !clippingHere && <p className="lares-muted">Saving links from a Notion database is set up on the <Link href="/integrations/notion">Notion</Link> page, under Clipping.</p>}
    </Page>
  );
}
