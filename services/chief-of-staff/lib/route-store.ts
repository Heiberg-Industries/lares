/**
 * lib/route-store.ts — cursor + proposal dedup store for CRM routing.
 *
 * Persists two tables:
 *   route_proposals — one row per (person, signal) pair proposed to Bendik. Dedup: never
 *                     re-propose the same person_id + signal_ref regardless of the row's
 *                     status (applied / skipped / vetoed).
 *   route_cursor    — single-row table recording the high-water-mark ISO timestamp the
 *                     scanner uses to know where to resume. Enforced as singleton via
 *                     CHECK (id = 1).
 *
 * Ported from `services/agent-runtime/lib/adapters/route/store.ts`, retyped against `Pool`
 * from "pg" instead of that file's `MiniPool` structural interface — matching every other
 * eve-saga store (`lib/proposals-store.ts`, `lib/reminders-store.ts`), none of which use that
 * abstraction. Same table/column names as upstream: other consumers (e.g. a future console
 * view) may read these tables directly.
 *
 * Kept as its own file rather than folded into `lib/proposals-store.ts`: the two stores share
 * no tables, no columns, and no callers — route_proposals is a dedup ledger keyed on
 * (person, signal), while proposals-store.ts's tables are a decision queue keyed on
 * (vault path / note path). Merging them would only make an unrelated file bigger.
 */
import type { Pool } from "pg";

// ─── Row / input types ────────────────────────────────────────────────────────

export interface RouteProposalRow {
  id: string;
  personId: string;
  opportunityId: string | null;
  brand: string;
  proposedStage: string;
  signalRef: string;
  confidence: number;
  status: string;
  createdAt: string;
}

export interface RouteProposalInput {
  personId: string;
  opportunityId?: string | null;
  brand: string;
  proposedStage: string;
  signalRef: string;
  confidence: number;
}

interface CursorDbRow {
  id: number;
  cursor_at: string | Date | null;
}

// ─── DDL ─────────────────────────────────────────────────────────────────────

/** Idempotent — safe to call on every startup. */
export async function ensureRouteTables(db: Pool): Promise<void> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS route_proposals (
       id             uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
       person_id      text             NOT NULL,
       opportunity_id text,
       brand          text             NOT NULL,
       proposed_stage text             NOT NULL,
       signal_ref     text             NOT NULL,
       confidence     double precision NOT NULL,
       status         text             NOT NULL DEFAULT 'proposed',
       created_at     timestamptz      NOT NULL DEFAULT now()
     )`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS route_cursor (
       id        integer  PRIMARY KEY DEFAULT 1,
       cursor_at timestamptz NOT NULL,
       CONSTRAINT route_cursor_singleton CHECK (id = 1)
     )`,
  );
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function makeRouteStore(db: Pool) {
  return {
    /** Return the stored ISO cursor string, or null if no cursor has been set. */
    async getCursor(): Promise<string | null> {
      const { rows } = await db.query<CursorDbRow>(`SELECT cursor_at FROM route_cursor WHERE id = 1`);
      const row = rows[0];
      if (row === undefined || row.cursor_at === null) return null;
      return row.cursor_at instanceof Date ? row.cursor_at.toISOString() : row.cursor_at;
    },

    /** Upsert the singleton cursor row with the given ISO timestamp. A second call
     *  overwrites the first — only one row ever exists. */
    async setCursor(iso: string): Promise<void> {
      await db.query(
        `INSERT INTO route_cursor (id, cursor_at) VALUES (1, $1)
         ON CONFLICT (id) DO UPDATE SET cursor_at = EXCLUDED.cursor_at`,
        [iso],
      );
    },

    /** True if a route_proposals row already exists for the given person_id + signal_ref
     *  combination — regardless of status. Used to prevent re-proposing the same move for
     *  the same signal. */
    async alreadyProposed(args: { personId: string; signalRef: string }): Promise<boolean> {
      const { rows } = await db.query(
        `SELECT 1 FROM route_proposals WHERE person_id = $1 AND signal_ref = $2 LIMIT 1`,
        [args.personId, args.signalRef],
      );
      return rows.length > 0;
    },

    /** The cool-down's memory (route-engine.ts PROPOSAL_COOLDOWN_DAYS): any proposal row for
     *  this person and brand since `sinceIso`, whatever became of it. */
    async proposedSince(args: { personId: string; brand: string; sinceIso: string }): Promise<boolean> {
      const { rows } = await db.query(
        `SELECT 1 FROM route_proposals WHERE person_id = $1 AND brand = $2 AND created_at >= $3 LIMIT 1`,
        [args.personId, args.brand, args.sinceIso],
      );
      return rows.length > 0;
    },

    /** Insert a new proposal row with status 'proposed'. Returns the generated row id. */
    async recordProposal(p: RouteProposalInput): Promise<{ id: string }> {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO route_proposals
           (person_id, opportunity_id, brand, proposed_stage, signal_ref, confidence)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [p.personId, p.opportunityId ?? null, p.brand, p.proposedStage, p.signalRef, p.confidence],
      );
      return { id: rows[0]!.id };
    },

    /** Update the status of a proposal — e.g. 'applied', 'skipped', 'vetoed'. */
    async markResolved(id: string, status: string): Promise<void> {
      await db.query(`UPDATE route_proposals SET status = $1 WHERE id = $2`, [status, id]);
    },
  };
}
