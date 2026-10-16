import { PageHeader } from "@lares/ui/patterns";
import { builderData, editedOutsideTheConsole } from "../../../../lib/builder";
import { DefinitionForm } from "../../../../components/DefinitionForm";
export const dynamic = "force-dynamic";
export default async function EditAgentPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  try {
    const data = await builderData(name);
    const outside = await editedOutsideTheConsole(name);
    return (
      <div className="lares-page lares-settings">
        <PageHeader
          title={`Edit ${name}`}
          description="Identity, instructions, access and schedules."
        />
        <p>
          <a href={`/agents/${encodeURIComponent(name)}`}>Agent overview</a>
        </p>
        {outside && (
          <p>
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
      </div>
    );
  } catch (error) {
    return (
      <div className="lares-page lares-settings">
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
      </div>
    );
  }
}
