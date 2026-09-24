/**
 * ORB-180 — the read layer and pure helpers behind `/deadlines`.
 *
 * THE ENGINE VALUES ARE MIRRORED, NOT IMPORTED — the same rule `lib/proactivity.ts` states for
 * ORB-193's `ENGINE`, and ADR-0014 rule 12 names it as a two-place truth for the console generally:
 * this file never imports `@lares/agent-kit`. `STATUTORY_RULES_MIRROR` is a copy of the kit's
 * `STATUTORY_RULES["NO-AS"]` (`packages/agent-kit/src/deadlines.ts`) minus its `evidenceRule` field
 * (every seed uses the same "owner confirms" value here, so the console names that once rather than
 * twelve times); `MENTION_DAYS_MIRROR` copies the kit's `MENTION_DAYS`. `tests/engine-drift.test.ts`
 * reads the kit's source as TEXT and fails on any disagreement — if the kit's rule set changes,
 * change this file too.
 *
 * `mintYearFromMirror` and `nextDueDate` recompute the kit's `mintYear`/`nextDue` arithmetic
 * independently (same formulas, no shared code) so the console can mint a year and roll a
 * recurrence forward without depending on the kit at runtime. `tests/engine-drift.test.ts` also
 * runs the kit's actual functions (a dev-time import, not a runtime one) against this file's, so a
 * drift in the arithmetic itself — not just the rule table — fails the suite (LAR-36).
 *
 * The per-rule due-date formula (`fiscalYear + yearOffset`, `month`, `day`) is factored out into
 * `lib/deadline-date.ts`'s `ruleDueDate` — the one copy both this file and the client-side mint
 * form (`DeadlineControls.tsx`) import, so there is no second place for it to drift from itself.
 */
import { pool } from "./db";
import { ownerDayIn, ownerId } from "./proactivity";
import { ruleDueDate } from "./deadline-date";

export type DeadlineSource = "statutory" | "accounting" | "contract" | "subscription" | "manual" | "renewal";
export type DeadlineRecurrence = "none" | "yearly" | "bimonthly" | "monthly";
export type DeadlineStatus = "open" | "done" | "dismissed";

export const DEADLINE_SOURCES: readonly DeadlineSource[] = ["statutory", "accounting", "contract", "subscription", "manual", "renewal"];
export const DEADLINE_RECURRENCES: readonly DeadlineRecurrence[] = ["none", "yearly", "bimonthly", "monthly"];

// ---------------------------------------------------------------------------------------------
// The statutory rule mirror (packages/agent-kit/src/deadlines.ts's STATUTORY_RULES["NO-AS"])
// ---------------------------------------------------------------------------------------------

export interface StatutoryRuleMirror {
  key: string;
  title: string;
  month: number;
  day: number;
  /** 1 = the deadline falls in the year AFTER the fiscal year it concerns. */
  yearOffset: 0 | 1;
  recurrence: DeadlineRecurrence;
  consequence: string;
}

export const STATUTORY_RULES_MIRROR: readonly StatutoryRuleMirror[] = [
  {
    key: "aksjonaerregister", title: "Aksjonærregisteroppgaven",
    month: 1, day: 31, yearOffset: 1, recurrence: "yearly",
    consequence: "Tvangsmulkt fra Skatteetaten løper per dag",
  },
  {
    key: "mva-t6", title: "MVA-melding, 6. termin",
    month: 2, day: 10, yearOffset: 1, recurrence: "yearly",
    consequence: "Tvangsmulkt per dag og forsinkelsesrenter",
  },
  {
    key: "forskuddsskatt-1", title: "Forskuddsskatt, 1. termin",
    month: 2, day: 15, yearOffset: 1, recurrence: "yearly",
    consequence: "Forsinkelsesrenter og tvangsinnfordring",
  },
  {
    key: "mva-t1", title: "MVA-melding, 1. termin",
    month: 4, day: 10, yearOffset: 0, recurrence: "yearly",
    consequence: "Tvangsmulkt per dag og forsinkelsesrenter",
  },
  {
    key: "forskuddsskatt-2", title: "Forskuddsskatt, 2. termin",
    month: 4, day: 15, yearOffset: 1, recurrence: "yearly",
    consequence: "Forsinkelsesrenter og tvangsinnfordring",
  },
  {
    key: "skattemelding", title: "Skattemelding for AS",
    month: 5, day: 31, yearOffset: 1, recurrence: "yearly",
    consequence: "Tvangsmulkt og mulig tilleggsskatt",
  },
  {
    key: "mva-t2", title: "MVA-melding, 2. termin",
    month: 6, day: 10, yearOffset: 0, recurrence: "yearly",
    consequence: "Tvangsmulkt per dag og forsinkelsesrenter",
  },
  {
    key: "generalforsamling", title: "Ordinær generalforsamling",
    month: 6, day: 30, yearOffset: 1, recurrence: "yearly",
    consequence: "Brudd på aksjeloven § 5-5; årsregnskapet kan ikke godkjennes",
  },
  {
    key: "aarsregnskap", title: "Årsregnskap til Regnskapsregisteret",
    month: 7, day: 31, yearOffset: 1, recurrence: "yearly",
    consequence: "Forsinkelsesgebyr; tvangsoppløsning ved vedvarende mangel",
  },
  {
    key: "mva-t3", title: "MVA-melding, 3. termin",
    month: 8, day: 31, yearOffset: 0, recurrence: "yearly",
    consequence: "Tvangsmulkt per dag og forsinkelsesrenter",
  },
  {
    key: "mva-t4", title: "MVA-melding, 4. termin",
    month: 10, day: 10, yearOffset: 0, recurrence: "yearly",
    consequence: "Tvangsmulkt per dag og forsinkelsesrenter",
  },
  {
    key: "mva-t5", title: "MVA-melding, 5. termin",
    month: 12, day: 10, yearOffset: 0, recurrence: "yearly",
    consequence: "Tvangsmulkt per dag og forsinkelsesrenter",
  },
];

/** Mirrors the kit's `MENTION_DAYS` — not used to gate anything here (the brief lives in the
 *  schedule, not the console), kept so the mint form's copy and any future surface can cite the
 *  same list the kit actually mentions on. */
export const MENTION_DAYS_MIRROR: readonly number[] = [30, 16, 8, 4, 2, 1, 0];

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** "31 January" — the standing date shown beside a rule's checkbox, independent of fiscal year. */
export function standingDateLabel(month: number, day: number): string {
  return `${day} ${MONTH_NAMES[month - 1] ?? "?"}`;
}

// ---------------------------------------------------------------------------------------------
// Pure date arithmetic — mirrors the kit's mintYear / nextDue / daysToDue formulas
// ---------------------------------------------------------------------------------------------

const pad = (n: number): string => String(n).padStart(2, "0");
const isoDate = (year: number, month: number, day: number): string => `${year}-${pad(month)}-${pad(day)}`;

export interface MintedDeadlineRow {
  ruleKey: string;
  title: string;
  /** `YYYY-MM-DD` */
  dueDate: string;
  recurrence: DeadlineRecurrence;
  consequence: string;
}

export interface MintYearMirrorResult {
  /** The rows to insert, `dueDate` ascending. */
  minted: MintedDeadlineRow[];
  /** Rules whose date for this fiscal year is already behind `today` — never inserted, but named
   *  so the action can report them and the form can grey them. Empty when `includePast` is true. */
  skippedPast: MintedDeadlineRow[];
}

/**
 * The year's deadlines from the mirror, sorted by due date ascending — same computation as the
 * kit's `mintYear`: `yearOffset` adds one year, dates render `YYYY-MM-DD`. `omit` drops rule keys
 * that do not apply; an unknown key THROWS, same reasoning as the kit — a silently-ignored typo
 * leaves a deadline standing (or missing) that the owner believed they had chosen otherwise.
 *
 * SAME already-past semantics as the kit (review fix, ORB-180): minting a year that has already
 * started inserts only the terms still ahead, because a row that is overdue on arrival is named in
 * the brief EVERY morning from then on. `today` is the owner's day (`ownerDayIn`), required rather
 * than defaulted for the same reason the kit requires it — the boundary is a calendar day on HIS
 * clock, not the server's.
 */
export function mintYearFromMirror(
  fiscalYear: number,
  omit: readonly string[] = [],
  opts: { today: string; includePast?: boolean } | { today?: string; includePast: true },
): MintYearMirrorResult {
  const omitSet = new Set(omit);
  const unknown = [...omitSet].filter((k) => !STATUTORY_RULES_MIRROR.some((r) => r.key === k));
  if (unknown.length > 0) {
    throw new Error(`mintYearFromMirror: unknown rule key(s) in omit: ${unknown.join(", ")}`);
  }
  const includePast = opts.includePast === true;
  const today = opts.today;
  if (!includePast && (today === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(today))) {
    throw new Error("mintYearFromMirror: `today` (YYYY-MM-DD, the owner's day) is required unless includePast is true");
  }

  const all = STATUTORY_RULES_MIRROR
    .filter((r) => !omitSet.has(r.key))
    .map((r) => ({
      ruleKey: r.key,
      title: r.title,
      dueDate: ruleDueDate(r, fiscalYear),
      recurrence: r.recurrence,
      consequence: r.consequence,
    }))
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));

  if (includePast) return { minted: all, skippedPast: [] };
  // A date ON the owner's day is today's deadline, not history — strictly-before is past.
  return {
    minted: all.filter((m) => !(m.dueDate < today!)),
    skippedPast: all.filter((m) => m.dueDate < today!),
  };
}

function utcMidnight(date: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  return Date.UTC(y ?? 1970, (mo ?? 1) - 1, d ?? 1);
}

/** Whole owner-clock days from `now`'s owner day to `dueDate`; negative when overdue. Mirrors the
 *  kit's `daysToDue`, computed independently on the owner's clock (`ownerDayIn`, the same
 *  `Intl.DateTimeFormat("sv-SE")` trick, never SQL `now()`). */
export function daysUntil(dueDate: string, now: Date, tz: string): number {
  return Math.round((utcMidnight(dueDate) - utcMidnight(ownerDayIn(now, tz))) / 86_400_000);
}

export type DueColor = "bad" | "warn" | null;

/** Overdue (negative days) is `bad`; due today or within 2 days is `warn`; anything further out
 *  gets no colour. The brief's rule, named once so the page and its tests share one definition. */
export function dueColor(days: number): DueColor {
  if (days < 0) return "bad";
  if (days <= 2) return "warn";
  return null;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The next due date after `dueDate` for a recurrence, or null for `"none"`. Mirrors the kit's
 * `nextDue`: yearly = +1 year, bimonthly = +2 months, monthly = +1 month, same day of month
 * CLAMPED to the target month's length (the 31st becomes the 28th in February, never rolling into
 * March) — the rule `markDone` uses to mint a recurring deadline's successor on close.
 */
export function nextDueDate(dueDate: string, recurrence: DeadlineRecurrence): string | null {
  const months = recurrence === "yearly" ? 12 : recurrence === "bimonthly" ? 2 : recurrence === "monthly" ? 1 : null;
  if (months === null) return null;
  const [y, mo, d] = dueDate.split("-").map(Number);
  const total = (y ?? 1970) * 12 + ((mo ?? 1) - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return isoDate(year, month, Math.min(d ?? 1, daysInMonth(year, month)));
}

/** Strict `YYYY-MM-DD`, and a real calendar date (rejects `2026-02-30`). */
export function isValidIsoDate(s: string): boolean {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export interface DeadlineRowDTO {
  id: string;
  entity: string;
  title: string;
  source: DeadlineSource;
  dueDate: string;
  recurrence: DeadlineRecurrence;
  consequence: string | null;
  evidenceRule: string;
  status: DeadlineStatus;
  statusReason: string | null;
  resolvedAt: Date | null;
  rung: number;
  ruleKey: string | null;
  createdBy: string;
  /** LAR-22 — who is paid and how much. Meant for `source: "renewal"`, not restricted to it. */
  vendor: string | null;
  amount: number | null;
  currency: string | null;
}

interface DeadlineDbRow {
  id: string;
  entity: string;
  title: string;
  source: DeadlineSource;
  due_date: string;
  recurrence: DeadlineRecurrence;
  consequence: string | null;
  evidence_rule: string;
  status: DeadlineStatus;
  status_reason: string | null;
  resolved_at: Date | null;
  rung: number;
  rule_key: string | null;
  created_by: string;
  vendor: string | null;
  // `numeric(12,2)` comes back from pg as a STRING (never parsed to a float by the driver) —
  // `mapDeadlineRow` converts it deliberately, the same reasoning as the eve-saga store's
  // `deadlines-store.ts`.
  amount: string | null;
  currency: string | null;
}

const DEADLINE_COLUMNS = `
  id, entity, title, source,
  to_char(due_date, 'YYYY-MM-DD') AS due_date,
  recurrence, consequence, evidence_rule, status, status_reason, resolved_at, rung, rule_key, created_by,
  vendor, amount, currency
`;

function mapDeadlineRow(r: DeadlineDbRow): DeadlineRowDTO {
  return {
    id: r.id,
    entity: r.entity,
    title: r.title,
    source: r.source,
    dueDate: r.due_date,
    recurrence: r.recurrence,
    consequence: r.consequence,
    evidenceRule: r.evidence_rule,
    status: r.status,
    statusReason: r.status_reason,
    resolvedAt: r.resolved_at === null ? null : new Date(r.resolved_at),
    rung: Number(r.rung),
    ruleKey: r.rule_key,
    createdBy: r.created_by,
    vendor: r.vendor,
    amount: r.amount === null ? null : Number(r.amount),
    currency: r.currency,
  };
}

export async function readLadderEnabled(owner: string): Promise<boolean> {
  const { rows } = await pool.query<{ ladder_enabled: boolean }>(
    `SELECT ladder_enabled FROM deadline_settings WHERE owner = $1`,
    [owner],
  );
  return rows.length > 0 ? rows[0]!.ladder_enabled : false;
}

export async function readOpenDeadlines(owner: string): Promise<DeadlineRowDTO[]> {
  const { rows } = await pool.query<DeadlineDbRow>(
    `SELECT ${DEADLINE_COLUMNS} FROM deadlines WHERE owner = $1 AND status = 'open' ORDER BY due_date ASC`,
    [owner],
  );
  return rows.map(mapDeadlineRow);
}

export async function readClosedDeadlines(owner: string, limit = 20): Promise<DeadlineRowDTO[]> {
  const { rows } = await pool.query<DeadlineDbRow>(
    `SELECT ${DEADLINE_COLUMNS} FROM deadlines WHERE owner = $1 AND status IN ('done', 'dismissed')
     ORDER BY resolved_at DESC NULLS LAST LIMIT $2`,
    [owner, limit],
  );
  return rows.map(mapDeadlineRow);
}

export interface CandidateRowDTO {
  threadId: string;
  subject: string;
  sender: string;
  seenAt: Date;
  surfacedAt: Date | null;
}

export async function readOpenCandidates(owner: string): Promise<CandidateRowDTO[]> {
  const { rows } = await pool.query<{ thread_id: string; subject: string; sender: string; seen_at: Date; surfaced_at: Date | null }>(
    `SELECT thread_id, subject, sender, seen_at, surfaced_at
     FROM deadline_candidates
     WHERE owner = $1 AND resolution IS NULL
     ORDER BY seen_at ASC`,
    [owner],
  );
  return rows.map((r) => ({
    threadId: r.thread_id,
    subject: r.subject,
    sender: r.sender,
    seenAt: new Date(r.seen_at),
    surfacedAt: r.surfaced_at === null ? null : new Date(r.surfaced_at),
  }));
}

export interface DeadlinesView {
  owner: string;
  ladderEnabled: boolean;
  open: DeadlineRowDTO[];
  candidates: CandidateRowDTO[];
  closed: DeadlineRowDTO[];
}

/** Everything `/deadlines` renders, in one round of reads — the owner resolved internally, the
 *  same shape as `lib/proactivity.ts`'s `getProactivityView`. */
export async function getDeadlinesView(): Promise<DeadlinesView> {
  const owner = ownerId();
  const [ladderEnabled, open, candidates, closed] = await Promise.all([
    readLadderEnabled(owner),
    readOpenDeadlines(owner),
    readOpenCandidates(owner),
    readClosedDeadlines(owner, 20),
  ]);
  return { owner, ladderEnabled, open, candidates, closed };
}
