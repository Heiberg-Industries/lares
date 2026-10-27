// The baseline replaced the numbered pre-release history. Three promises are pinned here:
//   1. a fresh database gets the whole schema from the one file, and a second run does nothing;
//   2. a database the OLD history built is refused, with one clear message, never a pile of
//      per-file refusals and never an attempt to create tables that already exist;
//   3. that database can be moved onto the baseline by adoption, once, and only when it is at the
//      last pre-release state.
import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";
import { readFileSync,copyFileSync,mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { quiet } from "./helpers/quiet-pool.js";
import { startTestDb, type TestDb } from "./helpers/pg.js";
import { ensureLedger, listApplied, recordApplied, type AppliedMigration } from "../lib/migration-ledger.js";
import {
  BASELINE_FILENAME,
  adoptMigrations,
  planMigrations,
  readMigrations,
  runMigrations,
} from "../lib/migration-runner.js";

const SQL = join(__dirname, "..", "sql");
const STANDING_FACTS_FILENAME = "002_standing_facts.sql";
const OUTSIDE_TOOL_SEEN_FILENAME = "003_outside_tool_seen.sql";
const WEB_INBOX_FILENAME = "004_web_inbox.sql";
const MODEL_STEPS_FILENAME = "005_model_steps.sql";
const APPROVAL_SESSION_FILENAME = "006_approval_session.sql";
const MEMBER_IDENTITY_FILENAME = "007_member_identity_sessions.sql";
const CONNECTED_ACCOUNTS_FILENAME = "008_connected_accounts.sql";
const ACCOUNT_CREDENTIALS_FILENAME = "012_connected_account_credentials.sql";
const BUDGET_FILENAME = "011_budget_admission.sql";
const CONSOLE_AUTHORITY_FILENAME = "013_console_turn_authority.sql";
const DREAM_SCHEMA_FILENAME = "026_dream_schema.sql";
const SHARED_SYNC_SCHEMA_FILENAME = "027_shared_sync_schema.sql";
const STUDIO_OWNERSHIP_FILENAME = "028_studio_ownership.sql";
const OUTSIDE_CUSTODY_FILENAME = "029_outside_custody.sql";
const CONVERSATION_AUDIENCE_FILENAME = "030_conversation_audience.sql";
const OUTSIDE_EXECUTION_APPROVALS_FILENAME = "031_outside_execution_approvals.sql";
const TRACK_ROUTING_FILENAME = "032_track_routing.sql";
const TRACK_DECLINE_FILENAME = "033_track_proposal_approval_links.sql";

/** Every table the numbered migrations create, plus the ledger. The list is written out so that a table the old
 *  history had and the baseline lost (outside_tool_pins once did) fails here, not on a fresh install. */
const EXPECTED_TABLES = [
  "budget_accounts", "budget_windows", "budget_gateway_bindings", "budget_attempts", "budget_gateway_grants", "budget_financial_checkpoints",
  "console_vault_source_captures",
  "personal_actions",
  "personal_action_calls",
  "agent_avatars",
  "agent_conversations",
  "agent_definitions",
  "agent_door_claim_audit",
  "agent_door_connections",
  "agent_doors",
  "agent_notes",
  "agent_registry",
  "agent_resources",
  "approval_asks",
  "approval_events",
  "atlas_notes",
  "atlas_proposals",
  "audit",
  "backup_status",
  "brief_settings",
  "clipping_choice",
  "clipping_items",
  "clipping_requests",
  "clipping_sources",
  "confirmations",
  "connected_accounts",
  "connected_account_credentials",
  "connected_resource_bindings",
  "console_session_bindings",
  "agent_access",
  "resource_grants",
  "vault_areas",
  "vault_backing_stores",
  "conversation_entries",
  "conversation_retention",
  "cross_member_grants",
  "cross_member_reads",
  "deadline_candidates",
  "deadline_settings",
  "deadlines",
  "dream_observations",
  "dream_preferences",
  "digest_requests",
  "digest_skips",
  "email_triage_processed",
  "email_watch_cursors",
  "forget_ledger",
  "heartbeat",
  "initiations",
  "karakeep_seen",
  "keeper_audit",
  "keeper_credentials",
  "meeting_followup_sent",
  "memory_proposals",
  "memory_reads",
  "memory_use",
  "member_invitations",
  "member_provider_identities",
  "member_sessions",
  "notion_sync_docs",
  "notion_sync_fidelity",
  "notion_sync_proposals",
  "notion_sync_run",
  "oauth_tokens",
  "obligation_threads",
  "org_member_policy",
  "orgs",
  "outreach_threads",
  "outside_tool_pins",
  "outside_custody_accounts",
  "outside_custody_revisions",
  "outside_custody_operations",
  "outside_execution_approvals",
  "owner_clock_signals",
  "proactivity_settings",
  "ratchet",
  "ratchet_audit",
  "reminders",
  "repairs",
  "route_cursor",
  "route_proposals",
  "route_proposal_approval_links",
  "schedule_settings",
  "sessions",
  "studio_runs",
  "settings",
  "settings_audit",
  "standing_facts",
  "telegram_daily_log",
  "telegram_session_rotation",
  "trigger_schedules",
  "update_history",
  "user_aliases",
  "users",
  "voice_exemplar",
  "voice_profile",
  "model_steps",
  "web_inbox",
  "workflow_jobs",
  "schema_migrations",
];

const oldRow = (filename: string, number: number): AppliedMigration => ({
  filename,
  number,
  checksum: "old",
  appliedAt: new Date("2026-10-01T00:00:00Z"),
  how: "applied",
  tookMs: 1,
});
/** What a database built by the old history holds: its first file, some in between, its last. */
const OLD_FULL = [oldRow("001_init.sql", 1), oldRow("050_brief_settings.sql", 50), oldRow("094_outside_tool_pins.sql", 94)];
const OLD_PARTIAL = [oldRow("001_init.sql", 1), oldRow("050_brief_settings.sql", 50)];

describe("the baseline on a fresh database", () => {
  it("upgrades the released 006 ledger with the actual runner and preserves existing rows", async () => {
    const container=await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    const pool=quiet(new Pool({connectionString:container.getConnectionUri()}));
    const released=mkdtempSync(join(tmpdir(),"lares-released-migrations-"));
    try {
      for(const file of readMigrations(SQL).filter(f=>f.number<=6))copyFileSync(file.path,join(released,file.filename));
      await ensureLedger(pool);
      expect((await runMigrations(pool,released)).refused).toEqual([]);
      await pool.query(`INSERT INTO orgs(id,display_name) VALUES('upgrade-org','Upgrade organisation');
        INSERT INTO users(id,display_name,org_id,org_role) VALUES('upgrade-owner','Upgrade owner','upgrade-org','owner');
        INSERT INTO reminders(agent,owner,due_at,payload,created_by) VALUES('fixture-agent','upgrade-owner',now()+interval '1 day','{}','upgrade-owner');`);
      const upgrade=await runMigrations(pool,SQL);
      expect(upgrade.refused).toEqual([]);
      expect(upgrade.applied).toContain(BUDGET_FILENAME);
      expect(upgrade.applied).toContain("009_vault_areas.sql");expect(upgrade.applied).toContain("019_personal_actions.sql");expect(upgrade.applied).toContain("020_vault_resource_grants.sql");expect(upgrade.applied).toContain("021_personal_action_acceptance.sql");expect(upgrade.applied).toContain("022_console_vault_source_history.sql");expect(upgrade.applied).toContain("023_budget_invocation_suppression.sql");expect(upgrade.applied).toContain("024_gateway_budget_grants.sql");expect(upgrade.applied).toContain("025_budget_financial_checkpoints.sql");expect(upgrade.applied).toContain(DREAM_SCHEMA_FILENAME);expect(upgrade.applied).toContain(SHARED_SYNC_SCHEMA_FILENAME);expect(upgrade.applied).toContain(STUDIO_OWNERSHIP_FILENAME);expect(upgrade.applied).toContain(OUTSIDE_CUSTODY_FILENAME);expect(upgrade.applied).toContain(CONVERSATION_AUDIENCE_FILENAME);expect(upgrade.applied).toContain(OUTSIDE_EXECUTION_APPROVALS_FILENAME);expect(upgrade.applied).toContain(TRACK_ROUTING_FILENAME);expect(upgrade.applied).toContain(TRACK_DECLINE_FILENAME);
      expect((await pool.query("SELECT display_name,status FROM users WHERE id='upgrade-owner'")).rows).toEqual([{display_name:'Upgrade owner',status:'active'}]);
      expect((await pool.query("SELECT 1 FROM reminders WHERE owner='upgrade-owner'")).rowCount).toBe(1);
      expect(await runMigrations(pool,SQL)).toMatchObject({applied:[],refused:[]});
      // Intermediate development ledgers are deliberately not repaired or auto-adopted.
      await pool.query("DELETE FROM schema_migrations WHERE filename IN ('009_vault_areas.sql','020_vault_resource_grants.sql');UPDATE schema_migrations SET checksum='intermediate-development-checksum' WHERE filename='014_agent_access_grants.sql'");
      const refused=await runMigrations(pool,SQL);
      expect(refused.applied).toEqual([]);
      expect(refused.refused.some(r=>r.filename==='009_vault_areas.sql'&&r.reason.includes('out of order'))).toBe(true);
      expect(refused.refused.some(r=>r.filename==='014_agent_access_grants.sql')).toBe(true);
    } finally {await pool.end();await container.stop();rmSync(released,{recursive:true,force:true});}
  },180_000);

  it("creates the whole schema in one step, and a second run does nothing", async () => {
    const container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    const pool = quiet(new Pool({ connectionString: container.getConnectionUri() }));
    try {
      await ensureLedger(pool);
      const first = await runMigrations(pool, SQL);
      expect(first.applied).toEqual([BASELINE_FILENAME, STANDING_FACTS_FILENAME, OUTSIDE_TOOL_SEEN_FILENAME, WEB_INBOX_FILENAME, MODEL_STEPS_FILENAME, APPROVAL_SESSION_FILENAME, MEMBER_IDENTITY_FILENAME, CONNECTED_ACCOUNTS_FILENAME, "009_vault_areas.sql", BUDGET_FILENAME, ACCOUNT_CREDENTIALS_FILENAME, CONSOLE_AUTHORITY_FILENAME, "014_agent_access_grants.sql", "015_exact_approval_execution.sql", "016_console_agent_access_capture.sql", "017_private_console_surface_capture.sql", "018_private_account_history.sql", "019_personal_actions.sql", "020_vault_resource_grants.sql", "021_personal_action_acceptance.sql", "022_console_vault_source_history.sql", "023_budget_invocation_suppression.sql", "024_gateway_budget_grants.sql", "025_budget_financial_checkpoints.sql", DREAM_SCHEMA_FILENAME, SHARED_SYNC_SCHEMA_FILENAME, STUDIO_OWNERSHIP_FILENAME, OUTSIDE_CUSTODY_FILENAME, CONVERSATION_AUDIENCE_FILENAME, OUTSIDE_EXECUTION_APPROVALS_FILENAME, TRACK_ROUTING_FILENAME, TRACK_DECLINE_FILENAME]);
      expect(first.refused).toEqual([]);
      const second = await runMigrations(pool, SQL);
      expect(second.applied).toEqual([]);
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'");
      expect(rows[0].n).toBeGreaterThan(50);
      const tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name");
      expect(tables.rows.map((r: { table_name: string }) => r.table_name).sort()).toEqual([...EXPECTED_TABLES].sort());
    } finally {
      await pool.end();
      await container.stop();
    }
  }, 180_000);
});

describe("a database the pre-release history built", () => {
  it("is refused with one message that names the way forward", () => {
    const plan = planMigrations(readMigrations(SQL), OLD_FULL);
    expect(plan.steps).toHaveLength(1);
    expect(plan.refusals).toHaveLength(1);
    const reason = plan.refusals[0]!.reason;
    expect(reason).toContain("pre-release migration history");
    expect(reason).toContain("migrate --adopt-through 001_baseline.sql");
    expect(reason).toContain("nothing was applied");
  });

  it("is told to update first when it does not hold the whole old history", () => {
    const plan = planMigrations(readMigrations(SQL), OLD_PARTIAL);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]!.reason).toContain("Update it to the last pre-release version first");
    expect(plan.refusals[0]!.reason).not.toContain("migrate --adopt-through");
  });

  it("is not mistaken for a database that already adopted the baseline", () => {
    const files = readMigrations(SQL);
    const adopted: AppliedMigration = { ...oldRow(BASELINE_FILENAME, 1), checksum: files[0]!.checksum, how: "adopted" };
    const plan = planMigrations(files, [adopted]);
    expect(plan.refusals).toEqual([]);
    expect(plan.steps.map((s) => s.action)).toEqual(files.map(file => file.filename === BASELINE_FILENAME ? "skip" : "apply"));
  });
});

describe("adopting the baseline", () => {
  let db: TestDb;
  beforeAll(async () => { db = await startTestDb(); }, 180_000);
  afterAll(async () => { await db?.stop(); });
  beforeEach(async () => {
    await db.pool.query("DELETE FROM schema_migrations");
  });

  async function seedOldLedger(rows: AppliedMigration[]): Promise<void> {
    for (const r of rows) await recordApplied(db.pool, { filename: r.filename, number: r.number, checksum: r.checksum, how: r.how, tookMs: r.tookMs });
  }

  it("a real run on such a database refuses and applies nothing", async () => {
    await seedOldLedger(OLD_FULL);
    const result = await runMigrations(db.pool, SQL);
    expect(result.applied).toEqual([]);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]!.reason).toContain("--adopt-through 001_baseline.sql");
    expect((await listApplied(db.pool)).map((r) => r.filename)).toEqual(OLD_FULL.map((r) => r.filename));
  });

  it("a dry run writes nothing and says the old rows would be replaced", async () => {
    await seedOldLedger(OLD_FULL);
    const result = await adoptMigrations(db.pool, SQL, { through: BASELINE_FILENAME, dryRun: true });
    expect(result.report).toContain("replaced by this one");
    expect(await listApplied(db.pool)).toHaveLength(OLD_FULL.length);
  });

  it("replaces the old ledger with the baseline's single row, once", async () => {
    await seedOldLedger(OLD_FULL);
    const result = await adoptMigrations(db.pool, SQL, { through: BASELINE_FILENAME, confirmWillRun: true });
    expect(result.adopted).toEqual([BASELINE_FILENAME]);
    const rows = await listApplied(db.pool);
    expect(rows.map((r) => [r.filename, r.how])).toEqual([[BASELINE_FILENAME, "adopted"]]);
    // Later files still run after adoption: the baseline is skipped, later numbered files are applied.
    expect(await runMigrations(db.pool, SQL)).toMatchObject({ applied: [STANDING_FACTS_FILENAME, OUTSIDE_TOOL_SEEN_FILENAME, WEB_INBOX_FILENAME, MODEL_STEPS_FILENAME, APPROVAL_SESSION_FILENAME, MEMBER_IDENTITY_FILENAME, CONNECTED_ACCOUNTS_FILENAME, "009_vault_areas.sql", BUDGET_FILENAME, ACCOUNT_CREDENTIALS_FILENAME, CONSOLE_AUTHORITY_FILENAME, "014_agent_access_grants.sql", "015_exact_approval_execution.sql", "016_console_agent_access_capture.sql", "017_private_console_surface_capture.sql", "018_private_account_history.sql", "019_personal_actions.sql", "020_vault_resource_grants.sql", "021_personal_action_acceptance.sql", "022_console_vault_source_history.sql", "023_budget_invocation_suppression.sql", "024_gateway_budget_grants.sql", "025_budget_financial_checkpoints.sql", DREAM_SCHEMA_FILENAME, SHARED_SYNC_SCHEMA_FILENAME, STUDIO_OWNERSHIP_FILENAME, OUTSIDE_CUSTODY_FILENAME, CONVERSATION_AUDIENCE_FILENAME, OUTSIDE_EXECUTION_APPROVALS_FILENAME, TRACK_ROUTING_FILENAME, TRACK_DECLINE_FILENAME], refused: [] });
    // Adoption is one-time: the ledger now holds the baseline, so a second adoption refuses.
    await expect(adoptMigrations(db.pool, SQL, { through: BASELINE_FILENAME })).rejects.toThrow(/one-time/);
  });

  it("the standing-facts file leaves a table that already holds rows untouched (the existing server)", async () => {
    const sql = readFileSync(join(SQL, STANDING_FACTS_FILENAME), "utf8");
    await db.pool.query(sql);
    await db.pool.query("INSERT INTO standing_facts (fact, category, source_turn, user_id) VALUES ('a fact', 'travel', 't1', 'fixture-owner')");
    await db.pool.query(sql);
    const { rows } = await db.pool.query("SELECT fact, origin, source FROM standing_facts");
    expect(rows).toEqual([{ fact: "a fact", origin: "owner", source: "remember" }]);
    await db.pool.query("DROP TABLE standing_facts");
  });

  it("the outside-tool file adds its columns to a table that already holds pins, and runs again harmlessly", async () => {
    const sql = readFileSync(join(SQL, OUTSIDE_TOOL_SEEN_FILENAME), "utf8");
    await db.pool.query("TRUNCATE outside_tool_pins");
    await db.pool.query("INSERT INTO outside_tool_pins (agent, tool, config_hash, pin_hash) VALUES ('bookkeeper', 'registry', $1, $2)", ["c".repeat(64), "p".repeat(64)]);
    await db.pool.query(sql);
    await db.pool.query(sql);
    const { rows } = await db.pool.query("SELECT pin_hash, pin_tools, seen_hash, seen_tools, seen_at FROM outside_tool_pins");
    expect(rows).toEqual([{ pin_hash: "p".repeat(64), pin_tools: null, seen_hash: null, seen_tools: null, seen_at: null }]);
    await expect(db.pool.query("UPDATE outside_tool_pins SET seen_hash = 'short'")).rejects.toThrow(/outside_tool_pins_seen_shape/);
    await expect(db.pool.query(`UPDATE outside_tool_pins SET seen_tools = '{"name":"x"}'`)).rejects.toThrow(/outside_tool_pins_seen_shape/);
    await db.pool.query("TRUNCATE outside_tool_pins");
  });

  it("the approval-session file runs twice, leaves old cards without a session, and takes a 'revised' settlement", async () => {
    const sql = readFileSync(join(SQL, APPROVAL_SESSION_FILENAME), "utf8");
    await db.pool.query(sql);
    await db.pool.query(sql);
    await db.pool.query("INSERT INTO approval_asks (request_id, call_id, agent, tool, payload_hash) VALUES ('r1', 'c1', 'assistant', 'gmail_send', 'h')");
    await db.pool.query("INSERT INTO approval_asks (request_id, call_id, agent, tool, payload_hash, session_id, turn_sequence, target_hash) VALUES ('r2', 'c2', 'assistant', 'gmail_send', 'h', 's1', 3, 't')");
    await db.pool.query("UPDATE approval_asks SET outcome = 'cancelled', answered_at = now(), answered_via = 'revised' WHERE request_id = 'r2'");
    const { rows } = await db.pool.query("SELECT request_id, session_id, turn_sequence, target_hash, outcome, answered_via FROM approval_asks ORDER BY request_id");
    expect(rows).toEqual([
      { request_id: "r1", session_id: null, turn_sequence: null, target_hash: null, outcome: null, answered_via: null },
      { request_id: "r2", session_id: "s1", turn_sequence: 3, target_hash: "t", outcome: "cancelled", answered_via: "revised" },
    ]);
    await db.pool.query("TRUNCATE approval_asks CASCADE");
  });

  it("refuses when the old history is not whole, and leaves the ledger alone", async () => {
    await seedOldLedger(OLD_PARTIAL);
    await expect(adoptMigrations(db.pool, SQL, { through: BASELINE_FILENAME })).rejects.toThrow(/Update it to the last pre-release version/);
    expect(await listApplied(db.pool)).toHaveLength(OLD_PARTIAL.length);
  });
});
