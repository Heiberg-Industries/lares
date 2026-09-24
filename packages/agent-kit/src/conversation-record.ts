/**
 * src/conversation-record.ts — ADR-0020's one conversation record.
 *
 * `conversation_entries` (`services/box/sql/060_conversation_entries.sql`) is the append-only
 * table behind this store: one row per exchange, stamped with an `Origin` at write time, never
 * edited afterward. A correction is a new row, not an UPDATE — this module offers no update or
 * delete of an entry's content; `pruneBefore` removes whole rows by age, for the nightly
 * retention job only, and is the one exception the ADR names.
 *
 * Standalone functions over an injected `db: Pool`, in the shape of
 * `services/chief-of-staff/lib/standing-facts.ts`: a `ROW_COLUMNS` constant so the `SELECT`
 * list and the row type cannot drift, and a `toEntry` mapper that narrows `origin` through
 * `isOrigin` and throws — naming the row id — if it ever sees a class outside the five (the
 * table's own CHECK constraint should make that impossible; a reader hitting it means the
 * constraint was dropped, not that the reader should guess).
 */
import type { Pool } from "pg";
import { isOrigin, type Origin } from "@lares/agent-kit/origin";

export interface ConversationEntry {
  id: string; // uuid
  agent: string; // LARES_AGENT_NAME
  sessionId: string;
  turnId: string;
  door: string; // "slack" | "telegram" | … — whatever the door reports
  /** Who this entry belongs to, for export and erase. The canonical user id, never a channel address. */
  personKey: string;
  /** The scheduled lane, or null when a human spoke. Kept as a column, not inferred from origin. */
  lane: string | null;
  origin: Origin;
  input: string;
  reply: string;
  proposals: string[];
  at: Date;
  recordedAt: Date;
}

export interface NewConversationEntry {
  agent: string;
  sessionId: string;
  turnId: string;
  door: string;
  personKey: string;
  lane?: string | null;
  origin: Origin;
  input: string;
  reply: string;
  proposals: string[];
  at: Date;
}

const ROW_COLUMNS = "id, agent, session_id, turn_id, door, person_key, lane, origin, input, reply, proposals, at, recorded_at";

interface ConversationEntryRow {
  id: string;
  agent: string;
  session_id: string;
  turn_id: string;
  door: string;
  person_key: string;
  lane: string | null;
  origin: string;
  input: string;
  reply: string;
  proposals: string[];
  at: Date;
  recorded_at: Date;
}

function toEntry(row: ConversationEntryRow): ConversationEntry {
  if (!isOrigin(row.origin)) {
    throw new Error(
      `conversation_entries row ${row.id} carries origin "${row.origin}", not one of the five classes — the table's CHECK constraint should make this impossible.`,
    );
  }
  return {
    id: row.id,
    agent: row.agent,
    sessionId: row.session_id,
    turnId: row.turn_id,
    door: row.door,
    personKey: row.person_key,
    lane: row.lane,
    origin: row.origin,
    input: row.input,
    reply: row.reply,
    proposals: row.proposals,
    at: row.at,
    recordedAt: row.recorded_at,
  };
}

/**
 * `conversation_retention` (`services/box/sql/061_conversation_retention.sql`) is the one
 * per-owner setting ADR-0020 rule 3 asks for: twelve months by default, and the owner may
 * shorten it, lengthen it, or choose "keep forever". `null` is the unambiguous spelling of
 * "keep forever" — never a magic large number — and a missing row is read as the documented
 * default, never as "delete everything" and never as "keep forever". Pattern copied from
 * `services/chief-of-staff/lib/deadlines-store.ts`'s `readLadderEnabled`.
 */

/** `null` means keep forever. Never `0` — a zero would read as "delete everything tonight". */
export type RetentionMonths = number | null;
export const DEFAULT_RETENTION_MONTHS = 12;

/** No row ⇒ the documented default. THROWS on a query error: the prune must never read an
 *  outage as "keep nothing". Pattern: deadlines-store.ts:247's readLadderEnabled. */
export async function readRetentionMonths(db: Pool, owner: string): Promise<RetentionMonths> {
  const { rows } = await db.query<{ months: number | null }>(
    `SELECT months FROM conversation_retention WHERE owner = $1`,
    [owner],
  );
  return rows.length > 0 ? rows[0]!.months : DEFAULT_RETENTION_MONTHS;
}

export async function writeRetentionMonths(
  db: Pool,
  owner: string,
  months: RetentionMonths,
  updatedBy: string,
): Promise<void> {
  await db.query(
    `INSERT INTO conversation_retention (owner, months, updated_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (owner) DO UPDATE SET months = $2, updated_by = $3, updated_at = now()`,
    [owner, months, updatedBy],
  );
}

/** The cutoff instant, or undefined when nothing should ever be pruned. Calendar months, not
 *  `30 * months` days, because "twelve months" is what the owner was told. */
export function cutoffFor(months: RetentionMonths, now: Date): Date | undefined {
  if (months === null) return undefined;
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return cutoff;
}

/**
 * The nightly prune, ADR-0020 rule 3 — the ONE place in this engine that deletes an owner's
 * conversation history, and the only table it may ever touch is `conversation_entries`.
 *
 * IT DOES NOT TOUCH EVE'S OWN TABLES. `workflow.workflow_*` and `graphile_worker.*` hold turn
 * content too, and tonight's finding (`docs/research/2026-09-18-eve-session-rows-retention.md`)
 * says plainly that pruning them is unknown-until-measured on this version of the framework:
 * that schema has no foreign keys, so a delete the framework still needs succeeds silently and
 * surfaces as a wedged chat or an approval button that fails under the owner's finger. Rule 5 of
 * the ADR keeps them out of the retention setting entirely. Do not widen this function.
 *
 * THE ONE DELIBERATE WIDENING: `memory_reads` (`services/box/sql/075_memory_reads.sql`). A read
 * record says which remembered thing one turn's answer opened, so it is conversation data by the
 * same test as everything else here, and it is pruned on the exact cutoff already computed for
 * `conversation_entries` — never a second retention promise about the same conversation.
 *
 * EVERY UNKNOWN RESOLVES TOWARDS KEEPING DATA. This is the deliberate inversion of the house
 * pattern (`deadlines-store.ts`'s `readLadderEnabled` treats an unreadable switch as OFF): a
 * schedule that reads an outage as "ladder off" loses a nudge, while a prune that reads an
 * outage as "keep nothing" loses the record for ever. So:
 *   - the setting cannot be read (outage, or migration 061 not applied)  -> refuse, delete nothing;
 *   - the stored setting is NULL ("keep forever")                        -> delete nothing, no query;
 *   - no row at all                                                      -> twelve months, the
 *     documented default — never "delete everything" and never "keep forever";
 *   - the clock is obviously wrong (before 2026)                         -> refuse, delete nothing,
 *     because the cutoff is computed from the clock and nothing else;
 *   - anything newer than the floor                                      -> kept, whatever the
 *     owner's setting says.
 *
 * It reports what it did — the outcome, the cutoff it used and the number of rows removed — so
 * the caller can say it out loud. A prune that has been quietly refusing for weeks is exactly the
 * silent-degradation shape this fleet keeps producing.
 */
export interface PruneOutcome {
  /** Never a bare number, so a caller cannot read a refusal as "nothing to do". */
  outcome: "pruned" | "kept-forever" | "refused";
  deleted: number;
  /** `memory_reads` rows removed on the same cutoff — 0 whenever `deleted` is 0, and 0 (not
   *  undefined) on a box that has not applied `services/box/sql/075_memory_reads.sql`. */
  deletedReads: number;
  /** The instant actually used — the owner's window, or the floor, whichever is earlier. */
  cutoff?: Date;
  /** Why nothing was deleted, in a sentence an operator can act on. */
  reason?: string;
  /** The run stopped at its batch limit and older rows are still there for the next one. */
  batchLimited?: boolean;
}

/** Postgres's "relation does not exist" (42P01) — the shape `memory_reads`
 *  (`services/box/sql/075_memory_reads.sql`) raises when a box has not applied that migration
 *  yet. The same code every other fail-soft memory read in this repo catches
 *  (`@lares/agent-kit/memory-read`, `services/chief-of-staff/lib/memory-reads.ts`). */
function isMissingMemoryReadsTable(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "42P01";
}

/** Nothing newer than this many days is ever deleted, whatever the setting says. A console
 *  control that can be set to one month is a console control that can be set to one month by
 *  accident, and the last thirty days is the window an owner can still remember and complain
 *  about. A parameter so a test can prove it; no console surface. */
export const PRUNE_FLOOR_DAYS = 30;

/** Rows removed in one run. A first prune on a table that has never been pruned could otherwise
 *  be a single DELETE over millions of rows, holding locks on the table the door writes to on
 *  every turn. What is left waits for the next night; the run says so. */
export const PRUNE_BATCH_LIMIT = 5_000;

/** A clock reading before this is a broken clock, not a date. The container's clock is the only
 *  input to the cutoff, and a clock stuck at the epoch would compute a cutoff in 1969 (deletes
 *  nothing) — but one stuck FORWARD, or one misread, would compute a cutoff far in the future
 *  and take the whole record. Refusing below a known-past instant is the cheap half of that. */
export const EARLIEST_SANE_CLOCK = new Date("2026-01-01T00:00:00Z");

export async function pruneForOwner(
  db: Pool,
  opts: { owner: string; now: Date; floorDays?: number; batchLimit?: number },
): Promise<PruneOutcome> {
  const now = opts.now;
  if (Number.isNaN(now.getTime()) || now.getTime() < EARLIEST_SANE_CLOCK.getTime()) {
    return {
      outcome: "refused",
      deleted: 0,
      deletedReads: 0,
      reason:
        `the clock reads ${Number.isNaN(now.getTime()) ? "an invalid date" : now.toISOString()}, ` +
        `before ${EARLIEST_SANE_CLOCK.toISOString()} — nothing was deleted, because the cutoff is computed from the clock`,
    };
  }

  let months: RetentionMonths;
  try {
    months = await readRetentionMonths(db, opts.owner);
  } catch (e) {
    return {
      outcome: "refused",
      deleted: 0,
      deletedReads: 0,
      reason:
        `could not read the retention setting — nothing was deleted: ${e instanceof Error ? e.message : String(e)} ` +
        `(is services/box/sql/061_conversation_retention.sql applied on this installation?)`,
    };
  }

  if (months === null) return { outcome: "kept-forever", deleted: 0, deletedReads: 0 };

  const window = cutoffFor(months, now)!;
  const floor = new Date(now);
  floor.setUTCDate(floor.getUTCDate() - (opts.floorDays ?? PRUNE_FLOOR_DAYS));
  const cutoff = window < floor ? window : floor;
  const limit = opts.batchLimit ?? PRUNE_BATCH_LIMIT;

  let deleted: number;
  try {
    // `person_key`, NOT `agent`: retention is a promise to a PERSON, and an installation running
    // three agents must not keep a copy of what was said because a different agent wrote the row.
    // The sub-select bounds the run; `ORDER BY at` makes it the OLDEST rows that go first, so a
    // limited run is a prefix of the same work and not an arbitrary sample of it.
    const result = await db.query(
      `DELETE FROM conversation_entries
        WHERE ctid IN (
          SELECT ctid FROM conversation_entries
           WHERE person_key = $1 AND at < $2
           ORDER BY at ASC
           LIMIT $3
        )`,
      [opts.owner, cutoff, limit],
    );
    deleted = result.rowCount ?? 0;
  } catch (e) {
    // One statement, so a failure deleted nothing — and that is what this says.
    return {
      outcome: "refused",
      deleted: 0,
      deletedReads: 0,
      cutoff,
      reason: `could not delete — nothing was deleted: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // `memory_reads` (see the header) is pruned on this same cutoff — not batched: the table is
  // tiny beside `conversation_entries` and a partial read-record prune has no meaning. A missing
  // table (a box that has not applied 075) means nothing was ever recorded, not a failure; any
  // other error is unexpected and is left to propagate rather than be reported as "refused" —
  // the conversation entries above were already deleted, so that word would be a lie.
  let deletedReads = 0;
  try {
    const readsResult = await db.query(`DELETE FROM memory_reads WHERE owner = $1 AND at < $2`, [opts.owner, cutoff]);
    deletedReads = readsResult.rowCount ?? 0;
  } catch (e) {
    if (!isMissingMemoryReadsTable(e)) throw e;
  }

  return { outcome: "pruned", deleted, deletedReads, cutoff, batchLimited: deleted >= limit };
}

export function makeConversationRecord(db: Pool): {
  append(e: NewConversationEntry): Promise<ConversationEntry>;
  since(opts: { agent: string; since: Date; excludeLanes?: boolean; limit?: number }): Promise<ConversationEntry[]>;
  forPerson(personKey: string): Promise<ConversationEntry[]>;
  pruneBefore(before: Date): Promise<number>;
} {
  return {
    /** Append-only. Returns the stored row. Re-appending the same (agent, session, turn) is a NEW row —
     *  a correction is an entry, never an edit (ADR-0020 operational rules). */
    async append(e: NewConversationEntry): Promise<ConversationEntry> {
      const { rows } = await db.query<ConversationEntryRow>(
        `INSERT INTO conversation_entries (agent, session_id, turn_id, door, person_key, lane, origin, input, reply, proposals, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING ${ROW_COLUMNS}`,
        [e.agent, e.sessionId, e.turnId, e.door, e.personKey, e.lane ?? null, e.origin, e.input, e.reply, e.proposals, e.at],
      );
      return toEntry(rows[0]!);
    },

    /** Entries strictly after `since`, oldest first, optionally excluding scheduled lanes. */
    async since(opts: { agent: string; since: Date; excludeLanes?: boolean; limit?: number }): Promise<ConversationEntry[]> {
      const { rows } = await db.query<ConversationEntryRow>(
        `SELECT ${ROW_COLUMNS}
           FROM conversation_entries
          WHERE agent = $1 AND at > $2 ${opts.excludeLanes ? "AND lane IS NULL" : ""}
          ORDER BY at ASC
          LIMIT $3`,
        [opts.agent, opts.since, opts.limit ?? null],
      );
      return rows.map(toEntry);
    },

    /** Every entry for one person — the read half of export-a-person. */
    async forPerson(personKey: string): Promise<ConversationEntry[]> {
      const { rows } = await db.query<ConversationEntryRow>(
        `SELECT ${ROW_COLUMNS}
           FROM conversation_entries
          WHERE person_key = $1
          ORDER BY at DESC`,
        [personKey],
      );
      return rows.map(toEntry);
    },

    /** Rows older than `before`. Returns the count deleted. Used only by the prune job. */
    async pruneBefore(before: Date): Promise<number> {
      const result = await db.query("DELETE FROM conversation_entries WHERE at < $1", [before]);
      return result.rowCount ?? 0;
    },
  };
}
