import { requireConsolePage } from "../../lib/auth";
import { Page, PageHeader } from "@lares/ui/patterns";
import { getConnectionRows } from "../../lib/connections";
import { getCredentialView } from "../../lib/credentials";
import { anyOutsideToolsInUse } from "../../lib/outside-tools";
import { buildIntegrationCards } from "../../lib/integrations-grid";
import { IntegrationsGrid } from "../../components/IntegrationsGrid";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  await requireConsolePage();
  const [rows, credential, outsideToolsInUse] = await Promise.all([getConnectionRows(), getCredentialView(), anyOutsideToolsInUse()]);
  return (
    <Page className="lares-stack">
      <PageHeader title="Integrations" description="Services shared by the whole installation. Only the owner turns them on or changes them." />
      <IntegrationsGrid cards={buildIntegrationCards({ rows, credential, outsideToolsInUse })} />
      <p className="lares-muted">Each card opens its page with the details: which agents use it, when it was last used, where its key is kept, and test buttons.</p>
    </Page>
  );
}
