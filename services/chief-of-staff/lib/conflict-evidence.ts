/**
 * lib/conflict-evidence.ts — does THIS mail cancel THIS booking? (LAR-59-s2, ORB-139
 * resolution half, groundwork.)
 *
 * WHY THIS EXISTS. The detection half (`lib/calendar-conflicts.ts`) finds two overlapping
 * stays and deliberately stops there — it never proposes a fix. The next step, wiring a
 * bounded Gmail search and an approval card, is later work (LAR-59-s3 onward). This module is
 * the rule those slices will call: given one stay and a short list of candidate mails, does
 * any of them look like a cancellation of THAT booking, specifically?
 *
 * THE BIAS IS CONSERVATIVE ON PURPOSE. A wrong "yes, this was cancelled" leads a later slice
 * to PROPOSE DELETING A LIVE BOOKING. A wrong "no match" leaves the plain clash flag standing,
 * which is exactly what happens today. Those two mistakes are not symmetric, so every rule
 * below is written to fail toward "no match": a missing vendor, a veto phrase anywhere in the
 * text, a mail sent after check-in, or a date that cannot be read all quietly return `null`
 * or downgrade `strong` to `weak` rather than guess.
 *
 * PURE, NO I/O. No network call, no database, no clock read (there is nothing here that reads
 * "now" — a mail's own `sentAt` is compared only to the event's own `start`). Same inputs in,
 * same verdict out, every time.
 *
 * THIRD-PARTY CONTENT. A mail's subject and body are the most hostile text this engine reads
 * (ADR-0019, `lib/obligation-intent.ts`'s own sentence). This module only ever MATCHES that
 * text against fixed word lists and date patterns — it never executes, follows, or interprets
 * an instruction found inside a mail. `evidenceSentence` is the one function that renders any
 * of it back out, and it renders only `from`, `sentAt` and a truncated `subject` — never the
 * body, which is where an injected instruction would live.
 */
import type { MailMessage } from "./google.js";

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The word lists. English and Norwegian, because that is what the owner's mailbox holds.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** A cancellation actually happened. Substring-matched, lower-case, against the mail's own
 *  subject and body — never against a mail we merely wish said this. */
export const CANCEL_WORDS: readonly string[] = [
  "cancelled",
  "canceled",
  "cancellation confirmed",
  "kansellert",
  "avbestilt",
  "avbestilling bekreftet",
];

/**
 * A cancel word nearby does NOT mean a cancellation happened — a hotel's own boilerplate
 * ("free cancellation", "cancellation policy") and a marketing mail ("cancel anytime") say
 * these words about EVERY booking or EVERY subscriber, not about this one. Any one of these
 * phrases anywhere in the mail vetoes it entirely: the conservative direction is to lose a
 * true match to a coincidental footer, never to keep a false one because the footer was easy
 * to ignore.
 */
export const NOT_EVIDENCE: readonly string[] = [
  "free cancellation",
  "cancellation policy",
  "cancel anytime",
  "gratis avbestilling",
  "avbestillingsregler",
];

/** Leading words a booking title wraps a vendor name in. Stripped once, in this order, so
 *  "Stay at The Standard" and "Hotell Continental" both yield the bare vendor name. The
 *  vocabulary matches `lib/calendar-conflicts.ts`'s `STAY_TITLE`, deliberately: this module
 *  reads the same titles that class already recognises as beds. */
const VENDOR_PREFIXES: readonly string[] = [
  "stay at",
  "opphold på",
  "opphold pa",
  "check-in",
  "checkin",
  // "hotell" (Norwegian) before "hotel" (English) — "hotel" is a PREFIX of "hotell", and
  // checking it first would strip "Hotell Continental" down to "l Continental".
  "hotell",
  "hotel",
];

const MONTH_LONG: Readonly<Record<number, readonly string[]>> = {
  1: ["january", "januar"], 2: ["february", "februar"], 3: ["march", "mars"],
  4: ["april"], 5: ["may", "mai"], 6: ["june", "juni"],
  7: ["july", "juli"], 8: ["august"], 9: ["september"],
  10: ["october", "oktober"], 11: ["november"], 12: ["december", "desember"],
};

const MONTH_SHORT: Readonly<Record<number, readonly string[]>> = {
  1: ["jan"], 2: ["feb"], 3: ["mar"], 4: ["apr"], 5: ["may", "mai"], 6: ["jun"],
  7: ["jul"], 8: ["aug"], 9: ["sep"], 10: ["oct", "okt"], 11: ["nov"], 12: ["dec", "des"],
};

const MONTH_ABBR_EN: readonly string[] = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Small pure helpers.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * The vendor named in a booking title, or `null` when nothing worth matching survives.
 *
 * Strips ONE leading phrase from {@link VENDOR_PREFIXES} (case-insensitive, with any of a
 * colon/dash/space after it), then returns whatever remains when it is at least 4 characters
 * long — short enough to be no name at all ("Hotel" alone strips to "") reads as `null`,
 * because matching a mail against a 1-3 character token is how a vendor check stops meaning
 * anything.
 */
export function vendorOf(title: string): string | null {
  let rest = (title ?? "").trim();
  for (const prefix of VENDOR_PREFIXES) {
    const re = new RegExp(`^${escapeRegExp(prefix)}[\\s:.-]*`, "iu");
    if (re.test(rest)) {
      rest = rest.replace(re, "").trim();
      break; // one pass only — the titles this reads wrap a vendor in at most one such phrase.
    }
  }
  return rest.length >= 4 ? rest : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** The `YYYY-MM-DD` a booking's `start` (timed or all-day) reads as its check-in day — read
 *  straight off the date STRING, never through a `Date` round-trip (the ORB-118/LAR-67 lesson:
 *  a timezone conversion can walk an all-day date onto the wrong side of midnight). Exported
 *  (LAR-59-s3) so `lib/conflict-resolution.ts`'s Gmail query builder reads the same check-in
 *  day this module matches against, rather than a second copy of the regex drifting from it. */
export function isoDayOf(start: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/u.exec(start.trim());
  return m ? m[1]! : null;
}

/**
 * Does `text` mention `isoDay` (`YYYY-MM-DD`), in any of these shapes: the ISO date itself,
 * `26 Aug`, `26. aug`, `26. august`, `August 26`, `Aug 26`, `26.08`, `26/08`. Case-insensitive.
 * Both the English and the Norwegian names for the month are accepted throughout, because the
 * mail this reads is not only English.
 */
export function mentionsDate(text: string, isoDay: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(isoDay.trim());
  if (!m) return false;
  const [, , monthStr, dayStr] = m;
  const month = Number(monthStr);
  const lower = text.toLowerCase();

  if (lower.includes(isoDay.trim().toLowerCase())) return true;

  const dayNum = String(Number(dayStr));
  const dayVariants = [...new Set([dayNum, dayStr])];
  const names = [...(MONTH_SHORT[month] ?? []), ...(MONTH_LONG[month] ?? [])];

  for (const dv of dayVariants) {
    for (const name of names) {
      if (new RegExp(`\\b${dv}\\s+${name}\\b`, "iu").test(lower)) return true; // "26 Aug"
      if (new RegExp(`\\b${name}\\s+${dv}\\b`, "iu").test(lower)) return true; // "Aug 26"
      if (new RegExp(`\\b${dv}\\.\\s*${name}\\b`, "iu").test(lower)) return true; // "26. aug"
    }
  }

  if (lower.includes(`${dayStr}.${monthStr}`)) return true; // "26.08"
  if (lower.includes(`${dayStr}/${monthStr}`)) return true; // "26/08"

  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The matcher.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** The booking, reduced to what this module needs to know. Structurally a `ConflictEventRef` /
 *  `CalendarEvent`, declared here so this module depends on neither. */
export interface EvidenceEvent {
  readonly title: string;
  readonly start: string;
  readonly end: string;
}

export type MatchStrength = "strong" | "weak";

export interface CancellationMatch {
  readonly strength: MatchStrength;
  readonly mail: MailMessage;
}

/**
 * Does any mail in `mails` look like a cancellation of `event`? Returns the newest qualifying
 * mail with its strength, or `null` when nothing qualifies.
 *
 * A mail QUALIFIES when all of these hold:
 *  - `event.title` yields a vendor ({@link vendorOf}) — a title with none can never match;
 *  - the vendor appears in the mail's subject or body;
 *  - a {@link CANCEL_WORDS} phrase appears in the mail;
 *  - no {@link NOT_EVIDENCE} phrase appears anywhere in the mail;
 *  - the mail was sent strictly before `event.start` — a "cancellation" received after
 *    check-in cannot be evidence that the booking never happened.
 *
 * Among qualifying mails, the NEWEST (by `sentAt`) wins. Its strength is `"strong"` when it
 * also mentions the check-in day ({@link mentionsDate}), else `"weak"`. The caller decides how
 * to threshold that — this module only ever reports it.
 *
 * Returns `null`, never throws, when `event.start` cannot be parsed as an instant: without a
 * usable start there is no way to honour the "before check-in" rule, and skipping it silently
 * would be the one unsafe direction.
 */
export function matchCancellation(
  event: EvidenceEvent, mails: readonly MailMessage[],
): CancellationMatch | null {
  const vendor = vendorOf(event.title);
  if (vendor === null) return null;
  const vendorToken = vendor.toLowerCase();

  const eventStart = Date.parse(event.start);
  if (Number.isNaN(eventStart)) return null;

  const checkInDay = isoDayOf(event.start);

  let best: { mail: MailMessage; sentAt: number } | null = null;
  for (const mail of mails) {
    const text = `${mail.subject ?? ""}\n${mail.bodyText ?? ""}`.toLowerCase();
    if (!text.includes(vendorToken)) continue;
    if (!CANCEL_WORDS.some((w) => text.includes(w))) continue;
    if (NOT_EVIDENCE.some((w) => text.includes(w))) continue;

    const sentAt = Date.parse(mail.sentAt);
    if (Number.isNaN(sentAt) || sentAt >= eventStart) continue;

    if (!best || sentAt > best.sentAt) best = { mail, sentAt };
  }
  if (!best) return null;

  const text = `${best.mail.subject ?? ""}\n${best.mail.bodyText ?? ""}`;
  const strong = checkInDay !== null && mentionsDate(text, checkInDay);
  return { strength: strong ? "strong" : "weak", mail: best.mail };
}

/** The `from` header, reduced to a display name when there is one, else the bare address. */
function fromDisplay(from: string): string {
  const raw = (from ?? "").trim();
  const m = /^"?([^"<]*?)"?\s*<([^>]+)>$/u.exec(raw);
  if (!m) return raw;
  const name = m[1]!.trim();
  return name !== "" ? name : m[2]!.trim();
}

/** `sentAt` as `D Mon YYYY` (e.g. `18 Aug 2026`), read off UTC fields — pure and independent
 *  of the machine's own timezone, which a "same input, same output" module must be. */
function formatSentAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTH_ABBR_EN[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function truncate(s: string, max: number): string {
  const trimmed = (s ?? "").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * The fixed, English sentence an approval card can show as evidence. Built ONLY from `from`,
 * `sentAt` and a subject truncated to 80 characters — never body text, which is where an
 * injected instruction in the mail would live.
 */
export function evidenceSentence(match: CancellationMatch): string {
  const from = fromDisplay(match.mail.from);
  const when = formatSentAt(match.mail.sentAt);
  const subject = truncate(match.mail.subject, 80);
  return `Cancellation mail from ${from}, ${when}: "${subject}".`;
}
