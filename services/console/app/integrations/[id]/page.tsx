import { notFound } from "next/navigation";
import { requireConsolePage } from "../../../lib/auth";
import { Page } from "@lares/ui/patterns";
import { getConnectionRows } from "../../../lib/connections";
import { getBoardRows } from "../../../lib/board";
import { getCredentialView } from "../../../lib/credentials";
import { getClippingView } from "../../../lib/clipping";
import { getNotionSyncStatus } from "../../../lib/queries";
import { getNotionProposalsView } from "../../../lib/notion-proposals";
import { anyOutsideToolsInUse, declaredOutsideTools, getOutsideToolEvidence, type OutsideToolEvidence } from "../../../lib/outside-tools";
import { integrationCard } from "../../../lib/integrations-grid";
import { IntegrationDetail, IntegrationHeader } from "../../../components/IntegrationDetail";
import { OutsideToolsOverview } from "../../../components/OutsideToolsOverview";
import { NotionCredential } from "../../../components/NotionCredential";
import { NotionProposalsCard } from "../../../components/NotionProposalsCard";
import { ClippingCard } from "../../../components/ClippingCard";

export const dynamic = "force-dynamic";

type Credential = Awaited<ReturnType<typeof getCredentialView>>;
type NotionSync = Awaited<ReturnType<typeof getNotionSyncStatus>>;
type NotionProposals = Awaited<ReturnType<typeof getNotionProposalsView>>;

function NotionExtras({ credential, notionSync, notionProposals }: { credential: Credential; notionSync: NotionSync; notionProposals: NotionProposals }) {
  const noNotionRun = !notionSync.unavailable && notionSync.lastRunAt === null &&
    notionSync.synced === 0 && notionSync.needsYou === 0 &&
    notionSync.retrying === 0 && notionSync.unmatched === 0;
  return (
    <>
      <NotionCredential initial={credential} />
      <h2>Notion sync</h2>
      {notionSync.unavailable ? (
        <p className="mono lares-operational-note lares-status-error">Status unavailable.</p>
      ) : noNotionRun ? (
        <p className="mono lares-operational-note lares-status-muted">
          No sync run recorded. Check the service setup before expecting Notion changes here.
        </p>
      ) : (
        <p className="mono lares-operational-note">
          Last run: {notionSync.lastRunAt ?? "never"} · {notionSync.synced} synced
          {notionSync.needsYou > 0 && <span className="lares-status-error"> · {notionSync.needsYou} need you</span>}
          {notionSync.retrying > 0 && <span> · {notionSync.retrying} retrying</span>}
          {notionSync.unmatched > 0 && <span className="lares-status-muted"> · {notionSync.unmatched} unmatched</span>}
        </p>
      )}
      {notionProposals.unavailable ? (
        <p className="mono lares-operational-note lares-status-error">Proposals unavailable.</p>
      ) : (
        <NotionProposalsCard proposals={notionProposals.proposals} frozen={notionProposals.frozen} />
      )}
    </>
  );
}

export default async function IntegrationPage({ params }: { params: Promise<{ id: string }> }) {
  await requireConsolePage();
  const { id } = await params;
  const [rows, credential, outsideToolsInUse] = await Promise.all([getConnectionRows(), getCredentialView(), anyOutsideToolsInUse()]);
  const card = integrationCard(id, { rows, credential, outsideToolsInUse });
  if (!card) notFound();

  if (card.id === "outside") {
    const declared = await declaredOutsideTools();
    const evidence: Record<string, OutsideToolEvidence> = {};
    await Promise.all((declared ?? []).map(async (a) => { evidence[a.agent] = await getOutsideToolEvidence(a.agent); }));
    return (
      <Page className="lares-stack">
        <IntegrationHeader card={{ ...card, line: "Tools from servers outside Lares. They are added for one agent at a time, on that agent's page." }} />
        <OutsideToolsOverview declared={declared} evidence={evidence} />
      </Page>
    );
  }

  const [board, notion, clipping] = await Promise.all([
    getBoardRows({ strict: true }).catch(() => null),
    card.id === "notion" ? Promise.all([getNotionSyncStatus(), getNotionProposalsView()]).then(([sync, proposals]) => ({ sync, proposals })) : null,
    card.id === "readability" ? getClippingView() : null,
  ]);
  return (
    <Page className="lares-stack">
      <IntegrationDetail card={card} rows={rows.filter((r) => r.connectionId === card.id)} board={board} />
      {notion && <NotionExtras credential={credential} notionSync={notion.sync} notionProposals={notion.proposals} />}
      {clipping && <ClippingCard initial={clipping} credential={credential} />}
    </Page>
  );
}
