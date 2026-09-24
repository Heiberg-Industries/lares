import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Pool } from "pg";
import { z } from "zod";
import { lifecycleSchema } from "./lifecycle-config.js";
const absolute = z.string().refine(isAbsolute);
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
export function loadKeeperConfig(path = "/etc/lares/keeper.json"): KeeperConfig {
  try {
    return configSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  }
  catch {
    throw new Error("keeper: invalid or unreadable configuration");
  }
}
export function keeperPool(db: KeeperConfig["db"]): Pool {
  try {
    return new Pool({ host: db.host, port: db.port, database: db.database, user: db.user, password: readFileSync(db.passwordFile, "utf8").trimEnd(), connectionTimeoutMillis: 5000 });
  }
  catch {
    throw new Error("keeper: database credentials unavailable");
  }
}
