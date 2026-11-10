import Link from "next/link";
import { requireConsolePage } from "../../lib/auth";
import { Page, PageHeader } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { getConnectionRows } from "../../lib/connections";
import { getCredentialView } from "../../lib/credentials";
import { anyOutsideToolsInUse } from "../../lib/outside-tools";
import { getGatewayStatusView } from "../../lib/gateway-status";
import { buildIntegrationCards } from "../../lib/integrations-grid";
import { IntegrationsGrid } from "../../components/IntegrationsGrid";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  await requireConsolePage();
  const [rows, credential, outsideToolsInUse, gateway] = await Promise.all([getConnectionRows(), getCredentialView(), anyOutsideToolsInUse(), getGatewayStatusView()]);
  return (
    <Page className="lares-stack">
      <PageHeader title="Integrations" description="Services shared by the whole installation. Only the owner turns them on or changes them."
        actions={<>
          <Button variant="outline" asChild><Link href="/voice">Email writing style</Link></Button>
          <Button variant="outline" asChild><Link href="/meetings">Meetings</Link></Button>
        </>} />
      <IntegrationsGrid cards={buildIntegrationCards({ rows, credential, outsideToolsInUse, gateway })} />
      <p className="lares-muted">Each card opens its page with the details: which agents use it, when it was last used, where its key is kept, and test buttons.</p>
    </Page>
  );
}
