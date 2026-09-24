// services/box/lib/atlas-proposals.ts
// The Atlas sync job's proposal queue: the rows behind Bendik's 👍 on a re-derived note.
//
// WHY IT LIVES HERE and not in services/atlas: two surfaces resolve an Atlas proposal —
// the job's own CLI and Saga's Telegram decision button (services/agent-runtime) — and the
// binding constraint is that they are the SAME code, never two callers that happen to
// agree. @lares/agent-box is the package both already depend on, and it owns this table's
// schema (sql/019_atlas_sync.sql). Exactly the argument notion-proposals.ts makes for
// itself, for exactly the same reason.
//
// Vendor-neutral: takes a structural Queryable, never imports "pg".
import type { Queryable } from "./db.js";

export type AtlasProposalState = "pending" | "approved" | "rejected" | "applied" | "superseded";

export interface AtlasProposalInput {
  notePath: string;
  /** The FULL proposed file — frontmatter and body — not a patch. */
  proposedNote: string;
  baseBodyHash: string;
  sourcesHash: string;
  diffPreview?: string;
}

export interface AtlasProposalRow {
  id: number;
  notePath: string;
  proposedNote: string;
  baseBodyHash: string;
  sourcesHash: string;
  diffPreview: string;
  state: AtlasProposalState;
  createdAt: Date;
}

// ── What a decision does, in ONE place ────────────────────────────────────────────
// Unlike the Notion queue there are not three outcomes here — an Atlas proposal is always
// "rewrite this note's narrative from its sources". These are still functions rather than
// strings inlined at each surface, because notion-sync proved the alternative twice: six
// surfaces each writing their own sentence produced six promises the engine had stopped
// keeping. A sentence written once can be wrong once and fixed once.

export function atlasApproveConsequence(): string {
  return "the re-derived note is written into the Atlas on the next sync tick, and pushed";
}

export function atlasRejectConsequence(): string {
  return "the note is left exactly as it is, and this draft is not offered again until one " +
    "of its canonical sources actually changes";
}

const COLUMNS = `id, note_path, proposed_note, base_body_hash, sources_hash, diff_preview,
                 state, created_at`;

// One column list for atlas_notes too, and one mapper (below, in getAtlasNotes) — a SELECT
// that quietly omits a column leaves a field `undefined` at runtime while TypeScript still
// believes it is present. One reader uses this today; the protection is for the second one.
const NOTE_COLUMNS = `note_path, brand, accounted_sources_hash, body_hash,
                      state, state_reason, state_since`;

interface DbRow {
  id: string;
  note_path: string;
  proposed_note: string;
  base_body_hash: string;
  sources_hash: string;
  diff_preview: string;
  state: AtlasProposalState;
  created_at: Date;
}

function toRow(r: DbRow): AtlasProposalRow {
  return {
    id: Number(r.id),
    notePath: r.note_path,
    proposedNote: r.proposed_note,
    baseBodyHash: r.base_body_hash,
    sourcesHash: r.sources_hash,
    diffPreview: r.diff_preview,
    state: r.state,
    createdAt: r.created_at,
  };
}

/**
 * Plain INSERT, not an upsert: `atlas_proposals_open` is a partial unique index, so a
 * second open proposal for the same note must be SUPERSEDED by the caller first — the
 * caller is the one that knows it is replacing something and must say so.
 */
export async function insertAtlasProposal(db: Queryable, input: AtlasProposalInput): Promise<number> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO atlas_proposals
       (note_path, proposed_note, base_body_hash, sources_hash, diff_preview)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.notePath, input.proposedNote, input.baseBodyHash, input.sourcesHash, input.diffPreview ?? ""],
  );
  return Number(res.rows[0]!.id);
}

export async function getOpenAtlasProposals(db: Queryable): Promise<AtlasProposalRow[]> {
  const res = await db.query<DbRow>(
    `SELECT ${COLUMNS} FROM atlas_proposals
      WHERE state IN ('pending','approved') ORDER BY created_at`,
  );
  return res.rows.map(toRow);
}

/**
 * The apply pass's work queue: decided, not yet executed. BOTH decisions appear here —
 * an approve owes a file write, a reject owes the accounted-for stamp without which the
 * declined draft returns on the next tick.
 */
/**
 * A row from that queue. `state` is narrowed to the two decided states because the WHERE
 * clause admits nothing else — which lets `completeAtlasProposal(db, id, p.state)` typecheck
 * without a cast at the call site, and makes "the apply pass only ever sees decided rows" a
 * fact the compiler carries rather than a comment.
 */
export type AtlasAwaitingApplyRow = Omit<AtlasProposalRow, "state"> & { state: AtlasDecidedState };

export async function getAtlasProposalsAwaitingApply(db: Queryable): Promise<AtlasAwaitingApplyRow[]> {
  const res = await db.query<DbRow>(
    `SELECT ${COLUMNS} FROM atlas_proposals
      WHERE state IN ('approved','rejected') AND resolved_at IS NULL ORDER BY created_at`,
  );
  // The narrowing the WHERE clause already guarantees; toRow types `state` off the column.
  return res.rows.map(toRow) as AtlasAwaitingApplyRow[];
}

/**
 * Terminal-state moves the ENGINE makes. Never a human decision — 'pending', 'approved'
 * and 'rejected' only ever move through `resolveAtlasProposal`'s guarded UPDATE, so this
 * type names the two states an engine tick actually sets. That narrowing is load-bearing,
 * not decorative: an engine mover that accepted the full `AtlasProposalState` union was a
 * second, unguarded path to the SAME transition `resolveAtlasProposal` guards — it compiled
 * for `"rejected"` and moved an already-applied row with no state check at all, and
 * re-opening a closed row into ('pending','approved') threw a raw unique-index violation
 * (`atlas_proposals_open`) instead of a clear error.
 */
export type AtlasEngineState = "applied" | "superseded";

/** The two states a human decision leaves behind, and the only ones the apply pass executes. */
export type AtlasDecidedState = "approved" | "rejected";

/**
 * Closes an EXECUTED decision: terminal state and resolved_at move together, in ONE guarded
 * UPDATE, or neither moves.
 *
 * This replaced a two-statement version (`setAtlasProposalState` then `closeAtlasProposal`)
 * that could not work and shipped anyway. The close was guarded `state IN
 * ('approved','rejected')`, so by the time it ran — after the state move to 'applied' — it
 * matched zero rows and resolved_at stayed NULL forever. The store's own test hid it by
 * stamping resolved_at with raw SQL between the two calls; the apply pass's tests caught it.
 * Hence one statement: there is no intermediate state for a guard to disagree with.
 *
 * Guarded on `state = $3` — the state the caller READ — not `IN (…)`. If a human flips an
 * approval to 'rejected' while the tick is mid-flight, this updates zero rows and throws
 * rather than stamping 'applied' onto a decision that no longer says approve; the next tick
 * re-reads the row and executes the branch the human actually chose. `resolved_at IS NULL`
 * keeps the "first value wins" posture markProposalReverted established on the Notion queue.
 *
 * A still-'pending' row is unreachable through either predicate, which is what makes the
 * old hazard structurally impossible: a resolved_at stamped on an undecided row would make
 * a LATER approval invisible to `getAtlasProposalsAwaitingApply` (it filters resolved_at IS
 * NULL) — accepted, then silently never executed.
 */
export async function completeAtlasProposal(
  db: Queryable, id: number, from: AtlasDecidedState,
): Promise<void> {
  // An approve becomes 'applied'; a reject is already terminal and only owes its stamp.
  const to: AtlasProposalState = from === "approved" ? "applied" : "rejected";
  const res = await db.query(
    `UPDATE atlas_proposals SET state = $2, resolved_at = now()
      WHERE id = $1 AND state = $3 AND resolved_at IS NULL
      RETURNING id`,
    [id, to, from],
  );
  if (res.rows.length === 0) {
    throw new Error(
      `atlas proposal ${id} was no longer '${from}' and unexecuted when the apply pass ` +
      "tried to close it (concurrently decided, or already closed)",
    );
  }
}

/**
 * The stale-approval outcome: the note moved under an approval, so the draft was NOT
 * written. Same one-statement shape and the same reasoning as `completeAtlasProposal`;
 * separate because only an 'approved' row can go stale — a rejection writes nothing, so
 * nothing underneath it can invalidate it.
 *
 * Deliberately does NOT record the sources as accounted: the note still differs from what
 * its sources say, and the next tick SHOULD offer a fresh proposal.
 */
export async function supersedeAtlasProposal(db: Queryable, id: number): Promise<void> {
  const res = await db.query(
    `UPDATE atlas_proposals SET state = 'superseded', resolved_at = now()
      WHERE id = $1 AND state = 'approved' AND resolved_at IS NULL
      RETURNING id`,
    [id],
  );
  if (res.rows.length === 0) {
    throw new Error(
      `atlas proposal ${id} was no longer an open approval when the apply pass tried to ` +
      "supersede it (concurrently decided, or already closed)",
    );
  }
}

export type AtlasProposalAction = "approve" | "reject";

/**
 * THE guarded state transition — the single execution path behind every human decision,
 * whatever surface it arrives on (Telegram button, `atlas-sync approve|reject`).
 *
 * ONE statement, not read-then-write. The read-then-write version is a TOCTOU race against
 * the apply pass, and the two are on a collision course by design (a daily tick and a human
 * tap). The losing interleaving is silent: the engine moves the row to 'applied' and stamps
 * resolved_at, then the unguarded UPDATE sets state='rejected' on top — producing a
 * 'rejected' row WITH resolved_at, which the apply queue can never pick up, so the decision
 * is never executed and nothing reports a failure. The state predicate closes it: once the
 * engine has moved the row, this updates zero rows and throws.
 *
 * resolved_at is deliberately untouched: both decisions still owe the world a write.
 */
export async function resolveAtlasProposal(
  db: Queryable, id: number, action: AtlasProposalAction,
): Promise<AtlasProposalRow> {
  const state: AtlasProposalState = action === "approve" ? "approved" : "rejected";
  const res = await db.query<DbRow>(
    `UPDATE atlas_proposals SET state = $2
      WHERE id = $1 AND state IN ('pending','approved')
      RETURNING ${COLUMNS}`,
    [id, state],
  );
  const row = res.rows[0];
  if (row === undefined) {
    throw new Error(`no open atlas proposal with id ${id} (already resolved, or never existed)`);
  }
  return toRow(row);
}

// ── The announce ledger ───────────────────────────────────────────────────────────
// Durable rather than in-process: an in-memory Set re-announces every open proposal on
// each deploy, which is the fastest way to teach a human to ignore the messages.

/** 'pending' only — an approved proposal is already decided and merely awaiting the tick. */
/**
 * Carries the note's brand alongside the proposal, so the announcement can say "murmur"
 * rather than making its caller guess one from the filename — `_projects/traad-io.md` is
 * the brand `traad.io`, and a basename heuristic gets that wrong. LEFT JOIN, and the brand
 * stays nullable: a note row is created before a proposal can exist, but `brand` itself is
 * nullable in the schema, and a missing one must read as absent rather than as a guess.
 */
export type AtlasUnannouncedRow = AtlasProposalRow & { brand: string | null };

export async function getUnannouncedAtlasProposals(db: Queryable): Promise<AtlasUnannouncedRow[]> {
  const res = await db.query<DbRow & { brand: string | null }>(
    `SELECT ${COLUMNS.split(",").map((c) => `p.${c.trim()}`).join(", ")}, n.brand
       FROM atlas_proposals p
       LEFT JOIN atlas_notes n ON n.note_path = p.note_path
      WHERE p.state = 'pending' AND p.announced_at IS NULL ORDER BY p.created_at`,
  );
  return res.rows.map((r) => ({ ...toRow(r), brand: r.brand }));
}

/**
 * First stamp wins. The CALLER must only invoke this after the message actually went out —
 * stamping optimistically turns one failed send into a proposal nobody is ever told about.
 */
export async function markAtlasProposalAnnounced(db: Queryable, id: number): Promise<void> {
  await db.query(
    `UPDATE atlas_proposals SET announced_at = now() WHERE id = $1 AND announced_at IS NULL`, [id],
  );
}

// ── atlas_notes ───────────────────────────────────────────────────────────────────

export type AtlasNoteState = "ok" | "sources_failed" | "sources_missing";

export interface AtlasNoteRow {
  notePath: string;
  brand: string | null;
  accountedSourcesHash: string | null;
  bodyHash: string | null;
  state: AtlasNoteState;
  stateReason: string | null;
  stateSince: Date | null;
}

/**
 * Asserts the note EXISTS and refreshes what the job knows about its bytes. Deliberately
 * does NOT touch accounted_sources_hash, state or state_since: those are decisions and
 * verdicts, and a routine bookkeeping write must never quietly overwrite one.
 */
export async function upsertAtlasNote(
  db: Queryable, note: { notePath: string; brand: string | null; bodyHash: string | null },
): Promise<void> {
  await db.query(
    `INSERT INTO atlas_notes (note_path, brand, body_hash, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (note_path) DO UPDATE
       SET brand = EXCLUDED.brand, body_hash = EXCLUDED.body_hash, updated_at = now()`,
    [note.notePath, note.brand, note.bodyHash],
  );
}

export async function getAtlasNotes(db: Queryable): Promise<Map<string, AtlasNoteRow>> {
  const res = await db.query<{
    note_path: string; brand: string | null; accounted_sources_hash: string | null;
    body_hash: string | null; state: AtlasNoteState; state_reason: string | null;
    state_since: Date | null;
  }>(
    `SELECT ${NOTE_COLUMNS} FROM atlas_notes`,
  );
  const out = new Map<string, AtlasNoteRow>();
  for (const r of res.rows) {
    out.set(r.note_path, {
      notePath: r.note_path, brand: r.brand, accountedSourcesHash: r.accounted_sources_hash,
      bodyHash: r.body_hash, state: r.state, stateReason: r.state_reason, stateSince: r.state_since,
    });
  }
  return out;
}

/**
 * Records the source fingerprint a note has ACCOUNTED FOR. Two callers, one meaning: an
 * APPLIED proposal (the note now reflects those sources) and a REJECTED one (Bendik looked
 * at what those sources produced and said no).
 *
 * A note with no row THROWS. It used to be tempting to make this a silent no-op, but the
 * caller that matters is the rejection branch, whose whole job is to remember a decision —
 * an UPDATE matching zero rows lets it "succeed", close the proposal, and hand Bendik the
 * identical draft on the next tick. Loud is safe: the apply pass runs this before closing,
 * so a throw leaves the decision unexecuted and the next tick retries it.
 */
export async function recordAtlasSourcesAccounted(
  db: Queryable, notePath: string, sourcesHash: string,
): Promise<void> {
  const res = await db.query<{ note_path: string }>(
    `UPDATE atlas_notes SET accounted_sources_hash = $2, updated_at = now()
      WHERE note_path = $1 RETURNING note_path`,
    [notePath, sourcesHash],
  );
  if (res.rows.length === 0) {
    throw new Error(
      `atlas: cannot record a decision against ${notePath} — it has no state row. The proposer ` +
      "must upsert one before it proposes, or the decision has nowhere to live and the " +
      "proposal comes back on the next tick.",
    );
  }
}

/**
 * Sets a note's health state and reports whether it CHANGED — which is what lets the caller
 * ping on transitions only. A source that stays unreachable for a week must be one message,
 * not seven; and a source that comes back must say so.
 *
 * IMPLEMENTER NOTE ON RETURNING: a plain `UPDATE … RETURNING (atlas_notes.state IS DISTINCT
 * FROM $2)` looks right and is wrong — RETURNING projects the row AFTER the write, so
 * `atlas_notes.state` in that clause is already the NEW value and the comparison is always
 * false. This CTE captures the OLD state first (`before`, locked FOR UPDATE so nothing else
 * can change it between the read and the write), then does the UPDATE, then compares
 * old-vs-new in the final SELECT — the only way to see both sides of the same write.
 *
 * state_since keeps its FIRST value while the state holds (the COALESCE), so it records
 * when the trouble started rather than when it was last re-noticed.
 */
export async function setAtlasNoteState(
  db: Queryable, notePath: string, state: AtlasNoteState, reason: string | null, at: Date,
): Promise<boolean> {
  const res = await db.query<{ changed: boolean }>(
    `WITH before AS (
       SELECT note_path, state FROM atlas_notes WHERE note_path = $1 FOR UPDATE
     ),
     upd AS (
       UPDATE atlas_notes
          SET state = $2,
              state_reason = $3,
              state_since = CASE WHEN atlas_notes.state = $2
                                 THEN COALESCE(atlas_notes.state_since, $4) ELSE $4 END,
              updated_at = now()
         FROM before
        WHERE atlas_notes.note_path = before.note_path
        RETURNING before.state AS old_state
     )
     SELECT (old_state IS DISTINCT FROM $2) AS changed FROM upd`,
    [notePath, state, reason, at.toISOString()],
  );
  const row = res.rows[0];
  if (row === undefined) throw new Error(`atlas: no state row for ${notePath}`);
  return row.changed;
}
