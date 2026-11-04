import type { Pool } from "pg";
import { z } from "zod";
import { CONSOLE_ENVIRONMENT } from "./agent-environment.js";
export const SETTING_KEYS = { "models.alias_prefix": z.string().regex(/^[a-z0-9]+$/), "agents.ceiling": z.number().int().nonnegative(), "agents.backup_remote": z.string(), "house.name": z.string(),
  // The Notion database the meeting follow-up schedule reads. "" means "none, on purpose".
  "notion.meetings_data_source": z.union([z.literal(""), z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)]),
  // The console-settable agent environment values (agent-environment.ts). "" means "none, on purpose".
  ...Object.fromEntries(CONSOLE_ENVIRONMENT.map(s => [s.setting, z.string().max(2048)])) as Record<string, z.ZodString> } as const;
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
/** A Notion data source id typed or pasted in either spelling (with or without dashes, any case,
 * surrounding spaces) as the one dashed lowercase form, or null when it is not an id. */
export function normaliseNotionId(raw: string): string | null {
  const hex = raw.trim().replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
