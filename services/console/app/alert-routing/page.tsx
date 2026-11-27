import { requirePage } from "../../lib/auth";
import Link from "next/link";
import { ALERTS_NOT_SET_UP, alertsSetUp, getRules, getConsumers } from "../../lib/signals";
import { JsonEditor } from "../../components/JsonEditor";
import { ConsumerSwitches } from "../../components/ConsumerSwitches";
import { saveRules, saveConsumers } from "../actions/signals";
import { Notice, PageHeader, Page, Row, Rows } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@lares/ui/primitives/card";
export const dynamic = "force-dynamic";
export default async function RulesPage() {
  await requirePage("admin");
  if (!alertsSetUp()) return (
    <Page className="lares-stack">
      <PageHeader title="Alert routing" description="Where alerts are sent, and what each one means." />
      <Notice>{ALERTS_NOT_SET_UP}</Notice>
    </Page>
  );
  // The switches sit ABOVE the rules rather than on their own page, because they are the same
  // question — where does an alert go — asked one level up. Fetched independently so a spine
  // that answers one and not the other still renders what it can.
  const [r, c] = await Promise.all([getRules(), getConsumers()]);
  return (
    <Page>
      <PageHeader
        title="Alert routing"
        description="Where alerts are sent, and what each one means."
        actions={
          <Button variant="outline" asChild>
            <Link href="/alerts">Alerts →</Link>
          </Button>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>Delivery</CardTitle>
          <CardDescription>Turn a whole destination on or off. A change applies as soon as you flip the switch.</CardDescription>
        </CardHeader>
        {"unavailable" in c ? (
          <CardContent className="lares-stack">
            <Notice error>
              The delivery switches could not be loaded because the service that records alerts did not answer. Check that it is running on your server, then reload this page.
            </Notice>
          </CardContent>
        ) : (
          <ConsumerSwitches initial={c.consumers} onSave={saveConsumers} />
        )}
      </Card>
      <Card>
        <Rows label="Catalogue">
          <Row
            title="Catalogue"
            description="The plain sentence shown with each kind of alert: what it means and what to do next."
            control={
              <Button variant="outline" size="sm" asChild>
                <Link href="/alert-routing/catalogue">Open catalogue →</Link>
              </Button>
            }
          />
        </Rows>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>Advanced</CardTitle>
          <CardDescription>
            The rules that decide which Slack channel each alert goes to. They are written as a list in a code-like format. Change them only if you are comfortable editing it; a mistake is refused when you save, and nothing changes until a save succeeds.
          </CardDescription>
        </CardHeader>
        <CardContent className="lares-stack">
          {"unavailable" in r ? (
            <Notice error>
              The routing rules could not be loaded because the service that records alerts did not answer. Check that it is running on your server, then reload this page.
            </Notice>
          ) : (
            <JsonEditor
              label="Routing rules"
              initial={r.rules}
              onSave={saveRules}
              hint="The list is read from the top and the first rule that matches wins. In a rule, project, severity, type, source and kind are optional: leave one out to match anything. destinations is the list of Slack channel ids the alert is posted to. allowTarget lets a report choose its own channel. Save replaces the whole list."
            />
          )}
        </CardContent>
      </Card>
    </Page>
  );
}
