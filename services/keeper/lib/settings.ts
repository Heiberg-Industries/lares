import type { Pool } from "pg";
import { z } from "zod";
export const SETTING_KEYS = { "models.alias_prefix": z.string().regex(/^[a-z0-9]+$/), "agents.ceiling": z.number().int().nonnegative(), "agents.backup_remote": z.string(), "house.name": z.string() } as const;
function schema(key: string) {
  if (!Object.hasOwn(SETTING_KEYS, key))
    throw new Error("keeper: unknown setting");
  return SETTING_KEYS[key as keyof typeof SETTING_KEYS];
}
export async function readSetting(pool: Pool, key: string): Promise<unknown> {
  schema(key);
  try {
    const { rows } = await pool.query("SELECT value FROM settings WHERE key=$1", [key]);
    return rows[0]?.value;
  }
  catch {
    throw new Error("keeper: setting read failed");
  }
}
export async function writeSetting(pool: Pool, key: string, value: unknown, actor: string): Promise<void> {
  const parsed = schema(key).safeParse(value);
  if (!parsed.success)
    throw new Error("keeper: invalid setting value");
  try {
    await pool.query("INSERT INTO settings (key,value,updated_by) VALUES ($1,$2::jsonb,$3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()", [key, JSON.stringify(parsed.data), actor]);
  }
  catch {
    throw new Error("keeper: setting write failed");
  }
}
