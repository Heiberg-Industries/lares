/**
 * LAR-54-s5 — the read layer behind `/backup`.
 *
 * Decision 2 of `docs/specs/2026-09-03-backup-and-restore-per-installation-design.md` (settled
 * 2026-09-04): the console owns "protected / not protected" because Lares is for non-technical
 * owners, not the command line. This file reads the one table the box's nightly check and monthly
 * restore rehearsal write to (`sql/049_backup_status.sql`: rows `verify` and `drill`) and turns it
 * into a verdict a non-developer can act on — never the other way around; the console only reads.
 *
 * `VERIFY_MAX_AGE_HOURS` and `DRILL_MAX_AGE_DAYS` MIRROR, NOT IMPORT, the two windows
 * `services/box/ops/backup-verify.sh` enforces on the box (its `MAX_AGE_HOURS` and
 * `DRILL_MAX_AGE_DAYS`) — the same "mirrored, not imported" rule the header of
 * `tests/engine-drift.test.ts` states for the console's other engine numbers: this package does
 * not depend on the box's shell scripts, so the two are checked in one place and kept in step by
 * hand rather than by an import.
 */
import { pool } from "./db";

/** The nightly check runs once a day; 26 h = that day plus the same two hours of grace the
 *  heartbeat monitor gives it. (The script's own 24 h window is about the SNAPSHOT's age, not this.) */
export const VERIFY_MAX_AGE_HOURS = 26;
export const DRILL_MAX_AGE_DAYS = 45;

export type BackupState = "protected" | "unproven" | "not-protected";

export interface BackupCheckRow {
  ok: boolean | null;
  checkedAt: Date | null;
  lastPassAt: Date | null;
  detail: string | null;
  target: string | null;
}

export interface BackupStatusRows {
  verify: BackupCheckRow;
  drill: BackupCheckRow;
}

export interface BackupVerdict {
  state: BackupState;
  reasons: string[];
}

export interface BackupStatusDTO extends BackupStatusRows, BackupVerdict {
  unavailable?: true;
}

const NEVER_CHECKED: BackupCheckRow = { ok: null, checkedAt: null, lastPassAt: null, detail: null, target: null };

function hoursSince(at: Date, now: Date): number {
  return (now.getTime() - at.getTime()) / 3_600_000;
}

function daysSince(at: Date, now: Date): number {
  return (now.getTime() - at.getTime()) / 86_400_000;
}

/**
 * PURE — no database, no clock of its own. `not-protected` when the verify check is not ok, is
 * older than `VERIFY_MAX_AGE_HOURS`, the drill failed, or the last drill pass is older than
 * `DRILL_MAX_AGE_DAYS`. `unproven` when the verify check is ok but no drill has ever passed —
 * the backup itself checks out, but restoring from it has never been proven. Otherwise
 * `protected`. Boundaries are inclusive: exactly `VERIFY_MAX_AGE_HOURS` hours or exactly
 * `DRILL_MAX_AGE_DAYS` days still counts as within the window.
 */
export function protectionVerdict(rows: BackupStatusRows, now: Date): BackupVerdict {
  const { verify, drill } = rows;
  const reasons: string[] = [];

  if (verify.ok === null) {
    reasons.push("The nightly backup check has never run.");
  } else if (verify.ok === false) {
    reasons.push(`Last night's backup check did not pass${verify.detail ? `: ${verify.detail}` : "."}`);
  }

  const verifyAgeHours = verify.checkedAt ? hoursSince(verify.checkedAt, now) : null;
  if (verify.ok !== null && verifyAgeHours !== null && verifyAgeHours > VERIFY_MAX_AGE_HOURS) {
    reasons.push(`The last backup check was more than ${VERIFY_MAX_AGE_HOURS} hours ago (${Math.floor(verifyAgeHours)}h).`);
  }

  if (drill.ok === false) {
    reasons.push(`The last restore drill failed${drill.detail ? `: ${drill.detail}` : "."}`);
  }

  const drillAgeDays = drill.lastPassAt ? daysSince(drill.lastPassAt, now) : null;
  if (drillAgeDays !== null && drillAgeDays > DRILL_MAX_AGE_DAYS) {
    reasons.push(`The last successful restore drill was more than ${DRILL_MAX_AGE_DAYS} days ago (${Math.floor(drillAgeDays)}d).`);
  }

  if (reasons.length > 0) return { state: "not-protected", reasons };

  if (drill.lastPassAt === null) {
    return {
      state: "unproven",
      reasons: ["The backup checks out, but no restore has ever been rehearsed successfully."],
    };
  }

  return { state: "protected", reasons: [] };
}

function toCheckRow(row: {
  ok: boolean | null;
  checked_at: Date | null;
  last_pass_at: Date | null;
  detail: string | null;
  target: string | null;
} | undefined): BackupCheckRow {
  if (!row) return NEVER_CHECKED;
  return { ok: row.ok, checkedAt: row.checked_at, lastPassAt: row.last_pass_at, detail: row.detail, target: row.target };
}

/**
 * Degrades like `getNotionSyncStatus` in `lib/queries.ts`: any query failure (including a
 * `backup_status` table that does not exist yet, before `sql/049_backup_status.sql` is
 * hand-applied) returns `unavailable: true` rather than taking the page down.
 */
export async function getBackupStatus(now: Date = new Date()): Promise<BackupStatusDTO> {
  try {
    const { rows } = await pool.query<{
      check_name: "verify" | "drill";
      ok: boolean | null;
      checked_at: Date | null;
      last_pass_at: Date | null;
      detail: string | null;
      target: string | null;
    }>(`SELECT check_name, ok, checked_at, last_pass_at, detail, target FROM backup_status`);
    const byName = new Map(rows.map((r) => [r.check_name, r]));
    const verify = toCheckRow(byName.get("verify"));
    const drill = toCheckRow(byName.get("drill"));
    const { state, reasons } = protectionVerdict({ verify, drill }, now);
    return { state, reasons, verify, drill };
  } catch {
    return { state: "not-protected", reasons: [], verify: NEVER_CHECKED, drill: NEVER_CHECKED, unavailable: true };
  }
}
