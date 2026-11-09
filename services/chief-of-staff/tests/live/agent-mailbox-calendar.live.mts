/** Manual opt-in live probe: can the "read + drafts" token add, change and remove a calendar event through
 * the same Google Calendar calls the calendar tools use? It touches one private event with no guests.
 * Run from services/chief-of-staff:  pnpm exec tsx tests/live/agent-mailbox-calendar.live.mts
 * Inputs (environment):
 *   RUN_AGENT_MAILBOX_CALENDAR_LIVE=1     manual opt-in
 *   GOOGLE_LIVE_CLIENT_ID, GOOGLE_LIVE_CLIENT_SECRET   the OAuth client the account was connected with
 *   GOOGLE_LIVE_REFRESH_TOKEN             a refresh token granted with the "read+mail-draft" power
 *                                         (normally run all three through agent-mailbox-all.live.mts,
 *                                         which signs in once and passes it in; the probe never stores it)
 * Writes one event on the primary calendar 30 days ahead, no attendees, sendUpdates "none", then removes it
 * (also when something fails in between). Only booleans are printed, never ids, addresses or titles:
 *   accessTokenIssued      the refresh token produced an access token
 *   scopeIncludesEvents    the token reports calendar.events (or calendar)
 *   eventInserted          events.insert returned an event
 *   eventReadBack          events.get returned the same summary
 *   eventUpdated           events.patch changed the summary
 *   eventDeleted           events.delete succeeded
 *   eventGone              a later events.get no longer returns a live event
 */
import { google } from 'googleapis';

if (process.env.RUN_AGENT_MAILBOX_CALENDAR_LIVE !== '1') throw new Error('Manual opt-in required');
const { GOOGLE_LIVE_CLIENT_ID: id, GOOGLE_LIVE_CLIENT_SECRET: secret, GOOGLE_LIVE_REFRESH_TOKEN: refresh } = process.env;
if (!id || !secret || !refresh) throw new Error('Set GOOGLE_LIVE_CLIENT_ID, GOOGLE_LIVE_CLIENT_SECRET and GOOGLE_LIVE_REFRESH_TOKEN');

const result = { accessTokenIssued: false, scopeIncludesEvents: false, eventInserted: false, eventReadBack: false,
  eventUpdated: false, eventDeleted: false, eventGone: false };
let eventId: string | undefined;
let events: ReturnType<typeof google.calendar>['events'] | undefined;
try {
  const auth = new google.auth.OAuth2(id, secret);
  auth.setCredentials({ refresh_token: refresh });
  const { credentials } = await auth.refreshAccessToken();
  result.accessTokenIssued = !!credentials.access_token;
  const info = await auth.getTokenInfo(credentials.access_token as string);
  result.scopeIncludesEvents = info.scopes.some(s => s === 'https://www.googleapis.com/auth/calendar.events' || s === 'https://www.googleapis.com/auth/calendar');
  events = google.calendar({ version: 'v3', auth }).events;
  const start = new Date(Date.now() + 30 * 86_400_000);
  const end = new Date(start.getTime() + 30 * 60_000);
  const summary = 'Assistant probe event';
  const created = (await events.insert({ calendarId: 'primary', sendUpdates: 'none',
    requestBody: { summary, visibility: 'private', start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } } })).data;
  eventId = created.id ?? undefined;
  result.eventInserted = !!eventId;
  if (eventId) {
    result.eventReadBack = (await events.get({ calendarId: 'primary', eventId })).data.summary === summary;
    const patched = (await events.patch({ calendarId: 'primary', eventId, sendUpdates: 'none', requestBody: { summary: `${summary} (changed)` } })).data;
    result.eventUpdated = patched.summary === `${summary} (changed)`;
    await events.delete({ calendarId: 'primary', eventId, sendUpdates: 'none' });
    result.eventDeleted = true;
    const after = await events.get({ calendarId: 'primary', eventId }).then(r => r.data.status, () => 'cancelled');
    result.eventGone = after === 'cancelled';
    eventId = undefined;
  }
} catch {
  console.error('Live calendar probe failed. Inspect locally without sharing raw responses.');
  process.exitCode = 1;
} finally {
  if (eventId && events) await events.delete({ calendarId: 'primary', eventId, sendUpdates: 'none' }).catch(() => undefined);
  console.log(JSON.stringify(result));
}
