import type { Pool } from "pg";
import type { AutonomyLevel, RatchetStore } from "./governance-ratchet.js";

// ⚠️ TWIN. `packages/agent-kit/src/ratchet.ts`'s `KitRatchet` is the same accessor over the
// same `ratchet` table, for consumers (eve-saga) that cannot reach this package. If the
// RESOLUTION ORDER below changes, change it in the twin in the same commit — see that file's
// header for why a single home isn't possible here.

/** Postgres-backed ratchet. `updatedBy` records who flipped the dial (audited surface). */
export class PgRatchet implements RatchetStore {
  constructor(private readonly pool: Pool) {}

  async level(agent: string, capability: string, action?: string): Promise<AutonomyLevel> {
    const { rows } = await this.pool.query<{ action: string; level: AutonomyLevel }>(
      `SELECT action, level FROM ratchet WHERE agent = $1 AND capability = $2 AND action IN ('', $3)`,
      [agent, capability, action ?? ""],
    );
    if (action) {
      const exact = rows.find((r) => r.action === action);
      if (exact) return exact.level;
    }
    const def = rows.find((r) => r.action === "");
    return def?.level ?? "gated";
  }

  async setLevel(agent: string, capability: string, level: AutonomyLevel, action?: string, updatedBy = "system"): Promise<void> {
    await this.pool.query(
      `INSERT INTO ratchet (agent, capability, action, level, updated_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (agent, capability, action)
       DO UPDATE SET level = EXCLUDED.level, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [agent, capability, action ?? "", level, updatedBy],
    );
  }

  /**
   * Every fine-grained `action` currently set to `level` for this capability, newest first.
   *
   * The capability default (`action = ''`) is EXCLUDED: it is a policy row, not a thing, and
   * showing it in a list of meetings would invite someone to revoke the default while
   * believing they were revoking one meeting.
   */
  async listAtLevel(
    agent: string, capability: string, level: AutonomyLevel,
  ): Promise<Array<{ action: string; level: AutonomyLevel; updatedBy: string; updatedAt: Date }>> {
    const { rows } = await this.pool.query<{
      action: string; level: AutonomyLevel; updated_by: string; updated_at: Date;
    }>(
      `SELECT action, level, updated_by, updated_at FROM ratchet
        WHERE agent = $1 AND capability = $2 AND level = $3 AND action <> ''
        ORDER BY updated_at DESC`,
      [agent, capability, level],
    );
    return rows.map((r) => ({
      action: r.action, level: r.level, updatedBy: r.updated_by, updatedAt: r.updated_at,
    }));
  }
}
