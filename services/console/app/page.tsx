import { requirePage } from "../lib/auth";
import Link from "next/link";
import { AgentsList } from "../components/AgentsList";
import { Col, Notice, Page, PageHeader, Row, Rows } from "@lares/ui/patterns";
import { Badge } from "@lares/ui/primitives/badge";
import { Button } from "@lares/ui/primitives/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@lares/ui/primitives/card";
import { getFleetSnapshot, getPermissionEvents } from "../lib/console-overview";
import { PermissionEvents } from "../components/PermissionEvents";
export const dynamic = "force-dynamic";
export default async function HomePage() {
  await requirePage("admin");
  const [snapshot, events] = await Promise.all([
    getFleetSnapshot(),
    getPermissionEvents({ limit: 5 }),
  ]);
  const failures = snapshot.workflows.available
    ? snapshot.workflows.value.filter((r) => r.status === "failed" && r.n > 0)
    : [];
  return (
    <Page>
      <PageHeader
        title="Overview"
        description="What is waiting for you, what needs a look, and your agents."
        actions={
          <Button asChild>
            <Link href="/chat">Open chat →</Link>
          </Button>
        }
      />
      <Col span={6}>
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>Waiting for you</CardTitle>
            <CardDescription>What your agents have asked you to decide.</CardDescription>
          </CardHeader>
          <Rows label="Waiting for you">
            <Row
              title="Approval requests"
              description="Requests from every conversation are in Reviews."
              control={
                <Button variant="outline" size="sm" asChild>
                  <Link href="/reviews">Open Reviews →</Link>
                </Button>
              }
            />
          </Rows>
        </Card>
      </Col>
      <Col span={6}>
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>Alerts</CardTitle>
            <CardDescription>Work that failed and needs a look.</CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/alerts">All alerts →</Link>
              </Button>
            </CardAction>
          </CardHeader>
          {!snapshot.workflows.available ? (
            <CardContent className="lares-stack">
              <Notice error>Workflow status could not be loaded. Reload this page to try again.</Notice>
            </CardContent>
          ) : failures.length ? (
            <Rows label="Failed work">
              {failures.map((r) => (
                <Row
                  key={r.agent}
                  title={<Link href={`/agents/${encodeURIComponent(r.agent)}`}>{r.agent}</Link>}
                  control={
                    <Badge variant="error">
                      {r.n} failed {r.n === 1 ? "workflow" : "workflows"}
                    </Badge>
                  }
                />
              ))}
            </Rows>
          ) : (
            <CardContent className="lares-muted">No failed workflows recorded.</CardContent>
          )}
        </Card>
      </Col>
      <section className="lares-stack" aria-labelledby="overview-agents">
        <h2 id="overview-agents" className="lares-section-title">Agents</h2>
        <AgentsList snapshot={snapshot} compact />
        <Button variant="outline" asChild>
          <Link href="/agents">Manage agents →</Link>
        </Button>
      </section>
      <section className="lares-stack" aria-labelledby="overview-checks">
        <h2 id="overview-checks" className="lares-section-title">Recent permission checks</h2>
        <p className="lares-muted">Recent decisions about what your agents may do.</p>
        <PermissionEvents events={events} />
        <Button variant="outline" asChild>
          <Link href="/permission-checks">All permission checks →</Link>
        </Button>
      </section>
    </Page>
  );
}
