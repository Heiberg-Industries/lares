// -s2 — the backup_status table and its two seed rows in sql/001_baseline.sql, proved against a
// REAL Postgres (testcontainers, the same pattern services/chief-of-staff/tests/deadlines-store.test.ts
// uses): the baseline applied verbatim from disk.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { quiet } from "./helpers/quiet-pool.js";

const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(here, "..", "sql");
const sql = (name: string) => readFileSync(join(SQL_DIR, name), "utf8");

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = quiet(new Pool({ connectionString: container.getConnectionUri() }));
  await pool.query(sql("001_baseline.sql"));
}, 120_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

/** The seed statement the baseline carries for backup_status, so the "re-run never clobbers" claim is
 *  proved on the real text. */
const seedStatement = (): string => {
  const m = /INSERT INTO backup_status[\s\S]*?ON CONFLICT \(check_name\) DO NOTHING;/.exec(sql("001_baseline.sql"));
  if (!m) throw new Error("backup_status seed not found in the baseline");
  return m[0];
};

describe("backup_status in 001_baseline.sql", () => {
  it("seeds both rows as unproven (no false pass), and the seed can be run again", async () => {
    await pool.query(seedStatement()); // a second run: must not error or reseed over real data
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

  it("re-running the seed after a real upsert does not clobber it (ON CONFLICT DO NOTHING)", async () => {
    await pool.query(
      `UPDATE backup_status
          SET ok = true, checked_at = now(), last_pass_at = now(),
              detail = 'OK — nightly snapshot deadbeef 2h old', target = 'rclone:example.invalid:box-backup'
        WHERE check_name = 'verify'`,
    );
    await pool.query(seedStatement()); // now over real data
    const { rows } = await pool.query(`SELECT ok, detail FROM backup_status WHERE check_name = 'verify'`);
    expect(rows[0].ok).toBe(true);
    expect(rows[0].detail).toContain("nightly snapshot");
  });
});
