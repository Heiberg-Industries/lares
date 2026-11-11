/** Manual opt-in live probe: does Google Calendar really refuse a change or a delete of an event that
 * has changed since it was read? `lib/google.ts` reads one event with its revision (`getEvent`) and can
 * hand that revision back on `updateEvent` / `deleteEvent`, which then send it as an `If-Match` header
 * and treat Google's HTTP 412 as "changed since it was read". The unit tests prove what this code SENDS.
 * Only this probe shows what Google ANSWERS, and that the header survives the real sign-in and HTTP
 * layers on the way out.
 *
 * It goes through the service's own calendar client (`wrapCalendarApi`), so what is probed is the code
 * that ships. Only the event's creation and the last-resort cleanup use the Google client directly.
 *
 * Run from services/chief-of-staff:  pnpm exec tsx tests/live/calendar-event-precondition.live.mts
 * Inputs (environment):
 *   RUN_CALENDAR_EVENT_PRECONDITION_LIVE=1   manual opt-in
 *   GOOGLE_LIVE_CLIENT_ID, GOOGLE_LIVE_CLIENT_SECRET   the OAuth client the account was connected with
 *   GOOGLE_LIVE_REFRESH_TOKEN                a refresh token that may write calendar events
 *                                            (the same one tests/live/agent-mailbox-calendar.live.mts takes;
 *                                            the probe never stores or prints it)
 *   GOOGLE_LIVE_CALENDAR_ID                  the id of a DEDICATED test calendar in that account.
 *                                            "primary" is refused: this probe writes and deletes.
 *
 * It writes ONE event on that calendar, 30 days ahead, private, shown as free, with no attendees, no
 * reminders and sendUpdates "none" on every write, so nobody is invited or notified. It removes the
 * event again, also when a step fails in between.
 *
 * One line is printed per step, then a summary. A line carries the step's name, the HTTP status Google
 * really answered (`httpStatus`), whether the request carried `If-Match` (`ifMatchSent`), what the
 * client made of the answer (`outcome`) and whether that is what the design expects (`asExpected`).
 * Never an id, an address, a title or a revision value.
 *   create                    events.insert, no If-Match                       expect 200
 *   read                      getEvent finds it, with a revision               expect 200
 *   patch-current-revision    updateEvent with the revision just read          expect 200 and a NEW revision
 *   read-after-patch          a read reports the same revision the write did   expect 200
 *   patch-stale-revision      updateEvent with the OLD revision                expect 412 -> changed-since-read
 *   read-after-stale-patch    the refused write changed nothing                expect 200, revision unchanged
 *   delete-stale-revision     deleteEvent with the OLD revision                expect 412 -> changed-since-read
 *   read-after-stale-delete   the refused delete deleted nothing               expect 200, still there
 *   delete-current-revision   deleteEvent with the current revision            expect 204
 *   read-after-delete         getEvent says cancelled or not found             expect 200 (cancelled), 404 or 410
 * The process exits non-zero if any step was not as expected. Report the printed lines as they are.
 */
import { google } from 'googleapis';

import { CalendarEventChangedError, wrapCalendarApi } from '../../lib/google.js';

if (process.env.RUN_CALENDAR_EVENT_PRECONDITION_LIVE !== '1') throw new Error('Manual opt-in required');
const { GOOGLE_LIVE_CLIENT_ID: id, GOOGLE_LIVE_CLIENT_SECRET: secret, GOOGLE_LIVE_REFRESH_TOKEN: refresh,
  GOOGLE_LIVE_CALENDAR_ID: calendarId } = process.env;
if (!id || !secret || !refresh) throw new Error('Set GOOGLE_LIVE_CLIENT_ID, GOOGLE_LIVE_CLIENT_SECRET and GOOGLE_LIVE_REFRESH_TOKEN');
if (!calendarId || calendarId === 'primary') throw new Error('Set GOOGLE_LIVE_CALENDAR_ID to a dedicated test calendar, not "primary"');

/** What the last Calendar request looked like on the wire. Filled by the two interceptors below, which
 *  only observe: they sit where the service's own deadline interceptor sits and change nothing. */
let seen: { httpStatus: number | null; ifMatchSent: boolean } = { httpStatus: null, ifMatchSent: false };
const isCalendarCall = (url: unknown): boolean => String(url ?? '').includes('/calendar/v3/');

let allAsExpected = true;
function report(step: string, outcome: string, asExpected: boolean): void {
  if (!asExpected) allAsExpected = false;
  console.log(JSON.stringify({ step, httpStatus: seen.httpStatus, ifMatchSent: seen.ifMatchSent, outcome, asExpected }));
}

/** One call, observed. A refusal for a stale revision is told apart from every other failure. */
async function attempt<T>(call: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; changed: boolean }> {
  seen = { httpStatus: null, ifMatchSent: false };
  try { return { ok: true, value: await call() }; }
  catch (err) { return { ok: false, changed: err instanceof CalendarEventChangedError }; }
}

/** A step did not produce what the next step needs; stop and clean up. */
class Halt extends Error {}

let eventId: string | undefined;
let removed = false;
let events: ReturnType<typeof google.calendar>['events'] | undefined;
try {
  const auth = new google.auth.OAuth2(id, secret);
  auth.setCredentials({ refresh_token: refresh });
  await auth.refreshAccessToken();
  auth.transporter.interceptors.request.add({
    resolved: async options => {
      if (isCalendarCall(options.url)) seen.ifMatchSent = new Headers(options.headers).has('if-match');
      return options;
    },
  });
  auth.transporter.interceptors.response.add({
    resolved: async response => {
      if (isCalendarCall(response.config?.url)) seen.httpStatus = response.status;
      return response;
    },
    rejected: async (err: { response?: { status?: number }; config?: { url?: unknown } }) => {
      if (isCalendarCall(err?.config?.url)) seen.httpStatus = err?.response?.status ?? null;
      throw err;
    },
  });
  const api = google.calendar({ version: 'v3', auth });
  events = api.events;
  const client = wrapCalendarApi(api);

  // 1. One private event nobody is invited to and nobody is told about.
  const start = new Date(Date.now() + 30 * 86_400_000);
  const end = new Date(start.getTime() + 30 * 60_000);
  const summary = 'Assistant probe event';
  const created = await attempt(() => events!.insert({ calendarId, sendUpdates: 'none',
    requestBody: { summary, visibility: 'private', transparency: 'transparent', reminders: { useDefault: false, overrides: [] },
      start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } } }));
  eventId = created.ok ? created.value.data.id ?? undefined : undefined;
  report('create', eventId ? 'created' : 'failed', !!eventId);
  if (!eventId) throw new Halt();
  const target = eventId;

  /** Read the event and return its revision, or '' when it is not there as a live event. */
  const readRevision = async (step: string, expected: (etag: string) => boolean, expectation: string): Promise<string> => {
    const read = await attempt(() => client.getEvent(calendarId, target));
    const found = read.ok && read.value.outcome === 'found' ? read.value.event : undefined;
    const etag = found?.revision.etag ?? '';
    const good = !!found && found.id === target && found.attendees === undefined && etag !== '' && expected(etag);
    report(step, !read.ok ? 'failed' : found ? (good ? expectation : `found, but not: ${expectation}`) : read.value.outcome, good);
    return etag;
  };

  // 2. Read it: the revision to bind to.
  const firstRevision = await readRevision('read', () => true, 'found with a revision');
  if (!firstRevision) throw new Halt();

  // 3. Change it with the revision just read: accepted, and Google's answer carries a new revision.
  const patched = await attempt(() => client.updateEvent({ eventId: target, calendarId, notify: false,
    summary: `${summary} (changed)`, expectedRevision: firstRevision }));
  const secondRevision = patched.ok ? patched.value.revision?.etag ?? '' : '';
  const gotNewRevision = secondRevision !== '' && secondRevision !== firstRevision;
  report('patch-current-revision', !patched.ok ? (patched.changed ? 'changed-since-read' : 'failed')
    : gotNewRevision ? 'updated, new revision returned' : 'updated, but no new revision returned', gotNewRevision);
  if (!gotNewRevision) throw new Halt();

  // 4. The revision the write returned is the one a fresh read reports.
  await readRevision('read-after-patch', etag => etag === secondRevision, 'the revision the write returned');

  // 5. Change it again with the OLD revision: Google must refuse.
  const stalePatch = await attempt(() => client.updateEvent({ eventId: target, calendarId, notify: false,
    summary: `${summary} (must not be written)`, expectedRevision: firstRevision }));
  report('patch-stale-revision', stalePatch.ok ? 'WRITTEN despite a stale revision' : stalePatch.changed ? 'changed-since-read' : 'failed',
    !stalePatch.ok && stalePatch.changed && seen.httpStatus === 412);

  // 6. The refused write changed nothing.
  await readRevision('read-after-stale-patch', etag => etag === secondRevision, 'revision unchanged');

  // 7. Delete with the OLD revision: Google must refuse.
  const staleDelete = await attempt(() => client.deleteEvent({ eventId: target, calendarId, notify: false, expectedRevision: firstRevision }));
  if (staleDelete.ok) removed = true;
  report('delete-stale-revision', staleDelete.ok ? 'DELETED despite a stale revision' : staleDelete.changed ? 'changed-since-read' : 'failed',
    !staleDelete.ok && staleDelete.changed && seen.httpStatus === 412);
  if (staleDelete.ok) throw new Halt();

  // 8. The refused delete deleted nothing.
  await readRevision('read-after-stale-delete', etag => etag === secondRevision, 'still there, revision unchanged');

  // 9. Delete with the current revision: accepted.
  const deleted = await attempt(() => client.deleteEvent({ eventId: target, calendarId, notify: false, expectedRevision: secondRevision }));
  if (deleted.ok) removed = true;
  report('delete-current-revision', deleted.ok ? 'deleted' : deleted.changed ? 'changed-since-read' : 'failed', deleted.ok);

  // 10. A read now says the event is gone, one way or the other. Which way is printed.
  const after = await attempt(() => client.getEvent(calendarId, target));
  const gone = after.ok && (after.value.outcome === 'not_found' || after.value.outcome === 'cancelled');
  report('read-after-delete', after.ok ? after.value.outcome : 'failed', deleted.ok && gone);
} catch (err) {
  allAsExpected = false;
  if (!(err instanceof Halt)) console.error('Live calendar precondition probe failed. Inspect locally without sharing raw responses.');
} finally {
  // Last resort, unconditional: whatever happened above, the event does not stay behind.
  if (eventId && !removed && events) {
    const target = eventId;
    const cleaned = await attempt(() => events!.delete({ calendarId, eventId: target, sendUpdates: 'none' }));
    report('cleanup', cleaned.ok ? 'removed' : 'NOT removed: delete the probe event by hand', cleaned.ok);
  }
  console.log(JSON.stringify({ allAsExpected }));
  if (!allAsExpected) process.exitCode = 1;
}
