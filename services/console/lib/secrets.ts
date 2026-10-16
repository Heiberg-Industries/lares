// services/console/lib/secrets.ts
// File-first secret resolution: <NAME>_FILE (file contents) wins over <NAME> (plain env).
// Matches the PGPASSWORD_FILE pattern in lib/db.ts so secrets can be mounted, not env-baked.
import { readFileSync } from "node:fs";

export function readSecret(name: string): string | undefined {
  const file = process.env[`${name}_FILE`];
  if (file) {
    try {
      return readFileSync(file, "utf8").trim();
    } catch {
      return undefined;
    }
  }
  return process.env[name];
}
