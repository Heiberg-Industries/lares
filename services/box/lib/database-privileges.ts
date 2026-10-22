// The fixed privilege boundary for the engine database. This is an offline operator helper:
// callers pass an already-authenticated superuser client and deliberately confirm the target DB.
import type { PoolClient, QueryResultRow } from "pg";

const ROLE_MARKERS = {
  owner: "lares-engine-database-role:v1:owner",
  application: "lares-engine-database-role:v1:application",
  financial: "lares-engine-database-role:v1:financial",
} as const;

const OWNER = "lares_schema_owner";
const APPLICATION = "lares_app";
const FINANCIAL = "lares_financial";
const SCHEMA = "public";

const FINANCIAL_TABLES = [
  "budget_accounts",
  "budget_windows",
  "budget_gateway_bindings",
  "budget_attempts",
  "budget_gateway_grants",
  "budget_financial_checkpoints",
] as const;
const LEDGER_TABLES = ["schema_migrations"] as const;

/** Every migrated engine table appears exactly once in one of the three fixed classes. */
export const ENGINE_TABLE_PRIVILEGES = {
  ordinary: [
    "agent_avatars", "agent_conversations", "agent_definitions", "agent_door_claim_audit",
    "agent_door_connections", "agent_doors", "agent_notes", "agent_registry", "agent_resources", "agent_access",
    "approval_asks", "approval_events", "atlas_notes", "atlas_proposals", "audit", "backup_status",
    "brief_settings", "clipping_choice", "clipping_items", "clipping_requests", "clipping_sources",
    "confirmations", "connected_account_credentials", "connected_accounts", "connected_resource_bindings",
    "console_session_bindings", "console_vault_source_captures", "conversation_entries",
    "conversation_retention", "cross_member_grants", "cross_member_reads", "deadline_candidates",
    "deadline_settings", "deadlines", "digest_requests", "digest_skips", "dream_observations",
    "dream_preferences", "email_triage_processed", "email_watch_cursors", "forget_ledger",
    "heartbeat", "initiations", "keeper_audit", "keeper_credentials", "karakeep_seen",
    "meeting_followup_sent", "member_invitations", "member_provider_identities", "member_sessions",
    "memory_proposals", "memory_reads", "memory_use", "model_steps", "notion_sync_docs",
    "notion_sync_fidelity", "notion_sync_proposals", "notion_sync_run", "oauth_tokens",
    "obligation_threads", "org_member_policy", "orgs", "outside_tool_pins", "outreach_threads",
    "owner_clock_signals", "personal_action_calls", "personal_actions", "proactivity_settings",
    "ratchet", "ratchet_audit", "reminders", "repairs", "resource_grants", "route_cursor",
    "route_proposals", "schedule_settings", "sessions", "settings", "settings_audit",
    "standing_facts", "studio_runs", "telegram_daily_log", "telegram_session_rotation",
    "trigger_schedules", "update_history", "user_aliases", "users", "vault_areas",
    "vault_backing_stores", "voice_exemplar", "voice_profile", "web_inbox", "workflow_jobs",
  ],
  financial: FINANCIAL_TABLES,
  ledger: LEDGER_TABLES,
} as const;

/** Fixed role names shared by offline setup and other engine proof tooling. */
export const ENGINE_DATABASE_ROLES = { owner: OWNER, application: APPLICATION, financial: FINANCIAL } as const;

/** Exact engine-owned callable inventory; signatures use PostgreSQL identity argument types. */
export const ENGINE_FUNCTIONS = [
  "ratchet_audit_fn()", "settings_audit_fn()", "update_history_images_are_digests(jsonb)",
  "guard_vault_metadata()", "invalidate_member_vault_access()", "retire_vault_backing_areas()",
  "budget_live_identity_guard()", "budget_immutable()", "budget_account_guard()",
  "budget_member_policy_changed()", "budget_retire_member(text, boolean)", "budget_member_retirement()",
  "guard_member_owner()", "invalidate_member_agent_access()", "immutable_resource_grant()",
  "agent_access_changed()", "invalidate_member_policy_agent_access()", "invalidate_definition_agent_access()",
  "guard_console_session_binding()", "guard_exact_approval_authority()",
  "invalidate_personal_account_history()", "preserve_personal_action_call()", "guard_personal_action()",
  "validate_vault_resource_grant()", "guard_console_vault_source_capture()",
  "budget_invocation_insert_guard()", "budget_gateway_grant_immutable()",
  "budget_financial_checkpoint_immutable()", "guard_studio_run_owner()",
] as const;

/** Trigger identity is fixed by name, table, and function; no unknown binding is accepted. */
export const ENGINE_TRIGGER_BINDINGS = [
  ["ratchet_audit_trg", "ratchet", "ratchet_audit_fn()"],
  ["settings_audit_trg", "settings", "settings_audit_fn()"],
  ["vault_backing_guard", "vault_backing_stores", "guard_vault_metadata()"],
  ["vault_area_guard", "vault_areas", "guard_vault_metadata()"],
  ["member_vault_access_guard", "users", "invalidate_member_vault_access()"],
  ["vault_backing_retire", "vault_backing_stores", "retire_vault_backing_areas()"],
  ["budget_window_member", "budget_windows", "budget_live_identity_guard()"],
  ["budget_binding_member", "budget_gateway_bindings", "budget_live_identity_guard()"],
  ["budget_attempt_member", "budget_attempts", "budget_live_identity_guard()"],
  ["budget_window_immutable", "budget_windows", "budget_immutable()"],
  ["budget_binding_immutable", "budget_gateway_bindings", "budget_immutable()"],
  ["budget_attempt_immutable", "budget_attempts", "budget_immutable()"],
  ["budget_account_guard", "budget_accounts", "budget_account_guard()"],
  ["budget_member_cap_revision", "org_member_policy", "budget_member_policy_changed()"],
  ["budget_member_retirement", "users", "budget_member_retirement()"],
  ["users_member_owner_guard", "users", "guard_member_owner()"],
  ["agent_access_changed_guard", "agent_access", "agent_access_changed()"],
  ["immutable_resource_grant_guard", "resource_grants", "immutable_resource_grant()"],
  ["member_agent_access_guard", "users", "invalidate_member_agent_access()"],
  ["member_policy_agent_access_guard", "org_member_policy", "invalidate_member_policy_agent_access()"],
  ["definition_agent_access_guard", "agent_definitions", "invalidate_definition_agent_access()"],
  ["console_session_binding_guard", "console_session_bindings", "guard_console_session_binding()"],
  ["exact_approval_authority_guard", "approval_asks", "guard_exact_approval_authority()"],
  ["personal_account_history_guard", "connected_accounts", "invalidate_personal_account_history()"],
  ["personal_action_call_guard", "personal_action_calls", "preserve_personal_action_call()"],
  ["personal_action_guard", "personal_actions", "guard_personal_action()"],
  ["vault_resource_grant_guard", "resource_grants", "validate_vault_resource_grant()"],
  ["console_vault_source_guard", "console_vault_source_captures", "guard_console_vault_source_capture()"],
  ["budget_invocation_insert_guard", "budget_attempts", "budget_invocation_insert_guard()"],
  ["budget_gateway_grant_immutable", "budget_gateway_grants", "budget_gateway_grant_immutable()"],
  ["budget_financial_checkpoint_immutable", "budget_financial_checkpoints", "budget_financial_checkpoint_immutable()"],
  ["studio_runs_owner_guard", "studio_runs", "guard_studio_run_owner()"],
] as const;

/** PostgreSQL tgtype bits: fixed row/timing/event bindings are part of the privilege boundary. */
const ENGINE_TRIGGER_TYPES: Readonly<Record<string, number>> = {
  ratchet_audit_trg: 29, settings_audit_trg: 21, vault_backing_guard: 31, vault_area_guard: 31,
  member_vault_access_guard: 25, vault_backing_retire: 17, budget_window_member: 7,
  budget_binding_member: 7, budget_attempt_member: 7, budget_window_immutable: 27,
  budget_binding_immutable: 27, budget_attempt_immutable: 27, budget_account_guard: 31,
  budget_member_cap_revision: 29, budget_member_retirement: 27, users_member_owner_guard: 27,
  agent_access_changed_guard: 27, immutable_resource_grant_guard: 19, member_agent_access_guard: 17,
  member_policy_agent_access_guard: 31, definition_agent_access_guard: 17,
  console_session_binding_guard: 19, exact_approval_authority_guard: 19,
  personal_account_history_guard: 17, personal_action_call_guard: 27, personal_action_guard: 23,
  vault_resource_grant_guard: 7, console_vault_source_guard: 31, budget_invocation_insert_guard: 7,
  budget_gateway_grant_immutable: 27, budget_financial_checkpoint_immutable: 27, studio_runs_owner_guard: 23,
};
const ENGINE_TRIGGER_UPDATE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  personal_account_history_guard: ["generation", "status"],
  definition_agent_access_guard: ["hash", "status"],
  studio_runs_owner_guard: ["owner_member_id"],
};

const ENGINE_SEQUENCES = [
  "agent_door_claim_audit_id_seq", "agent_notes_id_seq", "approval_events_id_seq",
  "atlas_proposals_id_seq", "audit_id_seq", "cross_member_grants_id_seq", "cross_member_reads_id_seq",
  "forget_ledger_id_seq", "initiations_id_seq", "keeper_audit_id_seq", "memory_proposals_id_seq",
  "notion_sync_docs_id_seq", "notion_sync_proposals_id_seq", "ratchet_audit_id_seq", "settings_audit_id_seq",
  "update_history_id_seq", "vault_access_revision_seq", "resource_access_revision_seq",
  "standing_facts_id_seq", "web_inbox_id_seq", "schema_migrations_seq_seq",
] as const;

// Only sequences needed by ordinary inserts or invoker-security triggers reach online roles.
// GENERATED ALWAYS identities reject direct inserts without sequence privileges; the migration
// ledger sequence is operator-only. These are intentionally not inferred from ownership.
const ONLINE_SEQUENCE_USAGE = [
  "agent_notes_id_seq", "approval_events_id_seq", "audit_id_seq", "cross_member_grants_id_seq",
  "cross_member_reads_id_seq", "forget_ledger_id_seq", "initiations_id_seq", "keeper_audit_id_seq",
  "memory_proposals_id_seq", "notion_sync_docs_id_seq", "ratchet_audit_id_seq", "settings_audit_id_seq",
  "update_history_id_seq", "standing_facts_id_seq", "web_inbox_id_seq", "vault_access_revision_seq",
  "resource_access_revision_seq",
] as const;

const ENGINE_TYPES = ["budget_money"] as const;

const APP_FINANCIAL_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  budget_accounts: ["installation_cap", "selected_endpoint", "endpoint_generation", "recovery_epoch", "state", "reason", "policy_generation", "active_window_id", "live_member_id", "organisation_id"],
  budget_windows: ["live_member_id"],
  budget_gateway_bindings: ["state", "live_member_id", "agent", "incarnation", "native_team", "native_user", "purpose_alias", "key_fingerprint"],
  budget_attempts: ["state", "admitted_at", "actual_amount", "settlement_hash", "conflict_reason", "conflict_hash", "highest_observed_liability", "live_member_id", "authority_reference"],
  budget_gateway_grants: ["attempt_id"],
};

const FUNCTION_CALL_GRANTS = {
  application: ["update_history_images_are_digests(jsonb)"],
  financial: ["update_history_images_are_digests(jsonb)", "budget_retire_member(text, boolean)"],
} as const;

const safeFailure = (): Error => new Error("Database privilege setup could not be confirmed; inspect the database before retrying.");
const qid = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const qname = (name: string): string => `${qid(SCHEMA)}.${qid(name)}`;

function passwordText(value: Buffer): string {
  if (!Buffer.isBuffer(value) || value.length < 32 || value.length > 96) throw safeFailure();
  const decoded = value.toString("utf8");
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(decoded) || !Buffer.from(decoded, "utf8").equals(value)) throw safeFailure();
  return decoded;
}

async function queryRows<T extends QueryResultRow>(client: PoolClient, sql: string, values: unknown[] = []): Promise<T[]> {
  return (await client.query<T>(sql, values)).rows;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

async function requireInventory(client: PoolClient): Promise<void> {
  const expectedTables = [...ENGINE_TABLE_PRIVILEGES.ordinary, ...ENGINE_TABLE_PRIVILEGES.financial, ...ENGINE_TABLE_PRIVILEGES.ledger];
  if (new Set(expectedTables).size !== expectedTables.length || expectedTables.some((name) => !/^[a-z][a-z0-9_]*$/.test(name))) throw safeFailure();

  const relations = await queryRows<{ name: string; kind: string }>(client, `
    SELECT c.relname AS name, c.relkind AS kind
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f','S')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
  `, [SCHEMA]);
  const expectedRelationKinds = new Map<string, string>([
    ...expectedTables.map((name) => [name, "r"] as const),
    ...ENGINE_SEQUENCES.map((name) => [name, "S"] as const),
  ]);
  if (sorted(relations.map((relation) => relation.name)).join("\0") !== sorted([...expectedRelationKinds.keys()]).join("\0")) throw safeFailure();
  if (relations.some((relation) => expectedRelationKinds.get(relation.name) !== relation.kind)) throw safeFailure();

  const routines = await queryRows<{ identity: string; kind: string; securityDefiner: boolean }>(client, `
    SELECT p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS identity, p.prokind AS kind, p.prosecdef AS "securityDefiner"
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname=$1 AND NOT EXISTS (
       SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
  `, [SCHEMA]);
  if (sorted(routines.map((routine) => routine.identity)).join("\0") !== sorted(ENGINE_FUNCTIONS).join("\0") || routines.some((routine) => routine.kind !== "f" || routine.securityDefiner)) throw safeFailure();

  const types = await queryRows<{ name: string }>(client, `
    SELECT t.typname AS name FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
     WHERE n.nspname=$1 AND t.typtype IN ('d','e','r','m')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_type'::regclass AND d.objid=t.oid AND d.deptype='e')
  `, [SCHEMA]);
  if (sorted(types.map((type) => type.name)).join("\0") !== sorted(ENGINE_TYPES).join("\0")) throw safeFailure();

  const triggers = await queryRows<{ trigger: string; table: string; routine: string; functionSchema: string; enabled: string; triggerType: number; hasCondition: boolean; argumentCount: number; argumentBytes: number; updateColumns: string[]; constraintId: string; deferrable: boolean; initiallyDeferred: boolean }>(client, `
    SELECT t.tgname AS trigger, c.relname AS table,
           p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS routine, pns.nspname AS "functionSchema",
           t.tgenabled AS enabled, t.tgtype AS "triggerType", t.tgqual IS NOT NULL AS "hasCondition",
           t.tgnargs AS "argumentCount", COALESCE(octet_length(t.tgargs),0) AS "argumentBytes",
           ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum=ANY(t.tgattr) ORDER BY a.attname) AS "updateColumns",
           t.tgconstraint AS "constraintId", t.tgdeferrable AS deferrable, t.tginitdeferred AS "initiallyDeferred"
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pns ON pns.oid=p.pronamespace
     WHERE n.nspname=$1 AND NOT t.tgisinternal
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_trigger'::regclass AND d.objid=t.oid AND d.deptype='e')
  `, [SCHEMA]);
  const triggerKey = (item: { trigger: string; table: string; routine: string }) => `${item.trigger}\0${item.table}\0${item.routine}`;
  if (sorted(triggers.map(triggerKey)).join("\n") !== sorted(ENGINE_TRIGGER_BINDINGS.map(([trigger, table, routine]) => `${trigger}\0${table}\0${routine}`)).join("\n") || triggers.some((trigger) => {
    const expectedColumns = ENGINE_TRIGGER_UPDATE_COLUMNS[trigger.trigger] ?? [];
    return trigger.functionSchema !== SCHEMA || trigger.enabled !== "O" || ENGINE_TRIGGER_TYPES[trigger.trigger] !== trigger.triggerType ||
      trigger.hasCondition || trigger.argumentCount !== 0 || trigger.argumentBytes !== 0 || Number(trigger.constraintId) !== 0 || trigger.deferrable || trigger.initiallyDeferred ||
      sorted(trigger.updateColumns ?? []).join("\0") !== sorted(expectedColumns).join("\0");
  })) throw safeFailure();

  const rules = await queryRows<{ name: string }>(client, `
    SELECT r.rulename AS name FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND r.rulename <> '_RETURN'
  `, [SCHEMA]);
  if (rules.length !== 0) throw safeFailure();

  const defaults = await queryRows(client, `SELECT 1 FROM pg_default_acl WHERE defaclnamespace IN (0, (SELECT oid FROM pg_namespace WHERE nspname=$1)) LIMIT 1`, [SCHEMA]);
  if (defaults.length !== 0) throw safeFailure();

  const schemas = await queryRows(client, `
    SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public','pg_catalog','information_schema','pg_toast')
      AND nspname !~ '^pg_toast_[0-9]+$' AND nspname !~ '^pg_temp_[0-9]+$' AND nspname !~ '^pg_toast_temp_[0-9]+$' LIMIT 1
  `);
  if (schemas.length) throw safeFailure();

  const unknownTypes = await queryRows(client, `
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
     WHERE n.nspname=$1 AND t.typtype IN ('b','c','d','e','r','m')
       AND t.typelem=0 AND (t.typrelid=0 OR EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=t.typrelid AND c.relkind='c'))
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_type'::regclass AND d.objid=t.oid AND d.deptype='e')
       AND t.typname <> ALL($2::text[]) LIMIT 1
  `, [SCHEMA, ENGINE_TYPES]);
  if (unknownTypes.length) throw safeFailure();
}

async function requireRoleState(client: PoolClient): Promise<"fresh" | "managed"> {
  const rows = await queryRows<{ rolname: string; rolsuper: boolean; rolinherit: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolcanlogin: boolean; rolreplication: boolean; rolbypassrls: boolean; rolconfig: string[] | null; rolvaliduntil: Date | null; comment: string | null }>(client, `
    SELECT r.rolname, r.rolsuper, r.rolinherit, r.rolcreaterole, r.rolcreatedb, r.rolcanlogin,
           r.rolreplication, r.rolbypassrls, r.rolconfig, r.rolvaliduntil, d.description AS comment
      FROM pg_roles r LEFT JOIN pg_shdescription d ON d.objoid=r.oid AND d.classoid='pg_authid'::regclass
     WHERE r.rolname = ANY($1::text[])
  `, [[OWNER, APPLICATION, FINANCIAL]]);
  if (rows.length === 0) return "fresh";
  if (rows.length !== 3) throw safeFailure();
  for (const row of rows) {
    const expectedMarker = row.rolname === OWNER ? ROLE_MARKERS.owner : row.rolname === APPLICATION ? ROLE_MARKERS.application : ROLE_MARKERS.financial;
    const owner = row.rolname === OWNER;
    if (row.comment !== expectedMarker || row.rolsuper || row.rolcreaterole || row.rolcreatedb || row.rolreplication || row.rolbypassrls || row.rolcanlogin !== !owner || row.rolinherit || row.rolconfig !== null || row.rolvaliduntil !== null) throw safeFailure();
  }
  const memberships = await queryRows(client, `SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles g ON g.oid=m.member WHERE r.rolname=ANY($1::text[]) OR g.rolname=ANY($1::text[]) LIMIT 1`, [[OWNER, APPLICATION, FINANCIAL]]);
  if (memberships.length !== 0) throw safeFailure();
  return "managed";
}

async function requireOnlyExpectedGrants(client: PoolClient): Promise<void> {
  // Before the first run PostgreSQL grants CONNECT/TEMP on a database and USAGE/CREATE on public
  // to PUBLIC. Table ACLs have no public grants; functions have PostgreSQL's default PUBLIC EXECUTE.
  const badTableAcl = await queryRows(client, `
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) a
     WHERE n.nspname=$1 AND c.relkind IN ('r','p','S')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
       AND a.grantee <> c.relowner
       AND NOT EXISTS (SELECT 1 FROM pg_roles g WHERE g.oid=a.grantee AND g.rolname=ANY($2::text[]))
     LIMIT 1
  `, [SCHEMA, [OWNER, APPLICATION, FINANCIAL]]);
  if (badTableAcl.length !== 0) throw safeFailure();

  const foreignRoutineAcl = await queryRows(client, `
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f'::"char",p.proowner))) a
     WHERE n.nspname=$1 AND a.grantee <> p.proowner AND a.grantee <> 0
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
       AND NOT EXISTS (SELECT 1 FROM pg_roles g WHERE g.oid=a.grantee AND g.rolname=ANY($2::text[]))
     LIMIT 1
  `, [SCHEMA, [OWNER, APPLICATION, FINANCIAL]]);
  if (foreignRoutineAcl.length !== 0) throw safeFailure();

  const unexpectedGrantOptions = await queryRows(client, `
    SELECT 1 FROM (
      SELECT a.is_grantable, a.grantee, c.relowner AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) a
       WHERE n.nspname=$1 AND c.relkind IN ('r','p','S') AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
      UNION ALL
      SELECT a.is_grantable, a.grantee, p.proowner AS owner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f'::"char",p.proowner))) a WHERE n.nspname=$1 AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
    ) x WHERE x.is_grantable AND x.grantee <> x.owner LIMIT 1
  `, [SCHEMA]);
  if (unexpectedGrantOptions.length !== 0) throw safeFailure();

  const foreignTypeAcl = await queryRows(client, `
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(t.typacl,acldefault('T'::"char",t.typowner))) a
     WHERE n.nspname=$1 AND a.grantee<>t.typowner AND a.grantee<>0
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_type'::regclass AND d.objid=t.oid AND d.deptype='e')
       AND NOT EXISTS (SELECT 1 FROM pg_roles g WHERE g.oid=a.grantee AND g.rolname=ANY($2::text[])) LIMIT 1
  `,[SCHEMA,[OWNER,APPLICATION,FINANCIAL]]);
  if (foreignTypeAcl.length) throw safeFailure();

  const publicTableAcl = await queryRows(client, `
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) a
     WHERE n.nspname=$1 AND c.relkind IN ('r','p','S') AND a.grantee=0 LIMIT 1
  `,[SCHEMA]);
  const publicColumnAcl = await queryRows(client, `
    SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN LATERAL aclexplode(NULLIF(a.attacl,'{}'::aclitem[])) x
     WHERE n.nspname=$1 AND a.attnum>0 AND NOT a.attisdropped AND x.grantee=0 LIMIT 1
  `,[SCHEMA]);
  const foreignColumnAcl = await queryRows(client, `
    SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN LATERAL aclexplode(NULLIF(a.attacl,'{}'::aclitem[])) x
     WHERE n.nspname=$1 AND a.attnum>0 AND NOT a.attisdropped AND x.grantee<>0
       AND NOT EXISTS (SELECT 1 FROM pg_roles g WHERE g.oid=x.grantee AND g.rolname=ANY($2::text[]))
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e') LIMIT 1
  `,[SCHEMA,[OWNER,APPLICATION,FINANCIAL]]);
  if (publicTableAcl.length || publicColumnAcl.length || foreignColumnAcl.length) throw safeFailure();
}

async function requireBootstrapState(client: PoolClient, database: string): Promise<void> {
  const dbAcl = await queryRows<{ grantee: string; privilege: string; grantable: boolean }>(client, `
    SELECT COALESCE(r.rolname,'PUBLIC') AS grantee,a.privilege_type AS privilege,a.is_grantable AS grantable
      FROM pg_database d CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl,acldefault('d'::"char",d.datdba))) a
      LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE d.datname=$1 AND a.grantee<>d.datdba
  `,[database]);
  if (dbAcl.some((a) => a.grantable || a.grantee!=="PUBLIC" || !["CONNECT","TEMPORARY"].includes(a.privilege)) ||
      !dbAcl.some((a) => a.grantee==="PUBLIC" && a.privilege==="CONNECT") || !dbAcl.some((a) => a.grantee==="PUBLIC" && a.privilege==="TEMPORARY")) throw safeFailure();
  const schemaAcl = await queryRows<{ grantee: string; privilege: string; grantable: boolean }>(client, `
    SELECT COALESCE(r.rolname,'PUBLIC') AS grantee,a.privilege_type AS privilege,a.is_grantable AS grantable
      FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n'::"char",n.nspowner))) a
      LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE n.nspname=$1 AND a.grantee<>n.nspowner
  `,[SCHEMA]);
  if (schemaAcl.some((a) => a.grantable || a.grantee!=="PUBLIC" || a.privilege!=="USAGE") || !schemaAcl.some((a) => a.grantee==="PUBLIC" && a.privilege==="USAGE")) throw safeFailure();

  const schemaOwner = await queryRows<{ owner: string; databaseOwner: string }>(client, `
    SELECT owner.rolname AS owner, dbowner.rolname AS "databaseOwner"
      FROM pg_namespace n JOIN pg_roles owner ON owner.oid=n.nspowner
      JOIN pg_database d ON d.datname=$2 JOIN pg_roles dbowner ON dbowner.oid=d.datdba
     WHERE n.nspname=$1
  `,[SCHEMA,database]);
  if (!schemaOwner.length || !["pg_database_owner", schemaOwner[0].databaseOwner, (await queryRows<{ name: string }>(client,"SELECT current_user AS name"))[0]?.name].includes(schemaOwner[0].owner)) throw safeFailure();

  const unknownOwner = await queryRows(client, `
    WITH allowed AS (
      SELECT current_user::text AS name UNION SELECT r.rolname FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=$1 UNION SELECT 'pg_database_owner'
    ), owners AS (
      SELECT r.rolname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname=$2 AND c.relkind IN ('r','p','S')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
      UNION SELECT r.rolname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname=$2
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
      UNION SELECT r.rolname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_roles r ON r.oid=t.typowner
        WHERE n.nspname=$2 AND t.typrelid=0 AND t.typelem=0 AND t.typtype IN ('b','c','d','e','r','m')
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_type'::regclass AND d.objid=t.oid AND d.deptype='e')
    ) SELECT 1 FROM owners o WHERE NOT EXISTS (SELECT 1 FROM allowed a WHERE a.name=o.name) LIMIT 1
  `,[database,SCHEMA]);
  if (unknownOwner.length) throw safeFailure();
}

function expectedAclKey(grantee: string, privilege: string): string { return `${grantee}\0${privilege}`; }

async function requireAcl(
  client: PoolClient,
  sql: string,
  values: unknown[],
  expected: readonly string[],
): Promise<void> {
  const rows = await queryRows<{ grantee: string; privilege: string; grantable: boolean }>(client, sql, values);
  if (rows.some((row) => row.grantable)) throw safeFailure();
  const actual = sorted(rows.map((row) => expectedAclKey(row.grantee, row.privilege)));
  if (actual.join("\n") !== sorted(expected).join("\n")) throw safeFailure();
}

async function requireManagedState(client: PoolClient, database: string): Promise<void> {
  const badOwners = await queryRows(client, `
    SELECT 1 FROM (
      SELECT r.rolname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname=$1 AND c.relkind IN ('r','p','S') AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
      UNION ALL SELECT r.rolname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname=$1 AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
      UNION ALL SELECT r.rolname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_roles r ON r.oid=t.typowner WHERE n.nspname=$1 AND t.typname=ANY($2::text[])
    ) x WHERE x.rolname<>$3 LIMIT 1
  `,[SCHEMA,ENGINE_TYPES,OWNER]);
  const [databaseOwner] = await queryRows<{ name: string }>(client,`SELECT r.rolname AS name FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=$1`,[database]);
  const [schemaOwner] = await queryRows<{ name: string }>(client,`SELECT r.rolname AS name FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE n.nspname=$1`,[SCHEMA]);
  if (badOwners.length || databaseOwner?.name!==OWNER || schemaOwner?.name!==OWNER) throw safeFailure();
  const managedRoleOwnership = await queryRows(client, `
    SELECT 1 FROM pg_shdepend s JOIN pg_roles r ON r.oid=s.refobjid
     WHERE s.refclassid='pg_authid'::regclass AND r.rolname=ANY($1::text[])
       AND s.deptype='o' AND r.rolname<>$2 LIMIT 1
  `,[[APPLICATION,FINANCIAL],OWNER]);
  if (managedRoleOwnership.length) throw safeFailure();
  const unexpectedAclAuthority = await queryRows(client, `
    SELECT 1 FROM pg_shdepend s JOIN pg_roles grantee ON grantee.oid=s.refobjid
      LEFT JOIN pg_database db ON db.oid=s.objid AND s.classid='pg_database'::regclass
      LEFT JOIN pg_namespace ns ON ns.oid=s.objid AND s.classid='pg_namespace'::regclass
      LEFT JOIN pg_class c ON c.oid=s.objid AND s.classid='pg_class'::regclass
      LEFT JOIN pg_proc p ON p.oid=s.objid AND s.classid='pg_proc'::regclass
      LEFT JOIN pg_type t ON t.oid=s.objid AND s.classid='pg_type'::regclass
     WHERE s.refclassid='pg_authid'::regclass AND grantee.rolname=ANY($1::text[]) AND s.deptype='a'
       AND NOT (
         grantee.rolname=ANY($2::text[]) AND (
           (s.classid='pg_database'::regclass AND db.datname=$3 AND s.dbid IN (0,(SELECT oid FROM pg_database WHERE datname=$3)))
           OR (s.dbid=(SELECT oid FROM pg_database WHERE datname=$3) AND (
             (s.classid='pg_namespace'::regclass AND ns.nspname=$4)
             OR (s.classid='pg_class'::regclass AND c.relnamespace=(SELECT oid FROM pg_namespace WHERE nspname=$4) AND c.relname=ANY($5::text[]))
             OR (s.classid='pg_proc'::regclass AND (
               (p.pronamespace=(SELECT oid FROM pg_namespace WHERE nspname=$4) AND p.proname || '(' || oidvectortypes(p.proargtypes) || ')'=ANY($6::text[]))
               OR (p.oid='pg_catalog.pg_control_system()'::regprocedure)
             ))
             OR (s.classid='pg_type'::regclass AND t.typnamespace=(SELECT oid FROM pg_namespace WHERE nspname=$4) AND t.typname='budget_money')
           ))
         )
       ) LIMIT 1
  `,[[APPLICATION,FINANCIAL],[APPLICATION,FINANCIAL],database,SCHEMA,[...ENGINE_TABLE_PRIVILEGES.ordinary,...ENGINE_TABLE_PRIVILEGES.financial,...ENGINE_TABLE_PRIVILEGES.ledger,...ENGINE_SEQUENCES],ENGINE_FUNCTIONS]);
  if (unexpectedAclAuthority.length) throw safeFailure();
  await requireManagedAcls(client,database);
}

async function requireManagedAcls(client: PoolClient, database: string): Promise<void> {
  const dbAcl = `SELECT COALESCE(r.rolname,'PUBLIC') AS grantee, a.privilege_type AS privilege, a.is_grantable AS grantable
    FROM pg_database d CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl,acldefault('d'::"char",d.datdba))) a
    LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE d.datname=$1 AND a.grantee<>d.datdba`;
  await requireAcl(client, dbAcl, [database], [expectedAclKey(APPLICATION,"CONNECT"),expectedAclKey(FINANCIAL,"CONNECT")]);
  const schemaAcl = `SELECT COALESCE(r.rolname,'PUBLIC') AS grantee, a.privilege_type AS privilege, a.is_grantable AS grantable
    FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n'::"char",n.nspowner))) a
    LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE n.nspname=$1 AND a.grantee<>n.nspowner`;
  await requireAcl(client, schemaAcl, [SCHEMA], [expectedAclKey(APPLICATION,"USAGE"),expectedAclKey(FINANCIAL,"USAGE")]);

  for (const table of [...ENGINE_TABLE_PRIVILEGES.ordinary, ...ENGINE_TABLE_PRIVILEGES.financial, ...ENGINE_TABLE_PRIVILEGES.ledger]) {
    const ordinary = (ENGINE_TABLE_PRIVILEGES.ordinary as readonly string[]).includes(table);
    const expected: string[] = [];
    if (ordinary) for (const role of [APPLICATION, FINANCIAL]) for (const privilege of ["SELECT","INSERT","UPDATE","DELETE"]) expected.push(expectedAclKey(role,privilege));
    else if ((FINANCIAL_TABLES as readonly string[]).includes(table)) for (const privilege of ["SELECT","INSERT"]) expected.push(expectedAclKey(FINANCIAL,privilege));
    const tableAcl = `SELECT COALESCE(r.rolname,'PUBLIC') AS grantee, a.privilege_type AS privilege, a.is_grantable AS grantable
      FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r'::"char",c.relowner))) a
      LEFT JOIN pg_roles r ON r.oid=a.grantee JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND a.grantee<>c.relowner`;
    await requireAcl(client, tableAcl, [SCHEMA,table], expected);
    const columnNames = await queryRows<{ name: string }>(client, `SELECT a.attname AS name FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped`, [SCHEMA,table]);
    for (const column of columnNames) {
      const allowed = (APP_FINANCIAL_COLUMNS[table] ?? []).includes(column.name);
      const columnAcl = `SELECT COALESCE(r.rolname,'PUBLIC') AS grantee, x.privilege_type AS privilege, x.is_grantable AS grantable
        FROM pg_attribute a CROSS JOIN LATERAL aclexplode(NULLIF(a.attacl,'{}'::aclitem[])) x
        LEFT JOIN pg_roles r ON r.oid=x.grantee JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relname=$2 AND a.attname=$3`;
      await requireAcl(client,columnAcl,[SCHEMA,table,column.name],allowed?[expectedAclKey(FINANCIAL,"UPDATE")]:[]);
    }
  }

  for (const sequence of ENGINE_SEQUENCES) {
    const sequenceAcl = `SELECT COALESCE(r.rolname,'PUBLIC') AS grantee, a.privilege_type AS privilege, a.is_grantable AS grantable
      FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('s'::"char",c.relowner))) a
      LEFT JOIN pg_roles r ON r.oid=a.grantee JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind='S' AND a.grantee<>c.relowner`;
    const expected = (ONLINE_SEQUENCE_USAGE as readonly string[]).includes(sequence)
      ? [expectedAclKey(APPLICATION,"USAGE"),expectedAclKey(FINANCIAL,"USAGE")]
      : [];
    await requireAcl(client,sequenceAcl,[SCHEMA,sequence],expected);
  }
  for (const fn of ENGINE_FUNCTIONS) {
    const allowed: string[] = [];
    if ((FUNCTION_CALL_GRANTS.application as readonly string[]).includes(fn)) allowed.push(expectedAclKey(APPLICATION,"EXECUTE"));
    if ((FUNCTION_CALL_GRANTS.financial as readonly string[]).includes(fn)) allowed.push(expectedAclKey(FINANCIAL,"EXECUTE"));
    const name = fn.slice(0,fn.indexOf("("));
    const args = fn.slice(fn.indexOf("(")+1,-1);
    const routineAcl = `SELECT COALESCE(r.rolname,'PUBLIC') AS grantee, a.privilege_type AS privilege, a.is_grantable AS grantable
      FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f'::"char",p.proowner))) a
      LEFT JOIN pg_roles r ON r.oid=a.grantee JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=$1 AND p.proname=$2 AND oidvectortypes(p.proargtypes)=$3 AND a.grantee<>p.proowner`;
    await requireAcl(client,routineAcl,[SCHEMA,name,args],allowed);
  }
  await requireAcl(client,`SELECT COALESCE(r.rolname,'PUBLIC') AS grantee,a.privilege_type AS privilege,a.is_grantable AS grantable
    FROM pg_type t CROSS JOIN LATERAL aclexplode(COALESCE(t.typacl,acldefault('T'::"char",t.typowner))) a
    LEFT JOIN pg_roles r ON r.oid=a.grantee JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=$1 AND t.typname='budget_money' AND a.grantee<>t.typowner`,
    [SCHEMA],[expectedAclKey(APPLICATION,"USAGE"),expectedAclKey(FINANCIAL,"USAGE")]);
  const controlAcl = `SELECT COALESCE(r.rolname,'PUBLIC') AS grantee,a.privilege_type AS privilege,a.is_grantable AS grantable
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f'::"char",p.proowner))) a
    LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE p.oid='pg_catalog.pg_control_system()'::regprocedure AND a.grantee<>p.proowner`;
  await requireAcl(client,controlAcl,[],[expectedAclKey(FINANCIAL,"EXECUTE")]);

  const unsafeSettings = await queryRows(client, `
    SELECT 1 FROM pg_db_role_setting s LEFT JOIN pg_database d ON d.oid=s.setdatabase
     WHERE (s.setdatabase=0 OR d.datname=$2) AND (s.setrole=0 OR s.setrole IN (SELECT oid FROM pg_roles WHERE rolname=ANY($1::text[])))
     LIMIT 1
  `,[[OWNER,APPLICATION,FINANCIAL],database]);
  if (unsafeSettings.length) throw safeFailure();
  const parameterAcl = await queryRows(client, `
    SELECT 1 FROM pg_parameter_acl p CROSS JOIN LATERAL aclexplode(NULLIF(p.paracl,'{}'::aclitem[])) a
     WHERE p.parname='session_replication_role' AND a.grantee=ANY(ARRAY[0::oid,(SELECT oid FROM pg_roles WHERE rolname=$1),(SELECT oid FROM pg_roles WHERE rolname=$2),(SELECT oid FROM pg_roles WHERE rolname=$3)]) LIMIT 1
  `,[OWNER,APPLICATION,FINANCIAL]);
  if (parameterAcl.length) throw safeFailure();
}

async function applyGrants(client: PoolClient): Promise<void> {
  const database = (await queryRows<{ name: string }>(client, "SELECT current_database() AS name"))[0]!.name;
  await client.query(`GRANT CONNECT ON DATABASE ${qid(database)} TO ${qid(APPLICATION)}, ${qid(FINANCIAL)}`);
  await client.query(`REVOKE ALL ON SCHEMA ${qid(SCHEMA)} FROM PUBLIC`);
  await client.query(`GRANT USAGE ON SCHEMA ${qid(SCHEMA)} TO ${qid(APPLICATION)}, ${qid(FINANCIAL)}`);

  for (const table of ENGINE_TABLE_PRIVILEGES.ordinary) {
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${qname(table)} TO ${qid(APPLICATION)}, ${qid(FINANCIAL)}`);
  }
  for (const table of ENGINE_TABLE_PRIVILEGES.financial) {
    await client.query(`GRANT SELECT, INSERT ON TABLE ${qname(table)} TO ${qid(FINANCIAL)}`);
    const columns = APP_FINANCIAL_COLUMNS[table];
    if (columns?.length) await client.query(`GRANT UPDATE (${columns.map(qid).join(", ")}) ON TABLE ${qname(table)} TO ${qid(FINANCIAL)}`);
  }
  for (const sequence of ONLINE_SEQUENCE_USAGE) {
    await client.query(`GRANT USAGE ON SEQUENCE ${qname(sequence)} TO ${qid(APPLICATION)}, ${qid(FINANCIAL)}`);
  }
  for (const sequence of ENGINE_SEQUENCES.filter((name) => !(ONLINE_SEQUENCE_USAGE as readonly string[]).includes(name))) {
    await client.query(`REVOKE ALL ON SEQUENCE ${qname(sequence)} FROM PUBLIC, ${qid(APPLICATION)}, ${qid(FINANCIAL)}`);
  }
  await client.query(`REVOKE ALL ON TYPE ${qname("budget_money")} FROM PUBLIC`);
  await client.query(`GRANT USAGE ON TYPE ${qname("budget_money")} TO ${qid(APPLICATION)}, ${qid(FINANCIAL)}`);
  for (const fn of ENGINE_FUNCTIONS) await client.query(`REVOKE EXECUTE ON FUNCTION ${qname(fn.slice(0, fn.indexOf("(")))}${fn.slice(fn.indexOf("("))} FROM PUBLIC`);
  for (const fn of FUNCTION_CALL_GRANTS.application) await client.query(`GRANT EXECUTE ON FUNCTION ${qname(fn.slice(0, fn.indexOf("(")))}${fn.slice(fn.indexOf("("))} TO ${qid(APPLICATION)}`);
  for (const fn of FUNCTION_CALL_GRANTS.financial) await client.query(`GRANT EXECUTE ON FUNCTION ${qname(fn.slice(0, fn.indexOf("(")))}${fn.slice(fn.indexOf("("))} TO ${qid(FINANCIAL)}`);
  await client.query(`REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM PUBLIC`);
  await client.query(`GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ${qid(FINANCIAL)}`);
  await client.query(`REVOKE ALL ON TABLE ${qname("schema_migrations")} FROM ${qid(APPLICATION)}, ${qid(FINANCIAL)}`);
  for (const table of ENGINE_TABLE_PRIVILEGES.ledger) await client.query(`REVOKE ALL ON TABLE ${qname(table)} FROM ${qid(APPLICATION)}, ${qid(FINANCIAL)}`);
}

/**
 * Apply or verify the fixed database privilege foundation using an already-open superuser client.
 * Passwords are used only when the three fixed roles are first created. Reverification checks
 * managed role identity and privileges; it cannot prove that the supplied password authenticates.
 */
export async function provisionEngineDatabasePrivileges(
  operator: PoolClient,
  input: { expectedDatabase: string; passwords: { application: Buffer; financial: Buffer } },
): Promise<{ status: "applied" | "verified" }> {
  let inTransaction = false;
  try {
    const appPassword = passwordText(input.passwords.application);
    const financialPassword = passwordText(input.passwords.financial);
    await operator.query("BEGIN");
    inTransaction = true;
    const identity = (await queryRows<{ database: string; superuser: boolean }>(operator, `SELECT current_database() AS database, r.rolsuper AS superuser FROM pg_roles r WHERE r.rolname=current_user`))[0];
    if (!identity?.superuser || identity.database !== input.expectedDatabase) throw safeFailure();
    await requireInventory(operator);
    const roleState = await requireRoleState(operator);
    await requireOnlyExpectedGrants(operator);

    if (roleState === "fresh") await requireBootstrapState(operator, identity.database);
    if (roleState === "managed") {
      await requireManagedState(operator, identity.database);
      await operator.query("COMMIT");
      inTransaction = false;
      return { status: "verified" };
    }

    if (roleState === "fresh") {
      for (const [name, marker, login, password] of [
        [OWNER, ROLE_MARKERS.owner, false, null],
        [APPLICATION, ROLE_MARKERS.application, true, appPassword],
        [FINANCIAL, ROLE_MARKERS.financial, true, financialPassword],
      ] as const) {
        const passwordClause = password === null ? "" : ` PASSWORD '${password}'`;
        await operator.query(`CREATE ROLE ${qid(name)} ${login ? "LOGIN" : "NOLOGIN"} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS${passwordClause}`);
        await operator.query("COMMENT ON ROLE " + qid(name) + " IS '" + marker + "'");
      }
    }

    const database = qid(identity.database);
    await operator.query(`REVOKE CONNECT, TEMP ON DATABASE ${database} FROM PUBLIC`);
    await operator.query(`GRANT CONNECT ON DATABASE ${database} TO ${qid(APPLICATION)}, ${qid(FINANCIAL)}`);
    await operator.query(`ALTER DATABASE ${database} OWNER TO ${qid(OWNER)}`);
    await operator.query(`ALTER SCHEMA ${qid(SCHEMA)} OWNER TO ${qid(OWNER)}`);
    for (const table of [...ENGINE_TABLE_PRIVILEGES.ordinary, ...ENGINE_TABLE_PRIVILEGES.financial, ...ENGINE_TABLE_PRIVILEGES.ledger]) {
      await operator.query(`ALTER TABLE ${qname(table)} OWNER TO ${qid(OWNER)}`);
    }
    for (const sequence of ENGINE_SEQUENCES) await operator.query(`ALTER SEQUENCE ${qname(sequence)} OWNER TO ${qid(OWNER)}`);
    for (const fn of ENGINE_FUNCTIONS) await operator.query(`ALTER FUNCTION ${qname(fn.slice(0, fn.indexOf("(")))}${fn.slice(fn.indexOf("("))} OWNER TO ${qid(OWNER)}`);
    await operator.query(`ALTER DOMAIN ${qname("budget_money")} OWNER TO ${qid(OWNER)}`);
    await applyGrants(operator);

    // Catch unexpected ownership/role drift before committing. Owner-managed objects remain NOLOGIN.
    const nonOwnerRelations = await queryRows(operator, `
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
       WHERE n.nspname=$1 AND c.relkind IN ('r','p','S') AND r.rolname<>$2 LIMIT 1
    `, [SCHEMA, OWNER]);
    const databaseOwner = await queryRows<{ name: string }>(operator, `SELECT r.rolname AS name FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=current_database()`);
    if (nonOwnerRelations.length !== 0 || databaseOwner[0]?.name !== OWNER) throw safeFailure();
    await requireManagedState(operator, identity.database);
    await operator.query("COMMIT");
    inTransaction = false;
    return { status: roleState === "fresh" ? "applied" : "verified" };
  } catch {
    if (inTransaction) {
      try { await operator.query("ROLLBACK"); } catch { /* Preserve the fixed safe failure. */ }
    }
    throw safeFailure();
  }
}
