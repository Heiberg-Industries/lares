import { requirePage } from "../../lib/auth";
import { Notice, PageHeader, Page, Row, Rows } from "@lares/ui/patterns";
import { Card, CardContent, CardHeader, CardTitle } from "@lares/ui/primitives/card";
import { ModelsSection } from "../../components/ModelsSection";
import { AgentLimitControl } from "../../components/AgentLimitControl";
import { getAgentLimitView } from "../../lib/agent-limit";
import { AgentSettingsSections } from "../../components/AgentSettingsControl";
import { getAgentSettingsView } from "../../lib/agent-settings";
import { getGatewayStatusView } from "../../lib/gateway-status";
import { getProactivityView } from "../../lib/proactivity";
export const dynamic = "force-dynamic";
export default async function GeneralPage() {
  await requirePage("owner");
  const [view, gateway, limit, agentSettings] = await Promise.all([getProactivityView().catch(() => null), getGatewayStatusView(), getAgentLimitView(), getAgentSettingsView()]);
  return (
    <Page>
      <PageHeader title="General" description="Settings shared by the whole installation." />
      <Card>
        <Rows label="Time zone">
          <Row
            title="Time zone"
            description="Used for schedules and your daily brief."
            control={<span className="mono">{view?.clock.tz ?? "Unavailable"}</span>}
          />
        </Rows>
      </Card>
      <ModelsSection view={gateway} />
      <Card>
        <CardContent className="lares-stack">
          <CardTitle role="heading" aria-level={2}>Agents</CardTitle>
          {limit ? <AgentLimitControl capacity={limit} /> : <Notice error>The agent limit could not be loaded. Reload this page to try again.</Notice>}
        </CardContent>
      </Card>
      {agentSettings ? <AgentSettingsSections settings={agentSettings.settings} canChange={agentSettings.canChange} /> : (
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>Agent settings</CardTitle>
          </CardHeader>
          <CardContent className="lares-stack">
            <Notice error>The agent settings could not be loaded. Reload this page to try again.</Notice>
          </CardContent>
        </Card>
      )}
    </Page>
  );
}
