/**
 * src/repairs.ts — the Repairs record: what broke, how bad, from when it stops working, how to
 * fix it (ADR-0019 decision 9). Backs `services/box/sql/079_repairs.sql`.
 *
 * ONE ROW PER (kind, ref), NOT A LOG. `openRepair` is an upsert: the first failure opens the
 * row, a repeat touches `last_seen_at` (and clears `resolved_at`, re-opening a row that had
 * healed and broke again), and `resolveRepair` closes it. See 079_repairs.sql for the full
 * rationale, including why `ref` is a free-text column rather than a foreign key.
 *
 * `what` AND `howToFix` ARE OWNER TEXT ONLY. Never a stack trace, a vendor's error body, a
 * token, or a path inside a container — the caller composes the sentence; this module does not
 * inspect or transform it.
 *
 * BEST-EFFORT BY CONSTRUCTION, modelled line for line on `recordUse`
 * (`services/chief-of-staff/lib/dream/store.ts`) and `recordRead`
 * (`services/chief-of-staff/lib/memory-reads.ts`, W5A-s1). NEVER throws, never blocks, and a
 * failure is logged at most once per process: noticing (or missing) a repair must not be able to
 * cost the turn that noticed it.
 */
import type { Queryable } from "@lares/vault-format/forget-ledger";

/** How bad it is. Matches signal-format.ts's ViewState where the two overlap, so a repair can be
 *  rendered by formatSignal without a second vocabulary. */
export const REPAIR_SEVERITIES = ["info", "warn", "error"] as const;
export type RepairSeverity = (typeof REPAIR_SEVERITIES)[number];

export interface Repair {
  kind: string;
  ref: string;
  severity: RepairSeverity;
  /** One sentence an owner reads. Never a stack trace, never a secret, never a token. */
  what: string;
  /** What to do about it, in the owner's hands. Null when only the maintainer can act. */
  howToFix: string | null;
  /** The release from which this stops working, e.g. "0.4.0". Null when nothing breaks. */
  breaksIn: string | null;
  openedAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
}

export interface RepairInput {
  kind: string;
  ref: string;
  severity: RepairSeverity;
  what: string;
  howToFix?: string | null;
  breaksIn?: string | null;
}

/** How many open repairs a page reads at once. Repairs are rare by design — a broken thing is
 *  one row, not a log — so this is a generous ceiling, not a real-world limit. */
export const REPAIRS_PAGE_LIMIT = 100;

let warnedAboutRepairs = false;

function warnAboutRepairs(err: unknown): void {
  if (warnedAboutRepairs) return;
  warnedAboutRepairs = true;
  console.warn(
    "repairs: could not record a repair (this and any further failures this process are " +
      "swallowed) — apply services/box/sql/079_repairs.sql if it is not there yet. " +
      "The turn that triggered this is unaffected.",
    err,
  );
}

/** Resets the once-per-process warning flag. Test-only. */
export function resetRepairWarningForTests(): void {
  warnedAboutRepairs = false;
}

function toRepair(row: {
  kind: string;
  ref: string;
  severity: RepairSeverity;
  what: string;
  how_to_fix: string | null;
  breaks_in: string | null;
  opened_at: Date;
  last_seen_at: Date;
  resolved_at: Date | null;
}): Repair {
  return {
    kind: row.kind,
    ref: row.ref,
    severity: row.severity,
    what: row.what,
    howToFix: row.how_to_fix,
    breaksIn: row.breaks_in,
    openedAt: row.opened_at,
    lastSeenAt: row.last_seen_at,
    resolvedAt: row.resolved_at,
  };
}

/**
 * Opens a repair, or touches the one already open for (kind, ref) — an upsert, not an append.
 * A row that had recovered and breaks again is re-opened rather than left closed.
 *
 * BEST-EFFORT. Never throws; warns once per process when box 079 is missing and names the file
 * to apply.
 */
/** The schema's own limits (box 079, `repairs_short_text`). A writer that hands over a stack
 *  trace gets it cut here rather than refused by the database — a repair that fails to open
 *  because its sentence was too long would hide the very problem it reports. */
export const REPAIR_TEXT_LIMITS = { kind: 64, ref: 128, what: 400, howToFix: 400, breaksIn: 64 } as const;

const clamp = (v: string, max: number): string => (v.length <= max ? v : `${v.slice(0, max - 1)}…`);
const clampOrNull = (v: string | null | undefined, max: number): string | null =>
  v === null || v === undefined ? null : clamp(v, max);

export async function openRepair(db: Queryable, r: RepairInput): Promise<void> {
  try {
    await db.query(
      `INSERT INTO repairs (kind, ref, severity, what, how_to_fix, breaks_in)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (kind, ref) DO UPDATE SET
         last_seen_at = now(),
         resolved_at = NULL,
         severity = EXCLUDED.severity,
         what = EXCLUDED.what,
         how_to_fix = EXCLUDED.how_to_fix,
         breaks_in = EXCLUDED.breaks_in`,
      [
        clamp(r.kind, REPAIR_TEXT_LIMITS.kind),
        clamp(r.ref, REPAIR_TEXT_LIMITS.ref),
        r.severity,
        clamp(r.what, REPAIR_TEXT_LIMITS.what),
        clampOrNull(r.howToFix, REPAIR_TEXT_LIMITS.howToFix),
        clampOrNull(r.breaksIn, REPAIR_TEXT_LIMITS.breaksIn),
      ],
    );
  } catch (err) {
    warnAboutRepairs(err);
  }
}

/**
 * Closes the open repair for (kind, ref) if there is one. A close with no open repair is a
 * no-op, not an insert.
 *
 * BEST-EFFORT. Never throws; warns once per process when box 079 is missing.
 */
export async function resolveRepair(db: Queryable, kind: string, ref: string): Promise<void> {
  try {
    await db.query(
      `UPDATE repairs SET resolved_at = now() WHERE kind = $1 AND ref = $2 AND resolved_at IS NULL`,
      [kind, ref],
    );
  } catch (err) {
    warnAboutRepairs(err);
  }
}

/**
 * Every open repair, worst and freshest first. Answers `[]` (never throws) when box 079 is
 * missing, warning once per process.
 */
export async function openRepairs(db: Queryable): Promise<Repair[]> {
  try {
    const { rows } = await db.query(
      `SELECT kind, ref, severity, what, how_to_fix, breaks_in, opened_at, last_seen_at, resolved_at
       FROM repairs
       WHERE resolved_at IS NULL
       ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, last_seen_at DESC
       LIMIT $1`,
      [REPAIRS_PAGE_LIMIT],
    );
    return rows.map(toRepair);
  } catch (err) {
    warnAboutRepairs(err);
    return [];
  }
}
