// Test harness: spin up a real Postgres (the same pgvector image the box runs),
// apply the real sql/001_baseline.sql, and hand back a Pool. Tear it all down after.
// This proves the data layer against the actual schema, extensions and constraints —
// not a mock.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { quiet } from "./quiet-pool.js";

const here = dirname(fileURLToPath(import.meta.url));
const sqlDir = join(here, "..", "..", "sql");
const baselineSql = readFileSync(join(sqlDir, "001_baseline.sql"), "utf8");

export interface TestDb {
  pool: Pool;
  connectionString: string;
  stop: () => Promise<void>;
}

export async function startTestDb(): Promise<TestDb> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    "pgvector/pgvector:pg16",
  ).start();
  const connectionString = container.getConnectionUri();
  const pool = quiet(new Pool({ connectionString }));
  await pool.query(baselineSql);
  return {
    pool,
    connectionString,
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
}
