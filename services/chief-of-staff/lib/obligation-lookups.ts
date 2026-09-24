/**
 * ORB-45 Task 10, B5 — the two REAL lookups behind `lib/obligation-resolution.ts`'s
 * `resolveElsewhere`: "did he email them after their message?" and "did he sit in a room (or a
 * call) with them after it?".
 *
 * They live HERE, once, rather than inside each schedule, because the morning brief and the
 * evening brief ask the identical question of the identical accounts — two copies would have
 * drifted the first time one of them was tuned. The other two legs need no module: Slack's is
 * a Map lookup over the scan the morning brief already ran (in memory, no I/O), and the network
 * replica's is `lib/network-client.ts`'s `networkOutboundAfter` (Task B2).
 *
 * METADATA ONLY, in both directions. Neither function reads, returns, or logs a word anybody
 * wrote: the Gmail leg returns a timestamp, the calendar leg a timestamp and an event TITLE
 * (which is the evidence sentence's whole content — "you met 2026-08-11 14:00: Pilot review").
 * Nothing here is persisted; `lib/obligations-store.ts` stores the evidence sentence and
 * nothing else.
 *
 * FAIL DIRECTION, deliberately asymmetric. A throw from either function reaches
 * `resolveElsewhere`, which records that source as `unreadable` and contributes NOTHING to the
 * verdict — so the obligation stays on the radar. That is the safe direction: a lookup that
 * broke must never look like "he never answered them", and it must certainly never look like
 * "he did". The one place this file swallows anything is an account that is not wired on THIS
 * host (rule 2 of `lib/calendar-fanout.ts`) — a deterministic, host-level absence, not a data
 * gap a retry could fix.
 *
 * WHAT A FIXTURE CANNOT PROVE (CLAUDE.md's third-party-API rule). Two assumptions here are
 * about Google's behaviour, not this module's logic, and `tests/obligation-lookups.test.ts`
 * can only re-confirm what it was told:
 *   1. Gmail's `after:` operator is DATE-granular and interpreted in the account's own
 *      timezone. This module compensates by re-comparing every candidate against the real
 *      `since` timestamp, so a too-WIDE search costs a few thread reads and nothing else. A too
 *      NARROW one would be the dangerous direction, which is why the query uses the UTC date
 *      (never a rounded-up local one) — a day early is safe, a day late loses a real answer.
 *   2. `events.list`'s `timeMin`/`timeMax` select events that OVERLAP the window rather than
 *      ones contained by it — which is what makes a meeting that started before their message
 *      and ended after it visible at all. If Google ever narrowed that, this leg would silently
 *      stop resolving overnight meetings and every one of these tests would stay green.
 *      Note the ASYMMETRY the branch review fixed: this assumption can now only ever cost a HIT
 *      (a meeting Google declines to return is one this leg never sees), never cause a false
 *      one — the window is re-checked in code on both sides, so an event Google returns that
 *      ended before their message is rejected here rather than trusted through.
 * A live sweep belongs beside this file the day either assumption is load-bearing enough to
 * bet a brief line on.
 */
import { GoogleConfigError } from "@lares/agent-kit/google-auth";

import { addressOf, mapWithConcurrency } from "./brief-content.js";
import { GoogleUnenrolledError, type CalendarEvent, type ThreadMessage } from "./google.js";
import type { ResolutionDeps } from "./obligation-resolution.js";

/** Sent-mail search ceiling. Generous on purpose: the search is already narrowed to HIS mail,
 *  TO these addresses, after a specific date — a result set anywhere near this is a person he
 *  is in constant contact with, which is exactly the case where the answer matters. */
export const SENT_SEARCH_CEILING = 200;

/** In-flight `readThread` calls. Four, not `scanThreads`' six: this runs INSIDE the obligation
 *  pass, once per candidate, so its concurrency multiplies against the resolve pass's own. */
export const SENT_THREAD_CONCURRENCY = 4;

/** Events fetched per account for one obligation's window. A truncated read fails toward
 *  "no meeting found", i.e. the obligation stays on the radar — the safe direction, and the
 *  reason this does not throw on a full page the way the brief's calendar read does. */
export const CALENDAR_LOOKUP_MAX_EVENTS = 50;

export interface GmailLookupDeps {
  searchThreadIds(query: string, ceiling: number): Promise<string[]>;
  readThread(threadId: string): Promise<ThreadMessage[]>;
}

/** `since` as Gmail's `after:` operand — the UTC calendar day, `YYYY/MM/DD`. */
export function gmailAfterDate(since: Date): string {
  const mm = String(since.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(since.getUTCDate()).padStart(2, "0");
  return `${since.getUTCFullYear()}/${mm}/${dd}`;
}

/**
 * "Did he email any of these addresses after `since`?" — the Gmail leg of `resolveElsewhere`.
 *
 * `myAddresses` is read ONCE and memoised for the life of the returned function (one schedule
 * tick), not once per obligation: it is a Postgres read of the identity registry, and a pass
 * over twenty obligations would otherwise make twenty identical queries.
 */
export function makeGmailSentAfter(
  gmail: GmailLookupDeps,
  myAddresses: () => Promise<string[]>,
): ResolutionDeps["gmailSentAfter"] {
  let mine: Promise<Set<string>> | undefined;
  const mineSet = (): Promise<Set<string>> => {
    if (!mine) {
      // A REJECTION IS NOT MEMOISED. Caching one would turn a single transient Postgres blip into
      // "the Gmail leg is unreadable" for every remaining obligation on the tick — one hiccup
      // costing the whole pass its email evidence. Clearing it means the next candidate retries;
      // the happy path still reads the registry exactly once.
      const pending = myAddresses().then((addresses) => {
        if (addresses.length === 0) {
          // The same guard `gatherOpenObligations` makes at the top of the pass, for the same
          // reason: with no addresses on file NOTHING would ever match him, so every lookup
          // would answer "he never replied" — a confident wrong answer in the direction that
          // keeps obligations alive forever. Louder is better; the caller turns this into an
          // `unreadable` source.
          throw new Error(
            "cannot tell which sent mail is his: the identity registry returned no addresses for the owner",
          );
        }
        return new Set(addresses.map((a) => a.toLowerCase()));
      });
      pending.catch(() => { if (mine === pending) mine = undefined; });
      mine = pending;
    }
    return mine;
  };

  return async (addresses: string[], since: Date): Promise<Date | null> => {
    if (addresses.length === 0) return null;   // nothing to search for — no call, no cost
    const owner = await mineSet();

    const query =
      `from:me (${addresses.map((a) => `to:${a}`).join(" OR ")}) after:${gmailAfterDate(since)}`;
    const threadIds = await gmail.searchThreadIds(query, SENT_SEARCH_CEILING);
    if (threadIds.length === 0) return null;

    const threads = await mapWithConcurrency(threadIds, SENT_THREAD_CONCURRENCY, (id) => gmail.readThread(id));

    // `from:me` narrows the THREAD, never the message: a matched thread carries their replies
    // too. Both conditions are re-checked here — the sender must actually be him, and the
    // moment must actually be after theirs (Gmail's `after:` only resolves to a day).
    let latest: number | null = null;
    for (const msgs of threads) {
      for (const m of msgs) {
        if (!owner.has(addressOf(m.from))) continue;
        const at = Date.parse(m.sentAt);
        if (!Number.isFinite(at) || at <= since.getTime()) continue;
        if (latest === null || at > latest) latest = at;
      }
    }
    return latest === null ? null : new Date(latest);
  };
}

export interface CalendarLookupDeps {
  /** Every Google account enrolled for him — the same list the briefs' calendar fan-out uses. */
  accounts(): Promise<string[]>;
  /** A calendar client for one account. Throwing `GoogleConfigError`/`GoogleUnenrolledError`
   *  means "not wired on this host" and skips that account. */
  clientFor(account: string): Promise<{
    listEvents(opts: { timeMin: string; timeMax: string; max: number }): Promise<CalendarEvent[]>;
  }>;
}

/**
 * "Did a meeting with any of these addresses END between `since` and `now`?" — the calendar leg
 * of `resolveElsewhere`. A meeting he actually sat through answers a question far better than
 * an email does, which is why it is worth a lookup of its own.
 *
 * The account's DEFAULT calendar only — no `calendarId` fan-out across every subscribed
 * calendar the briefs walk. A meeting with this person is on the calendar he keeps; the extra
 * round-trips (one `listCalendars` plus one `listEvents` per calendar, per account, per
 * obligation) would cost far more than the marginal hit is worth, and a miss here is the safe
 * direction anyway.
 *
 * THREE conditions, each learned: the attendee must actually be them (case-folded on both
 * sides — Google echoes whatever case the inviter typed); the event must carry an `end`; and
 * that end must be in the PAST. An all-day entry is excluded outright — its "end" is the
 * exclusive next midnight, a date boundary rather than a moment two people stopped talking, and
 * an out-of-office block spanning a week would otherwise resolve every obligation he has.
 */
export function makeCalendarEndedWith(deps: CalendarLookupDeps): ResolutionDeps["calendarEndedWith"] {
  return async (addresses: string[], since: Date, now: Date) => {
    if (addresses.length === 0) return null;   // nobody to look for — no call, no cost
    const theirs = new Set(addresses.map((a) => a.toLowerCase()));

    let best: { at: Date; summary: string } | null = null;
    for (const account of await deps.accounts()) {
      let client: Awaited<ReturnType<CalendarLookupDeps["clientFor"]>>;
      try {
        client = await deps.clientFor(account);
      } catch (err) {
        // Rule 2 of lib/calendar-fanout.ts: an org whose client secrets are not mounted on this
        // host is a deterministic absence, not a failure a retry fixes. Every OTHER error
        // propagates, so the caller can mark the calendar unreadable instead of reading silence
        // as "they never met".
        if (err instanceof GoogleConfigError || err instanceof GoogleUnenrolledError) {
          console.warn(`obligation-lookups: skipping ${account}'s calendar — not wired on this host`);
          continue;
        }
        throw err;
      }

      const events = await client.listEvents({
        timeMin: since.toISOString(),
        timeMax: now.toISOString(),
        max: CALENDAR_LOOKUP_MAX_EVENTS,
      });
      for (const e of events) {
        if (e.allDay === true || !e.end) continue;
        const end = new Date(e.end);
        if (!Number.isFinite(end.getTime())) continue;
        // The window is re-checked HERE, on both sides, rather than trusted to the API's
        // `timeMin`/`timeMax`. A meeting that ended BEFORE their message cannot be an answer to
        // it, and leaning on Google's window semantics to exclude it made this leg's correctness
        // depend on an undocumented behaviour that a fixture can only ever re-confirm. Same
        // reasoning as the Gmail leg re-comparing `sentAt` against `since` rather than trusting
        // the date-granular `after:`.
        if (end.getTime() <= since.getTime()) continue;
        // Still in progress is not a meeting that happened.
        if (end.getTime() >= now.getTime()) continue;
        if (!(e.attendees ?? []).some((a) => theirs.has(a.email.toLowerCase()))) continue;
        if (!best || end.getTime() > best.at.getTime()) {
          best = { at: end, summary: e.summary || "(untitled)" };
        }
      }
    }
    return best;
  };
}
