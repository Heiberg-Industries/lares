/**
 * The deadline engine: the standing statutory calendar, the per-year mint, and the
 * escalation ladder's one step.
 *
 * WHAT THIS IS: the machinery for a STANDING calendar — the dates that repeat every year because
 * a statute says so, written down once so a missed filing is a bug in the calendar rather than a
 * gap in memory. The calendar itself is INSTALLATION DATA, not engine code: it is a jurisdiction's
 * rules for one kind of company, and which jurisdiction (and which rules) applies is the owner's
 * fact. An installation supplies it as a JSON file named by `DEADLINE_CALENDAR_FILE`:
 *
 *     { "jurisdiction": "XX-LLC",
 *       "rules": [ { "key": "annual-return", "title": "Annual return",
 *                    "month": 3, "day": 31, "yearOffset": 1, "recurrence": "yearly",
 *                    "consequence": "A late fee runs per day.", "evidenceRule": "owner confirms" } ] }
 *
 * With no file configured there is no calendar: the mint says so plainly, and every other part of
 * the deadline feature (adding, the brief, the ladder) works as ever. The console reads the same
 * file, so there is one copy of the table, not two.
 *
 * WHAT THIS DELIBERATELY IS NOT:
 *
 *   - **Not an authority feed.** Nothing here calls a tax or registry authority; nothing here is
 *     refreshed. A rule is a date this file believes, and a belief can go stale — a deadline that
 *     lands on a weekend or a public holiday commonly moves, terminal dates change, and a company
 *     can be assigned a different reporting frequency. That is why the mint is a CARD the owner
 *     confirms per year rather than a silent insert: the confirmation is the moment
 *     the year's dates are checked against the authority by a human, and every rule carries an
 *     `evidenceRule` (default `"owner confirms"`) for the same reason.
 *   - **Not a per-company profile.** Some rules apply only to some companies (a VAT-registered
 *     one, say). The engine does not guess which — the caller drops the ones that do not apply
 *     through `mintYear`'s `omit`, and an unknown key in `omit` THROWS, because the failure mode
 *     of a typo is a deadline silently kept when the owner meant to drop it, or dropped when they
 *     meant to keep it.
 *   - **Not a store and not a channel.** No database, no message, no clock of its own: `now` and
 *     `tz` are always arguments. `ladderStep` says which rung is due; it never sends. The caller
 *     gates the send (ADR 0014 — a schedule speaks only through `initiate()`).
 *
 * All day arithmetic is on the OWNER's clock, reusing `proactivity.ts`'s `ownerDay`/`wallClock`
 * (`Intl.DateTimeFormat("sv-SE")`, no library) so a deadline's "tomorrow" and a gate's "today" can
 * never come off two different clocks. `daysToDue` counts WHOLE
 * calendar days between two `YYYY-MM-DD` strings, so 23:30 the night before is one day out and
 * 00:30 the same night is zero, which is what a person means by "tomorrow".
 */
import { readFileSync, statSync } from "node:fs";

import { ownerDay, wallClock } from "./proactivity.js";

export type DeadlineSource = "statutory" | "accounting" | "contract" | "subscription" | "manual" | "renewal";
export type DeadlineRecurrence = "none" | "yearly" | "bimonthly" | "monthly";

export interface StatutoryRule {
  /** Stable across years — the mint keys on it, so renaming one orphans its rows. */
  key: string;
  /** Rendered verbatim on the card and in the brief, in the language the installation wrote it in. */
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

/** The installation's calendar: one jurisdiction key and its rules. */
export interface StatutoryCalendar {
  jurisdiction: string;
  rules: readonly StatutoryRule[];
}

const RECURRENCES: readonly DeadlineRecurrence[] = ["none", "yearly", "bimonthly", "monthly"];

/** Parse and validate a calendar file's text. Throws, naming the problem, on anything malformed:
 *  a half-read calendar would mint a wrong year, which is worse than minting nothing. */
export function parseStatutoryCalendar(text: string): StatutoryCalendar {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`deadline calendar: not valid JSON (${(e as Error).message})`);
  }
  const obj = raw as { jurisdiction?: unknown; rules?: unknown };
  if (typeof obj?.jurisdiction !== "string" || obj.jurisdiction.trim() === "") {
    throw new Error('deadline calendar: "jurisdiction" must be a non-empty string');
  }
  if (!Array.isArray(obj.rules)) throw new Error('deadline calendar: "rules" must be an array');
  const seen = new Set<string>();
  const rules = obj.rules.map((r: unknown, i): StatutoryRule => {
    const x = r as Record<string, unknown>;
    const where = `deadline calendar: rule ${i + 1}`;
    const str = (k: string): string => {
      const v = x?.[k];
      if (typeof v !== "string" || v.trim() === "") throw new Error(`${where}: "${k}" must be a non-empty string`);
      return v;
    };
    const int = (k: string, min: number, max: number): number => {
      const v = x?.[k];
      if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
        throw new Error(`${where}: "${k}" must be a whole number from ${min} to ${max}`);
      }
      return v;
    };
    const key = str("key");
    if (seen.has(key)) throw new Error(`${where}: duplicate key "${key}"`);
    seen.add(key);
    const yearOffset = int("yearOffset", 0, 1) as 0 | 1;
    const recurrence = str("recurrence") as DeadlineRecurrence;
    if (!RECURRENCES.includes(recurrence)) throw new Error(`${where}: "recurrence" must be one of ${RECURRENCES.join(", ")}`);
    return {
      key,
      title: str("title"),
      month: int("month", 1, 12),
      day: int("day", 1, 31),
      yearOffset,
      recurrence,
      consequence: str("consequence"),
      evidenceRule: typeof x["evidenceRule"] === "string" && x["evidenceRule"].trim() !== "" ? x["evidenceRule"] : "owner confirms",
    };
  });
  return { jurisdiction: obj.jurisdiction.trim(), rules: Object.freeze(rules) };
}

let calendarCache: { key: string; calendar: StatutoryCalendar } | undefined;

/** The installation's calendar from `DEADLINE_CALENDAR_FILE`, or null when none is configured.
 *  A configured file that cannot be read or is malformed throws. */
export function statutoryCalendar(env: Record<string, string | undefined> = process.env): StatutoryCalendar | null {
  const path = env["DEADLINE_CALENDAR_FILE"];
  if (!path) return null;
  const key = `${path}:${statSync(path).mtimeMs}`;
  if (calendarCache?.key === key) return calendarCache.calendar;
  const calendar = parseStatutoryCalendar(readFileSync(path, "utf8"));
  calendarCache = { key, calendar };
  return calendar;
}

/** The jurisdiction a mint call means: the one it names, else the installation's own. Null when
 *  neither exists. */
export function jurisdictionFor(named: unknown): string | null {
  if (typeof named === "string" && named.trim() !== "") return named.trim();
  return statutoryCalendar()?.jurisdiction ?? null;
}

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
 * `omit` drops rules that do not apply to this company. An unknown key throws
 * rather than being ignored: a silently-ignored typo leaves a deadline standing that the owner
 * believed they had dropped, and neither side would ever see it.
 *
 * A MID-YEAR MINT SKIPS WHAT IS ALREADY PAST. Minting a year in September
 * inserts every term from January onwards, and each of those rows is overdue the moment it lands —
 * so the brief's Frister block, which names an overdue row EVERY day, opens the next morning with a
 * wall of filings that were made months ago. They are returned in `skippedPast` rather than
 * dropped in silence: the owner who really does want a January row back can add it by hand, or
 * mint again with `includePast: true`.
 */
export function mintYear(
  jurisdiction: string,
  fiscalYear: number,
  opts?: MintYearOptions,
): MintYearResult {
  const calendar = statutoryCalendar();
  if (calendar === null) {
    throw new Error(
      "mintYear: no statutory calendar is configured for this installation (DEADLINE_CALENDAR_FILE is not set)",
    );
  }
  if (calendar.jurisdiction !== jurisdiction) {
    throw new Error(
      `mintYear: this installation's calendar is for "${calendar.jurisdiction}", not "${jurisdiction}"`,
    );
  }
  const rules = calendar.rules;
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
 * True when the brief should list this deadline today: a mention day, or overdue and
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
 * The rung due NOW for an open deadline, or null. Pure; the caller gates it.
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
