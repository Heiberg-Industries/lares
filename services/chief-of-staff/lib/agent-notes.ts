/**
 * lib/agent-notes.ts — the store behind `catalogue/save_note.ts` (W4B-s5, ADR-0018 rule 9).
 *
 * WHAT A NOTE IS, AND IS NOT. A working note the agent leaves for itself mid-conversation — "the
 * owner prefers the summary first", "waiting on the supplier's reply about X" — because a
 * conversation can be interrupted at any time. It is never a fact about the owner
 * (`lib/standing-facts.ts` is that store) and it is never a standing instruction the dream cycle
 * may promote: `agent_notes` has no reader anywhere near `@lares/agent-kit/learning`'s promotion
 * gate, and none is added by this slice.
 *
 * ADD-ONLY, BY CONSTRUCTION. There is no `UPDATE` and no `DELETE` anywhere in this module, and
 * none in `services/box/sql/071_agent_notes.sql` either — a wrong or stale note is superseded by
 * a newer one, exactly as a standing fact is, never rewritten. `tests/agent-notes.test.ts` pins
 * this by importing the module and asserting no export name matches update/edit/delete/remove.
 *
 * ORIGIN IS NEVER A CALLER-SUPPLIED FIELD. `catalogue/save_note.ts` computes it with
 * `stampFor("agent", key)` before calling `addNote` — this module only stores whatever class it
 * is handed, the same posture `rememberFact` takes toward `remember.ts`'s own gate.
 *
 * WHY A TABLE, NOT A MARKDOWN FILE. `_meta/` is excluded from vault search
 * (`packages/agent-kit/src/notes-store.ts:30`, ADR-0017 rule 1), so a note written there would be
 * unfindable; `duties.md`/`voice.md` are definition files, hashed at session start
 * (`packages/agent-kit/src/definition.ts:143`), so appending to them would change the agent's own
 * definition hash mid-conversation.
 *
 * WHERE THIS SLICE STOPS. Nothing outside the session that wrote a note reads it back yet —
 * `agent/instructions/standing-facts.ts`'s turn-scoped correction block surfaces a session's own
 * notes on a LATER TURN of the SAME conversation, and only the ones safe to reflect back (see
 * that file's header); a later session cannot read any note at all. That is wave 5A's job
 * ("which memories did you use?"), named here rather than implied.
 */
import type { Pool } from "pg";
import type { Origin } from "@lares/agent-kit/origin";

/** The three shapes a note can take — a label, not prose. A fixed, small set on purpose: this
 *  is a constrained shape, not a free-form scratchpad. */
export const AGENT_NOTE_KINDS = ["working", "watch", "followup"] as const;
export type AgentNoteKind = (typeof AGENT_NOTE_KINDS)[number];

/** A sentence, not a transcript — mirrors `MAX_FACT_LENGTH`'s reasoning in
 *  `lib/standing-facts.ts`, and is the same ceiling `sql/071_agent_notes.sql`'s CHECK enforces. */
export const MAX_NOTE_LENGTH = 400;

export interface AgentNote {
  /** `BIGSERIAL`, narrowed to a JS number — see `StandingFact.id`'s identical reasoning. */
  id: number;
  owner: string;
  /** What wrote the row — a role/agent label, never a person. `process.env["LARES_AGENT_NAME"]`
   *  at the call site, the same fallback `lib/turn-capture.ts` and `agent/schedules/dream.ts`
   *  already use. */
  agent: string;
  kind: AgentNoteKind;
  note: string;
  /** Computed by `stampFor`, never supplied by the caller — see the module header. */
  origin: Origin;
  sessionId: string;
  turnId: string;
  at: Date;
}

export interface NewAgentNote {
  owner: string;
  agent: string;
  kind: AgentNoteKind;
  note: string;
  origin: Origin;
  sessionId: string;
  turnId: string;
}

/** The refusal, or null when the note may be stored — mechanical checks only, the same posture
 *  `rejectFact` takes. Unlike a standing fact, a note may legitimately be day-scoped or carry a
 *  hedge ("I think she meant Thursday") — it is the agent's own working note, not a claim about
 *  what the owner said, so neither check from `rejectFact` applies here. */
export function rejectNote(note: string): string | null {
  const trimmed = note.trim();
  if (!trimmed) {
    return "There is nothing to note — say what you want to carry forward.";
  }
  if (trimmed.length > MAX_NOTE_LENGTH) {
    return `A note is one sentence, at most ${MAX_NOTE_LENGTH} characters — this was ${trimmed.length}. Say only the part that matters.`;
  }
  return null;
}

interface AgentNoteRow {
  id: string;
  owner: string;
  agent: string;
  kind: string;
  note: string;
  origin: string;
  session_id: string;
  turn_id: string;
  at: Date;
}

function toNote(row: AgentNoteRow): AgentNote {
  return {
    id: Number(row.id),
    owner: row.owner,
    agent: row.agent,
    kind: row.kind as AgentNoteKind,
    note: row.note,
    origin: row.origin as Origin,
    sessionId: row.session_id,
    turnId: row.turn_id,
    at: row.at,
  };
}

/**
 * Add a note. One `INSERT … RETURNING` — there is no other statement in this module, which is
 * what makes "add-only" a property of the code rather than a promise about it.
 */
export async function addNote(db: Pool, n: NewAgentNote): Promise<AgentNote> {
  const { rows } = await db.query<AgentNoteRow>(
    `INSERT INTO agent_notes (owner, agent, kind, note, origin, session_id, turn_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, owner, agent, kind, note, origin, session_id, turn_id, at`,
    [n.owner, n.agent, n.kind, n.note.trim(), n.origin, n.sessionId, n.turnId],
  );
  return toNote(rows[0]!);
}

/** How many of a session's notes the correction block may carry. A session can live for weeks
 *  and a note is up to `MAX_NOTE_LENGTH` characters, so without a bound the block — and every
 *  turn's prompt — grows for as long as the conversation does. The newest win: an older note
 *  is still in the table, it just stops being repeated. */
export const NOTES_SURFACED_PER_SESSION = 10;

/** The newest `NOTES_SURFACED_PER_SESSION` notes added in one session, oldest first — what the
 *  turn-scoped correction block reads. */
export async function notesForSession(db: Pool, sessionId: string): Promise<AgentNote[]> {
  const { rows } = await db.query<AgentNoteRow>(
    `SELECT id, owner, agent, kind, note, origin, session_id, turn_id, at
       FROM agent_notes
      WHERE session_id = $1
      ORDER BY id DESC
      LIMIT $2`,
    [sessionId, NOTES_SURFACED_PER_SESSION],
  );
  return rows.map(toNote).reverse();
}

/** Postgres `undefined_table` (42P01) — the shape an unapplied 071 migration produces. The same
 *  code `lib/turn-capture.ts`'s own (private) check reads for `conversation_entries`. Exported so
 *  `catalogue/save_note.ts` can fail soft instead of throwing on an installation that has not
 *  applied `services/box/sql/071_agent_notes.sql` yet. */
export function isMissingTableError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "42P01";
}
