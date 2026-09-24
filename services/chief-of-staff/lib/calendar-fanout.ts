/**
 * lib/calendar-fanout.ts — every calendar he actually looks at, as ONE event list (ORB-118).
 *
 * WHY THIS EXISTS, in incident terms: the 2026-08-17 evening brief said "nothing to say" while
 * Tuesday held a three-hour Folkepuls meeting at Folio. Two independent holes fed that silence.
 * The narrow attendee rule is fixed in `lib/brief-content.ts`; THIS file fixes the other one —
 * the brief read `calendarId: "primary"` on ONE account, so anything living on a second
 * calendar (his shared Vol de Nuit calendar) or a second Google account (owner@project.example) was
 * never fetched at all.
 *
 * Three rules, each learned the hard way:
 *
 *  1. **A truncated read throws.** Same reasoning as `listTomorrowMeetings`: a short list reads
 *     as "a quiet day", a claim a cut-off read has not earned. Checked PER CALENDAR, because
 *     that is the request whose ceiling was actually hit.
 *
 *  2. **A missing OAuth client for an org is a SKIP, not a failure.** `orgConfig()` throws
 *     `GoogleConfigError` when an org's client secrets are not mounted on this host — which is
 *     exactly the state of zero7 on the agent box today (the 2026-08-16 "primary-token lottery"
 *     incident: the token row exists, the client does not). That is a deterministic, host-level
 *     absence, not a data gap a retry could fix, and it must not silence the whole brief. It is
 *     logged loudly and skipped; the day zero7's client IS mounted, its calendars join with no
 *     code change. Every OTHER failure (network, API, auth) throws — a read that broke is not a
 *     day that was empty.
 *
 *  3. **Nothing read at all still throws.** If no account yielded a client, the brief must not
 *     render "no meetings" off zero sources.
 *
 * Calendar SELECTION: `listCalendars()` already keeps only calendars he owns or can write,
 * which drops subscribed noise (holiday feeds, TrainerRoad's daily workout banners). The deny
 * list here is the second line of defence for owned-but-noisy calendars — Birthdays, Tasks —
 * because those are all-day events, and all-day events now COUNT (ORB-118). Override with
 * `BRIEF_CALENDAR_DENY` (comma-separated, case-insensitive substrings); set it empty to keep
 * everything.
 */
import { GoogleConfigError } from "@lares/agent-kit/google-auth";

import { GoogleUnenrolledError, type CalendarEvent, type CalendarSummary } from "./google.js";

/** Substring matches against a calendar's display name. All-day feeds he never "attends". */
const DEFAULT_CALENDAR_DENY = [
  "birthday", "bursdag",
  "helligdag", "holiday",
  "tasks", "oppgaver",
  "trainerroad",
  "week number", "ukenummer",
];

export function calendarDenyPatterns(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env["BRIEF_CALENDAR_DENY"];
  if (raw === undefined) return DEFAULT_CALENDAR_DENY;
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s !== "");
}

/** Calendars whose events belong in a brief. Primary is always kept: a deny pattern that
 *  happens to match his own name must never blind the brief to his main calendar. */
export function selectBriefCalendars(
  calendars: readonly CalendarSummary[], deny: readonly string[] = calendarDenyPatterns(),
): CalendarSummary[] {
  return calendars.filter((c) => {
    if (c.primary) return true;
    const name = (c.summary || "").toLowerCase();
    return !deny.some((d) => name.includes(d));
  });
}

export interface FanoutCalendarClient {
  listCalendars(opts?: { includeReadOnly?: boolean }): Promise<CalendarSummary[]>;
  listEvents(opts: { timeMin: string; timeMax: string; max: number; calendarId?: string }): Promise<CalendarEvent[]>;
}

export interface CalendarFanoutDeps {
  /** Every Google account enrolled for him — the same token rows Gmail fans out over. */
  accounts(): Promise<string[]>;
  /** A calendar client for one account. Throwing `GoogleConfigError`/`GoogleUnenrolledError`
   *  means "not wired on this host" and skips that account (rule 2). */
  clientFor(account: string): Promise<FanoutCalendarClient>;
}

export interface FanoutWindow { timeMin: string; timeMax: string; max: number }

/** Two calendars can carry the SAME event (an invitation accepted on one, copied to another —
 *  Folkepuls itself is a copy). Google gives a copy its own id, so identity alone is not
 *  enough: the second key is what a human would call the same commitment. */
function dedupeKey(e: CalendarEvent): string {
  return `${(e.summary || "").trim().toLowerCase()}|${e.start}|${e.end}`;
}

/**
 * Every event in `window`, across every calendar of every wired account.
 *
 * THROWS on a read failure, on a truncated per-calendar read, and when no account could be
 * reached at all — never returns a short list for any of those.
 */
export async function listEventsEverywhere(
  deps: CalendarFanoutDeps, window: FanoutWindow,
): Promise<CalendarEvent[]> {
  const accounts = await deps.accounts();
  const byId = new Map<string, CalendarEvent>();
  const seen = new Set<string>();
  let reached = 0;

  for (const account of accounts) {
    let client: FanoutCalendarClient;
    try {
      client = await deps.clientFor(account);
    } catch (e) {
      if (e instanceof GoogleConfigError || e instanceof GoogleUnenrolledError) {
        console.warn(`calendar-fanout: skipping ${account} — not wired on this host (${e.message})`);
        continue;
      }
      throw e;
    }
    reached++;

    // `includeReadOnly` on purpose: his Vol de Nuit calendar is SUBSCRIBED (accessRole
    // "reader"), and the default owner/writer filter — written so a create-event tool only
    // offers writable calendars — would drop it. Reading someone else's calendar he follows is
    // exactly what a night-before brief needs; the deny list keeps the read-only NOISE
    // (holiday feeds, TrainerRoad) out by name.
    for (const cal of selectBriefCalendars(await client.listCalendars({ includeReadOnly: true }))) {
      const events = await client.listEvents({ ...window, calendarId: cal.id });
      if (events.length >= window.max) {
        throw new Error(
          `calendar ${cal.summary || cal.id} (${account}) returned its ceiling of ${window.max} events — ` +
          "the rest were cut off, so tomorrow's calendar cannot be trusted",
        );
      }
      for (const e of events) {
        if (e.id && byId.has(e.id)) continue;
        const key = dedupeKey(e);
        if (seen.has(key)) continue;
        seen.add(key);
        // LAR-59-s1: stamp which account and calendar this copy came from, so a later delete
        // can target the right one. The dedupe keys above are unchanged — the first-seen copy
        // still wins; only the fields tacked onto that surviving copy are new.
        const stamped: CalendarEvent = { ...e, account, calendarId: cal.id };
        if (e.id) byId.set(e.id, stamped);
        else byId.set(`${key}#${byId.size}`, stamped);
      }
    }
  }

  if (reached === 0) {
    throw new Error(
      `no calendar could be read: ${accounts.length} enrolled account(s), none wired on this host — ` +
      "an empty result would read as 'nothing on tomorrow'",
    );
  }
  return [...byId.values()];
}
