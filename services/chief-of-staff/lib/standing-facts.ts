/**
 * lib/standing-facts.ts — the store behind this role's `remember` / `forget` (ORB-167).
 *
 * THE PROBLEM THIS EXISTS FOR. On the morning of 2026-08-25 the owner corrected the agent five
 * times in one conversation: the hotel is for tonight, not all day; the 16:30 is a remote call;
 * the train, not the car, between the two offices. Every one of those was durable, and every one
 * died when the chat ended. The nightly dream cycle is the slow lane (it distils conversation
 * logs into the Brain overnight); this is the fast one — the owner says it once, and it is
 * standing from the next turn onward.
 *
 * A FACT IS THE OWNER'S WORDS. `fact` holds what the owner said, verbatim, never the agent's
 * summary of it. That is the same rule `@lares/compose-contract` already imposes on prose — never
 * assert what isn't grounded — applied to memory, where it matters more: a paraphrase that drifts
 * one word ("prefers the train" → "always takes the train") becomes a standing instruction nobody
 * remembers agreeing to, and it rides on every single turn afterwards.
 *
 * WHAT THIS FILE ENFORCES vs WHAT THE DESCRIPTION ASKS FOR. `rejectFact` catches the two
 * mechanically detectable failures — an empty fact, and a fact that is true only today. It
 * cannot detect a fluent paraphrase, and it does not pretend to; the tool description carries
 * that rule to the model. This is a net under a stated contract, not a detector.
 *
 * Storage: `standing_facts` in `lares_state` — `sql/002-standing-facts.sql`, hand-applied
 * (the box has no auto-migrate). Standalone functions taking `db: Pool`, matching every
 * sibling store here (`lib/reminders-store.ts`, `lib/obligations-store.ts`).
 */
import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import type { Origin } from "@lares/agent-kit/origin";
import type { AgentNote } from "./agent-notes.js";

/** The five buckets a standing fact can fall in. The tool's zod enum is built from this, so
 *  adding a category is a code change in one place. */
export const STANDING_FACT_CATEGORIES = ["travel", "schedule", "preference", "people", "places"] as const;
export type StandingFactCategory = (typeof STANDING_FACT_CATEGORIES)[number];

/** Which shelf a standing fact belongs on (ADR-0018 rule 7).
 *  `world`   — a fact about a person, a company or a place. Its long-term home is that
 *              entity's page in the vault; the row is the dated, checkable version of it.
 *  `conduct` — a standing instruction about how to act on the owner's behalf. Its long-term
 *              home is the agent's own notes area; the row is what makes it dated. */
export type FactShelf = "world" | "conduct";

/** Total over STANDING_FACT_CATEGORIES — a new category will not compile without a shelf. */
export const SHELF_OF_CATEGORY: Readonly<Record<StandingFactCategory, FactShelf>> = {
  travel: "conduct",
  schedule: "conduct",
  preference: "conduct",
  people: "world",
  places: "world",
};

export function shelfOf(category: StandingFactCategory): FactShelf {
  return SHELF_OF_CATEGORY[category];
}

export interface StandingFact {
  /** `BIGSERIAL`, narrowed to a JS number — the sequence would have to reach 2^53 for that to
   *  lose anything, and this table gains a handful of rows a month. The model names this id
   *  when it calls `forget`, so it must stay short enough to say. */
  id: number;
  /** The owner's own words. */
  fact: string;
  category: StandingFactCategory;
  /** The eve turn the words were said in — how any row is traced back to its conversation. */
  sourceTurn: string;
  /**
   * The canonical user id (e.g. `CANONICAL_USER_ID` from `lib/identity-client.ts`) this fact
   * belongs to. NO foreign key to a users table (`sql/003-facts-owner.sql`) — deliberately: a
   * fact must outlive alias churn in whatever identity registry sits above it.
   */
  userId: string;
  statedAt: Date;
  retiredAt: Date | null;
  /**
   * Always `"owner"` — `sql/004-standing-facts-origin.sql`'s CHECK constraint admits no other
   * class (Owner decision A2). `rememberFact` computes this; it is not a caller-supplied field.
   */
  origin: Origin;
  /** When the ROW was written. Differs from `statedAt` only for a hand-dated backfill, which
   *  is why both exist: `statedAt` is when it became true, this is when we learned it. */
  recordedAt: Date;
  /** What wrote the row — a tool name or a job label, never a person and never a persona.
   *  `"remember"` for every row this store has ever held. */
  source: string;
  /** The id of the row that replaced this one, or null. Set only by `supersedeFact`
   *  (W4A-s2); `forgetFact` leaves it null, because a retirement is not a replacement. */
  supersededBy: number | null;
  /** Which shelf this fact belongs on (ADR-0018 rule 7) — DERIVED from `category`, never
   *  stored: see `shelfOf`. */
  readonly shelf: FactShelf;
}

/**
 * How many facts reach the prompt. This block rides on EVERY turn and both briefs, so an
 * unbounded list is a standing cost leak, not a one-off one. Forty is generous for a year of
 * corrections; past that, the oldest stop being injected but stay in the table (nothing is
 * deleted, so raising the cap is a one-line change that recovers them).
 */
export const MAX_STANDING_FACTS = 40;

/**
 * How long a standing-facts read may take before the caller gives up on it (ORB-167 fix round 1).
 *
 * THE HOLE THIS CLOSES. Every reader of this store treats a failure as "no facts this turn" —
 * but a `catch` only fires on a REJECTION, and the failure this box actually produces is a
 * STALL: `db` up but unresponsive (a full disk, which has happened here before, or
 * `max_connections` exhausted). `getPool()` sets no `connectionTimeoutMillis` and eve applies no
 * timeout to a dynamic-instruction resolver, so an unbounded `pool.query` neither resolves nor
 * rejects — and the owner's message gets NO reply at all, rather than a reply without the memory.
 *
 * 1500 ms because the read is ONE indexed SELECT of at most 40 short rows. It is deliberately far
 * below any human patience threshold: the right trade here is always to answer him without her
 * memory rather than to wait for it.
 *
 * The bound is applied at each call site with `withTimeout` (lib/timeout.ts) rather than on
 * the pool: `getPool()` is @lares/agent-kit's shared singleton, and a connection-timeout set here
 * would change behaviour for every other consumer of it in every service.
 */
export const STANDING_FACTS_TIMEOUT_MS = 1500;

/** A standing fact is a sentence, not a transcript. Also the second half of the cost bound:
 *  40 facts × this ceiling is the worst case the prompt block can ever cost. */
export const MAX_FACT_LENGTH = 300;

/**
 * Words that make a statement true only today. "I'm in Oslo until 14:00 today" was one of the
 * five corrections on 2026-08-25 and is the one that must NOT be stored: tomorrow it is false,
 * and a false standing fact is worse than no memory at all — it silently poisons every brief.
 *
 * Norwegian and English both, because the owner corrects the agent in both.
 */
const DAY_SCOPED = /\b(today|tonight|tomorrow|this (?:morning|afternoon|evening)|i dag|i kveld|i morgen|i natt)\b/iu;

/**
 * Hedges. The owner states things; the agent is the one that thinks something "seems" true. A
 * fact carrying a hedge is the agent's inference wearing the owner's voice, which is exactly the
 * row this table must never hold. Coarse on purpose — it catches the tell, not the intent.
 */
const HEDGED = /\b(i think|i believe|probably|maybe|perhaps|seems? to|it seems|jeg tror|virker som|kanskje|antar)\b/iu;

/**
 * The refusal, or null when the fact may be stored. Returned as a model-facing sentence rather
 * than thrown: `remember` answers the model with it, and the model can then quote him properly
 * or drop the fact — a thrown error would just cost the turn.
 */
export function rejectFact(fact: string): string | null {
  const trimmed = fact.trim();
  if (!trimmed) {
    return "A standing fact must be the owner's own words. Nothing was quoted, so there is nothing to remember.";
  }
  if (trimmed.length > MAX_FACT_LENGTH) {
    return `A standing fact is one sentence in his words, at most ${MAX_FACT_LENGTH} characters — this was ${trimmed.length}. Quote the part that stands, not the whole message.`;
  }
  if (DAY_SCOPED.test(trimmed)) {
    return "That is true today, not always — it is a fact about one day, not a standing one. Do not remember it; use it this turn and let it go.";
  }
  if (HEDGED.test(trimmed)) {
    return "That reads as your inference, not his words. Only store what he actually said, quoted as he said it.";
  }
  return null;
}

interface StandingFactRow {
  id: string;
  fact: string;
  category: string;
  source_turn: string;
  user_id: string;
  stated_at: Date;
  retired_at: Date | null;
  /** OPTIONAL for the same reason the three below are: on a box where
   *  `sql/004-standing-facts-origin.sql` has not been hand-applied yet the fallback selects a
   *  column list without it. `toFact` then reads `"owner"`, which is exactly what 004's own
   *  backfill writes, and which its CHECK constraint makes the only possible value. */
  origin?: string;
  /** The three `sql/005-standing-facts-validity.sql` columns. OPTIONAL on the row type, not on
   *  `StandingFact`: on a box where 005 has not been hand-applied yet the fallback below selects
   *  the pre-005 list, and these keys are simply absent. `toFact` supplies exactly the values 005
   *  will backfill, so a fact reads the same before and after the file is applied. */
  recorded_at?: Date;
  source?: string;
  superseded_by?: string | null;
}

function toFact(row: StandingFactRow): StandingFact {
  return {
    id: Number(row.id),
    fact: row.fact,
    category: row.category as StandingFactCategory,
    sourceTurn: row.source_turn,
    userId: row.user_id,
    statedAt: row.stated_at,
    retiredAt: row.retired_at,
    // `?? "owner"` is sql/004's backfill (`SET origin = 'owner'`) and its CHECK constraint's only
    // admissible value, for the same reason as the three below.
    origin: (row.origin ?? "owner") as Origin,
    // `?? row.stated_at` and `?? "remember"` are not guesses: they are the literal backfills in
    // sql/005 (`SET recorded_at = stated_at`, `SET source = 'remember'`). A pre-005 read
    // therefore reports what the row will say once the file is applied, never something else.
    recordedAt: row.recorded_at ?? row.stated_at,
    source: row.source ?? "remember",
    supersededBy: row.superseded_by == null ? null : Number(row.superseded_by),
    shelf: shelfOf(row.category as StandingFactCategory),
  };
}

/**
 * The columns every query in this file returns, before and after `sql/005-standing-facts-validity.sql`.
 *
 * WHY TWO LISTS. The one installation applies SQL BY HAND, and may do so days after the image
 * that reads these columns is deployed. A bare `SELECT …, recorded_at, …` against a box where
 * 005 has not run yet raises `42703 undefined_column` — and every reader of this store
 * (`agent/instructions/standing-facts.ts`, both briefs) treats a rejection as "no facts this
 * turn". The agent would silently stop applying the owner's standing facts, on every turn, until
 * somebody noticed. That is the exact failure this store exists to prevent, so it is not
 * acceptable as a migration window: the read falls back instead, and says so once.
 */
const FACT_COLUMNS_PRE_004 = "id, fact, category, source_turn, user_id, stated_at, retired_at";
const FACT_COLUMNS_PRE_005 = `${FACT_COLUMNS_PRE_004}, origin`;
const FACT_COLUMNS = `${FACT_COLUMNS_PRE_005}, recorded_at, source, superseded_by`;

/**
 * Postgres `undefined_column`. The only columns any query here names that can be missing are the
 * three 005 adds and the one 004 adds — every other one has existed since sql/002. The same shape
 * `lib/turn-capture.ts` checks for 42P01 (`undefined_table`).
 *
 * Exported because `catalogue/remember.ts` needs it too: the supersede path is a TRANSACTION and
 * therefore cannot retry in place (see `supersedeFact`), so it rethrows and the tool decides
 * whether to fall back to the older, unlinked pair of writes.
 */
export function isMissingColumnError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "42703";
}

/** Once per process, not once per turn: this block is read on every single turn, and a warning
 *  repeated forty times an hour is a log nobody reads. One flag per file, so a box missing both
 *  is told about both. */
let warnedAboutMissingValidityColumns = false;
let warnedAboutMissingOriginColumn = false;

/**
 * Run a fact query with the full column list; on a pre-005 database, run it again with the
 * pre-005 list; on a pre-004 database, once more with the pre-004 one. One warning per missing
 * file, per process.
 *
 * SAFE FOR THE WRITES TOO. Postgres resolves every column name — including the ones in a
 * `RETURNING` list — during parse analysis, before the executor touches a row. So an INSERT or
 * UPDATE that trips `42703` on `RETURNING … recorded_at` has written nothing, and the retry
 * cannot produce a duplicate row or a second retirement.
 *
 * NOT USABLE INSIDE A TRANSACTION, and `supersedeFact` therefore does not use it: the first
 * failed statement aborts the surrounding transaction, so the retry would come back `25P02
 * in_failed_sql_transaction` rather than rows. That is why the supersede path fails soft one
 * level up, in `catalogue/remember.ts`, rather than here.
 *
 * WHAT THE PRE-004 STEP DOES AND DOES NOT BUY. It makes a fact READ on a box that never applied
 * 004 — which is what every reader of this store needs, because all three of them treat a
 * rejection as "no facts this turn". It does not make a WRITE work there: `rememberFact`'s
 * INSERT names `origin` in its column list, not only in `RETURNING`, and no choice of returned
 * columns can conjure a column to insert into. A box in that state stores nothing new until 004
 * is applied, and says so once — which is the honest answer, not a silent half-write.
 */
async function queryFacts(
  db: Pool | PoolClient,
  build: (columns: string) => string,
  params: unknown[],
): Promise<StandingFactRow[]> {
  try {
    const { rows } = await db.query<StandingFactRow>(build(FACT_COLUMNS), params);
    return rows;
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    if (!warnedAboutMissingValidityColumns) {
      warnedAboutMissingValidityColumns = true;
      console.warn(
        "standing_facts has no recorded_at/source/superseded_by yet — apply " +
          "services/chief-of-staff/sql/005-standing-facts-validity.sql on this box. " +
          "Facts still load and are still stored; until it is applied, recorded_at reads as stated_at " +
          "and source reads as 'remember', which is what the file will backfill.",
      );
    }
    try {
      const { rows } = await db.query<StandingFactRow>(build(FACT_COLUMNS_PRE_005), params);
      return rows;
    } catch (older) {
      if (!isMissingColumnError(older)) throw older;
      if (!warnedAboutMissingOriginColumn) {
        warnedAboutMissingOriginColumn = true;
        console.warn(
          "standing_facts has no origin column yet — apply " +
            "services/chief-of-staff/sql/004-standing-facts-origin.sql on this box. " +
            "Facts still load; until it is applied, origin reads as 'owner', which is what the file " +
            "will backfill and the only class its CHECK constraint admits.",
        );
      }
      const { rows } = await db.query<StandingFactRow>(build(FACT_COLUMNS_PRE_004), params);
      return rows;
    }
  }
}

export interface NewStandingFact {
  fact: string;
  category: StandingFactCategory;
  sourceTurn: string;
  /** The canonical user id this fact belongs to — see `StandingFact.userId`. */
  userId: string;
  /** Defaults to the row's `now()` — passed only by tests and by a hand-dated backfill. */
  statedAt?: Date;
}

/**
 * Store a fact. Callers must have run `rejectFact` first; this writes what it is given.
 *
 * `origin` is always the literal `'owner'` — this store has no other caller, and the table's
 * CHECK constraint (`sql/004-standing-facts-origin.sql`) would refuse anything else anyway.
 * `remember.ts` is the gate that decides WHETHER to call this at all on a tainted turn; by the
 * time execution reaches here, the answer is always yes.
 */
export async function rememberFact(db: Pool, f: NewStandingFact): Promise<StandingFact> {
  // `recorded_at` and `source` are not named in the INSERT: their sql/005 DEFAULTs (`now()` and
  // `'remember'`) are already the right answer, and naming them would make this write fail on a
  // box where 005 has not been applied yet instead of falling back.
  const rows = await queryFacts(
    db,
    (columns) => `INSERT INTO standing_facts (fact, category, source_turn, user_id, stated_at, origin)
     VALUES ($1, $2, $3, $4, COALESCE($5, now()), 'owner')
     RETURNING ${columns}`,
    [f.fact.trim(), f.category, f.sourceTurn, f.userId, f.statedAt ?? null],
  );
  return toFact(rows[0]!);
}

/**
 * Store a fact while clearing a matching forget-ledger entry, in ONE transaction (W5B-s3) —
 * called only when the owner has been told a fact was forgotten and explicitly says to keep it
 * anyway (`remember`'s `evenThoughForgotten`). Injected the same way `forgetFact`'s `ledger`
 * writer is: this file keeps no dependency on `@lares/agent-kit/forget-ledger`, and the caller
 * (`catalogue/remember.ts`) builds the clearer on `removeForgotten` and passes it in.
 *
 * `clearForgotten` runs on the SAME client that ran the insert, before `COMMIT` — so a clear that
 * throws (including a missing ledger table) rolls the insert back too: there is no state in which
 * the fact is stored while the ledger still says it was forgotten, and none in which the ledger
 * is cleared but the fact was never written. The caller can then retry with plain `rememberFact`
 * (no clearer) when the failure is `isMissingLedgerTable` — the same shape `catalogue/forget.ts`
 * already uses for the opposite direction.
 *
 * Falls back to the plain, non-transactional write on a pre-005 box, exactly as `forgetFact`
 * degrades: `forget_ledger` (076) is numbered far past `sql/005-standing-facts-validity.sql`, so
 * a box holding one but not the other is the rare case, not the common one, and it still gets a
 * fact written — just without the ledger cleared in the same breath.
 */
export async function rememberFactClearingForgotten(
  db: Pool,
  f: NewStandingFact,
  clearForgotten: (client: PoolClient) => Promise<void>,
): Promise<StandingFact> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<StandingFactRow>(
      `INSERT INTO standing_facts (fact, category, source_turn, user_id, stated_at, origin)
       VALUES ($1, $2, $3, $4, COALESCE($5, now()), 'owner')
       RETURNING ${FACT_COLUMNS}`,
      [f.fact.trim(), f.category, f.sourceTurn, f.userId, f.statedAt ?? null],
    );
    const stored = toFact(rows[0]!);
    await clearForgotten(client);
    await client.query("COMMIT");
    return stored;
  } catch (err) {
    // `.catch()` so a rollback that fails cannot replace the real reason with a second one — the
    // same shape `forgetFact` and `supersedeFact` use.
    await client.query("ROLLBACK").catch(() => {});
    if (!isMissingColumnError(err)) throw err;
    const rows = await queryFacts(
      db,
      (columns) => `INSERT INTO standing_facts (fact, category, source_turn, user_id, stated_at, origin)
       VALUES ($1, $2, $3, $4, COALESCE($5, now()), 'owner')
       RETURNING ${columns}`,
      [f.fact.trim(), f.category, f.sourceTurn, f.userId, f.statedAt ?? null],
    );
    return toFact(rows[0]!);
  } finally {
    client.release();
  }
}

/**
 * The ledger seam. Injected rather than imported so this file keeps no dependency on
 * `services/box` or `@lares/agent-kit/forget-ledger` — the caller (`catalogue/forget.ts`) builds
 * one on `recordForgotten` and passes it in, and a unit test can drive the transaction with none
 * at all. Takes the retiring transaction's OWN client, never `db`, so the ledger row and the
 * retirement commit or roll back together — never one without the other.
 */
export type ForgetLedgerWriter = (client: PoolClient, f: StandingFact) => Promise<void>;

/**
 * Retire a fact he has superseded. Returns the retired row, or null when the id is unknown,
 * already retired, or owned by a DIFFERENT user — the caller tells those apart from a success,
 * and none of them is an error. Scoping this by owner means one member can never retire a fact
 * another member stated, even by guessing or brute-forcing an id.
 *
 * Never deletes: the superseded row is what explains why she used to say "train".
 *
 * ONE TRANSACTION WITH THE LEDGER. `ledger`, when given, is called with the SAME client that ran
 * the retirement, before `COMMIT` — so a ledger write that throws rolls the retirement back too:
 * there is no state in which a fact is forgotten with no ledger row, or a ledger row for a fact
 * still standing. `id`/`userId` are unchanged by a rollback, so the caller can simply retry
 * without a ledger writer (see `catalogue/forget.ts`) when the failure is `isMissingLedgerTable`.
 *
 * NOT `queryFacts` — its header says it must not run inside a transaction (the first failed
 * statement would abort it, `25P02`, and its retry would never see rows). So this function issues
 * its own `UPDATE … RETURNING` with the full column list, and if THAT trips `42703` (a pre-005 or
 * pre-004 box), it rolls back and re-runs the retirement through `queryFacts`, outside any
 * transaction, with no ledger call — the fact still retires; the ledger simply cannot be reached
 * on a box that has not applied those files yet, which is the same shape every other fallback in
 * this file already accepts.
 */
export async function forgetFact(
  db: Pool,
  id: number,
  userId: string,
  now?: Date,
  ledger?: ForgetLedgerWriter,
): Promise<StandingFact | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // `superseded_by` is deliberately left NULL: a retirement is not a replacement. The row that
    // both closes and links is `supersedeFact` (W4A-s2).
    const { rows } = await client.query<StandingFactRow>(
      `UPDATE standing_facts SET retired_at = COALESCE($3, now())
        WHERE id = $1 AND user_id = $2 AND retired_at IS NULL
        RETURNING ${FACT_COLUMNS}`,
      [id, userId, now ?? null],
    );
    if (rows.length === 0) {
      // Nothing changed — no ledger call, so a guessed or stale id never creates a ledger entry.
      await client.query("COMMIT");
      return null;
    }
    const fact = toFact(rows[0]!);
    if (ledger) await ledger(client, fact);
    await client.query("COMMIT");
    return fact;
  } catch (err) {
    // `.catch()` so a rollback that fails cannot replace the real reason with a second one — the
    // same shape `supersedeFact` uses.
    await client.query("ROLLBACK").catch(() => {});
    if (!isMissingColumnError(err)) throw err;
    // No warning of our own: `queryFacts` below already warns once per process for exactly this
    // condition (see its header) — a second, differently-worded warning for the same missing
    // file would just be a second log line nobody reads.
    const rows = await queryFacts(
      db,
      (columns) => `UPDATE standing_facts SET retired_at = COALESCE($3, now())
        WHERE id = $1 AND user_id = $2 AND retired_at IS NULL
        RETURNING ${columns}`,
      [id, userId, now ?? null],
    );
    return rows[0] ? toFact(rows[0]) : null;
  } finally {
    client.release();
  }
}

/**
 * Thrown by `supersedeFact` when `oldId` is not a standing fact of this user: an id the model
 * guessed, one that belongs to somebody else, or one that has already been closed. The caller
 * turns it into a sentence for the model — never a thrown turn.
 */
export class UnknownFactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownFactError";
  }
}

/**
 * Replace a standing fact: insert the new row, close the old one, and link them — ONE
 * transaction, never two independent calls.
 *
 * WHY THIS EXISTS. Until now the model was told to call `forget` and then `remember`, which
 * leaves two unrelated rows: a retired one and a fresh one, with nothing recording that they are
 * the same fact changing. So "why did she used to say train?" has no answer, and a reversed
 * decision does not outrank the decision it reversed — they are just two rows with two dates.
 * This function is the only writer of `superseded_by`.
 *
 * ONE TRANSACTION, AND THE ORDER IS FORCED. The insert must come first, because `superseded_by`
 * is a foreign key to the new row; `retired_at` and `superseded_by` must then be set in the SAME
 * statement, because sql/005's CHECK refuses a row that names a replacement while still standing.
 * A failure anywhere leaves both rows exactly as they were — there is no state in which the old
 * fact is closed with nothing standing in its place, which is the one outcome that would leave
 * the owner silently unrepresented.
 *
 * `FOR UPDATE` on the lock read, because two doors (two channels, two sessions) can race on the
 * same fact. Without it the second one would either fork the chain or trip the CHECK with a
 * constraint name no model can act on; with it, the second one finds the row already closed and
 * gets `UnknownFactError`, which is a sentence.
 *
 * THE OLD FACT STOPS BEING TRUE EXACTLY WHEN THE NEW ONE STARTS. Both dates come from the same
 * `f.statedAt ?? now()`, and `now()` is the transaction's timestamp, so the two instants are
 * equal to the microsecond: no gap in which the owner had no answer, no overlap in which he had
 * two.
 *
 * NOTHING IS DELETED. The closed row keeps its words, its dates, its source and its origin, and
 * gains the id of what replaced it.
 */
export async function supersedeFact(
  db: Pool,
  oldId: number,
  f: NewStandingFact,
): Promise<{ retired: StandingFact; stored: StandingFact }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Scoped by owner, exactly as `forgetFact` is: one member must never be able to close another
    // member's fact, by guessing an id or by brute-forcing one. `retired_at IS NULL` is what makes
    // a chain unable to fork — an already-closed row is not superseded a second time.
    const { rows: locked } = await client.query<{ id: string }>(
      `SELECT id FROM standing_facts
        WHERE id = $1 AND user_id = $2 AND retired_at IS NULL
        FOR UPDATE`,
      [oldId, f.userId],
    );
    if (locked.length === 0) {
      await client.query("ROLLBACK");
      throw new UnknownFactError(
        `No standing fact ${oldId} for this owner: unknown, somebody else's, or already replaced.`,
      );
    }

    // The same INSERT `rememberFact` uses, with `recorded_at` and `source` left to their sql/005
    // defaults. `user_id` is `f.userId` — the very value the lock read above was scoped by — so a
    // link can never point across owners.
    const { rows: inserted } = await client.query<StandingFactRow>(
      `INSERT INTO standing_facts (fact, category, source_turn, user_id, stated_at, origin)
       VALUES ($1, $2, $3, $4, COALESCE($5, now()), 'owner')
       RETURNING ${FACT_COLUMNS}`,
      [f.fact.trim(), f.category, f.sourceTurn, f.userId, f.statedAt ?? null],
    );
    const stored = toFact(inserted[0]!);

    const { rows: closed } = await client.query<StandingFactRow>(
      `UPDATE standing_facts SET retired_at = COALESCE($3, now()), superseded_by = $2
        WHERE id = $1
        RETURNING ${FACT_COLUMNS}`,
      [oldId, stored.id, f.statedAt ?? null],
    );

    await client.query("COMMIT");
    return { retired: toFact(closed[0]!), stored };
  } catch (err) {
    // `.catch()` so a rollback that fails cannot replace the real reason with a second one — the
    // caller branches on `isMissingColumnError(err)`, and an unapplied sql/005 must stay legible.
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The standing facts for ONE user, newest first, capped.
 *
 * ORDER BY (stated_at, id) DESC, not stated_at alone. A cap over a partial order drops an
 * arbitrary half of any tie — and ties are the normal case here, because the seed batch and
 * any hand-applied backfill insert several rows inside one `now()`. (feedback: "a cap needs a
 * known ordering".)
 *
 * `AND user_id = $1` scopes every read: one member's facts must never surface in another's
 * turn or brief. `standing_facts_owner_active_idx` (`sql/003-facts-owner.sql`) covers exactly
 * this shape — `(user_id, stated_at DESC, id DESC) WHERE retired_at IS NULL`.
 */
export async function listActiveFacts(
  db: Pool,
  userId: string,
  limit: number = MAX_STANDING_FACTS,
): Promise<StandingFact[]> {
  const rows = await queryFacts(
    db,
    (columns) => `SELECT ${columns}
       FROM standing_facts
      WHERE user_id = $1 AND retired_at IS NULL
      ORDER BY stated_at DESC, id DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows.map(toFact);
}

/**
 * How many retired facts `listRetiredFacts` ever returns in one call — "what have I retired?"
 * (owner ruling, 2026-09-19 afternoon). Fifty is generous for what this table actually
 * accumulates and matches the spirit of `MAX_STANDING_FACTS`'s reasoning: a bound that says so
 * when it cuts, rather than an unbounded read.
 */
export const RETIRED_FACTS_LIMIT = 50;

/** One retired fact, as `listRetiredFacts` reports it. */
export interface RetiredFact {
  id: number;
  fact: string;
  category: StandingFactCategory;
  statedAt: Date;
  retiredAt: Date;
  /**
   * What replaced it, or `null` when nothing did — PRESENT ONLY when
   * `sql/005-standing-facts-validity.sql`'s `superseded_by` column exists on this box. A box
   * that has not applied 005 cannot say either way, and reporting `null` there would silently
   * claim "nothing replaced it" when the true answer is "this box cannot tell yet" — so the key
   * is simply absent instead, mirroring `StandingFactRow`'s own optionality for the same column.
   */
  supersededBy?: number | null;
}

/** What `listRetiredFacts` produced. `cut` is true when more retired facts exist past the
 *  limit — the caller says so rather than silently truncating (BUILDER task: "cap the list (50)
 *  and say when it was cut"). */
export interface RetiredFactsPage {
  facts: RetiredFact[];
  cut: boolean;
}

/**
 * The owner's RETIRED standing facts (`retired_at IS NOT NULL`) — newest RETIREMENT first, not
 * newest stated. `forget` sets `retired_at` and keeps the row; nothing before this function
 * listed it back, so it is the only way the owner can see, or start to recover, what they told
 * the agent to drop. Recovering one is never something the agent does on its own: the owner
 * says it again, and `remember` (with `evenThoughForgotten` if it refuses) writes it.
 *
 * READS ONLY `standing_facts`, scoped by owner, the same as `listActiveFacts` — NEVER the
 * forget ledger (`@lares/agent-kit/forget-ledger`), which holds a one-way hash and no words at
 * all, so there is nothing there this function could read back even if it wanted to.
 *
 * SAME FALLBACK AS EVERY OTHER READ IN THIS FILE. Built on `queryFacts`, so a box missing
 * `sql/004-standing-facts-origin.sql` or `sql/005-standing-facts-validity.sql` still lists its
 * retired facts — `id`, `fact`, `category`, `stated_at` and `retired_at` have all existed since
 * `sql/002-standing-facts.sql`, so the retry ladder never has to reach further than that to
 * answer this query. This never throws for a missing 004/005 column; see `RetiredFact.supersededBy`
 * for what changes on that fallback. A genuinely broken box (no `standing_facts` table at all)
 * is the caller's concern — `catalogue/facts_list.ts` catches that and answers with an honest
 * sentence instead of throwing the turn away.
 */
export async function listRetiredFacts(
  db: Pool,
  userId: string,
  limit: number = RETIRED_FACTS_LIMIT,
): Promise<RetiredFactsPage> {
  // One extra row fetched, never returned: whether it exists is exactly what "cut" reports,
  // without a second COUNT(*) query.
  const rows = await queryFacts(
    db,
    (columns) => `SELECT ${columns}
       FROM standing_facts
      WHERE user_id = $1 AND retired_at IS NOT NULL
      ORDER BY retired_at DESC, id DESC
      LIMIT $2`,
    [userId, limit + 1],
  );
  const cut = rows.length > limit;
  const page = cut ? rows.slice(0, limit) : rows;
  return {
    cut,
    facts: page.map((row) => ({
      id: Number(row.id),
      fact: row.fact,
      category: row.category as StandingFactCategory,
      statedAt: row.stated_at,
      // Never null in practice — the WHERE clause admits only rows where it is set — but the
      // column type itself is nullable, so this stays honest about what `toFact` would say too.
      retiredAt: row.retired_at as Date,
      ...("superseded_by" in row
        ? { supersededBy: row.superseded_by == null ? null : Number(row.superseded_by) }
        : {}),
    })),
  };
}

/** One rendered fact. The id LEADS the line because `forget` needs it: a fact the model can
 *  read but cannot name is one it can never retire. */
export function standingFactLine(f: StandingFact): string {
  return `- [${f.id}] ${f.fact} (${f.category})`;
}

/**
 * The block's ceiling in CHARACTERS, not rows (Owner decision B1).
 *
 * WHY CHARACTERS. A row cap cannot bound a prompt: `MAX_STANDING_FACTS` (40) at
 * `MAX_FACT_LENGTH` (300) is roughly 12 kB of worst-case system prompt, and this block rides on
 * every session of every door. 3,000 characters is about 750 tokens — roughly twenty ordinary
 * facts, and comfortably more than any real box holds today.
 *
 * WHAT IT DOES WHEN THE FACTS DO NOT FIT. It reports; it does not cut. See `FACT_LOOKUP_TOOL`.
 */
export const STANDING_FACTS_BUDGET_CHARS = 3_000;

/**
 * The tool an agent can call to read back a fact the budget left out of the block — or `null`
 * when this service has none.
 *
 * THIS IS THE SWITCH THAT DECIDES WHETHER THE BUDGET CUTS. Until `catalogue/facts_list.ts`
 * existed, nothing here listed standing facts back to the model: `remember` writes one, `forget`
 * retires one by id, and neither reads the table back. The console's Memory page is not
 * reachable from inside a conversation either. So a budget that dropped the oldest facts then
 * would have been a one-way door — words the owner actually said, gone from the only place the
 * agent can see them, with no call it could make to get them back, and a line in the prompt
 * promising a lookup that did not exist.
 *
 * NOW THAT `facts_list` SHIPS, `buildFactsCore` starts cutting at the budget and states in the
 * block how many it left out and which tool reaches them (`tests/memory-core.test.ts`). The
 * block itself was already bounded by `MAX_STANDING_FACTS`, exactly as it has been since
 * ORB-167, and `facts_list` reads that same bound — so nothing the owner said becomes
 * unreachable, only unshown in the default block.
 */
export const FACT_LOOKUP_TOOL: string | null = "facts_list";

/** What `buildFactsCore` produced, and what it had to leave out to produce it. */
export interface FactsCore {
  markdown: string;
  /** How many of the facts offered were rendered into the block. */
  included: number;
  /** How many owner-origin facts the budget left out. Always 0 while `FACT_LOOKUP_TOOL` is null
   *  — nothing is ever dropped silently, and nothing is dropped at all when it cannot be read
   *  back. Rendered into the block, with the tool that reaches them, when it is non-zero. */
  omitted: number;
  /** Whether the rendered block is larger than the budget. True only on the no-cut path; it is
   *  what an operator (or a later slice) reads to know a box has outgrown 3,000 characters. */
  overBudget: boolean;
}

/** The four-line header. Role-neutral: the engine ships no owner's name and no persona's. */
const FACTS_CORE_HEADER = [
  "## What I have been told",
  "The owner's own words, said once and standing until they say otherwise. Apply them without being",
  "asked and never make the owner repeat one. When one changes, call `remember` again with " +
    "`supersedes` set to its id, so the two rows stay linked — call `forget` only to retire " +
    "one outright, with nothing replacing it.",
].join("\n");

function omissionLine(omitted: number, lookup: string): string {
  return `_${omitted} older ones are not shown here — call \`${lookup}\` to read them._`;
}

/**
 * The session's memory block: the owner's standing facts, in the order they were offered.
 *
 * PURE, AND THAT IS THE POINT. The same facts in the same order always produce the same bytes,
 * so a block built once at the start of a conversation can be handed back unchanged on every
 * turn of it. eve merges every dynamic instruction into ONE system message with a single
 * byte-exact cache breakpoint (see `@lares/agent-kit/clock`'s header), so bytes that wobble
 * re-bill the whole system prompt. Nothing in here reads a clock, a counter or a random source.
 *
 * OWNER-ORIGIN ONLY. Belt and braces: `sql/004-standing-facts-origin.sql`'s CHECK constraint
 * already admits no other class, and `remember` refuses a tainted turn. This function is the one
 * thing that decides what reaches a system prompt, so it checks anyway — a row that arrived by
 * some other route must never be presented to the model as something the owner said.
 *
 * NEWEST FIRST IS THE CALLER'S RULE, NOT THIS FUNCTION'S. `listActiveFacts` orders by
 * `(stated_at, id) DESC`; this renders what it is handed, in that order, and any cut takes from
 * the END. So which facts make the block is deterministic and is decided in one place.
 */
export function buildFactsCore(
  facts: readonly StandingFact[],
  budgetChars: number = STANDING_FACTS_BUDGET_CHARS,
  lookup: string | null = FACT_LOOKUP_TOOL,
): FactsCore {
  const owned = facts.filter((f) => f.origin === "owner");
  if (owned.length === 0) return { markdown: "", included: 0, omitted: 0, overBudget: false };

  const lines = owned.map(standingFactLine);
  const full = [FACTS_CORE_HEADER, ...lines].join("\n");

  if (full.length <= budgetChars) {
    return { markdown: full, included: owned.length, omitted: 0, overBudget: false };
  }

  // Over budget, and nothing can read back what a cut would remove: keep every word the owner
  // said and say so to the operator, not to the model (there is nothing the model could do with
  // it, and a line in the prompt that cannot be acted on is just more prompt).
  if (lookup === null) {
    warnAboutBlockSize(owned.length, full.length, budgetChars);
    return { markdown: full, included: owned.length, omitted: 0, overBudget: true };
  }

  // The cut. The omission line counts against the budget too, so the ceiling is a real ceiling;
  // the space reserved for it is its WORST case (every fact omitted), which keeps the result a
  // pure function of the inputs rather than of the loop's own arithmetic.
  const reserve = omissionLine(owned.length, lookup).length + 1;
  let used = FACTS_CORE_HEADER.length;
  let included = 0;
  for (const line of lines) {
    if (used + 1 + line.length + reserve > budgetChars) break;
    used += 1 + line.length;
    included += 1;
  }
  const omitted = owned.length - included;
  return {
    markdown: [FACTS_CORE_HEADER, ...lines.slice(0, included), omissionLine(omitted, lookup)].join("\n"),
    included,
    omitted,
    overBudget: false,
  };
}

/** Once per process, not once per session: a box that has outgrown the budget has outgrown it
 *  every time, and a warning repeated per conversation is a log nobody reads. */
let warnedAboutBlockSize = false;
function warnAboutBlockSize(count: number, chars: number, budget: number): void {
  if (warnedAboutBlockSize) return;
  warnedAboutBlockSize = true;
  console.warn(
    `standing facts: the memory block is ${chars} characters, over a budget of ${budget} ` +
      `(${count} facts). Nothing was left out — this service has no tool that could read back a ` +
      "fact the block dropped, so the budget reports rather than cuts (see FACT_LOOKUP_TOOL in " +
      "lib/standing-facts.ts). The block is still bounded by MAX_STANDING_FACTS.",
  );
}

/**
 * A cheap, order-independent identity for a fact set: what a later turn compares against to
 * decide whether the session's block has gone stale.
 *
 * IDS AND RETIREMENT STATE ONLY — never the text. It stays short, and it carries no content, so
 * it can sit in memory beside a prompt without being a second copy of what the owner said. Two
 * sets with the same ids standing are the same set as far as the block is concerned: rewording a
 * fact in place is not something any write path here does (a change is a supersede, which is a
 * new id), so text is not what makes a change.
 */
export function factsCoreFingerprint(facts: readonly StandingFact[]): string {
  const parts = facts.map((f) => `${f.id}:${f.retiredAt ? 1 : 0}`).sort();
  return createHash("sha256").update(parts.join(",")).digest("hex").slice(0, 16);
}

/**
 * The unbudgeted render of the same block, or "" for an empty set — an empty heading over
 * nothing is worse than silence, and eve merges this into the instruction stream verbatim.
 *
 * Kept as its own name because callers outside a session (a scheduled brief is one turn, with no
 * conversation to hold a cache for) want every fact regardless of the budget. Today it is
 * byte-identical to `buildFactsCore`'s output, because the budget does not cut; if a listing tool
 * ever makes it cut, this is the call that still does not.
 */
export function standingFactsMarkdown(facts: readonly StandingFact[]): string {
  return buildFactsCore(facts, Number.POSITIVE_INFINITY, null).markdown;
}

/**
 * The turn-scoped correction (W4B-s3, ADR-0018 rule 9): what changed since the session's block
 * (`buildFactsCore`) was built — or `""` when nothing did, which is the ordinary turn and the
 * case that must cost nothing. eve deletes an empty resolver's slot outright rather than
 * reserving space for it (`agent/instructions/standing-facts.ts`'s header), so an unchanged turn
 * adds zero bytes to the merged system message and the session's cache prefix stays byte-exact.
 *
 * COMPARES BY ID, NEVER BY TEXT — the same rule `factsCoreFingerprint` already states. The same
 * id set with the same retirement state IS the same set as far as this block is concerned: a
 * reworded fact is not something any write path here produces (a change is a `supersede`, which
 * is a new id), so text is never what triggers a correction. The fingerprint comparison is the
 * whole cost of the ordinary turn — one string compare, no rendering, no iteration.
 *
 * RETIREMENTS BEFORE ADDITIONS. A stale instruction the model is still applying is the harm this
 * exists to stop, so it is named first. Both sections render with the same `standingFactLine`
 * the session block itself used, so an id named here is the same id the model was already shown.
 *
 * `sessionFacts` is what the session's block was built from (held by the resolver alongside its
 * fingerprint); `currentFacts` is a fresh read of the same query. A fact standing in
 * `sessionFacts` that is now either absent from `currentFacts` (retired or superseded) or present
 * with `retiredAt` set is named as no longer applying; a fact active in `currentFacts` that was
 * not part of `sessionFacts` at all is named as newly told. A `supersede` therefore shows as one
 * of each — the old id retired, the new id added — because that is genuinely two facts, linked
 * only by `supersededBy`, which a resolver reading the ACTIVE list alone cannot see on the closed
 * row (`listActiveFacts` selects `WHERE retired_at IS NULL`).
 *
 * `notes` (W4B-s5) is this session's OWN `agent_notes` rows, oldest first — never another
 * session's. Rendered under "I have noted, this conversation:", so a note left on turn 3 is in
 * front of the model on turn 4 without touching the session prefix. Defaults to `[]` so every
 * existing two-argument call site and test keeps its exact behaviour.
 */
const SAFE_TO_SURFACE_NOTE_ORIGINS: ReadonlySet<Origin> = new Set(["owner", "agent", "system"]);

/** One rendered note. Mirrors `standingFactLine`'s shape, minus the id: `save_note` gives the
 *  model no id to act on, because there is nothing to retire or supersede by one. */
function agentNoteLine(n: AgentNote): string {
  return `- ${n.note} (${n.kind})`;
}

export function buildFactsCorrection(
  sessionFacts: readonly StandingFact[],
  currentFacts: readonly StandingFact[],
  notes: readonly AgentNote[] = [],
): string {
  const factsChanged = factsCoreFingerprint(sessionFacts) !== factsCoreFingerprint(currentFacts);

  // NEVER a third-party or synced note, however it is worded — a note stamped either class was
  // written on a turn that had already read someone else's words, and reflecting it back here
  // would put that text in front of the model again as "something I noted", unmarked, on every
  // later turn of the conversation — exactly the laundering path the origin model exists to
  // close (docs/specs/2026-09-18-origin-model-design.md; @lares/agent-kit/origin-taint's header).
  // The note itself is still stored, unchanged — only this render-time reflection is gated.
  const safeNotes = notes.filter((n) => SAFE_TO_SURFACE_NOTE_ORIGINS.has(n.origin));

  const currentById = new Map(currentFacts.map((f) => [f.id, f] as const));
  const sessionIds = new Set(sessionFacts.map((f) => f.id));

  const retired = factsChanged
    ? sessionFacts.filter((f) => {
        const now = currentById.get(f.id);
        return now === undefined || now.retiredAt !== null;
      })
    : [];
  const added = factsChanged
    ? currentFacts.filter((f) => f.retiredAt === null && !sessionIds.has(f.id))
    : [];

  // Unreachable for the facts half alone in practice — a fingerprint mismatch always means at
  // least one id's presence or retirement state differs — but an empty heading over nothing is
  // worse than silence, so this stays a guard rather than an assumption. `safeNotes` can make
  // this block real with nothing to say about facts at all, so the guard covers that case too.
  if (retired.length === 0 && added.length === 0 && safeNotes.length === 0) return "";

  const lines = ["## Since this conversation began"];
  if (retired.length > 0) {
    lines.push(
      "This no longer applies — ignore it from now on, whatever was said earlier in this conversation:",
    );
    lines.push(...retired.map(standingFactLine));
  }
  if (added.length > 0) {
    lines.push("I have also been told:");
    lines.push(...added.map(standingFactLine));
  }
  if (safeNotes.length > 0) {
    lines.push("I have noted, this conversation:");
    lines.push(...safeNotes.map(agentNoteLine));
  }
  return lines.join("\n");
}
