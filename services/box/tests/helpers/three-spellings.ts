// services/box/tests/helpers/three-spellings.ts — W5I-s2: the fixture every later slice of the
// identity track (the resolver, the two migrations that rewrite person columns, the Google-token
// rename, erase-a-person) is proven against — never the live server.
//
// A disposable Postgres with the box's REAL schema applied from services/box/sql (every numbered
// migration file, in order, read off disk rather than named one by one — the mistake
// tests/helpers/pg.ts made and stopped at 019), plus the per-service files an erase must reach
// (services/chief-of-staff/sql 002-005, the standing-facts family) and the dream tables' runtime
// DDL (services/box cannot import services/chief-of-staff, so it is reproduced inline below,
// copied verbatim from ensureDreamTables). Seeded with TWO fictional people whose rows use all
// four id conventions the inventory (lib/member-scope.ts) records: `registry` (the identity
// register's own id space), `principal` (an older, door-native/legacy spelling), `owner-key` (a
// free-text `owner` column convention fills with the canonical id) and `actor` (whoever changed
// an administrative row).
//
// NOTHING HERE EVER TOUCHES A REAL INSTALLATION. The container is disposable
// (@testcontainers/postgresql), the connection string is generated per run, and every value this
// module writes is fictional (`fixture-owner`, `fixture-second`, example.invalid addresses,
// made-up ids). Applying the real migrations also runs their own seeds — 014_identity.sql,
// 028_orgs.sql and 029_cross_member.sql each insert ONE real installation's row ('bendik') — that
// is what a real box has and this fixture must work alongside; it never adds to those rows, and
// every assertion in the test file that uses this module is about the fixture members only.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const boxSqlDir = join(here, "..", "..", "sql");
const chiefOfStaffSqlDir = join(here, "..", "..", "..", "chief-of-staff", "sql");

export interface TestDb {
  pool: Pool;
  connectionString: string;
  stop: () => Promise<void>;
}

/** Who the fixture seeds, named once so every later test quotes it rather than re-deriving it. */
export const FIXTURE_OWNER = "fixture-owner";
export const FIXTURE_SECOND = "fixture-second";

// Legacy/channel-native spellings — the shape 014_identity.sql's own alias set shows a real
// long-lived box actually accumulates (a case-divergent duplicate included). Deliberately NOT
// equal to FIXTURE_OWNER/FIXTURE_SECOND: that difference is the whole point of the `principal`
// convention, and five tables are still seeded under exactly these spellings (digest_requests,
// workflow_jobs, meeting_followup_sent and the two agent_door tables — the inventory's
// `LEGACY_PRINCIPAL_TABLES`). `oauth_tokens` and `email_watch_cursors` are NO LONGER among them:
// box 085 renamed their principals onto the register's id, so the fixture seeds them the way a
// box looks after that migration, and tests/oauth-principal-rename.test.ts plants the legacy
// spelling itself when it needs the before-picture.
const LEGACY = "U_fixture";
const LEGACY_CASE = "U_FIXTURE";
const LEGACY_SECOND = "U_fixture2";

interface SeedRow {
  table: string;
  column: string;
  value: string;
  insert: (pool: Pool) => Promise<void>;
}

function row(
  table: string,
  column: string,
  value: string,
  sql: string,
  params: unknown[] = [],
): SeedRow {
  return { table, column, value, insert: async (pool) => { await pool.query(sql, params); } };
}

// ─── The seed, one entry per row this fixture writes ──────────────────────────────────────────
// Order matters only where a foreign key requires it (users before anything that REFERENCES
// users.id). Each entry both DOCUMENTS the row (table/column/value, read by
// three-spellings-fixture.test.ts and by every later slice) and WRITES it — one definition, so
// the two can never drift apart.
const SEED_ROWS: SeedRow[] = [
  // ── The identity register itself (014_identity.sql) ──────────────────────────────────────
  row("users", "id", FIXTURE_OWNER,
    `INSERT INTO users (id, display_name, primary_email) VALUES ($1, 'Fixture Owner', 'owner@fixture.test')`,
    [FIXTURE_OWNER]),
  row("users", "id", FIXTURE_SECOND,
    `INSERT INTO users (id, display_name, primary_email) VALUES ($1, 'Fixture Second', 'second@fixture.test')`,
    [FIXTURE_SECOND]),

  row("user_aliases", "user_id", FIXTURE_OWNER,
    `INSERT INTO user_aliases (system, alias, user_id) VALUES
       ('legacy', $2, $1), ('legacy', $3, $1), ('slack', $4, $1), ('email', $5, $1)`,
    [FIXTURE_OWNER, LEGACY, LEGACY_CASE, "U_FIXTURE_SLACK", "owner@fixture.test"]),
  row("user_aliases", "user_id", FIXTURE_SECOND,
    `INSERT INTO user_aliases (system, alias, user_id) VALUES
       ('legacy', $2, $1), ('legacy', $3, $1), ('slack', $4, $1), ('email', $5, $1)`,
    [FIXTURE_SECOND, LEGACY_SECOND, "U_FIXTURE2", "U_FIXTURE2_SLACK", "second@fixture.test"]),

  // ── 001_init.sql ──────────────────────────────────────────────────────────────────────────
  row("reminders", "owner", FIXTURE_OWNER,
    `INSERT INTO reminders (agent, owner, due_at, payload, created_by)
     VALUES ('fixture-agent', $1, now() + interval '1 day', '{}'::jsonb, $1)`,
    [FIXTURE_OWNER]),
  row("reminders", "owner", FIXTURE_SECOND,
    `INSERT INTO reminders (agent, owner, due_at, payload, created_by)
     VALUES ('fixture-agent', $1, now() + interval '1 day', '{}'::jsonb, $1)`,
    [FIXTURE_SECOND]),

  // ── 003_digest.sql ────────────────────────────────────────────────────────────────────────
  row("digest_requests", "requested_by", LEGACY,
    `INSERT INTO digest_requests (agent, requested_by, door, thread_ref)
     VALUES ('fixture-agent', $1, 'slack', 'fixture-thread-1')`,
    [LEGACY]),

  // ── 005_workflow_jobs.sql ─────────────────────────────────────────────────────────────────
  row("workflow_jobs", "principal", LEGACY,
    `INSERT INTO workflow_jobs (agent, principal, workflow_type)
     VALUES ('fixture-agent', $1, 'fixture-workflow')`,
    [LEGACY]),

  // ── 006_oauth_tokens.sql — the register's id since box 085 (ruling D4) ────────────────────
  row("oauth_tokens", "principal", FIXTURE_OWNER,
    `INSERT INTO oauth_tokens (principal, provider, org_id, email_address, refresh_token_enc)
     VALUES ($1, 'google', 'fixture-org', 'owner@fixture.test', 'fixture-encrypted-blob')`,
    [FIXTURE_OWNER]),
  row("oauth_tokens", "principal", FIXTURE_SECOND,
    `INSERT INTO oauth_tokens (principal, provider, org_id, email_address, refresh_token_enc)
     VALUES ($1, 'google', 'fixture-org', 'second@fixture.test', 'fixture-encrypted-blob-2')`,
    [FIXTURE_SECOND]),

  // ── 008_ratchet.sql — also fires ratchet_audit_trg, see the no-op entry below ─────────────
  row("ratchet", "updated_by", FIXTURE_OWNER,
    `INSERT INTO ratchet (agent, capability, level, updated_by)
     VALUES ('fixture-agent', 'fixture-capability', 'gated', $1)`,
    [FIXTURE_OWNER]),

  // ── 012_email_watch_cursors.sql — the register's id since box 085 (ruling D4) ─────────────
  row("email_watch_cursors", "principal", FIXTURE_OWNER,
    `INSERT INTO email_watch_cursors (watcher, principal, email_address)
     VALUES ('fixture-watcher', $1, 'owner@fixture.test')`,
    [FIXTURE_OWNER]),

  // ── 013_voice.sql — voice_profile is a singleton (id='default'), already inserted by the
  //    migration itself; this UPDATEs its one row rather than inserting a second ─────────────
  row("voice_profile", "updated_by", FIXTURE_OWNER,
    `UPDATE voice_profile SET updated_by = $1 WHERE id = 'default'`,
    [FIXTURE_OWNER]),

  // ── 019_obligations.sql ───────────────────────────────────────────────────────────────────
  row("obligation_threads", "principal", FIXTURE_OWNER,
    `INSERT INTO obligation_threads
       (thread_id, principal, counterparty_address, last_message_at, last_speaker_is_them)
     VALUES ('fixture-thread-1', $1, 'someone@example.invalid', now(), false)`,
    [FIXTURE_OWNER]),

  // ── 020_telegram_session_rotation.sql (principal added by 023, written as the canonical id) ─
  row("telegram_daily_log", "principal", FIXTURE_OWNER,
    `INSERT INTO telegram_daily_log (chat_id, role, body, principal)
     VALUES ('fixture-chat-1', 'user', 'hello', $1)`,
    [FIXTURE_OWNER]),
  row("telegram_session_rotation", "principal", FIXTURE_OWNER,
    `INSERT INTO telegram_session_rotation (chat_id, oslo_day, principal)
     VALUES ('fixture-chat-1', '2026-09-19', $1)`,
    [FIXTURE_OWNER]),

  // ── 021_outreach_threads.sql (principal added by 023, written as the canonical id) ────────
  row("outreach_threads", "principal", FIXTURE_OWNER,
    `INSERT INTO outreach_threads (thread_id, account, principal)
     VALUES ('fixture-thread-1', 'owner@fixture.test', $1)`,
    [FIXTURE_OWNER]),

  // ── 022_email_triage.sql ──────────────────────────────────────────────────────────────────
  row("email_triage_processed", "principal", FIXTURE_OWNER,
    `INSERT INTO email_triage_processed (mailbox, gmail_message_id, principal, outcome)
     VALUES ('owner@fixture.test', 'fixture-msg-1', $1, 'drafted')`,
    [FIXTURE_OWNER]),

  // ── 027_meeting_followup.sql ──────────────────────────────────────────────────────────────
  row("meeting_followup_sent", "principal", LEGACY,
    `INSERT INTO meeting_followup_sent (notion_page_id, principal, outcome)
     VALUES ('fixture-page-1', $1, 'sent')`,
    [LEGACY]),

  // ── 029_cross_member.sql ──────────────────────────────────────────────────────────────────
  row("cross_member_grants", "grantor_user_id", FIXTURE_OWNER,
    `INSERT INTO cross_member_grants (grantor_user_id, capability) VALUES ($1, 'calendar')`,
    [FIXTURE_OWNER]),
  row("cross_member_reads", "grantor_user_id", FIXTURE_OWNER,
    `INSERT INTO cross_member_reads (grantor_user_id, capability, requested_by_user_id, agent)
     VALUES ($1, 'calendar', $1, 'fixture-agent')`,
    [FIXTURE_OWNER]),
  row("org_member_policy", "user_id", FIXTURE_OWNER,
    `INSERT INTO org_member_policy (user_id) VALUES ($1)`,
    [FIXTURE_OWNER]),

  // ── 035_proactivity.sql ───────────────────────────────────────────────────────────────────
  row("proactivity_settings", "owner", FIXTURE_OWNER,
    `INSERT INTO proactivity_settings (owner, agent, door) VALUES ($1, 'fixture-agent', 'slack')`,
    [FIXTURE_OWNER]),
  row("initiations", "owner", FIXTURE_OWNER,
    `INSERT INTO initiations (owner, agent, door, cls, item_key, status, owner_day)
     VALUES ($1, 'fixture-agent', 'slack', 'event', 'fixture-item', 'sent', CURRENT_DATE)`,
    [FIXTURE_OWNER]),
  row("owner_clock_signals", "owner", FIXTURE_OWNER,
    `INSERT INTO owner_clock_signals (owner, source, tz) VALUES ($1, 'slack-profile', 'Europe/Oslo')`,
    [FIXTURE_OWNER]),

  // ── 036_deadlines.sql ─────────────────────────────────────────────────────────────────────
  row("deadlines", "owner", FIXTURE_OWNER,
    `INSERT INTO deadlines (owner, entity, title, source, due_date, created_by)
     VALUES ($1, 'Fixture Co', 'Renew fixture license', 'manual', CURRENT_DATE + 30, 'fixture-agent')`,
    [FIXTURE_OWNER]),
  row("deadline_candidates", "owner", FIXTURE_OWNER,
    `INSERT INTO deadline_candidates (owner, thread_id, subject, sender, seen_at)
     VALUES ($1, 'fixture-thread-1', 'Renewal notice', 'vendor@example.invalid', now())`,
    [FIXTURE_OWNER]),
  row("deadline_settings", "owner", FIXTURE_OWNER,
    `INSERT INTO deadline_settings (owner) VALUES ($1)`,
    [FIXTURE_OWNER]),
  row("markets_settings", "owner", FIXTURE_OWNER,
    `INSERT INTO markets_settings (owner) VALUES ($1)`,
    [FIXTURE_OWNER]),

  // ── 038_permissions_board.sql ─────────────────────────────────────────────────────────────
  // ratchet_audit is written by ratchet_audit_trg when the `ratchet` row above is inserted
  // (changed_by = NEW.updated_by) — no separate INSERT here, just the documentation entry.
  row("ratchet_audit", "changed_by", FIXTURE_OWNER, `SELECT 1`, []),

  // ── 040_keeper.sql ────────────────────────────────────────────────────────────────────────
  row("keeper_audit", "actor", FIXTURE_OWNER,
    `INSERT INTO keeper_audit (action, actor, outcome) VALUES ('fixture-action', $1, 'ok')`,
    [FIXTURE_OWNER]),
  row("settings", "updated_by", FIXTURE_OWNER,
    `INSERT INTO settings (key, value, updated_by) VALUES ('fixture-setting', '{}'::jsonb, $1)`,
    [FIXTURE_OWNER]),
  // settings_audit is written by settings_audit_trg when the `settings` row above is inserted
  // (changed_by = NEW.updated_by) — no separate INSERT here, just the documentation entry.
  row("settings_audit", "changed_by", FIXTURE_OWNER, `SELECT 1`, []),

  // ── 044_agent_door_connections.sql ────────────────────────────────────────────────────────
  row("agent_door_connections", "principal", LEGACY,
    `INSERT INTO agent_door_connections (agent, kind, incarnation, revision, owner_email, principal)
     VALUES ('fixture-agent', 'slack', gen_random_uuid(), gen_random_uuid(), 'owner@fixture.test', $1)`,
    [LEGACY]),
  row("agent_door_claim_audit", "principal", LEGACY,
    `INSERT INTO agent_door_claim_audit (agent, kind, incarnation, principal)
     VALUES ('fixture-agent', 'slack', gen_random_uuid(), $1)`,
    [LEGACY]),

  // ── 050_brief_settings.sql ────────────────────────────────────────────────────────────────
  row("brief_settings", "owner", FIXTURE_OWNER,
    `INSERT INTO brief_settings (owner) VALUES ($1)`,
    [FIXTURE_OWNER]),

  // ── 060_conversation_entries.sql ──────────────────────────────────────────────────────────
  row("conversation_entries", "person_key", FIXTURE_OWNER,
    `INSERT INTO conversation_entries (agent, session_id, turn_id, door, person_key, origin, input, reply, at)
     VALUES ('fixture-agent', 'fixture-session-1', 'fixture-turn-1', 'slack', $1, 'owner', 'hi', 'hello', now())`,
    [FIXTURE_OWNER]),
  row("conversation_entries", "person_key", FIXTURE_SECOND,
    `INSERT INTO conversation_entries (agent, session_id, turn_id, door, person_key, origin, input, reply, at)
     VALUES ('fixture-agent', 'fixture-session-2', 'fixture-turn-2', 'slack', $1, 'owner', 'hi', 'hello', now())`,
    [FIXTURE_SECOND]),

  // ── 061_conversation_retention.sql ────────────────────────────────────────────────────────
  row("conversation_retention", "owner", FIXTURE_OWNER,
    `INSERT INTO conversation_retention (owner, months) VALUES ($1, 12)`,
    [FIXTURE_OWNER]),

  // ── 065_schedule_settings.sql ─────────────────────────────────────────────────────────────
  row("schedule_settings", "owner", FIXTURE_OWNER,
    `INSERT INTO schedule_settings (owner, schedule, hours) VALUES ($1, 'fixture-brief', ARRAY[8])`,
    [FIXTURE_OWNER]),

  // ── 071_agent_notes.sql ───────────────────────────────────────────────────────────────────
  row("agent_notes", "owner", FIXTURE_OWNER,
    `INSERT INTO agent_notes (owner, agent, kind, note, origin, session_id, turn_id)
     VALUES ($1, 'fixture-agent', 'working', 'fixture note', 'owner', 'fixture-session-1', 'fixture-turn-1')`,
    [FIXTURE_OWNER]),
  row("agent_notes", "owner", FIXTURE_SECOND,
    `INSERT INTO agent_notes (owner, agent, kind, note, origin, session_id, turn_id)
     VALUES ($1, 'fixture-agent', 'working', 'fixture note two', 'owner', 'fixture-session-2', 'fixture-turn-2')`,
    [FIXTURE_SECOND]),

  // ── 072_memory_proposals.sql / 073_memory_use.sql ─────────────────────────────────────────
  row("memory_use", "owner", FIXTURE_OWNER,
    `INSERT INTO memory_use (kind, ref, owner) VALUES ('standing_fact', '1', $1)`,
    [FIXTURE_OWNER]),

  // ── 075_memory_reads.sql ──────────────────────────────────────────────────────────────────
  row("memory_reads", "owner", FIXTURE_OWNER,
    `INSERT INTO memory_reads (session_id, turn_id, owner, kind, ref)
     VALUES ('fixture-session-1', 'fixture-turn-1', $1, 'standing_fact', '1')`,
    [FIXTURE_OWNER]),

  // ── 076_forget_ledger.sql ─────────────────────────────────────────────────────────────────
  row("forget_ledger", "owner", FIXTURE_OWNER,
    `INSERT INTO forget_ledger (owner, kind, match_hash, reason) VALUES ($1, 'fact', repeat('0', 64), 'forget')`,
    [FIXTURE_OWNER]),

  // ── dream tables (runtime DDL, not a numbered migration; box 084 gives them an `owner`
  //    column, W5I-s6) — one row per fixture person in each table, so a later erase test can
  //    tell the two apart the same way it can for every numbered-migration member table. ─────
  row("dream_observations", "owner", FIXTURE_OWNER,
    `INSERT INTO dream_observations (text, kind, origin, owner)
     VALUES ('fixture observation for the owner', 'identity', 'owner', $1)`,
    [FIXTURE_OWNER]),
  row("dream_observations", "owner", FIXTURE_SECOND,
    `INSERT INTO dream_observations (text, kind, origin, owner)
     VALUES ('fixture observation for the second person', 'identity', 'owner', $1)`,
    [FIXTURE_SECOND]),
  row("dream_preferences", "owner", FIXTURE_OWNER,
    `INSERT INTO dream_preferences (text, kind, origin, owner)
     VALUES ('fixture preference for the owner', 'preference', 'owner', $1)`,
    [FIXTURE_OWNER]),
  row("dream_preferences", "owner", FIXTURE_SECOND,
    `INSERT INTO dream_preferences (text, kind, origin, owner)
     VALUES ('fixture preference for the second person', 'preference', 'owner', $1)`,
    [FIXTURE_SECOND]),

  // ── services/chief-of-staff/sql/002-standing-facts.sql + 003/004/005 ──────────────────────
  row("standing_facts", "user_id", FIXTURE_OWNER,
    `INSERT INTO standing_facts (fact, category, source_turn, user_id, origin)
     VALUES ('Fixture said something', 'preference', 'fixture-turn-1', $1, 'owner')`,
    [FIXTURE_OWNER]),
  row("standing_facts", "user_id", FIXTURE_SECOND,
    `INSERT INTO standing_facts (fact, category, source_turn, user_id, origin)
     VALUES ('Fixture second said something', 'preference', 'fixture-turn-2', $1, 'owner')`,
    [FIXTURE_SECOND]),
];

/** Every table the fixture puts a row in, with the spelling it used. Later slices assert
 *  against THIS, so a table that gains rows must be added here (in SEED_ROWS above) in the
 *  same change. */
export const FIXTURE_ROWS: ReadonlyArray<{ table: string; column: string; value: string }> =
  SEED_ROWS.map(({ table, column, value }) => ({ table, column, value }));

// ─── The dream tables' DDL, copied verbatim from services/chief-of-staff/lib/dream/store.ts's
// `ensureDreamTables` (services/box cannot import services/chief-of-staff). Not a numbered
// migration on a real box either — see lib/member-scope.ts's DREAM_STORE constant. AS OF box 084
// (W5I-s6, ruling D5) both tables carry an `owner text` column (nullable, no default — kept in
// step with that ALTER; see this fixture's SEED_ROWS below for the rows it seeds into them).
const DREAM_TABLES_DDL = [
  `CREATE TABLE IF NOT EXISTS dream_observations (
     id         uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
     text       text          NOT NULL,
     kind       text          NOT NULL,
     subject    text          NOT NULL DEFAULT '',
     confidence double precision NOT NULL DEFAULT 0,
     source     text,
     owner      text,
     valid_from timestamptz   NOT NULL DEFAULT now(),
     valid_to   timestamptz,
     created_at timestamptz   NOT NULL DEFAULT now()
   )`,
  `ALTER TABLE dream_observations ADD COLUMN IF NOT EXISTS text_norm text`,
  `ALTER TABLE dream_observations ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'agent'`,
  `ALTER TABLE dream_observations ADD COLUMN IF NOT EXISTS owner text`,
  `CREATE TABLE IF NOT EXISTS dream_preferences (
     id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
     text          text          NOT NULL,
     kind          text          NOT NULL,
     subject       text          NOT NULL DEFAULT '',
     confidence    double precision NOT NULL DEFAULT 0,
     source        text,
     owner         text,
     valid_from    timestamptz   NOT NULL DEFAULT now(),
     valid_to      timestamptz,
     superseded_by uuid,
     created_at    timestamptz   NOT NULL DEFAULT now()
   )`,
  `ALTER TABLE dream_preferences ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'agent'`,
  `ALTER TABLE dream_preferences ADD COLUMN IF NOT EXISTS owner text`,
];

/** Every `services/box/sql/[0-9][0-9][0-9]_*.sql` file, in numeric-then-alphabetic order (two
 *  files share the number 019 — see sql/062_schema_migrations.sql's own comment on that). Read
 *  off disk rather than named one by one, so a new migration is picked up automatically instead
 *  of silently stopping at whatever number the last builder named (tests/helpers/pg.ts's mistake,
 *  which stopped at 019). */
function boxSqlFilesInOrder(): string[] {
  return readdirSync(boxSqlDir)
    .filter((f) => /^[0-9]{3}_.*\.sql$/.test(f))
    .sort();
}

const CHIEF_OF_STAFF_STANDING_FACTS_FILES = [
  "002-standing-facts.sql",
  "003-facts-owner.sql",
  "004-standing-facts-origin.sql",
  "005-standing-facts-validity.sql",
];

/** A throwaway Postgres with the box's real schema applied from `services/box/sql`, plus the
 *  per-service files erase must reach (`chief-of-staff/sql/002…005`) and the dream tables'
 *  runtime DDL — seeded with TWO people whose rows use all three id conventions.
 *  Nothing here ever connects to a real installation: the container is disposable and the
 *  connection string is generated. */
export async function startThreeSpellingsDb(): Promise<TestDb> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    "pgvector/pgvector:pg16",
  ).start();
  const connectionString = container.getConnectionUri();
  const pool = new Pool({ connectionString });
  // Stopping the container ends every server-side session with FATAL 57P01. A connection that
  // `pool.end()` has let go of but whose socket is not closed yet still hears it, has no listener
  // by then, and the run fails with an "unhandled error" although every test passed (seen on CI,
  // 2026-09-19, intermittently). The database is disposable: its dying words are not a result.
  pool.on("error", () => undefined);
  pool.on("connect", (client) => client.on("error", () => undefined));

  for (const file of boxSqlFilesInOrder()) {
    await pool.query(readFileSync(join(boxSqlDir, file), "utf8"));
  }
  for (const file of CHIEF_OF_STAFF_STANDING_FACTS_FILES) {
    await pool.query(readFileSync(join(chiefOfStaffSqlDir, file), "utf8"));
  }
  for (const stmt of DREAM_TABLES_DDL) {
    await pool.query(stmt);
  }

  for (const seed of SEED_ROWS) {
    await seed.insert(pool);
  }

  return {
    pool,
    connectionString,
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
}
