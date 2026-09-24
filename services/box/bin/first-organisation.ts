import { fileURLToPath } from "node:url";
import { poolFromEnv } from "../lib/db.js";
import { enrolFirstOrganisation } from "../lib/first-organisation.js";

export async function main(
  argv: readonly string[],
  deps: { db: Parameters<typeof enrolFirstOrganisation>[0]; env: NodeJS.ProcessEnv; out: (message: string) => void },
): Promise<number> {
  if (argv.includes("--help") && argv.every((arg) => arg === "--help" || arg === "--")) {
    deps.out("first-organisation: enrol the first owner using LARES_OWNER_ID, LARES_OWNER_EMAIL and LARES_DOMAIN");
    return 0;
  }
  if (argv.some((arg) => arg !== "--")) {
    deps.out("first-organisation: unknown argument");
    return 1;
  }
  const ownerId = deps.env.LARES_OWNER_ID;
  const ownerEmail = deps.env.LARES_OWNER_EMAIL;
  const domain = deps.env.LARES_DOMAIN;
  if (!ownerId || !ownerEmail || !domain) {
    deps.out("first-organisation: owner id, email and domain are required; nothing changed");
    return 1;
  }
  try {
    const outcome = await enrolFirstOrganisation(deps.db, { ownerId, ownerEmail, domain });
    deps.out(outcome === "created"
      ? `first organisation ${domain} created; ${ownerId} is its owner`
      : `first organisation ${domain} already enrolled; nothing changed`);
    return 0;
  } catch (error) {
    deps.out(`first-organisation refused: ${error instanceof Error ? error.message : String(error)}; nothing changed`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = poolFromEnv();
  main(process.argv.slice(2), { db: pool, env: process.env, out: (message) => process.stdout.write(`${message}\n`) })
    .then((code) => { process.exitCode = code; })
    .finally(() => pool.end());
}
