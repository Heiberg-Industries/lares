import type { Queryable } from "./db.js";

const RUNTIME = "lares_workflow";
const PROVISIONER = "lares_workflow_provisioner";
const SCHEMAS = ["workflow", "workflow_drizzle", "graphile_worker"] as const;
const WORKFLOW_DML = [
  "workflow_event_slots", "workflow_events", "workflow_hooks", "workflow_runs",
  "workflow_steps", "workflow_stream_chunks", "workflow_waits",
] as const;
const GRAPHILE_DML = [
  "_private_job_queues", "_private_jobs", "_private_known_crontabs", "_private_tasks",
] as const;
const GRAPHILE_RLS = GRAPHILE_DML;
const GRAPHILE_SEQUENCES = ["job_queues_id_seq", "jobs_id_seq1", "tasks_id_seq"] as const;
const GRAPHILE_FUNCTIONS = [
  "add_job(text,json,text,timestamptz,integer,text,integer,text[],text)",
  "add_jobs(graphile_worker.job_spec[],boolean)",
  "force_unlock_workers(text[])",
] as const;
const GRAPHILE_FUNCTION_INVENTORY = [
  ...GRAPHILE_FUNCTIONS,
  "complete_jobs(bigint[])",
  "permanently_fail_jobs(bigint[],text)",
  "remove_job(text)",
  "reschedule_jobs(bigint[],timestamptz,integer,integer,integer)",
] as const;
const TYPES = [
  "workflow.status", "workflow.step_status", "workflow.wait_status", "graphile_worker.job_spec",
] as const;

function quoteIdent(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
function relation(schema: string, name: string): string { return `${quoteIdent(schema)}.${quoteIdent(name)}`; }

/**
 * Grants the fixed workflow runtime ACL to a newly migrated template, or to a new per-agent
 * database cloned from it. Caller must prove that this database is newly created and owned by
 * lares_workflow_owner before applying. It never creates roles, changes ownership, or grants
 * schema CREATE, database CREATE/TEMP, or other object DDL authority.
 */
export async function applyWorkflowRuntimePrivileges(db: Queryable): Promise<void> {
  const identity = await db.query<{ database: string }>("SELECT current_database() AS database");
  const database = identity.rows[0]?.database;
  if (!database) throw new Error("Workflow database identity is unavailable");
  const existingPolicies = await db.query<{ schema: string; table: string; name: string | null; roles: string[] | null; command: string | null; permissive: string | null; predicate: string | null; check_expression: string | null; enabled: boolean; forced: boolean }>(`
    SELECT n.nspname AS schema,c.relname AS table,p.policyname AS name,p.roles::text[] AS roles,p.cmd AS command,p.permissive,
      p.qual AS predicate,p.with_check AS check_expression,c.relrowsecurity AS enabled,c.relforcerowsecurity AS forced
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_policies p ON p.schemaname=n.nspname AND p.tablename=c.relname
    WHERE n.nspname='graphile_worker' AND c.relname=ANY($1::text[])
  `, [[...GRAPHILE_RLS]]);
  const knownPolicyKeys = new Set(GRAPHILE_RLS.map((table) => `graphile_worker.${table}.runtime_${table}`));
  if (existingPolicies.rows.length < GRAPHILE_RLS.length || existingPolicies.rows.some((row) => !row.enabled || row.forced || row.name !== null &&
      (!knownPolicyKeys.has(`${row.schema}.${row.table}.${row.name}`) || row.name !== `runtime_${row.table}` || row.roles?.length !== 1 || row.roles[0] !== RUNTIME || row.command !== "ALL" || row.permissive !== "PERMISSIVE" || !isTrueExpression(row.predicate) || !isTrueExpression(row.check_expression)))) {
    throw new Error("Workflow database contains unknown or incomplete queue row policies");
  }
  const policyInventory = await db.query<{ schema: string; table: string; name: string }>(`SELECT schemaname AS schema,tablename AS table,policyname AS name FROM pg_policies WHERE schemaname=ANY($1::text[])`, [[...SCHEMAS]]);
  if (policyInventory.rows.some((row) => !knownPolicyKeys.has(`${row.schema}.${row.table}.${row.name}`)) || policyInventory.rows.length > GRAPHILE_RLS.length) {
    throw new Error("Workflow database contains an unknown row policy");
  }
  await db.query(`REVOKE CONNECT, TEMP ON DATABASE ${quoteIdent(database)} FROM PUBLIC`);
  await db.query(`GRANT CONNECT ON DATABASE ${quoteIdent(database)} TO ${quoteIdent(RUNTIME)}, ${quoteIdent(PROVISIONER)}`);
  for (const schema of SCHEMAS) {
    await db.query(`REVOKE ALL ON SCHEMA ${quoteIdent(schema)} FROM PUBLIC`);
    await db.query(`REVOKE CREATE ON SCHEMA ${quoteIdent(schema)} FROM ${quoteIdent(RUNTIME)}`);
    await db.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${quoteIdent(schema)} FROM PUBLIC`);
    await db.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${quoteIdent(schema)} FROM PUBLIC`);
    await db.query(`GRANT USAGE ON SCHEMA ${quoteIdent(schema)} TO ${quoteIdent(RUNTIME)}`);
  }
  for (const table of WORKFLOW_DML) await db.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${relation("workflow", table)} TO ${quoteIdent(RUNTIME)}`);
  await db.query(`GRANT SELECT ON TABLE ${relation("workflow_drizzle", "workflow_migrations")} TO ${quoteIdent(RUNTIME)}`);
  for (const table of GRAPHILE_DML) {
    const policyName = `runtime_${table}`;
    const hasPolicy = existingPolicies.rows.some((row) => row.table === table && row.name !== null);
    if (!hasPolicy) {
      await db.query(`CREATE POLICY ${quoteIdent(policyName)} ON ${relation("graphile_worker", table)} FOR ALL TO ${quoteIdent(RUNTIME)} USING (true) WITH CHECK (true)`);
    }
    await db.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${relation("graphile_worker", table)} TO ${quoteIdent(RUNTIME)}`);
  }
  await db.query(`GRANT SELECT ON TABLE ${relation("graphile_worker", "migrations")} TO ${quoteIdent(RUNTIME)}`);
  for (const sequence of GRAPHILE_SEQUENCES) await db.query(`GRANT USAGE ON SEQUENCE ${relation("graphile_worker", sequence)} TO ${quoteIdent(RUNTIME)}`);
  for (const schema of SCHEMAS) await db.query(`REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ${quoteIdent(schema)} FROM PUBLIC, ${quoteIdent(RUNTIME)}`);
  for (const type of TYPES) {
    const [schema, name] = type.split(".");
    await db.query(`REVOKE USAGE ON TYPE ${relation(schema!, name!)} FROM PUBLIC, ${quoteIdent(RUNTIME)}`);
  }
  await db.query(`GRANT USAGE ON TYPE ${relation("graphile_worker", "job_spec")} TO ${quoteIdent(RUNTIME)}`);
  for (const signature of GRAPHILE_FUNCTIONS) await db.query(`GRANT EXECUTE ON FUNCTION ${relation("graphile_worker", signature.slice(0, signature.indexOf("(")))}${signature.slice(signature.indexOf("("))} TO ${quoteIdent(RUNTIME)}`);
}

function isTrueExpression(value: string | null | undefined): boolean {
  return value?.replace(/[()\s]/g, "").toLowerCase() === "true";
}

/** Checks the minimum ACL/runtime contract without repairing unknown or partial databases. */
export async function verifyWorkflowRuntimePrivileges(db: Queryable): Promise<void> {
  const identity = await db.query<{ current_user: string; superuser: boolean; createdb: boolean; createrole: boolean; bypassrls: boolean; role_config: string[] | null; owns_database: boolean; workflow_owned_database: boolean }>(`
    SELECT current_user,r.rolsuper AS superuser,r.rolcreatedb AS createdb,
      r.rolcreaterole AS createrole,r.rolbypassrls AS bypassrls,r.rolconfig AS role_config,
      d.datdba=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owns_database,
      d.datdba=(SELECT oid FROM pg_roles WHERE rolname='lares_workflow_owner') AS workflow_owned_database
    FROM pg_roles r JOIN pg_database d ON d.datname=current_database() WHERE r.rolname=current_user
  `);
  const self = identity.rows[0];
  // A second query catches a caller that used SET ROLE; current_user alone would hide that.
  const session = await db.query<{ session_user: string; current_user: string; role_setting: string; replica_setting: string }>(`SELECT session_user,current_user,current_setting('role') AS role_setting,current_setting('session_replication_role') AS replica_setting`);
  const replicationSet = await db.query<{ allowed: boolean }>(`SELECT has_parameter_privilege($1,'session_replication_role','SET') AS allowed`, [RUNTIME]);
  const runtimeRole = await db.query<{ superuser: boolean; createdb: boolean; createrole: boolean; bypassrls: boolean; replication: boolean; login: boolean; inherit: boolean; memberships: number; settings: number }>(`
    SELECT r.rolsuper AS superuser,r.rolcreatedb AS createdb,r.rolcreaterole AS createrole,r.rolbypassrls AS bypassrls,r.rolreplication AS replication,r.rolcanlogin AS login,r.rolinherit AS inherit,
      (SELECT count(*)::int FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS memberships,
      (SELECT count(*)::int FROM pg_db_role_setting s WHERE s.setrole=r.oid AND (s.setdatabase=0 OR s.setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database()))) AS settings
    FROM pg_roles r WHERE r.rolname=$1
  `, [RUNTIME]);
  const supportRoles = await db.query<{ owner_login: boolean | null; owner_inherit: boolean | null; owner_privileged: boolean | null; provisioner_login: boolean | null; provisioner_inherit: boolean | null; provisioner_createdb: boolean | null; provisioner_privileged: boolean | null; membership_count: number; owner_admin: boolean | null; settings: number }>(`
    SELECT
      (SELECT rolcanlogin FROM pg_roles WHERE rolname='lares_workflow_owner') AS owner_login,
      (SELECT rolinherit FROM pg_roles WHERE rolname='lares_workflow_owner') AS owner_inherit,
      (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname='lares_workflow_owner') AS owner_privileged,
      (SELECT rolcanlogin FROM pg_roles WHERE rolname='lares_workflow_provisioner') AS provisioner_login,
      (SELECT rolinherit FROM pg_roles WHERE rolname='lares_workflow_provisioner') AS provisioner_inherit,
      (SELECT rolcreatedb FROM pg_roles WHERE rolname='lares_workflow_provisioner') AS provisioner_createdb,
      (SELECT rolsuper OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname='lares_workflow_provisioner') AS provisioner_privileged,
      (SELECT count(*)::int FROM pg_auth_members m JOIN pg_roles granted ON granted.oid=m.roleid JOIN pg_roles member ON member.oid=m.member
        WHERE granted.rolname IN ('lares_workflow_owner','lares_workflow_provisioner') OR member.rolname IN ('lares_workflow_owner','lares_workflow_provisioner')) AS membership_count,
      (SELECT m.admin_option FROM pg_auth_members m JOIN pg_roles granted ON granted.oid=m.roleid JOIN pg_roles member ON member.oid=m.member
        WHERE granted.rolname='lares_workflow_owner' AND member.rolname='lares_workflow_provisioner') AS owner_admin,
      (SELECT count(*)::int FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole WHERE r.rolname IN ('lares_workflow_owner','lares_workflow_provisioner')
        AND (s.setdatabase=0 OR s.setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database()))) AS settings
  `);
  const support = supportRoles.rows[0];
  if (!support || support.owner_login || support.owner_inherit || support.owner_privileged || !support.provisioner_login || support.provisioner_inherit || !support.provisioner_createdb || support.provisioner_privileged || support.membership_count !== 1 || support.owner_admin !== false || support.settings !== 0) {
    throw new Error("Workflow support role identity or membership is not exact");
  }
  const currentRuntimeRole = runtimeRole.rows[0];
  const identityFailures = [
    ...(self?.current_user !== RUNTIME ? ["current-user"] : []),
    ...(self?.superuser || self?.createdb || self?.createrole || self?.bypassrls || self?.role_config?.length ? ["current-role-authority"] : []),
    ...(self?.owns_database !== false || self?.workflow_owned_database !== true ? ["database-owner"] : []),
    ...(session.rows[0]?.session_user !== RUNTIME || session.rows[0]?.current_user !== RUNTIME || session.rows[0]?.role_setting !== "none" ? ["session-identity"] : []),
    ...(session.rows[0]?.replica_setting !== "origin" || replicationSet.rows[0]?.allowed !== false ? ["replication-role"] : []),
    ...(currentRuntimeRole?.superuser || currentRuntimeRole?.createdb || currentRuntimeRole?.createrole || currentRuntimeRole?.bypassrls || currentRuntimeRole?.replication || !currentRuntimeRole?.login || currentRuntimeRole?.inherit || currentRuntimeRole?.memberships !== 0 || currentRuntimeRole?.settings !== 0 ? ["runtime-role-attributes"] : []),
  ];
  if (identityFailures.length) throw new Error(`Workflow database authority identity is not the expected runtime login (${identityFailures.join(",")})`);
  const relationInventory = await db.query<{ schema: string; name: string; kind: string; owner: string }>(`
    SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,r.rolname AS owner
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
    WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p','v','m','f','S','c')
  `, [[...SCHEMAS]]);
  const expectedRelations = [
    ...WORKFLOW_DML.map((name) => `workflow.${name}:r`), "workflow_drizzle.workflow_migrations:r",
    "workflow_drizzle.workflow_migrations_id_seq:S",
    ...GRAPHILE_DML.map((name) => `graphile_worker.${name}:r`), "graphile_worker.jobs:v", "graphile_worker.migrations:r",
    ...GRAPHILE_SEQUENCES.map((name) => `graphile_worker.${name}:S`), "graphile_worker.job_spec:c",
  ].sort();
  const actualRelations = relationInventory.rows.map((row) => `${row.schema}.${row.name}:${row.kind}`).sort();
  if (actualRelations.length !== expectedRelations.length || actualRelations.some((value, index) => value !== expectedRelations[index]) || relationInventory.rows.some((row) => row.owner !== "lares_workflow_owner")) {
    throw new Error("Workflow database object inventory or ownership is not the expected template");
  }
  const schemaOwners = await db.query<{ schema: string; owner: string }>(`
    SELECT n.nspname AS schema,r.rolname AS owner FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner
    WHERE n.nspname=ANY($1::text[])
  `, [[...SCHEMAS]]);
  if (schemaOwners.rows.length !== SCHEMAS.length || schemaOwners.rows.some((row) => row.owner !== "lares_workflow_owner")) throw new Error("Workflow schema ownership is not the fixed owner");
  const typeInventory = await db.query<{ signature: string; owner: string }>(`
    SELECT n.nspname||'.'||t.typname AS signature,r.rolname AS owner
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_roles r ON r.oid=t.typowner
    WHERE n.nspname=ANY($1::text[]) AND t.typtype IN ('d','e','r','m') AND t.typelem=0 AND t.typrelid=0
  `, [[...SCHEMAS]]);
  const actualTypes = typeInventory.rows.map((row) => row.signature).sort();
  const expectedTypes = [...TYPES].filter((name) => !name.endsWith(".job_spec")).sort();
  if (actualTypes.length !== expectedTypes.length || actualTypes.some((value, index) => value !== expectedTypes[index]) || typeInventory.rows.some((row) => row.owner !== "lares_workflow_owner")) throw new Error("Workflow type inventory or ownership is not the pinned template");

  // Graphile Worker 0.16.6 has migrations 1..18. createWorld().start() invokes its
  // migrator; matching this exact ledger lets it take the no-DDL path. A behind or
  // unexpected ledger is refused here, before Keeper exposes any agent sockets.
  const graphileMigrations = await db.query<{ ids: number[] | null }>(`
    SELECT array_agg(id ORDER BY id) AS ids FROM graphile_worker.migrations
  `);
  const expectedGraphileMigrations = Array.from({ length: 18 }, (_, index) => index + 1);
  const actualGraphileMigrations = graphileMigrations.rows[0]?.ids;
  if (!actualGraphileMigrations || actualGraphileMigrations.length !== expectedGraphileMigrations.length ||
      actualGraphileMigrations.some((id, index) => id !== expectedGraphileMigrations[index])) {
    throw new Error("Workflow Graphile migration ledger is not at the pinned head");
  }

  const schemas = await db.query<{ schema: string; usage: boolean; create: boolean }>(`
    SELECT n.nspname AS schema,
      has_schema_privilege($1,n.oid,'USAGE') AS usage,
      has_schema_privilege($1,n.oid,'CREATE') AS create
    FROM pg_namespace n WHERE n.nspname=ANY($2::text[])
  `, [RUNTIME, [...SCHEMAS]]);
  if (schemas.rows.length !== SCHEMAS.length || schemas.rows.some((row) => !row.usage || row.create)) throw new Error(`Workflow runtime schema privileges are incomplete (${schemas.rows.filter((row) => !row.usage || row.create).map((row) => row.schema).join(",")})`);
  const publicSchemaAcl = await db.query<{ count: number }>(`
    SELECT count(*)::int AS count FROM pg_namespace n
    CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n'::"char",n.nspowner))) a
    WHERE n.nspname=ANY($1::text[]) AND a.grantee=0
  `, [[...SCHEMAS]]);
  const publicRelationAcl = await db.query<{ count: number }>(`
    SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('S'::"char",c.relowner))) a
    WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p','S') AND a.grantee=0
  `, [[...SCHEMAS]]);
  const publicColumnAcl = await db.query<{ count: number }>(`
    SELECT count(*)::int AS count FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL aclexplode(NULLIF(a.attacl,'{}'::aclitem[])) x
    WHERE n.nspname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
      AND x.grantee IN (0,(SELECT oid FROM pg_roles WHERE rolname=$2))
  `, [[...SCHEMAS], RUNTIME]);
  if (publicSchemaAcl.rows[0]?.count !== 0 || publicRelationAcl.rows[0]?.count !== 0 || publicColumnAcl.rows[0]?.count !== 0) throw new Error("Workflow schema has a public or column-level ACL");

  const requiredTables = [
    ...WORKFLOW_DML.map((name) => ["workflow", name, "SELECT,INSERT,UPDATE,DELETE"] as const),
    ["workflow_drizzle", "workflow_migrations", "SELECT"] as const,
    ...GRAPHILE_DML.map((name) => ["graphile_worker", name, "SELECT,INSERT,UPDATE,DELETE"] as const),
    ["graphile_worker", "migrations", "SELECT"] as const,
  ];
  for (const [schema, table, privileges] of requiredTables) {
    for (const privilege of privileges.split(",")) {
      const result = await db.query<{ allowed: boolean }>(`SELECT has_table_privilege($1,$2,$3) AS allowed`, [RUNTIME, relation(schema, table), privilege]);
      if (result.rows[0]?.allowed !== true) throw new Error("Workflow runtime table privileges are incomplete");
    }
    for (const privilege of ["TRUNCATE", "REFERENCES", "TRIGGER"] as const) {
      const result = await db.query<{ allowed: boolean }>(`SELECT has_table_privilege($1,$2,$3) AS allowed`, [RUNTIME, relation(schema, table), privilege]);
      if (result.rows[0]?.allowed !== false) throw new Error("Workflow runtime table privileges are broader than intended");
    }
  }
  for (const [schema, table] of [["workflow_drizzle", "workflow_migrations"], ["graphile_worker", "migrations"]] as const) {
    for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const) {
      const result = await db.query<{ allowed: boolean }>(`SELECT has_table_privilege($1,$2,$3) AS allowed`, [RUNTIME, relation(schema, table), privilege]);
      if (result.rows[0]?.allowed !== false) throw new Error("Workflow runtime migration ledger is writable");
    }
  }
  for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const) {
    const result = await db.query<{ allowed: boolean }>(`SELECT has_table_privilege($1,$2,$3) AS allowed`, [RUNTIME, relation("graphile_worker", "jobs"), privilege]);
    if (result.rows[0]?.allowed !== false) throw new Error("Workflow runtime has access to the internal Graphile jobs view");
  }
  const actualPolicies = await db.query<{ schema: string; table: string; name: string; roles: string[]; command: string; permissive: string; predicate: string | null; check_expression: string | null }>(`
    SELECT schemaname AS schema,tablename AS table,policyname AS name,roles::text[] AS roles,cmd AS command,permissive,qual AS predicate,with_check AS check_expression
    FROM pg_policies WHERE schemaname=ANY($1::text[])
  `, [[...SCHEMAS]]);
  const expectedPolicyKeys = GRAPHILE_RLS.map((table) => `graphile_worker.${table}.runtime_${table}`).sort();
  const actualPolicyKeys = actualPolicies.rows.map((row) => `${row.schema}.${row.table}.${row.name}`).sort();
  if (actualPolicyKeys.length !== expectedPolicyKeys.length || actualPolicyKeys.some((value, index) => value !== expectedPolicyKeys[index])) throw new Error("Workflow database has an unknown row policy");
  for (const policy of actualPolicies.rows) {
    if (policy.roles.length !== 1 || policy.roles[0] !== RUNTIME || policy.command !== "ALL" || policy.permissive !== "PERMISSIVE" || !isTrueExpression(policy.predicate) || !isTrueExpression(policy.check_expression)) throw new Error("Workflow runtime row policy is not exact");
  }
  for (const table of GRAPHILE_RLS) {
    const result = await db.query<{ enabled: boolean; forced: boolean; policy: boolean }>(`
      SELECT c.relrowsecurity AS enabled,c.relforcerowsecurity AS forced, EXISTS (
        SELECT 1 FROM pg_policies p WHERE p.schemaname='graphile_worker' AND p.tablename=$1
          AND p.policyname=$2 AND p.roles=ARRAY[$3]::name[] AND p.cmd='ALL' AND p.permissive='PERMISSIVE'
          AND regexp_replace(COALESCE(p.qual,''),'[()[:space:]]','','g')='true'
          AND regexp_replace(COALESCE(p.with_check,''),'[()[:space:]]','','g')='true'
      ) AS policy
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='graphile_worker' AND c.relname=$1
    `, [table, `runtime_${table}`, RUNTIME]);
    if (result.rows.length !== 1 || result.rows[0]?.enabled !== true || result.rows[0]?.forced !== false || result.rows[0]?.policy !== true) throw new Error("Workflow runtime row policy is incomplete");
  }
  for (const sequence of GRAPHILE_SEQUENCES) {
    const usage = await db.query<{ allowed: boolean }>(`SELECT has_sequence_privilege($1,$2,'USAGE') AS allowed`, [RUNTIME, relation("graphile_worker", sequence)]);
    if (usage.rows[0]?.allowed !== true) throw new Error("Workflow runtime sequence privileges are incomplete");
    for (const privilege of ["SELECT", "UPDATE"] as const) {
      const result = await db.query<{ allowed: boolean }>(`SELECT has_sequence_privilege($1,$2,$3) AS allowed`, [RUNTIME, relation("graphile_worker", sequence), privilege]);
      if (result.rows[0]?.allowed !== false) throw new Error("Workflow runtime sequence privileges are broader than intended");
    }
  }
  for (const privilege of ["USAGE", "SELECT", "UPDATE"] as const) {
    const result = await db.query<{ allowed: boolean }>(`SELECT has_sequence_privilege($1,$2,$3) AS allowed`, [RUNTIME, relation("workflow_drizzle", "workflow_migrations_id_seq"), privilege]);
    if (result.rows[0]?.allowed !== false) throw new Error("Workflow runtime migration sequence is accessible");
  }
  for (const signature of GRAPHILE_FUNCTIONS) {
    const result = await db.query<{ allowed: boolean }>(`SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed`, [RUNTIME, `graphile_worker.${signature}`]);
    if (result.rows[0]?.allowed !== true) throw new Error("Workflow runtime function privileges are incomplete");
  }
  const functions = await db.query<{ signature: string; executable: boolean; expected: boolean; security_definer: boolean; public_execute: boolean; owner: string }>(`
    SELECT p.oid::regprocedure::text AS signature,
      has_function_privilege($1,p.oid,'EXECUTE') AS executable,
      p.oid=ANY(ARRAY(SELECT target.signature::regprocedure FROM unnest($2::text[]) AS target(signature))) AS expected,
      p.prosecdef AS security_definer,
      EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f'::"char",p.proowner))) a
        WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute,
      owner.rolname AS owner
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles owner ON owner.oid=p.proowner WHERE n.nspname=ANY($3::text[])
  `, [RUNTIME, GRAPHILE_FUNCTION_INVENTORY.map((signature) => `graphile_worker.${signature}`), [...SCHEMAS]]);
  const executableFunctions = functions.rows.filter((row) => row.executable);
  if (functions.rows.length !== GRAPHILE_FUNCTION_INVENTORY.length || functions.rows.some((row) => !row.expected) ||
      functions.rows.some((row) => row.owner !== "lares_workflow_owner" || row.security_definer || row.public_execute) ||
      executableFunctions.length !== GRAPHILE_FUNCTIONS.length || executableFunctions.some((row) => !row.expected)) {
    throw new Error("Workflow runtime function inventory, owner, or security mode is not pinned");
  }
  const triggers = await db.query<{ count: number }>(`
    SELECT count(*)::int AS count FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=ANY($1::text[]) AND NOT t.tgisinternal
  `, [[...SCHEMAS]]);
  if (triggers.rows[0]?.count !== 0) throw new Error("Workflow database contains an unknown trigger binding");
  const publicSequences = await db.query<{ count: number }>(`
    SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('S'::"char",c.relowner))) a
    WHERE n.nspname=ANY($1::text[]) AND c.relkind='S' AND a.grantee=0
  `, [[...SCHEMAS]]);
  if (publicSequences.rows[0]?.count !== 0) throw new Error("Workflow sequence is public");
  const database = await db.query<{ connect: boolean; create: boolean; temp: boolean }>(`SELECT has_database_privilege($1,current_database(),'CONNECT') AS connect, has_database_privilege($1,current_database(),'CREATE') AS create, has_database_privilege($1,current_database(),'TEMP') AS temp`, [RUNTIME]);
  const databaseAcl = await db.query<{ public_privileges: string[] }>(`
    SELECT COALESCE(array_agg(a.privilege_type ORDER BY a.privilege_type) FILTER (WHERE a.privilege_type IS NOT NULL),'{}') AS public_privileges
    FROM pg_database d LEFT JOIN LATERAL aclexplode(COALESCE(d.datacl,acldefault('d'::"char",d.datdba))) a ON a.grantee=0
    WHERE d.datname=current_database()
  `);
  if (database.rows[0]?.connect !== true || database.rows[0]?.create !== false || database.rows[0]?.temp !== false || databaseAcl.rows[0]?.public_privileges.length) throw new Error("Workflow runtime database privileges are broader than intended");

  // Effective `has_*_privilege` checks above prove required/forbidden operations for the
  // runtime login. These exact ACL inventories also reject grant options and unrelated
  // grantees, which effective checks would otherwise hide.
  const exactAcl = (label: string, actualRows: Array<{ object: string; grantee: string; privilege: string; grantable: boolean }>, expectedRows: Array<{ object: string; grantee: string; privilege: string }>) => {
    const key = (row: { object: string; grantee: string; privilege: string }) => `${row.object}\0${row.grantee}\0${row.privilege}`;
    const actual = actualRows.map(key).sort();
    const expected = expectedRows.map(key).sort();
    if (actualRows.some((row) => row.grantable) || actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) throw new Error(`Workflow ${label} ACL is not exact`);
  };
  const dbAcl = await db.query<{ object: string; grantee: string; privilege: string; grantable: boolean }>(`
    SELECT d.datname AS object,COALESCE(r.rolname,'PUBLIC') AS grantee,a.privilege_type AS privilege,a.is_grantable AS grantable
    FROM pg_database d CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl,acldefault('d'::"char",d.datdba))) a
    LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE d.datname=current_database() AND a.grantee<>d.datdba
  `);
  const databaseName = dbAcl.rows[0]?.object;
  if (!databaseName) throw new Error("Workflow database ACL identity is unavailable");
  exactAcl("database", dbAcl.rows, [RUNTIME, PROVISIONER].map((grantee) => ({ object: databaseName, grantee, privilege: "CONNECT" })));
  const schemaAcl = await db.query<{ object: string; grantee: string; privilege: string; grantable: boolean }>(`
    SELECT n.nspname AS object,COALESCE(r.rolname,'PUBLIC') AS grantee,a.privilege_type AS privilege,a.is_grantable AS grantable
    FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n'::"char",n.nspowner))) a
    LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE n.nspname=ANY($1::text[]) AND a.grantee<>n.nspowner
  `, [[...SCHEMAS]]);
  exactAcl("schema", schemaAcl.rows, SCHEMAS.map((object) => ({ object, grantee: RUNTIME, privilege: "USAGE" })));
  const relationAcl = await db.query<{ object: string; grantee: string; privilege: string; grantable: boolean }>(`
    SELECT n.nspname||'.'||c.relname AS object,COALESCE(r.rolname,'PUBLIC') AS grantee,a.privilege_type AS privilege,a.is_grantable AS grantable
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) a
    LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p','v','m','f') AND a.grantee<>c.relowner
  `, [[...SCHEMAS]]);
  const expectedRelationAcl = [
    ...WORKFLOW_DML.map((name) => ({ object: `workflow.${name}`, grantee: RUNTIME, privilege: "SELECT" })),
    ...WORKFLOW_DML.map((name) => ({ object: `workflow.${name}`, grantee: RUNTIME, privilege: "INSERT" })),
    ...WORKFLOW_DML.map((name) => ({ object: `workflow.${name}`, grantee: RUNTIME, privilege: "UPDATE" })),
    ...WORKFLOW_DML.map((name) => ({ object: `workflow.${name}`, grantee: RUNTIME, privilege: "DELETE" })),
    { object: "workflow_drizzle.workflow_migrations", grantee: RUNTIME, privilege: "SELECT" },
    ...GRAPHILE_DML.flatMap((name) => ["SELECT","INSERT","UPDATE","DELETE"].map((privilege) => ({ object: `graphile_worker.${name}`, grantee: RUNTIME, privilege }))),
    { object: "graphile_worker.migrations", grantee: RUNTIME, privilege: "SELECT" },
  ];
  exactAcl("table", relationAcl.rows, expectedRelationAcl);
  const sequenceAcl = await db.query<{ object: string; grantee: string; privilege: string; grantable: boolean }>(`
    SELECT n.nspname||'.'||c.relname AS object,COALESCE(r.rolname,'PUBLIC') AS grantee,a.privilege_type AS privilege,a.is_grantable AS grantable
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('s'::"char",c.relowner))) a
    LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE n.nspname=ANY($1::text[]) AND c.relkind='S' AND a.grantee<>c.relowner
  `, [[...SCHEMAS]]);
  exactAcl("sequence", sequenceAcl.rows, GRAPHILE_SEQUENCES.map((name) => ({ object: `graphile_worker.${name}`, grantee: RUNTIME, privilege: "USAGE" })));
  const functionAcl = await db.query<{ object: string; grantee: string; privilege: string; grantable: boolean }>(`
    SELECT p.oid::text AS object,COALESCE(r.rolname,'PUBLIC') AS grantee,a.privilege_type AS privilege,a.is_grantable AS grantable
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f'::"char",p.proowner))) a
    LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE n.nspname=ANY($1::text[]) AND a.grantee<>p.proowner
  `, [[...SCHEMAS]]);
  const expectedFunctionOids = await db.query<{ object: string }>(`SELECT signature::regprocedure::oid::text AS object FROM unnest($1::text[]) AS expected(signature)`, [GRAPHILE_FUNCTIONS.map((signature) => `graphile_worker.${signature}`)]);
  exactAcl("function", functionAcl.rows, expectedFunctionOids.rows.map(({ object }) => ({ object, grantee: RUNTIME, privilege: "EXECUTE" })));
  const columnAcl = await db.query<{ object: string; grantee: string; privilege: string; grantable: boolean }>(`
    SELECT n.nspname||'.'||c.relname||'.'||a.attname AS object,COALESCE(r.rolname,'PUBLIC') AS grantee,x.privilege_type AS privilege,x.is_grantable AS grantable
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL aclexplode(NULLIF(a.attacl,'{}'::aclitem[])) x LEFT JOIN pg_roles r ON r.oid=x.grantee
    WHERE n.nspname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped
  `, [[...SCHEMAS]]);
  exactAcl("column", columnAcl.rows, []);
  const typeAcl = await db.query<{ object: string; grantee: string; privilege: string; grantable: boolean }>(`
    SELECT n.nspname||'.'||t.typname AS object,COALESCE(r.rolname,'PUBLIC') AS grantee,a.privilege_type AS privilege,a.is_grantable AS grantable
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(t.typacl,acldefault('T'::"char",t.typowner))) a
    LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE n.nspname=ANY($1::text[]) AND t.typname=ANY($2::text[]) AND a.grantee<>t.typowner
  `, [[...SCHEMAS], [...TYPES.map((name) => name.split(".")[1])]]);
  exactAcl("type", typeAcl.rows, [{ object: "graphile_worker.job_spec", grantee: RUNTIME, privilege: "USAGE" }]);
  const unsafeParameterAcl = await db.query<{ allowed: boolean }>(`
    SELECT EXISTS (SELECT 1 FROM pg_parameter_acl p CROSS JOIN LATERAL aclexplode(NULLIF(p.paracl,'{}'::aclitem[])) a
      WHERE p.parname='session_replication_role' AND a.grantee=ANY(ARRAY[0::oid,(SELECT oid FROM pg_roles WHERE rolname=$1)])) AS allowed
  `, [RUNTIME]);
  if (unsafeParameterAcl.rows[0]?.allowed) throw new Error("Workflow runtime has SET authority for session_replication_role");
}
