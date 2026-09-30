import Link from "next/link";
import { EmptyState, Notice, StatusBadge } from "@lares/ui/patterns";
import type { EventPage, Reading } from "../lib/console-overview";
const labels: Record<string, string> = {
  asked: "Asked for approval",
  autonomous: "Allowed by policy",
  denied: "Denied by policy",
  locked: "Always asks",
  "failed-closed": "Refused safely",
};
export function PermissionEvents({ events }: { events: Reading<EventPage> }) {
  if (!events.available)
    return (
      <Notice error>
        Permission history is unavailable. Reload to try again.
      </Notice>
    );
  if (!events.value.rows.length)
    return (
      <EmptyState title="No permission checks recorded">
        New checks appear here when agents use approval-controlled tools.
      </EmptyState>
    );
  return (
    <div className="lares-event-table">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Agent & tool</th>
            <th>Permission decision</th>
          </tr>
        </thead>
        <tbody>
          {events.value.rows.map((r) => (
            <tr key={r.id}>
              <td>
                <time title={r.at} dateTime={r.at}>
                  {r.at.slice(0, 10)}
                  <br />
                  {r.at.slice(11, 16)} UTC
                </time>
              </td>
              <td>
                <Link href={`/agents/${encodeURIComponent(r.agent)}`}>
                  {r.agent}
                </Link>
                <br />
                <span className="lares-muted">{r.tool}</span>
              </td>
              <td>
                <StatusBadge
                  tone={
                    r.decision === "failed-closed" || r.decision === "denied"
                      ? "error"
                      : r.decision === "asked" || r.decision === "locked"
                        ? "attention"
                        : "quiet"
                  }
                >
                  {labels[r.decision] ?? r.decision}
                </StatusBadge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
