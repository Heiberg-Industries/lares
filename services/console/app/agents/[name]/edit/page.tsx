import { mayUse, requirePage } from "../../../../lib/auth";
import Link from "next/link";
import { Notice, PageHeader, Page } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { builderData, editedOutsideTheConsole } from "../../../../lib/builder";
import { DefinitionForm } from "../../../../components/DefinitionForm";
export const dynamic = "force-dynamic";
export default async function EditAgentPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const member = await requirePage("owner");
  const { name } = await params;
  try {
    const data = await builderData(name);
    const outside = await editedOutsideTheConsole(name);
    return (
      <Page>
        <PageHeader
          title={`Edit ${name}`}
          description="Identity, instructions, access and schedules."
          actions={
            <Button variant="outline" asChild>
              <Link href={`/agents/${encodeURIComponent(name)}`}>Agent overview</Link>
            </Button>
          }
        />
        {outside && (
          <Notice>
            Changed outside the console,{" "}
            {new Date(outside.at).toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
              timeZone: "UTC",
            })}
            .
          </Notice>
        )}
        <DefinitionForm {...data} owner={mayUse(member, "owner")} />
      </Page>
    );
  } catch (error) {
    return (
      <Page>
        <PageHeader
          title={`Edit ${name}`}
          description="Identity, instructions, access and schedules."
        />
        <Notice error>
          This agent’s settings could not be loaded:{" "}
          {error instanceof Error
            ? error.message
            : "The server did not answer."}
        </Notice>
      </Page>
    );
  }
}
