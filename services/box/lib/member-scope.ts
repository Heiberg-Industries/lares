// services/box/lib/member-scope.ts — the list of every table that holds a person.
//
// THE RULE, stated once so it can be quoted rather than reconstructed: a table added to
// `services/box/sql/*.sql` without a matching entry below fails
// `tests/member-scope-inventory.test.ts`, and that is the point. This module is not a
// convenience — it is the safety property an erase-a-person routine depends on. A
// table nobody listed is a table nobody erases.
//
// WHAT EACH CLASS MEANS.
//   member      — the row belongs to one person and is erased with them, found by `column`.
//   operational — the row is about the installation's running, not about a person.
//   derived     — the row can be rebuilt from a member table and is cleared, not exported.
//   resolved    — the row holds a person's words but has NO person column; it is reached by
//                 resolving ids or paths first (memory_proposals, the sync-state tables, the
//                 dream tables). Pretending one of these has a column would be worse than saying
//                 it does not — `reachedBy` says, in one sentence, what an erase routine must do
//                 instead.
//
// WHAT `idKind` ADDS, beyond its own `{ table, class, column }` shape. The fleet does
// not agree on what "the person" is: chief-of-staff writes rows under a constant owner id
// (`CANONICAL_USER_ID`, services/chief-of-staff/lib/identity-client.ts) while notion-sync
// resolves the owner from the identity registry (`users`, 001_baseline.sql). A `column` name
// alone hides that disagreement — `owner` and `principal` are both free text, neither is
// FK-enforced against `users.id` anywhere in this schema, and an erase routine that joins one of
// them against the wrong id space erases nothing while reporting success. `idKind` names, for
// every `member` table, which of three things the column actually holds:
//   "registry"   — the same id space as `users.id` (001_baseline.sql); some of these ARE
//                  FK-enforced (`cross_member_grants.grantor_user_id`, `org_member_policy.user_id`),
//                  some are documented as canonical without a foreign key
//                  (`conversation_entries.person_key`: "the canonical user id, never a channel
//                  address" — deliberately not an FK, so an entry outlives alias churn).
//   "principal"  — a "principal" (or `requested_by`) column: historically a door-native or legacy
//                  channel spelling, not FK-enforced against `users.id` anywhere. Five tables are
//                  left in this family; `oauth_tokens` and `email_watch_cursors` left it when
//                  001_baseline.sql renamed their values onto the register's id. Some comments
//                  elsewhere call it an "ADR-0009" convention, but `docs/decisions/` has no
//                  0009 (it jumps 0010 → 0013) and no other decision record defines the term
//                  either — "principal" is not defined anywhere in this repository; it survives
//                  only as a name.
//   "owner-key"  — a free-text `owner` column that installation convention fills with the
//                  canonical slug (001_baseline.sql backfills `reminders.owner` to it by hand),
//                  but nothing in the schema enforces that against `users.id`. ONE table is left in
//                  this family: `forget_ledger`. Every other formerly owner-keyed table now
//                  holds the register's id and has a `CHECK (<column> <> '')`; the ledger is
//                  excluded because its `match_hash` was derived from the owner string and can
//                  never be re-derived (see that entry's `reason`). There is still no foreign
//                  key on any of them, and `idKind: "registry"` here records what the values ARE,
//                  not what the schema enforces.
//   "actor"      — a column that names whoever (or whatever: 'system', 'unknown', 'console')
//                  changed an administrative row, not a member's own content. Classified `member`
//                  here on the conservative default this module follows (below), not because it
//                  is confidently a person.
//
// THE CONSERVATIVE DEFAULT. Where a table's only candidate person-column is an actor/operator
// label rather than clear member content (`ratchet.updated_by`, `ratchet_audit.changed_by`,
// `keeper_audit.actor`, `settings.updated_by`, `settings_audit.changed_by`,
// `voice_profile.updated_by`), this module classifies it `member` rather than `operational` and
// says so in `reason` — a wrongly-skipped person is worse than a wrongly-included one. These
// six are the genuinely unsure calls; a human may overrule them.
//
// WHAT IS DELIBERATELY EXCLUDED: eve's own `workflow.*` / `workflow_drizzle.*` schema
// (services/chief-of-staff/sql/001-eve-workflow.sql and its `services/creative` twin).
// `tablesInBoxSql` drops any dotted name for exactly this reason, and ADR-0020 rule 5 already
// says why an erase routine has nothing to say about them: "eve's own session/workflow rows are
// kept only as long as eve needs them to run — not subject to the twelve-month setting, and not
// treated as a historical record." (docs/decisions/0020-conversations.md, rule 5). They are not
// listed below; they are not this module's to cover.
//
// TWO TABLES THAT ARE NOT EVEN IN `services/box/sql`: `dream_observations` and
// `dream_preferences` are created by runtime DDL
// (`services/chief-of-staff/lib/dream/store.ts`'s `ensureDreamTables`), not by a numbered
// migration. They are listed below anyway, `createdBy` naming the runtime function rather than a
// `.sql` file. Both now carry a free-text-but-registry `owner`
// column — `member`/`registry`, not `resolved` any more — and every NEW row carries it
// (`makeDreamStore(db, owner)` throws rather than writing one without). A row written before the
// column existed is NULL unless the register held exactly one person at the time it was
// labelled (`labelExistingDreamRows`) — with more than one
// member the guess would be real, so it is left NULL on purpose. An erase still has to decide
// what a NULL row is: on a single-member installation it is that member's, wherever it was
// written; `labelExistingDreamRows`'s own doc comment says so.
//
// THE RESOLVER. `lib/person-identity.ts` EXISTS and is the only sanctioned way to turn a
// person into the set of spellings this inventory's `idKind` values describe (`registry`,
// `principal`, `owner-key`, `actor`). This module states what each table's column holds; it does
// not itself resolve one spelling to another — that is the resolver's job, and
// `person-identity.ts`'s `spellingsFor` is exhaustive over `IdKind`, so an id convention added
// here without teaching the resolver about it throws rather than resolving to no spellings at
// all. `tests/person-identity.test.ts` walks every `member` entry below against a real schema and
// fails if the resolver cannot reach one of them.
//
// THE RULE FOR EVERY NEW TABLE:
// every new table that holds a person's data carries a person column of kind `registry` — no new
// free-text owner key, no new legacy "principal" spelling, no new person-holding table with no
// person column at all, and no new free-text "actor" column. Multi-user is the next priority
// after launch, and each of those spellings is a way a later erase-a-person routine could miss a
// row or erase the wrong one. Today's exceptions are named explicitly, one frozen list per kind,
// in `tests/member-scope-inventory.test.ts`; each list may only SHRINK — the test fails the
// moment a table not on a list uses that kind, and fails just as loudly when a listed table no
// longer uses it (it was fixed; remove the table from the list in the same change).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * member      — the row belongs to one person and is erased with them, found by `column`.
 * operational — the row is about the installation's running, not about a person.
 * derived     — the row can be rebuilt from a member table and is cleared, not exported.
 * resolved    — the row holds a person's words but has NO person column; it is reached by
 *               resolving ids or paths first (memory_proposals, the sync-state tables).
 */
export type ScopeClass = "member" | "operational" | "derived" | "resolved";

/** How a `member` table's person-column is actually populated — see the file header. */
export type IdKind = "registry" | "principal" | "owner-key" | "actor";

export interface ScopedTable {
  table: string;
  scope: ScopeClass;
  /** The person column, for `member` only. */
  column?: string;
  /** For `member` only: what kind of id `column` holds. See the file header. */
  idKind?: IdKind;
  /** For `resolved`: one sentence naming what must be resolved first. */
  reachedBy?: string;
  /** The file that creates it, so a reader can check the claim. */
  createdBy: string;
  /** One line saying why this table is NOT a member table, for scopes other than `member`. */
  reason?: string;
  /** For a `resolved` table that CANNOT be reached at all: the honest limit, stated once.
   *  Present only where `reachedBy` would otherwise have to invent a join that does not exist. */
  clearedWholeOnly?: true;
}

const BOX = "services/box/sql";
const DREAM_STORE = "services/chief-of-staff/lib/dream/store.ts (runtime DDL)";

export const MEMBER_SCOPE: readonly ScopedTable[] = [
  { table: "agent_access", scope: "member", column: "owner_member_id", idKind: "registry", createdBy: `${BOX}/014_agent_access_grants.sql` },
  { table: "resource_grants", scope: "member", column: "grantor_member_id", idKind: "registry", createdBy: `${BOX}/014_agent_access_grants.sql`, reason: "principal_member_id also names the recipient and must be included in export/erase." },
  { table: "console_session_bindings", scope: "member", column: "member_id", idKind: "registry", createdBy: `${BOX}/013_console_turn_authority.sql` },
  { table: "connected_account_credentials", scope: "member", column: "owner_member_id", idKind: "registry", createdBy: `${BOX}/012_connected_account_credentials.sql` },
  { table: "connected_accounts", scope: "member", column: "owner_member_id", idKind: "registry", createdBy: `${BOX}/008_connected_accounts.sql` },
  { table: "connected_resource_bindings", scope: "member", column: "owner_member_id", idKind: "registry", createdBy: `${BOX}/008_connected_accounts.sql` },

  { table: "member_invitations", scope: "member", column: "member_id", idKind: "registry", createdBy: `${BOX}/007_member_identity_sessions.sql` },
  { table: "member_provider_identities", scope: "member", column: "member_id", idKind: "registry", createdBy: `${BOX}/007_member_identity_sessions.sql` },
  { table: "member_sessions", scope: "member", column: "member_id", idKind: "registry", createdBy: `${BOX}/007_member_identity_sessions.sql` },

  {
    table: "sessions",
    scope: "operational",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "which agent/door/thread a session maps to; no person column — the person is reachable only indirectly, via the door's own identity system.",
  },
  {
    table: "confirmations",
    scope: "operational",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "a short-lived approval gate keyed by session_id; it holds an action's parameters awaiting a yes/no, not a person's own words, and names no person directly.",
  },
  {
    table: "reminders",
    scope: "member",
    column: "owner",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
  },
  {
    table: "trigger_schedules",
    scope: "operational",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "a schedule's own name and cron expression, owned by an agent, not a person.",
  },
  {
    table: "audit",
    scope: "operational",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "an append-only log of outbound actions; its own comment says the payload is 'a redacted summary, not raw payload' — deliberately non-personal by design.",
  },

  {
    table: "digest_requests",
    scope: "member",
    column: "requested_by",
    idKind: "principal",
    createdBy: `${BOX}/001_baseline.sql`,
  },
  {
    table: "digest_skips",
    scope: "operational",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "keyed by (agent, vault-inbox path); records which item was left for a decision, not who left it.",
  },

  {
    table: "workflow_jobs",
    scope: "member",
    column: "principal",
    idKind: "principal",
    createdBy: `${BOX}/001_baseline.sql`,
  },

  {
    table: "oauth_tokens",
    scope: "member",
    column: "principal",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "named `principal` but holds the register's id as of 001_baseline.sql: the principal is a lookup key, not key material, so the rename needed no re-encryption and no re-consent.",
  },

  {
    table: "ratchet",
    scope: "member",
    column: "updated_by",
    idKind: "actor",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "conservative default: updated_by names whoever set a permission level, which may be an operator label rather than a member — an unsure call.",
  },

  {
    table: "email_watch_cursors",
    scope: "member",
    column: "principal",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "named `principal` but holds the register's id as of 001_baseline.sql, renamed in the same transaction as oauth_tokens so the watcher and the token store never disagree about who a mailbox belongs to.",
  },

  {
    table: "voice_profile",
    scope: "member",
    column: "updated_by",
    idKind: "actor",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "conservative default: voice_profile is a singleton (id text NOT NULL DEFAULT 'default'; learn_key defaults to a specific agent's own name, not a mailbox address or a person id); updated_by is the only candidate person-column and defaults to 'system' — an unsure call.",
  },
  {
    table: "voice_exemplar",
    scope: "resolved",
    clearedWholeOnly: true,
    reachedBy: "cannot be reached at all: sql/001_baseline.sql creates it as (id, lang, text, vector, source_message_id, included, created_at, mailbox) — no person column; `mailbox` is the address the mail was sent from, which does not resolve to a registered person. On a single-member installation the whole corpus is the owner's own learned exemplars and is cleared in full when the owner is erased; left untouched for any other identity.",
    createdBy: `${BOX}/001_baseline.sql`,
  },

  {
    table: "users",
    scope: "member",
    column: "id",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
  },
  {
    table: "user_aliases",
    scope: "member",
    column: "user_id",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
  },

  {
    table: "notion_sync_docs",
    scope: "resolved",
    reachedBy: "resolve via vault_path against a vault note's frontmatter scope, or via notion_page_id against the identity registry's linked Notion account.",
    createdBy: `${BOX}/001_baseline.sql`,
  },
  {
    table: "notion_sync_run",
    scope: "operational",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "a singleton run watermark (last_commit, last_run_at); no path, no person.",
  },

  {
    table: "notion_sync_proposals",
    scope: "resolved",
    reachedBy: "resolve via vault_path against a vault note's frontmatter scope, or via notion_page_id against the identity registry's linked Notion account.",
    createdBy: `${BOX}/001_baseline.sql`,
  },
  {
    table: "notion_sync_fidelity",
    scope: "resolved",
    reachedBy: "resolve via vault_path, the same path notion_sync_docs resolves.",
    createdBy: `${BOX}/001_baseline.sql`,
  },

  {
    table: "atlas_notes",
    scope: "resolved",
    reachedBy: "resolve via note_path against a vault note's frontmatter scope.",
    createdBy: `${BOX}/001_baseline.sql`,
  },
  {
    table: "atlas_proposals",
    scope: "resolved",
    reachedBy: "resolve via note_path, the same path atlas_notes resolves.",
    createdBy: `${BOX}/001_baseline.sql`,
  },

  {
    table: "obligation_threads",
    scope: "member",
    column: "principal",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
  },

  {
    table: "telegram_daily_log",
    scope: "member",
    column: "principal",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "named principal, but every write passes CANONICAL_USER_ID, the register's canonical id, not a channel spelling (services/chief-of-staff/lib/telegram-rotation.ts:126-127).",
  },
  {
    table: "telegram_session_rotation",
    scope: "member",
    column: "principal",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "named principal, but every write passes CANONICAL_USER_ID, the register's canonical id, not a channel spelling (services/chief-of-staff/lib/telegram-rotation.ts:84-88, :260-267).",
  },

  {
    table: "outreach_threads",
    scope: "member",
    column: "principal",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "named principal, but every write passes CANONICAL_USER_ID, the register's canonical id, not a channel spelling (services/chief-of-staff/lib/outreach-store.ts:56-61); person_id (a Twenty CRM contact id) names the third-party recipient, never the member — do not key an erase on person_id.",
  },

  {
    table: "email_triage_processed",
    scope: "member",
    column: "principal",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "named principal, but every write passes CANONICAL_USER_ID, the register's canonical id, not a channel spelling (services/chief-of-staff/lib/email-triage-store.ts:54-62).",
  },

  {
    table: "meeting_followup_sent",
    scope: "member",
    column: "principal",
    idKind: "principal",
    createdBy: `${BOX}/001_baseline.sql`,
  },

  {
    table: "orgs",
    scope: "operational",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "describes the org as a whole (today, a single organisation), not an individual member.",
  },

  {
    table: "cross_member_grants",
    scope: "member",
    column: "grantor_user_id",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
  },
  {
    table: "cross_member_reads",
    scope: "member",
    column: "grantor_user_id",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "grantor_user_id is whose data was read (the member this row belongs to); requested_by_user_id also names a person — the requester — and is a second thing an erase must consider.",
  },
  {
    table: "org_member_policy",
    scope: "member",
    column: "user_id",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
  },

  {
    table: "heartbeat",
    scope: "operational",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "one row per schedule name; liveness only.",
  },

  {
    table: "proactivity_settings",
    scope: "member",
    column: "owner",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
  },
  {
    table: "initiations",
    scope: "member",
    column: "owner",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
  },
  {
    table: "owner_clock_signals",
    scope: "member",
    column: "owner",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
  },

  {
    table: "deadlines",
    scope: "member",
    column: "owner",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
  },
  {
    table: "deadline_candidates",
    scope: "member",
    column: "owner",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
  },
  {
    table: "deadline_settings",
    scope: "member",
    column: "owner",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
  },


  {
    table: "ratchet_audit",
    scope: "member",
    column: "changed_by",
    idKind: "actor",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "conservative default: changed_by names whoever changed a permission level (an operator, 'unknown', or a member via the console) — an unsure call.",
  },
  {
    table: "approval_events",
    scope: "operational",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "what the approval policy decided for a tool call, keyed by agent and capability, not by a person.",
  },
  {
    table: "agent_registry",
    scope: "operational",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "an agent's own self-registration (grants, autonomy, skills, doors) — about the agent, not a member.",
  },

  {
    table: "agent_avatars",
    scope: "operational",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "the installation's agent identity image, keyed to agent_definitions rather than a member; reset explicitly or removed by the agent-definition deletion cascade.",
  },

  {
    table: "agent_definitions",
    scope: "operational",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "an agent's last-valid definition; about the agent, not a member.",
  },
  {
    table: "agent_doors",
    scope: "operational",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "per-agent door configuration (kind, enabled, secret_set_at); no person column.",
  },

  {
    table: "keeper_audit",
    scope: "member",
    column: "actor",
    idKind: "actor",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "conservative default: actor names whoever ran a privileged keeper operation — an unsure call.",
  },
  {
    table: "settings",
    scope: "member",
    column: "updated_by",
    idKind: "actor",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "conservative default: updated_by names whoever changed an installation setting — an unsure call.",
  },
  {
    table: "settings_audit",
    scope: "member",
    column: "changed_by",
    idKind: "actor",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "conservative default: changed_by names whoever changed an installation setting — an unsure call.",
  },

  {
    table: "agent_resources",
    scope: "operational",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "infrastructure ownership records (address, workflow database, state) for an agent, not a person.",
  },

  {
    table: "agent_conversations",
    scope: "operational",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "current-incarnation UI projection of which sessions exist; its own comment says 'No transcripts' — no person content.",
  },

  {
    table: "agent_door_connections",
    scope: "member",
    column: "principal",
    idKind: "principal",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "principal is set once the door is claimed; owner_email (the claim email) is a second, unenforced person-identifying column worth checking by hand.",
  },
  {
    table: "agent_door_claim_audit",
    scope: "member",
    column: "principal",
    idKind: "principal",
    createdBy: `${BOX}/001_baseline.sql`,
  },

  {
    table: "backup_status",
    scope: "operational",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "the installation's own backup/restore verification record; not about a person.",
  },

  {
    table: "brief_settings",
    scope: "member",
    column: "owner",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
  },

  {
    table: "conversation_entries",
    scope: "member",
    column: "person_key",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
  },

  {
    table: "conversation_retention",
    scope: "member",
    column: "owner",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
  },

  {
    table: "schema_migrations",
    scope: "operational",
    createdBy: `${BOX}/001_baseline.sql`,
    reason: "the migration runner's own ledger; pure system metadata.",
  },

  {
    table: "schedule_settings",
    scope: "member",
    column: "owner",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
  },

  {
    table: "agent_notes",
    scope: "member",
    column: "owner",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
  },

  {
    table: "memory_proposals",
    scope: "resolved",
    reachedBy: "a supersede/retire proposal resolves existing_id against standing_facts.id or dream_preferences.id and reads that row's own owner column; an add proposal has no existing row at all and resolves instead via ref, the deterministic hash the dream cycle derived from the observation's subject.",
    createdBy: `${BOX}/001_baseline.sql`,
  },

  {
    table: "memory_use",
    scope: "member",
    column: "owner",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
  },

  {
    table: "memory_reads",
    scope: "member",
    column: "owner",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
  },

  {
    table: "forget_ledger",
    scope: "member",
    column: "owner",
    idKind: "owner-key",
    createdBy: `${BOX}/001_baseline.sql`,
    reason:
      "THE LAST FREE-TEXT OWNER KEY, and deliberately so. `match_hash` is derived FROM this " +
      "owner string (`forgetKey(owner, kind, normalised)`, packages/vault-format/src/" +
      "forget-ledger.ts), and the forgotten words are not stored, so a hash can never be " +
      "re-derived: rewriting `owner` would turn every existing forget into a row that matches " +
      "nothing, silently. The migration that moved the other owner-keyed tables onto the register's id " +
      "skips this table for exactly that reason; NEW ledger rows are keyed on the register's id instead.",
  },

  {
    table: "repairs",
    scope: "operational",
    createdBy: `${BOX}/001_baseline.sql`,
    reason:
      "About the installation's running, not about a person: a dead credential, a stale generated " +
      "file, a backup that did not verify. `ref` holds a connection id, a capability name, a secret " +
      "file name or a schedule key — never a member id, and `what`/`how_to_fix` are engine-written " +
      "owner text, never a person's words.",
  },

  {
    table: "approval_asks",
    scope: "member",
    column: "acting_member_id",
    idKind: "registry",
    createdBy: `${BOX}/015_exact_approval_execution.sql`,
    reason: "Strict rows retain original actor and matching resolver metadata. Legacy rows have no actor and remain legacy evidence.",
  },

  {
    table: "outside_tool_pins",
    scope: "operational",
    createdBy: `${BOX}/001_baseline.sql`,
    reason:
      "About an outside tool server, not about a person: SHA-256 hashes (the entry's address and " +
      "allow-list, and the tool descriptions the server sent) keyed by agent and tool name, plus the " +
      "descriptions themselves as the server published them (names, descriptions and input schemas of " +
      "the allowed tools) so the owner can review a change. No address, no key and no member " +
      "id is stored.",
  },

  {
    table: "update_history",
    scope: "operational",
    createdBy: `${BOX}/001_baseline.sql`,
    reason:
      "About the installation's running, not about a person: which image digests were live " +
      "before an update, which migration it applied, and whether it finished. No secret either — " +
      "`images` holds only digest references, `snapshot_id` is an opaque restic label, never a " +
      "compose file or an env dump.",
  },

  {
    table: "keeper_credentials",
    scope: "operational",
    createdBy: `${BOX}/001_baseline.sql`,
    reason:
      "Installation credential operation metadata: named slot, opaque revisions, fixed test " +
      "outcomes and runtime consumer progress. No credential values, member identities or " +
      "person-authored content; actor attribution remains in keeper_audit.",
  },

  {
    table: "clipping_sources",
    scope: "member",
    column: "owner",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
    reason:
      "`owner` is the organisation (the literal 'organisation', the only organisation-wide value) or one " +
      "member's register id; a member's own source and its state are erased with them.",
  },
  {
    table: "clipping_items",
    scope: "member",
    column: "owner",
    idKind: "registry",
    createdBy: `${BOX}/001_baseline.sql`,
    reason:
      "Metadata only (a normalised link key, never the link or any text); `owner` is the " +
      "organisation or one member's register id, copied from the source, never from a page.",
  },

  {
    table: "clipping_requests",
    scope: "operational",
    createdBy: `${BOX}/001_baseline.sql`,
    reason:
      "A queue of console button presses (read a database, test, import, add columns) and their " +
      "secret-free answers: ids, column names and counts. `requested_by` names the console " +
      "administrator who pressed the button, an actor label, not a member's own content.",
  },
  {
    table: "clipping_choice",
    scope: "operational",
    createdBy: `${BOX}/001_baseline.sql`,
    reason:
      "One installation-wide setting row (which clipping source the digest reads). `set_by` is " +
      "the console administrator who changed it, an actor label, not a member's own content.",
  },

  // ── Not created by any services/box/sql migration — both carry an `owner`
  // column, so they are `member`/`registry`, not `resolved`. The column is
  // NULLABLE and carries no default (`services/chief-of-staff/lib/dream/store.ts`'s
  // `ensureDreamTables`): a row written before this column existed is NULL unless
  // `labelExistingDreamRows` labelled it as the
  // installation's one member, only ever done when the register held exactly one
  // person at the time. A NULL row is still this table's business, not a second convention: an
  // erase reads it as "the installation's own, from before this column existed", the same as any
  // other member row this inventory does not itself resolve down to a single spelling.
  {
    table: "dream_observations",
    scope: "member",
    column: "owner",
    idKind: "registry",
    createdBy: DREAM_STORE,
  },
  {
    table: "dream_preferences",
    scope: "member",
    column: "owner",
    idKind: "registry",
    createdBy: DREAM_STORE,
  },

  // ── The chief of staff's own store, created by services/box/sql/002_standing_facts.sql ──
  {
    table: "standing_facts",
    scope: "member",
    column: "user_id",
    idKind: "registry",
    createdBy: "services/box/sql/002_standing_facts.sql",
    reason: "the chief of staff's store of a person's own stated words, created by its own box migration so it is part of this inventory.",
  },

  // ── The web chat door's mailbox, created by services/box/sql/004_web_inbox.sql ──
  {
    table: "web_inbox",
    scope: "member",
    column: "owner",
    idKind: "registry",
    createdBy: `${BOX}/004_web_inbox.sql`,
    reason: "messages an agent wrote for one owner's web chat; `owner` is the same canonical id the proactivity ledger (`initiations.owner`) uses.",
  },

  // ── Per-model-call token counts, created by services/box/sql/005_model_steps.sql ──
  {
    table: "model_steps",
    scope: "operational",
    createdBy: `${BOX}/005_model_steps.sql`,
    reason: "token counts and ids for each model call, keyed by agent and session; no message text and no person column, pruned after 90 days.",
  },
];

export function scopeOf(table: string): ScopedTable | undefined {
  return MEMBER_SCOPE.find((t) => t.table === table);
}

/**
 * Every table created in `services/box/sql/*.sql`, read off disk.
 *
 * Matches `CREATE TABLE [IF NOT EXISTS] <name> (`, lower-cased and de-duplicated, excluding any
 * name containing a `.` (eve's `workflow.*` / `workflow_drizzle.*` schema — out of scope, see the
 * file header). The trailing `\(` is required, not cosmetic: several migrations' own comments
 * quote the phrase "CREATE TABLE IF NOT EXISTS" in prose (035/036/037's re-run-safety notes)
 * without a table name following it, and a regex that stops at the identifier alone reads the
 * word "IF" out of that prose as a phantom table.
 */
export function tablesInBoxSql(dir: string): string[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
  const names = new Set<string>();
  for (const file of files) {
    const bytes = readFileSync(join(dir, file), "utf8");
    const re = /CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_.]*)\s*\(/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(bytes))) {
      const name = m[1].toLowerCase();
      if (name.includes(".")) continue;
      names.add(name);
    }
  }
  return [...names].sort();
}
