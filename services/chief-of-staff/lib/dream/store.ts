// lib/adapters/dream/store.ts — bi-temporal observation/preference store.
//
// Persists two tables:
//   dream_observations  — append-only signals extracted from conversation logs.
//   dream_preferences   — bi-temporal; active rows have valid_to IS NULL.
//                         Superseding a preference sets valid_to + superseded_by
//                         on the old row (never deletes).
//
// `db` is the minimal MiniPool interface so the store stays unit-testable with an
// injected fake — no real Postgres required. Inlined rather than imported: the
// upstream source (services/agent-runtime/lib/adapters/heartbeat.ts) is on the
// retired runtime, and eve-saga must not take a dependency on it.

import type { Pool } from "pg";

import type { Observation } from "./reflect.js";
import type { Origin } from "@lares/agent-kit/origin";

interface MiniPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

// ─── Text normalisation ───────────────────────────────────────────────────────

/**
 * Shared normalisation function for dedup matching.
 * Lowercase → strip anything that isn't a Unicode letter, digit, or whitespace
 * (removes punctuation AND emoji, keeps Norwegian ø/æ/å and other accented letters
 * via the `u` flag and \p{L}\p{N}) → collapse whitespace → trim.
 *
 * Used both when storing (to populate text_norm) and when querying (to compute
 * the value to match against). This keeps the JS and DB sides in sync regardless
 * of the Postgres collation — the canonical form is always the JS-produced value.
 */
export function normalizeObservationText(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Row types ────────────────────────────────────────────────────────────────

export interface ObservationRow {
  id: string;
  text: string;
  /** Normalised form of `text` (lowercase, punctuation/emoji stripped, whitespace collapsed).
   *  NULL for rows inserted before this column was added. */
  text_norm?: string | null;
  kind: string;
  subject: string;
  confidence: number;
  source: string | null;
  /** Which of the five ADR-0018/origin-spec classes produced this row. Never null — see
   *  `ensureDreamTables`'s ALTER TABLE for the backfill default and why it is `'agent'`. */
  origin: Origin;
  /** The identity register's canonical id this row belongs to (box 084, ruling D5). NULL for a
   *  row written before this column existed AND not labelled by `labelExistingDreamRows` (the
   *  installation had more than one member at the time, or none). Never NULL for a row this
   *  store itself inserts — `makeDreamStore`'s `owner` is bound once, at construction, and every
   *  write uses it. */
  owner: string | null;
  valid_from: string;
  valid_to: string | null;
  created_at: string;
}

export interface PreferenceRow {
  id: string;
  text: string;
  kind: string;
  subject: string;
  confidence: number;
  source: string | null;
  /** Which of the five ADR-0018/origin-spec classes produced this row. Never null. */
  origin: Origin;
  /** Same rule as `ObservationRow.owner` — see there. */
  owner: string | null;
  valid_from: string;
  valid_to: string | null;
  superseded_by: string | null;
  created_at: string;
}

// ─── Input type for addPreference ────────────────────────────────────────────

export interface PreferenceInput {
  text: string;
  kind: string;
  subject: string;
  confidence: number;
  source?: string | null;
  /** Required, not defaulted here: a preference with no stated class is the defect this
   *  column exists to end. The caller (promote.ts, surface.ts) decides the value. */
  origin: Origin;
}

// ─── DDL ─────────────────────────────────────────────────────────────────────

/** Idempotent — safe to call on every startup. */
export async function ensureDreamTables(db: MiniPool): Promise<void> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS dream_observations (
       id         uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
       text       text          NOT NULL,
       kind       text          NOT NULL,
       subject    text          NOT NULL DEFAULT '',
       confidence double precision NOT NULL DEFAULT 0,
       source     text,
       owner      text,
       valid_from timestamptz   NOT NULL DEFAULT now(),
       valid_to   timestamptz,
       created_at timestamptz   NOT NULL DEFAULT now()
     )`,
  );
  // Idempotent migration: add text_norm if the table was created before this column existed.
  // Pre-existing rows will have text_norm = NULL and won't match new normalised queries —
  // worst case a one-time re-record of those observations on the next dream cycle.
  await db.query(
    `ALTER TABLE dream_observations ADD COLUMN IF NOT EXISTS text_norm text`,
  );
  // Origin (docs/decisions/0018-learning-and-dreaming.md, docs/specs/2026-09-18-origin-model-
  // design.md). DEFAULT 'agent' is the correct backfill: every row that exists today was
  // produced by the reflector reasoning over conversation logs (cycle.ts), which is the
  // `agent` class by the spec's rule 2. Unlike `standing_facts`, there is deliberately NO
  // CHECK constraint here — these tables legitimately hold all five classes once the taint
  // reaches them. Wave 4's promotion gate is the thing that will read this column.
  await db.query(
    `ALTER TABLE dream_observations ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'agent'`,
  );
  // Owner (box 084_dream_tables_owner.sql, ruling D5, WIDENED 2026-09-19). NULLABLE, NO DEFAULT
  // — unlike `origin` above, an ALTER must never INVENT an owner: a row this store did not write
  // itself either predates the column, or belongs to an installation this code cannot see. THIS
  // CREATE TABLE, and this ALTER, are the column's one truth (`owner text`, nullable, no
  // default): box 084 runs the byte-identical `ALTER TABLE … ADD COLUMN IF NOT EXISTS owner
  // text` against a database where these tables already exist, so the two can never disagree
  // about the column's shape, whichever happens to run first — a fresh installation never sees
  // 084 do anything (box migrations run before this service ever starts, so the tables are not
  // here yet), and the one existing installation has both apply, in either order, to the same
  // result. Labelling an existing NULL row as the installation's one member (when there is
  // exactly one) is a SEPARATE, explicit step — `labelExistingDreamRows` below, and box 084's own
  // equivalent — never something this ALTER does on its own.
  await db.query(
    `ALTER TABLE dream_observations ADD COLUMN IF NOT EXISTS owner text`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS dream_preferences (
       id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
       text          text          NOT NULL,
       kind          text          NOT NULL,
       subject       text          NOT NULL DEFAULT '',
       confidence    double precision NOT NULL DEFAULT 0,
       source        text,
       owner         text,
       valid_from    timestamptz   NOT NULL DEFAULT now(),
       valid_to      timestamptz,
       superseded_by uuid,
       created_at    timestamptz   NOT NULL DEFAULT now()
     )`,
  );
  // Same rule and same backfill default as dream_observations above.
  await db.query(
    `ALTER TABLE dream_preferences ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'agent'`,
  );
  // Same rule as dream_observations' owner column above — see that comment.
  await db.query(
    `ALTER TABLE dream_preferences ADD COLUMN IF NOT EXISTS owner text`,
  );
}

// ─── Labelling pre-existing rows (box 084, ruling D5) ─────────────────────────────────────────

/** What `labelExistingDreamRows` did. */
export interface DreamLabelResult {
  /** Rows given an owner by this call. 0 on a second run — already-labelled rows are left. */
  labelled: number;
  /** The single member the rows were labelled as, or null when nothing was labelled. */
  owner: string | null;
  /** True when the register does not resolve to exactly one person — including when it holds
   *  none at all, or is not on this database — so labelling would be a guess. The name follows
   *  the owner's ruling (D5), which was written against the common "a second member joined"
   *  case; an empty or missing register reaches the same, more conservative, answer. */
  skippedBecauseSeveralMembers: boolean;
}

/**
 * Label pre-existing dream rows as the installation's single member (owner ruling D5, widened
 * 2026-09-19). Does nothing, and says so, when `users` holds anything other than exactly one row
 * — or is not on this database at all.
 *
 * THE SAME RULE AS BOX 084's OWN LABELLING STEP, expressed here for two callers the SQL file
 * cannot reach: a deploy where `ensureDreamTables` added the column (at chief-of-staff startup)
 * before 084 happened to be applied by hand over SSH, and the erase CLI's `--prepare` path (a
 * later slice). Running either implementation, or both, in either order, ends at the same
 * answer — every row that predates the column, and only those, get exactly one owner: the
 * register's one member, when there is exactly one; otherwise nothing changes.
 *
 * ONE TRANSACTION, table-level locked: a member added or removed while this runs waits for this
 * transaction to finish, so the count this decides on and the UPDATEs it gates can never see a
 * different answer than each other (the same guarantee box 083's header states for its own
 * rewrite). Only rows with `owner IS NULL` are touched — a row already labelled, by this
 * function or by a write that carried its own owner, is never revisited.
 *
 * ASSUMES both tables already exist — call `ensureDreamTables(db)` first (every real caller
 * already does, to write or read through the store at all). Unlike box 084's own labelling step,
 * this function does not itself guard a missing `dream_observations`/`dream_preferences`.
 */
export async function labelExistingDreamRows(db: Pool): Promise<DreamLabelResult> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const reg = await client.query<{ present: boolean }>(
      "SELECT to_regclass('users') IS NOT NULL AS present",
    );
    if (!reg.rows[0]?.present) {
      await client.query("COMMIT");
      return { labelled: 0, owner: null, skippedBecauseSeveralMembers: true };
    }

    // A table-level lock, not just a row lock: it blocks a concurrent INSERT/DELETE on `users`
    // until this transaction ends, which a row lock on the existing rows alone would not.
    await client.query("LOCK TABLE users IN EXCLUSIVE MODE");

    const count = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM users");
    const memberCount = Number(count.rows[0]!.n);
    if (memberCount !== 1) {
      await client.query("COMMIT");
      return { labelled: 0, owner: null, skippedBecauseSeveralMembers: true };
    }

    const only = await client.query<{ id: string }>("SELECT id FROM users LIMIT 1");
    const owner = only.rows[0]!.id;

    const obs = await client.query(
      "UPDATE dream_observations SET owner = $1 WHERE owner IS NULL",
      [owner],
    );
    const prefs = await client.query(
      "UPDATE dream_preferences SET owner = $1 WHERE owner IS NULL",
      [owner],
    );

    await client.query("COMMIT");
    return {
      labelled: (obs.rowCount ?? 0) + (prefs.rowCount ?? 0),
      owner,
      skippedBecauseSeveralMembers: false,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // A rollback that itself fails must not replace the real reason this failed.
    }
    throw err;
  } finally {
    client.release();
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/** No owner was bound to this store, and a write was attempted anyway (box 084, ruling D5).
 *  Every NEW dream row must carry the installation member it belongs to — a caller that
 *  constructs a read-only store (`makeDreamStore(db)`, no second argument) gets a loud error
 *  here instead of a silently NULL-owned row. */
function requireOwner(owner: string | undefined): string {
  if (owner === undefined) {
    throw new Error(
      "makeDreamStore: cannot write a dream row without an owner. Pass one to " +
        "makeDreamStore(db, owner) — the caller's identity, not guessed here.",
    );
  }
  return owner;
}

/**
 * `owner` is bound ONCE, here, rather than threaded through every call to `record`/
 * `addPreference` — those two methods are also called generically by
 * `@lares/agent-kit/learning`'s `makeLearningPromoter` (via `PromoterStore`/`LearningStore`,
 * whose signatures are fixed across every role that learns), so there is nowhere in that shared
 * call to add a per-write owner argument without changing the kit for every role. Binding it at
 * construction keeps this service's contract with the kit unchanged and makes the owner
 * EXPLICIT at exactly the one place a future multi-user caller has to change: which store an
 * agent's turn constructs, not the generic gate that writes through it (box 084, ruling D5).
 *
 * Optional because the read-only callers (`lib/dream-store.ts`'s `activePreferences`, read by
 * `agent/schedules/weekly-summary.ts`) never write, and requiring an owner they do not have and
 * do not need would be a pointless ceremony — `record` and `addPreference` are the only two
 * methods that need one, and each throws if it is missing rather than writing a silent NULL.
 */
export function makeDreamStore(db: MiniPool, owner?: string) {
  return {
    /**
     * Append an observation extracted by the reflector.
     * Returns the stored row (including the generated id).
     */
    async record(obs: Observation, source: string | undefined, origin: Origin): Promise<ObservationRow> {
      const { rows } = await db.query(
        `INSERT INTO dream_observations (text, text_norm, kind, subject, confidence, source, origin, owner)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          obs.text, normalizeObservationText(obs.text), obs.kind, obs.subject, obs.confidence,
          source ?? null, origin, requireOwner(owner),
        ],
      );
      return rows[0] as ObservationRow;
    },

    /**
     * Insert an ACTIVE preference (valid_to NULL) into dream_preferences.
     * Returns the stored row with its generated id.
     */
    async addPreference(pref: PreferenceInput): Promise<PreferenceRow> {
      const { rows } = await db.query(
        `INSERT INTO dream_preferences (text, kind, subject, confidence, source, origin, owner)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [pref.text, pref.kind, pref.subject, pref.confidence, pref.source ?? null, pref.origin, requireOwner(owner)],
      );
      return rows[0] as PreferenceRow;
    },

    /**
     * All currently active preferences, ordered by confidence desc then created_at asc.
     */
    async activePreferences(): Promise<PreferenceRow[]> {
      const { rows } = await db.query(
        `SELECT * FROM dream_preferences
         WHERE valid_to IS NULL
         ORDER BY confidence DESC, created_at ASC`,
      );
      return rows as PreferenceRow[];
    },

    /**
     * Supersede an existing preference: stamp valid_to = now() and record
     * which row replaced it. The old row is kept for the audit trail.
     */
    async supersede(id: string, byId: string): Promise<void> {
      await db.query(
        `UPDATE dream_preferences
         SET valid_to = now(), superseded_by = $2
         WHERE id = $1`,
        [id, byId],
      );
    },

    /**
     * How many DISTINCT prior observations with the same normalised text the OWNER is on
     * record as having made. This is the only recurrence the promotion gate counts
     * (ADR-0018 rule 4, `@lares/agent-kit/learning`) — it replaced `seenSimilar`, which
     * answered "has anyone, anywhere, said this before" and so let anybody who could email the
     * agent manufacture recurrence.
     *
     * `origin = 'owner'` also excludes every row written BEFORE the origin column existed:
     * `ensureDreamTables`'s backfill stamps those `'agent'` (see its ALTER above), and they
     * were derived from conversation logs of unknown provenance. Unknown is not trusted, so no
     * date cutoff is needed — the backfill default is exactly the marker.
     *
     * Similarity rule: normalise via `normalizeObservationText` (shared export) and compare
     * against the stored `text_norm` column — an exact, locale-independent match on the
     * JS-produced normalised form. Rows inserted before `text_norm` existed have NULL there
     * and will NOT match; worst case they are re-recorded once on the next dream cycle.
     *
     * This matches near-duplicates that differ only in punctuation, emoji, case, or Norwegian
     * diacritics (ø/æ/å) — "Han bruker norsk å/æ/ø ofte." vs "han bruker norsk å æ ø ofte".
     */
    async ownerRecurrenceCount(text: string): Promise<number> {
      const { rows } = await db.query(
        `SELECT count(DISTINCT id)::int AS n FROM dream_observations
         WHERE text_norm = $1 AND origin = 'owner'`,
        [normalizeObservationText(text)],
      );
      return Number(rows[0]?.n ?? 0);
    },
  };
}

// ─── Usage clock (W4C-s11, ADR-0018 rule 8) ───────────────────────────────────

/** Which store a used row belongs to — one table, two sources, because retirement will have to
 *  treat them alike and a second table would guarantee they drift. */
export type MemoryKind = "standing_fact" | "preference";

/** A failure is logged at most once per process — a usage clock must not be able to train the
 *  operator to ignore its own warnings, and it must never repeat once per turn forever. */
let warnedAboutMemoryUse = false;
function warnAboutMemoryUse(err: unknown): void {
  if (warnedAboutMemoryUse) return;
  warnedAboutMemoryUse = true;
  console.warn(
    "memory-use: could not record a usage (this and any further failures this process are " +
      "swallowed) — apply services/box/sql/073_memory_use.sql if it is not there yet. " +
      "The turn that triggered this is unaffected.",
    err,
  );
}

/**
 * Records that these rows were put in front of a model — one upserted row per (kind, ref,
 * owner), keeping the first and last use and a count.
 *
 * BEST-EFFORT BY CONSTRUCTION. NEVER throws, never blocks, and a failure is logged at most once
 * per process: a usage clock must not be able to cost a turn. Starts the clock ADR-0018 rule 8's
 * retirement will read; this slice does not read it back (see `tests/memory-use.test.ts`'s last
 * case).
 */
export async function recordUse(
  db: Pool,
  use: { kind: MemoryKind; refs: readonly string[]; owner: string },
): Promise<void> {
  if (use.refs.length === 0) return;
  try {
    await db.query(
      `INSERT INTO memory_use (kind, ref, owner)
       SELECT $1, unnest($2::text[]), $3
       ON CONFLICT (kind, ref, owner)
       DO UPDATE SET last_used = now(), uses = memory_use.uses + 1`,
      [use.kind, use.refs, use.owner],
    );
  } catch (err) {
    warnAboutMemoryUse(err);
  }
}
