/**
 * ORB-180 — the deadline engine: the standing statutory calendar, the per-year mint, and the
 * escalation ladder's one step.
 *
 * WHAT THIS IS: the STANDING calendar for a limited company (aksjeselskap) in the Norwegian
 * jurisdiction on a CALENDAR fiscal year — the dates that repeat every year because a statute says
 * so, written down once so a missed filing is a bug in the calendar rather than a gap in memory.
 *
 * WHAT THIS DELIBERATELY IS NOT:
 *
 *   - **Not an authority feed.** Nothing here calls Skatteetaten, Altinn or Brønnøysund; nothing
 *     here is refreshed. A rule is a date this file believes, and a belief can go stale — a
 *     deadline that lands on a weekend or a public holiday commonly moves, terminal dates change,
 *     and a company can be assigned a different reporting frequency. That is why the mint is a
 *     CARD the owner confirms per year (Ruling 3) rather than a silent insert: the confirmation is
 *     the moment the year's dates are checked against the authority by a human, and every seeded
 *     rule carries `evidenceRule: "owner confirms"` for the same reason.
 *   - **Not a per-company profile.** The `mva-*` rules apply only to a VAT-REGISTERED company on
 *     the ordinary two-month terminer; a company outside the VAT register, or on annual or monthly
 *     terminer, has a different set. The engine does not guess which — the caller drops the ones
 *     that do not apply through `mintYear`'s `omit`, and an unknown key in `omit` THROWS, because
 *     the failure mode of a typo is a deadline silently kept when the owner meant to drop it, or
 *     dropped when they meant to keep it.
 *   - **Not a store and not a channel.** No database, no message, no clock of its own: `now` and
 *     `tz` are always arguments. `ladderStep` says which rung is due; it never sends. The caller
 *     gates the send (ADR 0014 — a schedule speaks only through `initiate()`).
 *
 * The rule set is REGION-DECLARED, the way `entur-client.ts` declares `NOR`: keyed by
 * `"NO-AS"`, and that key is the only identity in the file. No person, company or place appears
 * here — a rule is a jurisdiction's fact, not one owner's fact, so the same table serves any AS.
 *
 * All day arithmetic is on the OWNER's clock, reusing `proactivity.ts`'s `ownerDay`/`wallClock`
 * (`Intl.DateTimeFormat("sv-SE")`, no library) so a deadline's "tomorrow" and a gate's "today" can
 * never come off two different clocks — the ORB-124/128/204 mistake. `daysToDue` counts WHOLE
 * calendar days between two `YYYY-MM-DD` strings, so 23:30 the night before is one day out and
 * 00:30 the same night is zero, which is what a person means by "tomorrow".
 */
import { ownerDay, wallClock } from "./proactivity.js";

export type DeadlineSource = "statutory" | "accounting" | "contract" | "subscription" | "manual" | "renewal";
export type DeadlineRecurrence = "none" | "yearly" | "bimonthly" | "monthly";

export interface StatutoryRule {
  /** Stable across years — the mint keys on it, so renaming one orphans its rows. */
  key: string;
  /** Norwegian, rendered verbatim on the card and in the brief. */
  title: string;
  month: number;
  day: number;
  /** 1 = the deadline falls in the year AFTER the fiscal year it concerns. */
  yearOffset: 0 | 1;
  recurrence: DeadlineRecurrence;
  /** One sentence: what happens if the date passes. */
  consequence: string;
  /** What closes the row. `"owner confirms"` for every seed in v1 — nothing here reads a receipt. */
  evidenceRule: string;
}

const NO_AS: readonly StatutoryRule[] = [
  {
    key: "aksjonaerregister",
    title: "Aksjonærregisteroppgaven",
    month: 1, day: 31, yearOffset: 1, recurrence: "yearly",
    consequence: "Tvangsmulkt fra Skatteetaten løper per dag",
    evidenceRule: "owner confirms",
  },
  {
    key: "mva-t6",
    title: "MVA-melding, 6. termin",
    month: 2, day: 10, yearOffset: 1, recurrence: "yearly",
    consequence: "Tvangsmulkt per dag og forsinkelsesrenter",
    evidenceRule: "owner confirms",
  },
  {
    key: "forskuddsskatt-1",
    title: "Forskuddsskatt, 1. termin",
    month: 2, day: 15, yearOffset: 1, recurrence: "yearly",
    consequence: "Forsinkelsesrenter og tvangsinnfordring",
    evidenceRule: "owner confirms",
  },
  {
    key: "mva-t1",
    title: "MVA-melding, 1. termin",
    month: 4, day: 10, yearOffset: 0, recurrence: "yearly",
    consequence: "Tvangsmulkt per dag og forsinkelsesrenter",
    evidenceRule: "owner confirms",
  },
  {
    key: "forskuddsskatt-2",
    title: "Forskuddsskatt, 2. termin",
    month: 4, day: 15, yearOffset: 1, recurrence: "yearly",
    consequence: "Forsinkelsesrenter og tvangsinnfordring",
    evidenceRule: "owner confirms",
  },
  {
    key: "skattemelding",
    title: "Skattemelding for AS",
    month: 5, day: 31, yearOffset: 1, recurrence: "yearly",
    consequence: "Tvangsmulkt og mulig tilleggsskatt",
    evidenceRule: "owner confirms",
  },
  {
    key: "mva-t2",
    title: "MVA-melding, 2. termin",
    month: 6, day: 10, yearOffset: 0, recurrence: "yearly",
    consequence: "Tvangsmulkt per dag og forsinkelsesrenter",
    evidenceRule: "owner confirms",
  },
  {
    key: "generalforsamling",
    title: "Ordinær generalforsamling",
    month: 6, day: 30, yearOffset: 1, recurrence: "yearly",
    consequence: "Brudd på aksjeloven § 5-5; årsregnskapet kan ikke godkjennes",
    evidenceRule: "owner confirms",
  },
  {
    key: "aarsregnskap",
    title: "Årsregnskap til Regnskapsregisteret",
    month: 7, day: 31, yearOffset: 1, recurrence: "yearly",
    consequence: "Forsinkelsesgebyr; tvangsoppløsning ved vedvarende mangel",
    evidenceRule: "owner confirms",
  },
  {
    key: "mva-t3",
    title: "MVA-melding, 3. termin",
    month: 8, day: 31, yearOffset: 0, recurrence: "yearly",
    consequence: "Tvangsmulkt per dag og forsinkelsesrenter",
    evidenceRule: "owner confirms",
  },
  {
    key: "mva-t4",
    title: "MVA-melding, 4. termin",
    month: 10, day: 10, yearOffset: 0, recurrence: "yearly",
    consequence: "Tvangsmulkt per dag og forsinkelsesrenter",
    evidenceRule: "owner confirms",
  },
  {
    key: "mva-t5",
    title: "MVA-melding, 5. termin",
    month: 12, day: 10, yearOffset: 0, recurrence: "yearly",
    consequence: "Tvangsmulkt per dag og forsinkelsesrenter",
    evidenceRule: "owner confirms",
  },
];

/** The rule set, keyed by jurisdiction. One key today; the shape is what makes a second one cheap. */
export const STATUTORY_RULES: Readonly<Record<"NO-AS", readonly StatutoryRule[]>> = Object.freeze({
  "NO-AS": Object.freeze(NO_AS),
});

export interface MintedDeadline {
  ruleKey: string;
  title: string;
  /** `YYYY-MM-DD` */
  dueDate: string;
  recurrence: DeadlineRecurrence;
  consequence: string;
  evidenceRule: string;
  source: "statutory";
}

const pad = (n: number) => String(n).padStart(2, "0");

const isoDate = (year: number, month: number, day: number): string =>
  `${year}-${pad(month)}-${pad(day)}`;

export interface MintYearOptions {
  /** Rule keys that do not apply to this company. An unknown key THROWS. */
  omit?: readonly string[];
  /**
   * The OWNER's day, `YYYY-MM-DD` — the line between "still ahead" and "already past".
   *
   * REQUIRED unless {@link MintYearOptions.includePast} is true, and deliberately not defaulted to
   * `new Date()`: this module has no clock of its own (see the file header), and a default here
   * would silently put the owner-day boundary on the SERVER's zone. The caller already knows the
   * owner's zone — it passes `ownerDay(now, tz)`.
   */
  today?: string;
  /** Mint the whole year including dates already gone. Default false. */
  includePast?: boolean;
}

export interface MintYearResult {
  /** The rows to insert, `dueDate` ascending. */
  minted: MintedDeadline[];
  /**
   * The rows dropped because their date is already behind `today` — never inserted, but NAMED, so
   * a mid-year mint can say what it left out instead of quietly minting fewer rows than the year
   * has. Empty when `includePast` is true.
   */
  skippedPast: MintedDeadline[];
}

/**
 * The year's deadlines for a jurisdiction, sorted by `dueDate` ascending — the order the mint card
 * and the brief both read in.
 *
 * `omit` drops rules that do not apply to this company (the VAT set, above). An unknown key throws
 * rather than being ignored: a silently-ignored typo leaves a deadline standing that the owner
 * believed they had dropped, and neither side would ever see it.
 *
 * A MID-YEAR MINT SKIPS WHAT IS ALREADY PAST (review fix, ORB-180). Minting 2026 in September
 * inserts every term from January onwards, and each of those rows is overdue the moment it lands —
 * so the brief's Frister block, which names an overdue row EVERY day, opens the next morning with a
 * wall of filings that were made months ago. They are returned in `skippedPast` rather than
 * dropped in silence: the owner who really does want a January row back can add it by hand, or
 * mint again with `includePast: true`.
 */
export function mintYear(
  jurisdiction: "NO-AS",
  fiscalYear: number,
  opts?: MintYearOptions,
): MintYearResult {
  const rules = STATUTORY_RULES[jurisdiction];
  const omit = new Set(opts?.omit ?? []);
  const unknown = [...omit].filter((k) => !rules.some((r) => r.key === k));
  if (unknown.length > 0) {
    throw new Error(
      `mintYear(${jurisdiction}): unknown rule key(s) in omit: ${unknown.join(", ")}`,
    );
  }

  const includePast = opts?.includePast === true;
  const today = opts?.today;
  if (!includePast && (today === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(today))) {
    throw new Error(
      "mintYear: `today` (YYYY-MM-DD, the owner's day) is required unless includePast is true",
    );
  }

  const all = rules
    .filter((r) => !omit.has(r.key))
    .map((r) => ({
      ruleKey: r.key,
      title: r.title,
      dueDate: isoDate(fiscalYear + r.yearOffset, r.month, r.day),
      recurrence: r.recurrence,
      consequence: r.consequence,
      evidenceRule: r.evidenceRule,
      source: "statutory" as const,
    }))
    // Plain string comparison, not `localeCompare`: `YYYY-MM-DD` sorts correctly by code unit and
    // is not at the mercy of the runtime's collation.
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));

  if (includePast) return { minted: all, skippedPast: [] };
  // Same code-unit comparison as the sort above — a date strictly BEFORE the owner's day is past;
  // one falling on it is today's deadline and still mintable.
  return {
    minted: all.filter((m) => !(m.dueDate < today!)),
    skippedPast: all.filter((m) => m.dueDate < today!),
  };
}

export interface DeadlineForLadder {
  id: string;
  title: string;
  source: DeadlineSource;
  dueDate: string;
  rung: number;
  status: "open" | "done" | "dismissed";
}

/** Midnight UTC of a `YYYY-MM-DD`, in ms — a stable ruler for counting calendar days. */
function utcMidnight(date: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  return Date.UTC(y ?? 1970, (mo ?? 1) - 1, d ?? 1);
}

/** Whole owner-clock days from `now`'s owner day to `dueDate`; negative when overdue. */
export function daysToDue(dueDate: string, now: Date, tz: string): number {
  return Math.round((utcMidnight(dueDate) - utcMidnight(ownerDay(now, tz))) / 86_400_000);
}

/** The wall-clock hour in `tz` — the same clock `daysToDue` counts days on. */
function hourIn(now: Date, tz: string): number {
  return Number(wallClock(now, tz).slice(0, 2));
}

/**
 * The days out on which the brief names a deadline. A named list, not a window: a window has no
 * ceiling, and a line repeated every morning for a month is how a brief stops being read.
 */
export const MENTION_DAYS: readonly number[] = [30, 16, 8, 4, 2, 1, 0];

/**
 * True when the brief should list this deadline today (Ruling 1): a mention day, or overdue and
 * not yet stopped. Once the ladder has rung its final stop the brief goes quiet too — the owner
 * has been told, in the loudest way the system has, and repeating it is nagging rather than news.
 */
export function mentionsToday(d: DeadlineForLadder, now: Date, tz: string): boolean {
  if (d.status !== "open" || d.rung >= 3) return false;
  const dd = daysToDue(d.dueDate, now, tz);
  return MENTION_DAYS.includes(dd) || dd < 0;
}

export interface LadderStep {
  rung: 1 | 2 | 3;
  finalStop: boolean;
}

/**
 * The rung due NOW for an open deadline, or null (Ruling 1's table). Pure; the caller gates it.
 *
 *   rung 1 — 15:00 the day before, any source: "this is tomorrow".
 *   rung 2 — 09:00 on the day, STATUTORY only: a self-imposed date does not earn a second ring.
 *   rung 3 — 09:00 the day after, any source, `finalStop: true`: "I stopped chasing this."
 *
 * A rung is NEVER caught up. The conditions key on the day the rung belongs to, so a deadline that
 * slept through T-1 does not get rung 1 on T+1 — it goes straight to the stop. `rung` on the row is
 * a high-water mark, which is what makes the ladder idempotent under a schedule that ticks often.
 */
export function ladderStep(d: DeadlineForLadder, now: Date, tz: string): LadderStep | null {
  if (d.status !== "open") return null;
  const dd = daysToDue(d.dueDate, now, tz);
  const hh = hourIn(now, tz);
  if (dd === 1 && hh >= 15 && d.rung < 1) return { rung: 1, finalStop: false };
  if (dd === 0 && hh >= 9 && d.rung < 2 && d.source === "statutory") return { rung: 2, finalStop: false };
  if (dd <= -1 && hh >= 9 && d.rung < 3) return { rung: 3, finalStop: true };
  return null;
}

/** Days in a calendar month (1-based month). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The next due date after `dueDate` for a recurrence, or null for `"none"`.
 *
 * yearly = +1 year, bimonthly = +2 months, monthly = +1 month — same day of month, CLAMPED to the
 * target month's length, so the 31st becomes the 28th in February rather than rolling into March.
 * Clamping loses a day rather than gaining one, which for a deadline is the safe direction.
 */
export function nextDue(dueDate: string, recurrence: DeadlineRecurrence): string | null {
  const months = recurrence === "yearly" ? 12 : recurrence === "bimonthly" ? 2 : recurrence === "monthly" ? 1 : null;
  if (months === null) return null;
  const [y, mo, d] = dueDate.split("-").map(Number);
  const total = (y ?? 1970) * 12 + ((mo ?? 1) - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return isoDate(year, month, Math.min(d ?? 1, daysInMonth(year, month)));
}
