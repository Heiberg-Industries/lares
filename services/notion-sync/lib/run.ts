// Vendor-neutral orchestration: every side effect arrives as an injected dep.
import {
  detectStarvation, needsAttendees, planAttendees,
  type AttendeeUpdate, type CalEvent, type MeetingRow,
} from "./attendees.js";

export interface AttendeeSyncDeps {
  listMeetings: () => Promise<MeetingRow[]>;
  listEvents: (window: { timeMin: string; timeMax: string }) => Promise<CalEvent[]>;
  /**
   * Writes what the matcher concluded about one row: the attendees, and — when the
   * row's `Date` held no time of its own — the matched event's start (ORB-155).
   *
   * ONE call carrying both, the same rule `updateMeetingPeople` follows: they are
   * two halves of one statement ("this note is that meeting, and these were the
   * people"). Split into two writes, a failure between them leaves a row whose
   * attendees came from an event its date now contradicts — and the next tick would
   * skip it, because its Attendees is no longer empty.
   */
  updateMeetingMatch: (
    pageId: string,
    value: { attendees: string; startsAt?: string; seriesKey?: string },
  ) => Promise<void>;
  /** ORB-27 — advances `Status` to Summarized for rows whose summary exists. Its own dep,
   *  its own failure domain: a status write must never cost a row its attendees. */
  updateMeetingStatus: (
    pageId: string,
    value: { name: string; type: "status" | "select" },
  ) => Promise<void>;
  recordSynced: (pageId: string) => Promise<void>;
  recordUnmatched: (pageId: string, reason: string) => Promise<void>;
  recordError: (pageId: string, message: string) => Promise<void>;
  /** Best-effort human ping. Only ever called for SYSTEMIC failure — see below. */
  notify: (message: string) => Promise<void>;
}

export interface AttendeeSyncOptions {
  /** Every address that counts as the owner — see NotionSyncConfig.selfEmails. */
  selfEmails: readonly string[];
  toleranceMinutes: number;
  /** Window for rows timed only by page creation — see DEFAULT_CREATED_TOLERANCE_MINUTES. */
  createdToleranceMinutes: number;
  windowDays: number;
  now: Date;
  dryRun: boolean;
  /** Consecutive recent misses that make this systemic — DEFAULT_STARVATION_STREAK. */
  starvationStreak: number;
  /** How far back a miss still counts — DEFAULT_STARVATION_WINDOW_DAYS. */
  starvationWindowDays: number;
}

export interface AttendeeSyncResult {
  scanned: number;
  filled: number;
  flagged: number;
  errored: number;
  /**
   * Rows whose Notion outcome could not be written to the local store. Counted and
   * logged separately from `errored` because Notion itself was fine — but for a
   * filled row this drift is PERMANENT, since the next run skips rows whose
   * `Attendees` is no longer empty. A non-zero value must fail the command.
   */
  bookkeepingFailed: number;
  /** ORB-27 — rows whose Status advanced to Summarized this tick. */
  statusAdvanced: number;
  /** ORB-27 — status writes that failed. Logged and counted, never fatal: the attendee
   *  half of the tick is untouched by a Status 400. */
  statusFailed: number;
  /**
   * Did this tick look like SYSTEMIC starvation — every one of the last few notes
   * failing, rather than one ad-hoc note with no invite (ORB-155)? Reported as well
   * as notified, so a `--once` run on the box shows it without a spine configured.
   */
  starved: boolean;
  summary: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Contains a bookkeeping-write failure so it can never abort the run or get
 * misreported as something it isn't. Notion (for filled rows) or the still-empty
 * Attendees field (for unmatched rows) remains the source of truth regardless of
 * whether the local store recorded it.
 *
 * Contained is not the same as invisible: a TOTAL store outage already fails the
 * command loudly elsewhere (`setLastRunAt` is unguarded, and the calendar source
 * reads `oauth_tokens` before any Notion write). What lands here is PARTIAL failure
 * — a mid-run blip, a statement timeout, a GRANT covering one table but not the
 * other, a single row failing a type cast — so each one is logged with its page id
 * and counted into `bookkeepingFailed`, which the caller turns into a non-zero exit.
 *
 * Returns true when the write persisted.
 */
async function tryRecord(what: string, pageId: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`notion-sync: bookkeeping write failed (${what}) for page ${pageId}: ${message}`);
    return false;
  }
}

/** The write payload for one matched row — an omitted key means "leave that property alone". */
function matchValue(update: AttendeeUpdate): { attendees: string; startsAt?: string; seriesKey?: string } {
  return {
    attendees: update.attendees,
    ...(update.startsAt === undefined ? {} : { startsAt: update.startsAt }),
    ...(update.seriesKey === undefined ? {} : { seriesKey: update.seriesKey }),
  };
}

export async function runAttendeeSync(
  opts: AttendeeSyncOptions,
  deps: AttendeeSyncDeps,
): Promise<AttendeeSyncResult> {
  const rows = await deps.listMeetings();
  const events = await deps.listEvents({
    timeMin: new Date(opts.now.getTime() - opts.windowDays * DAY_MS).toISOString(),
    timeMax: new Date(opts.now.getTime() + DAY_MS).toISOString(),
  });

  // An empty calendar result while there are rows to match is never a legitimate
  // "nothing due" state — it's what a wrong principal, an unenrolled org, or a bad
  // --tolerance produces. Fail loudly instead of flagging the whole table unmatched.
  //
  // Keyed on the rows that would actually be PROCESSED, not on everything scanned:
  // in steady state every row is already filled, and an empty calendar then means
  // nothing at all is at stake — hard-failing on it would break every run.
  const toMatch = rows.filter(needsAttendees).length;
  if (events.length === 0 && toMatch > 0) {
    throw new Error(
      `notion-sync: calendar returned 0 events for a window with ${toMatch} meeting ` +
      `row(s) to match — refusing to flag them all unmatched; check the calendar principal ` +
      `and org configuration before re-running`,
    );
  }

  const plan = planAttendees(rows, events, {
    selfEmails: opts.selfEmails,
    toleranceMinutes: opts.toleranceMinutes,
    createdToleranceMinutes: opts.createdToleranceMinutes,
  });

  let filled = 0;
  let errored = 0;
  let bookkeepingFailed = 0;

  if (!opts.dryRun) {
    // Per-document, not per-run: a failure on one row must not discard the rows
    // already applied, and the next run resumes from what is left (spec §2).
    for (const update of plan.updates) {
      try {
        await deps.updateMeetingMatch(update.pageId, matchValue(update));
      } catch (err) {
        errored += 1;
        const message = err instanceof Error ? err.message : String(err);
        if (!await tryRecord("error", update.pageId, () => deps.recordError(update.pageId, message))) {
          bookkeepingFailed += 1;
        }
        continue;
      }
      // Notion already has the value at this point. A bookkeeping failure from here
      // on must never be reported through recordError — that would misfile a
      // successful Notion write as a Notion failure, and it could never self-correct
      // because the row's Attendees field is no longer empty on the next run.
      filled += 1;
      if (!await tryRecord("synced", update.pageId, () => deps.recordSynced(update.pageId))) {
        bookkeepingFailed += 1;
      }
    }
    for (const miss of plan.unmatched) {
      const ok = await tryRecord(
        "unmatched", miss.pageId, () => deps.recordUnmatched(miss.pageId, miss.reason),
      );
      if (!ok) bookkeepingFailed += 1;
    }
  } else {
    filled = plan.updates.length;
  }

  // The pattern, not the row (ORB-155, decision 3). Computed from the plan that was
  // just carried out, so what a human is told matches what actually happened this
  // tick — and computed even in dry-run, so a rehearsal still REPORTS the condition
  // it declines to broadcast.
  const starving = detectStarvation(rows, plan, {
    now: opts.now,
    streak: opts.starvationStreak,
    windowDays: opts.starvationWindowDays,
  });
  if (starving !== null) {
    const named = starving.map((r) => `"${r.matchTitle || "(untitled)"}" (${r.pageId})`).join(", ");
    const message =
      `notion-sync: attendee matching looks starved — the ${opts.starvationStreak} most recent ` +
      `meeting notes all failed to match a calendar event: ${named}. ` +
      `That is the shape of a broken input, not of an unusual week: check the Notion ` +
      `Meetings payload, the calendar principal and the OAuth enrolment.`;
    console.error(message);
    // Best-effort, and silent in dry-run: the same contract every notify in this
    // service keeps. A down spine must never fail a tick or make completed Notion
    // writes look like failures.
    if (!opts.dryRun) {
      try {
        await deps.notify(message);
      } catch (err) {
        console.error(`notion-sync: notify failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ORB-27 — the status pass. Independent of the matcher: a row advances when its summary
  // exists and its Status has not caught up, whatever its attendee state. All 49 live rows
  // sat at `Recorded` with summaries present, so the field carried zero information; this is
  // what finally makes it mean something. Idempotent by the guard (an advanced row no longer
  // qualifies), per-row failure isolation, and NOTHING here touches `errored` — a Status 400
  // must never make the attendee half look broken.
  let statusAdvanced = 0;
  let statusFailed = 0;
  const toAdvance = rows.filter((r) => r.hasSummary && r.status !== "Summarized");
  if (!opts.dryRun) {
    for (const row of toAdvance) {
      try {
        await deps.updateMeetingStatus(row.pageId, { name: "Summarized", type: row.statusType });
        statusAdvanced += 1;
      } catch (err) {
        statusFailed += 1;
        console.error(
          `notion-sync: status advance failed for ${row.pageId} — attendees are unaffected: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return {
    scanned: rows.length,
    filled,
    flagged: plan.unmatched.length,
    errored,
    bookkeepingFailed,
    statusAdvanced,
    statusFailed,
    starved: starving !== null,
    summary:
      `${filled} filled, ${plan.unmatched.length} flagged, ${errored} errored, ` +
      `${bookkeepingFailed} bookkeeping-failed, ${statusAdvanced} status-advanced, ` +
      `${rows.length} scanned` +
      `${opts.dryRun ? " (dry-run)" : ""}`,
  };
}
