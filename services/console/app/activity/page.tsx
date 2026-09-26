import Link from "next/link";
import { PageHeader } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Input } from "@lares/ui/primitives/input";
import { getPermissionEvents } from "../../lib/console-overview";
import { PermissionEvents } from "../../components/PermissionEvents";
export const dynamic = "force-dynamic";
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string; before?: string }>;
}) {
  const { agent, before } = await searchParams;
  const events = await getPermissionEvents({ agent, before });
  const next = events.available && events.value.next;
  return (
    <div className="lares-page lares-stack">
      <PageHeader
        title="Activity"
        description="Permission decisions across your agents."
        actions={
          <Button variant="outline" asChild>
            <Link href="/signals">Signals & events →</Link>
          </Button>
        }
      />
      <form className="lares-actions" action="/activity">
        <label>
          Agent name
          <Input
            name="agent"
            defaultValue={agent ?? ""}
            placeholder="All agents"
          />
        </label>
        <Button variant="outline" type="submit">
          Filter
        </Button>
        {agent && <Link href="/activity">Clear filter</Link>}
      </form>
      <section>
        <PermissionEvents events={events} />
      </section>
      <p className="lares-muted">
        These records show permission decisions. Completed work appears in the
        original conversation.
      </p>
      {next && (
        <Button variant="outline" asChild>
          <Link
            href={`/activity?${new URLSearchParams({ ...(agent ? { agent } : {}), before: next })}`}
          >
            Older checks →
          </Link>
        </Button>
      )}
    </div>
  );
}
