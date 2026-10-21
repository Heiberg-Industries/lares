// Small Postgres connection helper for the agent box.
// The password is read from DATABASE_PASSWORD_FILE (default /run/secrets/database-password —
// the name every agent, start.sh and compose-agents.ts already use), falling back to
// /run/secrets/db_password for an older installation whose compose file was not written by
// this engine, and finally to PGPASSWORD for local/dev use. Everything else comes from
// PG* env (see .env.example). No secret is ever hard-coded here.
import { readFileSync } from "node:fs";
import { Pool, type PoolConfig } from "pg";

/** Minimal structural query interface. pg.Pool satisfies this, as does any test double.
 *  Lets callers in vendor-neutral `lib/` code type a DB handle without importing "pg". */
export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<R = any>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

const DEFAULT_SECRET_PATH = "/run/secrets/database-password";
// An older installation's spelling, kept as a last-resort fallback: such a compose file mounts
// the Docker secret under this exact name, and the engine cannot edit a compose file it did not
// write. Remove it once no installation uses the old name, which every other reader has dropped.
const LEGACY_SECRET_PATH = "/run/secrets/db_password";

/** Where the password may be found. Injectable so a test never depends on a path that exists
 *  on the live box and not on a laptop — the same discipline `checkSettings` uses for files. */
export interface DatabasePasswordPaths {
  /** Used when DATABASE_PASSWORD_FILE is unset. */
  readonly primaryDefault?: string;
  /** The older spelling (see LEGACY_SECRET_PATH). */
  readonly legacy?: string;
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

/** DATABASE_PASSWORD_FILE → the legacy path → PGPASSWORD. Exported so every step of that
 *  order can be tested against temp files instead of the real /run/secrets. */
export function readDatabasePassword(
  env: NodeJS.ProcessEnv,
  paths: DatabasePasswordPaths = {},
): string | undefined {
  const primary = env.DATABASE_PASSWORD_FILE ?? paths.primaryDefault ?? DEFAULT_SECRET_PATH;
  const legacy = paths.legacy ?? LEGACY_SECRET_PATH;
  const fromEnv = env.PGPASSWORD?.trim() === "" ? undefined : env.PGPASSWORD;
  return fileValue(primary) ?? fileValue(legacy) ?? fromEnv;
}

/** Build a Pool from env (PGHOST/PGPORT/PGDATABASE/PGUSER + the secret-file password). */
export function poolFromEnv(overrides: PoolConfig = {}, env: NodeJS.ProcessEnv = process.env): Pool {
  return new Pool({
    host: env.PGHOST ?? "db",
    port: Number(env.PGPORT ?? 5432),
    database: env.PGDATABASE ?? "lares_state",
    user: env.PGUSER ?? "lares",
    password: readDatabasePassword(env),
    ...overrides,
  });
}

/** Build a Pool from a single connection string (used by tests). */
export function poolFromUrl(connectionString: string): Pool {
  return new Pool({ connectionString });
}
