import { getBackupStatus, type BackupCheckRow, type BackupState } from "../../lib/backup-status";

export const dynamic = "force-dynamic";

const lede = { color: "var(--mist)", fontSize: 12, marginTop: 4 } as const;

const STATE_LABEL: Record<BackupState, string> = {
  protected: "Protected",
  unproven: "Unproven",
  "not-protected": "Not protected",
};

const STATE_COLOR: Record<BackupState, string> = {
  protected: "var(--ok)",
  unproven: "var(--warn)",
  "not-protected": "var(--bad)",
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
      <td className="mono" style={{ color: row.ok === true ? "var(--ok)" : row.ok === false ? "var(--bad)" : "var(--mist)" }}>
        {row.ok === true ? "ok" : row.ok === false ? "failed" : "never run"}
      </td>
      <td className="mono">{when(row.checkedAt, "—")}</td>
      <td className="mono">{when(row.lastPassAt, neverPassLabel)}</td>
      <td style={{ color: "var(--mist)" }}>{row.target ?? "—"}</td>
    </tr>
  );
}

export default async function BackupPage() {
  const status = await getBackupStatus();

  return (
    <>
      <h1 className="mono" style={{ fontSize: 18 }}>Backup</h1>
      <p style={lede}>
        Whether this installation&apos;s data is protected: when the nightly backup was last
        verified, when a restore was last actually rehearsed, and where backups go. This page only
        reads that record — it runs no backup and no restore itself.
      </p>

      {status.unavailable ? (
        <p className="mono" style={{ marginTop: 16, color: "var(--bad)" }}>
          Backup status couldn&apos;t be read. If this installation has not applied sql/049_backup_status.sql yet, apply it on the server and reload this page; otherwise the database is not answering.
        </p>
      ) : (
        <>
          <h2 className="mono" style={{ fontSize: 14, marginTop: 24, color: STATE_COLOR[status.state] }}>
            {STATE_LABEL[status.state]}
          </h2>
          <p style={lede}>{STATE_SUMMARY[status.state]}</p>

          {status.reasons.length > 0 && (
            <ul style={{ marginTop: 8, color: "var(--mist)", fontSize: 12 }}>
              {status.reasons.map((reason, i) => <li key={i}>{reason}</li>)}
            </ul>
          )}

          <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>Checks</h2>
          <table className="card" style={{ marginTop: 8 }}>
            <thead>
              <tr><th>Check</th><th>Status</th><th>Last checked</th><th>Last pass</th><th>Target</th></tr>
            </thead>
            <tbody>
              <CheckRow label="Nightly backup verify" row={status.verify} neverPassLabel="never" />
              <CheckRow label="Monthly restore drill" row={status.drill} neverPassLabel="never rehearsed" />
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
