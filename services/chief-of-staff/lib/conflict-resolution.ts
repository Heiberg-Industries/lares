/**
 * lib/conflict-resolution.ts — the bounded mailbox search per clash (LAR-59-s3, ORB-139
 * resolution half).
 *
 * WHAT THIS DOES. For each `overlapping-stay` clash the detector already found
 * (`lib/calendar-conflicts.ts`), ask whether exactly ONE of the two bookings has a strong
 * cancellation match (`lib/conflict-evidence.ts`). When exactly one does, attach a
 * `resolution` naming that event; otherwise the clash keeps today's plain flag. Nothing here
 * ever deletes, declines or drafts anything — this only decides which stale-event proposal, if
 * any, a LATER slice (s5) is allowed to surface behind an approval card.
 *
 * THE SAFETY PROPERTY THAT MATTERS MOST: mail text can never choose WHICH event a resolution
 * points at, and it can never invent a clash. `resolveConflicts` only ever iterates the
 * `conflicts` array it was GIVEN — every clash in it, and every event id inside it, came from
 * `detectCalendarConflicts` reading calendar data alone. A mail is consulted only to ask "does
 * this specific, already-flagged event have a cancellation?" (`matchCancellation` checks the
 * CANDIDATE EVENT's own vendor name against the mail — it never reads an event id or vendor
 * name OUT of the mail). A mail whose subject names some unrelated third booking
 * ("cancel the 14:00 with the bank") simply fails to match either candidate and changes
 * nothing; see `tests/conflict-resolution.test.ts`'s "cannot be steered by mail text" cases.
 *
 * NO CTX, DELIBERATELY. This module is a plain library function, injected with a `gmailFor`
 * dependency — it is not itself an eve tool and nothing wires it into a turn yet (that is
 * s5, out of this slice's scope). There is therefore no `ctx` to thread an origin-taint stamp
 * through, and none is invented here: the moment a catalogue tool calls this function inside a
 * turn, THAT call site is where `taintTurn`/`turnKeyFrom` belongs (the same convention
 * `catalogue/gmail_search.ts` and `catalogue/calendar_conflicts.ts` already follow), exactly
 * as `gmail_search` and `gmail_read` do for a direct Gmail read. Whoever builds s5 must add
 * that there, not here.
 *
 * BOUNDED, NEVER A SWEEP. Three named caps ({@link MAX_CLASHES_PER_PASS},
 * {@link MAX_MESSAGES_PER_EVENT}, {@link CLASH_TIMEOUT_MS}), plus the query's own date window
 * ({@link SEARCH_WINDOW_BEFORE_DAYS}/{@link SEARCH_WINDOW_AFTER_DAYS}) and its restriction to
 * `overlapping-stay` clashes only (the owner's own decision: a meeting "cancellation" is
 * usually a calendar update, not a mail — double-booked and timezone-trap clashes are never
 * searched).
 *
 * NEVER THROWS. A search failure, a timeout, or anything else going wrong for one clash costs
 * that clash its plain flag only — one `console.warn`, the clash unchanged, every other clash
 * unaffected. A clash the detector never raised can never appear in the output either, since
 * the output is built by mapping over the input, one entry per input entry, in order.
 */
import { withTimeout } from "./timeout.js";
import { evidenceSentence, matchCancellation, vendorOf, isoDayOf, type EvidenceEvent, type MatchStrength } from "./conflict-evidence.js";
import { addDays, type CalendarConflict, type ConflictEventRef } from "./calendar-conflicts.js";
import type { GmailClient, MailMessage } from "./google.js";

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The caps. Named, tested, and — the point of this module — never a tuning knob for "search
// more": raising any of these is a decision to widen the mailbox sweep, not a bugfix.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** How many `overlapping-stay` clashes ONE PASS will search. Every clash beyond this keeps its
 *  plain flag, unsearched — never a partial or best-effort search of the rest. */
export const MAX_CLASHES_PER_PASS = 3;

/** How many candidate messages are read PER EVENT (not per clash — each of the two bookings in
 *  a stay clash gets its own budget). Enforced twice: the search itself is asked for at most
 *  this many ids, and the id list is sliced to this many again before any is read, so a search
 *  client that ignores its own `max` parameter still cannot cost more reads than this. */
export const MAX_MESSAGES_PER_EVENT = 5;

/** Wall-clock ceiling on resolving ONE clash (both its events, searched in parallel), via
 *  `lib/timeout.ts`. A wedged Gmail call costs this clash its plain flag, never the rest of
 *  the pass and never the brief that is waiting on it. */
export const CLASH_TIMEOUT_MS = 10_000;

/** The query's date window, in days either side of the check-in day: far enough back that a
 *  cancellation mailed well ahead of the stay is still inside it, one day past check-in so a
 *  same-day cancellation is not clipped by an exclusive boundary. */
export const SEARCH_WINDOW_BEFORE_DAYS = 120;
export const SEARCH_WINDOW_AFTER_DAYS = 1;

/** The exact cancellation-word disjunction the query asks Gmail for. Deliberately broader than
 *  `CANCEL_WORDS` in `lib/conflict-evidence.ts` (that module's own phrase list, applied AFTER
 *  the mail is in hand, is the precise filter) — this is a SEARCH, cast slightly wide on
 *  purpose, and `matchCancellation` is what actually decides. */
const QUERY_CANCEL_TERMS = "cancelled OR canceled OR cancellation OR kansellert OR avbestilt OR avbestilling";

/** Gmail's `after:`/`before:` take `YYYY/MM/DD` and match the message date (the belief this
 *  module bets on — see the live probe, `tests/live/gmail-cancellation-search.live.mts`). */
function toGmailDate(isoDay: string): string {
  return isoDay.replaceAll("-", "/");
}

/**
 * The exact query `resolveConflicts` sends for one booking: a quoted vendor name, the
 * cancellation-word disjunction, and the date window around `checkInDay` (`YYYY-MM-DD`).
 * Exported so the live probe runs the SAME builder against a real mailbox, never a second,
 * possibly-drifted copy of it.
 */
export function buildCancellationQuery(vendor: string, checkInDay: string): string {
  const after = toGmailDate(addDays(checkInDay, -SEARCH_WINDOW_BEFORE_DAYS));
  const before = toGmailDate(addDays(checkInDay, SEARCH_WINDOW_AFTER_DAYS));
  return `"${vendor}" (${QUERY_CANCEL_TERMS}) after:${after} before:${before}`;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The shapes.
// ═══════════════════════════════════════════════════════════════════════════════════════════

export interface ConflictResolution {
  /** The id of the event a later slice may propose deleting — always one of THIS clash's own
   *  two event ids, from calendar data; never derived from mail text. */
  readonly staleEventId: string;
  /** Carried from that event's own `account`/`calendarId` (LAR-59-s1), when the fan-out set
   *  them, so a later delete can target the right calendar. */
  readonly account?: string;
  readonly calendarId?: string;
  /** Always `"strong"` in practice — see the acceptance rule below — but typed as
   *  {@link MatchStrength} rather than the literal, so a caller that reads this field and a
   *  caller that reads {@link matchCancellation}'s own result are looking at the same type. */
  readonly strength: MatchStrength;
  /** `evidenceSentence`'s fixed sentence, verbatim — sender, date, truncated subject, never
   *  body text. */
  readonly sentence: string;
}

export type ResolvedConflict = CalendarConflict & { readonly resolution?: ConflictResolution };

export interface ConflictResolutionDeps {
  /** A Gmail client for one account (or the default mailbox when `account` is omitted) — the
   *  same convention `googleClients().gmail(account?)` already uses. Only `search`/`read` are
   *  needed, so a caller can hand this a narrower fake than the full `GmailClient`. */
  gmailFor(account?: string): Promise<Pick<GmailClient, "search" | "read">>;
}

export interface ConflictResolutionCaps {
  maxClashes?: number;
  maxMessagesPerEvent?: number;
  clashTimeoutMs?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The pass.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** One candidate event's cancellation check: the vendor and the search, capped, then matched.
 *  Returns `null` — no throw — for anything that rules the event out early (no vendor, no
 *  readable check-in day) or that simply finds no qualifying mail. */
async function matchOneEvent(
  event: ConflictEventRef, deps: ConflictResolutionDeps, maxMessages: number,
): Promise<{ strength: MatchStrength; sentence: string } | null> {
  const vendor = vendorOf(event.title);
  if (vendor === null) return null;
  const checkInDay = isoDayOf(event.start);
  if (checkInDay === null) return null;

  const gmail = await deps.gmailFor(event.account);
  const query = buildCancellationQuery(vendor, checkInDay);
  const ids = (await gmail.search(query, maxMessages)).slice(0, maxMessages);

  const mails: MailMessage[] = [];
  for (const id of ids) {
    const mail = await gmail.read(id);
    if (mail) mails.push(mail);
  }

  const evidenceEvent: EvidenceEvent = { title: event.title, start: event.start, end: event.end };
  const match = matchCancellation(evidenceEvent, mails);
  return match ? { strength: match.strength, sentence: evidenceSentence(match) } : null;
}

/** One `overlapping-stay` clash, both events checked in parallel. A resolution is attached
 *  ONLY when EXACTLY ONE event came back `"strong"` — two strong matches or none (including
 *  any weak-only case) leave the clash exactly as it arrived. */
async function resolveOneClash(
  conflict: CalendarConflict, deps: ConflictResolutionDeps, maxMessages: number,
): Promise<ResolvedConflict> {
  const results = await Promise.all(conflict.events.map((e) => matchOneEvent(e, deps, maxMessages)));
  const strongIdx: number[] = [];
  results.forEach((r, i) => { if (r?.strength === "strong") strongIdx.push(i); });
  if (strongIdx.length !== 1) return conflict;

  const i = strongIdx[0]!;
  const event = conflict.events[i]!;
  const result = results[i]!;
  return {
    ...conflict,
    resolution: {
      staleEventId: event.id,
      ...(event.account !== undefined ? { account: event.account } : {}),
      ...(event.calendarId !== undefined ? { calendarId: event.calendarId } : {}),
      strength: result.strength,
      sentence: result.sentence,
    },
  };
}

/**
 * Every conflict, unchanged, except that an `overlapping-stay` clash among the first
 * {@link MAX_CLASHES_PER_PASS} (in the order given) gains a `resolution` when exactly one of
 * its two bookings has a strong cancellation match. `double-booked` and `timezone-trap`
 * clashes are always returned unchanged and never searched (the owner's own decision: only
 * overlapping stays, not meetings).
 *
 * NEVER THROWS. A resolving clash that errors or exceeds {@link CLASH_TIMEOUT_MS} logs one
 * `console.warn` and is returned unchanged; every other clash in the same pass is unaffected.
 */
export async function resolveConflicts(
  conflicts: readonly CalendarConflict[],
  deps: ConflictResolutionDeps,
  caps: ConflictResolutionCaps = {},
): Promise<ResolvedConflict[]> {
  const maxClashes = caps.maxClashes ?? MAX_CLASHES_PER_PASS;
  const maxMessages = caps.maxMessagesPerEvent ?? MAX_MESSAGES_PER_EVENT;
  const timeoutMs = caps.clashTimeoutMs ?? CLASH_TIMEOUT_MS;

  const out: ResolvedConflict[] = [];
  let searched = 0;

  for (const conflict of conflicts) {
    if (conflict.kind !== "overlapping-stay" || searched >= maxClashes) {
      out.push(conflict);
      continue;
    }
    searched++;
    try {
      out.push(await withTimeout(resolveOneClash(conflict, deps, maxMessages), timeoutMs, "conflict-resolution"));
    } catch (err) {
      console.warn(`conflict-resolution: could not resolve a clash, leaving its plain flag (${(err as Error).message})`);
      out.push(conflict);
    }
  }
  return out;
}
