import { requireConsolePage } from "../../lib/auth";
import Link from "next/link";
import { Notice, PageHeader, Page } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { getNotionSyncStatus } from "../../lib/queries";
import { getConnectionRows } from "../../lib/connections";
import { getBoardRows } from "../../lib/board";
import type { BoardRowDTO } from "../../lib/contracts";
import { getNotionProposalsView } from "../../lib/notion-proposals";
import { ConnectionsTable } from "../../components/ConnectionsTable";
import { AutonomyControl } from "../../components/AutonomyControl";
import { NoControl } from "../../components/PermissionsBoard";
import { NotionProposalsCard } from "../../components/NotionProposalsCard";
import { NotionCredential } from "../../components/NotionCredential";
import { ClippingCard } from "../../components/ClippingCard";
import { getClippingView } from "../../lib/clipping";
import { getCredentialView } from "../../lib/credentials";

export const dynamic = "force-dynamic";

/** How often the owner actually says yes, in the owner's own words — never a percentage of
 *  nothing, and never the word "ratchet" or a column name. A never-answered card (ignored, expired,
 *  a stale card) is not a refusal, so it never counts against the rate — it is only named on its
 *  own ). */
function answersLine(a: BoardRowDTO["answers"]): string {
  const asked = a.approved + a.cancelled + a.neverAnswered;
  if (asked === 0) return "no answers recorded yet";
  if (a.rate === null)
    return `${asked} asked · none of them have been answered yet`;
  const parts = [
    `${asked} asked`,
    `you said yes to ${Math.round(a.rate * 100)}% of the cards`,
  ];
  if (a.neverAnswered > 0) parts.push(`${a.neverAnswered} never answered`);
  return parts.join(" · ");
}

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ added?: string; error?: string }>;
}) {
  await requireConsolePage();
  const params = await searchParams;
  const [rows, board, notionSync, notionProposals, credential, clipping] =
    await Promise.all([
      getConnectionRows(),
      getBoardRows(),
      getNotionSyncStatus(),
      getNotionProposalsView(),
      getCredentialView(),
      getClippingView(),
    ]);
  const noNotionRun = !notionSync.unavailable && notionSync.lastRunAt === null &&
    notionSync.synced === 0 && notionSync.needsYou === 0 &&
    notionSync.retrying === 0 && notionSync.unmatched === 0;

  return (
    <Page className="lares-operational">
      <PageHeader
        title="Connections"
        description="Accounts, recorded connection status and agent access."
        actions={
          <>
            <Button variant="outline" asChild><Link href="/voice">Email writing style</Link></Button>
            <Button variant="outline" asChild><Link href="/meetings">Meetings</Link></Button>
          </>
        }
      />

      {params.added && (
        <Notice>✓ Connected {decodeURIComponent(params.added)}.</Notice>
      )}
      {params.error && (
        <Notice error>✕ {decodeURIComponent(params.error)}</Notice>
      )}

      <p className="lares-muted lares-operational-intro">
        Connected accounts and the access granted to agents on this installation. Other catalogue entries are available below for inspection.
      </p>
      <ConnectionsTable rows={rows} />
      <NotionCredential initial={credential} />
      <ClippingCard initial={clipping} credential={credential} />

      <details className="lares-disclosure">
        <summary>Service sync status and Notion proposals</summary>
        <p className="lares-muted">These services report recorded activity separately from account connections.</p>
      <h2>Notion sync</h2>
      {notionSync.unavailable ? (
        <p className="mono lares-operational-note lares-status-error">
          Status unavailable.
        </p>
      ) : noNotionRun ? (
        <p className="mono lares-operational-note lares-status-muted">
          No sync run recorded. Check the service setup before expecting Notion changes here.
        </p>
      ) : (
        <p className="mono lares-operational-note">
          Last run: {notionSync.lastRunAt ?? "never"} · {notionSync.synced}{" "}
          synced
          {notionSync.needsYou > 0 && (
            <span className="lares-status-error">
              {" "}
              · {notionSync.needsYou} need you
            </span>
          )}
          {notionSync.retrying > 0 && (
            <span> · {notionSync.retrying} retrying</span>
          )}
          {notionSync.unmatched > 0 && (
            <span className="lares-status-muted">
              {" "}
              · {notionSync.unmatched} unmatched
            </span>
          )}
        </p>
      )}

      {notionProposals.unavailable ? (
        <p className="mono lares-operational-note lares-status-error">
          Proposals unavailable.
        </p>
      ) : (
        <NotionProposalsCard
          proposals={notionProposals.proposals}
          frozen={notionProposals.frozen}
        />
      )}
      </details>

      <h2>Agent permissions</h2>
      <p className="lares-muted lares-operational-note">
        These counts record permission checks, not every read or conversation. ✓ acts on its own · ✋ asks first ·
        🚫 never. A change reaches the agent at its next action. 🔒 Some actions
        always ask, even at ✓ (🚫 still refuses them): moving money, deleting
        data, contacting someone for the first time, publishing, an agent
        changing its own autonomy.
      </p>
      <div className="lares-table-scroll"><table className="card lares-operational-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Integration</th>
            <th>Level</th>
            <th>Set by</th>
            <th>Last 30 days</th>
            <th>Always asks</th>
          </tr>
        </thead>
        <tbody>
          {board.map((b) => (
            <tr key={`${b.agent}:${b.capability}:${b.action}`}>
              <td className="mono">{b.displayName}</td>
              {/* The Vault's areas are set one at a time, so each is its own row, named. */}
              <td className="mono">
                {b.capability}
                {b.actionLabel && (
                  <span className="lares-status-muted">
                    {" "}
                    · {b.actionLabel}
                  </span>
                )}
              </td>
              <td>
                {b.controllable ? (
                  <AutonomyControl
                    agent={b.agent}
                    capability={b.capability}
                    action={b.action || undefined}
                    level={b.level}
                  />
                ) : (
                  <NoControl scope={b.scope} />
                )}
              </td>
              <td className="lares-small lares-status-muted">
                {b.source.kind === "board"
                  ? `${b.source.by}, ${b.source.at.slice(0, 10)}`
                  : "its definition"}
              </td>
              <td className="mono lares-small">
                {b.evidence.asked} asked · {b.evidence.autonomous} on its own ·{" "}
                {b.evidence.denied} refused
                {b.evidence.locked > 0 && <> · {b.evidence.locked} 🔒</>}
                {b.evidence.failedClosed > 0 && (
                  <> · {b.evidence.failedClosed} couldn&apos;t check</>
                )}
                <div className="lares-status-muted">
                  {answersLine(b.answers)}
                </div>
                {b.couldGraduate && (
                  <div className="lares-status-muted">
                    You have approved every one of these. You could set this to
                    act on its own.
                  </div>
                )}
              </td>
              <td className="lares-small">
                {b.lockedTools.length === 0
                  ? "—"
                  : b.lockedTools.map((l) => (
                      <div key={l.tool} title={l.reason}>
                        🔒 {l.tool}
                      </div>
                    ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </Page>
  );
}
