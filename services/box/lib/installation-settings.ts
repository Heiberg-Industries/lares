import type { Queryable } from "./db.js";

export const INSTALLATION_ALIAS_PREFIX = "lares";
export const INSTALLATION_AGENT_CEILING = 1;

interface SettingRow {
  key: string;
  value: unknown;
}

interface TransactionClient extends Queryable {
  release(): void;
}

export interface TransactionPool {
  connect(): Promise<TransactionClient>;
}

export interface InstallationSettingsResult {
  aliasPrefix: string;
  agentCeiling: number;
  initialized: string[];
}

/**
 * Give a fresh installation the two settings the first-agent screen requires. Existing values
 * always win: a repair run must not silently undo an owner's model namespace or approved capacity.
 *
 * The validation is inside the same transaction as the inserts. That matters on a repair with one
 * missing row and one malformed existing row: refusal must roll the new default back instead of
 * truthfully reporting an error after having changed half the pair.
 */
export async function initializeInstallationSettings(
  db: TransactionPool,
): Promise<InstallationSettingsResult> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query<{ key: string }>(
      `INSERT INTO settings (key, value, updated_by) VALUES
         ('models.alias_prefix', $1::jsonb, 'installer'),
         ('agents.ceiling', $2::jsonb, 'installer')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      [JSON.stringify(INSTALLATION_ALIAS_PREFIX), JSON.stringify(INSTALLATION_AGENT_CEILING)],
    );
    const { rows } = await client.query<SettingRow>(
      `SELECT key, value FROM settings
       WHERE key IN ('models.alias_prefix', 'agents.ceiling')
       ORDER BY key`,
    );

    const values = new Map(rows.map((row) => [row.key, row.value]));
    const aliasPrefix = values.get("models.alias_prefix");
    const agentCeiling = values.get("agents.ceiling");
    if (
      typeof aliasPrefix !== "string" ||
      !/^[a-z0-9]+$/.test(aliasPrefix) ||
      aliasPrefix === "installation"
    ) {
      throw new Error("installation settings: models.alias_prefix is missing or invalid");
    }
    if (
      typeof agentCeiling !== "number" ||
      !Number.isInteger(agentCeiling) ||
      agentCeiling < 0
    ) {
      throw new Error("installation settings: agents.ceiling is missing or invalid");
    }

    await client.query("COMMIT");
    return {
      aliasPrefix,
      agentCeiling,
      initialized: inserted.rows.map((row) => row.key).sort(),
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Keep the original error: it is the actionable refusal.
    }
    throw error;
  } finally {
    client.release();
  }
}
