import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { applyWorkflowRuntimePrivileges, verifyWorkflowRuntimePrivileges } from "../lib/workflow-database-privileges.js";

const PROVISIONER = "lares_workflow_provisioner";
const OWNER = "lares_workflow_owner";
const RUNTIME = "lares_workflow";
const OPERATOR = "lares_operator";
const TEMPLATE = "empty_workflow";
const ENGINE = "lares_state";
const STORE = /^lares_[a-f0-9]{32}$/;
const AGENT = /^[a-z][a-z0-9-]{1,30}$/;
const MODES = ["apply", "apply-database", "verify", "verify-database", "update-plan"] as const;
type Mode = (typeof MODES)[number];

/** A refusal the operator can act on, as opposed to a fault. Both stop the caller. */
class Refused extends Error {}

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? "" : process.argv[index + 1] ?? "";
  if (!value || value.startsWith("--")) throw new Error(`workflow template: ${name} needs a value`);
  return value;
}

function password(path: string): string {
  const value = readFileSync(path, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(value)) throw new Error("workflow template: credential file is empty or has an unsupported format");
  return value;
}

async function identity(pool: Pool, expectedUser: string, database: string): Promise<void> {
  const result = await pool.query<{ current_user: string; session_user: string; database: string }>(
    "SELECT current_user,session_user,current_database() AS database",
  );
  const row = result.rows[0];
  if (row?.current_user !== expectedUser || row.session_user !== expectedUser || row.database !== database)
    throw new Error("workflow template: the database login did not prove its expected identity");
}

/**
 * What an update is allowed to touch, read as the operator and changing nothing: the workflow
 * template and every agent store, each proven to be one this installation owns. Prints one line
 * per database (`template<TAB>empty_workflow`, `store<TAB><database><TAB><agent>`), or refuses
 * with a plain reason. It also refuses a database time zone other than UTC, because the workflow
 * package's schema step rewrites every stored time on any other setting. With --require-quiet it
 * first proves that nothing else is connected to any of those databases.
 */
async function updatePlan(host: string, port: number): Promise<void> {
  const operatorPassword = password(option("--operator-password-file"));
  const requireQuiet = process.argv.includes("--require-quiet");
  const open = (database: string) => new Pool({ host, port, database, user: OPERATOR, password: operatorPassword, max: 1, connectionTimeoutMillis: 5000 });
  const admin = open("postgres");
  const engine = open(ENGINE);
  try {
    const self = (await admin.query<{ user_name: string; current_user: string; superuser: boolean; database: string }>(
      "SELECT session_user AS user_name,current_user,r.rolsuper AS superuser,current_database() AS database FROM pg_roles r WHERE r.rolname=session_user")).rows[0];
    if (self?.user_name !== OPERATOR || self.current_user !== OPERATOR || self.superuser !== true || self.database !== "postgres")
      throw new Error("workflow template: explicit lares_operator identity check failed while reading the agent stores");

    const databases = (await admin.query<{ name: string; owner: string; is_template: boolean; allow_connections: boolean; marker: string | null }>(`
      SELECT d.datname AS name,pg_get_userbyid(d.datdba) AS owner,d.datistemplate AS is_template,d.datallowconn AS allow_connections,
        shobj_description(d.oid,'pg_database') AS marker
      FROM pg_database d WHERE d.datname=$1 OR d.datname ~ '^lares_[0-9a-f]{32}$' ORDER BY d.datname
    `, [TEMPLATE])).rows;
    const template = databases.find((row) => row.name === TEMPLATE);
    if (!template) throw new Refused("this server has no workflow template database, so its agent stores were not left by the previous release");
    if (template.owner !== OWNER || !template.is_template || !template.allow_connections)
      throw new Refused("the workflow template database is not in the state the previous release left it in (owner or template marking)");
    const stores = new Map(databases.filter((row) => row.name !== TEMPLATE).map((row) => [row.name, row]));

    const resources = (await engine.query<{ name: string; workflow_database: string; ownership: string; ownership_token: string | null; state: string }>(
      "SELECT name,workflow_database,ownership,ownership_token::text AS ownership_token,state FROM agent_resources ORDER BY name")).rows;
    const planned: Array<{ database: string; agent: string }> = [];
    const claimed = new Set<string>();
    for (const row of resources) {
      if (!AGENT.test(row.name) || !STORE.test(row.workflow_database))
        throw new Refused("an agent record names an agent or a store in a form this update does not know");
      if (row.ownership !== "owned")
        throw new Refused(`agent ${row.name} has a store this installation does not own (${row.ownership}), so this update will not change it. An operator has to settle who owns that store before this server can take this release`);
      if (claimed.has(row.workflow_database)) throw new Refused(`two agent records name the same store (${row.workflow_database})`);
      claimed.add(row.workflow_database);
      const database = stores.get(row.workflow_database);
      if (row.state === "deleting") {
        if (database) throw new Refused(`agent ${row.name} is half removed: its store still exists. Finish removing it, then run the update again`);
        continue;
      }
      // A retired agent keeps its store so that it can be brought back; it is upgraded like any other.
      if (row.state !== "ready" && row.state !== "provisioning" && row.state !== "retired") throw new Refused(`agent ${row.name} is in a state this update does not know (${row.state})`);
      if (!database)
        throw new Refused(`agent ${row.name} has no store on this server: it was never finished. Finish it with: sudo lares agent start ${row.name}, or remove it in the console, then run the update again`);
      if (database.owner !== OWNER || database.is_template || !database.allow_connections || !row.ownership_token || database.marker !== `lares-owned:${row.ownership_token}`)
        throw new Refused(`the store of agent ${row.name} does not carry this installation's ownership marker`);
      planned.push({ database: row.workflow_database, agent: row.name });
    }
    for (const name of stores.keys()) {
      if (!claimed.has(name)) throw new Refused(`database ${name} looks like an agent store but no agent record names it, so I cannot prove this installation owns it`);
    }
    planned.sort((a, b) => a.database < b.database ? -1 : a.database > b.database ? 1 : 0);
    const targets = [TEMPLATE, ...planned.map((entry) => entry.database)];

    if (requireQuiet) {
      const busy = (await admin.query<{ database: string; sessions: number }>(`
        SELECT datname AS database,count(*)::int AS sessions FROM pg_stat_activity
        WHERE datname=ANY($1::text[]) AND pid<>pg_backend_pid() AND backend_type='client backend' GROUP BY datname ORDER BY datname
      `, [targets])).rows;
      if (busy.length) throw new Refused(`something is still connected to ${busy.map((row) => `${row.database} (${row.sessions})`).join(", ")}`);
    }

    const settings = (await admin.query<{ database: string; role: string; setting: string }>(`
      SELECT COALESCE(d.datname,'every database') AS database,COALESCE(r.rolname,'every login') AS role,split_part(cfg,'=',1) AS setting
      FROM pg_db_role_setting s LEFT JOIN pg_database d ON d.oid=s.setdatabase LEFT JOIN pg_roles r ON r.oid=s.setrole
      CROSS JOIN LATERAL unnest(s.setconfig) AS cfg
      WHERE lower(split_part(cfg,'=',1)) IN ('timezone','workflow.legacy_timezone')
        AND (s.setdatabase=0 OR d.datname=ANY($1::text[])) AND (s.setrole=0 OR r.rolname=ANY($2::text[]))
    `, [targets, [OWNER, PROVISIONER, RUNTIME]])).rows;
    if (settings.length) {
      const first = settings[0]!;
      throw new Refused(`a time zone setting (${first.setting}) is stored for ${first.database} and ${first.role}, so stored times may not be UTC. This release only upgrades agent stores on UTC: the upgrade rewrites how every stored time is kept, and that is only proven on UTC. Stay on your current release for now, and do not change the database's time zone yourself: that would move the times already stored`);
    }
    for (const database of targets) {
      const pool = open(database);
      try {
        const zone = (await pool.query<{ zone: string; legacy: string | null }>(
          "SELECT current_setting('TimeZone') AS zone,current_setting('workflow.legacy_timezone',true) AS legacy")).rows[0];
        if (!zone || (zone.zone !== "UTC" && zone.zone !== "Etc/UTC") || (zone.legacy ?? "") !== "")
          throw new Refused(`the database is set to time zone ${zone?.legacy || zone?.zone || "unknown"}, not UTC. This release only upgrades agent stores on UTC: the upgrade rewrites how every stored time is kept, and that is only proven on UTC. Stay on your current release for now, and do not change the database's time zone yourself: that would move the times already stored`);
      } finally {
        await pool.end();
      }
    }

    process.stdout.write(`template\t${TEMPLATE}\n`);
    for (const entry of planned) process.stdout.write(`store\t${entry.database}\t${entry.agent}\n`);
  } finally {
    await Promise.all([admin.end(), engine.end()]);
  }
}

async function run(): Promise<void> {
  const mode = process.argv[2] as Mode;
  if (!MODES.includes(mode)) throw new Error("workflow template: choose apply, apply-database, verify, verify-database, or update-plan");
  const host = option("--host");
  const port = Number(option("--port"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("workflow template: invalid database port");
  if (mode === "update-plan") {
    await updatePlan(host, port);
    return;
  }
  // `apply` and `verify` are the template; the -database modes name one agent store, or the
  // template for a verify.
  const applying = mode === "apply" || mode === "apply-database";
  const database = mode === "apply-database" || mode === "verify-database" ? option("--database") : TEMPLATE;
  if (mode === "apply-database" ? !STORE.test(database) : !STORE.test(database) && database !== TEMPLATE)
    throw new Error("workflow template: unsupported database identity");
  const runtimePool = new Pool({
    host, port, database, user: RUNTIME,
    password: password(option("--runtime-password-file")), max: 1, connectionTimeoutMillis: 5000,
  });
  const provisionerPool = !applying ? undefined : new Pool({
    host, port, database, user: PROVISIONER,
    password: password(option("--provisioner-password-file")), max: 1, connectionTimeoutMillis: 5000,
  });
  try {
    if (applying) {
      await identity(provisionerPool!, PROVISIONER, database);
      const owner = await provisionerPool!.connect();
      try {
        // One transaction: the list first takes away every function right, then gives the listed ones
        // back, and an agent running meanwhile (an update) must see the old list or the new one.
        await owner.query("BEGIN");
        // An agent's transaction can hold a queue table the list needs (a missing row policy is
        // created with a lock no reader may share): wait at most this long, then give up unchanged.
        await owner.query("SET LOCAL lock_timeout = '10s'");
        const ownership = await owner.query<{ owner: string }>("SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=current_database()");
        if (ownership.rows[0]?.owner !== OWNER) throw new Error("workflow template: this database is not owned by the workflow owner role");
        await owner.query(`SET ROLE "${OWNER}"`);
        const current = await owner.query<{ current_user: string; session_user: string }>("SELECT current_user,session_user");
        if (current.rows[0]?.current_user !== OWNER || current.rows[0]?.session_user !== PROVISIONER)
          throw new Error("workflow template: provisioner could not prove its explicit schema-owner role");
        await applyWorkflowRuntimePrivileges(owner);
        await owner.query("COMMIT");
      } catch (error) {
        await owner.query("ROLLBACK").catch(() => undefined);
        if ((error as { code?: string }).code === "55P03")
          throw new Refused("the store was busy: something held a table this change needs for more than 10 seconds, so nothing was changed on it. Run the same command again");
        throw error;
      } finally {
        // Never return a role-switched connection to pg's pool.
        try { await owner.query("RESET ROLE"); } finally { owner.release(); }
      }
      await identity(provisionerPool!, PROVISIONER, database);
    }
    await identity(runtimePool, RUNTIME, database);
    await verifyWorkflowRuntimePrivileges(runtimePool);
    process.stdout.write(`workflow template: ${applying ? "runtime privileges prepared and verified" : "runtime privileges verified"}\n`);
  } finally {
    await Promise.all([provisionerPool?.end(), runtimePool.end()]);
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "workflow template setup failed";
  process.stderr.write(error instanceof Refused ? `workflow stores: ${message}\n` : `${message}\n`);
  process.exitCode = 1;
});
