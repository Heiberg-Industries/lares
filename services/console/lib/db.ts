import { Pool, type PoolConfig } from "pg";
import { readFileSync } from "node:fs";

export function databasePoolConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const passwordFile = env.PGPASSWORD_FILE;
  if (!passwordFile) throw new Error("application database password file is not configured");
  let password: string;
  try { password = readFileSync(passwordFile, "utf8").trim(); }
  catch { throw new Error("application database password file is unavailable"); }
  if (!password) throw new Error("application database password file is blank");

  return {
    host: env.PGHOST ?? "db",
    port: Number(env.PGPORT ?? "5432"),
    database: env.PGDATABASE ?? "lares_state",
    user: env.PGUSER ?? "lares_app",
    password,
  };
}

let configuredPool: Pool | undefined;
function activePool(): Pool {
  configuredPool ??= new Pool(databasePoolConfig());
  return configuredPool;
}

// Next can import server modules while collecting routes during a build, when the runtime
// secret is intentionally absent. Defer reading it until database access; the first query
// then fails closed before opening a connection if the explicit file is unavailable.
export const pool = new Proxy({} as Pool, {
  get(_target, property) {
    const current = activePool();
    const value = Reflect.get(current, property, current) as unknown;
    return typeof value === "function" ? value.bind(current) : value;
  },
});
