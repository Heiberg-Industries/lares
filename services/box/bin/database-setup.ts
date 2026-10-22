import { readFileSync } from "node:fs";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { provisionEngineDatabasePrivileges } from "../lib/database-privileges.js";
import { verifyWorkflowRuntimePrivileges } from "../lib/workflow-database-privileges.js";

const WORKFLOW_PROVISIONER = "lares_workflow_provisioner";
const WORKFLOW_OWNER = "lares_workflow_owner";
const WORKFLOW_RUNTIME = "lares_workflow";
const GATEWAY = "lares_gateway";
const ENGINE = "lares_state";
const GATEWAY_DATABASE = "litellm";
const WORKFLOW_TEMPLATE = "empty_workflow";
const ROLE_PREFIX = "lares-rc13-database:v1:";
const TEMPLATE_TABLES = [
  ["workflow", "workflow_event_slots"], ["workflow", "workflow_events"], ["workflow", "workflow_hooks"],
  ["workflow", "workflow_runs"], ["workflow", "workflow_steps"], ["workflow", "workflow_stream_chunks"],
  ["workflow", "workflow_waits"], ["graphile_worker", "_private_job_queues"], ["graphile_worker", "_private_jobs"],
  ["graphile_worker", "_private_known_crontabs"], ["graphile_worker", "_private_tasks"],
] as const;
const ENGINE_ROLE_MARKERS = new Map([
  ["lares_schema_owner", "lares-engine-database-role:v1:owner"],
  ["lares_app", "lares-engine-database-role:v1:application"],
  ["lares_financial", "lares-engine-database-role:v1:financial"],
]);

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? "" : process.argv[index + 1] ?? "";
  if (!value || value.startsWith("--")) throw new Error(`database setup: ${name} needs a value`);
  return value;
}

function secret(path: string): string {
  const value = readFileSync(path, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(value)) throw new Error("database setup: a credential file is empty or has an unsupported format");
  return value;
}

function ident(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("database setup: invalid fixed database identity");
  return `"${value}"`;
}

async function query<T extends QueryResultRow>(client: PoolClient, sql: string, values: unknown[] = []): Promise<T[]> {
  return (await client.query<T>(sql, values)).rows;
}

async function finalizeWorkflowTemplate(): Promise<void> {
  const operatorPassword = secret(argument("--operator-password-file"));
  const runtimePassword = secret(argument("--workflow-password-file"));
  const host = process.env.PGHOST ?? "127.0.0.1";
  const port = Number(process.env.PGPORT ?? 5432);
  const operatorPool = new Pool({ host, port, database: "postgres", user: "lares_operator", password: operatorPassword, max: 1, connectionTimeoutMillis: 5000 });
  const templateOperatorPool = new Pool({ host, port, database: WORKFLOW_TEMPLATE, user: "lares_operator", password: operatorPassword, max: 1, connectionTimeoutMillis: 5000 });
  const runtimePool = new Pool({ host, port, database: WORKFLOW_TEMPLATE, user: WORKFLOW_RUNTIME, password: runtimePassword, max: 1, connectionTimeoutMillis: 5000 });
  let client: PoolClient | undefined;
  let templateClient: PoolClient | undefined;
  try {
    const admin = await operatorPool.connect();
    client = admin;
    const template = await templateOperatorPool.connect();
    templateClient = template;
    const identity = (await query<{ user_name: string; superuser: boolean; database: string }>(admin,
      "SELECT session_user AS user_name, r.rolsuper AS superuser, current_database() AS database FROM pg_roles r WHERE r.rolname=session_user"))[0];
    if (identity?.user_name !== "lares_operator" || identity.superuser !== true || identity.database !== "postgres")
      throw new Error("database setup: explicit lares_operator identity check failed while finalizing the workflow template");
    const templateMetadata = (await query<{ owner: string; is_template: boolean; allow_connections: boolean }>(admin,
      "SELECT pg_get_userbyid(datdba) AS owner, datistemplate AS is_template, datallowconn AS allow_connections FROM pg_database WHERE datname=$1", [WORKFLOW_TEMPLATE]))[0];
    if (templateMetadata?.owner !== WORKFLOW_OWNER || templateMetadata.is_template || !templateMetadata.allow_connections)
      throw new Error("database setup: workflow template owner or pre-finalized state is unexpected");
    const templateIdentity = (await query<{ user_name: string; current_user: string; database: string; superuser: boolean }>(template,
      "SELECT session_user AS user_name,current_user, current_database() AS database,r.rolsuper AS superuser FROM pg_roles r WHERE r.rolname=session_user"))[0];
    if (templateIdentity?.user_name !== "lares_operator" || templateIdentity.current_user !== "lares_operator" || templateIdentity.database !== WORKFLOW_TEMPLATE || templateIdentity.superuser !== true)
      throw new Error("database setup: explicit lares_operator identity check failed while inspecting the workflow template");
    const roles = await query<{ rolname: string; rolcanlogin: boolean; rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolbypassrls: boolean; comment: string | null }>(admin,
      "SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,shobj_description(oid,'pg_authid') AS comment FROM pg_roles WHERE rolname=ANY($1::text[])",
      [[WORKFLOW_OWNER, WORKFLOW_PROVISIONER, WORKFLOW_RUNTIME]]);
    const expected = new Map(roles.map((row) => [row.rolname, row]));
    const owner = expected.get(WORKFLOW_OWNER), provisioner = expected.get(WORKFLOW_PROVISIONER), runtime = expected.get(WORKFLOW_RUNTIME);
    if (roles.length !== 3 || !owner || !provisioner || !runtime || owner.rolcanlogin || owner.rolsuper || owner.rolcreatedb || owner.rolcreaterole || owner.rolbypassrls || owner.comment !== `${ROLE_PREFIX}workflow-owner` ||
      !provisioner.rolcanlogin || provisioner.rolsuper || !provisioner.rolcreatedb || provisioner.rolcreaterole || provisioner.rolbypassrls || provisioner.comment !== `${ROLE_PREFIX}workflow-provisioner` ||
      !runtime.rolcanlogin || runtime.rolsuper || runtime.rolcreatedb || runtime.rolcreaterole || runtime.rolbypassrls || runtime.comment !== `${ROLE_PREFIX}workflow-runtime`)
      throw new Error("database setup: workflow role markers or role attributes do not match a fresh install");
    const dataTables = await query<{ table_schema: string; table_name: string }>(template,
      "SELECT n.nspname AS table_schema,c.relname AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('workflow','graphile_worker') AND c.relkind IN ('r','p') AND c.relname NOT IN ('workflow_migrations','migrations') ORDER BY 1,2");
    const actual = new Set(dataTables.map((row) => `${row.table_schema}.${row.table_name}`));
    if (actual.size !== TEMPLATE_TABLES.length || TEMPLATE_TABLES.some(([schema, table]) => !actual.has(`${schema}.${table}`)))
      throw new Error("database setup: workflow template table inventory differs from the pinned runtime schema");
    for (const [schema, table] of TEMPLATE_TABLES) {
      const count = (await query<{ rows: string }>(template, `SELECT count(*)::text AS rows FROM "${schema}"."${table}"`))[0]?.rows;
      if (count !== "0") throw new Error("database setup: workflow template contains jobs or user workflow data");
    }
    await verifyWorkflowRuntimePrivileges(runtimePool);
    await admin.query(`ALTER DATABASE ${ident(WORKFLOW_TEMPLATE)} IS_TEMPLATE true`);
    const confirmed = (await query<{ owner: string; is_template: boolean }>(admin,
      "SELECT pg_get_userbyid(datdba) AS owner, datistemplate AS is_template FROM pg_database WHERE datname=$1", [WORKFLOW_TEMPLATE]))[0];
    if (confirmed?.owner !== WORKFLOW_OWNER || confirmed.is_template !== true)
      throw new Error("database setup: finalized workflow template state could not be confirmed");
    process.stdout.write("database setup: verified empty workflow template finalized for database cloning\n");
  } finally {
    templateClient?.release();
    client?.release();
    await Promise.all([operatorPool.end(), templateOperatorPool.end(), runtimePool.end()]);
  }
}

async function verifyRestoredEngine(): Promise<void> {
  const operatorPassword = secret(argument("--operator-password-file"));
  const appPassword = secret(argument("--app-password-file"));
  const financialPassword = secret(argument("--financial-password-file"));
  const pool = new Pool({
    host: process.env.PGHOST ?? "127.0.0.1", port: Number(process.env.PGPORT ?? 5432),
    database: ENGINE, user: "lares_operator", password: operatorPassword, max: 1, connectionTimeoutMillis: 5000,
  });
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const identity = (await query<{ session_user: string; current_user: string; database: string; superuser: boolean }>(client,
      "SELECT session_user,current_user,current_database() AS database,r.rolsuper AS superuser FROM pg_roles r WHERE r.rolname=session_user"))[0];
    if (identity?.session_user !== "lares_operator" || identity.current_user !== "lares_operator" || identity.database !== ENGINE || !identity.superuser)
      throw new Error("database setup: restored engine verification requires the explicit operator identity on lares_state");
    const roles = await query<{ rolname: string; comment: string | null }>(client,
      "SELECT rolname,shobj_description(oid,'pg_authid') AS comment FROM pg_roles WHERE rolname=ANY($1::text[])", [[...ENGINE_ROLE_MARKERS.keys()]]);
    if (roles.length !== ENGINE_ROLE_MARKERS.size || roles.some((row) => ENGINE_ROLE_MARKERS.get(row.rolname) !== row.comment))
      throw new Error("database setup: restored engine roles do not carry the exact managed ownership markers");
    const result = await provisionEngineDatabasePrivileges(client, {
      expectedDatabase: ENGINE,
      passwords: { application: Buffer.from(appPassword), financial: Buffer.from(financialPassword) },
    });
    if (result.status !== "verified") throw new Error("database setup: restored engine privilege state was not already managed");
    process.stdout.write("database setup: restored engine role ownership and grants verified\n");
  } finally {
    client?.release(true);
    await pool.end();
  }
}

async function run(): Promise<void> {
  if (process.argv[2] === "--finalize-workflow-template") {
    await finalizeWorkflowTemplate();
    return;
  }
  if (process.argv[2] === "--verify-restored-engine") {
    await verifyRestoredEngine();
    return;
  }
  const operatorPasswordFile = argument("--operator-password-file");
  const appPasswordFile = argument("--app-password-file");
  const financialPasswordFile = argument("--financial-password-file");
  const workflowProvisionerPasswordFile = argument("--workflow-provisioner-password-file");
  const workflowPasswordFile = argument("--workflow-password-file");
  const gatewayPasswordFile = argument("--gateway-password-file");
  const operatorPassword = secret(operatorPasswordFile);
  const appPassword = secret(appPasswordFile);
  const financialPassword = secret(financialPasswordFile);
  const workflowProvisionerPassword = secret(workflowProvisionerPasswordFile);
  const workflowPassword = secret(workflowPasswordFile);
  const gatewayPassword = secret(gatewayPasswordFile);
  if (new Set([operatorPassword, appPassword, financialPassword, workflowProvisionerPassword, workflowPassword, gatewayPassword]).size !== 6)
    throw new Error("database setup: the generated database credentials are not distinct");

  const pool = new Pool({
    host: process.env.PGHOST ?? "127.0.0.1",
    port: Number(process.env.PGPORT ?? 5432),
    database: "postgres",
    user: "lares_operator",
    password: operatorPassword,
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const identity = (await query<{ user_name: string; superuser: boolean; database: string }>(client,
      "SELECT session_user AS user_name, r.rolsuper AS superuser, current_database() AS database FROM pg_roles r WHERE r.rolname=session_user"))[0];
    if (identity?.user_name !== "lares_operator" || identity.superuser !== true || identity.database !== "postgres")
      throw new Error("database setup: the explicit lares_operator connection did not prove its identity");

    const existingDatabases = await query<{ datname: string }>(client,
      "SELECT datname FROM pg_database WHERE datname=ANY($1::text[])", [[ENGINE, GATEWAY_DATABASE, WORKFLOW_TEMPLATE]]);
    if (existingDatabases.length !== 0)
      throw new Error("database setup: a target database already exists without a completed installation record; inspect it before retrying");
    const existingRoles = await query<{ rolname: string; comment: string | null }>(client,
      "SELECT rolname, shobj_description(oid, 'pg_authid') AS comment FROM pg_roles WHERE rolname=ANY($1::text[])",
      [[WORKFLOW_PROVISIONER, WORKFLOW_OWNER, WORKFLOW_RUNTIME, GATEWAY]]);
    if (existingRoles.length !== 0)
      throw new Error("database setup: a target login or owner role already exists; refusing to adopt unknown role state");

    await client.query(`CREATE ROLE ${ident(WORKFLOW_OWNER)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    await client.query(`COMMENT ON ROLE ${ident(WORKFLOW_OWNER)} IS '${ROLE_PREFIX}workflow-owner'`);
    await client.query(`CREATE ROLE ${ident(WORKFLOW_PROVISIONER)} LOGIN CREATEDB NOCREATEROLE NOSUPERUSER NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${workflowProvisionerPassword}'`);
    await client.query(`COMMENT ON ROLE ${ident(WORKFLOW_PROVISIONER)} IS '${ROLE_PREFIX}workflow-provisioner'`);
    await client.query(`GRANT ${ident(WORKFLOW_OWNER)} TO ${ident(WORKFLOW_PROVISIONER)}`);
    await client.query(`CREATE ROLE ${ident(WORKFLOW_RUNTIME)} LOGIN NOCREATEDB NOCREATEROLE NOSUPERUSER NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${workflowPassword}'`);
    await client.query(`COMMENT ON ROLE ${ident(WORKFLOW_RUNTIME)} IS '${ROLE_PREFIX}workflow-runtime'`);
    await client.query(`CREATE ROLE ${ident(GATEWAY)} LOGIN NOCREATEDB NOCREATEROLE NOSUPERUSER NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${gatewayPassword}'`);
    await client.query(`COMMENT ON ROLE ${ident(GATEWAY)} IS '${ROLE_PREFIX}gateway'`);

    await client.query(`CREATE DATABASE ${ident(ENGINE)} OWNER lares_operator`);
    await client.query(`CREATE DATABASE ${ident(GATEWAY_DATABASE)} OWNER ${ident(GATEWAY)}`);
    await client.query(`CREATE DATABASE ${ident(WORKFLOW_TEMPLATE)} OWNER ${ident(WORKFLOW_OWNER)}`);
    for (const db of [GATEWAY_DATABASE, WORKFLOW_TEMPLATE]) {
      await client.query(`REVOKE CONNECT, CREATE, TEMP ON DATABASE ${ident(db)} FROM PUBLIC`);
    }
    await client.query(`GRANT CONNECT ON DATABASE ${ident(WORKFLOW_TEMPLATE)} TO ${ident(WORKFLOW_PROVISIONER)}`);

    const enginePool = new Pool({
      host: process.env.PGHOST ?? "127.0.0.1",
      port: Number(process.env.PGPORT ?? 5432),
      database: ENGINE,
      user: "lares_operator",
      password: operatorPassword,
      max: 1,
      connectionTimeoutMillis: 5000,
    });
    try {
      // The baseline is deliberately the first SQL applied. Engine role creation and ownership
      // transfer only happen after its full inventory exists.
      const baseline = await import("../migrate.js");
      const code = await baseline.main(["--bootstrap-operator"], { db: enginePool, out: (line) => process.stdout.write(`${line}\n`) });
      if (code !== 0) throw new Error("database setup: the first engine baseline was refused");
      const engine = await enginePool.connect();
      try {
      await provisionEngineDatabasePrivileges(engine, {
        expectedDatabase: ENGINE,
        passwords: { application: Buffer.from(appPassword), financial: Buffer.from(financialPassword) },
      });
      } finally {
        engine.release();
      }
    } finally {
      await enginePool.end();
    }

    process.stdout.write("database setup: fresh engine, gateway, and workflow roles/databases prepared\n");
  } finally {
    client?.release(true);
    await pool.end();
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "database setup failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
