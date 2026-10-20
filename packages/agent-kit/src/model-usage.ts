/**
 * src/model-usage.ts — one row per model call: the token counts eve reports, kept locally.
 * Backs `services/box/sql/005_model_steps.sql`.
 *
 * WHY. The prompt cache only saves money if the provider actually reads from it. eve's
 * `step.completed` event carries `usage.{inputTokens, outputTokens, cacheReadTokens,
 * cacheWriteTokens, costUsd}`; this module writes those numbers down so a later page can show the
 * hit rate. Numbers and ids only — never message text or tool input.
 *
 * BEST-EFFORT BY CONSTRUCTION, in the shape of `./approval-ledger.ts`. NEVER throws, never
 * blocks, and a failure is logged at most once per process: recording a call must not be able to
 * cost the turn that made it. A box that has not applied that migration simply records nothing.
 *
 * RETENTION. After each insert the same call removes this agent's rows older than
 * `MODEL_STEPS_RETENTION_DAYS` (insert-then-delete, the shape `./conversation-control.ts` uses
 * for its own projection). The `(agent, at)` index keeps that delete cheap.
 */
import type { Queryable } from "@lares/vault-format/forget-ledger";

/** Rows older than this are removed by the writer. */
export const MODEL_STEPS_RETENTION_DAYS = 90;

export interface ModelStep {
  /** eve's `meta.id` for the `step.completed` event. */
  eventId: string;
  agent: string;
  sessionId: string;
  turnId: string;
  stepIndex: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  /** ISO-8601 emission time; the database's clock when absent or unparseable. */
  at?: string;
}

let warnedAboutModelSteps = false;

function warnAboutModelSteps(err: unknown): void {
  if (warnedAboutModelSteps) return;
  warnedAboutModelSteps = true;
  console.warn(
    "model-usage: could not record a model call (this and any further failures this process " +
      "are swallowed) — apply the latest database update if it is not there yet. The turn " +
      "that triggered this is unaffected.",
    err,
  );
}

/** Resets the once-per-process warning flag. Test-only. */
export function resetModelUsageWarningForTests(): void {
  warnedAboutModelSteps = false;
}

function count(n: number | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null;
}

function validAt(at: string | undefined): string | null {
  return typeof at === "string" && !Number.isNaN(Date.parse(at)) ? at : null;
}

/**
 * Writes down one model call, then prunes this agent's rows past retention. A repeat of the same
 * event id keeps the first row (`ON CONFLICT DO NOTHING`).
 *
 * BEST-EFFORT. Never throws; warns once per process.
 */
export async function recordModelStep(db: Queryable, s: ModelStep): Promise<void> {
  try {
    await db.query(
      `INSERT INTO model_steps (event_id, agent, session_id, turn_id, step_index,
                                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                                cost_usd, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11::timestamptz, now()))
       ON CONFLICT (event_id) DO NOTHING`,
      [
        s.eventId, s.agent, s.sessionId, s.turnId, Math.round(s.stepIndex),
        count(s.inputTokens), count(s.outputTokens), count(s.cacheReadTokens),
        count(s.cacheWriteTokens),
        typeof s.costUsd === "number" && Number.isFinite(s.costUsd) ? s.costUsd : null,
        validAt(s.at),
      ],
    );
    await db.query(
      `DELETE FROM model_steps WHERE agent = $1 AND at < now() - make_interval(days => $2)`,
      [s.agent, MODEL_STEPS_RETENTION_DAYS],
    );
  } catch (err) {
    warnAboutModelSteps(err);
  }
}
