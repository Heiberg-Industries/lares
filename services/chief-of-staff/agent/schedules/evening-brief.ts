/**
 * The evening prep pass — 20:00 on the owner's clock. Tomorrow's external meetings, plus whatever is owed to
 * the people in them, while there is still an evening in which to act on it.
 *
 * DELIBERATE CONTRACT (the ONE feature exception — see `lib/brief-content.ts`'s
 * header): if `buildEveningBrief` returns `null`, NOTHING is sent — not an empty message, not
 * "nothing to prepare for tonight". Silence is the correct, expected output on most evenings.
 *
 * TIMEZONE: Vercel evaluates `cron` in UTC, and an offset moves with the season — a fixed cron
 * string cannot itself track that. This fires every minute and only actually runs the pass when
 * the OWNER's wall clock reads 20:00 (`ownerTz` → `slotIn`). On a day the owner is at home the
 * resolver returns the home zone and the slot is the configured one — the clock only moves on a
 * day the owner is somewhere else, which is exactly the day a home-clock prep pass would fire at
 * the wrong end of the owner's evening.
 *
 * PROACTIVITY: the send passes `@lares/agent-kit`'s gate as a `scheduled` initiation
 * keyed on the slot. A suppression (quiet hours, DND) logs one line and STILL stamps the pass —
 * a brief the owner asked not to receive is not a dead schedule.
 *
 * `lastSlot`/`running` are module-scope, matching `proposals-watch.ts`'s `liveState` —
 * persisting across cron fires within the same warm process, single-fire-per-owner-day.
 *
 * ONE CLOCK FOR THE WHOLE PASS. The `tz` that decides the slot also decides which day is
 * "tomorrow" (the meetings, the itinerary) and the day the delivery stamp names — ADR 0014 rule
 * 11: date and time always come off the same clock. Before, the slot followed the owner and the
 * day stayed at home, so 20:00 in New York (past midnight at home) prepared the owner for the day AFTER
 * tomorrow. What a clock that MOVES mid-day does, stated once because it is a choice:
 *   - never two: the slot key is `<owner date>T20`, and the ledger's already-seen rule holds it
 *     for good, so a date the owner meets twice (a jump west) gets one pass, not two;
 *   - sometimes none: a jump east past the owner's 20:00 leaves that date without a pass, and it is not
 *     caught up — the choice ADR 0014 rule 4 already makes for a slot lost to quiet hours (a late
 *     prep pass is worse than none). A skipped evening is this pass's existing fail-safe: nothing
 *     is stamped, so the next morning brief reports what it would have covered.
 */
import { defineSchedule } from "eve/schedules";

import telegram from "../channels/telegram.js";
import slack from "../channels/slack.js";
import { getPool } from "@lares/agent-kit/db";
import { scheduleEnabled } from "@lares/agent-kit/schedule-switch";
import { isGranted } from "@lares/agent-kit/manifest";
import { thisAgent } from "../../lib/definition.js";
import { recordSchedulePass, recordScheduleTick } from "@lares/agent-kit/schedule-heartbeat";
import { configuredOwnerId, listAliases } from "../../lib/identity-client.js";
import { ownerId } from "../../lib/principals.js";
import { alreadySentToday, type InitiationOutcome } from "../../lib/initiation.js";
import { routeDelivery } from "../../lib/delivery.js";
import { sendTurn } from "../../lib/delivery-send.js";
import { scheduleHours } from "../../lib/schedule-hours.js";
import { ownerTz } from "../../lib/owner-clock.js";
import { homeTzFromEnv } from "@lares/agent-kit/owner-clock";
import type { BriefRender } from "../../lib/brief-strings.js";
import { googleClients, listEnrolledMailboxes } from "../../lib/google.js";
import { listEventsEverywhere, sourceGapLine } from "../../lib/calendar-fanout.js";
import { dateIn, slotIn } from "../../lib/recurrence.js";
import { labeledContext } from "@lares/compose-contract";
import {
  buildEveningBrief,
  listTomorrowMeetings,
  nightBeforeCoveredDay,
  commitmentLine,
  eventKindClauses,
  organisationLookupClause,
  splitCommitments,
  standingFactsBlock,
  standingFactsClause,
  transitClause,
  travelContextBlock,
  unavailableSourcesBlock,
  type BriefContent,
  type NightBeforeMeeting,
  type Obligation,
} from "../../lib/brief-content.js";
import { gatherOpenObligations } from "../../lib/obligation-pipeline.js";
import { withTimeout } from "../../lib/timeout.js";
import {
  ensureObligationsTableOnce,
  dismissedThreads,
  upsertSeen,
  markNightBeforeDelivered,
  resolvedThreads,
  markResolved,
  cachedIntent,
  recordIntent,
} from "../../lib/obligations-store.js";
import { resolveElsewhere } from "../../lib/obligation-resolution.js";
import { classifyIntent } from "../../lib/obligation-intent.js";
import { makeGmailSentAfter, makeCalendarEndedWith } from "../../lib/obligation-lookups.js";
import { gatewayComplete } from "../../lib/llm-complete.js";
import { emitSignal } from "../../lib/signal-emit.js";
import { errorDetail } from "../../lib/error-detail.js";
import { STANDING_FACTS_TIMEOUT_MS, listActiveFacts, type StandingFact } from "../../lib/standing-facts.js";
import { agentName } from "../../lib/agent-name.js";

// Logged once per process: the schedule ticks every minute, and a missing principal does not change between ticks.
let warnedNoPrincipal = false;

/**
 * 20_000 → 35_000, the base 20s plus `RESOLUTION_PASS_TIMEOUT_MS` (15s)
 * and nothing else, matching the arithmetic morning-brief.ts spells out at its own copy of this
 * constant. `gatherOpenObligations` now runs a cross-channel resolution check and a bounded
 * model read INSIDE this same budget; adding the stage's own budget on top is what keeps the
 * two additive rather than letting the new stage eat the Gmail scan's headroom.
 *
 * The same constant still bounds this pass's calendar read, which gained nothing from the cross-channel check —
 * it is simply the one budget this schedule has, and being 15s more generous to a read that
 * takes ~1s costs nothing but a slightly longer worst-case silence.
 *
 * AND IT IS SPENT TWICE PER TICK, exactly as in morning-brief.ts: `run` awaits tomorrow's calendar under this budget,
 * then — only after that resolves — the obligations gather under it again. Worst case moves from
 * 20 + 20 + 1.5 ≈ 41.5s to 35 + 35 + 1.5 ≈ 71.5s of a 60s tick, so this pass can now overrun the
 * minute where before it could not. Safe for the same STRUCTURAL reason: `running` makes the next
 * tick return immediately and `lastSlot` is stamped before the work starts, so an overrun SKIPS
 * ticks rather than double-sending. Anyone raising this again should double whatever they add.
 */
const OBLIGATION_TIMEOUT_MS = Number(process.env["OBLIGATION_TIMEOUT_MS"]) || 35_000;

/** `facts` defaults to `[]`. See buildMorningPrompt's own note for why standing
 *  facts ride as a parameter rather than as a `BriefContent` field. */
export function buildEveningPrompt(
  content: BriefContent,
  facts: readonly StandingFact[] = [],
  // See `buildMorningPrompt`'s own note; the two briefs render this
  // identically so a gap disclosed at 08:00 reads the same way at 20:00.
  unreadableSources: readonly string[] = [],
  // Rendering options; this brief only ever reads `render.tz` (it renders no
  // deadlines, so `lang` is unused here), same shape as `buildMorningPrompt`'s own `render`.
  // Omitting it defaults `tz` to the home zone (OWNER_HOME_TZ, UTC if unset).
  render: BriefRender = {},
): string {
  const tz = render.tz ?? homeTzFromEnv();
  // an all-day block has no clock time (rendering one would invent 02:00 from a UTC
  // midnight), and an attendee-less block is now normal — say so rather than print an empty
  // participants list the model might read as a gap it should fill.
  // lodging, flights and out-of-office markers are not commitments — they move to
  // their own block. Both renderers are shared with the morning brief on purpose: the two
  // briefs read the same `NightBeforeMeeting`, so they must render it the same way.
  const { commitments, travel } = splitCommitments(content.meetings);
  // The titles, locations and attendee names are somebody else's words: the rows ride only
  // inside a flagged block, the owner-side wording stays in the heading's label and note.
  const meetingLines = labeledContext([{
    label: "Tomorrow's calendar",
    note: "meetings, and the blocks the owner set aside",
    // GOTCHA — see morning-brief.ts's own note: `.map(commitmentLine)` would pass the
    // array index as `tz`, so this is wrapped in an arrow instead.
    content: commitments.map((m) => commitmentLine(m, tz)).join("\n"),
    emptyText: "(none)",
    thirdParty: true,
  }]);
  const travelSection = travelContextBlock(travel, tz);
  const factsSection = standingFactsBlock(facts);
  // A source that could not be read, named right under the calendar it is about.
  const unavailableSection = unavailableSourcesBlock(content.unavailable);

  // The counterparty's name and the mail's subject are outside text: flagged block, as above.
  const obligationLines = labeledContext([{
    label: "Owed a reply",
    note: "from people the owner is meeting tomorrow",
    content: content.obligations
        .map((o: Obligation) =>
          `- ${o.counterpartyName} <${o.counterpartyAddress}> — waiting ${o.ageHours}h` +
          `${o.isRePing ? ", they've written again since" : ""} — re: ${o.subject || "(no subject)"}` +
          // The same clause the morning brief renders, from the same
          // field, so the two briefs can never explain the same obligation differently.
          ` — why: ${o.reason ?? "on the radar"}`,
        )
        .join("\n"),
    emptyText: "(none)",
    thirdParty: true,
  }]);

  // A cross-channel lookup that could not be read, as a labeled block.
  // Mirrors `buildMorningPrompt`'s "Sources behind that list": the whole point is that a
  // shorter list must never be mistaken for a complete one.
  const obligationsSection = unreadableSources.length > 0
    ? `${obligationLines}\n\n${labeledContext([
        {
          label: "Sources behind that list",
          note: "one source could not be read — the list above is NOT the whole picture",
          content: `cross-channel check could not read: ${unreadableSources.join(", ")}`,
        },
      ])}`
    : obligationLines;

  return [
    "[scheduled turn — the evening prep pass. This is not a message from a person; it is your cue",
    "to prepare the owner for tomorrow.]",
    "",
    meetingLines,
    "",
    ...(unavailableSection ? [unavailableSection, ""] : []),
    ...(travelSection ? [travelSection, ""] : []),
    obligationsSection,
    "",
    // — what the owner has told the agent. Empty drops out entirely (`labeledContext`).
    ...(factsSection ? [factsSection, ""] : []),
    "For EACH participant listed above, call person_lookup now (pass their email) and read what",
    "comes back. Do not write about anyone you have not looked up, and do not fill a gap from",
    "memory. An entry with no participants needs no lookup — name it as what the owner's day holds and",
    "move on; never guess who might be there.",
    "",
    // — the ONE sentence about what an UNKNOWN lookup that still carries an ORGANISATION
    // section means. From lib/brief-content.ts so the two briefs cannot disagree; unconditional,
    // because whether a lookup comes back that way is only knowable at turn time.
    ...organisationLookupClause(),
    "Then write the owner one short message covering tomorrow: who they're meeting, what last came up and",
    "where things stand, plus anything the owner owes them from the list above — lead with that, it's",
    "why this arrives tonight rather than in the morning, while they can still act. Blocks without",
    "participants belong in the shape of the owner's day (when they are committed, and where), not as",
    "people to prepare for.",
    "",
    // — the same two clauses the morning brief uses, from the same helper, so the two
    // briefs can never disagree about what a hotel booking or a remote call means.
    ...eventKindClauses(commitments, travel),
    // — the same helper the morning brief calls, so the two can never disagree about
    // WHEN a real departure may be looked up. It matters more here: 20:00 is when there is still
    // an evening in which to act on "the 14:05 is the one".
    //
    // "tomorrow" is not decoration. This pass composes tonight about the day
    // after, so the journey's starting point is where the owner will be TOMORROW — and on the nights
    // this feature earns its keep (away, or travelling overnight) that is not where the owner is now.
    // The helper's `today` wording would point at a station in the wrong city.
    ...transitClause(commitments, travel, "tomorrow", tz, render.transit ?? true),
    // The same one sentence the morning brief carries, from the same helper, so the
    // two briefs can never disagree about what the owner's standing facts are FOR.
    ...standingFactsClause(facts),
    "TONE: Write to inform, not to prove checking happened. Never state that nothing is",
    "outstanding. Under 200 words. Plain prose.",
    "",
    // The same named prohibition the morning brief carries, for the same
    // reason: this turn is the app's, nothing in it is something the owner said, and both tools refuse
    // it anyway. Told AND blocked.
    "This is a PREPARATION message: REPORT ONLY. Take no action and propose nothing this turn —",
    "no emails, no drafts, no calendar changes, no reminders, no notes, no 👍 confirmation cards.",
    "Do not call `remember` or `forget` — the owner has said nothing on this turn, and a standing fact",
    "is only ever the owner's own words.",
  ].join("\n");
}

let lastSlot: string | null = null;
let running = false;

/** — the row input-freshness.sh reads; pinned to this filename by the conformance test. */
export const HEARTBEAT_KEY = "chief-of-staff/evening-brief";

export default defineSchedule({
  cron: "* * * * *",
  async run({ to, waitUntil, appAuth }) {
    const { loaded } = await thisAgent(undefined);
    if (!scheduleEnabled(loaded.definition, "evening-brief")) return;
    await recordScheduleTick(getPool(), HEARTBEAT_KEY);
    const now = new Date();
    // The owner clock, resolved once per tick and cached for five minutes (lib/owner-clock.ts).
    const tz = await ownerTz();
    // See morning-brief.ts's own note: the hour is a setting now, cached in-process
    // for a few minutes (lib/schedule-hours.ts).
    const [hour] = await scheduleHours("evening-brief");
    const slot = slotIn(now, tz, hour);
    if (!slot || slot === lastSlot) return;      // not in slot, or already fired today
    if (running) return;                          // previous turn still running

    lastSlot = slot;
    running = true;
    try {
      const pool = getPool();

      // See morning-brief.ts's own note on `alreadySentToday`: the hour can change
      // mid-day, and the ledger's dedupe is keyed on the slot (hour included), so this guard
      // holds "at most one per owner-day" a second way, checked before any of the gathering
      // below.
      const ownerToday = dateIn(now, tz);
      if (await alreadySentToday(pool, ownerId(), agentName(), "evening-brief", ownerToday)) {
        console.log(
          `evening-brief: already sent today (${ownerToday}) — skipping slot ${slot} ` +
          "(the hour setting changed after today's brief went out)",
        );
        await recordSchedulePass(pool, HEARTBEAT_KEY);
        return;
      }

      // Where this goes is the owner's choice (the definition's `delivery` map); without one, the
      // Telegram chat it always went to. Null = no door can carry it.
      const routed = routeDelivery("evening-brief", loaded);
      if (!routed) {
        if (!warnedNoPrincipal) {
          warnedNoPrincipal = true;
          console.warn("evening-brief: no door to deliver through (Telegram is not connected); skipping");
        }
        return;
      }

      await ensureObligationsTableOnce(pool);
      const myAddresses = () => listAliases(pool, configuredOwnerId(), "email");

      // A read that fails no longer stops the pass: the pass uses what could be read
      // and NAMES what could not (`unavailable`), so a shorter list is never mistaken for a whole
      // one. If nothing readable earns a send, the pass stays silent as it always did, and
      // tomorrow's morning brief carries the "not connected" line. Nothing is stamped for what
      // was not read, so the morning delta still reports it.
      const unavailable: string[] = [];
      let meetings: NightBeforeMeeting[];
      try {
        meetings = await withTimeout(
          (async () => {
            // every calendar of every wired account, not `primary` of one — the owner's
            // meetings live on shared and second-account calendars too.
            const listEvents = (o: { timeMin: string; timeMax: string; max: number }) =>
              listEventsEverywhere(
                {
                  accounts: () => listEnrolledMailboxes(),
                  clientFor: (account) => googleClients().calendar(account),
                },
                o,
              );
            // — "tomorrow" on the same owner clock that decided this IS the 20:00 slot.
            return listTomorrowMeetings({ listEvents, myAddresses }, now, tz);
          })(),
          OBLIGATION_TIMEOUT_MS,
          "evening-brief: tomorrow's calendar",
        );
      } catch (e) {
        console.error(`evening-brief: could not read tomorrow's calendar (slot ${slot}) — continuing without it`, e);
        unavailable.push(sourceGapLine("Calendar", e));
        meetings = [];
      }

      // See morning-brief.ts's own note: filled by the pass when a
      // cross-channel lookup could not be read, and rendered as a "Sources behind that list"
      // note so a shorter list is never mistaken for a complete one.
      let unreadableSources: string[] = [];
      let obligations: Obligation[];
      try {
        obligations = await withTimeout(
          (async () => {
            const gmail = await googleClients().gmail();
            // Built once per tick and shared with the morning pass by living in
            // lib/obligation-lookups.ts — the two briefs ask the identical question of the
            // identical accounts, and two copies would have drifted the first time one was tuned.
            const gmailSentAfter = makeGmailSentAfter(gmail, myAddresses);
            const calendarEndedWith = makeCalendarEndedWith({
              accounts: () => listEnrolledMailboxes(),
              clientFor: (account) => googleClients().calendar(account),
            });
            return gatherOpenObligations(
              {
                myAddresses,
                gmail: { searchThreadIds: gmail.searchThreadIds, readThread: gmail.readThread },
                dismissed: () => dismissedThreads(pool),
                upsertSeen: (o, seenAt) => upsertSeen(pool, o, seenAt, configuredOwnerId()),
                // ─── Cross-channel resolution ─────────────────────────────────────────
                // The same stage the morning pass runs, minus the Slack leg — this schedule
                // scans no Slack conversations (Slack obligations are morning-brief-only), so it has no own-activity map to consult
                // and answers "no evidence" rather than pretending to have looked. That is the
                // fail-open direction: an unconsulted source can only ever KEEP an obligation.
                resolved: () => resolvedThreads(pool),
                resolve: (o) =>
                  resolveElsewhere(
                    o,
                    { gmailSentAfter, calendarEndedWith, slackOwnMessageAfter: () => null },
                    now,
                  ),
                markResolved: (o, r) => markResolved(pool, o.threadId, { via: r.via, evidence: r.evidence, at: r.at }),
                // Two deps, not one — see morning-brief.ts's own note: the cap bounds model
                // calls, and a cache hit must not consume one.
                cachedIntent: (o) => cachedIntent(pool, o.threadId, o.lastMessageAt),
                classifyIntent: async (o) => {
                  // `maxRetries: 0` is what makes classifyIntent's "no retry, one bounded read"
                  // TRUE — the AI SDK defaults to 2 retries, which would have made
                  // INTENT_MAX_PER_PASS a ceiling of 24 model calls instead of 8.
                  const read = await classifyIntent(o, {
                    complete: (prompt, callOpts) => gatewayComplete(prompt, { ...callOpts, maxRetries: 0 }),
                  });
                  await recordIntent(pool, o.threadId, read, o.lastMessageAt);
                  return read;
                },
                onUnreadable: (sources) => { unreadableSources = sources; },
                // No `slack` here, DELIBERATELY — this pass pushes to Telegram via
                // `nightBefore` below, and Slack obligations are morning-brief-only (an
                // owner rule). `GatherObligationsDeps.slack`
                // is optional exactly so this omission compiles and behaves identically to
                // before the Slack leg existed. See morning-brief.ts's own call site for the one place it IS wired.
              },
              now,
            );
          })(),
          OBLIGATION_TIMEOUT_MS,
          "evening-brief: obligations",
        );
      } catch (e) {
        console.error(`evening-brief: could not gather obligations (slot ${slot}) — continuing without them`, e);
        unavailable.push(sourceGapLine("Email", e));
        obligations = [];
      }

      const content = buildEveningBrief({ meetings, obligations, unavailable });
      if (!content && unavailable.length > 0) {
        // Silent because a read FAILED, not because the evening was quiet: that is not a
        // completed pass, so nothing is stamped and the heartbeat stays honest.
        console.error(`evening-brief: skipping (slot ${slot}) — ${unavailable.join("; ")}; nothing sent`);
        return;
      }
      if (!content) {
        console.log(`evening-brief: nothing to say (slot ${slot}) — skipping send`);
        await recordSchedulePass(pool, HEARTBEAT_KEY); // a quiet evening IS a completed pass
        return;
      }

      // — best-effort, and the `.catch` is the whole point: the standing facts are
      // context, not content. A Postgres hiccup here must cost the agent the facts, never the brief.
      // BOUNDED, because `.catch` only fires on a rejection: an unresponsive `db`
      // container makes `pool.query` hang forever, and this brief's whole tick would hang with
      // it. `withTimeout` is what turns that stall into the rejection this catch handles.
      const facts = await withTimeout(
        // CANONICAL_USER_ID, not a resolved principal — see standing-facts.ts's tool call sites;
        // this schedule runs as the app principal, with no session user to resolve.
        listActiveFacts(pool, configuredOwnerId()),
        STANDING_FACTS_TIMEOUT_MS,
        "evening-brief: standing facts",
      ).catch((e) => {
        console.error("evening-brief: could not read standing facts — the brief goes out without them", e);
        return [];
      });

      const prompt = buildEveningPrompt(content, facts, unreadableSources, { tz, transit: isGranted(loaded.definition, "transit") });
      let initiation: InitiationOutcome;
      try {
        initiation = await routed.gate(
          { cls: "scheduled", itemKey: `evening-brief/${slot}`, now, tz },
          () => sendTurn(routed, { to, waitUntil, appAuth, telegram, slack }, prompt, {
            lane: "evening-brief", itemKey: `evening-brief/${slot}`, title: "Evening brief",
          }),
        );
      } catch (err) {
        console.error(`evening-brief: send FAILED (slot ${slot}) — nothing stamped; will be reconsidered tomorrow morning`, err);
        return;
      }
      if (!initiation.sent) {
        // Held back, or ALREADY SENT for this slot (a restart inside the same slot minute). Either
        // way this pass has nothing further to do: the obligations stay unmarked on a hold, so
        // tomorrow's morning brief reports them, and on an already-seen the send that DID go out
        // ran its own stamping. The PASS is stamped either way — the schedule ran and did exactly
        // what the owner's settings asked of it.
        await recordSchedulePass(pool, HEARTBEAT_KEY);
        return;
      }

      // Stamp ONLY after the send has actually gone out — see buildEveningBrief's own
      // doc-comment. Marking on an unconfirmed send would suppress tomorrow's copy of a
      // message the owner never received.
      // — the owner's tomorrow, the day the meetings above were listed for; the morning
      // pass reads it back as ITS today on the same clock (`dateIn(now, tz)`).
      const day = nightBeforeCoveredDay(now, tz);
      for (const o of content.obligations) {
        await markNightBeforeDelivered(pool, o.threadId, { day, principal: configuredOwnerId(), now }).catch((e) =>
          console.error(`evening-brief: failed to record delivery of thread ${o.threadId} (tomorrow's brief will report it again)`, e),
        );
      }
      console.log(
        `evening-brief: delivered (slot ${slot}) — ${content.meetings.length} meeting(s), ` +
        `${content.obligations.length} obligation(s) stamped for ${day}`,
      );
      await emitSignal("brief-sent", "Evening brief sent", undefined, {
        kind: "event", severity: "info", key: "evening-brief",
      });
      await recordSchedulePass(pool, HEARTBEAT_KEY);
    } catch (e) {
      console.error("evening-brief: tick failed", e);
      await emitSignal("schedule-tick-failed", "evening-brief: tick failed", errorDetail(e));
    } finally {
      running = false;
    }
  },
});
