// lib/memory-reads.ts — which remembered things one answer actually opened (box 075).
//
// Two tables, two questions: `memory_use` (073) is the retirement clock — one row per
// (kind, ref, owner) for all time, no session, no turn. This table is append-only and answers
// "which memories did THIS answer use" instead of "has this ever been used". See
// services/box/sql/075_memory_reads.sql for the full rationale.

import type { Pool } from "pg";

/** What kind of remembered thing was opened. `standing_fact` and `preference` match
 *  `lib/dream/store.ts`'s `MemoryKind` exactly; `vault_note` and `agent_note` are new. */
export type ReadKind = "standing_fact" | "preference" | "vault_note" | "agent_note";

export const READ_KINDS: readonly ReadKind[] = ["standing_fact", "preference", "vault_note", "agent_note"];

/** `turnId` is "" for the session-scoped facts block, which is shown on every turn of the
 *  session and therefore belongs to all of them. */
export interface MemoryRead {
  sessionId: string;
  turnId: string;
  owner: string;
  kind: ReadKind;
  ref: string;
  at: Date;
}

let warnedAboutMemoryReads = false;

function warnAboutMemoryReads(err: unknown): void {
  if (warnedAboutMemoryReads) return;
  warnedAboutMemoryReads = true;
  console.warn(
    "memory-reads: could not record a read (this and any further failures this process are " +
      "swallowed) — apply services/box/sql/075_memory_reads.sql if it is not there yet. " +
      "The turn that triggered this is unaffected.",
    err,
  );
}

/** Resets the once-per-process warning flag. Test-only. */
export function resetReadWarningForTests(): void {
  warnedAboutMemoryReads = false;
}

/**
 * Records that these remembered things were opened by name or path in this turn (or, with
 * `turnId: ""`, the session's standing-facts block).
 *
 * BEST-EFFORT BY CONSTRUCTION. NEVER throws, never blocks, and a failure is logged at most once
 * per process: recording a read must not be able to cost a turn.
 */
export async function recordRead(
  db: Pool,
  r: { sessionId: string; turnId: string; owner: string; kind: ReadKind; refs: readonly string[] },
): Promise<void> {
  if (r.refs.length === 0) return;
  try {
    await db.query(
      `INSERT INTO memory_reads (session_id, turn_id, owner, kind, ref)
       SELECT $1, $2, $3, $4, unnest($5::text[])
       ON CONFLICT (session_id, turn_id, kind, ref) DO NOTHING`,
      [r.sessionId, r.turnId, r.owner, r.kind, r.refs],
    );
  } catch (err) {
    warnAboutMemoryReads(err);
  }
}
