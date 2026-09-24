// The conflict radar, on request (ORB-139). The morning brief runs the same pass over today
// automatically; this is what answers "is anything clashing next week?" when he asks directly.
//
// WHY A TOOL AND NOT A SKILL FILE. A skill would be prose telling her to reason about overlaps
// herself — precisely the unreliable-by-construction behaviour this ticket exists to replace.
// The detection is CODE (`lib/calendar-conflicts.ts`), so what she needs is a way to call it,
// and a tool is the only shape that gives her one.
//
// READ-ONLY, UNGATED, under the existing `calendar` capability. Same reasoning as the orakel
// and transit reads that carry no approval: this tool has no write path at all — it lists
// calendars, reads events, and returns rows. Gating something harmless is what costs the real
// gates their meaning. It can never delete, decline or move anything itself.
//
// LAR-59-s5 — RESOLUTION IS A PROPOSAL, NEVER AN ACTION. For each `overlapping-stay` finding
// (the only kind the owner decided is worth a mailbox search — `lib/conflict-resolution.ts`'s
// own header), this tool now runs `resolveConflicts` after detection: a small, bounded Gmail
// search (at most 3 clashes per call, 5 messages per event, 10s per clash) for a cancellation
// of one of the two bookings. When exactly one booking has a STRONG match, that row gains a
// `resolution` naming the stale event, its `account`/`calendarId`, and the evidence sentence.
// THE MAIL NEVER CHOOSES THE EVENT — `resolveConflicts` only asks "does this event the
// DETECTOR already flagged have a cancellation?", never "which event does this mail name?"
// (see that module's own header for why that direction matters). This tool still deletes
// nothing: a `resolution` is a proposal for the model to relay and offer, never an action taken
// here. Removing the stale event stays entirely behind `calendar_delete_event`'s own approval
// card — that call uses the row's `eventId`, `account` and `calendarId`, with `reason` set to
// `resolution.sentence` verbatim, so the card names the evidence he is asked to approve
// against. A row with no `resolution` is reported as found, nothing more.
//
// EVERY CALENDAR OF EVERY ACCOUNT, like the briefs. `listEventsEverywhere` with
// `includeReadOnly` is what reaches the subscribed calendar a clash can perfectly well live
// on; asking the primary calendar alone would answer "nothing clashes" off half the data,
// which is the ORB-118 silence wearing a new hat.
//
// W3A-s5 (beyond the slice's own file list — found auditing the catalogue for the register-
// completeness test, tests/origin-taint-reads.test.ts). This tool structurally cannot make
// `calendar_list_events.ts`'s "bare primary listing" exception — it deliberately reads EVERY
// calendar of every account, including subscribed and read-only ones, every time. So unlike
// that tool it taints unconditionally on a successful call, same class (`third_party`) and same
// reasoning (docs/specs/2026-09-18-origin-model-design.md, "The in-turn taint rule").
//
// LAR-59-s5 — the taint above is set from the CALENDAR read alone, before `resolveConflicts`
// ever touches Gmail, and deliberately stays that way: the turn must read `third_party` whether
// or not any clash turns out to be an `overlapping-stay` worth searching mail for. A mail read
// happening afterwards, in the same tainted turn, never needs a taint call of its own — it
// would only ever confirm a class the turn already carries.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { taintTurn, turnKeyFrom } from "@lares/agent-kit/origin-taint";
import { listEventsEverywhere } from "../lib/calendar-fanout.js";
import { googleClients, listEnrolledMailboxes } from "../lib/google.js";
import {
  DEFAULT_HOME_TIMEZONE,
  detectCalendarConflicts,
  type ConflictTrip,
} from "../lib/calendar-conflicts.js";
import { resolveConflicts } from "../lib/conflict-resolution.js";
import { conflictTrips, readBriefTravel } from "../lib/brief-content.js";
import { addOsloDays, osloDate } from "../lib/recurrence.js";

/** How far ahead one call may look. A month is more calendar than any real question needs, and
 *  the pass is pairwise — the ceiling is a guard on a runaway request, not a tuning knob. */
const MAX_DAYS = 31;
const DEFAULT_DAYS = 7;

/** The fan-out's per-calendar ceiling. It THROWS above this rather than returning a short
 *  list, which is the whole point: a truncated read that answered "nothing clashes" would be
 *  the most convincing wrong answer this tool could give. */
const EVENTS_MAX = 250;

export default defineTool({
  description:
    "Check the calendar for conflicts it contradicts itself about, over a window of days " +
    "starting from a date. Deterministic — this is a code pass over every calendar of every " +
    "connected account, not a judgement. Finds three things: double-booked time (two timed " +
    "commitments overlapping), overlapping stays (two places to sleep booked for the same " +
    "night), and timezone traps (an event whose booked clock time lands outside waking hours " +
    "where he actually is that day, using the filed travel itinerary). For an overlapping-stay " +
    "finding it also runs a small, bounded mailbox search for a cancellation of one of the two " +
    "bookings; when exactly one has a strong match, that row carries a `resolution` naming the " +
    "stale event and the cancellation mail's own sentence as evidence. Returns a list of " +
    "{kind, severity, events, explanation, resolution?}; an empty list means the pass found " +
    "nothing, not that it could not run. It reads only and never deletes, declines or moves " +
    "anything itself — a `resolution` is a PROPOSAL the owner still has to approve: a row with " +
    "`resolution.strength === \"strong\"` may be offered for removal, but only by calling " +
    "calendar_delete_event with that row's own `eventId`, `account` and `calendarId`, passing " +
    "`resolution.sentence` verbatim as `reason` so the approval card shows the evidence. A row " +
    "with no `resolution` is reported as found, nothing more — never propose removing it.",
  inputSchema: z.object({
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .optional()
      .describe("First day to check, YYYY-MM-DD. Defaults to today."),
    days: z
      .number()
      .int()
      .positive()
      .max(MAX_DAYS)
      .optional()
      .describe(`How many days from \`from\` to check, 1–${MAX_DAYS}. Defaults to ${DEFAULT_DAYS}.`),
  }),
  async execute({ from, days }, ctx) {
    const now = new Date();
    const first = from ?? osloDate(now);
    const span = days ?? DEFAULT_DAYS;
    const window = Array.from({ length: span }, (_, i) => addOsloDays(first, i));
    const last = window[window.length - 1] ?? first;

    // A day either side of the window, so a stay or a meeting that STRADDLES its edge is
    // fetched rather than clipped. `detectCalendarConflicts` re-applies the window itself, so
    // the extra days widen the read without widening the answer.
    const events = await listEventsEverywhere(
      {
        accounts: () => listEnrolledMailboxes(),
        clientFor: (account) => googleClients().calendar(account),
      },
      {
        timeMin: `${addOsloDays(first, -1)}T00:00:00Z`,
        timeMax: `${addOsloDays(last, 2)}T00:00:00Z`,
        max: EVENTS_MAX,
      },
    );

    // The filed itinerary is what says which clock he is on each day. It never throws; with no
    // travel wiring it yields no trips, which reads as the home clock — the same default the
    // radar applies on its own.
    const trips: ConflictTrip[] = conflictTrips(readBriefTravel(first, "today"));

    const k = turnKeyFrom(ctx);
    if (k) taintTurn(k, "third_party");

    const conflicts = detectCalendarConflicts(events, { days: window, trips });

    // LAR-59-s5 — never let a resolver problem cost him the plain findings. `resolveConflicts`
    // already documents itself as never throwing (every per-clash failure is caught inside it
    // and logged as a warning), but this call is defensive belt-and-braces on top of that
    // promise: whatever goes wrong, the tool still answers with what the DETECTOR found.
    const resolved = await resolveConflicts(conflicts, {
      gmailFor: (account) => googleClients().gmail(account),
    }).catch((err) => {
      console.warn(
        `calendar_conflicts: could not check findings against mail, returning plain conflicts (${(err as Error).message})`,
      );
      return conflicts;
    });

    return {
      window: { from: first, days: span, timezone: DEFAULT_HOME_TIMEZONE },
      conflicts: resolved,
    };
  },
});
