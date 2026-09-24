/**
 * tests/live/calendar-conflicts.live.mts — the LIVE sweep for the four Google Calendar wire
 * fields the conflict radar branches on (`lib/calendar-conflicts.ts`, ORB-139):
 *
 *   1. `status` — `confirmed` | `tentative` | `cancelled` (a cancelled row is not a commitment)
 *   2. `transparency` — `transparent` means free; ABSENT means busy (the API's default)
 *   3. the owner's own `responseStatus` — read off the `attendees[]` entry Google marks
 *      `self: true`; absent whenever there is no attendee list at all (his own blocks, and
 *      copied invitations that arrive bare — ORB-118), which the radar reads as "his own event"
 *   4. `iCalUID` — the same commitment copied onto a second calendar keeps it, so the radar
 *      de-duplicates on it before it looks for clashes (plus `start.timeZone`, which the
 *      timezone-trap class needs to compare against where he is that day)
 *
 * Per the root CLAUDE.md's Third-party APIs rule: "a fixture is what we believe an API does;
 * only a live call is what it does." `tests/calendar-conflicts.test.ts` is built on SHAPED
 * fixtures (the field names come from `googleapis`' `calendar/v3.d.ts`, not from a recorded
 * response) — this file is what actually asks Google how often each field is present, and
 * with which values, across the next fourteen days of every enrolled account. It answers the
 * two assumptions the ORB-139 review named as unverified: how often `self: true` is present on
 * his events, and whether the bookings Gmail files onto the calendar carry
 * `transparency: "transparent"` (the radar treats a transparent row as free — a booking that
 * arrives transparent would be INVISIBLE to the overlapping-stay class).
 *
 * NOT part of `pnpm test` — it needs a live Calendar OAuth session, which only exists inside
 * the deployed eve-saga container. Run it there, by hand, whenever `lib/calendar-conflicts.ts`
 * changes what it assumes about these fields, exactly as `tests/live/google.live.mts`'s header
 * says (the read-only rootfs and the `/proc/1/environ` env read are the same two traps):
 *
 *   cat services/chief-of-staff/tests/live/calendar-conflicts.live.mts | \
 *     ssh root@192.0.2.20 'docker exec -i agent-box-eve-saga-1 sh -c \
 *       "cat > /app/services/chief-of-staff/node_modules/.cache/calendar-conflicts.live.mts"'
 *   ssh root@192.0.2.20 'docker exec agent-box-eve-saga-1 sh -c \
 *     "cd /app/services/chief-of-staff && \
 *      export \$(tr \"\\0\" \"\\n\" < /proc/1/environ | grep -E \"^(DATABASE_URL|PGPASSWORD|TOKEN_ENC_KEY_FILE|GOOGLE_|GMAIL_PRIMARY_EMAIL|CALENDAR_PRIMARY_EMAIL|EGRESS_PROXY_URL)\" | xargs) && \
 *      /app/node_modules/.bin/tsx node_modules/.cache/calendar-conflicts.live.mts"'
 *   ssh root@192.0.2.20 'docker exec agent-box-eve-saga-1 rm -f /app/services/chief-of-staff/node_modules/.cache/calendar-conflicts.live.mts'
 *
 * COUNTS AND VALUES ONLY, always: this file never prints an event's summary, a location, an
 * attendee address or an id — only how many events carried which value. Read-only against
 * Google (`listEvents` only). It requires the image that carries ORB-139, because the four
 * fields are read through `lib/google.ts`'s `listEvents` as that change shaped them.
 */
import { googleClients, listEnrolledMailboxes } from "../../lib/google.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 14;
/** The lodging vocabulary the radar's overlapping-stay class keys on — mirrored from
 *  `lib/calendar-conflicts.ts`'s STAY_TITLE so this sweep measures the same rows it would. */
const STAY_TITLE = /\b(stay at|hotel|hotell|motel|motell|hostel|resort|airbnb|lodging|overnatting|opphold|guest ?house|pensjonat|b ?& ?b|bed and breakfast|apartment|leilighet|check[-\s]?in|innsjekk)\b/iu;

let failed = false;
function report(ok: boolean, label: string): void {
  console.log(`  [${ok ? "ok" : "FAIL"}] ${label}`);
  if (!ok) failed = true;
}
function blocked(label: string): void {
  console.log(`  [BLOCKED] ${label}`);
  failed = true;
}
function histogram(values: (string | undefined)[]): string {
  const h = new Map<string, number>();
  for (const v of values) h.set(v ?? "(absent)", (h.get(v ?? "(absent)") ?? 0) + 1);
  return [...h.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(", ");
}

async function main(): Promise<void> {
  console.log(`calendar-conflicts live sweep — next ${WINDOW_DAYS} days, every enrolled account, counts only`);
  let accounts: string[];
  try {
    accounts = await listEnrolledMailboxes();
  } catch (err) {
    blocked(`listEnrolledMailboxes threw: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (accounts.length === 0) {
    blocked("no enrolled accounts — nothing to sweep");
    return;
  }
  const now = new Date();
  const timeMax = new Date(now.getTime() + WINDOW_DAYS * DAY_MS);
  let total = 0;
  const status: (string | undefined)[] = [];
  const transparency: (string | undefined)[] = [];
  const myResponse: (string | undefined)[] = [];
  let withAttendees = 0;
  let withAttendeesAndMyResponse = 0;
  let iCalPresent = 0;
  let tzPresent = 0;
  let allDay = 0;
  const stayTransparency: (string | undefined)[] = [];
  const stayAllDay: boolean[] = [];

  for (const account of accounts) {
    let events: Awaited<ReturnType<Awaited<ReturnType<ReturnType<typeof googleClients>["calendar"]>>["listEvents"]>>;
    try {
      const calendar = await googleClients().calendar(account);
      events = await calendar.listEvents({ timeMin: now.toISOString(), timeMax: timeMax.toISOString(), max: 250 });
    } catch (err) {
      blocked(`${accounts.indexOf(account) + 1}/${accounts.length}: listEvents threw: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    console.log(`  account ${accounts.indexOf(account) + 1}/${accounts.length}: ${events.length} events in the window`);
    for (const e of events as Array<Record<string, unknown>>) {
      total += 1;
      status.push(typeof e["status"] === "string" ? (e["status"] as string) : undefined);
      transparency.push(typeof e["transparency"] === "string" ? (e["transparency"] as string) : undefined);
      const mr = typeof e["myResponse"] === "string" ? (e["myResponse"] as string) : undefined;
      myResponse.push(mr);
      const attendees = Array.isArray(e["attendees"]) ? (e["attendees"] as unknown[]) : [];
      if (attendees.length > 0) {
        withAttendees += 1;
        if (mr !== undefined) withAttendeesAndMyResponse += 1;
      }
      if (typeof e["iCalUID"] === "string" && (e["iCalUID"] as string).length > 0) iCalPresent += 1;
      if (typeof e["startTimeZone"] === "string") tzPresent += 1;
      if (e["allDay"] === true) allDay += 1;
      if (typeof e["summary"] === "string" && STAY_TITLE.test(e["summary"] as string)) {
        stayTransparency.push(typeof e["transparency"] === "string" ? (e["transparency"] as string) : undefined);
        stayAllDay.push(e["allDay"] === true);
      }
    }
  }

  console.log(`  total=${total} allDay=${allDay}`);
  console.log(`  status: ${histogram(status)}`);
  console.log(`  transparency: ${histogram(transparency)}`);
  console.log(`  myResponse: ${histogram(myResponse)} (events with an attendee list: ${withAttendees}, of which carrying the owner's own response: ${withAttendeesAndMyResponse})`);
  console.log(`  iCalUID present: ${iCalPresent}/${total}; start.timeZone present: ${tzPresent}/${total}`);
  console.log(`  stay-titled rows: ${stayTransparency.length} — transparency: ${histogram(stayTransparency)}; all-day: ${stayAllDay.filter(Boolean).length}/${stayAllDay.length}`);

  if (total === 0) {
    blocked("zero events in the window — nothing measured; widen WINDOW_DAYS and re-run");
    return;
  }
  // The assumptions the radar rests on, each stated as what would break it:
  report(status.every((s) => s === undefined || ["confirmed", "tentative", "cancelled"].includes(s)),
    "status carries only confirmed|tentative|cancelled (an unlisted value reads as committed — noisier, never blinder)");
  report(transparency.every((t) => t === undefined || ["opaque", "transparent"].includes(t)),
    "transparency carries only opaque|transparent|absent");
  report(myResponse.every((r) => r === undefined || ["needsAction", "declined", "tentative", "accepted"].includes(r)),
    "the owner's responseStatus carries only needsAction|declined|tentative|accepted|absent");
  report(withAttendees === 0 || withAttendeesAndMyResponse > 0,
    `self: true is present on at least one attendee-carrying event (${withAttendeesAndMyResponse}/${withAttendees}) — the declined/tentative guards depend on it`);
  report(iCalPresent === total,
    "every event carries an iCalUID (the de-duplication key across two calendars)");
  report(stayTransparency.length === 0 || stayTransparency.every((t) => t !== "transparent"),
    "no stay-titled row is transparent — a transparent booking would be invisible to the overlapping-stay class");

  console.log(failed ? "RESULT: at least one assumption did not hold — read the lines above" : "RESULT: every assumption held on live data");
}

await main();
if (failed) process.exitCode = 1;
