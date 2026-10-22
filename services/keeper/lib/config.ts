import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Pool,type PoolConfig } from "pg";
import { z } from "zod";
import { lifecycleSchema } from "./lifecycle-config.js";
import { credentialConfigSchema } from "./credential-state.js";
const absolute = z.string().refine(isAbsolute, "must be an absolute path");
const databaseConnectionSchema = z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65535), database: z.string().min(1), user: z.string().min(1), passwordFile: absolute }).strict();
export type KeeperDatabaseConfig = z.infer<typeof databaseConnectionSchema>;
export const financialCustodyConfigSchema=z.object({directory:z.literal('/var/lib/lares/budget-financial'),db:databaseConnectionSchema.extend({user:z.literal('lares_financial')})}).strict();
export const nativeCustodyConfigSchema=z.object({directory:z.literal('/var/lib/lares/budget-native')}).strict();
const configSchema = z.object({
  lifecycle: lifecycleSchema.optional(),
  /** Trusted identity written by the installer from the same ownerId used in role bindings.
   * Older keeper configs may omit it; member removal then refuses closed. */
  designatedOwnerId: z.string().min(1).max(128).optional(),
  budgetFinancial: financialCustodyConfigSchema.optional(),
  budgetNative: nativeCustodyConfigSchema.optional(),
  credentials: credentialConfigSchema.optional(),
  publicDoorOrigin: z.string().url().optional(),
  // Optional protected gateway service key only. No recovery bypass or console copy.
  gatewayBudget: z.object({serviceKeyFile:absolute}).strict().optional(),
  // Optional installer-owned Vault signer. Kept separate from the Keeper's writable secrets
  // directory so the same protected file is never copied into role custody.
  vaultConsoleSigningKeyFile: absolute.optional(),
  // Separate optional Console signer for model-purpose receipts; never derived from Vault.
  modelPurposeConsoleSigningKeyFile: absolute.optional(),
  // Dedicated runtime socket directory on the shared host socket mount. Only the chief receives it.
  modelPurposeRuntimeDir: absolute.optional(),
  mode: z.enum(["overlay", "rendered"]), project: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  dir: absolute, files: z.array(z.string().min(1).refine(s => !s.includes("\u0000"))).min(1),
  agentsDir: absolute, retiredDir: absolute, secretsDir: absolute,
  rolesDir: absolute, templatesDir: absolute, backupDir: absolute,
  db: databaseConnectionSchema.extend({user:z.literal('lares_app')}),
}).strict().superRefine((value,context)=>{
  if(value.budgetNative&&!value.budgetFinancial)context.addIssue({code:'custom',path:['budgetNative'],message:'requires prepared financial custody'});
  if(value.budgetFinancial&&(value.budgetFinancial.db.host!==value.db.host||value.budgetFinancial.db.port!==value.db.port||value.budgetFinancial.db.database!==value.db.database))context.addIssue({code:'custom',path:['budgetFinancial','db'],message:'must connect to the same engine database as db'});
  if(Boolean(value.modelPurposeConsoleSigningKeyFile)!==Boolean(value.modelPurposeRuntimeDir))context.addIssue({code:'custom',path:['modelPurposeRuntimeDir'],message:'requires the configured Console model-purpose signer'});
});
export type KeeperConfig = z.infer<typeof configSchema>;
/**
 * Loads the file the keeper boots from. Three failures, three different sentences,
 * none of which echoes a value from the file:
 *  - the file is missing or unreadable: the path and the system's error code;
 *  - the file is not JSON: the path only. Node's own SyntaxError quotes the offending text,
 *    which could be a secret somebody pasted in, so it is deliberately NOT repeated;
 *  - the file does not fit the schema: the path and, per problem, the field's dotted path and
 *    the schema's reason. The reasons name types, bounds and unrecognized KEY names, never
 *    the value that was there.
 */
export function loadKeeperConfig(path = "/etc/lares/keeper.json"): KeeperConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unreadable";
    throw new Error(`keeper: configuration file ${path} is missing or unreadable (${code})`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  }
  catch {
    throw new Error(`keeper: configuration file ${path} is not valid JSON`);
  }
  const parsed = configSchema.safeParse(data);
  if (parsed.success)
    return parsed.data;
  const problems = parsed.error.issues.slice(0, 10).map(issue => issue.path[0] === "credentials"
    ? "credentials: invalid credential preparation; review the named slot, administrator and consumer inventory"
    : `${issue.path.length ? issue.path.map(String).join(".") : "(top level)"}: ${issue.message}`);
  const more = parsed.error.issues.length > 10 ? `; and ${parsed.error.issues.length - 10} more` : "";
  throw new Error(`keeper: invalid configuration in ${path}: ${problems.join("; ")}${more}`);
}
export function keeperPool(db: KeeperDatabaseConfig,limits:Pick<PoolConfig,'max'|'connectionTimeoutMillis'|'query_timeout'|'options'>={}): Pool {
  try {
    const password = readFileSync(db.passwordFile, "utf8").trimEnd();
    if (!password) throw new Error("empty database credential");
    return new Pool({ host: db.host, port: db.port, database: db.database, user: db.user, password, connectionTimeoutMillis: 5000,...limits });
  }
  catch {
    throw new Error("keeper: database credentials unavailable");
  }
}
export function keeperFinancialPool(config: Pick<KeeperConfig, 'budgetFinancial'>, limits: Pick<PoolConfig,'max'|'connectionTimeoutMillis'|'query_timeout'|'options'> = {}): Pool | undefined {
  return config.budgetFinancial ? keeperPool(config.budgetFinancial.db, limits) : undefined;
}
