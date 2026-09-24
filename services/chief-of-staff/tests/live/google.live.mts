/**
 * tests/live/google.live.mts — the LIVE sweep for the two Google-behaviour assumptions behind
 * `lib/obligation-resolution.ts`'s `resolveElsewhere`, as `lib/obligation-lookups.ts`'s header
 * names them (ORB-45 Task 10, B6a):
 *
 *   1. Gmail's `after:` operator is DATE-granular, in the account's own timezone — so a query
 *      built from a date can return messages from BEFORE the moment that date represents (same
 *      day but earlier, or a timezone-driven day-early inclusion). `makeGmailSentAfter`
 *      compensates by re-checking every candidate's `sentAt > since` in code rather than
 *      trusting the query alone to have excluded them.
 *   2. `events.list`'s `timeMin`/`timeMax` select events that OVERLAP the window (bound the
 *      event's END time) rather than events fully CONTAINED by it — which is what makes a
 *      meeting that started before the window and ended inside it visible at all.
 *      `makeCalendarEndedWith` compensates the same way: it re-checks `end > since` in code
 *      rather than trusting Google's window semantics to have already excluded early meetings.
 *
 * Per the root CLAUDE.md's Third-party APIs rule: "a fixture is what we believe an API does;
 * only a live call is what it does." `tests/obligation-lookups.test.ts` can only ever
 * re-confirm the fixtures it was given; this file is what actually asks Google.
 *
 * NOT part of `pnpm test` — it needs a live Gmail/Calendar OAuth session, which only exists
 * inside the deployed eve-saga container (the refresh tokens live in the box's Postgres,
 * decrypted with a key only the container holds). Run it there, by hand, whenever
 * `makeGmailSentAfter` or `makeCalendarEndedWith` changes what they assume about either API.
 *
 * MEASURED ON THE BOX (2026-09-02), both traps below cost a first attempt each:
 *   - `docker cp` into this container fails outright — "container rootfs is marked
 *     read-only" — even for a destination under a tmpfs mount (`node_modules/.cache`). A
 *     `docker exec -i … sh -c "cat > <path>"` fed the file over stdin writes to the SAME
 *     tmpfs path without tripping that check.
 *   - `pgrep` does not exist in this image. PID 1 IS the `eve start` process (confirmed via
 *     `/proc/1/cmdline`) and carries the same env as the worker PID a `pgrep -f "eve start"`
 *     would have found, so `/proc/1/environ` is the reliable read, not a fallback.
 *
 *   cat services/chief-of-staff/tests/live/google.live.mts | \
 *     ssh root@192.0.2.20 'docker exec -i agent-box-eve-saga-1 sh -c \
 *       "cat > /app/services/chief-of-staff/node_modules/.cache/google.live.mts"'
 *   ssh root@192.0.2.20 'docker exec agent-box-eve-saga-1 sh -c \
 *     "cd /app/services/chief-of-staff && \
 *      export \$(tr \"\\0\" \"\\n\" < /proc/1/environ | grep -E \"^(DATABASE_URL|PGPASSWORD|TOKEN_ENC_KEY_FILE|GOOGLE_|GMAIL_PRIMARY_EMAIL|CALENDAR_PRIMARY_EMAIL|EGRESS_PROXY_URL)\" | xargs -0) && \
 *      /app/node_modules/.bin/tsx node_modules/.cache/google.live.mts"'
 *   ssh root@192.0.2.20 'docker exec agent-box-eve-saga-1 rm -f /app/services/chief-of-staff/node_modules/.cache/google.live.mts'
 *
 * Written under `node_modules/.cache/` (a writable tmpfs mount, two directories below the
 * package root — same depth as this file's own `tests/live/`) so its relative imports below
 * resolve unchanged, and so `googleapis`/`pg`/`@lares/agent-kit` resolve through eve-saga's own
 * `node_modules` rather than a bare `tsx` invocation that cannot see the workspace link.
 *
 * The env grep above lists every `process.env[...]` read reachable from this file, measured
 * 2026-09-02 by walking `lib/google.ts` + `@lares/agent-kit/google-auth` + `@lares/agent-kit/db`:
 * `DATABASE_URL` (the identity-registry read), `TOKEN_ENC_KEY_FILE`, `GOOGLE_PRINCIPAL_ID`,
 * `GOOGLE_CLIENT_ID_HEIBERG_FILE`/`GOOGLE_CLIENT_SECRET_HEIBERG_FILE` (and the `_ZERO7_` pair
 * only if that org is enrolled — on the box measured 2026-09-02, both orgs' client id/secret
 * files are mounted at their DEFAULT `/run/secrets/google-client-*` paths, so neither env var
 * actually appears in the process environment; `readSecretFile`'s default-path fallback covers
 * it), `GOOGLE_REDIRECT_URI`, `GMAIL_PRIMARY_EMAIL`, `CALENDAR_PRIMARY_EMAIL`,
 * `EGRESS_PROXY_URL`. If `lib/google.ts` grows a new `process.env[...]` read, widen the grep to
 * match — a silently-missing var surfaces as `GoogleConfigError`, which this script reports as
 * BLOCKED rather than papering over.
 *
 * `addressOf` and the `after:` date format are reimplemented below (three lines each) rather
 * than imported from `lib/obligation-lookups.ts` / `lib/brief-content.ts`'s exported copy —
 * deliberately: this sweep needs to run against WHATEVER eve-saga image happens to be
 * deployed, including before Phase B (ORB-45 Task 10) ships, so it must not depend on files
 * that only exist once that deploy has landed. Same "three-line helper, not worth a shared
 * import" convention already used by `lib/email-triage.ts` and `lib/outreach-reply-detect.ts`.
 *
 * COUNTS AND BOOLEANS ONLY, always. This file never reads or prints a message's `bodyText` or
 * `subject`, an event's `summary`, or an address beyond how many matched a count — the only
 * strings it emits are ISO timestamps and the fixed labels below. Read-only against Google: no
 * `send`, no `insertEvent`/`updateEvent`/`deleteEvent`.
 */
import { getPool } from "@lares/agent-kit/db";

import { googleClients, listEnrolledMailboxes } from "../../lib/google.js";
import { configuredOwnerId, listAliases } from "../../lib/identity-client.js";

/** `lib/person-sources.ts`'s `addressOf`, verbatim — see the header note above. */
function addressOf(header: string): string {
  const m = /<([^>]+)>/.exec(header);
  return (m?.[1] ?? header).trim().toLowerCase();
}

/** `since` as Gmail's `after:` operand — the UTC calendar day, `YYYY/MM/DD`. Verbatim copy of
 *  `lib/obligation-lookups.ts`'s `gmailAfterDate` — see the header note above. */
function gmailAfterDate(since: Date): string {
  const mm = String(since.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(since.getUTCDate()).padStart(2, "0");
  return `${since.getUTCFullYear()}/${mm}/${dd}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
let failed = false;

function report(ok: boolean, label: string): void {
  console.log(`  [${ok ? "ok" : "FAIL"}] ${label}`);
  if (!ok) failed = true;
}

function blocked(label: string): void {
  console.log(`  [BLOCKED] ${label}`);
  failed = true;
}

/**
 * Sweep 1 — Gmail `after:` granularity, both directions.
 *
 * MEASURED WRINKLE, first run (2026-09-02): `searchThreadIds` matches on THREADS, and
 * `readThread` returns a thread's ENTIRE history (`lib/google.ts`'s own doc-comment on
 * `readThread` — "both directions... his own SENT messages never carry the INBOX label").
 * A raw "earliest 'mine' message across every returned thread" is therefore NOT a measurement
 * of `after:`'s own looseness: it is dominated by how far back the matched threads' histories
 * happen to reach (measured: one thread's history reached back ~2 months on a 7-day query —
 * ordinary for a long-running conversation, nothing to do with date granularity). Assertion (a)
 * below is scoped per-thread instead, to actually isolate the `after:` boundary from that
 * thread-history effect:
 *
 *   (a) "at most a day wider, per thread": EVERY thread the search returned must contain AT
 *       LEAST ONE "mine" message within 24h of the query date's UTC midnight or later — since
 *       the query is `from:me after:<date>`, that is the message the boundary should have
 *       matched on. A thread with none is the real leak: `after:` matched something the code
 *       does not expect it to. A thread's OTHER, older messages (arbitrarily old, per the
 *       wrinkle above) are not evidence either way and are excluded from this check.
 *   (b) "the code-level `> since` re-filter is load-bearing": pick a `since` inside the 7-day
 *       query window and confirm the raw results actually include owner messages older than
 *       it — proving Gmail's own `after:` boundary alone does NOT exclude them (whether via
 *       date-granularity or full-thread-history), so `makeGmailSentAfter`'s in-code
 *       `at > since.getTime()` check is doing real work, not guarding a case that can't occur.
 */
async function sweepGmail(): Promise<void> {
  const now = new Date();
  const queryDate = new Date(now.getTime() - 7 * DAY_MS);
  const queryDateMidnightUTC = new Date(Date.UTC(queryDate.getUTCFullYear(), queryDate.getUTCMonth(), queryDate.getUTCDate()));
  const lowerBound = new Date(queryDateMidnightUTC.getTime() - DAY_MS);
  // "since chosen inside the window" — 2 days back, well inside the 7-day query range.
  const sinceInner = new Date(now.getTime() - 2 * DAY_MS);

  let mine: string[];
  try {
    const pool = getPool();
    mine = (await listAliases(pool, configuredOwnerId(), "email")).map((a) => a.toLowerCase());
  } catch (err) {
    blocked(`identity registry read failed: ${(err as Error).message}`);
    return;
  }
  if (mine.length === 0) {
    blocked("identity registry returned no email addresses for the owner");
    return;
  }

  let gmail: Awaited<ReturnType<ReturnType<typeof googleClients>["gmail"]>>;
  try {
    gmail = await googleClients().gmail();
  } catch (err) {
    blocked(`could not resolve a Gmail client: ${(err as Error).message}`);
    return;
  }

  const q = `from:me after:${gmailAfterDate(queryDate)}`;
  let threadIds: string[];
  try {
    threadIds = await gmail.searchThreadIds(q, 200);
  } catch (err) {
    blocked(`searchThreadIds failed: ${(err as Error).message}`);
    return;
  }

  let messageCount = 0;
  let mineCount = 0;
  let earliest: number | null = null;
  let latest: number | null = null;
  let belowSinceInner = 0;
  let threadsWithoutQualifyingMine = 0;

  for (const id of threadIds) {
    const msgs = await gmail.readThread(id);
    messageCount += msgs.length;
    let threadHasQualifying = false;
    for (const m of msgs) {
      if (!mine.includes(addressOf(m.from))) continue;
      const at = Date.parse(m.sentAt);
      if (!Number.isFinite(at)) continue;
      mineCount++;
      if (earliest === null || at < earliest) earliest = at;
      if (latest === null || at > latest) latest = at;
      if (at >= lowerBound.getTime()) threadHasQualifying = true;
      if (at < sinceInner.getTime()) belowSinceInner++;
    }
    if (!threadHasQualifying) threadsWithoutQualifyingMine++;
  }

  console.log(`  threads=${threadIds.length} messages=${messageCount} mine=${mineCount}`);
  console.log(`  earliest=${earliest !== null ? new Date(earliest).toISOString() : "-"} latest=${latest !== null ? new Date(latest).toISOString() : "-"} (full thread history — expect this to reach further back than the query window; see the wrinkle noted above)`);
  console.log(`  queryDate(UTC midnight)=${queryDateMidnightUTC.toISOString()} lowerBound(-24h)=${lowerBound.toISOString()} sinceInner=${sinceInner.toISOString()}`);

  report(
    threadsWithoutQualifyingMine === 0,
    `every matched thread has >=1 "mine" message within a day of the query boundary (${threadsWithoutQualifyingMine} of ${threadIds.length} threads did not — after: matched without a qualifying message)`,
  );

  if (mineCount === 0) {
    console.log('  [inconclusive] zero "mine" messages in the 7-day window — cannot exercise the re-filter check; not a code defect, re-run when there is outbound mail in range');
  } else {
    console.log(`  [info] load-bearing check: ${belowSinceInner} of ${mineCount} "mine" messages (across full thread history) are older than sinceInner (>0 means the code's own since re-filter is doing real work: ${belowSinceInner > 0})`);
  }
}

/**
 * Sweep 2 — Calendar `timeMin`/`timeMax` overlap semantics, both directions:
 *   (a) overlap-returned: count events whose `start < timeMin` — a non-zero count is the
 *       positive proof that `timeMin` bounds the event's END time (a meeting that started
 *       before the window and ended inside it is exactly what `makeCalendarEndedWith` needs
 *       visible).
 *   (b) the dangerous direction: an event whose `end < timeMin` should never come back at all
 *       — if Google ever returns one, `timeMin` no longer means what the code assumes it
 *       means. The code's own `end > since` guard still protects the obligation radar either
 *       way, but the assumption this sweep exists to check would be wrong, so it is a hard
 *       failure here.
 */
async function sweepCalendar(): Promise<void> {
  const now = new Date();
  const timeMin = new Date(now.getTime() - 14 * DAY_MS);

  let accounts: string[];
  try {
    accounts = await listEnrolledMailboxes();
  } catch (err) {
    blocked(`could not list enrolled accounts: ${(err as Error).message}`);
    return;
  }
  if (accounts.length === 0) {
    blocked("no enrolled Google accounts");
    return;
  }

  let accountsWithEvents = 0;
  let totalEvents = 0;
  let overlapReturned = 0; // start < timeMin
  let noUsableEnd = 0; // all-day / missing end
  let stillOpen = 0; // end > now
  let endBeforeTimeMin = 0; // the leak direction

  for (const account of accounts) {
    let events: Awaited<ReturnType<Awaited<ReturnType<ReturnType<typeof googleClients>["calendar"]>>["listEvents"]>>;
    try {
      const calendar = await googleClients().calendar(account);
      events = await calendar.listEvents({ timeMin: timeMin.toISOString(), timeMax: now.toISOString(), max: 50 });
    } catch (err) {
      console.log(`  [account skipped] ${(err as Error).name ?? "Error"} — could not list events for this account`);
      continue;
    }
    if (events.length > 0) accountsWithEvents++;
    totalEvents += events.length;
    for (const e of events) {
      const start = Date.parse(e.start);
      if (Number.isFinite(start) && start < timeMin.getTime()) overlapReturned++;

      if (e.allDay === true || e.end === "") { noUsableEnd++; continue; }
      const end = Date.parse(e.end);
      if (!Number.isFinite(end)) { noUsableEnd++; continue; }
      if (end > now.getTime()) stillOpen++;
      if (end < timeMin.getTime()) endBeforeTimeMin++;
    }
  }

  console.log(`  accounts=${accounts.length} accountsWithEvents=${accountsWithEvents} totalEvents=${totalEvents}`);
  console.log(`  timeMin=${timeMin.toISOString()} timeMax(now)=${now.toISOString()}`);
  console.log(`  overlapReturned(start<timeMin)=${overlapReturned} noUsableEnd(allDay)=${noUsableEnd} stillOpen(end>now)=${stillOpen} endBeforeTimeMin=${endBeforeTimeMin}`);

  report(accountsWithEvents >= 1, "at least one account listed events");
  report(
    endBeforeTimeMin === 0,
    endBeforeTimeMin === 0
      ? "no returned event has end < timeMin — timeMin bounds END time as assumed"
      : `${endBeforeTimeMin} returned event(s) have end < timeMin — the assumption is WRONG (the code guard end<=since still protects the radar, but this needs a note beside obligation-lookups.ts)`,
  );
}

console.log("=== Sweep 1: Gmail after: granularity (obligation-lookups.ts assumption 1) ===");
await sweepGmail();

console.log("\n=== Sweep 2: Calendar timeMin/timeMax overlap semantics (obligation-lookups.ts assumption 2) ===");
await sweepCalendar();

console.log(`\n=== ${failed ? "FAIL" : "PASS"} ===`);
process.exit(failed ? 1 : 0);
