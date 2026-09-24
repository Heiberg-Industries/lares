/**
 * detectProposedWindow — does an inbound email propose a meeting time, and if so, over what
 * window should the calendar be checked before drafting a reply? (ORB-147 Task 2.)
 *
 * PURE by design: `now` is always a parameter, never `new Date()`/`Date.now()` read from
 * inside this file. eve injects no ambient clock into agents — every computed date is a
 * guess without one, and that guess has already produced two wrong reminders in this fleet
 * (see recurrence.ts's port notes). A detector with a silent internal clock would carry the
 * same risk into email drafting.
 *
 * NO MODEL CALL, ever. The email-triage schedule caps billed calls at
 * TRIAGE_CEILING_PER_TICK = 10, one per message — a detector call here would double that,
 * and an uncapped retry loop is exactly what turned into a $250 leak in August. This also
 * keeps the detector unit-testable, which a model call is not.
 *
 * Conservative on purpose: a miss costs nothing (the draft is no worse than today, since
 * Task 3's calendar read simply doesn't happen); a false positive costs one calendar read.
 * So every pattern below is written to avoid firing on ordinary prose, even at the cost of
 * missing some real proposals — see the per-pattern comments for the specific collisions
 * that ruled each shape in or out.
 *
 * Correspondents write in English AND Norwegian, in the same inbox, sometimes the same
 * thread — that's deliberate, not something to normalise (Bendik's mail always has both).
 * Every pattern family below has an EN and a NO branch.
 */
import { osloDate, addOsloDays, osloLocalToDate } from "./recurrence.js";

export interface ProposedWindow {
  timeMin: string;
  timeMax: string;
  label: string;
}

interface DayMatch {
  index: number;
  date: string; // Oslo-local YYYY-MM-DD
  label: string;
}

interface TimeMatch {
  index: number;
  hour: number;
  minute: number;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local copy of recurrence.ts's private `osloDow` — one three-line helper isn't worth
 *  exporting a shared import for (same call as email-triage.ts's `addressOf`, ORB-92). */
function osloDow(d: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Oslo", weekday: "short" });
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return names.indexOf(fmt.format(d));
}

const EN_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const EN_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "Weekday D Month" for a resolved Oslo date, e.g. "Tuesday 2 September" — always rendered
 *  in English regardless of the source language, since this feeds a prompt block rather than
 *  the draft itself (the draft's own language matching is voice.ts's job, not this file's). */
function labelForDate(dateStr: string): string {
  const [, m, d] = dateStr.split("-").map(Number);
  const noon = osloLocalToDate(`${dateStr} 12:00`); // noon sidesteps any DST-boundary edge case
  return `${EN_WEEKDAYS[osloDow(noon)]} ${d} ${EN_MONTHS[m! - 1]}`;
}

// ---------------------------------------------------------------------------------------
// Explicit dates: "2026-09-03", "3. september", "3 Sept", "Sept 3".
// ---------------------------------------------------------------------------------------

const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, januar: 1,
  feb: 2, february: 2, februar: 2,
  mar: 3, march: 3, mars: 3,
  apr: 4, april: 4,
  may: 5, mai: 5,
  jun: 6, june: 6, juni: 6,
  jul: 7, july: 7, juli: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, okt: 10, oktober: 10,
  nov: 11, november: 11,
  dec: 12, december: 12, des: 12, desember: 12,
};
const MONTH_ALT = Object.keys(MONTHS).join("|");

// "3. september" (NO, dot after the day) / "3 Sept" (EN, no dot) / optional ordinal ("3rd") /
// an optional trailing 4-digit year ("3. september 2028"). A required adjacent digit is what
// keeps month words like "may" (the modal verb) and "jul" (Norwegian for Christmas) safe —
// either alone, with no digit next to it, never matches.
const DAY_MONTH_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\.?\\s+(${MONTH_ALT})\\.?(?:,?\\s+(\\d{4}))?\\b`, "i");
const MONTH_DAY_RE = new RegExp(`\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "i");

/** Actual day count for `month` (1-12) in `year`, leap years included — the day-0-of-next-
 *  month trick, via the same UTC-anchored arithmetic recurrence.ts's addOsloDays already uses
 *  elsewhere in this file, so leap-year handling never needs its own separate case. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Resolve a day+month mention to a concrete Oslo YYYY-MM-DD.
 *
 * An explicit year in the text (`explicitYear`) is honoured verbatim — a sender who states a
 * year has given the most reliable signal in the message, and guessing over it would discard
 * a true positive (ORB-147 review, finding 2: "3. september 2028" written in August 2026 must
 * resolve to 2028, not silently roll to 2026/2027 via the yearless heuristic below) — but only
 * when it's a PLAUSIBLE year. The year-capture regex has no way to know it's looking at a year
 * rather than any other bare 4-digit token that happens to follow a day+month phrase — a
 * Norwegian postal code right after a date in an address ("3. september, 1400 Ski") is exactly
 * that shape, and without a plausibility check it would resolve to the year 1400 (ORB-147
 * review round 3: this file's own finding-2 fix reintroduced the wrong-positive-with-a-garbage-
 * value failure class it was written to eliminate). Outside [now-1, now+10], the captured token
 * is treated as NOT a year — falling back to the same yearless rollover guess below, rather than
 * returning null outright, because the day+month mention itself is still a perfectly good
 * signal; only the trailing digits' meaning as "a year" was ever in doubt.
 *
 * With no explicit (or no plausible) year, this year's occurrence is used, rolled to next year
 * if it has already passed relative to `now` — "3 Sept" said in October means next September,
 * not the one that already happened.
 *
 * Returns null when `day` does not exist in that month for the resolved year — "31 April" (no
 * year has a 31st in April) or "29 February" landing on a non-leap year — rather than letting
 * it silently normalize to a different calendar date the way JS `Date` overflow would (ORB-147
 * review, finding 1).
 */
function resolveMonthDay(now: Date, month: number, day: number, explicitYear: number | null): string | null {
  const todayStr = osloDate(now);
  const currentYear = Number(todayStr.slice(0, 4));
  const yearIsPlausible = explicitYear !== null && explicitYear >= currentYear - 1 && explicitYear <= currentYear + 10;

  let year: number;
  if (yearIsPlausible) {
    year = explicitYear!;
  } else {
    year = currentYear;
    const candidate = `${year}-${pad(month)}-${pad(day)}`;
    if (candidate < todayStr) year += 1;
  }
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function findExplicitDate(text: string, now: Date): DayMatch | null {
  const candidates: DayMatch[] = [];

  const iso = ISO_DATE_RE.exec(text);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    // Same month-length rule as the day+month forms below — Date-overflow normalization
    // would otherwise silently turn "2026-02-30" into March 2 (ORB-147 review, finding 1).
    if (month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)) {
      const date = `${iso[1]}-${iso[2]}-${iso[3]}`;
      candidates.push({ index: iso.index, date, label: labelForDate(date) });
    }
  }

  const dm = DAY_MONTH_RE.exec(text);
  if (dm) {
    const day = Number(dm[1]);
    const month = MONTHS[dm[2]!.toLowerCase()];
    const explicitYear = dm[3] ? Number(dm[3]) : null;
    if (month) {
      const date = resolveMonthDay(now, month, day, explicitYear);
      if (date) candidates.push({ index: dm.index, date, label: labelForDate(date) });
    }
  }

  const md = MONTH_DAY_RE.exec(text);
  if (md) {
    const month = MONTHS[md[1]!.toLowerCase()];
    const day = Number(md[2]);
    const explicitYear = md[3] ? Number(md[3]) : null;
    if (month) {
      const date = resolveMonthDay(now, month, day, explicitYear);
      if (date) candidates.push({ index: md.index, date, label: labelForDate(date) });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.index - b.index);
  return candidates[0]!;
}

// ---------------------------------------------------------------------------------------
// Relative days: "tomorrow", "i morgen", "i overmorgen".
// ---------------------------------------------------------------------------------------

// Bare Norwegian "morgen" means "morning" (time of day), not "tomorrow" — only the two-word
// "i morgen" carries that meaning, so the "i " is required, never optional, unlike overmorgen
// below where the bare word is already unambiguous.
const TOMORROW_RE = /\b(tomorrow|i\s+morgen)\b/i;
const OVERMORGEN_RE = /\b(?:i\s+)?overmorgen\b/i;

function findRelativeDay(text: string, now: Date): DayMatch | null {
  const candidates: DayMatch[] = [];

  const tomorrow = TOMORROW_RE.exec(text);
  if (tomorrow) {
    const date = addOsloDays(osloDate(now), 1);
    candidates.push({ index: tomorrow.index, date, label: "tomorrow" });
  }

  const overmorgen = OVERMORGEN_RE.exec(text);
  if (overmorgen) {
    const date = addOsloDays(osloDate(now), 2);
    candidates.push({ index: overmorgen.index, date, label: "the day after tomorrow" });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.index - b.index);
  return candidates[0]!;
}

// ---------------------------------------------------------------------------------------
// Weekday names: "tuesday", "tirsdag" — full names only, deliberately no abbreviations.
// ---------------------------------------------------------------------------------------

// Full names only: 3-letter weekday abbreviations collide too often with ordinary words to
// match standalone (no adjacent digit protects them, unlike the month patterns above) —
// NO "fri" means "free" ("er du fri fredag?"), NO "man" means "one"/"people", EN "sat" is the
// past tense of "sit", EN "sun" is the star. Any of those firing on ordinary prose is exactly
// the false-positive class this detector exists to avoid, so only the unambiguous full words
// are recognised.
const WEEKDAY_WORDS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  søndag: 0, mandag: 1, tirsdag: 2, onsdag: 3, torsdag: 4, fredag: 5, lørdag: 6,
};
const WEEKDAY_RE = new RegExp(`\\b(${Object.keys(WEEKDAY_WORDS).join("|")})\\b`, "i");

function findWeekdayName(text: string, now: Date): DayMatch | null {
  const m = WEEKDAY_RE.exec(text);
  if (!m) return null;
  const targetDow = WEEKDAY_WORDS[m[1]!.toLowerCase()]!;
  const nowDow = osloDow(now);

  // Always the NEXT such weekday, strictly after today — including when `now` itself IS that
  // weekday, in which case this resolves 7 days out, not today. Rule, not an accident: a bare
  // weekday name with no other qualifier ("let's do Tuesday") reads as an upcoming plan: if
  // the sender meant right now, on the day they're writing, they'd say "today". Treating it as
  // possibly-today would mean any Tuesday mention in Tuesday's mail resolves to a same-day
  // window that's frequently wrong (mail sent Tuesday afternoon proposing "Tuesday" almost
  // never means "in the next few hours").
  const daysAhead = ((targetDow - nowDow + 7) % 7) || 7;
  const date = addOsloDays(osloDate(now), daysAhead);
  return { index: m.index, date, label: labelForDate(date) };
}

// ---------------------------------------------------------------------------------------
// Optional clock time: "14:00", "kl 14", "kl. 14:30", "2pm".
// ---------------------------------------------------------------------------------------

// Colon-separated only — "14.00" is excluded because it's exactly how a price reads in this
// inbox ("14.00 kr"), and the negative test case this file ships with is a cost question.
const TIME_24H_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;
const TIME_KL_RE = /\bkl\.?\s*([01]?\d|2[0-3])(?::([0-5]\d))?\b/i;
const TIME_AMPM_RE = /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/i;

function findTime(text: string): TimeMatch | null {
  const candidates: TimeMatch[] = [];

  const t24 = TIME_24H_RE.exec(text);
  if (t24) candidates.push({ index: t24.index, hour: Number(t24[1]), minute: Number(t24[2]) });

  const kl = TIME_KL_RE.exec(text);
  if (kl) candidates.push({ index: kl.index, hour: Number(kl[1]), minute: kl[2] ? Number(kl[2]) : 0 });

  const ampm = TIME_AMPM_RE.exec(text);
  if (ampm) {
    let hour = Number(ampm[1]) % 12;
    if (ampm[3]!.toLowerCase() === "pm") hour += 12;
    candidates.push({ index: ampm.index, hour, minute: ampm[2] ? Number(ampm[2]) : 0 });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.index - b.index);
  return candidates[0]!;
}

// ---------------------------------------------------------------------------------------

/**
 * Does `text` propose a meeting time, and if so over what window should the calendar be
 * checked? Returns null when nothing matches (see file header for why a miss is the safe
 * default). When several day-shaped mentions appear, the one occurring EARLIEST in the text
 * wins — an explicit rule, not the more semantically-loaded "most specific form wins", so an
 * unrelated date elsewhere in the message (an invoice date, a past reference) doesn't get
 * silently preferred over the actual proposal just because it happens to be an ISO date.
 */
export function detectProposedWindow(text: string, now: Date): ProposedWindow | null {
  const dayCandidates = [findExplicitDate(text, now), findRelativeDay(text, now), findWeekdayName(text, now)]
    .filter((c): c is DayMatch => c !== null);
  if (dayCandidates.length === 0) return null;
  dayCandidates.sort((a, b) => a.index - b.index);
  const day = dayCandidates[0]!;

  const time = findTime(text);

  if (time) {
    const start = osloLocalToDate(`${day.date} ${pad(time.hour)}:${pad(time.minute)}`);
    // No message ever states a meeting length, so this assumes a 1-hour meeting starting at
    // the stated time. Getting that wrong just narrows the freeBusy check to a slightly wrong
    // slot on the right day — a false positive/negative on the busy check, not a wrong draft
    // (see file header: a miss here costs nothing, a false positive costs one calendar read).
    const end = new Date(start.getTime() + 60 * 60_000);
    return {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      label: `${day.label} ${pad(time.hour)}:${pad(time.minute)}`,
    };
  }

  const dayStart = osloLocalToDate(`${day.date} 00:00`);
  const dayEnd = osloLocalToDate(`${addOsloDays(day.date, 1)} 00:00`);
  return { timeMin: dayStart.toISOString(), timeMax: dayEnd.toISOString(), label: day.label };
}
