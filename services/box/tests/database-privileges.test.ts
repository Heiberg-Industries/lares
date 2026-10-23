import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { quietPool } from "./helpers/quiet-pool.js";
import { PgBudgetAdmissionStore } from "@lares/agent-kit/budget-admission-store";
import { ENGINE_TABLE_PRIVILEGES, provisionEngineDatabasePrivileges } from "../lib/database-privileges.js";
import { MEMBER_SCOPE, tablesInBoxSql } from "../lib/member-scope.js";
import { LEDGER_DDL } from "../lib/migration-ledger.js";

const sqlDir = new URL("../sql/", import.meta.url);
const sqlPath = (name: string) => new URL(name, sqlDir);
const appPassword = Buffer.from("app-role-test-password-0123456789abcd");
const financialPassword = Buffer.from("financial-role-test-password-0123456789");
let container: StartedPostgreSqlContainer;
let admin: Pool;
let app: Pool;
let financial: Pool;

async function expectDenied(query: () => Promise<unknown>): Promise<void> {
  try {
    await query();
    expect.fail("expected PostgreSQL to reject the operation");
  } catch (error) {
    expect((error as { code?: string }).code).toBe("42501");
  }
}

function loginPool(role: string, password: Buffer): Pool {
  const connection = new URL(container.getConnectionUri());
  connection.username = role;
  connection.password = password.toString("ascii");
  return quietPool({ connectionString: connection.toString(), max: 3 });
}

async function expectProvisionRefused(): Promise<void> {
  const operator = await admin.connect();
  try {
    await expect(provisionEngineDatabasePrivileges(operator, {
      expectedDatabase: container.getDatabase(),
      passwords: { application: appPassword, financial: financialPassword },
    })).rejects.toThrow("Database privilege setup could not be confirmed; inspect the database before retrying.");
  } finally { operator.release(); }
}

const financialTables = ["budget_accounts", "budget_windows", "budget_gateway_bindings", "budget_attempts", "budget_gateway_grants", "budget_financial_checkpoints"];

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  admin = quietPool({ connectionString: container.getConnectionUri(), max: 4 });
  const files = readdirSync(sqlPath(".")).filter((name) => /^\d+.*\.sql$/.test(name)).sort((a, b) => Number(a.match(/^\d+/)![0]) - Number(b.match(/^\d+/)![0]) || a.localeCompare(b));
  for (const file of files) await admin.query(readFileSync(sqlPath(file), "utf8"));
  await admin.query(LEDGER_DDL);
  const triggerShape = (await admin.query(`SELECT
    count(*) FILTER (WHERE pns.nspname<>'public') AS wrong_namespace,
    count(*) FILTER (WHERE t.tgqual IS NOT NULL) AS conditions,
    count(*) FILTER (WHERE t.tgnargs<>0) AS argument_count,
    count(*) FILTER (WHERE COALESCE(octet_length(t.tgargs),0)<>0) AS argument_bytes,
    count(*) FILTER (WHERE t.tgconstraint<>0) AS constraint_triggers,
    count(*) FILTER (WHERE t.tgdeferrable OR t.tginitdeferred) AS deferred_triggers,
    count(*) FILTER (WHERE ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum=ANY(t.tgattr) ORDER BY a.attname) <>
      CASE t.tgname WHEN 'personal_account_history_guard' THEN ARRAY['generation','status']::text[]
                    WHEN 'definition_agent_access_guard' THEN ARRAY['hash','status']::text[]
                    WHEN 'studio_runs_owner_guard' THEN ARRAY['owner_member_id']::text[] ELSE ARRAY[]::text[] END) AS column_filters
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pns ON pns.oid=p.pronamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_trigger'::regclass AND d.objid=t.oid AND d.deptype='e')`)).rows[0];
  expect(Object.fromEntries(Object.entries(triggerShape).map(([key, value]) => [key, Number(value)]))).toEqual({ wrong_namespace: 0, conditions: 0, argument_count: 0, argument_bytes: 0, constraint_triggers: 0, deferred_triggers: 0, column_filters: 0 });
  const operator = await admin.connect();
  try {
    expect(await provisionEngineDatabasePrivileges(operator, {
      expectedDatabase: container.getDatabase(),
      passwords: { application: appPassword, financial: financialPassword },
    })).toEqual({ status: "applied" });
    expect(await provisionEngineDatabasePrivileges(operator, {
      expectedDatabase: container.getDatabase(),
      passwords: { application: Buffer.from("different-app-password-0123456789abcd"), financial: Buffer.from("different-fin-password-0123456789abcd") },
    })).toEqual({ status: "verified" });
  } finally { operator.release(); }
  app = loginPool("lares_app", appPassword);
  financial = loginPool("lares_financial", financialPassword);
}, 180_000);

afterAll(async () => {
  await Promise.all([app?.end(), financial?.end(), admin?.end()]);
  await container?.stop();
});

describe("engine database privilege foundation", () => {
  it("matches the fixed table policy inventory to every shipped migration table and member scope", () => {
    const online = [...ENGINE_TABLE_PRIVILEGES.ordinary, ...ENGINE_TABLE_PRIVILEGES.financial];
    const complete = [...online, ...ENGINE_TABLE_PRIVILEGES.ledger].sort();
    expect(ENGINE_TABLE_PRIVILEGES.ledger).toEqual(["schema_migrations"]);
    expect(new Set(complete).size).toBe(complete.length);
    expect(complete.sort()).toEqual(MEMBER_SCOPE.map((entry) => entry.table).sort());
    expect(complete.sort()).toEqual(tablesInBoxSql(join(new URL("../sql/", import.meta.url).pathname)).sort());
  });

  it("checks invoker-trigger permissions under the actual app login, even with no matching accounts", async () => {
    await admin.query("INSERT INTO orgs(id,display_name) VALUES ('probe-org','Probe')");
    await admin.query("INSERT INTO users(id,display_name,org_id,org_role) VALUES ('probe-owner','Probe owner','probe-org','owner'),('probe-member','Probe member','probe-org','member')");
    expect((await app.query("SELECT current_user, session_user")).rows[0]).toEqual({ current_user: "lares_app", session_user: "lares_app" });
    expect(Number((await admin.query("SELECT count(*) AS n FROM budget_accounts WHERE live_member_id='probe-member'")).rows[0].n)).toBe(0);

    await expectDenied(() => app.query("INSERT INTO org_member_policy(user_id,allowed_capabilities) VALUES ('probe-member',NULL)"));
    expect((await admin.query("SELECT count(*) AS n FROM org_member_policy WHERE user_id='probe-member'")).rows[0].n).toBe("0");
    await expectDenied(() => app.query("UPDATE users SET status='removed' WHERE id='probe-member'"));
    expect((await admin.query("SELECT status FROM users WHERE id='probe-member'")).rows[0].status).not.toBe("removed");
    await expectDenied(() => app.query("SELECT budget_retire_member('probe-member',false)"));
  });

  it("allows ordinary writes and denies ledger and financial data to the application login", async () => {
    await app.query("INSERT INTO agent_notes(owner,agent,kind,note,origin,session_id,turn_id) VALUES ('probe-owner','probe-agent','working','ordinary write','owner','probe-session','probe-turn')");
    await app.query("INSERT INTO standing_facts(fact,category,source_turn,user_id) VALUES ('ordinary write','test','probe-turn','probe-owner')");
    await app.query("INSERT INTO update_history(to_release,images) VALUES ('1.0.0','{\"box\":\"ghcr.io/lares/box@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}'::jsonb)");
    await app.query("INSERT INTO settings(key,value,updated_by) VALUES ('probe-app-setting','\"value\"'::jsonb,'probe-owner')");
    expect((await admin.query("SELECT count(*) AS n FROM settings_audit WHERE key='probe-app-setting'")).rows[0].n).toBe("1");
    for (const table of ENGINE_TABLE_PRIVILEGES.financial) await expectDenied(() => app.query(`SELECT * FROM public."${table}"`));
    await expectDenied(() => app.query("SELECT * FROM schema_migrations"));
    await expectDenied(() => app.query("SELECT nextval('schema_migrations_seq_seq')"));
    await expectDenied(() => app.query("SELECT nextval('atlas_proposals_id_seq')"));
    await expectDenied(() => app.query("TRUNCATE agent_notes"));
    await expectDenied(() => app.query("ALTER TABLE agent_notes DISABLE TRIGGER ALL"));
    await expectDenied(() => app.query("CREATE TEMP TABLE probe_temp(id int)"));
    await expectDenied(() => app.query("CREATE TABLE public.role_probe_ddl(id int)"));
    await expectDenied(() => app.query("SET ROLE lares_schema_owner"));
    await expectDenied(() => app.query("SET ROLE lares_financial"));
    await expectDenied(() => app.query("SET session_replication_role = replica"));
    await expectDenied(() => app.query("SELECT pg_catalog.pg_control_system()"));
  });

  it("gives financial operations only the fixed account, checkpoint, lock and observer access", async () => {
    const ids = {
      installation: "00000000-0000-4000-8000-000000000001", member: "00000000-0000-4000-8000-000000000002",
      checkpoint: "00000000-0000-4000-8000-000000000003", journal: "00000000-0000-4000-8000-000000000004",
      installationWindow: "00000000-0000-4000-8000-000000000013", memberWindow: "00000000-0000-4000-8000-000000000014",
      binding: "00000000-0000-4000-8000-000000000015", attempt: "00000000-0000-4000-8000-000000000016",
    };
    await financial.query("INSERT INTO budget_accounts(id,installation_id,kind,installation_account_id) VALUES ($1,'probe-installation','installation',$1)", [ids.installation]);
    expect((await financial.query("SELECT current_user, session_user")).rows[0]).toEqual({ current_user: "lares_financial", session_user: "lares_financial" });
    await financial.query("UPDATE budget_accounts SET installation_cap=0.1 WHERE id=$1", [ids.installation]);
    expect((await financial.query("SELECT installation_cap FROM budget_accounts WHERE id=$1", [ids.installation])).rows[0].installation_cap).toBe("0.1");
    await financial.query("INSERT INTO settings(key,value,updated_by) VALUES ('probe-financial-setting','\"value\"'::jsonb,'financial-probe')");
    expect((await admin.query("SELECT count(*) AS n FROM settings_audit WHERE key='probe-financial-setting'")).rows[0].n).toBe("1");
    await financial.query("INSERT INTO budget_financial_checkpoints(operation_id,journal_id,proposal_sequence,proposal_digest) VALUES ($1,$2,1,$3)", [ids.checkpoint, ids.journal, "a".repeat(64)]);
    expect((await financial.query("SELECT operation_id FROM budget_financial_checkpoints WHERE operation_id=$1", [ids.checkpoint])).rows).toHaveLength(1);
    expect((await financial.query("SELECT attempt_id FROM budget_gateway_grants FOR UPDATE")).rows).toHaveLength(0);
    expect((await financial.query("SELECT pg_catalog.pg_control_system()")).rows).toHaveLength(1);
    await expectDenied(() => financial.query("UPDATE budget_financial_checkpoints SET proposal_sequence=2 WHERE operation_id=$1", [ids.checkpoint]));
    await expectDenied(() => financial.query("DELETE FROM budget_financial_checkpoints WHERE operation_id=$1", [ids.checkpoint]));
    await expectDenied(() => financial.query("TRUNCATE budget_accounts"));
    await expectDenied(() => financial.query("CREATE TEMP TABLE financial_temp(id int)"));
    await expectDenied(() => financial.query("CREATE TABLE public.financial_role_probe(id int)"));
    await expectDenied(() => financial.query("ALTER TABLE public.settings DISABLE TRIGGER ALL"));
    await expectDenied(() => financial.query("SELECT * FROM schema_migrations"));
    await expectDenied(() => financial.query("SELECT nextval('schema_migrations_seq_seq')"));
    await expectDenied(() => financial.query("SELECT nextval('atlas_proposals_id_seq')"));
    await expectDenied(() => financial.query("SET ROLE lares_schema_owner"));
    await expectDenied(() => financial.query("SET ROLE lares_app"));
    await expectDenied(() => financial.query("SET session_replication_role = replica"));

    const ticket = "t".repeat(43), ticketHash = createHash("sha256").update(ticket).digest("hex");
    const hash = "a".repeat(64), incarnation = "00000000-0000-4000-8000-000000000017";
    await admin.query("INSERT INTO orgs(id,display_name) VALUES ('ticket-pool-org','Ticket pool proof')");
    await admin.query("INSERT INTO users(id,display_name,org_id,org_role) VALUES ('ticket-pool-member','Ticket pool member','ticket-pool-org','member')");
    await admin.query(`INSERT INTO budget_accounts(id,installation_id,kind,installation_account_id,live_member_id,organisation_id,canonical_suppression_hash,provider_suppression_hashes)
      VALUES($1,'probe-installation','member',$2,'ticket-pool-member','ticket-pool-org',$3,ARRAY[$3])`, [ids.member, ids.installation, hash]);
    await admin.query(`INSERT INTO budget_windows(id,account_id,live_member_id,starts_at,ends_at,opening_liability,opening_cap,policy_revision)
      VALUES($1,$2,NULL,clock_timestamp(),clock_timestamp()+interval '1 day',0,10,0),
            ($3,$4,'ticket-pool-member',clock_timestamp(),clock_timestamp()+interval '1 day',0,10,0)`,
      [ids.installationWindow, ids.installation, ids.memberWindow, ids.member]);
    await admin.query(`INSERT INTO budget_gateway_bindings(id,installation_account_id,member_account_id,live_member_id,endpoint_hash,credential_generation,
      key_fingerprint,agent,incarnation,native_team,native_user,purpose_alias,profile_hash,maximum_liability,pricing_profile,state)
      VALUES($1,$2,$3,'ticket-pool-member',$4,0,$5,'helper',$6,'proof-team','proof-user','standard',$7,1,'{}'::jsonb,'active')`,
      [ids.binding, ids.installation, ids.member, hash, hash, incarnation, hash]);
    await admin.query(`INSERT INTO budget_attempts(id,invocation_hash,ticket_hash,installation_account_id,member_account_id,binding_id,live_member_id,
      installation_window_id,member_window_id,endpoint_hash,credential_generation,installation_policy_generation,member_policy_generation,
      endpoint_generation,recovery_epoch,request_hash,authority_hash,profile_hash,reserved_amount,installation_cap_snapshot,member_cap_snapshot,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,'ticket-pool-member',$7,$8,$9,0,0,0,0,'epoch',$10,$11,$12,1,10,10,clock_timestamp()+interval '20 seconds')`,
      [ids.attempt, hash, ticketHash, ids.installation, ids.member, ids.binding, ids.installationWindow, ids.memberWindow, hash, hash, hash, hash]);

    const appStore = new PgBudgetAdmissionStore(app);
    const financialStore = new PgBudgetAdmissionStore(financial);
    await expect(appStore.discoverGatewayTicket(ticket)).rejects.toMatchObject({ code: "42501" });
    await expect(financialStore.discoverGatewayTicket(ticket)).resolves.toMatchObject({
      bindingId: ids.binding, agent: "helper", incarnation, purposeAlias: "standard", requestHash: hash,
    });
  });

  it("refuses PUBLIC and foreign column grants without repairing them", async () => {
    await admin.query("GRANT SELECT (display_name) ON public.orgs TO PUBLIC");
    try {
      await expectProvisionRefused();
      expect((await admin.query(`SELECT EXISTS (
        SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
        WHERE a.attrelid='public.orgs'::regclass AND a.attname='display_name' AND x.grantee=0 AND x.privilege_type='SELECT'
      ) AS remains`)).rows[0].remains).toBe(true);
    } finally { await admin.query("REVOKE SELECT (display_name) ON public.orgs FROM PUBLIC"); }

    await admin.query("CREATE ROLE privilege_probe_column NOLOGIN");
    try {
      await admin.query("GRANT SELECT (display_name) ON public.orgs TO privilege_probe_column");
      await expectProvisionRefused();
      expect((await admin.query("SELECT has_column_privilege('privilege_probe_column','public.orgs','display_name','SELECT') AS remains")).rows[0].remains).toBe(true);
    } finally {
      await admin.query("REVOKE SELECT (display_name) ON public.orgs FROM privilege_probe_column");
      await admin.query("DROP ROLE privilege_probe_column");
    }
  });

  it("refuses a SECURITY DEFINER engine function and a disabled engine trigger", async () => {
    await admin.query("ALTER FUNCTION public.update_history_images_are_digests(jsonb) SECURITY DEFINER");
    try {
      await expectProvisionRefused();
      expect((await admin.query("SELECT prosecdef AS enabled FROM pg_proc WHERE oid='public.update_history_images_are_digests(jsonb)'::regprocedure")).rows[0].enabled).toBe(true);
    } finally { await admin.query("ALTER FUNCTION public.update_history_images_are_digests(jsonb) SECURITY INVOKER"); }

    await admin.query("ALTER TABLE public.settings DISABLE TRIGGER settings_audit_trg");
    try {
      await expectProvisionRefused();
      expect((await admin.query("SELECT tgenabled FROM pg_trigger WHERE tgrelid='public.settings'::regclass AND tgname='settings_audit_trg'")).rows[0].tgenabled).toBe("D");
    } finally { await admin.query("ALTER TABLE public.settings ENABLE TRIGGER settings_audit_trg"); }
  });

  it("refuses weakened trigger conditions, altered column filters and trigger arguments", async () => {
    await admin.query("DROP TRIGGER budget_gateway_grant_immutable ON public.budget_gateway_grants");
    await admin.query(`CREATE TRIGGER budget_gateway_grant_immutable BEFORE UPDATE OR DELETE ON public.budget_gateway_grants
      FOR EACH ROW WHEN (false) EXECUTE FUNCTION public.budget_gateway_grant_immutable()`);
    try {
      await expectProvisionRefused();
      expect((await admin.query("SELECT tgqual IS NOT NULL AS remains FROM pg_trigger WHERE tgrelid='public.budget_gateway_grants'::regclass AND tgname='budget_gateway_grant_immutable'")).rows[0].remains).toBe(true);
    } finally {
      await admin.query("DROP TRIGGER budget_gateway_grant_immutable ON public.budget_gateway_grants");
      await admin.query("CREATE TRIGGER budget_gateway_grant_immutable BEFORE UPDATE OR DELETE ON public.budget_gateway_grants FOR EACH ROW EXECUTE FUNCTION public.budget_gateway_grant_immutable()");
    }

    await admin.query("DROP TRIGGER definition_agent_access_guard ON public.agent_definitions");
    await admin.query("CREATE TRIGGER definition_agent_access_guard AFTER UPDATE OF hash ON public.agent_definitions FOR EACH ROW EXECUTE FUNCTION public.invalidate_definition_agent_access()");
    try {
      await expectProvisionRefused();
      expect((await admin.query(`SELECT ARRAY(
        SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=t.tgrelid AND a.attnum=ANY(t.tgattr) ORDER BY a.attname
      ) AS columns FROM pg_trigger t WHERE t.tgrelid='public.agent_definitions'::regclass AND t.tgname='definition_agent_access_guard'`)).rows[0].columns).toEqual(["hash"]);
    } finally {
      await admin.query("DROP TRIGGER definition_agent_access_guard ON public.agent_definitions");
      await admin.query("CREATE TRIGGER definition_agent_access_guard AFTER UPDATE OF hash,status ON public.agent_definitions FOR EACH ROW EXECUTE FUNCTION public.invalidate_definition_agent_access()");
    }

    await admin.query("DROP TRIGGER budget_gateway_grant_immutable ON public.budget_gateway_grants");
    await admin.query(`CREATE TRIGGER budget_gateway_grant_immutable BEFORE UPDATE OR DELETE ON public.budget_gateway_grants
      FOR EACH ROW EXECUTE FUNCTION public.budget_gateway_grant_immutable('unexpected')`);
    try {
      await expectProvisionRefused();
      expect((await admin.query("SELECT tgnargs FROM pg_trigger WHERE tgrelid='public.budget_gateway_grants'::regclass AND tgname='budget_gateway_grant_immutable'")).rows[0].tgnargs).toBe(1);
    } finally {
      await admin.query("DROP TRIGGER budget_gateway_grant_immutable ON public.budget_gateway_grants");
      await admin.query("CREATE TRIGGER budget_gateway_grant_immutable BEFORE UPDATE OR DELETE ON public.budget_gateway_grants FOR EACH ROW EXECUTE FUNCTION public.budget_gateway_grant_immutable()");
    }
  });

  it("refuses unknown public types and schemas without removing them", async () => {
    await admin.query("CREATE TYPE public.privilege_probe_type AS (value text)");
    try {
      await expectProvisionRefused();
      expect((await admin.query("SELECT to_regtype('public.privilege_probe_type') IS NOT NULL AS remains")).rows[0].remains).toBe(true);
    } finally { await admin.query("DROP TYPE public.privilege_probe_type"); }

    await admin.query("CREATE SCHEMA privilege_probe_schema");
    try {
      await expectProvisionRefused();
      expect((await admin.query("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='privilege_probe_schema') AS remains")).rows[0].remains).toBe(true);
    } finally { await admin.query("DROP SCHEMA privilege_probe_schema"); }
  });

  it("refuses a foreign public-schema owner and preserves the owner until cleanup", async () => {
    await admin.query("CREATE ROLE privilege_probe_owner NOLOGIN");
    await admin.query("ALTER SCHEMA public OWNER TO privilege_probe_owner");
    try {
      await expectProvisionRefused();
      expect((await admin.query("SELECT r.rolname FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE n.nspname='public'")).rows[0].rolname).toBe("privilege_probe_owner");
    } finally {
      await admin.query("ALTER SCHEMA public OWNER TO lares_schema_owner");
      await admin.query("DROP ROLE privilege_probe_owner");
    }
  });

  it("refuses role-level guard settings and parameter grants without changing them", async () => {
    await admin.query("ALTER ROLE lares_app SET search_path TO public");
    try {
      await expectProvisionRefused();
      expect((await admin.query("SELECT EXISTS (SELECT 1 FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole WHERE r.rolname='lares_app') AS remains")).rows[0].remains).toBe(true);
    } finally { await admin.query("ALTER ROLE lares_app RESET search_path"); }

    await admin.query("GRANT SET ON PARAMETER session_replication_role TO lares_app");
    try {
      await expectProvisionRefused();
      expect((await admin.query(`SELECT EXISTS (
        SELECT 1 FROM pg_parameter_acl p CROSS JOIN LATERAL aclexplode(p.paracl) a
        WHERE p.parname='session_replication_role' AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname='lares_app')
      ) AS remains`)).rows[0].remains).toBe(true);
    } finally { await admin.query("REVOKE SET ON PARAMETER session_replication_role FROM lares_app"); }
  });

  it("refuses PUBLIC pg_control_system access and non-policy system-function grants", async () => {
    await admin.query("GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO PUBLIC");
    try {
      await expectProvisionRefused();
      expect((await admin.query(`SELECT EXISTS (
        SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
        WHERE p.oid='pg_catalog.pg_control_system()'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE'
      ) AS remains`)).rows[0].remains).toBe(true);
    } finally { await admin.query("REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM PUBLIC"); }

    await admin.query("GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO lares_app");
    try {
      await expectProvisionRefused();
      expect((await admin.query("SELECT has_function_privilege('lares_app','pg_catalog.pg_read_file(text)','EXECUTE') AS remains")).rows[0].remains).toBe(true);
    } finally { await admin.query("REVOKE EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) FROM lares_app"); }
  });

  it("refuses managed-role grants and defaults that could affect another object or database", async () => {
    await admin.query("GRANT lares_financial TO lares_app");
    try {
      await expectProvisionRefused();
      expect((await admin.query("SELECT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles g ON g.oid=m.member WHERE r.rolname='lares_financial' AND g.rolname='lares_app') AS remains")).rows[0].remains).toBe(true);
    } finally { await admin.query("REVOKE lares_financial FROM lares_app"); }

    await admin.query("ALTER DEFAULT PRIVILEGES FOR ROLE lares_schema_owner IN SCHEMA public GRANT SELECT ON TABLES TO lares_app");
    try {
      await expectProvisionRefused();
      expect((await admin.query("SELECT EXISTS (SELECT 1 FROM pg_default_acl WHERE defaclnamespace='public'::regnamespace) AS remains")).rows[0].remains).toBe(true);
    } finally { await admin.query("ALTER DEFAULT PRIVILEGES FOR ROLE lares_schema_owner IN SCHEMA public REVOKE SELECT ON TABLES FROM lares_app"); }
  });

  it("refuses ACL authority for a managed role in another database and leaves it there", async () => {
    await admin.query("CREATE DATABASE privilege_probe_external");
    const connection = new URL(container.getConnectionUri());
    connection.pathname = "/privilege_probe_external";
    const external = quietPool({ connectionString: connection.toString(), max: 1 });
    try {
      await external.query("GRANT CREATE ON SCHEMA public TO lares_app");
      await expectProvisionRefused();
      expect((await external.query("SELECT has_schema_privilege('lares_app','public','CREATE') AS remains")).rows[0].remains).toBe(true);
    } finally {
      await external.end();
      await admin.query("DROP DATABASE privilege_probe_external");
    }
  });

  it("rejects unapproved database and role operations without exposing database details", async () => {
    const operator = await admin.connect();
    try {
      await expectDenied(() => app.query("CREATE DATABASE role_probe_database"));
      await admin.query("CREATE ROLE privilege_probe_unrelated LOGIN PASSWORD 'unrelated-role-test-password-0123456789' NOSUPERUSER NOCREATEDB NOCREATEROLE");
      const connection = new URL(container.getConnectionUri());
      connection.username = "privilege_probe_unrelated";
      connection.password = "unrelated-role-test-password-0123456789";
      const unrelated = quietPool({ connectionString: connection.toString(), max: 1 });
      try { await expectDenied(() => unrelated.query("SELECT 1")); }
      finally {
        await unrelated.end();
        await admin.query("DROP ROLE privilege_probe_unrelated");
      }
      await expect(provisionEngineDatabasePrivileges(operator, {
        expectedDatabase: "wrong-database",
        passwords: { application: appPassword, financial: financialPassword },
      })).rejects.toThrow("Database privilege setup could not be confirmed; inspect the database before retrying.");
    } finally { operator.release(); }
  });
});
