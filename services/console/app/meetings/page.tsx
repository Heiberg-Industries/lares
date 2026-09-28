import { listAutoSendSeries } from "../../lib/meeting-series";
import { MeetingSeriesRow } from "../../components/MeetingSeriesRow";
import { PageHeader } from "@lares/ui/patterns";

export const dynamic = "force-dynamic";

export default async function MeetingsPage() {
  const series = await listAutoSendSeries();

  return (
    <div className="lares-page lares-operational">
      <PageHeader title="Meeting follow-ups" description="Recurring series with approved automatic follow-ups." />
      <p className="lares-muted">
        Recurring meeting series Saga is allowed to send the follow-up email for without asking
        first. Revoking a series doesn&apos;t delete its history — it goes back to needing your
        approval, the same as before it was switched on.
      </p>

      {series.length === 0 ? (
        <p style={{ color: "var(--mist)", fontSize: 13, marginTop: 24 }}>
          No meeting series are on auto-send. Ask Saga to switch one on.
        </p>
      ) : (
        <div className="lares-table-scroll"><table className="card" style={{ marginTop: 16 }}>
          <thead><tr><th>Series</th><th>Turned on by</th><th>When</th><th></th></tr></thead>
          <tbody>
            {series.map((s) => (
              <MeetingSeriesRow
                key={s.seriesKey}
                seriesKey={s.seriesKey}
                name={s.name}
                updatedBy={s.updatedBy}
                updatedAt={s.updatedAt.toISOString().slice(0, 10)}
              />
            ))}
          </tbody>
        </table></div>
      )}
    </div>
  );
}
