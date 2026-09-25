import Link from "next/link";
import { AgentsList } from "../components/AgentsList";
import {
  PageHeader,
  EmptyState,
  Notice,
  AgentAvatar,
} from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { getFleetSnapshot, getPermissionEvents } from "../lib/console-overview";
import { PermissionEvents } from "../components/PermissionEvents";
export const dynamic = "force-dynamic";
export default async function HomePage() {
  const [snapshot, events] = await Promise.all([
    getFleetSnapshot(),
    getPermissionEvents({ limit: 5 }),
  ]);
  const failures = snapshot.workflows.available
    ? snapshot.workflows.value.filter((r) => r.status === "failed" && r.n > 0)
    : [];
  return (
    <div className="lares-page lares-stack">
      <PageHeader
        title="Your house"
        description="A quiet place to keep an eye on things."
        actions={
          <Button asChild>
            <Link href="/chat">Open chat →</Link>
          </Button>
        }
      />
      <section className="lares-surface">
        <h2 className="lares-section-title">Work to review</h2>
        {!snapshot.workflows.available ? (
          <Notice error>Workflow status is unavailable.</Notice>
        ) : failures.length ? (
          <ul className="lares-data-list">
            {failures.map((r) => (
              <li key={r.agent}>
                <Link href={`/agents/${encodeURIComponent(r.agent)}`}>
                  {r.agent}
                </Link>{" "}
                · {r.n} failed {r.n === 1 ? "workflow" : "workflows"}
              </li>
            ))}
          </ul>
        ) : (
          <p className="lares-muted">No failed workflows recorded.</p>
        )}
        <p className="lares-muted">
          Approval requests stay in their original conversation.{" "}
          <Link href="/chat">Open chat</Link> to review them.
        </p>
      </section>
      <div className="lares-stack">
        <section>
          <div className="lares-section-heading">
            <h2 className="lares-section-title">Your agents</h2>
            <Link href="/agents">Manage agents →</Link>
          </div>
          <AgentsList snapshot={snapshot} compact />
        </section>
        <section>
          <h2 className="lares-section-title">Recent permission checks</h2>
          <p className="lares-muted">
            Recent decisions about what your agents may do.
          </p>
          <PermissionEvents events={events} />
          <Link href="/activity">View activity →</Link>
        </section>
      </div>
    </div>
  );
}
