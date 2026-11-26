import { requirePage } from "../../lib/auth";
import Link from "next/link";
import { Field, PageHeader, Page } from "@lares/ui/patterns";
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
  await requirePage("admin");
  const { agent, before } = await searchParams;
  const events = await getPermissionEvents({ agent, before });
  const next = events.available && events.value.next;
  return (
    <Page className="lares-stack">
      <PageHeader
        title="Permission checks"
        description="Each time an agent asked whether it may use a tool, and what was decided."
        actions={
          <Button variant="outline" asChild>
            <Link href="/alerts">Alerts →</Link>
          </Button>
        }
      />
      <form className="lares-inline-form" action="/permission-checks">
        <Field label="Agent name">
          <Input name="agent" defaultValue={agent ?? ""} placeholder="All agents" />
        </Field>
        <Button variant="outline" type="submit">
          Filter
        </Button>
        {agent && (
          <Button variant="ghost" asChild>
            <Link href="/permission-checks">Clear filter</Link>
          </Button>
        )}
      </form>
      <PermissionEvents events={events} />
      <p className="lares-muted">
        These records show permission decisions. Completed work appears in the
        original conversation.
      </p>
      {next && (
        <Button variant="outline" asChild>
          <Link
            href={`/permission-checks?${new URLSearchParams({ ...(agent ? { agent } : {}), before: next })}`}
          >
            Older checks →
          </Link>
        </Button>
      )}
    </Page>
  );
}
