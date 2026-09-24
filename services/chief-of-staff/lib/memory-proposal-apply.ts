/**
 * Applying an APPROVED memory proposal — the ONE place a standing preference is closed by
 * anything other than the agent superseding its own earlier guess (ADR-0018 rule 2), and the ONE
 * place an inference the agent drew on its own becomes something this system keeps (rule 4).
 *
 * WHAT THE OWNER APPROVES IS WHAT GETS APPLIED. This function takes an `id` and, since box 084
 * (ruling D5), an explicit `owner` for the row an approved `add` inserts — defaulted to
 * `ownerId()`, this installation's one fail-soft owner key, so every real caller still passes
 * just the id and `applyMemoryProposal.length` stays 2 (a default parameter is not counted;
 * `tests/memory-proposal-apply.test.ts` pins that). A multi-user caller only has to supply the
 * third argument explicitly; nothing else about this function's contract changes. Every WORD it
 * writes is still re-read from the `memory_proposals` row inside the transaction that does the
 * writing — never a text, a subject or a row id handed in by the model. That is the whole
 * defence against the classic approval defect: a card rendered from one set of arguments and an
 * execution carried out with another. `catalogue/memory_resolve_proposal.ts` passes the id the
 * owner's card named; there is nothing else it could pass that would change the outcome.
 *
 * AND THE ROW MAY HAVE MOVED. A proposal is recorded at night and answered whenever the owner
 * next looks. Between those two moments the preference it names can be superseded by the agent's
 * own run, retired by the owner, or replaced through another proposal. Applying "close row X and
 * put this in its place" to a row that is no longer standing would be applying the owner's 👍 to
 * a decision they were never shown. So the standing row is re-read `FOR UPDATE` in the same
 * transaction: if it is gone, nothing is written, the proposal is marked `superseded` — recorded
 * as out of date rather than silently dropped — and the caller gets a plain refusal.
 *
 * ONE TRANSACTION, AND IDEMPOTENT. The close, the replacement and the proposal's own state move
 * together or not at all, so there is no half-applied change for a retry to trip over. The
 * `state = 'approved'` guard is also the once-only guard: the first apply leaves the row
 * `applied`, and a second call finds nothing to do and says so.
 *
 * AN `add` HAS NO ROW TO RE-READ, AND THAT IS NOT A WEAKER CHECK — it is a different one. An
 * add closes nothing, so "the preference this would have replaced has changed" names nothing and
 * cannot be asked. The only thing that can make an add stale is the proposal's own state, and
 * the `state = 'approved'` guard on the read above IS that check: it is what makes the apply
 * once-only, and it is the only path by which an agent's inference becomes something this system
 * keeps. The row the approval writes is stamped `owner` for the same reason the supersede
 * branch's replacement is — the owner tapped for it — while the proposal stays `agent`, which is
 * what it is. `source` keeps the approval's own id, so a later reader can always tell an
 * inference the owner confirmed from something the owner said in their own words. It is written
 * to `dream_preferences` and never to `standing_facts`, whose CHECK (origin = 'owner') is
 * reserved for the owner's own words and whose gate (`remember`'s tainted-turn refusal) an
 * unattended run must never be able to reach around.
 *
 * `confidence` IS WRITTEN AS 0, NOT CARRIED. ADR-0018 rule 4 removed the model's own confidence
 * as a signal in every decision this lane makes; a number that decides nothing must not be
 * stored as if it did. The supersede branch's confidence comes off the row being replaced — the
 * same sort of thing said differently — and an add has no such row.
 *
 * NOTHING HERE CHECKS WHO ASKED. That check belongs to the tool
 * (`assertApprover(approverFrom(ctx.session.auth))`), one call up, because only the tool has a
 * session. This module is deliberately unreachable from anywhere else in the service —
 * `tests/memory-proposal-apply.test.ts` pins the list of callers.
 */
import type { Pool, PoolClient } from "pg";

import { ownerId } from "./principals.js";

/**
 * The refusal. Not an error in the "something broke" sense — it is the right answer whenever the
 * proposal is no longer a live question: already decided and carried out, never opened, or
 * naming a preference that has since changed. Its `message` is a plain sentence the model can
 * relay to the owner unedited.
 */
export class ProposalNoLongerApplies extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalNoLongerApplies";
  }
}

/** What the caller writes into `dream_preferences.source` for the replacement row, so a later
 *  reader can trace a standing preference back to the exact proposal the owner approved. */
export function memoryProposalSource(id: number): string {
  return `memory-proposal-${id}`;
}

interface ProposalToApply {
  action: "supersede" | "retire" | "add";
  existing_id: string;
  existing_text: string;
  proposed_text: string;
  subject: string;
  /** The observation's own kind, carried on the proposal since sql/074 so the row an approved
   *  `add` inserts is not typed by anything re-derived at apply time. "" for the other two. */
  kind: string;
}

const NOT_OPEN =
  "That change is not waiting to be applied — it has already been decided and carried out, or " +
  "it was never open. Nothing changed.";

const MOVED =
  "The preference this would have replaced has changed since the change was recorded, so " +
  "nothing was applied. It is closed as out of date; if the change still holds it will be " +
  "raised again.";

/**
 * Apply an APPROVED memory proposal. For a supersede or a retire it re-reads the standing row
 * inside the same transaction as the close, so a preference that changed between the card being
 * rendered and the tap is a refusal rather than a wrong write; an `add` names no such row and is
 * guarded by its own state alone. Returns what was done, in the owner's terms.
 */
export async function applyMemoryProposal(
  db: Pool,
  id: number,
  // Explicit, not guessed inside the write below (box 084, ruling D5) — a default so every real
  // caller keeps passing just the id (see this file's header on why `.length` still reads 2).
  owner: string = ownerId(),
): Promise<{ applied: boolean; message: string }> {
  const client: PoolClient = await db.connect();
  // Set once the transaction has been ended deliberately — committed, or rolled back on a
  // refusal. Without it the catch below would try to roll back a transaction that is over.
  let finished = false;
  try {
    await client.query("BEGIN");

    const proposal = await client.query<ProposalToApply>(
      `SELECT action, existing_id, existing_text, proposed_text, subject, kind
         FROM memory_proposals
        WHERE id = $1 AND state = 'approved'
        FOR UPDATE`,
      [id],
    );
    const p = proposal.rows[0];
    if (p === undefined) {
      await client.query("ROLLBACK");
      finished = true;
      throw new ProposalNoLongerApplies(NOT_OPEN);
    }

    if (p.action === "add") {
      // NO STANDING ROW TO RE-READ. An add closes nothing, so the "the row may have moved"
      // refusal below has no subject here; the only thing that can make this stale is the
      // proposal's own state, and the `state = 'approved'` guard above is that check. The
      // inserted row's own `origin` is 'owner' for the same reason the supersede branch's is:
      // the owner tapped for it. The run that proposed it stays readable in `source`.
      await client.query(
        `INSERT INTO dream_preferences (text, kind, subject, confidence, source, origin, owner)
         VALUES ($1, $2, $3, 0, $4, 'owner', $5)`,
        [p.proposed_text, p.kind, p.subject, memoryProposalSource(id), owner],
      );
      await client.query(`UPDATE memory_proposals SET state = 'applied' WHERE id = $1`, [id]);
      await client.query("COMMIT");
      finished = true;
      return {
        applied: true,
        message:
          `Kept. "${p.proposed_text}" is standing from now on, recorded as something you ` +
          "confirmed rather than something I worked out.",
      };
    }

    // `existing_id` is text (see services/box/sql/072_memory_proposals.sql — the column names a
    // row in a table no migration owns), and `dream_preferences.id` is a uuid. Comparing on
    // `id::text` rather than casting the parameter means an `existing_id` that is not a uuid at
    // all reads as "no such standing row" — the refusal above — instead of a Postgres 22P02 the
    // owner would see as a crash.
    const standing = await client.query<{ id: string; kind: string; confidence: number }>(
      `SELECT id, kind, confidence
         FROM dream_preferences
        WHERE id::text = $1 AND valid_to IS NULL
        FOR UPDATE`,
      [p.existing_id],
    );
    const row = standing.rows[0];
    if (row === undefined) {
      // RECORDED, not dropped: a proposal that quietly disappeared would leave the owner
      // believing they answered something that never happened.
      await client.query(`UPDATE memory_proposals SET state = 'superseded' WHERE id = $1`, [id]);
      await client.query("COMMIT");
      finished = true;
      throw new ProposalNoLongerApplies(MOVED);
    }

    let message: string;
    if (p.action === "supersede") {
      // origin 'owner': the owner tapped for this, so the replacement carries their class, not
      // the run's. `kind` and `confidence` come off the row being replaced — the same sort of
      // thing, said differently, not a new sort of thing.
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO dream_preferences (text, kind, subject, confidence, source, origin, owner)
         VALUES ($1, $2, $3, $4, $5, 'owner', $6)
         RETURNING id`,
        [p.proposed_text, row.kind, p.subject, row.confidence, memoryProposalSource(id), owner],
      );
      const newId = inserted.rows[0]!.id;
      // CLOSED AND LINKED, never deleted: the old row stays readable and says what replaced it.
      await client.query(
        `UPDATE dream_preferences SET valid_to = now(), superseded_by = $2 WHERE id = $1`,
        [row.id, newId],
      );
      message =
        `Done. "${p.existing_text}" no longer applies, and "${p.proposed_text}" is standing ` +
        "from now on. The old one is kept on record and linked to the new one.";
    } else {
      await client.query(`UPDATE dream_preferences SET valid_to = now() WHERE id = $1`, [row.id]);
      message =
        `Done. "${p.existing_text}" no longer applies, and nothing takes its place. It is kept ` +
        "on record.";
    }

    await client.query(`UPDATE memory_proposals SET state = 'applied' WHERE id = $1`, [id]);
    await client.query("COMMIT");
    finished = true;
    return { applied: true, message };
  } catch (err) {
    if (!finished) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // A rollback that itself fails must not replace the real reason this failed.
      }
    }
    throw err;
  } finally {
    client.release();
  }
}
