import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PgMemberStore } from "@lares/agent-kit/member-store";
import { poolFromEnv } from "../lib/db.js";

function setting(source: string, name: string): string {
  const matches = source.split(/\r?\n/).flatMap(line => {
    const candidate = line.trimStart();
    if (!new RegExp(`^${name}(?:$|=|\\s)`).test(candidate)) return [];
    if (candidate !== line || !line.startsWith(`${name}=`)) throw new Error("installation setting is malformed");
    return [line];
  });
  if (matches.length !== 1) throw new Error("installation setting is missing or duplicated");
  const raw = matches[0]!.slice(name.length + 1);
  if (!raw.startsWith("'")) {
    if (/[\s\0\r\n]/.test(raw)) throw new Error("installation setting is malformed");
    return raw;
  }
  let value = "";
  for (let i = 1; i < raw.length;) {
    if (raw[i] !== "'") { value += raw[i]!; i++; continue; }
    if (raw.slice(i, i + 4) === "'\\''") { value += "'"; i += 4; continue; }
    if (i === raw.length - 1) return value;
    throw new Error("installation setting is malformed");
  }
  throw new Error("installation setting is malformed");
}

function authoritativeContext(envFile: string, keeperFile: string): { ownerId: string; organisationId: string } {
  const settings = readFileSync(envFile, "utf8");
  const ownerId = setting(settings, "LARES_OWNER_ID");
  const organisationId = setting(settings, "LARES_DOMAIN");
  if (!ownerId.trim() || !/^[a-z0-9.-]+$/.test(organisationId) || !organisationId.includes("."))
    throw new Error("installation settings are invalid");
  const keeper: unknown = JSON.parse(readFileSync(keeperFile, "utf8"));
  if (!keeper || typeof keeper !== "object" || Array.isArray(keeper) ||
      (keeper as Record<string, unknown>).designatedOwnerId !== ownerId)
    throw new Error("Keeper owner differs from installation settings");
  return { ownerId, organisationId };
}

export async function main(
  env: NodeJS.ProcessEnv,
  store: Pick<PgMemberStore, "firstOwnerBootstrapEligible">,
): Promise<number> {
  try {
    const envFile = env.LARES_INSTALLATION_ENV_FILE;
    const keeperFile = env.LARES_KEEPER_CONFIG_FILE;
    if (!envFile || !keeperFile) throw new Error("configured installation files are missing");
    const { ownerId, organisationId } = authoritativeContext(envFile, keeperFile);
    if (!await store.firstOwnerBootstrapEligible(ownerId, organisationId)) {
      process.stderr.write("owner bootstrap preflight refused; no configuration was changed\n");
      return 1;
    }
    process.stdout.write("owner bootstrap preflight passed\n");
    return 0;
  } catch {
    process.stderr.write("owner bootstrap preflight unavailable or invalid; no configuration was changed\n");
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = poolFromEnv({
    max: 1,
    connectionTimeoutMillis: 5_000,
    lock_timeout: 5_000,
    statement_timeout: 10_000,
    query_timeout: 12_000,
  });
  main(process.env, new PgMemberStore(pool))
    .then(code => { process.exitCode = code; })
    .finally(() => pool.end());
}
