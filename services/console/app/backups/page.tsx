import { requireConsolePage } from "../../lib/auth";
import { getBackupStatus, type BackupCheckRow, type BackupState } from "../../lib/backup-status";
import { Notice, PageHeader, Page, type NoticeTone } from "@lares/ui/patterns";
import { Badge } from "@lares/ui/primitives/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@lares/ui/primitives/card";

export const dynamic = "force-dynamic";

const STATE_LABEL: Record<BackupState, string> = {
  protected: "Protected",
  unproven: "Unproven",
  "not-protected": "Not protected",
};

const STATE_TONE: Record<BackupState, NoticeTone> = {
  protected: "success",
  unproven: "needs-you",
  "not-protected": "error",
};

const STATE_SUMMARY: Record<BackupState, string> = {
  protected: "Last night's backup was verified, and a restore from it has been proven within the last 45 days.",
  unproven: "Last night's backup was verified, but no restore from it has ever been tried successfully, so nobody knows yet whether it can be used on the day you need it.",
  "not-protected": "This installation is not currently protected.",
};

/** `YYYY-MM-DD HH:MM` (UTC), or a fallback when the timestamp is missing — the same
 *  `toISOString().replace("T", " ").slice(0, 16)` shape for a timestamp shown with its
 *  time, not just its day. */
function when(d: Date | null, never: string): string {
  return d ? d.toISOString().replace("T", " ").slice(0, 16) : never;
}

function CheckRow({ label, row, neverPassLabel }: { label: string; row: BackupCheckRow; neverPassLabel: string }) {
  return (
    <tr>
      <td>{label}</td>
      <td>
        {row.ok === true ? <Badge variant="success">Passed</Badge> : row.ok === false ? <Badge variant="error">Failed</Badge> : <Badge>Never run</Badge>}
      </td>
      <td className="mono">{when(row.checkedAt, "—")}</td>
      <td className="mono">{when(row.lastPassAt, neverPassLabel)}</td>
      <td className="lares-muted">{row.target ?? "—"}</td>
    </tr>
  );
}

export default async function BackupPage() {
  await requireConsolePage();
  const status = await getBackupStatus();

  return (
    <Page>
      <PageHeader
        title="Backups"
        description="Whether this installation's data is protected: when the nightly backup was last checked, when restoring from it was last tried, and where backups go."
      />
      <p className="lares-muted">
        This page only shows what has been recorded. It runs no backup and no restore itself. Times are in UTC.
      </p>

      {status.unavailable ? (
        <Notice error>
          Backup status couldn&apos;t be read. Check the database and backup-status setup, then reload this page. This does not confirm whether a backup exists.
        </Notice>
      ) : (
        <>
          <Notice tone={STATE_TONE[status.state]}>
            <p><strong>{STATE_LABEL[status.state]}.</strong> {STATE_SUMMARY[status.state]}</p>
            {status.reasons.length > 0 && (
              <ul>
                {status.reasons.map((reason, i) => <li key={i}>{reason}</li>)}
              </ul>
            )}
          </Notice>

          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={2}>Checks</CardTitle>
              <CardDescription>The nightly check that the backup can be read, and the monthly test that restores from it.</CardDescription>
            </CardHeader>
            <div className="lares-table-scroll"><table>
              <thead>
                <tr><th>Check</th><th>Result</th><th>Last checked</th><th>Last passed</th><th>Where backups go</th></tr>
              </thead>
              <tbody>
                <CheckRow label="Nightly backup check" row={status.verify} neverPassLabel="never" />
                <CheckRow label="Monthly restore test" row={status.drill} neverPassLabel="never rehearsed" />
              </tbody>
            </table></div>
          </Card>
          <p className="lares-muted">
            <a href="https://github.com/Heiberg-Industries/lares/blob/main/docs/runbooks/definition-backups.md#optional-setup-for-an-installation-administrator" target="_blank" rel="noopener noreferrer">
              Guide: optional backups of agent definitions ↗
            </a>
          </p>
        </>
      )}
    </Page>
  );
}
