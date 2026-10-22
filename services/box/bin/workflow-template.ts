import { readFileSync } from "node:fs";
import { Pool, type QueryResultRow } from "pg";
import { applyWorkflowRuntimePrivileges, verifyWorkflowRuntimePrivileges } from "../lib/workflow-database-privileges.js";

const PROVISIONER = "lares_workflow_provisioner";
const OWNER = "lares_workflow_owner";
const RUNTIME = "lares_workflow";

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

async function run(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "apply" && mode !== "verify" && mode !== "verify-database") throw new Error("workflow template: choose apply, verify, or verify-database");
  const database = mode === "verify-database" ? option("--database") : "empty_workflow";
  if (!/^lares_[a-f0-9]{32}$/.test(database) && database !== "empty_workflow") throw new Error("workflow template: unsupported database identity");
  const host = option("--host");
  const port = Number(option("--port"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("workflow template: invalid database port");
  const runtimePool = new Pool({
    host, port, database, user: RUNTIME,
    password: password(option("--runtime-password-file")), max: 1, connectionTimeoutMillis: 5000,
  });
  const provisionerPool = mode === "verify-database" ? undefined : new Pool({
    host, port, database, user: PROVISIONER,
    password: password(option("--provisioner-password-file")), max: 1, connectionTimeoutMillis: 5000,
  });
  try {
    if (mode === "apply") {
      await identity(provisionerPool!, PROVISIONER, database);
      const owner = await provisionerPool!.connect();
      try {
        await owner.query(`SET ROLE "${OWNER}"`);
        const current = await owner.query<{ current_user: string; session_user: string }>("SELECT current_user,session_user");
        if (current.rows[0]?.current_user !== OWNER || current.rows[0]?.session_user !== PROVISIONER)
          throw new Error("workflow template: provisioner could not prove its explicit schema-owner role");
        await applyWorkflowRuntimePrivileges(owner);
      } finally {
        // Never return a role-switched connection to pg's pool.
        try { await owner.query("RESET ROLE"); } finally { owner.release(); }
      }
      await identity(provisionerPool!, PROVISIONER, database);
    }
    await identity(runtimePool, RUNTIME, database);
    await verifyWorkflowRuntimePrivileges(runtimePool);
    process.stdout.write(`workflow template: ${mode === "apply" ? "runtime privileges prepared and verified" : "runtime privileges verified"}\n`);
  } finally {
    await Promise.all([provisionerPool?.end(), runtimePool.end()]);
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "workflow template setup failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
