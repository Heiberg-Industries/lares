/**
 * agent/instructions/travel-context.ts — today's travel, from Marcel's trip store, on every
 * turn (ORB-169).
 *
 * THE BUG THIS CLOSES ONE LAYER UP. `lib/travel-store.ts`'s header tells the whole story: on
 * 2026-08-25 Marcel had already resolved a Scandic Oslo Airport reservation as the night
 * before a Wednesday flight, while Saga — composing about that same night — read the identical
 * hotel off the calendar as "you're based there all day". Task 5 built the read-only pipe
 * (`currentTravel`); this task is what makes her actually consult it, unprompted, on every
 * turn — not only when a tool call happens to fetch it.
 *
 * MIRRORS `standing-facts.ts` (read that file's header first; this one assumes it). Same
 * shape, same discipline, for the same reasons:
 *
 *   - `defineDynamic` on `turn.started`, NOT `session.started`. A Telegram or Slack session
 *     can live up to an Oslo day (`clock.ts`'s header); a trip a fact-holder retires or a new
 *     booking Marcel files mid-conversation must land on the NEXT turn, not tomorrow.
 *   - `withTimeout`, because a `catch` covers a rejection but not a call that never settles,
 *     and eve applies no timeout of its own to a dynamic-instruction resolver. `travel-store.ts`
 *     reads are synchronous (`fs.readFileSync`), unlike standing-facts' Postgres query, so this
 *     guard is honest about what it can and cannot catch: it bounds any AWAIT this resolver
 *     makes — including a future async change to the store, or a mocked hang in a test — but a
 *     true kernel-level block on a stale mount would wedge Node's single thread before the
 *     timer ever got to run, and no library-level guard fixes that. See
 *     {@link TRAVEL_CONTEXT_TIMEOUT_MS} for the budget and why it is small.
 *   - EVERY failure yields an EMPTY block, and every one of them is now LOGGED. An unset
 *     `TRAVEL_PATH` throws {@link TravelPathNotConfiguredError}; that case was deliberately
 *     silent while the variable had not shipped yet, because it was the outcome of literally
 *     every turn. Deploy B2 set it, so the case inverted: it now means the variable was LOST,
 *     which costs every subsequent turn its travel awareness with no other symptom anywhere.
 *     It is warned rather than errored (it is a configuration fact, not a crash) and kept
 *     distinct from the rest, which are errors.
 *   - NOTHING AT MODULE SCOPE. `eve build` evaluates every module with no environment present;
 *     `travelRoot()` (called inside `currentTravel`) throws without `TRAVEL_PATH`, and calling
 *     it lazily inside the handler is what keeps the build green.
 *
 * WHY THIS DUPLICATES THE BLOCK TASK 7 ADDS TO THE BRIEF, ON PURPOSE — do not "fix" it. This
 * is the identical reasoning `brief-content.ts` already records for `standingFactsBlock`
 * (search that file for "ORB-167 — the \"Standing facts"): those facts already reach every
 * turn through `standing-facts.ts`, and are STILL repeated in the brief as a named block,
 * because grounding applies PER BLOCK — a brief is composed under the contract's rules, and a
 * fact she is expected to ACT on inside a brief has to be a labeled piece of context in it, not
 * background she happens to be carrying. Today's travel is exactly that kind of fact for a
 * brief. So: this file is what lets her not contradict herself mid-conversation about where he
 * is sleeping tonight; Task 7's block is what lets a brief ground its own travel-context lines
 * in something more specific than "she generally knows this".
 *
 * A DIFFERENT `travelContextBlock` ALREADY EXISTS IN `brief-content.ts` (ORB-165) — do not
 * confuse the two. That one renders calendar EVENTS classified as travel context (a hotel or
 * flight found on the calendar itself); this file and Task 7's block both render Marcel's
 * FILED RESERVATIONS instead, which is the whole fix — the calendar reading was the source of
 * the original bug. Same block name in spirit, two different data sources, on purpose.
 *
 * WHY THE DAY BOUNDARY IS OSLO, NEVER A TRIP'S OWN TIMEZONE — do not "fix" this either.
 * `services/travel/lib/current-trip.ts` resolves the current trip on `store.homeTimezone()`
 * (default `Europe/Oslo`), not on the destination's clock — Marcel picks "today" on the home
 * clock even when Bendik is in New York. Reading the trip's own timezone here instead would
 * make Saga and Marcel disagree about which day it is: precisely the agent-disagreement
 * ORB-169 exists to remove. `currentTravel`'s own signature only takes a plain date string for
 * exactly this reason — `osloDate(new Date())` is what both agents now share.
 *
 * WHAT THIS BLOCK DOES NOT DO. It never writes prose like "no trip today" — an empty block is
 * DROPPED by `labeledContext` (`@lares/compose-contract`), not rendered with invented text; the
 * absent-vs-empty vocabulary already lives in that package's `absentBlockClause`, and nothing
 * here reinvents it. And it never treats `unavailable` as "no travel" — `travel-store.ts`'s own
 * header and the plan's global constraints both say so explicitly: a store that could not be
 * read is a failure, not an empty calendar, so that case is logged and dropped exactly like a
 * throw, never rendered as "he has no travel this week".
 */
import { defineDynamic, defineInstructions } from "eve/instructions";

import { labeledContext } from "@lares/compose-contract";

import { withTimeout } from "../../lib/timeout.js";
import { osloDate } from "../../lib/recurrence.js";
import {
  DEFAULT_HORIZON_DAYS,
  TravelPathNotConfiguredError,
  currentTravel,
  type TravelBooking,
  type TravelItinerary,
  type TravelResult,
} from "../../lib/travel-store.js";

/**
 * The stall budget. `travel-store.ts` reads a handful of small files off a `:ro` bind mount —
 * a healthy read completes in low single-digit milliseconds, nothing like a network round
 * trip to Postgres (standing-facts.ts's 1500ms budget for that). This is generous headroom
 * over the healthy case while still keeping a degraded mount from costing Bendik's turn.
 */
export const TRAVEL_CONTEXT_TIMEOUT_MS = 500;

/** `currentTravel` is synchronous; wrapped in an `async` function so `withTimeout` has a real
 *  promise to race against — the same reason it is worth stating explicitly in the header
 *  above, not just here: this is what makes the resolver's stall guard exercisable at all. */
async function readTravel(todayISO: string): Promise<TravelResult<TravelItinerary>> {
  return currentTravel(todayISO, { horizonDays: DEFAULT_HORIZON_DAYS });
}

/** One booking's date/time, rendered once so lodging, transport, and the unclassified bucket
 *  below all say it the same way. */
function bookingWhen(b: TravelBooking): string {
  if (b.end !== undefined && b.end !== b.start) return `${b.start} → ${b.end}`;
  return b.time !== undefined ? `${b.start} ${b.time}` : b.start;
}

/**
 * One trip's readable facts as markdown lines.
 *
 * THREE buckets, rendered as three DIFFERENT sentence shapes on purpose — `lodging` says
 * where he sleeps, `transport` says how he moves, and `other` says neither: it names the
 * booking, says plainly it is unclassified, and says plainly it is NOT a confirmed departure.
 * Dropping `other` silently, or folding it into `transport`, reproduces the exact bug
 * `travel-store.ts` exists to fix — a Vy train (Marcel's extractor has no `train` kind yet)
 * would either vanish or get read as a real departure it never verified.
 */
function itineraryLines(it: TravelItinerary): string {
  const { trip } = it;
  const place = trip.destination ? ` — ${trip.destination}` : "";
  const tz = trip.timezone ? `, ${trip.timezone}` : "";
  const lines = [`${trip.name}${place} (${trip.start} to ${trip.end}${tz})`];
  for (const b of it.lodging) lines.push(`- sleeps: ${b.summary} (${bookingWhen(b)})`);
  for (const b of it.transport) lines.push(`- moves (${b.kind}): ${b.summary} (${bookingWhen(b)})`);
  for (const b of it.other) {
    lines.push(
      `- unclassified (${b.kind}) — a filed reservation, NOT a confirmed departure: ` +
        `${b.summary} (${bookingWhen(b)})`,
    );
  }
  return lines.join("\n");
}

/** The labeled `## Travel` block, or "" when there is no trip in the window — `labeledContext`
 *  drops an empty block rather than rendering a heading over nothing. */
function travelContextMarkdown(trips: readonly TravelItinerary[]): string {
  return labeledContext([
    {
      label: "Travel",
      note: "today ± 7 days, from Marcel's trip store — where he sleeps and moves",
      content: trips.map(itineraryLines).join("\n\n"),
    },
  ]);
}

export default defineDynamic({
  events: {
    "turn.started": async () => {
      try {
        const result = await withTimeout(
          readTravel(osloDate(new Date())),
          TRAVEL_CONTEXT_TIMEOUT_MS,
          "eve-saga: travel context",
        );
        if (result.unavailable !== undefined) {
          // Unavailable is not "none" (plan's own global constraint): the store COULD NOT BE
          // READ, and rendering that as an empty block would be exactly the "no travel"
          // false-negative Task 5 was built to stop. Log it and drop the block — never say
          // "(none)".
          console.error(
            `eve-saga: travel-context resolver — Marcel's trip store is unavailable this turn ` +
              `(${result.unavailable}); no travel context injected`,
          );
          return defineInstructions({ markdown: "" });
        }
        return defineInstructions({ markdown: travelContextMarkdown(result.trips) });
      } catch (err) {
        if (err instanceof TravelPathNotConfiguredError) {
          // REVIEW IMPORTANT 2 — this branch was silent because TRAVEL_PATH was not yet set, so
          // logging it would have been permanent noise from turn one. Deploy B2 set it. What the
          // branch means now is the opposite: the variable went MISSING — a compose edit, a
          // drift-guard accept, a container recreated from a stale file — and every turn from
          // then on has no travel awareness at all while the container stays healthy and
          // `docker logs` stays empty. Warned, not thrown: returning an empty block is still the
          // right behaviour, only the silence was wrong.
          console.warn(
            "eve-saga: TRAVEL_PATH is not set — no travel context on this turn; Marcel's trip " +
              "store is unreachable until the variable is restored",
          );
          return defineInstructions({ markdown: "" });
        }
        console.error(
          "eve-saga: travel-context resolver failed — this turn has NO awareness of Marcel's trips",
          err,
        );
        return defineInstructions({ markdown: "" });
      }
    },
  },
});
