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
import { getMeetingsSourceView } from "../../../lib/meetings-source";
import { getNotionSyncView } from "../../../lib/notion-sync";
import { anyOutsideToolsInUse } from "../../../lib/outside-tools";
import { getGatewayStatusView } from "../../../lib/gateway-status";
import { listAgents } from "../../../lib/agents";
import { agentNames } from "../../../lib/connection-words";
import { gatewayAgents, integrationCard } from "../../../lib/integrations-grid";
import { IntegrationDetail } from "../../../components/IntegrationDetail";
import { NotionCredential } from "../../../components/NotionCredential";
import { NotionProposalsCard } from "../../../components/NotionProposalsCard";
import { ClippingCard } from "../../../components/ClippingCard";
import { MeetingsSourceControl } from "../../../components/MeetingsSourceControl";
import { NotionSyncControl } from "../../../components/NotionSyncControl";

export const dynamic = "force-dynamic";

type Credential = Awaited<ReturnType<typeof getCredentialView>>;
type NotionSettings = {
  meetings: Awaited<ReturnType<typeof getMeetingsSourceView>>;
  people: Awaited<ReturnType<typeof getNotionSyncView>>;
  clipping: Awaited<ReturnType<typeof getClippingView>>;
  documents: Awaited<ReturnType<typeof getNotionSyncStatus>>;
  proposals: Awaited<ReturnType<typeof getNotionProposalsView>>;
};

const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** Every Notion setting, in one place and in the order a person sets them up: the key, the meetings
 *  database, the people sync, clipping, then the changes waiting for a decision. */
function NotionExtras({ credential, notion, owner }: { credential: Credential; notion: NotionSettings; owner: boolean }) {
  const { documents } = notion;
  const noNotionRun = !documents.unavailable && documents.lastRunAt === null &&
    documents.synced === 0 && documents.needsYou === 0 &&
    documents.retrying === 0 && documents.unmatched === 0;
  return (
    <>
      <NotionCredential initial={credential} />
      {notion.meetings ? <MeetingsSourceControl view={notion.meetings} /> : <Notice tone="needs-you">The meetings database setting could not be loaded.</Notice>}
      {/* Null also means this installation offers no people sync, so nothing is shown rather than an error. */}
      {notion.people && <NotionSyncControl initial={notion.people} />}
      <ClippingCard initial={notion.clipping} credential={credential} />
      {documents.unavailable ? (
        <Notice tone="needs-you">The status of the document sync could not be read.</Notice>
      ) : noNotionRun ? (
        <Notice>No document sync run is recorded. Check the service setup before expecting Notion changes here.</Notice>
      ) : (
        <Notice tone={documents.needsYou > 0 ? "needs-you" : "info"}>
          Document sync last ran {documents.lastRunAt ? when(documents.lastRunAt) : "never"}: {documents.synced} synced
          {documents.needsYou > 0 && <>, {documents.needsYou} need you</>}
          {documents.retrying > 0 && <>, {documents.retrying} retrying</>}
          {documents.unmatched > 0 && <>, {documents.unmatched} unmatched</>}.
        </Notice>
      )}
      {notion.proposals.unavailable ? (
        <Notice tone="needs-you">The changes waiting for you could not be read.</Notice>
      ) : (
        <NotionProposalsCard proposals={notion.proposals.proposals} frozen={notion.proposals.frozen} canDecide={owner} />
      )}
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
      ? Promise.all([getMeetingsSourceView(), getNotionSyncView(), getClippingView(), getNotionSyncStatus(), getNotionProposalsView()])
        .then(([meetings, people, clip, documents, proposals]): NotionSettings => ({ meetings, people, clipping: clip, documents, proposals }))
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
      <IntegrationDetail card={card} rows={shown} board={board} />
      {notion && <NotionExtras credential={credential} notion={notion} owner={mayUse(member, "owner")} />}
      {clipping && <ClippingCard initial={clipping} credential={credential} />}
      {card.id === "readability" && !clippingHere && <p className="lares-muted">Saving links from a Notion database is set up on the <Link href="/integrations/notion">Notion</Link> page, under Clipping.</p>}
    </Page>
  );
}
