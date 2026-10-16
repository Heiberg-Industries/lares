import { fileURLToPath } from "node:url";
import { poolFromEnv } from "../lib/db.js";
import {
  initializeInstallationSettings,
  type TransactionPool,
} from "../lib/installation-settings.js";

const HELP = [
  "pnpm -C services/box installation-settings [--help]",
  "",
  "Initializes the missing settings required by the first-agent screen. Existing settings are",
  "preserved. Database access comes from PG* plus DATABASE_PASSWORD_FILE or PGPASSWORD.",
].join("\n");

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function main(
  argv: readonly string[],
  deps: { db: TransactionPool; out: (message: string) => void },
): Promise<number> {
  if (argv.some((arg) => arg !== "--help" && arg !== "--")) {
    deps.out("installation settings: unknown argument. The only flag is --help.");
    return 1;
  }
  if (argv.includes("--help")) {
    deps.out(HELP);
    return 0;
  }

  try {
    const result = await initializeInstallationSettings(deps.db);
    const disposition = result.initialized.length > 0
      ? `initialized ${result.initialized.join(", ")}; preserved any existing values`
      : "both settings already existed and were preserved";
    deps.out(
      `installation settings ready: models.alias_prefix=${result.aliasPrefix}; ` +
        `agents.ceiling=${result.agentCeiling} (${disposition}).`,
    );
    return 0;
  } catch (error) {
    deps.out(`installation settings refused: ${messageOf(error)}. Nothing else was applied.`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = poolFromEnv();
  main(process.argv.slice(2), { db: pool, out: (message) => process.stdout.write(`${message}\n`) })
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.stdout.write("installation settings refused: the command failed unexpectedly.\n");
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
