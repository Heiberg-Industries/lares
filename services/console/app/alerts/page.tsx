import { requireConsolePage } from "../../lib/auth";
import Link from "next/link";
import { getRecentSignals } from "../../lib/signals";
import { EmptyState, Field, Notice, PageHeader, Page, Row, Rows } from "@lares/ui/patterns";
import { Badge } from "@lares/ui/primitives/badge";
import { Button } from "@lares/ui/primitives/button";
import { Card } from "@lares/ui/primitives/card";
import { Input } from "@lares/ui/primitives/input";
import { Select } from "@lares/ui/primitives/select";

export const dynamic = "force-dynamic";
const isHttpUrl = (u: string) => /^https?:\/\//i.test(u);
const SEVERITY: Record<string, { word: string; variant: "error" | "warning" | "neutral" }> = {
  error: { word: "Error", variant: "error" },
  warn: { word: "Warning", variant: "warning" },
  info: { word: "Info", variant: "neutral" },
};
const STATE: Record<string, string> = { open: "Open", recovered: "Recovered", closed: "Closed" };

export default async function SignalsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireConsolePage();
  const q = await searchParams;
  const r = await getRecentSignals({ severity: q.severity, project: q.project, kind: q.kind, state: q.state, since: q.since });
  return (
    <Page className="lares-stack">
      <PageHeader
        title="Alerts"
        description="Recent alerts, events and reports from your services."
        actions={
          <Button variant="outline" asChild>
            <Link href="/alert-routing">Alert routing →</Link>
          </Button>
        }
      />
      {"unavailable" in r ? (
        <Notice error>
          Alerts could not be loaded because the service that records them did not answer. Check that it is running on your server, then reload this page.
        </Notice>
      ) : (
        <>
          <form method="get" className="lares-inline-form">
            <Field label="Severity">
              <Select name="severity" defaultValue={q.severity ?? ""}>
                <option value="">Any severity</option>
                <option value="error">Error</option>
                <option value="warn">Warning</option>
                <option value="info">Info</option>
              </Select>
            </Field>
            <Field label="Kind">
              <Select name="kind" defaultValue={q.kind ?? ""}>
                <option value="">Any kind</option>
                <option value="alert">Alert</option>
                <option value="event">Event</option>
                <option value="report">Report</option>
              </Select>
            </Field>
            <Field label="State">
              <Select name="state" defaultValue={q.state ?? ""}>
                <option value="">Any state</option>
                <option value="open">Open</option>
                <option value="recovered">Recovered</option>
                <option value="closed">Closed</option>
              </Select>
            </Field>
            <Field label="Project">
              <Input name="project" placeholder="All projects" defaultValue={q.project ?? ""} />
            </Field>
            <Button type="submit" variant="outline">Filter</Button>
          </form>
          {r.signals.length === 0 ? (
            <EmptyState title="Nothing recorded for these filters">
              Choose other filters, or clear them to see everything recent.
            </EmptyState>
          ) : (
            <Card>
              <Rows label="Recent alerts">
                {r.signals.map((s) => {
                  const severity = SEVERITY[s.severity] ?? { word: s.severity, variant: "neutral" as const };
                  return (
                    <Row
                      key={`${s.fingerprint}:${s.occurrence}`}
                      title={<>{s.project} · {s.title}</>}
                      description={
                        <>
                          {s.lastSeen.slice(0, 16).replace("T", " ")} · {s.source} · {s.type} · seen {s.count} {s.count === 1 ? "time" : "times"}
                          {s.linearRef && <> · {s.linearRef}</>}
                          {s.url && isHttpUrl(s.url) && <> · <a href={s.url} rel="noopener noreferrer">Details</a></>}
                        </>
                      }
                      control={
                        <>
                          <Badge variant={severity.variant}>{severity.word}</Badge>
                          <Badge variant={s.state === "recovered" ? "success" : "neutral"}>{STATE[s.state] ?? s.state}</Badge>
                        </>
                      }
                    >
                      {s.description && <p className="lares-row-description">{s.description}</p>}
                    </Row>
                  );
                })}
              </Rows>
            </Card>
          )}
        </>
      )}
    </Page>
  );
}
