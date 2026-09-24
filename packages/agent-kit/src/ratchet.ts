/**
 * Reading and writing the fleet's autonomy ratchet (ADR-0009) from an agent-kit consumer.
 *
 * ⚠️ TWIN. `packages/agent-kit/src/ratchet-store.ts` is the same accessor over the same
 * `ratchet` table. If the RESOLUTION ORDER below changes, change it in the twin in the
 * same commit — that order is what "gated" means, and two files disagreeing means
 * governance means two things.
 *
 * THE TABLE IS THE SOURCE OF TRUTH. The resolution order is the whole safety property:
 * the fine-grained `action` (for ORB-156, a calendar recurring-event id), then the
 * capability's own default (`action = ''`), then **"gated"**. So a meeting series nobody
 * opted in is gated because nothing was ever written about it, not because a default
 * happened to be set correctly somewhere.
 */
import type { Pool } from "pg";

// The level vocabulary already exists in this package — do NOT declare a second one.
import { type AutonomyLevel } from "./manifest.js";
export type { AutonomyLevel };

export class KitRatchet {
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

  async setLevel(
    agent: string, capability: string, level: AutonomyLevel,
    action?: string, updatedBy = "system",
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO ratchet (agent, capability, action, level, updated_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (agent, capability, action)
       DO UPDATE SET level = EXCLUDED.level, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [agent, capability, action ?? "", level, updatedBy],
    );
  }

  /** The level set for exactly (agent, capability, action) — or for the capability's default when no
   *  action is given — WITHOUT falling back to "gated". `null` means nobody set one, so the caller can
   *  fall back to the agent's own declaration (the board policy does). */
  async explicitLevel(agent: string, capability: string, action?: string): Promise<AutonomyLevel | null> {
    const { rows } = await this.pool.query<{ level: AutonomyLevel }>(
      `SELECT level FROM ratchet WHERE agent = $1 AND capability = $2 AND action = $3`,
      [agent, capability, action ?? ""],
    );
    return rows[0]?.level ?? null;
  }
}

export type ApprovalDecision = "asked" | "autonomous" | "denied" | "locked" | "failed-closed";

/** The board's evidence. Fire-and-forget by contract: a failure here is logged and swallowed, because
 *  evidence must never be the reason an agent's action fails or waits. One row per `callId`: eve
 *  consults the policy again when an answered card resumes, with the same id, and that second
 *  answer is not a second decision (final review F6). A call without an id is always recorded. */
export async function recordApprovalEvent(
  pool: Pool,
  e: { agent: string; capability: string; tool: string; decision: ApprovalDecision; reason?: string; callId?: string },
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO approval_events (agent, capability, tool, decision, reason, call_id) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (call_id) WHERE call_id IS NOT NULL DO NOTHING`,
      [e.agent, e.capability, e.tool, e.decision, e.reason ?? null, e.callId ?? null],
    );
  } catch (err) {
    console.error(`[board] approval evidence not recorded (${e.agent}/${e.tool}): ${(err as Error).message}`);
  }
}
