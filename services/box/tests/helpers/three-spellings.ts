// services/box/tests/helpers/three-spellings.ts — the fixture the rest of the
// identity track (the resolver, the two migrations that rewrite person columns, the Google-token
// rename, erase-a-person) is proven against — never the live server.
//
// A disposable Postgres with the box's REAL schema applied from services/box/sql (every numbered
// migration file, in order, read off disk rather than named one by one — the mistake
// tests/helpers/pg.ts made and stopped at 019; that includes 002_standing_facts.sql, which creates
// the chief of staff's standing_facts table), including the dream schema migration. Seeded with
// TWO fictional people whose rows use all
// four id conventions the inventory (lib/member-scope.ts) records: `registry` (the identity
// register's own id space), `principal` (an older, door-native/legacy spelling), `owner-key` (a
// free-text `owner` column convention fills with the canonical id) and `actor` (whoever changed
// an administrative row).
//
// NOTHING HERE EVER TOUCHES A REAL INSTALLATION. The container is disposable
// (@testcontainers/postgresql), the connection string is generated per run, and every value this
// module writes is fictional (`fixture-owner`, `fixture-second`, example.invalid addresses,
// made-up ids). Applying the real migrations also runs their own seeds — 001_baseline.sql,
// 001_baseline.sql and 001_baseline.sql each insert ONE real installation's row ('owner') — that
// is what a real box has and this fixture must work alongside; it never adds to those rows, and
// every assertion in the test file that uses this module is about the fixture members only.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { encryptSecret } from "../../lib/crypto.js";
import { payloadFingerprint } from "../../../../packages/agent-kit/src/approval-ledger.js";
import { PRIVATE_CONSOLE_SURFACE_REVISION } from "../../../../packages/agent-kit/src/console-turn-authority.js";

const here = dirname(fileURLToPath(import.meta.url));
const boxSqlDir = join(here, "..", "..", "sql");

export interface TestDb {
  pool: Pool;
  connectionString: string;
  stop: () => Promise<void>;
}

/** Who the fixture seeds, named once so every later test quotes it rather than re-deriving it. */
export const FIXTURE_OWNER = "fixture-owner";
export const FIXTURE_SECOND = "fixture-second";

// Legacy/channel-native spellings — the shape 001_baseline.sql's own alias set shows a real
// long-lived box actually accumulates (a case-divergent duplicate included). Deliberately NOT
// equal to FIXTURE_OWNER/FIXTURE_SECOND: that difference is the whole point of the `principal`
// convention, and five tables are still seeded under exactly these spellings (digest_requests,
// workflow_jobs, meeting_followup_sent and the two agent_door tables — the inventory's
// `LEGACY_PRINCIPAL_TABLES`). `oauth_tokens` and `email_watch_cursors` are NO LONGER among them:
// the baseline schema keys their principals onto the register's id, so the fixture seeds them the way a
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
// three-spellings-fixture.test.ts and by every later test) and WRITES it — one definition, so
// the two can never drift apart.
const SEED_ROWS: SeedRow[] = [
  // ── The identity register itself (001_baseline.sql) ──────────────────────────────────────
  row("users", "id", FIXTURE_OWNER,
    `INSERT INTO users (id, display_name, primary_email) VALUES ($1, 'Fixture Owner', 'owner@fixture.test')`,
    [FIXTURE_OWNER]),
  row("users", "id", FIXTURE_SECOND,
    `INSERT INTO users (id, display_name, primary_email) VALUES ($1, 'Fixture Second', 'second@fixture.test')`,
    [FIXTURE_SECOND]),

  row("studio_runs", "owner_member_id", FIXTURE_OWNER,
    `INSERT INTO studio_runs (brief, consensus, spread, principal, owner_member_id)
     VALUES ('Fixture owner brief', 'Fixture grounding', '[]'::jsonb, 'U_fixture', $1)`,
    [FIXTURE_OWNER]),
  row("studio_runs", "owner_member_id", FIXTURE_SECOND,
    `INSERT INTO studio_runs (brief, consensus, spread, principal, owner_member_id)
     VALUES ('Fixture second brief', 'Fixture grounding', '[]'::jsonb, 'U_fixture2', $1)`,
    [FIXTURE_SECOND]),

  ...[FIXTURE_OWNER,FIXTURE_SECOND].map((member,index) => row("approval_asks", "acting_member_id", member,
    `INSERT INTO approval_asks(request_id,call_id,agent,tool,payload_hash,acting_member_id) VALUES($1,$2,'fixture-agent','deadline_dismiss','fixture-hash',$3)`,
    [`fixture-approval-${index}`,`fixture-call-${index}`,member])),

  // Personal connected-account metadata; account rows precede their selected resources.
  row("connected_accounts", "owner_member_id", FIXTURE_OWNER,
    `INSERT INTO connected_accounts (id, owner_member_id, connector_id, provider_issuer, provider_subject, provider_label, status)
     VALUES ('fixture-account-1', $1, 'google', 'https://provider.example', 'fixture-account-1', 'Fixture account', 'ok')`,
    [FIXTURE_OWNER]),
  row("connected_accounts", "owner_member_id", FIXTURE_SECOND,
    `INSERT INTO connected_accounts (id, owner_member_id, connector_id, provider_issuer, provider_subject, provider_label, status)
     VALUES ('fixture-account-2', $1, 'google', 'https://provider.example', 'fixture-account-2', 'Fixture account', 'ok')`,
    [FIXTURE_SECOND]),
  row("connected_resource_bindings", "owner_member_id", FIXTURE_OWNER,
    `INSERT INTO connected_resource_bindings (id, owner_member_id, connected_account_id, resource_kind, external_id, provider_label)
     VALUES ('fixture-account-1-resource', $1, 'fixture-account-1', 'mailbox', 'mailbox', 'Fixture inbox')`,
    [FIXTURE_OWNER]),
  row("connected_resource_bindings", "owner_member_id", FIXTURE_SECOND,
    `INSERT INTO connected_resource_bindings (id, owner_member_id, connected_account_id, resource_kind, external_id, provider_label)
     VALUES ('fixture-account-2-resource', $1, 'fixture-account-2', 'mailbox', 'mailbox', 'Fixture inbox')`,
    [FIXTURE_SECOND]),

  // Pending personal action content belongs to its actor; the trigger retains only a call hash
  // after erasure. Use the real encrypted format so exports exercise the same withheld column.
  ...[FIXTURE_OWNER,FIXTURE_SECOND].map((member,index) => {
    const id=`77777777-7777-4777-8777-77777777777${index+1}`;
    const selection={actorMemberId:member,agentId:'fixture-agent',
      incarnation:'88888888-8888-4888-8888-888888888888',sessionId:`fixture-action-session-${index}`,
      originalTurnId:`fixture-action-turn-${index}`,originalCallId:`fixture-action-call-${index}`,
      accountId:`fixture-account-${index+1}`,accountGeneration:0,
      resourceBindingId:`fixture-account-${index+1}-resource`,connectorId:'google',kind:'mail.send'};
    const payload={to:['recipient@example.invalid'],subject:'Fixture proposal',body:'Private fixture message'};
    const ciphertext=encryptSecret(JSON.stringify({purpose:'lares.personal-action.v1',version:1,actionId:id,selection,payload}),'3'.repeat(64));
    return row("personal_actions", "actor_member_id", member,
      `INSERT INTO personal_actions(id,payload_version,actor_member_id,agent,incarnation,session_id,
       original_turn_id,original_call_id,original_call_hash,account_id,account_generation,resource_binding_id,
       connector_id,kind,payload_hash,payload_ciphertext,created_at,expires_at)
       SELECT $1,1,$2,'fixture-agent',$3,$4,$5,$6,repeat('0',64),$7,0,$8,'google','mail.send',$9,$10,t,t+interval '24 hours'
       FROM (SELECT clock_timestamp() AS t) clock`,
      [id,member,selection.incarnation,selection.sessionId,selection.originalTurnId,selection.originalCallId,
        selection.accountId,selection.resourceBindingId,payloadFingerprint('mail.send',payload),ciphertext]);
  }),

  row("user_aliases", "user_id", FIXTURE_OWNER,
    `INSERT INTO user_aliases (system, alias, user_id) VALUES
       ('legacy', $2, $1), ('legacy', $3, $1), ('slack', $4, $1), ('email', $5, $1)`,
    [FIXTURE_OWNER, LEGACY, LEGACY_CASE, "U_FIXTURE_SLACK", "owner@fixture.test"]),
  row("user_aliases", "user_id", FIXTURE_SECOND,
    `INSERT INTO user_aliases (system, alias, user_id) VALUES
       ('legacy', $2, $1), ('legacy', $3, $1), ('slack', $4, $1), ('email', $5, $1)`,
    [FIXTURE_SECOND, LEGACY_SECOND, "U_FIXTURE2", "U_FIXTURE2_SLACK", "second@fixture.test"]),

  // ── 001_baseline.sql ──────────────────────────────────────────────────────────────────────────
  row("reminders", "owner", FIXTURE_OWNER,
    `INSERT INTO reminders (agent, owner, due_at, payload, created_by)
     VALUES ('fixture-agent', $1, now() + interval '1 day', '{}'::jsonb, $1)`,
    [FIXTURE_OWNER]),
  row("reminders", "owner", FIXTURE_SECOND,
    `INSERT INTO reminders (agent, owner, due_at, payload, created_by)
     VALUES ('fixture-agent', $1, now() + interval '1 day', '{}'::jsonb, $1)`,
    [FIXTURE_SECOND]),

  // ── 001_baseline.sql ────────────────────────────────────────────────────────────────────────
  row("digest_requests", "requested_by", LEGACY,
    `INSERT INTO digest_requests (agent, requested_by, door, thread_ref)
     VALUES ('fixture-agent', $1, 'slack', 'fixture-thread-1')`,
    [LEGACY]),

  // ── 001_baseline.sql ─────────────────────────────────────────────────────────────────
  row("workflow_jobs", "principal", LEGACY,
    `INSERT INTO workflow_jobs (agent, principal, workflow_type)
     VALUES ('fixture-agent', $1, 'fixture-workflow')`,
    [LEGACY]),

  // ── 001_baseline.sql — the register's id ────────────────────
  row("oauth_tokens", "principal", FIXTURE_OWNER,
    `INSERT INTO oauth_tokens (principal, provider, org_id, email_address, refresh_token_enc)
     VALUES ($1, 'google', 'fixture-org', 'owner@fixture.test', 'fixture-encrypted-blob')`,
    [FIXTURE_OWNER]),
  row("oauth_tokens", "principal", FIXTURE_SECOND,
    `INSERT INTO oauth_tokens (principal, provider, org_id, email_address, refresh_token_enc)
     VALUES ($1, 'google', 'fixture-org', 'second@fixture.test', 'fixture-encrypted-blob-2')`,
    [FIXTURE_SECOND]),

  row("connected_account_credentials", "owner_member_id", FIXTURE_OWNER,
    `INSERT INTO connected_account_credentials (account_id,owner_member_id,connector_id,account_generation,oauth_token_id)
     SELECT 'fixture-account-1',$1,'google',0,id FROM oauth_tokens WHERE principal=$1 AND provider='google'`,
    [FIXTURE_OWNER]),
  row("connected_account_credentials", "owner_member_id", FIXTURE_SECOND,
    `INSERT INTO connected_account_credentials (account_id,owner_member_id,connector_id,account_generation,oauth_token_id)
     SELECT 'fixture-account-2',$1,'google',0,id FROM oauth_tokens WHERE principal=$1 AND provider='google'`,
    [FIXTURE_SECOND]),

  // ── 001_baseline.sql — also fires ratchet_audit_trg, see the no-op entry below ─────────────
  row("ratchet", "updated_by", FIXTURE_OWNER,
    `INSERT INTO ratchet (agent, capability, level, updated_by)
     VALUES ('fixture-agent', 'fixture-capability', 'gated', $1)`,
    [FIXTURE_OWNER]),

  // ── 001_baseline.sql — the register's id ─────────────
  row("email_watch_cursors", "principal", FIXTURE_OWNER,
    `INSERT INTO email_watch_cursors (watcher, principal, email_address)
     VALUES ('fixture-watcher', $1, 'owner@fixture.test')`,
    [FIXTURE_OWNER]),

  // ── 001_baseline.sql — voice_profile is a singleton (id='default'), already inserted by the
  //    migration itself; this UPDATEs its one row rather than inserting a second ─────────────
  row("voice_profile", "updated_by", FIXTURE_OWNER,
    `UPDATE voice_profile SET updated_by = $1 WHERE id = 'default'`,
    [FIXTURE_OWNER]),

  // ── 001_baseline.sql ───────────────────────────────────────────────────────────────────
  row("obligation_threads", "principal", FIXTURE_OWNER,
    `INSERT INTO obligation_threads
       (thread_id, principal, counterparty_address, last_message_at, last_speaker_is_them)
     VALUES ('fixture-thread-1', $1, 'someone@example.invalid', now(), false)`,
    [FIXTURE_OWNER]),

  // ── 001_baseline.sql (principal added by 023, written as the canonical id) ─
  row("telegram_daily_log", "principal", FIXTURE_OWNER,
    `INSERT INTO telegram_daily_log (chat_id, role, body, principal)
     VALUES ('fixture-chat-1', 'user', 'hello', $1)`,
    [FIXTURE_OWNER]),
  row("telegram_session_rotation", "principal", FIXTURE_OWNER,
    `INSERT INTO telegram_session_rotation (chat_id, local_day, principal)
     VALUES ('fixture-chat-1', '2026-09-19', $1)`,
    [FIXTURE_OWNER]),

  // ── 001_baseline.sql (principal added by 023, written as the canonical id) ────────
  row("outreach_threads", "principal", FIXTURE_OWNER,
    `INSERT INTO outreach_threads (thread_id, account, principal)
     VALUES ('fixture-thread-1', 'owner@fixture.test', $1)`,
    [FIXTURE_OWNER]),

  // ── 001_baseline.sql ──────────────────────────────────────────────────────────────────
  row("email_triage_processed", "principal", FIXTURE_OWNER,
    `INSERT INTO email_triage_processed (mailbox, gmail_message_id, principal, outcome)
     VALUES ('owner@fixture.test', 'fixture-msg-1', $1, 'drafted')`,
    [FIXTURE_OWNER]),

  // ── 001_baseline.sql ──────────────────────────────────────────────────────────────
  row("meeting_followup_sent", "principal", LEGACY,
    `INSERT INTO meeting_followup_sent (notion_page_id, principal, outcome)
     VALUES ('fixture-page-1', $1, 'sent')`,
    [LEGACY]),

  // ── 001_baseline.sql ──────────────────────────────────────────────────────────────────
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

  // Financial evidence is member-scoped but survives erasure with its person metadata removed.
  {
    table: "budget_accounts", column: "live_member_id", value: FIXTURE_OWNER,
    insert: async (pool) => {
      // The member guard must see its installation account in an earlier statement.
      // A sibling data-changing CTE shares the outer statement's snapshot.
      await pool.query(`INSERT INTO budget_accounts(id,installation_id,kind,installation_account_id)
        VALUES('a1111111-1111-4111-8111-111111111111','fixture-installation','installation','a1111111-1111-4111-8111-111111111111')`);
      await pool.query(`INSERT INTO budget_accounts(id,installation_id,kind,installation_account_id,live_member_id,canonical_suppression_hash,provider_suppression_hashes)
        VALUES('a2222222-2222-4222-8222-222222222222','fixture-installation','member','a1111111-1111-4111-8111-111111111111',$1,repeat('d',64),ARRAY[repeat('e',64)])`, [FIXTURE_OWNER]);
    },
  },
  row("budget_windows", "live_member_id", FIXTURE_OWNER,
    `WITH installation_window AS (INSERT INTO budget_windows(id,account_id,starts_at,ends_at,opening_liability,opening_cap,policy_revision)
       VALUES('a6666666-6666-4666-8666-666666666666','a1111111-1111-4111-8111-111111111111',now(),now()+interval '1 day',0,1,0) RETURNING id)
     INSERT INTO budget_windows(id,account_id,live_member_id,starts_at,ends_at,opening_liability,opening_cap,policy_revision)
       VALUES('a3333333-3333-4333-8333-333333333333','a2222222-2222-4222-8222-222222222222',$1,now(),now()+interval '1 day',0,1,0)`,[FIXTURE_OWNER]),
  row("budget_gateway_bindings", "live_member_id", FIXTURE_OWNER,
    `INSERT INTO budget_gateway_bindings(id,installation_account_id,member_account_id,live_member_id,endpoint_hash,credential_generation,key_fingerprint,agent,profile_hash,maximum_liability)
       VALUES('a4444444-4444-4444-8444-444444444444','a1111111-1111-4111-8111-111111111111','a2222222-2222-4222-8222-222222222222',$1,repeat('a',64),0,repeat('b',64),'fixture-agent',repeat('c',64),0.1)`,[FIXTURE_OWNER]),
  row("budget_attempts", "live_member_id", FIXTURE_OWNER,
    `INSERT INTO budget_attempts(invocation_hash,id,ticket_hash,installation_account_id,member_account_id,binding_id,live_member_id,installation_window_id,member_window_id,endpoint_hash,credential_generation,installation_policy_generation,member_policy_generation,endpoint_generation,recovery_epoch,request_hash,authority_hash,authority_reference,profile_hash,reserved_amount,installation_cap_snapshot,member_cap_snapshot,created_at,expires_at)
       SELECT repeat('b',64),'a5555555-5555-4555-8555-555555555555',repeat('f',64),'a1111111-1111-4111-8111-111111111111','a2222222-2222-4222-8222-222222222222','a4444444-4444-4444-8444-444444444444',$1,'a6666666-6666-4666-8666-666666666666','a3333333-3333-4333-8333-333333333333',repeat('a',64),0,0,0,0,'fixture-epoch',repeat('1',64),repeat('2',64),'{"sessionId":"fixture-private"}',repeat('c',64),0.1,1,1,t,t+interval '30 seconds' FROM(SELECT clock_timestamp() AS t)c`,[FIXTURE_OWNER]),

  // ── 001_baseline.sql ───────────────────────────────────────────────────────────────────
  row("proactivity_settings", "owner", FIXTURE_OWNER,
    `INSERT INTO proactivity_settings (owner, agent, door) VALUES ($1, 'fixture-agent', 'slack')`,
    [FIXTURE_OWNER]),
  row("initiations", "owner", FIXTURE_OWNER,
    `INSERT INTO initiations (owner, agent, door, cls, item_key, status, owner_day)
     VALUES ($1, 'fixture-agent', 'slack', 'event', 'fixture-item', 'sent', CURRENT_DATE)`,
    [FIXTURE_OWNER]),
  row("owner_clock_signals", "owner", FIXTURE_OWNER,
    `INSERT INTO owner_clock_signals (owner, source, tz) VALUES ($1, 'slack-profile', 'Europe/Berlin')`,
    [FIXTURE_OWNER]),

  // ── 001_baseline.sql ─────────────────────────────────────────────────────────────────────
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

  // ── 001_baseline.sql ─────────────────────────────────────────────────────────────
  // ratchet_audit is written by ratchet_audit_trg when the `ratchet` row above is inserted
  // (changed_by = NEW.updated_by) — no separate INSERT here, just the documentation entry.
  row("ratchet_audit", "changed_by", FIXTURE_OWNER, `SELECT 1`, []),

  // ── 001_baseline.sql ────────────────────────────────────────────────────────────────────────
  row("keeper_audit", "actor", FIXTURE_OWNER,
    `INSERT INTO keeper_audit (action, actor, outcome) VALUES ('fixture-action', $1, 'ok')`,
    [FIXTURE_OWNER]),
  row("settings", "updated_by", FIXTURE_OWNER,
    `INSERT INTO settings (key, value, updated_by) VALUES ('fixture-setting', '{}'::jsonb, $1)`,
    [FIXTURE_OWNER]),
  // settings_audit is written by settings_audit_trg when the `settings` row above is inserted
  // (changed_by = NEW.updated_by) — no separate INSERT here, just the documentation entry.
  row("settings_audit", "changed_by", FIXTURE_OWNER, `SELECT 1`, []),

  // ── 001_baseline.sql ────────────────────────────────────────────────────────
  row("agent_door_connections", "principal", LEGACY,
    `INSERT INTO agent_door_connections (agent, kind, incarnation, revision, owner_email, principal)
     VALUES ('fixture-agent', 'slack', gen_random_uuid(), gen_random_uuid(), 'owner@fixture.test', $1)`,
    [LEGACY]),
  row("agent_door_claim_audit", "principal", LEGACY,
    `INSERT INTO agent_door_claim_audit (agent, kind, incarnation, principal)
     VALUES ('fixture-agent', 'slack', gen_random_uuid(), $1)`,
    [LEGACY]),

  // ── 001_baseline.sql ────────────────────────────────────────────────────────────────
  row("brief_settings", "owner", FIXTURE_OWNER,
    `INSERT INTO brief_settings (owner) VALUES ($1)`,
    [FIXTURE_OWNER]),

  // ── 001_baseline.sql ──────────────────────────────────────────────────────────
  row("conversation_entries", "person_key", FIXTURE_OWNER,
    `INSERT INTO conversation_entries (agent, session_id, turn_id, door, person_key, origin, input, reply, at)
     VALUES ('fixture-agent', 'fixture-session-1', 'fixture-turn-1', 'slack', $1, 'owner', 'hi', 'hello', now())`,
    [FIXTURE_OWNER]),
  row("conversation_entries", "person_key", FIXTURE_SECOND,
    `INSERT INTO conversation_entries (agent, session_id, turn_id, door, person_key, origin, input, reply, at)
     VALUES ('fixture-agent', 'fixture-session-2', 'fixture-turn-2', 'slack', $1, 'owner', 'hi', 'hello', now())`,
    [FIXTURE_SECOND]),

  // ── 001_baseline.sql ────────────────────────────────────────────────────────
  row("conversation_retention", "owner", FIXTURE_OWNER,
    `INSERT INTO conversation_retention (owner, months) VALUES ($1, 12)`,
    [FIXTURE_OWNER]),

  // ── 001_baseline.sql ─────────────────────────────────────────────────────────────
  row("schedule_settings", "owner", FIXTURE_OWNER,
    `INSERT INTO schedule_settings (owner, schedule, hours) VALUES ($1, 'fixture-brief', ARRAY[8])`,
    [FIXTURE_OWNER]),

  // ── 001_baseline.sql ───────────────────────────────────────────────────────────────────
  row("agent_notes", "owner", FIXTURE_OWNER,
    `INSERT INTO agent_notes (owner, agent, kind, note, origin, session_id, turn_id)
     VALUES ($1, 'fixture-agent', 'working', 'fixture note', 'owner', 'fixture-session-1', 'fixture-turn-1')`,
    [FIXTURE_OWNER]),
  row("agent_notes", "owner", FIXTURE_SECOND,
    `INSERT INTO agent_notes (owner, agent, kind, note, origin, session_id, turn_id)
     VALUES ($1, 'fixture-agent', 'working', 'fixture note two', 'owner', 'fixture-session-2', 'fixture-turn-2')`,
    [FIXTURE_SECOND]),

  // ── 001_baseline.sql / 001_baseline.sql ─────────────────────────────────────────
  row("memory_use", "owner", FIXTURE_OWNER,
    `INSERT INTO memory_use (kind, ref, owner) VALUES ('standing_fact', '1', $1)`,
    [FIXTURE_OWNER]),

  // ── 001_baseline.sql ──────────────────────────────────────────────────────────────────
  row("memory_reads", "owner", FIXTURE_OWNER,
    `INSERT INTO memory_reads (session_id, turn_id, owner, kind, ref)
     VALUES ('fixture-session-1', 'fixture-turn-1', $1, 'standing_fact', '1')`,
    [FIXTURE_OWNER]),

  // ── 001_baseline.sql ─────────────────────────────────────────────────────────────────
  row("forget_ledger", "owner", FIXTURE_OWNER,
    `INSERT INTO forget_ledger (owner, kind, match_hash, reason) VALUES ($1, 'fact', repeat('0', 64), 'forget')`,
    [FIXTURE_OWNER]),

  // ── 026_dream_schema.sql — one row per fixture person in each table, so a later erase test can
  //    tell the two apart the same way it can for every migration-owned member table. ──────────
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

  // ── 002_standing_facts.sql ────────────────────────────────────────────────────────────────
  row("standing_facts", "user_id", FIXTURE_OWNER,
    `INSERT INTO standing_facts (fact, category, source_turn, user_id, origin)
     VALUES ('Fixture said something', 'preference', 'fixture-turn-1', $1, 'owner')`,
    [FIXTURE_OWNER]),
  row("standing_facts", "user_id", FIXTURE_SECOND,
    `INSERT INTO standing_facts (fact, category, source_turn, user_id, origin)
     VALUES ('Fixture second said something', 'preference', 'fixture-turn-2', $1, 'owner')`,
    [FIXTURE_SECOND]),

  ...[FIXTURE_OWNER,FIXTURE_SECOND].flatMap((member,index) => [
    row("agent_access", "owner_member_id", member,
      `WITH org AS (INSERT INTO orgs(id,display_name) VALUES($3,'Fixture agent organisation') RETURNING id), definition AS (INSERT INTO agent_definitions(name,definition,hash) VALUES($1,'{"grants":[]}'::jsonb,'fixture') RETURNING name)
       INSERT INTO agent_access(agent_name,owner_member_id,organisation_id) SELECT definition.name,$2,o.id FROM definition,org o`,
      [`fixture-shared-${index}`,member,`fixture-agent-org-${index}`]),
    row("resource_grants", "grantor_member_id", member,
      `INSERT INTO resource_grants(id,resource_kind,resource_id,principal_member_id,permission,grantor_member_id,issued_access_revision)
       SELECT $1,'agent',agent_name,$2,'use',$2,revision FROM agent_access WHERE agent_name=$3`,
      [`22222222-2222-4222-8222-${String(index+1).padStart(12,'0')}`,member,`fixture-shared-${index}`]),
  ]),

  ...[FIXTURE_OWNER,FIXTURE_SECOND].map((member,index) => row("console_session_bindings", "member_id", member,
    `INSERT INTO console_session_bindings(agent,incarnation,session_id,member_id,admission_nonce,place_id,agent_access_revision,private_surface_revision,policy_revision) VALUES('fixture-agent','11111111-1111-1111-1111-111111111111',$1,$2,$3,$4,1,$5,2)`,
    [`console-session-${index}`,member,String(index+1).repeat(43),`console-place-${index}`,PRIVATE_CONSOLE_SURFACE_REVISION])),

  // ── 004_web_inbox.sql ─────────────────────────────────────────────────────────────────────
  row("web_inbox", "owner", FIXTURE_OWNER,
    `INSERT INTO web_inbox (owner, agent, kind, title, body, item_key)
     VALUES ($1, 'fixture-agent', 'morning-brief', 'Fixture brief', 'Fixture message for the owner', 'fixture-inbox-1')`,
    [FIXTURE_OWNER]),
  row("web_inbox", "owner", FIXTURE_SECOND,
    `INSERT INTO web_inbox (owner, agent, kind, title, body, item_key)
     VALUES ($1, 'fixture-agent', 'morning-brief', 'Fixture brief', 'Fixture message for the second person', 'fixture-inbox-2')`,
    [FIXTURE_SECOND]),

  // Member admission metadata is reached by the same canonical id, never a provider subject.
  ...[FIXTURE_OWNER, FIXTURE_SECOND].flatMap((member, index) => [
    row("member_provider_identities", "member_id", member,
      `INSERT INTO member_provider_identities(member_id,issuer,subject) VALUES($1,'https://identity.example.invalid',$2)`, [member, `subject-${index}`]),
    row("member_invitations", "member_id", member,
      `INSERT INTO member_invitations(id,member_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')`, [`invite-${index}`,member,String(index+1).repeat(64)]),
    row("member_sessions", "member_id", member,
      `INSERT INTO member_sessions(id,member_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')`, [`session-${index}`,member,String(index+3).repeat(64)]),
  ]),

  // ── 001_baseline.sql — a source per person, then one ledger item under each (the ledger's
  //    foreign key needs its source first). ──────────────────────────────────────────────────
  row("clipping_sources", "owner", FIXTURE_OWNER,
    `INSERT INTO clipping_sources (id, kind, data_source_id, url_property_id, owner, visibility, import_since)
     VALUES ('fixture-clip-source-1', 'notion', 'fixture-data-source', 'u1', $1, 'shared', now())`,
    [FIXTURE_OWNER]),
  row("clipping_sources", "owner", FIXTURE_SECOND,
    `INSERT INTO clipping_sources (id, kind, data_source_id, url_property_id, owner, visibility, import_since)
     VALUES ('fixture-clip-source-2', 'notion', 'fixture-data-source', 'u1', $1, 'shared', now())`,
    [FIXTURE_SECOND]),
  row("clipping_items", "owner", FIXTURE_OWNER,
    `INSERT INTO clipping_items (source_id, source_item_id, source_container, owner, visibility, state)
     VALUES ('fixture-clip-source-1', 'fixture-page-1', 'fixture-data-source', $1, 'shared', 'imported')`,
    [FIXTURE_OWNER]),
  row("clipping_items", "owner", FIXTURE_SECOND,
    `INSERT INTO clipping_items (source_id, source_item_id, source_container, owner, visibility, state)
     VALUES ('fixture-clip-source-2', 'fixture-page-2', 'fixture-data-source', $1, 'shared', 'imported')`,
    [FIXTURE_SECOND]),
];

// Owned storage metadata is part of resolver/export completeness. Legacy erase-path
// tests explicitly use vaultAreas:false; dedicated tests prove owned-area and retained-source refusal.
const VAULT_ROWS: SeedRow[] = [row("vault_areas", "owner_member_id", FIXTURE_OWNER,
  `WITH organisation AS (INSERT INTO orgs(id,display_name) VALUES('fixture-vault-org','Fixture Vault organisation') RETURNING id),
    member AS (UPDATE users SET org_id=(SELECT id FROM organisation),org_role='owner' WHERE id=$1 RETURNING id,org_id),
    backing AS (INSERT INTO vault_backing_stores(id,organisation_id,kind) SELECT 'fixture-vault-backing',org_id,'git' FROM member RETURNING id,organisation_id)
    INSERT INTO vault_areas(id,organisation_id,kind,owner_member_id,backing_store_id,relative_path)
    SELECT 'fixture-private-area',backing.organisation_id,'private',member.id,backing.id,'private/fixture' FROM backing,member`, [FIXTURE_OWNER]),
  row("console_vault_source_captures", "member_id", FIXTURE_OWNER,
    `WITH binding AS (INSERT INTO console_session_bindings(agent,incarnation,session_id,member_id,admission_nonce,place_id,agent_access_revision,private_surface_revision,source_history_guard_revision,policy_revision)
      VALUES('fixture-source-agent','11111111-1111-1111-1111-111111111111','fixture-source-session',$1,repeat('s',43),'fixture-source-place',1,$2,1,2) RETURNING *)
     INSERT INTO console_vault_source_captures(agent,incarnation,session_id,member_id,admission_nonce,area_id,access_revision,session_definition_hash)
     SELECT b.agent,b.incarnation,b.session_id,b.member_id,b.admission_nonce,a.id,a.revision,repeat('a',64) FROM binding b,vault_areas a WHERE a.id='fixture-private-area'`,
    [FIXTURE_OWNER,PRIVATE_CONSOLE_SURFACE_REVISION])];

/** Every table the fixture puts a row in, with the spelling it used. Later tests assert
 *  against THIS, so a table that gains rows must be added here (in SEED_ROWS above) in the
 *  same change. */
export const FIXTURE_ROWS: ReadonlyArray<{ table: string; column: string; value: string }> =
  [...SEED_ROWS,...VAULT_ROWS].map(({ table, column, value }) => ({ table, column, value }));

/** Every `services/box/sql/[0-9][0-9][0-9]_*.sql` file, in numeric-then-alphabetic order (two
 *  files share the number 019 — see sql/001_baseline.sql's own comment on that). Read
 *  off disk rather than named one by one, so a new migration is picked up automatically instead
 *  of silently stopping at whatever number the last builder named (tests/helpers/pg.ts's mistake,
 *  which stopped at 019). */
function boxSqlFilesInOrder(): string[] {
  return readdirSync(boxSqlDir)
    .filter((f) => /^[0-9]{3}_.*\.sql$/.test(f))
    .sort();
}

/** A throwaway Postgres with the box's real schema applied from `services/box/sql` — seeded with
 *  TWO people whose rows use all three id conventions.
 *  Nothing here ever connects to a real installation: the container is disposable and the
 *  connection string is generated. */
export async function startThreeSpellingsDb(options: {
  vaultAreas?: boolean;
  financial?: boolean;
  beforeMigration?: (pool: Pool, migration: string) => Promise<void>;
} = {}): Promise<TestDb> {
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
    await options.beforeMigration?.(pool, file);
    await pool.query(readFileSync(join(boxSqlDir, file), "utf8"));
  }
  for (const seed of [...SEED_ROWS,...(options.vaultAreas===false?[]:VAULT_ROWS)]) {
    if(options.financial===false&&seed.table.startsWith('budget_'))continue;
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
