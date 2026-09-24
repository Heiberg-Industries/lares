import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { BackupStatusDTO, BackupCheckRow } from "../lib/backup-status";

// Same pattern as tests/deadlines-page.test.tsx: the page's own read is mocked, everything else is
// real, so this renders the actual markup an owner sees.
const { getBackupStatus } = vi.hoisted(() => ({ getBackupStatus: vi.fn() }));

vi.mock("../lib/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock("../lib/backup-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/backup-status")>();
  return { ...actual, getBackupStatus };
});

function check(over: Partial<BackupCheckRow> = {}): BackupCheckRow {
  return {
    ok: true,
    checkedAt: new Date("2026-09-18T03:05:00Z"),
    lastPassAt: new Date("2026-09-01T03:10:00Z"),
    detail: null,
    target: "rclone:storagebox:repo",
    ...over,
  };
}

function status(over: Partial<BackupStatusDTO> = {}): BackupStatusDTO {
  return {
    state: "protected",
    reasons: [],
    verify: check(),
    drill: check(),
    ...over,
  };
}

async function render(v: BackupStatusDTO): Promise<string> {
  getBackupStatus.mockResolvedValue(v);
  const { default: BackupPage } = await import("../app/backup/page");
  return renderToStaticMarkup(await BackupPage());
}

beforeEach(() => {
  getBackupStatus.mockReset();
  vi.resetModules();
});

describe("/backup", () => {
  it("protected: shows the verdict, target, both dates, and no reasons", async () => {
    const html = await render(status({
      state: "protected",
      reasons: [],
      verify: check({ target: "rclone:storagebox:repo" }),
      drill: check({ target: "rclone:storagebox:repo" }),
    }));
    expect(html).toContain("Protected");
    expect(html).toMatch(/verified.*proven within the last 45 days/);
    expect(html).toContain("rclone:storagebox:repo");
    expect(html).toContain("2026-09-18 03:05");
    expect(html).toContain("2026-09-01 03:10");
    expect(html).not.toContain("<li>");
  });

  it("unproven: verify ok, drill never passed, states the reason", async () => {
    const html = await render(status({
      state: "unproven",
      reasons: ["The backup checks out, but no restore has ever been rehearsed successfully."],
      verify: check(),
      drill: check({ ok: null, checkedAt: null, lastPassAt: null }),
    }));
    expect(html).toContain("Unproven");
    expect(html).toContain("The backup checks out, but no restore has ever been rehearsed successfully.");
    expect(html).toContain("never rehearsed");
  });

  it("not-protected: verify failed, states the reasons and the target", async () => {
    const html = await render(status({
      state: "not-protected",
      reasons: ["Last night's backup check did not pass: stale snapshot"],
      verify: check({ ok: false, detail: "stale snapshot" }),
      drill: check(),
    }));
    expect(html).toContain("Not protected");
    expect(html).toMatch(/Last night(&#x27;|')s backup check did not pass: stale snapshot/);
    expect(html).toContain("rclone:storagebox:repo");
  });

  it("not-protected: a stale drill states its own reason", async () => {
    const html = await render(status({
      state: "not-protected",
      reasons: ["The last successful restore drill was more than 45 days ago (52d)."],
      verify: check(),
      drill: check({ lastPassAt: new Date("2026-07-01T03:10:00Z") }),
    }));
    expect(html).toContain("Not protected");
    expect(html).toContain("The last successful restore drill was more than 45 days ago (52d).");
  });

  it("missing table: renders the apply-sql/049 notice, not a crash", async () => {
    const html = await render(status({ unavailable: true }));
    expect(html).toContain("sql/049_backup_status.sql");
    expect(html).not.toContain("Protected");
    expect(html).not.toContain("Not protected");
  });
});
