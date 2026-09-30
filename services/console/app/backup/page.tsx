import { getBackupStatus, type BackupCheckRow, type BackupState } from "../../lib/backup-status";
import { PageHeader } from "@lares/ui/patterns";

export const dynamic = "force-dynamic";

const STATE_LABEL: Record<BackupState, string> = {
  protected: "Protected",
  unproven: "Unproven",
  "not-protected": "Not protected",
};

const STATE_CLASS: Record<BackupState, string> = {
  protected: "lares-status-success",
  unproven: "lares-status-warning",
  "not-protected": "lares-status-error",
};

const STATE_SUMMARY: Record<BackupState, string> = {
  protected: "Last night's backup was verified, and a restore from it has been proven within the last 45 days.",
  unproven: "Last night's backup was verified, but no restore has ever been rehearsed successfully — so it works right up until the day you'd actually need it.",
  "not-protected": "This installation is not currently protected.",
};

/** `YYYY-MM-DD HH:MM` (UTC), or a fallback when the timestamp is missing — the same
 *  `toISOString().replace("T", " ").slice(0, 16)` shape `app/markets/page.tsx` and
 *  `lib/markets.ts` already use for a timestamp shown with its time, not just its day. */
function when(d: Date | null, never: string): string {
  return d ? d.toISOString().replace("T", " ").slice(0, 16) : never;
}

function CheckRow({ label, row, neverPassLabel }: { label: string; row: BackupCheckRow; neverPassLabel: string }) {
  return (
    <tr>
      <td className="mono">{label}</td>
      <td className={`mono ${row.ok === true ? "lares-status-success" : row.ok === false ? "lares-status-error" : "lares-status-muted"}`}>
        {row.ok === true ? "ok" : row.ok === false ? "failed" : "never run"}
      </td>
      <td className="mono">{when(row.checkedAt, "—")}</td>
      <td className="mono">{when(row.lastPassAt, neverPassLabel)}</td>
      <td className="lares-status-muted">{row.target ?? "—"}</td>
    </tr>
  );
}

export default async function BackupPage() {
  const status = await getBackupStatus();

  return (
    <div className="lares-page lares-operational">
      <PageHeader title="Backup" description="Recorded backup and restore evidence for this installation." />
      <p className="lares-muted lares-operational-intro">
        Whether this installation&apos;s data is protected: when the nightly backup was last
        verified, when a restore was last actually rehearsed, and where backups go. This page only
        reads that record — it runs no backup and no restore itself.
      </p>

      {status.unavailable ? (
        <p className="lares-operational-error" role="alert">
          Backup status couldn&apos;t be read. Check the database and backup-status setup, then reload this page. This does not confirm whether a backup exists.
        </p>
      ) : (
        <>
          <h2 className={STATE_CLASS[status.state]}>
            {STATE_LABEL[status.state]}
          </h2>
          <p className="lares-muted lares-operational-intro">{STATE_SUMMARY[status.state]}</p>

          {status.reasons.length > 0 && (
            <ul className="lares-muted lares-operational-note">
              {status.reasons.map((reason, i) => <li key={i}>{reason}</li>)}
            </ul>
          )}

          <h2>Checks</h2>
          <div className="lares-table-scroll"><table className="card lares-operational-table">
            <thead>
              <tr><th>Check</th><th>Status</th><th>Last checked</th><th>Last pass</th><th>Target</th></tr>
            </thead>
            <tbody>
              <CheckRow label="Nightly backup verify" row={status.verify} neverPassLabel="never" />
              <CheckRow label="Monthly restore drill" row={status.drill} neverPassLabel="never rehearsed" />
            </tbody>
          </table></div>
        </>
      )}
    </div>
  );
}
