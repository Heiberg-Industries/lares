// LAR-54-s2 — sql/049_backup_status.sql, proved against a REAL Postgres (testcontainers,
// the same pattern services/chief-of-staff/tests/deadlines-store.test.ts uses): applied
// verbatim from disk, on top of 031_schedule_heartbeat.sql (the same baseline that test
// applies first — 049 does not actually reference the heartbeat table, but this proves
// 049 applies cleanly over an existing installation, not only a pristine database).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Pool } from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(here, "..", "sql");
const sql = (name: string) => readFileSync(join(SQL_DIR, name), "utf8");

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(sql("031_schedule_heartbeat.sql"));
  await pool.query(sql("049_backup_status.sql"));
}, 120_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

describe("049_backup_status.sql", () => {
  it("applies cleanly twice and seeds both rows as unproven (no false pass)", async () => {
    await pool.query(sql("049_backup_status.sql")); // second application: must not error or reseed over real data
    const { rows } = await pool.query(
      `SELECT check_name, ok, checked_at, last_pass_at, detail, target
         FROM backup_status ORDER BY check_name`,
    );
    expect(rows).toEqual([
      { check_name: "drill", ok: null, checked_at: null, last_pass_at: null, detail: null, target: null },
      { check_name: "verify", ok: null, checked_at: null, last_pass_at: null, detail: null, target: null },
    ]);
  });

  it("rejects a check_name other than verify/drill", async () => {
    await expect(pool.query(`INSERT INTO backup_status (check_name) VALUES ('bogus')`)).rejects.toThrow();
  });

  it("re-applying the migration after a real upsert does not clobber it (ON CONFLICT DO NOTHING)", async () => {
    await pool.query(
      `UPDATE backup_status
          SET ok = true, checked_at = now(), last_pass_at = now(),
              detail = 'OK — nightly snapshot deadbeef 2h old', target = 'rclone:example.invalid:box-backup'
        WHERE check_name = 'verify'`,
    );
    await pool.query(sql("049_backup_status.sql")); // third application, now over real data
    const { rows } = await pool.query(`SELECT ok, detail FROM backup_status WHERE check_name = 'verify'`);
    expect(rows[0].ok).toBe(true);
    expect(rows[0].detail).toContain("nightly snapshot");
  });
});
