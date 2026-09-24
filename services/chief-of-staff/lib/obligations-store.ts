/**
 * The obligation radar's read state — ported from
 * `services/agent-runtime/lib/adapters/obligations/store.ts` (`makeObligationStore`), reshaped
 * to standalone functions taking `db: Pool` directly, matching every sibling store in this
 * package (`lib/reminders-store.ts`, `lib/proposals-store.ts`) rather than the old file's
 * factory shape.
 *
 * Table and column names match `services/box/sql/019_obligations.sql` EXACTLY — that
 * migration already ran on the box's shared `lares_state` Postgres (the same database
 * `lib/reminders-store.ts` and `lib/proposals-store.ts` already read/write), so this needs no
 * new migration, matching the precedent those two stores set.
 *
 * WHAT IS DELIBERATELY ABSENT: message bodies, snippets, subject text. This table stores
 * POINTERS ONLY — a thread id, timestamps, who spoke last, a dismissal flag. If a column you
 * are about to add would hold something a person wrote, stop — read the migration's own
 * header banner (sql/019_obligations.sql:3-10) first.
 */
import type { Pool } from "pg";

import type { Obligation } from "./brief-content.js";
import type { Intent } from "./obligation-intent.js";

/**
 * Idempotent — safe to call at boot. The agent box has no auto-migrate
 * (`project_agent_box_no_auto_migrate`), so `019_obligations.sql` is applied by hand; this is
 * the net under a forgotten manual step, not a replacement for the file. Mirrors the file
 * exactly, index included — a net that only rebuilds the table and not the index it is
 * queried through is not actually a net.
 */
export async function ensureObligationsTable(db: Pool): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS obligation_threads (
      thread_id               TEXT PRIMARY KEY,
      principal               TEXT NOT NULL,
      source                  TEXT NOT NULL DEFAULT 'gmail',
      counterparty_address    TEXT NOT NULL,
      last_message_at         TIMESTAMPTZ NOT NULL,
      last_speaker_is_them    BOOLEAN NOT NULL,
      their_unanswered_count  INTEGER NOT NULL DEFAULT 0,
      first_seen_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      dismissed_at            TIMESTAMPTZ,
      reping_announced_at     TIMESTAMPTZ,
      reping_announced_count  INTEGER,
      night_before_delivered_day TEXT
    )`);
  await db.query(`
    CREATE INDEX IF NOT EXISTS obligation_threads_open_idx
      ON obligation_threads (last_message_at DESC)
      WHERE dismissed_at IS NULL`);
  // ORB-45 Task 10 (box sql 030) — resolution + intent, both pointers only. Mirrors
  // sql/030_obligation_resolution.sql exactly; see that file's header for what these hold.
  await db.query(`ALTER TABLE obligation_threads ADD COLUMN IF NOT EXISTS resolved_elsewhere_at TIMESTAMPTZ`);
  await db.query(`ALTER TABLE obligation_threads ADD COLUMN IF NOT EXISTS resolution_via        TEXT`);
  await db.query(`ALTER TABLE obligation_threads ADD COLUMN IF NOT EXISTS resolution_evidence   TEXT`);
  await db.query(
    `ALTER TABLE obligation_threads ADD COLUMN IF NOT EXISTS intent TEXT CHECK (intent IN ('expects_reply','closes_loop','fyi','unreadable'))`,
  );
  await db.query(`ALTER TABLE obligation_threads ADD COLUMN IF NOT EXISTS intent_for_message_at TIMESTAMPTZ`);
}

/** Module-scope memo so the four schedules sharing a warm process (evening/morning brief,
 *  re-ping, and any future consumer) pay the `ensureObligationsTable` round trip at most once
 *  per process rather than on every tick. */
let ensured: Promise<void> | undefined;
export function ensureObligationsTableOnce(db: Pool): Promise<void> {
  if (!ensured) ensured = ensureObligationsTable(db);
  return ensured;
}

/**
 * Note what is NOT written here: no subject, no body. This is the only function that touches
 * an `Obligation`, and it reads only structural fields off it.
 *
 * `principal` is the canonical user id this obligation belongs to (One Brain W5's schema
 * guard) — pass the canonical id, never a raw channel address.
 *
 * The SET clause updates `counterparty_address` (and `source`) on every conflict, not just
 * insert: `markRePingAnnounced`/`markNightBeforeDelivered` can create a row first with a ''
 * placeholder address (they don't know the address, only that a thread id was touched);
 * `upsertSeen` always carries the real one. Without this, that placeholder would never heal,
 * and a later surface that matches `counterparty_address` against a person would silently
 * never match it.
 */
export async function upsertSeen(db: Pool, o: Obligation, now: Date, principal: string): Promise<void> {
  await db.query(
    `INSERT INTO obligation_threads
       (thread_id, principal, source, counterparty_address, last_message_at, last_speaker_is_them, their_unanswered_count, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, true, $6, $7)
     ON CONFLICT (thread_id) DO UPDATE SET
       source = EXCLUDED.source,
       counterparty_address = EXCLUDED.counterparty_address,
       last_message_at = EXCLUDED.last_message_at,
       last_speaker_is_them = EXCLUDED.last_speaker_is_them,
       their_unanswered_count = EXCLUDED.their_unanswered_count,
       last_seen_at = EXCLUDED.last_seen_at`,
    [o.threadId, principal, o.source, o.counterpartyAddress, o.lastMessageAt, o.unansweredCount, now],
  );
}

export async function dismissedThreads(db: Pool): Promise<Set<string>> {
  const { rows } = await db.query(`SELECT thread_id FROM obligation_threads WHERE dismissed_at IS NOT NULL`);
  return new Set(rows.map((r: { thread_id: string }) => r.thread_id));
}

/**
 * He said "handled". Never resurface it — see the migration header.
 *
 * Reports what it actually did. `WHERE thread_id = $1` on an id that is not in the table — a
 * mistyped one, or one reconstructed from a brief the model can no longer see — updates ZERO
 * rows and raises nothing, so a naive caller would answer "Dismissed" for an item that is
 * still on the radar. `RETURNING` is what makes the difference visible: an empty result means
 * nothing was closed, and the caller must say so.
 */
export async function dismissObligation(
  db: Pool, threadId: string, now: Date,
): Promise<{ dismissed: boolean; counterpartyAddress: string }> {
  const { rows } = await db.query(
    `UPDATE obligation_threads SET dismissed_at = $2 WHERE thread_id = $1 RETURNING counterparty_address`,
    [threadId, now],
  );
  const row = rows[0] as { counterparty_address?: string } | undefined;
  return { dismissed: rows.length > 0, counterpartyAddress: row?.counterparty_address ?? "" };
}

/**
 * thread id → the unanswered count that was true when this thread last nudged him.
 *
 * A SET of "threads that ever nudged" would mean one thread could only ever interrupt him
 * once, no matter how many times they bumped it — while the escalating thread is precisely
 * the motivating case. Carrying the count turns the dedupe into "this BUMP already interrupted
 * him", not "this thread, ever". Rows announced before this column existed read as 0, so their
 * next real bump (count ≥ 2) is allowed through once — the safe direction: one extra nudge,
 * never a missed one.
 */
export async function announcedRePings(db: Pool): Promise<Map<string, number>> {
  const { rows } = await db.query(
    `SELECT thread_id, reping_announced_count FROM obligation_threads WHERE reping_announced_at IS NOT NULL`,
  );
  return new Map(
    rows.map((r: { thread_id: string; reping_announced_count: number | null }) =>
      [r.thread_id, r.reping_announced_count ?? 0] as const),
  );
}

/**
 * Dedupe lives here, in the database, on purpose: an in-memory set re-announces every bumped
 * thread on each deploy, which is the fastest way to teach him to ignore the messages. Upserts
 * (rather than requiring a prior `upsertSeen` row) so a re-ping can be recorded even if called
 * out of order.
 */
export async function markRePingAnnounced(
  db: Pool, threadId: string, opts: { now: Date; principal: string; unansweredCount: number },
): Promise<void> {
  await db.query(
    `INSERT INTO obligation_threads (thread_id, principal, counterparty_address, last_message_at, last_speaker_is_them, reping_announced_at, reping_announced_count)
     VALUES ($1, $2, '', $3, true, $3, $4)
     ON CONFLICT (thread_id) DO UPDATE SET reping_announced_at = $3, reping_announced_count = $4`,
    [threadId, opts.principal, opts.now, opts.unansweredCount],
  );
}

/**
 * Last night's 20:00 pass actually TOLD him about this thread, in a message that actually
 * arrived, as part of preparing him for `opts.day` (tomorrow on the owner's clock, as of that
 * pass — LAR-67; it was the home clock's tomorrow).
 *
 * This is what the morning brief's suppression is spent against — only a real delivery may
 * buy silence, so only a real delivery writes this row. Upserts, and mirrors
 * `markRePingAnnounced` exactly (same '' placeholder address, healed by the next `upsertSeen`
 * via its SET clause). The SET overwrites rather than preserves: a thread owed to someone he
 * meets again next month must be markable again for THAT day, and an old day is inert either
 * way.
 */
export async function markNightBeforeDelivered(
  db: Pool, threadId: string, opts: { day: string; principal: string; now: Date },
): Promise<void> {
  await db.query(
    `INSERT INTO obligation_threads (thread_id, principal, counterparty_address, last_message_at, last_speaker_is_them, night_before_delivered_day)
     VALUES ($1, $2, '', $3, true, $4)
     ON CONFLICT (thread_id) DO UPDATE SET night_before_delivered_day = $4`,
    [threadId, opts.principal, opts.now, opts.day],
  );
}

/**
 * Thread ids whose night-before message covered `day` ("YYYY-MM-DD", on the owner's clock — the
 * same clock the evening pass stamped it on, LAR-67) — i.e. the ones the morning brief for that
 * day may leave out, and only those.
 *
 * Scoped BY DAY rather than "has ever been announced": a mark is a statement about one
 * morning. Yesterday's mark suppressing today's brief would be the same silent-omission bug in
 * slower motion.
 *
 * THROWS on a read failure. Callers must degrade this to "unavailable", which suppresses
 * NOTHING — a duplicate is an annoyance, a silent omission is the bug this closes.
 */
export async function nightBeforeDelivered(db: Pool, day: string): Promise<Set<string>> {
  const { rows } = await db.query(
    `SELECT thread_id FROM obligation_threads WHERE night_before_delivered_day = $1`,
    [day],
  );
  return new Set(rows.map((r: { thread_id: string }) => r.thread_id));
}

// ─── ORB-45 Task 10 (B4): resolution + intent, both pointers only (box sql 030) ──────────────

/**
 * thread id → the `resolved_elsewhere_at` timestamp, for every thread found answered on another
 * channel. A Map rather than a Set (unlike `dismissedThreads`) because the caller (Task B5)
 * needs to compare the resolution's timestamp against a NEWER `last_message_at` — "they wrote
 * again since I resolved this" must not stay silently resolved — and a Set would throw that
 * timestamp away.
 */
export async function resolvedThreads(db: Pool): Promise<Map<string, Date>> {
  const { rows } = await db.query(
    `SELECT thread_id, resolved_elsewhere_at FROM obligation_threads WHERE resolved_elsewhere_at IS NOT NULL`,
  );
  return new Map(
    rows.map((r: { thread_id: string; resolved_elsewhere_at: Date }) => [r.thread_id, r.resolved_elsewhere_at] as const),
  );
}

/** `resolution_evidence` is a one-line sentence (Task B2's `Resolution.evidence`), never a
 *  body — this is a defensive ceiling, not the expected length. */
const RESOLUTION_EVIDENCE_MAX_CHARS = 200;

/**
 * Records that Bendik already handled this thread on another channel — see Task B2's
 * `Resolution`. UPDATE only, never upsert: the row is created by `upsertSeen` first (it alone
 * knows `principal`/`counterparty_address`/`last_message_at`), so a thread id this store has
 * never seen has nothing to mark and this is a silent no-op, matching `recordIntent` below.
 */
export async function markResolved(db: Pool, threadId: string, r: { via: string; evidence: string; at: Date }): Promise<void> {
  const evidence = r.evidence.slice(0, RESOLUTION_EVIDENCE_MAX_CHARS);
  await db.query(
    `UPDATE obligation_threads SET resolved_elsewhere_at = $2, resolution_via = $3, resolution_evidence = $4 WHERE thread_id = $1`,
    [threadId, r.at, r.via, evidence],
  );
}

/**
 * The cached intent read (Task B3) for this thread's LAST message — but only when
 * `intent_for_message_at` still equals `lastMessageAt`. A thread that got a new message since
 * the cached read must not hand back a verdict about a message that is no longer the last one;
 * `null` tells the caller to read again.
 */
export async function cachedIntent(db: Pool, threadId: string, lastMessageAt: Date): Promise<Intent | null> {
  const { rows } = await db.query(
    `SELECT intent FROM obligation_threads WHERE thread_id = $1 AND intent_for_message_at = $2`,
    [threadId, lastMessageAt],
  );
  return rows.length > 0 ? (rows[0].intent as Intent) : null;
}

/**
 * Caches an intent read against the message timestamp it was read from. UPDATE only, for an
 * EXISTING row — the caller always calls `upsertSeen` first, so a thread id with no row here
 * has nothing to cache against and this is a silent no-op.
 */
export async function recordIntent(db: Pool, threadId: string, intent: Intent, lastMessageAt: Date): Promise<void> {
  await db.query(
    `UPDATE obligation_threads SET intent = $2, intent_for_message_at = $3 WHERE thread_id = $1`,
    [threadId, intent, lastMessageAt],
  );
}
