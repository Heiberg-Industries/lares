// Small Postgres connection helper for the agent box. The application credential is read
// only from DATABASE_PASSWORD_FILE (default /run/secrets/database-password); it never falls
// back to a legacy secret name or a password-valued environment variable.
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Pool, type PoolConfig } from "pg";

/** Minimal structural query interface. pg.Pool satisfies this, as does any test double.
 *  Lets callers in vendor-neutral `lib/` code type a DB handle without importing "pg". */
export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<R = any>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

const DEFAULT_SECRET_PATH = "/run/secrets/database-password";
/** Where the password may be found. Injectable so tests never depend on a live secret path. */
export interface DatabasePasswordPaths {
  /** Used when DATABASE_PASSWORD_FILE is unset. */
  readonly primaryDefault?: string;
}

/** A blank file is NOT a password. The rule the console's secret read already learned
 *  (WAVE-3-NOTES 24): treat empty as absent, and never let a broken file skip a good value. */
function fileValue(path: string): string | undefined {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

/** Read only the explicit secret file; missing or blank files fail authentication closed. */
export function readDatabasePassword(
  env: NodeJS.ProcessEnv,
  paths: DatabasePasswordPaths = {},
): string | undefined {
  const primary = env.DATABASE_PASSWORD_FILE ?? paths.primaryDefault ?? DEFAULT_SECRET_PATH;
  return fileValue(primary);
}

/** Build a Pool from env (PGHOST/PGPORT/PGDATABASE/PGUSER + the secret-file password). */
export function poolFromEnv(overrides: PoolConfig = {}, env: NodeJS.ProcessEnv = process.env): Pool {
  const password = readDatabasePassword(env);
  if (password === undefined) {
    throw new Error("application database password file is missing or blank");
  }
  return new Pool({
    host: env.PGHOST ?? "db",
    port: Number(env.PGPORT ?? 5432),
    database: env.PGDATABASE ?? "lares_state",
    user: env.PGUSER ?? "lares_app",
    password,
    ...overrides,
  });
}

/** Create an offline administrator pool from one explicit host-only secret path, then prove
 * the actual PostgreSQL login and target database before handing the pool to a CLI. This helper
 * intentionally has no default path and never reads ambient PGUSER/PGPASSWORD values. */
export async function operatorPoolFromFile(
  passwordFile: string,
  target: { host: string; port: number; database: string },
): Promise<Pool> {
  if (!isAbsolute(passwordFile)) throw new Error("offline operator password path must be absolute");
  let password: string;
  try {
    const stat = lstatSync(passwordFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o777) !== 0o600) throw new Error();
    password = readFileSync(passwordFile, "utf8").trim();
  } catch {
    throw new Error("offline operator password file is unavailable or not root-only mode 0600");
  }
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(password)) throw new Error("offline operator password file has an unsupported value");
  const pool = new Pool({
    host: target.host,
    port: target.port,
    database: target.database,
    user: "lares_operator",
    password,
    max: 1,
    connectionTimeoutMillis: 5_000,
  });
  try {
    const result = await pool.query<{ session_user: string; current_user: string; database: string; superuser: boolean }>(
      "SELECT session_user,current_user,current_database() AS database,r.rolsuper AS superuser FROM pg_roles r WHERE r.rolname=session_user",
    );
    const identity = result.rows[0];
    if (identity?.session_user !== "lares_operator" || identity.current_user !== "lares_operator" || identity.database !== target.database || identity.superuser !== true)
      throw new Error("explicit lares_operator identity check failed");
    return pool;
  } catch {
    await pool.end().catch(() => undefined);
    throw new Error("offline operator login or target database could not be verified");
  }
}

/** Build a Pool from a single connection string (used by tests). */
export function poolFromUrl(connectionString: string): Pool {
  return new Pool({ connectionString });
}
