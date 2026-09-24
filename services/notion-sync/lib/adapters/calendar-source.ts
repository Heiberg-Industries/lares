// Wraps the calendar resolver (lib/adapters/calendar-oauth.ts, rehomed from the runtime in
// ORB-178). Under adapters/ because it reaches the googleapis-backed client and the
// oauth_tokens table.
import {
  makeCalendarResolver,
  type CalendarOrgConfig,
} from "./calendar-oauth.js";
import type { Queryable } from "@lares/agent-box";
import type { CalAttendee, CalEvent } from "../attendees.js";

export type { CalendarOrgConfig };

export interface CalendarSourceOptions {
  db: Queryable;
  keyHex: string;
  orgs: CalendarOrgConfig[];
  principal: string;
}

/** The slice of CalendarApiClient this module needs — kept structural so tests
 *  can stub a mailbox without pulling in the googleapis-backed `CalendarReadClient`
 *  from ./calendar-oauth.ts. */
export interface EventSourceClient {
  listEvents(params: { timeMin: string; timeMax: string; maxResults: number }): Promise<{
    items: Array<{
      id: string;
      summary: string;
      start: string;
      attendees?: CalAttendee[];
      recurringEventId?: string;
    }>;
  }>;
}

const MAX_RESULTS = 250;
const SLICE_DAYS = 30;
const SLICE_MS = SLICE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Splits [timeMin, timeMax) into slices no wider than SLICE_DAYS. The default sync
 * window is ~400 days back; asking Google for all of it in one call risks landing on
 * the (unpaginated) 250-result cap and silently dropping events — see fetchMailboxEvents.
 */
export function sliceWindow(
  window: { timeMin: string; timeMax: string },
  sliceMs: number = SLICE_MS,
): Array<{ timeMin: string; timeMax: string }> {
  const start = Date.parse(window.timeMin);
  const end = Date.parse(window.timeMax);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];

  const slices: Array<{ timeMin: string; timeMax: string }> = [];
  for (let sliceStart = start; sliceStart < end; sliceStart += sliceMs) {
    const sliceEnd = Math.min(sliceStart + sliceMs, end);
    slices.push({
      timeMin: new Date(sliceStart).toISOString(),
      timeMax: new Date(sliceEnd).toISOString(),
    });
  }
  return slices;
}

/**
 * Fetches one mailbox's events across the whole window in <=SLICE_DAYS slices.
 * CalendarApiClient exposes no pageToken, so a slice that still comes back at
 * MAX_RESULTS cannot be trusted as complete — that is a truncated read, not a busy
 * calendar, and we must not silently proceed on a partial set (spec: per-document
 * correctness depends on seeing every real candidate event).
 */
export async function fetchMailboxEvents(
  client: EventSourceClient,
  window: { timeMin: string; timeMax: string },
): Promise<CalEvent[]> {
  const events: CalEvent[] = [];
  for (const slice of sliceWindow(window)) {
    const res = await client.listEvents({ ...slice, maxResults: MAX_RESULTS });
    if (res.items.length >= MAX_RESULTS) {
      throw new Error(
        `calendar-source: slice ${slice.timeMin}..${slice.timeMax} returned ` +
        `${res.items.length} events (the ${MAX_RESULTS}-result cap) and cannot be paginated ` +
        `further — refusing to proceed on a truncated read; narrow the sync window or the slice size`,
      );
    }
    for (const item of res.items) {
      events.push({
        id: item.id,
        summary: item.summary,
        start: item.start,
        ...(item.attendees ? { attendees: item.attendees } : {}),
        ...(item.recurringEventId ? { recurringEventId: item.recurringEventId } : {}),
      });
    }
  }
  return events;
}

/**
 * Lists events across every enrolled mailbox for the principal and de-duplicates
 * by event id — the same meeting appears once per mailbox that was invited.
 *
 * Also exposes those mailboxes' own addresses via `ownerEmails()`: every one of them
 * is the operator, so all of them must sort last in the formatted attendee string.
 */
export function makeCalendarSource(opts: CalendarSourceOptions) {
  const resolver = makeCalendarResolver({
    db: opts.db, keyHex: opts.keyHex, orgs: opts.orgs,
  });

  // Resolved at most once per source: resolveAll decrypts a refresh token and builds
  // an API client per mailbox, and both entry points below need the same set. Left
  // null on failure so a transient error is retried rather than cached forever.
  type Mailbox = Awaited<ReturnType<typeof resolver.resolveAll>>[number];
  let cached: Mailbox[] | null = null;

  async function mailboxes(): Promise<Mailbox[]> {
    if (cached !== null) return cached;
    const resolved = await resolver.resolveAll(opts.principal);
    if (resolved.length === 0) {
      throw new Error(
        `calendar-source: no enrolled calendar mailbox resolved for principal '${opts.principal}' — ` +
        `check that the OAuth grant exists and its org has a matching GOOGLE_CLIENT_ID_*/` +
        `GOOGLE_CLIENT_SECRET_* pair configured`,
      );
    }
    cached = resolved;
    return cached;
  }

  async function listEvents(
    window: { timeMin: string; timeMax: string },
  ): Promise<CalEvent[]> {
    const byId = new Map<string, CalEvent>();
    for (const mailbox of await mailboxes()) {
      const events = await fetchMailboxEvents(mailbox.client, window);
      for (const event of events) {
        if (!byId.has(event.id)) byId.set(event.id, event);
      }
    }
    return [...byId.values()];
  }

  async function ownerEmails(): Promise<string[]> {
    return (await mailboxes()).map((mailbox) => mailbox.emailAddress);
  }

  return { listEvents, ownerEmails };
}
