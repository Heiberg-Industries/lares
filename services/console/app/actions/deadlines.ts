"use server";
/**
 * ORB-180 — the deadline knobs written from the console: the ladder switch, adding a one-off
 * deadline, minting a statutory year from the mirror, closing a row (done/dismissed), bringing a
 * rung back to zero, and resolving a mail-scanner candidate (either into a new deadline, or
 * ignored).
 *
 * Every action is `requireUser` first and refuses bad input as `{ ok: false, message }` rather
 * than throwing — an unauthenticated caller still throws, exactly as `app/actions/proactivity.ts`
 * does; that is not user error.
 *
 * `markDone`'s recurrence roll-forward is the one piece of logic the eve-saga store
 * (`closeDeadline`) also has — restated here, not imported, per ADR-0014 rule 12: the console does
 * not depend on `@lares/agent-kit` or any `services/chief-of-staff` module. `lib/deadlines.ts`'s
 * `nextDueDate` is the same formula as the store's `nextDue`.
 */
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { pool } from "../../lib/db";
import { verify } from "../../lib/auth";
import { homeTz, ownerDayIn, ownerId, resolveConsoleOwnerClock } from "../../lib/proactivity";
import { DEADLINE_RECURRENCES, DEADLINE_SOURCES, isValidIsoDate, mintYearFromMirror, nextDueDate } from "../../lib/deadlines";
import type { DeadlineRecurrence, DeadlineSource } from "../../lib/deadlines";

export type ActionResult = { ok: true } | { ok: false; message: string };
export type MintResult =
  | {
      ok: true;
      inserted: number;
      /** Rows already present for this entity, rule and date — minting the same year twice. */
      skipped: number;
      /** Rules whose date for this year is already behind the owner's day. Named, not just counted. */
      skippedPast: string[];
    }
  | { ok: false; message: string };

async function requireUser(): Promise<string> {
  const email = await verify((await cookies()).get("lares_session")?.value);
  if (!email) throw new Error("unauthenticated");
  return email;
}

/** The owner's calendar day, on the same clock `/deadlines` renders days-to-due with — never the
 *  server's `now()`, which is how ORB-124/128/204 got bitten before. */
function ownerToday(): string {
  const clock = resolveConsoleOwnerClock(new Date(), { homeTz: homeTz() });
  return ownerDayIn(new Date(), clock.tz);
}

function validateEntityTitleDate(entity: string, title: string, dueDate: string): ActionResult {
  if (!entity?.trim()) return { ok: false, message: "Entity cannot be empty." };
  if (!title?.trim()) return { ok: false, message: "Title cannot be empty." };
  if (!isValidIsoDate(dueDate)) return { ok: false, message: `${JSON.stringify(dueDate)} is not a date like 2026-09-08.` };
  if (dueDate < ownerToday()) return { ok: false, message: `${dueDate} is in the past.` };
  return { ok: true };
}

/**
 * LAR-22 — who is paid and how much, on any source (not only `"renewal"`; `deadline_add`, the
 * agent-side tool, makes the same allowance). All three are optional and independent of one
 * another: `amount` must be a positive number when given, `currency` must be three letters when
 * given, upper-cased BEFORE it reaches `deadlines_currency_check` (that constraint is case-
 * sensitive) so a lower-case value the owner typed is never silently refused by the database
 * instead of by this message.
 */
function validateVendorAmount(input: {
  vendor?: string;
  amount?: number;
  currency?: string;
}): { ok: true; vendor: string | null; amount: number | null; currency: string | null } | { ok: false; message: string } {
  if (input.amount !== undefined && !(typeof input.amount === "number" && input.amount > 0)) {
    return { ok: false, message: "Amount must be a positive number." };
  }
  let currency: string | null = null;
  if (input.currency !== undefined && input.currency.trim() !== "") {
    const upper = input.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/u.test(upper)) {
      return { ok: false, message: `Currency must be three letters, like NOK — got ${JSON.stringify(input.currency)}.` };
    }
    currency = upper;
  }
  return { ok: true, vendor: input.vendor?.trim() || null, amount: input.amount ?? null, currency };
}

// ── Ladder ─────────────────────────────────────────────────────────────────────────────────────

export async function saveLadderEnabled(input: { enabled: boolean }): Promise<ActionResult> {
  const email = await requireUser();
  if (typeof input.enabled !== "boolean") return { ok: false, message: "Ladder must be on or off." };
  const owner = ownerId();
  await pool.query(
    `INSERT INTO deadline_settings (owner, ladder_enabled, updated_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (owner) DO UPDATE SET ladder_enabled = EXCLUDED.ladder_enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [owner, input.enabled, email],
  );
  revalidatePath("/deadlines");
  return { ok: true };
}

// ── Add ────────────────────────────────────────────────────────────────────────────────────────

export async function addDeadline(input: {
  entity: string;
  title: string;
  dueDate: string;
  source: DeadlineSource;
  recurrence?: DeadlineRecurrence;
  consequence?: string;
  vendor?: string;
  amount?: number;
  currency?: string;
}): Promise<ActionResult> {
  const email = await requireUser();
  const check = validateEntityTitleDate(input.entity, input.title, input.dueDate);
  if (!check.ok) return check;
  if (!DEADLINE_SOURCES.includes(input.source)) return { ok: false, message: `Unknown source ${JSON.stringify(input.source)}.` };
  const recurrence = input.recurrence ?? "none";
  if (!DEADLINE_RECURRENCES.includes(recurrence)) return { ok: false, message: `Unknown recurrence ${JSON.stringify(recurrence)}.` };
  const vac = validateVendorAmount(input);
  if (!vac.ok) return vac;
  const owner = ownerId();
  await pool.query(
    `INSERT INTO deadlines (owner, entity, title, source, due_date, recurrence, consequence, evidence_rule, created_by, vendor, amount, currency)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'owner confirms',$8,$9,$10,$11)`,
    [owner, input.entity.trim(), input.title.trim(), input.source, input.dueDate, recurrence, input.consequence?.trim() || null, email, vac.vendor, vac.amount, vac.currency],
  );
  revalidatePath("/deadlines");
  return { ok: true };
}

// ── Mint a statutory year ─────────────────────────────────────────────────────────────────────

/**
 * Mints the fiscal year's rows from `STATUTORY_RULES_MIRROR`, skipping any row already present
 * for `(owner, entity, rule_key, due_date)` — there is no unique constraint on that combination
 * (sql/036 declares none), so this checks by hand rather than relying on `ON CONFLICT`.
 *
 * ALREADY-PAST DATES ARE SKIPPED (review fix, ORB-180), the same semantics as the kit's `mintYear`
 * and Saga's `deadline_mint_statutory`: a mid-year mint would otherwise insert every term from
 * January onwards, each overdue on arrival, and the brief names an overdue row every morning.
 * They come back in `skippedPast` by title so the form can say which — add one by hand if it is
 * genuinely still owed.
 */
export async function mintStatutoryYear(input: { entity: string; fiscalYear: number; omit?: string[] }): Promise<MintResult> {
  const email = await requireUser();
  if (!input.entity?.trim()) return { ok: false, message: "Entity cannot be empty." };
  if (!Number.isInteger(input.fiscalYear)) return { ok: false, message: "Fiscal year must be a whole number." };

  let rows;
  let skippedPast: string[];
  try {
    const result = mintYearFromMirror(input.fiscalYear, input.omit ?? [], { today: ownerToday() });
    rows = result.minted;
    skippedPast = result.skippedPast.map((r) => r.title);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }

  const owner = ownerId();
  const entity = input.entity.trim();
  let inserted = 0;
  let skipped = 0;
  for (const r of rows) {
    const existing = await pool.query(
      `SELECT 1 FROM deadlines WHERE owner = $1 AND entity = $2 AND rule_key = $3 AND due_date = $4`,
      [owner, entity, r.ruleKey, r.dueDate],
    );
    if (existing.rows.length > 0) {
      skipped += 1;
      continue;
    }
    await pool.query(
      `INSERT INTO deadlines (owner, entity, title, source, due_date, recurrence, consequence, evidence_rule, rule_key, created_by)
       VALUES ($1,$2,$3,'statutory',$4,$5,$6,'owner confirms',$7,$8)`,
      [owner, entity, r.title, r.dueDate, r.recurrence, r.consequence, r.ruleKey, email],
    );
    inserted += 1;
  }
  revalidatePath("/deadlines");
  return { ok: true, inserted, skipped, skippedPast };
}

// ── Close / reset ──────────────────────────────────────────────────────────────────────────────

interface ClosedRow {
  entity: string; title: string; source: DeadlineSource;
  due_date: string; recurrence: DeadlineRecurrence; consequence: string | null;
  evidence_rule: string; rule_key: string | null;
  // Carried straight into the successor's INSERT params below, never displayed here — so this
  // stays the raw pg shape (a numeric comes back as a string) rather than the DTO's `number`.
  vendor: string | null; amount: string | null; currency: string | null;
}

/**
 * Closes an open row as `done` and, when it recurs, mints the successor (`nextDueDate`): +1 year /
 * +2 months / +1 month, day clamped, `created_by: 'recurrence'`, `rung: 0` — the same rule as
 * Saga's store. A second call on an already-closed id is refused: the `status = 'open'` guard in
 * the UPDATE means nothing is touched twice.
 *
 * The close and the mint run in ONE transaction (`pool.connect()` + `BEGIN`/`COMMIT`/`ROLLBACK`),
 * the same shape as `services/chief-of-staff/lib/deadlines-store.ts`'s `closeDeadline`. Without it, a
 * successor INSERT that fails (a dropped connection, a constraint) would leave the row already
 * committed as `done` with no successor ever minted — a recurring statutory deadline silently
 * disappearing from the calendar, which is worse than the write never having happened at all.
 */
export async function markDone(input: { id: string; evidence: string }): Promise<ActionResult> {
  await requireUser();
  if (!input.evidence?.trim()) return { ok: false, message: "Evidence cannot be empty." };
  const owner = ownerId();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<ClosedRow>(
      `UPDATE deadlines SET status = 'done', status_reason = $3, resolved_at = now(), updated_at = now()
       WHERE id = $1 AND owner = $2 AND status = 'open'
       RETURNING entity, title, source, to_char(due_date, 'YYYY-MM-DD') AS due_date, recurrence, consequence, evidence_rule, rule_key, vendor, amount, currency`,
      [input.id, owner, input.evidence.trim()],
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return { ok: false, message: "That deadline is not open." };
    }

    const closed = rows[0]!;
    if (closed.recurrence !== "none") {
      const due = nextDueDate(closed.due_date, closed.recurrence);
      if (due !== null) {
        await client.query(
          `INSERT INTO deadlines (owner, entity, title, source, due_date, recurrence, consequence, evidence_rule, rule_key, created_by, rung, vendor, amount, currency)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'recurrence',0,$10,$11,$12)`,
          [owner, closed.entity, closed.title, closed.source, due, closed.recurrence, closed.consequence, closed.evidence_rule, closed.rule_key, closed.vendor, closed.amount, closed.currency],
        );
      }
    }
    await client.query("COMMIT");
    revalidatePath("/deadlines");
    return { ok: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function dismiss(input: { id: string; reason: string }): Promise<ActionResult> {
  await requireUser();
  if (!input.reason?.trim()) return { ok: false, message: "Reason cannot be empty." };
  const owner = ownerId();
  const { rowCount } = await pool.query(
    `UPDATE deadlines SET status = 'dismissed', status_reason = $3, resolved_at = now(), updated_at = now()
     WHERE id = $1 AND owner = $2 AND status = 'open'`,
    [input.id, owner, input.reason.trim()],
  );
  if ((rowCount ?? 0) === 0) return { ok: false, message: "That deadline is not open." };
  revalidatePath("/deadlines");
  return { ok: true };
}

/** Bring a row back to rung 0 without touching its status — for a deadline that rang past its
 *  first nudge but is not actually done or dismissed. */
export async function resetRung(input: { id: string }): Promise<ActionResult> {
  await requireUser();
  const owner = ownerId();
  const { rowCount } = await pool.query(
    `UPDATE deadlines SET rung = 0, rung_moved_at = NULL, updated_at = now() WHERE id = $1 AND owner = $2`,
    [input.id, owner],
  );
  if ((rowCount ?? 0) === 0) return { ok: false, message: "Deadline not found." };
  revalidatePath("/deadlines");
  return { ok: true };
}

// ── Candidates ─────────────────────────────────────────────────────────────────────────────────

/**
 * Ignore a candidate — the ONLY resolution this bare action can write. `resolution` is narrowed to
 * the literal `"ignored"` (not a union with `"added"`) and re-checked at runtime: a server action
 * is a network-reachable POST, not a UI choice, so the fact that the component only ever sends
 * `"ignored"` is not a guarantee about what a caller sends. Writing `resolution: "added"` here
 * would mark a candidate resolved with no deadline behind it — the "added" path can ONLY go
 * through {@link addFromCandidate}, which creates the deadline in the same action.
 */
export async function ignoreCandidate(input: { threadId: string; resolution: "ignored" }): Promise<ActionResult> {
  await requireUser();
  if (input.resolution !== "ignored") {
    return { ok: false, message: "This action can only ignore a candidate — use addFromCandidate to add one." };
  }
  const owner = ownerId();
  const { rowCount } = await pool.query(
    `UPDATE deadline_candidates SET resolution = 'ignored' WHERE owner = $1 AND thread_id = $2`,
    [owner, input.threadId],
  );
  if ((rowCount ?? 0) === 0) return { ok: false, message: "Candidate not found." };
  revalidatePath("/deadlines");
  return { ok: true };
}

/** The "Add" button on a candidate row: creates the deadline AND marks the candidate resolved as
 *  `added`, in one action — a candidate added but left unresolved would keep nagging as unsurfaced
 *  mail, and a candidate resolved without a deadline would silently drop what it was surfaced for. */
export async function addFromCandidate(input: {
  threadId: string;
  entity: string;
  title: string;
  dueDate: string;
  source?: DeadlineSource;
  recurrence?: DeadlineRecurrence;
  consequence?: string;
  vendor?: string;
  amount?: number;
  currency?: string;
}): Promise<ActionResult> {
  const email = await requireUser();
  const check = validateEntityTitleDate(input.entity, input.title, input.dueDate);
  if (!check.ok) return check;
  const source = input.source ?? "manual";
  if (!DEADLINE_SOURCES.includes(source)) return { ok: false, message: `Unknown source ${JSON.stringify(source)}.` };
  const recurrence = input.recurrence ?? "none";
  if (!DEADLINE_RECURRENCES.includes(recurrence)) return { ok: false, message: `Unknown recurrence ${JSON.stringify(recurrence)}.` };
  const vac = validateVendorAmount(input);
  if (!vac.ok) return vac;

  const owner = ownerId();
  await pool.query(
    `INSERT INTO deadlines (owner, entity, title, source, due_date, recurrence, consequence, evidence_rule, created_by, vendor, amount, currency)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'owner confirms',$8,$9,$10,$11)`,
    [owner, input.entity.trim(), input.title.trim(), source, input.dueDate, recurrence, input.consequence?.trim() || null, email, vac.vendor, vac.amount, vac.currency],
  );
  await pool.query(
    `UPDATE deadline_candidates SET resolution = 'added' WHERE owner = $1 AND thread_id = $2`,
    [owner, input.threadId],
  );
  revalidatePath("/deadlines");
  return { ok: true };
}
