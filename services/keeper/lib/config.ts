import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Pool } from "pg";
import { z } from "zod";
import { lifecycleSchema } from "./lifecycle-config.js";
const absolute = z.string().refine(isAbsolute, "must be an absolute path");
const configSchema = z.object({
  lifecycle: lifecycleSchema.optional(),
  publicDoorOrigin: z.string().url().optional(),
  mode: z.enum(["overlay", "rendered"]), project: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  dir: absolute, files: z.array(z.string().min(1).refine(s => !s.includes("\u0000"))).min(1),
  agentsDir: absolute, retiredDir: absolute, secretsDir: absolute,
  rolesDir: absolute, templatesDir: absolute, backupDir: absolute,
  db: z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65535), database: z.string().min(1), user: z.string().min(1), passwordFile: absolute }).strict(),
}).strict();
export type KeeperConfig = z.infer<typeof configSchema>;
/**
 * Loads the file the keeper boots from. Three failures, three different sentences (LAR-89),
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
  const problems = parsed.error.issues.slice(0, 10).map(issue => `${issue.path.length ? issue.path.map(String).join(".") : "(top level)"}: ${issue.message}`);
  const more = parsed.error.issues.length > 10 ? `; and ${parsed.error.issues.length - 10} more` : "";
  throw new Error(`keeper: invalid configuration in ${path}: ${problems.join("; ")}${more}`);
}
export function keeperPool(db: KeeperConfig["db"]): Pool {
  try {
    return new Pool({ host: db.host, port: db.port, database: db.database, user: db.user, password: readFileSync(db.passwordFile, "utf8").trimEnd(), connectionTimeoutMillis: 5000 });
  }
  catch {
    throw new Error("keeper: database credentials unavailable");
  }
}
