/**
 * Deadlines store — ORB-180. Backs `sql/036_deadlines.sql`'s four tables: the standing
 * calendar itself (`deadlines`), the mail-scanner's sightings (`deadline_candidates`), and
 * the one per-owner switch the ladder schedule reads (`deadline_settings`). Shaped like every
 * sibling store in this package (`lib/reminders-store.ts`, `lib/obligations-store.ts`): plain
 * functions taking `db: Pool` first, `owner` defaulting to `ownerId()` (`lib/principals.ts` —
 * ONE owner key for this feature's reads and writes alike, review fix ORB-180: the split where
 * writes used the identity registry's canonical id and reads used `ownerId()` was invisible until
 * the day `AGENT_OWNER_USER_ID` is set to anything else, at which point every deadline written
 * would be unreadable by the brief that asked for it), parameterised SQL, `owner` in the WHERE of
 * every UPDATE.
 *
 * `DeadlineSource`/`DeadlineRecurrence`/`nextDue` come from `@lares/agent-kit/deadlines`
 * (ORB-180 Task 1) — this file never redefines them.
 *
 * DATE HANDLING: `due_date` is a Postgres `date`. Every query that returns it uses
 * `to_char(due_date, 'YYYY-MM-DD')` rather than letting node-postgres parse the column, so a
 * `2026-08-31` row reads back as the string `"2026-08-31"` regardless of the process's local
 * timezone — pg's default DATE parser builds a JS `Date` at local midnight, which is exactly
 * the kind of implicit-timezone step ORB-124/128/204 already got bitten by once (see
 * `packages/agent-kit/src/deadlines.ts`'s header). `nextDue` and the store both work in this
 * same `YYYY-MM-DD` string currency, never a `Date`, for due dates.
 */
import type { Pool } from "pg";

import type { DeadlineRecurrence, DeadlineSource } from "@lares/agent-kit/deadlines";
import { nextDue } from "@lares/agent-kit/deadlines";
import { ownerDay } from "@lares/agent-kit/proactivity";

import { ownerId } from "./principals.js";

export interface DeadlineRow {
  id: string;
  owner: string;
  entity: string;
  title: string;
  source: DeadlineSource;
  dueDate: string;
  recurrence: DeadlineRecurrence;
  consequence: string | null;
  evidenceRule: string;
  status: "open" | "done" | "dismissed";
  statusReason: string | null;
  resolvedAt: Date | null;
  rung: number;
  rungMovedAt: Date | null;
  ruleKey: string | null;
  createdBy: string;
  createdAt: Date;
  vendor: string | null;
  amount: number | null;
  currency: string | null;
}

export interface NewDeadline {
  owner?: string;
  entity: string;
  title: string;
  source: DeadlineSource;
  dueDate: string;
  recurrence?: DeadlineRecurrence;
  consequence?: string | null;
  evidenceRule?: string;
  ruleKey?: string | null;
  createdBy: string;
  vendor?: string | null;
  amount?: number | null;
  currency?: string | null;
}

// Shared column list so every query that touches `deadlines` reads `due_date` the same way.
// Safe in both a SELECT and a RETURNING clause — Postgres accepts arbitrary expressions in
// either.
const DEADLINE_COLUMNS = `
  id, owner, entity, title, source,
  to_char(due_date, 'YYYY-MM-DD') AS due_date,
  recurrence, consequence, evidence_rule, status, status_reason,
  resolved_at, rung, rung_moved_at, rule_key, created_by, created_at,
  vendor, amount, currency
`;

interface DeadlineDbRow {
  id: string;
  owner: string;
  entity: string;
  title: string;
  source: DeadlineSource;
  due_date: string;
  recurrence: DeadlineRecurrence;
  consequence: string | null;
  evidence_rule: string;
  status: "open" | "done" | "dismissed";
  status_reason: string | null;
  resolved_at: Date | null;
  rung: number;
  rung_moved_at: Date | null;
  rule_key: string | null;
  created_by: string;
  created_at: Date;
  vendor: string | null;
  // `numeric(12,2)` comes back from node-postgres as a string (it does not parse numerics, to
  // avoid float precision loss) — never a number until `mapRow` converts it.
  amount: string | null;
  currency: string | null;
}

function mapRow(row: DeadlineDbRow): DeadlineRow {
  return {
    id: row.id,
    owner: row.owner,
    entity: row.entity,
    title: row.title,
    source: row.source,
    dueDate: row.due_date,
    recurrence: row.recurrence,
    consequence: row.consequence,
    evidenceRule: row.evidence_rule,
    status: row.status,
    statusReason: row.status_reason,
    resolvedAt: row.resolved_at,
    rung: row.rung,
    rungMovedAt: row.rung_moved_at,
    ruleKey: row.rule_key,
    createdBy: row.created_by,
    createdAt: row.created_at,
    vendor: row.vendor,
    amount: row.amount === null ? null : Number(row.amount),
    currency: row.currency,
  };
}

export async function createDeadline(db: Pool, d: NewDeadline): Promise<DeadlineRow> {
  const owner = d.owner ?? ownerId();
  const { rows } = await db.query<DeadlineDbRow>(
    `INSERT INTO deadlines (owner, entity, title, source, due_date, recurrence, consequence, evidence_rule, rule_key, created_by, vendor, amount, currency)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING ${DEADLINE_COLUMNS}`,
    [
      owner,
      d.entity,
      d.title,
      d.source,
      d.dueDate,
      d.recurrence ?? "none",
      d.consequence ?? null,
      d.evidenceRule ?? "owner confirms",
      d.ruleKey ?? null,
      d.createdBy,
      d.vendor ?? null,
      d.amount ?? null,
      d.currency ?? null,
    ],
  );
  return mapRow(rows[0]!);
}

/** Open rows by default, closest due first. `dueWithinDays` keeps rows due on or before the
 *  owner's day (computed from `now`/`tz`, never SQL `now()`) plus N days — which, since the
 *  cutoff is never before today, includes every overdue row for free. */
export async function listDeadlines(
  db: Pool,
  owner: string,
  opts: { status?: "open" | "done" | "dismissed" | "all"; dueWithinDays?: number; now?: Date; tz?: string } = {},
): Promise<DeadlineRow[]> {
  const status = opts.status ?? "open";
  const conditions = ["owner = $1"];
  const params: unknown[] = [owner];

  if (status !== "all") {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  if (opts.dueWithinDays !== undefined) {
    const now = opts.now ?? new Date();
    const tz = opts.tz ?? "Europe/Oslo";
    params.push(ownerDay(now, tz), opts.dueWithinDays);
    conditions.push(`due_date <= $${params.length - 1}::date + $${params.length}::int`);
  }

  const { rows } = await db.query<DeadlineDbRow>(
    `SELECT ${DEADLINE_COLUMNS} FROM deadlines WHERE ${conditions.join(" AND ")} ORDER BY due_date ASC`,
    params,
  );
  return rows.map(mapRow);
}

export async function getDeadline(db: Pool, id: string, owner: string): Promise<DeadlineRow | null> {
  const { rows } = await db.query<DeadlineDbRow>(
    `SELECT ${DEADLINE_COLUMNS} FROM deadlines WHERE id = $1 AND owner = $2`,
    [id, owner],
  );
  return rows.length > 0 ? mapRow(rows[0]!) : null;
}

/**
 * done/dismissed close the row; `done` with a recurrence mints the next row (`nextDue`) as
 * `created_by: "recurrence"` and returns it, in the SAME transaction as the close. A second
 * close of an already-closed id returns `{ closed: false, minted: null }` — the `WHERE status
 * = 'open'` guard is what makes that safe to call twice.
 */
export async function closeDeadline(
  db: Pool,
  id: string,
  owner: string,
  status: "done" | "dismissed",
  reason: string,
  now: Date,
): Promise<{ closed: boolean; minted: DeadlineRow | null }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<DeadlineDbRow>(
      `UPDATE deadlines SET status = $3, status_reason = $4, resolved_at = $5, updated_at = now()
       WHERE id = $1 AND owner = $2 AND status = 'open'
       RETURNING ${DEADLINE_COLUMNS}`,
      [id, owner, status, reason, now],
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return { closed: false, minted: null };
    }

    const closed = mapRow(rows[0]!);
    let minted: DeadlineRow | null = null;
    if (status === "done" && closed.recurrence !== "none") {
      const due = nextDue(closed.dueDate, closed.recurrence);
      if (due !== null) {
        const { rows: mintedRows } = await client.query<DeadlineDbRow>(
          `INSERT INTO deadlines (owner, entity, title, source, due_date, recurrence, consequence, evidence_rule, rule_key, created_by, rung, vendor, amount, currency)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'recurrence',0,$10,$11,$12)
           RETURNING ${DEADLINE_COLUMNS}`,
          [owner, closed.entity, closed.title, closed.source, due, closed.recurrence, closed.consequence, closed.evidenceRule, closed.ruleKey, closed.vendor, closed.amount, closed.currency],
        );
        minted = mapRow(mintedRows[0]!);
      }
    }

    await client.query("COMMIT");
    return { closed: true, minted };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function resetRung(db: Pool, id: string, owner: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE deadlines SET rung = 0, rung_moved_at = NULL, updated_at = now() WHERE id = $1 AND owner = $2`,
    [id, owner],
  );
  return (rowCount ?? 0) > 0;
}

export async function advanceRung(db: Pool, id: string, owner: string, rung: number, now: Date): Promise<void> {
  await db.query(
    `UPDATE deadlines SET rung = $3, rung_moved_at = $4, updated_at = now() WHERE id = $1 AND owner = $2`,
    [id, owner, rung, now],
  );
}

/** `false` when no row exists. THROWS on a query error — the schedule that reads this treats
 *  a throw as "ladder OFF", per the brief; it must never see a query failure as a settled
 *  answer. */
export async function readLadderEnabled(db: Pool, owner: string): Promise<boolean> {
  const { rows } = await db.query<{ ladder_enabled: boolean }>(
    `SELECT ladder_enabled FROM deadline_settings WHERE owner = $1`,
    [owner],
  );
  return rows.length > 0 ? rows[0]!.ladder_enabled : false;
}

export async function writeLadderEnabled(db: Pool, owner: string, enabled: boolean, updatedBy: string): Promise<void> {
  await db.query(
    `INSERT INTO deadline_settings (owner, ladder_enabled, updated_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (owner) DO UPDATE SET ladder_enabled = $2, updated_by = $3, updated_at = now()`,
    [owner, enabled, updatedBy],
  );
}

export interface CandidateRow {
  threadId: string;
  owner: string;
  subject: string;
  sender: string;
  seenAt: Date;
  surfacedAt: Date | null;
  resolution: "added" | "ignored" | null;
}

interface CandidateDbRow {
  thread_id: string;
  owner: string;
  subject: string;
  sender: string;
  seen_at: Date;
  surfaced_at: Date | null;
  resolution: "added" | "ignored" | null;
}

function mapCandidateRow(row: CandidateDbRow): CandidateRow {
  return {
    threadId: row.thread_id,
    owner: row.owner,
    subject: row.subject,
    sender: row.sender,
    seenAt: row.seen_at,
    surfacedAt: row.surfaced_at,
    resolution: row.resolution,
  };
}

/** The first sighting stands — `ON CONFLICT (owner, thread_id) DO NOTHING`. */
export async function upsertCandidate(
  db: Pool,
  c: { threadId: string; owner: string; subject: string; sender: string; seenAt: Date },
): Promise<void> {
  await db.query(
    `INSERT INTO deadline_candidates (owner, thread_id, subject, sender, seen_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (owner, thread_id) DO NOTHING`,
    [c.owner, c.threadId, c.subject, c.sender, c.seenAt],
  );
}

export async function unsurfacedCandidates(db: Pool, owner: string): Promise<CandidateRow[]> {
  const { rows } = await db.query<CandidateDbRow>(
    `SELECT owner, thread_id, subject, sender, seen_at, surfaced_at, resolution
     FROM deadline_candidates
     WHERE owner = $1 AND surfaced_at IS NULL AND resolution IS NULL
     ORDER BY seen_at ASC`,
    [owner],
  );
  return rows.map(mapCandidateRow);
}

/** An empty id list is a no-op — no query. */
export async function markCandidatesSurfaced(db: Pool, owner: string, threadIds: readonly string[], at: Date): Promise<void> {
  if (threadIds.length === 0) return;
  await db.query(
    `UPDATE deadline_candidates SET surfaced_at = $3 WHERE owner = $1 AND thread_id = ANY($2::text[])`,
    [owner, threadIds, at],
  );
}

export async function resolveCandidate(
  db: Pool,
  owner: string,
  threadId: string,
  resolution: "added" | "ignored",
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE deadline_candidates SET resolution = $3 WHERE owner = $1 AND thread_id = $2`,
    [owner, threadId, resolution],
  );
  return (rowCount ?? 0) > 0;
}
