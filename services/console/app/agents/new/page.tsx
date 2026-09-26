import { AgentsList } from "../../../components/AgentsList";
import { getFleetSnapshot } from "../../../lib/console-overview";
import Link from "next/link";
import { PageHeader, EmptyState } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { builderData } from "../../../lib/builder";
import { DefinitionForm } from "../../../components/DefinitionForm";
export const dynamic = "force-dynamic";
export default async function NewAgentPage() {
  const data = await builderData().catch(() => null);
  if (data)
    return (
      <>
        <AgentsList snapshot={await getFleetSnapshot()} />
        <DefinitionForm {...data} />
      </>
    );
  return (
    <div className="lares-page lares-settings">
      <PageHeader
        title="Create an agent"
        description="A purpose, a name, and a clear set of permissions."
      />

      <EmptyState
        title="Agent setup is unavailable"
        action={
          <Button variant="outline" asChild>
            <Link href="/agents">Back to agents</Link>
          </Button>
        }
      >
        The agent manager could not be reached. Your existing agents have not
        been changed.
      </EmptyState>
    </div>
  );
}
