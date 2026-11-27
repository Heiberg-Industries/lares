import { requirePage } from "../../lib/auth";
import { listAutoSendSeries } from "../../lib/meeting-series";
import { MeetingSeriesRow } from "../../components/MeetingSeriesRow";
import { EmptyState, PageHeader, Page, Rows } from "@lares/ui/patterns";
import { Card } from "@lares/ui/primitives/card";

export const dynamic = "force-dynamic";

export default async function MeetingsPage() {
  await requirePage("admin");
  const series = await listAutoSendSeries();

  return (
    <Page>
      <PageHeader
        title="Meeting follow-ups"
        description="Recurring meetings where an agent may send the follow-up email without asking you first."
      />
      <p className="lares-muted">
        Revoking a series doesn&apos;t delete its history. The follow-up goes back to needing your
        approval, the same as before it was switched on.
      </p>

      {series.length === 0 ? (
        <EmptyState title="No meeting series sends follow-ups on its own">
          Ask your agent to switch one on.
        </EmptyState>
      ) : (
        <Card>
          <Rows label="Meeting series that send follow-ups on their own">
            {series.map((s) => (
              <MeetingSeriesRow
                key={`${s.agent}/${s.seriesKey}`}
                agent={s.agent}
                seriesKey={s.seriesKey}
                name={s.name}
                updatedBy={s.updatedBy}
                updatedAt={s.updatedAt.toISOString().slice(0, 10)}
              />
            ))}
          </Rows>
        </Card>
      )}
    </Page>
  );
}
