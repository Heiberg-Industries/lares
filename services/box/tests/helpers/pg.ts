// Test harness: spin up a real Postgres (the same pgvector image the box runs),
// apply the real sql/001_init.sql, and hand back a Pool. Tear it all down after.
// This proves the data layer against the actual schema, extensions and constraints —
// not a mock.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const sqlDir = join(here, "..", "..", "sql");
const initSql = readFileSync(join(sqlDir, "001_init.sql"), "utf8");
const taskStateSql = readFileSync(join(sqlDir, "002_task_state.sql"), "utf8");
const digestSql = readFileSync(join(sqlDir, "003_digest.sql"), "utf8");
const auditPrincipalSql = readFileSync(join(sqlDir, "004_audit_principal.sql"), "utf8");
const workflowJobsSql = readFileSync(join(sqlDir, "005_workflow_jobs.sql"), "utf8");
const oauthTokensSql = readFileSync(join(sqlDir, "006_oauth_tokens.sql"), "utf8");
const confirmationSlackRefSql = readFileSync(join(sqlDir, "007_confirmation_slack_ref.sql"), "utf8");
const ratchetSql = readFileSync(join(sqlDir, "008_ratchet.sql"), "utf8");
const confirmationConsumeSql = readFileSync(join(sqlDir, "009_confirmation_consume.sql"), "utf8");
const oauthMultiAccountSql = readFileSync(join(sqlDir, "010_oauth_tokens_multi_account.sql"), "utf8");
const workflowCorrelationSql = readFileSync(join(sqlDir, "011_workflow_correlation_key.sql"), "utf8");
const emailWatchCursorsSql = readFileSync(join(sqlDir, "012_email_watch_cursors.sql"), "utf8");
const identitySql = readFileSync(join(sqlDir, "014_identity.sql"), "utf8");
const notionSyncSql = readFileSync(join(sqlDir, "015_notion_sync.sql"), "utf8");
const notionSyncPhase3Sql = readFileSync(join(sqlDir, "016_notion_sync_phase3.sql"), "utf8");
const notionProposalAnnouncedSql = readFileSync(join(sqlDir, "017_notion_proposal_announced.sql"), "utf8");
const notionSyncPhase4Sql = readFileSync(join(sqlDir, "018_notion_sync_phase4.sql"), "utf8");
const atlasSyncSql = readFileSync(join(sqlDir, "019_atlas_sync.sql"), "utf8");

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
  const pool = new Pool({ connectionString });
  await pool.query(initSql);
  await pool.query(taskStateSql);
  await pool.query(digestSql);
  await pool.query(auditPrincipalSql);
  await pool.query(workflowJobsSql);
  await pool.query(oauthTokensSql);
  await pool.query(confirmationSlackRefSql);
  await pool.query(ratchetSql);
  await pool.query(confirmationConsumeSql);
  await pool.query(oauthMultiAccountSql);
  await pool.query(workflowCorrelationSql);
  await pool.query(emailWatchCursorsSql);
  await pool.query(identitySql);   // the empty identity registry (013_voice is standalone)
  await pool.query(notionSyncSql);
  await pool.query(notionSyncPhase3Sql);
  await pool.query(notionProposalAnnouncedSql);
  await pool.query(notionSyncPhase4Sql);
  await pool.query(atlasSyncSql);
  return {
    pool,
    connectionString,
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
}
