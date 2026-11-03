import { requireConsolePage } from "../../../../lib/auth";
import { PageHeader, Page } from "@lares/ui/patterns";
import { builderData, editedOutsideTheConsole } from "../../../../lib/builder";
import { DefinitionForm } from "../../../../components/DefinitionForm";
export const dynamic = "force-dynamic";
export default async function EditAgentPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  await requireConsolePage();
  const { name } = await params;
  try {
    const data = await builderData(name);
    const outside = await editedOutsideTheConsole(name);
    return (
      <Page>
        <PageHeader
          title={`Edit ${name}`}
          description="Identity, instructions, access and schedules."
          actions={<a href={`/agents/${encodeURIComponent(name)}`}>Agent overview</a>}
        />
        {outside && (
          <p className="lares-muted">
            Changed outside the console,{" "}
            {new Date(outside.at).toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
              timeZone: "UTC",
            })}
            .
          </p>
        )}
        <DefinitionForm {...data} />
      </Page>
    );
  } catch (error) {
    return (
      <Page width="narrow" className="lares-settings">
        <PageHeader
          title={`Edit ${name}`}
          description="Identity, instructions, access and schedules."
        />
        <p role="alert">
          The builder is unavailable:{" "}
          {error instanceof Error
            ? error.message
            : "Could not load keeper state."}
        </p>
      </Page>
    );
  }
}
