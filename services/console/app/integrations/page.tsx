import { getNotionSyncStatus } from "../../lib/queries";
import { getConnectionRows } from "../../lib/connections";
import { getBoardRows } from "../../lib/board";
import type { BoardRowDTO } from "../../lib/contracts";
import { getNotionProposalsView } from "../../lib/notion-proposals";
import { getCrmStatus } from "../../lib/crm-status";
import { ConnectionsTable } from "../../components/ConnectionsTable";
import { AutonomyControl } from "../../components/AutonomyControl";
import { NoControl } from "../../components/PermissionsBoard";
import { NotionProposalsCard } from "../../components/NotionProposalsCard";
import { CrmStatusSection } from "../../components/CrmStatusSection";

export const dynamic = "force-dynamic";

/** How often the owner actually says yes, in the owner's own words — never a percentage of
 *  nothing, and never the word "ratchet" or a column name. A never-answered card (ignored, expired,
 *  a stale card) is not a refusal, so it never counts against the rate — it is only named on its
 *  own (owner decision B1). */
function answersLine(a: BoardRowDTO["answers"]): string {
  const asked = a.approved + a.cancelled + a.neverAnswered;
  if (asked === 0) return "no answers recorded yet";
  if (a.rate === null) return `${asked} asked · none of them have been answered yet`;
  const parts = [`${asked} asked`, `you said yes to ${Math.round(a.rate * 100)}% of the cards`];
  if (a.neverAnswered > 0) parts.push(`${a.neverAnswered} never answered`);
  return parts.join(" · ");
}

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ added?: string; error?: string }>;
}) {
  const params = await searchParams;
  const [rows, board, notionSync, notionProposals, crmStatus] = await Promise.all([
    getConnectionRows(),
    getBoardRows(),
    getNotionSyncStatus(),
    getNotionProposalsView(),
    getCrmStatus(),
  ]);

  return (
    <>
      <h1 className="mono" style={{ fontSize: 18 }}>Integrations &amp; Accounts</h1>

      {params.added && (
        <p className="mono" style={{ marginTop: 12, color: "var(--good, #2a7)" }}>
          ✓ Connected {decodeURIComponent(params.added)}.
        </p>
      )}
      {params.error && (
        <p className="mono" style={{ marginTop: 12, color: "var(--bad)" }}>
          ✕ {decodeURIComponent(params.error)}
        </p>
      )}

      <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>Connections</h2>
      <p style={{ color: "var(--mist)", fontSize: 12, marginTop: 4 }}>
        What the box is plugged into. Credentials the console holds it can reconnect; credentials the
        box holds it reports from recorded use, never by reading the file.
      </p>
      <ConnectionsTable rows={rows} />

      <CrmStatusSection status={crmStatus} />

      <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>notion-sync</h2>
      {notionSync.unavailable ? (
        <p className="mono" style={{ marginTop: 8, color: "var(--bad)" }}>
          Status unavailable.
        </p>
      ) : (
        <p className="mono" style={{ marginTop: 8 }}>
          Last run: {notionSync.lastRunAt ?? "never"} · {notionSync.synced} synced
          {notionSync.needsYou > 0 && (
            <span style={{ color: "var(--bad)" }}> · {notionSync.needsYou} need you</span>
          )}
          {notionSync.retrying > 0 && <span> · {notionSync.retrying} retrying</span>}
          {notionSync.unmatched > 0 && (
            <span style={{ color: "var(--mist)" }}> · {notionSync.unmatched} unmatched</span>
          )}
        </p>
      )}

      {notionProposals.unavailable ? (
        <p className="mono" style={{ marginTop: 8, color: "var(--bad)" }}>
          Proposals unavailable.
        </p>
      ) : (
        <NotionProposalsCard proposals={notionProposals.proposals} frozen={notionProposals.frozen} />
      )}

      <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>Permissions</h2>
      <p style={{ color: "var(--mist)", fontSize: 12, marginTop: 4 }}>
        What each agent may do on its own. ✓ acts on its own · ✋ asks first · 🚫 never. A change reaches the
        agent at its next action. 🔒 Some actions always ask, even at ✓ (🚫 still refuses them): moving money,
        deleting data, contacting someone for the first time, publishing, an agent changing its own autonomy.
      </p>
      <table className="card" style={{ marginTop: 8 }}>
        <thead><tr><th>Agent</th><th>Integration</th><th>Level</th><th>Set by</th><th>Last 30 days</th><th>Always asks</th></tr></thead>
        <tbody>
          {board.map((b) => (
            <tr key={`${b.agent}:${b.capability}:${b.action}`}>
              <td className="mono">{b.displayName}</td>
              {/* The Vault's areas are set one at a time, so each is its own row, named. */}
              <td className="mono">
                {b.capability}
                {b.actionLabel && <span style={{ color: "var(--mist)" }}> · {b.actionLabel}</span>}
              </td>
              <td>
                {b.controllable
                  ? <AutonomyControl agent={b.agent} capability={b.capability} action={b.action || undefined} level={b.level} />
                  : <NoControl scope={b.scope} />}
              </td>
              <td style={{ color: "var(--mist)", fontSize: 12 }}>
                {b.source.kind === "board" ? `${b.source.by}, ${b.source.at.slice(0, 10)}` : "its definition"}
              </td>
              <td className="mono" style={{ fontSize: 12 }}>
                {b.evidence.asked} asked · {b.evidence.autonomous} on its own · {b.evidence.denied} refused
                {b.evidence.locked > 0 && <> · {b.evidence.locked} 🔒</>}
                {b.evidence.failedClosed > 0 && <> · {b.evidence.failedClosed} couldn&apos;t check</>}
                <div style={{ color: "var(--mist)", marginTop: 2 }}>{answersLine(b.answers)}</div>
                {b.couldGraduate && (
                  <div style={{ color: "var(--mist)", marginTop: 2 }}>
                    You have approved every one of these. You could set this to act on its own.
                  </div>
                )}
              </td>
              <td style={{ fontSize: 12 }}>
                {b.lockedTools.length === 0 ? "—" : b.lockedTools.map((l) => <div key={l.tool} title={l.reason}>🔒 {l.tool}</div>)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
