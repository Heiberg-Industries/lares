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
    <ul className="lares-data-list">
      {events.value.rows.map((r) => (
        <li key={r.id}>
          <div className="lares-actions">
            <Link href={`/agents/${encodeURIComponent(r.agent)}`}>
              {r.agent}
            </Link>
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
          </div>
          <p>
            {r.tool} <span className="lares-muted">· {r.capability}</span>
          </p>
          <time className="mono lares-muted" dateTime={r.at}>
            {r.at.replace("T", " ").slice(0, 19)} UTC
          </time>
        </li>
      ))}
    </ul>
  );
}
