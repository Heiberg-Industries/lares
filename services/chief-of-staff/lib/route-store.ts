/**
 * lib/route-store.ts — cursor + proposal dedup store for track routing.
 *
 * Persists two tables:
 *   route_proposals — one row per (person, signal) pair proposed to the owner. Dedup: never
 *                     re-propose the same person_id + signal_ref regardless of the row's
 *                     status (applied / skipped / vetoed).
 *   route_cursor    — single-row table recording the high-water-mark ISO timestamp the
 *                     scanner uses to know where to resume. Enforced as singleton via
 *                     CHECK (id = 1).
 *
 * Typed against `Pool` from "pg" rather than a `MiniPool` structural interface — matching every
 * other chief-of-staff store (`lib/proposals-store.ts`, `lib/reminders-store.ts`), none of which
 * use that abstraction. Other consumers (e.g. a console view) may read these tables directly.
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
  home: string;
  trackId: string;
  proposedStage: string;
  signalRef: string;
  confidence: number;
  status: string;
  createdAt: string;
}

export interface RouteProposalInput {
  personId: string;
  opportunityId?: string | null;
  home: string;
  trackId: string;
  proposedStage: string;
  signalRef: string;
  confidence: number;
}

interface CursorDbRow {
  id: number;
  cursor_at: string | Date | null;
}

// ─── Schema readiness ────────────────────────────────────────────────────────

/** Check that the offline migration created the complete schema this store needs. */
export async function ensureRouteTables(db: Pool): Promise<void> {
  await db.query(
    `SELECT id, person_id, opportunity_id, home, track_id, proposed_stage, signal_ref,
            confidence, status, created_at
       FROM route_proposals LIMIT 0`,
  );
  await db.query(
    `SELECT id, cursor_at FROM route_cursor LIMIT 0`,
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
        `SELECT 1 FROM route_proposals WHERE person_id = $1 AND signal_ref = $2 AND status <> 'pending' LIMIT 1`,
        [args.personId, args.signalRef],
      );
      return rows.length > 0;
    },

    /** The cool-down's memory (route-engine.ts PROPOSAL_COOLDOWN_DAYS): any proposal row for
     *  this person and brand since `sinceIso`, whatever became of it. */
    async proposedSince(args: { personId: string; home: string; trackId: string; sinceIso: string }): Promise<boolean> {
      const { rows } = await db.query(
        `SELECT 1 FROM route_proposals WHERE person_id = $1 AND home = $2 AND track_id = $3 AND created_at >= $4 AND status <> 'pending' LIMIT 1`,
        [args.personId, args.home, args.trackId, args.sinceIso],
      );
      return rows.length > 0;
    },

    /** Insert a new proposal row with status 'proposed'. Returns the generated row id. */
    async recordProposal(p: RouteProposalInput): Promise<{ id: string }> {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO route_proposals
           (person_id, opportunity_id, home, track_id, proposed_stage, signal_ref, confidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [p.personId, p.opportunityId ?? null, p.home, p.trackId, p.proposedStage, p.signalRef, p.confidence],
      );
      return { id: rows[0]!.id };
    },

    /** Reserve the exact ledger row before sending an approval card. Approval-link creation
     * locks this row and promotes it; an unsent reservation can be safely discarded. */
    async reserveProposal(p: RouteProposalInput): Promise<{ id: string }> {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO route_proposals
           (person_id, opportunity_id, home, track_id, proposed_stage, signal_ref, confidence, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
         ON CONFLICT (person_id,signal_ref) WHERE status='pending' DO NOTHING RETURNING id`,
        [p.personId, p.opportunityId ?? null, p.home, p.trackId, p.proposedStage, p.signalRef, p.confidence],
      );
      if (rows[0]) return { id: rows[0].id };
      const existing = await db.query<{ id: string }>(`SELECT id FROM route_proposals WHERE person_id=$1 AND signal_ref=$2
        AND opportunity_id IS NOT DISTINCT FROM $3 AND home=$4 AND track_id=$5 AND proposed_stage=$6 AND status='pending'`,
      [p.personId,p.signalRef,p.opportunityId ?? null,p.home,p.trackId,p.proposedStage]);
      if (existing.rows.length === 1) return { id: existing.rows[0]!.id };
      throw new Error("a different pending route proposal already owns this signal");
    },

    async confirmProposalSent(id: string): Promise<void> {
      await db.query(`UPDATE route_proposals SET status='proposed' WHERE id=$1 AND status='pending'`, [id]);
    },

    async discardUnsentProposal(id: string): Promise<void> {
      // A concurrent approval link locks/promotes the row first, so this delete cannot erase it.
      await db.query(`DELETE FROM route_proposals WHERE id=$1 AND status='pending'`, [id]);
    },

    /** Update the status of a proposal — e.g. 'applied', 'skipped', 'vetoed'. */
    async markResolved(id: string, status: string): Promise<void> {
      await db.query(`UPDATE route_proposals SET status = $1 WHERE id = $2`, [status, id]);
    },
  };
}
