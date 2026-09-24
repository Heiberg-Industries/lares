import { describe, it, expect, vi, beforeEach } from "vitest";

// Same mocking shape as tests/notion-proposals.test.ts and tests/notion-sync-tile.test.ts: a pool
// whose .query is a controllable mock, so getBackupStatus's own SQL runs for real against a fake
// result set — no database, no testcontainer.
const queryMock = vi.fn();
vi.mock("../lib/db", () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }));

import {
  protectionVerdict, getBackupStatus, VERIFY_MAX_AGE_HOURS, DRILL_MAX_AGE_DAYS,
  type BackupCheckRow, type BackupStatusRows,
} from "../lib/backup-status";

beforeEach(() => { queryMock.mockReset(); });

const NOW = new Date("2026-09-18T08:00:00Z");

function check(over: Partial<BackupCheckRow> = {}): BackupCheckRow {
  return { ok: true, checkedAt: NOW, lastPassAt: NOW, detail: null, target: "rclone:box:repo", ...over };
}

function rows(over: Partial<BackupStatusRows> = {}): BackupStatusRows {
  return { verify: check(), drill: check(), ...over };
}

describe("protectionVerdict", () => {
  it("is protected when the verify check is fresh and ok, and a drill has passed within the window", () => {
    const v = protectionVerdict(rows(), NOW);
    expect(v).toEqual({ state: "protected", reasons: [] });
  });

  it("is not-protected when the verify check is not ok", () => {
    const v = protectionVerdict(rows({ verify: check({ ok: false, detail: "stale snapshot" }) }), NOW);
    expect(v.state).toBe("not-protected");
    expect(v.reasons).toEqual(["Last night's backup check did not pass: stale snapshot"]);
  });

  it("is not-protected when the verify check has never run", () => {
    const v = protectionVerdict(rows({ verify: check({ ok: null, checkedAt: null, detail: null }) }), NOW);
    expect(v.state).toBe("not-protected");
    expect(v.reasons).toEqual(["The nightly backup check has never run."]);
  });

  it("is protected at exactly VERIFY_MAX_AGE_HOURS old — the boundary is inclusive", () => {
    const checkedAt = new Date(NOW.getTime() - VERIFY_MAX_AGE_HOURS * 3_600_000);
    const v = protectionVerdict(rows({ verify: check({ checkedAt }) }), NOW);
    expect(v.state).toBe("protected");
  });

  it("is not-protected one hour past VERIFY_MAX_AGE_HOURS", () => {
    const checkedAt = new Date(NOW.getTime() - (VERIFY_MAX_AGE_HOURS + 1) * 3_600_000);
    const v = protectionVerdict(rows({ verify: check({ checkedAt }) }), NOW);
    expect(v.state).toBe("not-protected");
    expect(v.reasons).toEqual([`The last backup check was more than ${VERIFY_MAX_AGE_HOURS} hours ago (${VERIFY_MAX_AGE_HOURS + 1}h).`]);
  });

  it("is not-protected when the drill failed", () => {
    const v = protectionVerdict(rows({ drill: check({ ok: false, detail: "restore did not complete" }) }), NOW);
    expect(v.state).toBe("not-protected");
    expect(v.reasons).toEqual(["The last restore drill failed: restore did not complete"]);
  });

  it("is protected at exactly DRILL_MAX_AGE_DAYS old — the boundary is inclusive", () => {
    const lastPassAt = new Date(NOW.getTime() - DRILL_MAX_AGE_DAYS * 86_400_000);
    const v = protectionVerdict(rows({ drill: check({ lastPassAt }) }), NOW);
    expect(v.state).toBe("protected");
  });

  it("is not-protected one day past DRILL_MAX_AGE_DAYS", () => {
    const lastPassAt = new Date(NOW.getTime() - (DRILL_MAX_AGE_DAYS + 1) * 86_400_000);
    const v = protectionVerdict(rows({ drill: check({ lastPassAt }) }), NOW);
    expect(v.state).toBe("not-protected");
    expect(v.reasons).toEqual([`The last successful restore drill was more than ${DRILL_MAX_AGE_DAYS} days ago (${DRILL_MAX_AGE_DAYS + 1}d).`]);
  });

  it("is unproven when verify is ok and no drill has ever passed", () => {
    const v = protectionVerdict(rows({ drill: check({ ok: null, lastPassAt: null, checkedAt: null }) }), NOW);
    expect(v.state).toBe("unproven");
    expect(v.reasons).toEqual(["The backup checks out, but no restore has ever been rehearsed successfully."]);
  });

  it("never-rehearsed rows for both checks: verify drives the verdict, not the drill's null state alone", () => {
    // A brand-new install: sql/049's seed leaves both rows all-NULL except check_name/created_at.
    const v = protectionVerdict(rows({ verify: check({ ok: null, checkedAt: null }), drill: check({ ok: null, lastPassAt: null, checkedAt: null }) }), NOW);
    expect(v.state).toBe("not-protected");
    expect(v.reasons).toEqual(["The nightly backup check has never run."]);
  });

  it("collects more than one reason when several things are wrong at once", () => {
    const v = protectionVerdict(rows({
      verify: check({ ok: false, detail: "stale" }),
      drill: check({ ok: false, detail: "failed restore" }),
    }), NOW);
    expect(v.state).toBe("not-protected");
    expect(v.reasons).toHaveLength(2);
  });
});

describe("getBackupStatus", () => {
  it("reads both rows and returns the verdict, target and dates", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { check_name: "verify", ok: true, checked_at: NOW, last_pass_at: NOW, detail: null, target: "rclone:box:repo" },
        { check_name: "drill", ok: true, checked_at: NOW, last_pass_at: NOW, detail: null, target: "rclone:box:repo" },
      ],
    });
    const status = await getBackupStatus(NOW);
    expect(status.unavailable).toBeUndefined();
    expect(status.state).toBe("protected");
    expect(status.verify.target).toBe("rclone:box:repo");
    expect(status.drill.lastPassAt).toEqual(NOW);
  });

  it("treats a missing row as never-checked rather than throwing", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const status = await getBackupStatus(NOW);
    expect(status.unavailable).toBeUndefined();
    expect(status.state).toBe("not-protected");
    expect(status.verify.ok).toBeNull();
  });

  it("degrades to unavailable instead of throwing when the table is missing", async () => {
    queryMock.mockRejectedValue(new Error('relation "backup_status" does not exist'));
    const status = await getBackupStatus(NOW);
    expect(status.unavailable).toBe(true);
  });
});
