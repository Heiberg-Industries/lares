// Pure: no I/O, no vendor imports. The whole "never guess" rule lives here (spec §8).

export interface CalAttendee {
  email: string;
  displayName?: string;
  /**
   * The guest's RSVP (ORB-156). Optional because it is absent on an event nobody was
   * invited to, and because every caller predating this field must stay unaffected.
   * `Attendees` in Notion is an INVITE list, not an attendance list — this is the field
   * that would let a consumer tell the difference, and today nothing does.
   */
  responseStatus?: "accepted" | "declined" | "tentative" | "needsAction";
}
export interface CalEvent {
  id: string;
  summary: string;
  start: string;
  attendees?: CalAttendee[];
  /**
   * The recurring series this event belongs to (ORB-156), absent on a one-off. Copied
   * onto the update so the row can say which series it is part of — the identity that
   * survives a rename, unlike the title.
   */
  recurringEventId?: string;
}
/**
 * Where a row's `startsAt` came from — see the adapter's `deriveMeetingStart`.
 * Restated here rather than imported because this module may not reach into
 * adapters/ (neutrality.test.ts); the adapter's row stays structurally assignable.
 */
export type StartsAtSource = "date-property" | "title-mention" | "created-time" | "none";

export interface MeetingRow {
  pageId: string;
  /**
   * The meeting's title with Notion's date MENTIONS stripped out (ORB-155). Not the
   * raw title: a mention's flattened text is the whole ISO timestamp, which buries
   * the one real word of "Folkepuls 2026-08-24T10:00:00.000+02:00" under seven of
   * date noise and drags every similarity score below the gate.
   */
  matchTitle: string;
  startsAt: string | null;
  /** How much this row's time is worth — see `planAttendees`'s window and title gate. */
  startsAtSource: StartsAtSource;
  /** True when the `Date` property already holds a datetime, which is never overwritten. */
  dateHasTime: boolean;
  /** The page's `created_time` — the clock the starvation window is measured on. */
  createdAt: string;
  attendees: string;
  /** ORB-27 — a non-empty `Summary` property. All 49 rows sat at `Recorded` while their
   *  summaries existed, so the Status field carried zero information; this is the trigger
   *  that finally moves it. */
  hasSummary: boolean;
  /** The current `Status` value (`Recorded`, `Summarized`, …) or null when unset. */
  status: string | null;
  /** Whether Notion models `Status` as a status- or select-type property — the PATCH shape
   *  differs and guessing wrong 400s the write. Read from the live property, never assumed. */
  statusType: "status" | "select";
}

export type UnmatchedReason = "no-date" | "no-candidate" | "ambiguous" | "no-attendees";

/**
 * One row the matcher is confident about.
 *
 * `startsAt` is present only when the row's `Date` may be upgraded to the matched
 * event's start — see `planAttendees`. Its ABSENCE is a decision ("leave that
 * property alone"), not a missing value.
 */
export interface AttendeeUpdate {
  pageId: string;
  attendees: string;
  startsAt?: string;
  /**
   * The matched event's recurring-series id. ABSENT means this meeting is a one-off, which
   * ORB-156 reads as "never eligible for autonomous follow-up". An empty string would be a
   * series id matching nothing — a different and worse claim than "there isn't one".
   */
  seriesKey?: string;
}

export interface AttendeePlan {
  updates: AttendeeUpdate[];
  unmatched: Array<{ pageId: string; reason: UnmatchedReason }>;
}

/**
 * Whether this row is work for the matcher at all. A row that already has an
 * `Attendees` value is skipped before any matching happens — provenance is never
 * clobbered — so it is not "a row that needs a calendar event".
 */
export function needsAttendees(row: MeetingRow): boolean {
  return row.attendees.trim() === "";
}

/**
 * Default start-time match window, in minutes.
 *
 * Start time is the primary signal, so this has to be tight enough that an ordinary
 * working day does not collapse into ambiguity: with a wide window, meetings at
 * 09:00, 10:00 and 11:00 each see all three as candidates and none get filled. 15
 * minutes covers the realistic drift between what a meeting note records and what
 * the invite says (a note written on the hour for a :55 start, a rounded time typed
 * by hand) without swallowing the next slot.
 */
export const DEFAULT_TOLERANCE_MINUTES = 15;

/**
 * Match window, in minutes, for a row whose start is only INFERRED from when its
 * Notion page was created (ORB-155).
 *
 * A transcription page is created when the recording starts, which is close to the
 * meeting's start but not equal to it: on the live data the drift runs from a
 * couple of minutes early (the bot joins ahead of the invite) to nearly half an
 * hour late (a note begun after everyone has settled in). 90 minutes covers that
 * plus a meeting joined well after it began, which the tight window cannot.
 *
 * Widening the clock is only safe because the clock stops being the decision: a
 * `created-time` row must ALSO clear the title gate, even when it is the only
 * candidate in range (see planAttendees). The window narrows the field; the title
 * is what picks. A stated start — a `Date` with a time, or the invite's own minute
 * carried in a title mention — keeps the tight window and needs no such gate.
 */
export const DEFAULT_CREATED_TOLERANCE_MINUTES = 90;

/**
 * How many consecutive recent meeting notes must fail to match before this is a
 * systemic failure rather than an unusual week (ORB-155, decision 3).
 *
 * TWO is a normal Friday: an ad-hoc recording with no invite is legitimate, and two
 * of them back to back is not rare. THREE is not — 44 of the 54 rows in the live
 * database matched, and the three-in-a-row runs in its history are exactly the two
 * things worth a message: a genuine quiet patch of unscheduled notes, and the
 * two-week starvation this ticket exists to end. Choosing three trades a rare,
 * cheap false positive for catching the failure that was invisible for a fortnight.
 */
export const DEFAULT_STARVATION_STREAK = 3;

/**
 * How far back a row can have been created and still count toward the streak.
 *
 * Without it, three genuinely event-less notes that happened to be the newest three
 * would re-alert every day forever, and the alert would become noise to scroll past
 * — which is how the ORB-150 backup alarm failed. The claim being made is "recently,
 * nothing is matching", so it is measured over recent rows: a real starvation keeps
 * producing new unmatched rows and keeps saying so, while a permanent trio ages out.
 */
export const DEFAULT_STARVATION_WINDOW_DAYS = 14;

/**
 * How much of the NOTE's title an event summary must account for before the title
 * tie-break is allowed to separate candidates. Below this, the titles are treated as
 * telling us nothing and the row is flagged `ambiguous` rather than guessed at.
 */
const MIN_TITLE_SIMILARITY = 0.5;

/**
 * Letters that carry no combining mark to strip, so NFKD leaves them alone and the
 * ASCII filter below would otherwise split the word in half ("m\u00f8te" \u2192 "m te").
 * Folded explicitly to their conventional ASCII spelling.
 */
const LETTER_FOLD: Record<string, string> = {
  "\u00f8": "o", "\u00e6": "ae", "\u00e5": "a", "\u0111": "d", "\u00f0": "d", "\u00fe": "th", "\u00df": "ss", "\u0142": "l",
};

/** Lower-cased, accent-folded, every run of non-alphanumerics collapsed to a space. */
function normaliseTitle(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\u00f8\u00e6\u00e5\u0111\u00f0\u00fe\u00df\u0142]/g, (c) => LETTER_FOLD[c])
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleWords(text: string): Set<string> {
  const normalised = normaliseTitle(text);
  return new Set(normalised === "" ? [] : normalised.split(" "));
}

/**
 * How much of a Notion row's title a calendar event's summary accounts for, 0..1.
 *
 * Deliberately one line of arithmetic rather than a fuzzy-distance library, so it can
 * be explained and predicted: shared words divided by the NOTE's word count.
 *
 *   "Stein // Bendik"        vs "Stein / Bendik — Nomono" → 1     (summary covers it)
 *   "Weekly sync"            vs "Weekly standup"          → 0.5
 *   "Weekly sync with Stein" vs "Weekly sync w/ Stein"    → 0.75
 *   "Weekly sync with Stein" vs "Sync"                    → 0.25
 *   an empty title on either side                         → 0     (never a match)
 *
 * ASYMMETRIC ON PURPOSE, and the denominator is load-bearing. Dividing by the SMALLER
 * of the two word counts (the overlap coefficient) scores any event whose whole title
 * is a word-subset of the note's at a perfect 1 — so a generic invite like "Sync",
 * "Call" or "1:1" five minutes away outscores the real meeting whose wording differs
 * even slightly, and the job writes the wrong people's addresses into Notion. Dividing
 * by the note's own word count asks the question we actually mean — "does this summary
 * account for what the note says the meeting was about?" — under which a short generic
 * title can never beat a longer, more specific one.
 *
 * A runner-up margin was considered instead and rejected: it leaves the decoy holding
 * the top score, so it converts some wrong picks into `ambiguous` without ever fixing
 * the ordering. This fixes the ordering.
 */
export function titleSimilarity(noteTitle: string, eventSummary: string): number {
  const note = titleWords(noteTitle);
  const summary = titleWords(eventSummary);
  if (note.size === 0 || summary.size === 0) return 0;
  let shared = 0;
  for (const word of note) if (summary.has(word)) shared += 1;
  return shared / note.size;
}

/**
 * Breaks a start-time tie on title, or returns null when it cannot.
 *
 * "Never guess" survives intact: a candidate wins only if it clears
 * MIN_TITLE_SIMILARITY *and* beats every other candidate outright. A weak match or
 * a tie returns null, which the caller turns into `ambiguous` — not a coin flip.
 */
export function pickByTitle(rowTitle: string, candidates: CalEvent[]): CalEvent | null {
  let best: CalEvent | null = null;
  let bestScore = 0;
  let tied = false;
  for (const candidate of candidates) {
    const score = titleSimilarity(rowTitle, candidate.summary);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
      tied = false;
    } else if (score === bestScore) {
      tied = true;
    }
  }
  if (best === null || tied || bestScore < MIN_TITLE_SIMILARITY) return null;
  return best;
}

/**
 * `Name <email>, …` with the owner last — the format the existing rows already use.
 *
 * `selfEmails` is a list, not one address: the owner of a meeting in a second org is
 * a different mailbox of the same person, and missing that would sort them mid-list.
 */
export function formatAttendees(
  attendees: CalAttendee[],
  selfEmails: readonly string[],
): string {
  const owners = new Set(selfEmails.map((e) => e.toLowerCase()));
  const isSelf = (a: CalAttendee): boolean => owners.has(a.email.toLowerCase());
  const ordered = [...attendees.filter((a) => !isSelf(a)), ...attendees.filter(isSelf)];
  return ordered
    .map((a) => `${a.displayName ?? a.email.split("@")[0]} <${a.email}>`)
    .join(", ");
}

export interface PlanOptions {
  selfEmails: readonly string[];
  /** Window for a STATED start — a `Date` with a time, or a title date mention. */
  toleranceMinutes: number;
  /** Window for a start inferred from `created_time`. Wider, and gated on the title. */
  createdToleranceMinutes: number;
}

/** A start Notion (or a human) STATED, as opposed to one inferred from page creation. */
function isStated(source: StartsAtSource): boolean {
  return source !== "created-time";
}

export function planAttendees(
  rows: MeetingRow[],
  events: CalEvent[],
  opts: PlanOptions,
): AttendeePlan {
  const plan: AttendeePlan = { updates: [], unmatched: [] };

  for (const row of rows) {
    // Provenance is never clobbered.
    if (!needsAttendees(row)) continue;

    const rowMs = row.startsAt === null ? Number.NaN : Date.parse(row.startsAt);
    if (Number.isNaN(rowMs)) {
      plan.unmatched.push({ pageId: row.pageId, reason: "no-date" });
      continue;
    }

    const stated = isStated(row.startsAtSource);
    const toleranceMs = (stated ? opts.toleranceMinutes : opts.createdToleranceMinutes) * 60_000;

    const candidates = events.filter((e) => {
      const eventMs = Date.parse(e.start);
      return !Number.isNaN(eventMs) && Math.abs(eventMs - rowMs) <= toleranceMs;
    });

    if (candidates.length === 0) {
      // Includes date-only rows, which parse to midnight and so match nothing real.
      plan.unmatched.push({ pageId: row.pageId, reason: "no-candidate" });
      continue;
    }

    // A stated time may decide on its own when it is the only event in range; the
    // title is its tie-break. An INFERRED time may not — the wider window it needs
    // would otherwise let an unrelated invite an hour away write its attendees into
    // an ad-hoc note. So for `created-time` the title gate is mandatory, and a lone
    // candidate has to clear it exactly like a contested one.
    const match = stated && candidates.length === 1
      ? candidates[0]
      : pickByTitle(row.matchTitle, candidates);
    if (match === null) {
      plan.unmatched.push({ pageId: row.pageId, reason: "ambiguous" });
      continue;
    }

    const attendees = match.attendees ?? [];
    if (attendees.length === 0) {
      plan.unmatched.push({ pageId: row.pageId, reason: "no-attendees" });
      continue;
    }
    // The date write-back (ORB-155, decision 1). Two conditions, both necessary:
    //   - the row's `Date` holds no time yet. A datetime someone typed is a
    //     statement, and this pass corrects nobody — same provenance rule as
    //     Attendees, one property over.
    //   - the event has a time to give. Google reports an all-day event's start as
    //     a bare date; writing that back would swap one date-only value for another
    //     and leave the row exactly as unmatched-forever as it started.
    const upgradeDate = !row.dateHasTime && match.start.includes("T");
    plan.updates.push({
      pageId: row.pageId,
      attendees: formatAttendees(attendees, opts.selfEmails),
      ...(upgradeDate ? { startsAt: match.start } : {}),
      ...(match.recurringEventId ? { seriesKey: match.recurringEventId } : {}),
    });
  }

  return plan;
}

/**
 * Is attendee matching STARVED — failing as a pattern rather than on a row?
 *
 * Returns the streak (newest first) when it is, null when it is not. Pure, so the
 * rule that decides whether a human gets pinged is testable without a spine, a
 * clock or a network.
 *
 * The question is deliberately not "did anything fail?" — something always does, and
 * an alert that fires on every ad-hoc note is one nobody reads. It is "have the last
 * few notes ALL failed?", which is what a changed payload shape, a wrong calendar
 * principal or an expired token looks like, and what two weeks of `0 filled, 11
 * flagged` looked like while nothing said a word.
 */
export function detectStarvation(
  rows: readonly MeetingRow[],
  plan: AttendeePlan,
  opts: { now: Date; streak: number; windowDays: number },
): MeetingRow[] | null {
  const unmatched = new Set(plan.unmatched.map((u) => u.pageId));
  const oldestAllowed = opts.now.getTime() - opts.windowDays * 24 * 60 * 60 * 1000;

  const recent = rows
    // Only rows the matcher actually WORKED on: one that already has attendees was
    // never a candidate for failing, so counting it either way would be a lie.
    .filter((row) => needsAttendees(row))
    .map((row) => ({ row, createdMs: Date.parse(row.createdAt) }))
    .filter(({ createdMs }) => Number.isFinite(createdMs) && createdMs >= oldestAllowed)
    .sort((a, b) => b.createdMs - a.createdMs)
    .slice(0, opts.streak)
    .map(({ row }) => row);

  if (recent.length < opts.streak) return null;
  return recent.every((row) => unmatched.has(row.pageId)) ? recent : null;
}
