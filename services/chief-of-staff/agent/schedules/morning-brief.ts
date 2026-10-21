/**
 * The morning brief — 08:00 on the owner's clock. What's on the owner's plate today, as a prioritised list: TODAY's
 * commitments, the obligations that are new or changed since last night's pass, and notes that
 * entered the Brain recently.
 *
 * CONTRACT: the morning brief must say what is on the owner's plate, in a priority
 * list, with changes called out. A pure delta would say nothing about the day itself — it could
 * report one owed reply while the calendar held a full day of appointments. The
 * obligations half is still a delta; the calendar half deliberately is not, because at 08:00
 * the day's fixed points are the frame everything else hangs on and the evening pass is 12
 * hours stale.
 *
 * DELIBERATE CONTRACT (see `lib/brief-content.ts`'s header): if `buildMorningBrief` returns
 * `null`, NOTHING is sent. Silence is still correct on a morning with no meetings, no delta
 * and no new reading.
 *
 * The dedupe key is `night_before_delivered_day` for TODAY's date on the owner's clock (`lib/obligations-store.ts`'s `nightBeforeDelivered`) — the mark last night's 20:00 pass
 * wrote for "tomorrow" as of ITS clock, which is "today" as of this one. Anything not stamped
 * is new or changed since then and belongs in the delta.
 *
 * TIMEZONE: same "poll every minute, gate on the wall clock" shape as `evening-brief.ts` — see
 * that file's header for why a fixed cron string cannot itself track a seasonal offset. The clock is the
 * OWNER's (`ownerTz` → `slotIn`), which equals the home zone at home and moves the 08:00 with the
 * owner on any other day.
 *
 * PROACTIVITY: the send passes `@lares/agent-kit`'s gate as a `scheduled` initiation
 * keyed on the slot, and the brief gains ONE line — `heldBackLine` — naming what that gate kept
 * from the owner since yesterday's brief. That line is the trade: the gate may stay
 * quiet, but it never gets to be silent about having been quiet.
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
import { deferredSince } from "@lares/agent-kit/proactivity";
import { googleClients, listEnrolledMailboxes } from "../../lib/google.js";
import { listEventsEverywhere, sourceGapLine } from "../../lib/calendar-fanout.js";
import { resolveConflicts } from "../../lib/conflict-resolution.js";
import { dateIn, slotIn } from "../../lib/recurrence.js";
import {
  buildMorningBrief,
  heldBackLine,
  conflictsBlock,
  conflictsClause,
  signalsBlock,
  signalsClause,
  deadlinesBlock,
  deadlinesClause,
  CANDIDATE_LINES_MAX,
  listTodayCalendar,
  readIngestedPicks,
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
  type CandidateLine,
  type DayCalendar,
  type DeadlineLine,
  type IngestedPick,
  type NightBeforeMeeting,
  type Obligation,
  type ThreadSnapshot,
} from "../../lib/brief-content.js";
import { gatherOpenObligations } from "../../lib/obligation-pipeline.js";
import { daysToDue, mentionsToday } from "@lares/agent-kit/deadlines";
import {
  listDeadlines,
  markCandidatesSurfaced,
  unsurfacedCandidates,
  upsertCandidate,
  type CandidateRow,
} from "../../lib/deadlines-store.js";
import { withTimeout } from "../../lib/timeout.js";
import { readBriefLanguage } from "../../lib/brief-settings.js";
import type { BriefRender } from "../../lib/brief-strings.js";
import { SlackScanAbortedError, scanSlackThreadsWithOwnActivity, type SlackScanOptions, type SlackSourceDeps } from "../../lib/brief-content-slack.js";
import { createSlackSourceDeps, resolveSlackToken, SlackNotConfiguredError } from "../../lib/slack-source.js";
import { labeledContext } from "@lares/compose-contract";
import {
  ensureObligationsTableOnce,
  dismissedThreads,
  upsertSeen,
  nightBeforeDelivered,
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
import { makeSignalsClient, SignalsNotConfiguredError, type SignalRow } from "@lares/agent-kit/signals-client";
import { agentName } from "../../lib/agent-name.js";

// Logged once per process: the schedule ticks every minute, and a missing principal does not change between ticks.
let warnedNoPrincipal = false;

/**
 * Raised from 20_000 to 28_000. `gatherOpenObligations` awaits Gmail
 * FIRST, then (only after Gmail resolves) calls `deps.slack` — so on this schedule the two
 * sources are effectively SERIAL inside one shared race, not concurrent: total time can
 * approach Gmail's own duration PLUS up to the full `SLACK_SCAN_TIMEOUT_MS` sub-timeout below.
 * At the old 20s budget, a Gmail scan finishing at 13s — comfortably safe before the Slack leg —
 * would now blank the brief once Slack's sub-budget is added on top. 28s makes Slack's
 * sub-budget genuinely additive rather than stolen from Gmail.
 *
 * WHAT ONE TICK ACTUALLY COSTS (the calendar read has no budget of its own: `run` wraps that read
 * in THIS same `OBLIGATION_TIMEOUT_MS`). THIS CONSTANT IS SPENT TWICE PER TICK, and that is the fact every
 * revision of it has to be multiplied by: `run` awaits today's calendar under it, then — only
 * after that resolves — the obligations gather under it again. The four sequential awaits, worst
 * case: today's calendar `OBLIGATION_TIMEOUT_MS` + the obligations gather `OBLIGATION_TIMEOUT_MS`
 * + the standing-facts read 1.5s (`STANDING_FACTS_TIMEOUT_MS`) + `nightBeforeDelivered`, which
 * carries NO timeout at all. So a slow morning genuinely can overrun the minute. It is safe
 * anyway, and for a structural reason rather than a budgetary one: `running` makes the next tick
 * return immediately while this one is in flight, and `lastSlot` is stamped before the work
 * starts, so an overrun SKIPS ticks — it never double-sends and never queues. The right reading
 * of these budgets is "how long a bad morning may stay silent", not "how much of the minute is
 * left". (At 's 28s that was ~57.5s; see the note below for what it is today.)
 *
 * — UNCHANGED at 28s, and that is a measured decision rather than an untouched default.
 * Raising Slack's sub-budget to 20s leaves the Gmail half 8s of this shared 28s, which sounded
 * tight until it was measured on the box the same morning: `scanThreads` against the owner's real
 * mailboxes took ~1.0s wall (one `threads.list` at ~355 ms, then 14 `readThread` calls run
 * CONCURRENTLY by `mapWithConcurrency`, which is why the 3.4s of summed call time costs about a
 * second of clock). 8s is ~8x that. Widening this instead would have pushed calendar +
 * obligations past the 60s tick the paragraph above relies on, to buy headroom over a number
 * that is already an order of magnitude clear.
 *
 * 28_000 → 43_000, which is the base 28s PLUS `RESOLUTION_PASS_TIMEOUT_MS`
 * (15s) and nothing else. `gatherOpenObligations` gained a stage that runs INSIDE this same
 * budget: after the Gmail and Slack scans, each surviving candidate gets a cross-channel
 * resolution check (four metadata lookups, bounded per-source at 5s, four candidates in flight)
 * and then, for the oldest eight, one bounded model read of the counterparty's last message.
 * That stage carries its OWN 15s budget and — this is the point of giving it one — blowing it
 * keeps every candidate rather than failing the gather. Adding 15s here is what makes those two
 * budgets additive instead of the new stage quietly eating the scans' headroom, the exact shape
 * of the bug this constant was raised for the first time.
 *
 * THE WORST CASE IS NOW ~87.5s of a 60s tick: 43s + 43s + 1.5s. Raising this constant by 15s
 * costs the tick THIRTY, not fifteen, because the paragraph above is spent twice — the branch
 * review caught this stated as ~72.5s, which is what you get by adding the stage to only one of
 * the two awaits. It stays safe for the same STRUCTURAL reason (`running` + `lastSlot` make an
 * overrun skip ticks, never double-send), and these numbers still bound how long a bad morning
 * may stay silent rather than how much of the minute is left — but anyone raising this again
 * should double whatever they add before deciding it is affordable.
 */
const OBLIGATION_TIMEOUT_MS = Number(process.env["OBLIGATION_TIMEOUT_MS"]) || 43_000;

/**
 * The Slack scan's OWN budget, well under
 * `OBLIGATION_TIMEOUT_MS` (the shared gather budget both Gmail and Slack sit inside). Without
 * this, a merely SLOW Slack scan — not a fast failure — rides the shared 20s timeout to its
 * failure mode: `gatherOpenObligations`'s best-effort catch only helps when `deps.slack`
 * rejects; `withTimeout` in morning-brief.ts's own `run` is a `Promise.race` around the
 * WHOLE `gatherOpenObligations` call, so once it fires it discards the Gmail snapshots already
 * collected and the brief sends nothing at all. Bounding the scan HERE instead means a
 * hung/slow scan rejects on its own clock, landing squarely in `gatherOpenObligations`'s
 * existing best-effort catch (Gmail-only) well before the shared budget is ever in danger.
 *
 * — 8_000 → 20_000, and this number is MEASURED, not guessed. The 8s above was a first
 * estimate whose own docblock said "revisit upward once a few real mornings have been
 * observed"; the very first real morning blew it, and the brief went out
 * Gmail-only. So the scan was run three times out of schedule on the installation's box,
 * at the live cap of 40 conversations against the owner's real workspace:
 *
 *   run 1: 8671 ms   run 2: 8405 ms   run 3: 8343 ms   (84 conversations enrolled, 7 snapshots)
 *
 * Reliably ~8.5s, i.e. ~5% OVER the old budget — which is exactly why it failed on the first
 * try and why a guess a little higher would have been a coin flip too. The cost is round-trips,
 * not bytes: `listConversations` is one call (~300 ms), then 40 SERIAL `conversations.history`
 * calls at ~180 ms each (~7.1s, the bulk of it) plus ~7 `users.info` identity lookups at
 * ~155 ms (~1.1s). That shape is why INCREMENTALITY was considered and rejected here: a
 * per-conversation watermark would shrink the messages each call returns, but the scan would
 * still pay the same 40 round-trips, so it would buy almost none of the 8.5s back while adding
 * a cursor store to keep correct. The honest fix for a scan that is simply this size is a
 * budget that fits it.
 *
 * 20_000 is ~2.3x the measured duration — headroom for a Slack or squid-proxy day twice as slow
 * as this one, without pretending latency can never move. It still sits inside
 * `OBLIGATION_TIMEOUT_MS` with room for the Gmail half, which was measured the same morning at
 * ~1.0s wall (14 threads, read concurrently) — see that constant's own note.
 *
 * And unlike before, exceeding this budget now CANCELS the scan (`scanSlackWithBudget` below)
 * rather than leaving it running with nobody to read the answer.
 */
const SLACK_SCAN_TIMEOUT_MS = Number(process.env["SLACK_SCAN_TIMEOUT_MS"]) || 20_000;

/**
 * Deliberately conservative for the first live mornings, not `DEFAULT_MAX_SLACK_CONVERSATIONS`
 * (200). `scanSlackThreads`'s real cost per conversation is NOT one call — one
 * `conversations.history` call per 100-message PAGE plus one `conversations.replies` call per
 * threaded parent it meets, all serial through the squid proxy
 * (brief-content-slack.ts:214-224 says as much about itself: "a busy, heavily-threaded
 * workspace can turn one morning-brief tick into hundreds of real Slack requests"). DMs are
 * what the obligation radar actually cares about and 40 leaves headroom without inviting a channel-heavy scan to blow
 * `SLACK_SCAN_TIMEOUT_MS`. Revisit upward once a few real mornings have been observed.
 *
 * MEASURED on one installation — a workspace of 84 conversations: exactly 40
 * `im` and 44 `channel`. Since `createSlackSourceDeps.listConversations` partitions DMs ahead
 * of channels, this cap currently consumes the DM half EXACTLY and reaches zero channels: every
 * channel thread set out to cover is unread, and the 41st DM the owner opens starts
 * pushing DMs off the end too. Left at 40 deliberately — a budget fix is not the place
 * to widen scope — but this is a coverage question someone has to rule on, not a
 * headroom margin. It is not free to widen: 40 conversations already cost ~8.5s of round-trips
 * (see `SLACK_SCAN_TIMEOUT_MS`), and channels cost MORE per conversation than DMs because the
 * reader also walks `conversations.replies` on every thread parent it meets.
 */
// 40 was exactly the DM count, so the DM-first partition consumed the whole cap
// and ZERO channels were ever scanned. 80 covers the real workspace (40 im + 44 channel,
// minus the four least-recent channels) and the pooled scan (concurrency 4, backoff on
// 429) holds it well inside the measured 20s budget — ~4.5s where 40 serial cost ~8.8s.
const SLACK_MAX_CONVERSATIONS = Number(process.env["SLACK_MAX_CONVERSATIONS"]) || 80;

/**
 * What one tick's Slack scan is willing to say about itself.
 *
 * Deliberately mutable and passed down rather than returned up: the scan sits behind
 * `gatherOpenObligations`'s best-effort catch, which is a one-way door for a thrown error. A
 * return value cannot climb back through it; a handed-in object can be written on the way past.
 */
export interface SlackScanStatus {
  /** The Slack half produced nothing usable this tick — timed out, threw, or never started
   *  (no token, wrong alias count). The brief must SAY so; see `SLACK_DROPPED_SOURCE_LINE`. */
  failed: boolean;
  /** Conversations `readConversation` was actually called for — the measured figure behind the
   *  duration log, not the `SLACK_MAX_CONVERSATIONS` cap. */
  conversationsScanned: number;
  /**
   * Slack user id → the latest message the OWNER sent that person, harvested by
   * the same scan that produced the snapshots (`scanSlackThreadsWithOwnActivity`). This is the
   * Slack leg of the cross-channel resolution check, and it rides here for exactly the reason
   * the docblock above gives: the scan sits behind `gatherOpenObligations`'s one-way
   * best-effort catch, so a return value cannot climb back out — a handed-in object can.
   *
   * Empty on a failed or unscanned pass, which is the safe reading: no evidence the owner answered on
   * Slack, so nothing is resolved away by a scan that did not happen.
   */
  ownLastMessageByUser: Map<string, Date>;
}

export function newSlackScanStatus(): SlackScanStatus {
  return { failed: false, conversationsScanned: 0, ownLastMessageByUser: new Map() };
}

/**
 * The sentence the brief carries when Slack could not be read.
 *
 * A constant, not inline prose, because it is the thing the regression test pins: the failure
 * this guards against is a brief that looked perfectly normal while covering one source
 * instead of two, and "looked normal" is not something a test can assert the absence of unless
 * the disclosure has a name.
 */
export const SLACK_DROPPED_SOURCE_LINE =
  "Slack obligations could not be read this morning — Gmail only.";

/**
 * The Slack half of `GatherObligationsDeps`. Morning brief ONLY: this function exists
 * here, in this schedule, and nowhere else — `evening-brief.ts` and `reping.ts` never build
 * one, which is what makes that rule structural rather than a rule someone has to remember (pinned by
 * a static check in tests/schedule-slack-d4.test.ts).
 *
 * `ownUserId` (the owner's Slack user id) comes from the identity registry — the SAME
 * `user_aliases` table `myAddresses` above already reads for email, just `system='slack'`
 * instead of `'email'` (seeded live at `U-EXAMPLE-ID`, `services/box/sql/001_baseline.sql`).
 * Deliberately not a new env var: an id already on file, read the same way every other
 * channel-native id in this file is, beats a second, driftable place to configure it.
 *
 * REQUIRES EXACTLY ONE Slack alias: `slackAliases[0]` on a registry
 * carrying two would silently pick whichever is oldest, with nothing cross-checking it against
 * the workspace the enrolled token actually authenticates for. A mismatched id would not
 * throw anywhere downstream — `scanSlackThreads` would classify the owner's own messages as the
 * COUNTERPARTY's and manufacture obligations out of the owner's own DMs, which is worse than any error
 * message. Zero or two-or-more both throw here, by name, rather than guessing.
 *
 * Every failure mode here (alias count wrong, no token enrolled, a Slack API error, a scan that
 * outruns `SLACK_SCAN_TIMEOUT_MS`) is a plain throw — `gatherOpenObligations` is the one place
 * that catches a `deps.slack` failure and degrades to Gmail-only.
 *
 * — that best-effort catch is exactly why this function now records its own failure in
 * `status` on the way out. `gatherOpenObligations` swallows the throw by design (a Slack outage
 * must never cost the owner their Gmail obligations), which means the throw alone reaches nobody: the
 * brief that morning was delivered, looked entirely normal, and quietly covered one source
 * instead of two. `status.failed` is the only channel by which the fact survives the catch and
 * reaches the prose. The try/catch is around EVERYTHING, not just the scan: an alias-count
 * mismatch or an unenrolled token drops Slack from the brief every bit as completely as a
 * timeout does.
 */
function buildSlackObligationSource(
  pool: ReturnType<typeof getPool>,
  now: Date,
  status: SlackScanStatus,
): () => Promise<ThreadSnapshot[]> {
  return async () => {
    try {
      // No Slack sign-in named at all is "not configured", checked before anything else.
      const token = await resolveSlackToken();
      const slackAliases = await listAliases(pool, configuredOwnerId(), "slack");
      if (slackAliases.length !== 1) {
        throw new Error(
          `morning-brief: expected exactly one Slack alias on file for the owner (user_aliases, ` +
          `system='slack'), found ${slackAliases.length} — refusing to guess which one authenticates ` +
          "the enrolled token; a mismatched id would misclassify his own messages as the " +
          "counterparty's and manufacture obligations",
        );
      }
      const ownUserId = slackAliases[0]!;
      return await scanSlackWithBudget(
        (signal) => createSlackSourceDeps({ token, ownUserId, signal }),
        { ownUserId, now: () => now, maxConversations: SLACK_MAX_CONVERSATIONS },
        status,
      );
    } catch (err) {
      if (err instanceof SlackNotConfiguredError) {
        // No Slack sign-in on this installation: leave the Slack section out, one log line, no error.
        console.log("morning-brief: no Slack sign-in configured — the brief goes out without Slack");
        return [];
      }
      status.failed = true;
      throw err;
    }
  };
}

/**
 * Wraps a reader so the tick knows how many conversations it ACTUALLY read.
 *
 * 's log line could only say "attempted up to 40" — `scanSlackThreads` returns snapshots
 * and nothing else, so the real figure was unavailable without editing that reviewed file. It
 * is available here for free, one level out, and it is the figure that matters: pairing it with
 * the duration is what turns "the scan is slow" into "40 conversations at ~180 ms each", which
 * is the difference between guessing at a budget and choosing one.
 *
 * Applied by `scanSlackWithBudget` itself, NOT by its callers. It began as a
 * wrapper the call site composed in, which meant a later simplification of
 * `buildSlackObligationSource` back to a bare `createSlackSourceDeps(...)` would have dropped it
 * with every test still green, and the next morning's log would have read "0 conversation(s)
 * scanned" — the exact silently-degraded zero this counter exists to distinguish from a real
 * one. Owned by the function that prints the number, it cannot be left out by accident.
 */
function countingDeps(inner: SlackSourceDeps, status: SlackScanStatus): SlackSourceDeps {
  return {
    listConversations: () => inner.listConversations(),
    readConversation: (id, oldest, ceiling) => {
      status.conversationsScanned++;
      return inner.readConversation(id, oldest, ceiling);
    },
    getUserInfo: (userId) => inner.getUserInfo(userId),
  };
}

/**
 * What the Slack scan's budget actually buys. Exported for tests: this is the unit
 * that has to hold the "bound it, cancel it, and admit it" behaviour, and it holds it without
 * a pool, a token or a network.
 *
 * THE SCAN IS CANCELLED, NOT MERELY ABANDONED. `withTimeout` is a `Promise.race`: before this,
 * a scan that outran its budget kept walking conversations in the background long after the
 * gather had moved on Gmail-only — the file's own note admitted it and called it "accepted, not
 * free". It stopped being free the first morning it fired, and it was never really harmless:
 * the abandoned work goes on spending Tier-3 Slack requests against the same shared per-token
 * ceiling the NEXT morning's scan needs. The `AbortSignal` handed to `makeDeps` reaches every
 * in-flight `fetch` (lib/slack-source.ts), so the timeout now actually stops the scan.
 *
 * `makeDeps` is a FACTORY rather than a ready-made `SlackSourceDeps` because the signal has to
 * exist before the reader does — `createSlackSourceDeps` binds it at construction. Whatever it
 * returns is wrapped in `countingDeps` HERE, so the conversation count in the log below can
 * never be silently lost by a caller that stopped composing it in.
 *
 * No `.catch` is attached to the racing scan promise: `Promise.race` itself subscribes to
 * both sides, so a late rejection from the losing promise is delivered to an already-settled
 * handler and can never surface as an unhandled rejection.
 */
export async function scanSlackWithBudget(
  makeDeps: (signal: AbortSignal) => SlackSourceDeps,
  opts: SlackScanOptions,
  status: SlackScanStatus,
  budgetMs: number = SLACK_SCAN_TIMEOUT_MS,
): Promise<ThreadSnapshot[]> {
  const controller = new AbortController();
  const startedAt = Date.now();
  try {
    // `scanSlackThreadsWithOwnActivity`, not `scanSlackThreads`: the same
    // walk over the same conversations also yields "the last time the owner wrote to this person",
    // which is the Slack leg of the cross-channel resolution check. Free here (the messages are
    // already in hand) and unobtainable anywhere else without a second scan.
    const { snapshots, ownLastMessageByUser } = await withTimeout(
      // the signal reaches the OPTIONS too, not only the reader — the rate-limit
      // backoff sleeps, and a sleep the budget cannot cancel would outlive the race.
      scanSlackThreadsWithOwnActivity(countingDeps(makeDeps(controller.signal), status), { ...opts, signal: controller.signal }),
      budgetMs,
      "morning-brief: slack scan",
    );
    status.ownLastMessageByUser = ownLastMessageByUser;
    // The success path would otherwise be unobservable: a real zero
    // (nothing owed on Slack) and a silently-degraded zero (wrong scope, empty conversation
    // list, a `maxConversations` cut that excluded every DM) would look identical in the logs.
    // A past dream-cycle run logged success while
    // reflecting on nothing for six days. This logs the duration and the real conversation
    // count, so the next person to touch the budget can read the number instead of estimating
    // it.
    console.log(
      `morning-brief: slack scan — ${Date.now() - startedAt}ms, ` +
      `${status.conversationsScanned} conversation(s) scanned (cap ${SLACK_MAX_CONVERSATIONS}), ` +
      `${snapshots.length} snapshot(s) returned, budget ${budgetMs}ms`,
    );
    return snapshots;
  } catch (err) {
    status.failed = true;
    // Cancels whatever the scan still had in flight. A NAMED reason rather than a
    // bare `abort`: the reason is what every cancelled Slack call rejects with, and
    // `resolveIdentity` has to be able to tell that apart from a real `getUserInfo` failure —
    // otherwise cancellation prints as "degrading to a Slack-id-only identity". The original
    // error rides along as `cause`, so nothing is lost by wrapping it.
    controller.abort(
      new SlackScanAbortedError(
        `morning-brief: slack scan cancelled after ${Date.now() - startedAt}ms (budget ${budgetMs}ms)`,
        { cause: err },
      ),
    );
    console.error(
      `morning-brief: slack scan FAILED after ${Date.now() - startedAt}ms ` +
      `(${status.conversationsScanned} conversation(s) scanned, budget ${budgetMs}ms) — ` +
      "the brief will say so rather than quietly cover Gmail only",
      err,
    );
    throw err;
  }
}

/**
 * `facts` defaults to `[]`. An optional trailing parameter rather than a new
 * `BriefContent` field on purpose: `BriefContent` is what `buildMorningBrief` DERIVES from the
 * day's calendar and mail (and whose emptiness decides whether a brief is sent at all), while
 * standing facts are ambient context that neither derives from the day nor should ever make a
 * brief happen. Every existing call site and test literal keeps meaning exactly what it meant.
 */
export function buildMorningPrompt(
  content: BriefContent,
  facts: readonly StandingFact[] = [],
  // The cross-channel resolution sources that could not be read on this
  // pass (`gatherOpenObligations`'s `onUnreadable`). Trailing and optional for the same reason
  // as the one above: omitting it renders exactly the brief rendered.
  unreadableSources: readonly string[] = [],
  // — `heldBackLine`'s one sentence about what the proactivity gate kept from the owner since
  // yesterday's brief, or null on a day it kept nothing (which is every day under the default
  // settings). Trailing and optional for the same reason as the three above: omitting it renders
  // exactly the brief rendered.
  heldBack: string | null = null,
  // Rendering options: the brief's language and its clock. Trailing
  // and optional for the same reason as the four above: omitting `render` entirely defaults
  // `lang` to `"en"` and `tz` to the home zone (OWNER_HOME_TZ, UTC if unset); `lang` changes only
  // the six structural strings and the clock-reading calls; every other line of this prompt is
  // unchanged.
  render: BriefRender = {},
): string {
  const lang = render.lang ?? "en";
  const tz = render.tz ?? homeTzFromEnv();
  // — a hotel booking and a flight are not commitments and are not whereabouts, so
  // they never reach the calendar block at all; they get their own labeled block below. The
  // row renderers live in lib/brief-content.ts so this brief and the evening one cannot drift.
  const { commitments, travel } = splitCommitments(content.meetings);
  // The titles, locations and attendee names are somebody else's words: the rows ride only
  // inside a flagged block, the owner-side wording stays in the heading's label and note.
  const meetingLines = labeledContext([{
    label: "Today's calendar",
    note: "meetings, and the blocks he set aside",
    // GOTCHA — `commitments.map(commitmentLine)` would pass the array INDEX as
    // `commitmentLine`'s second argument (`tz`) now that it takes one; wrapped in an arrow so
    // every row gets the real `tz` instead of a number.
    content: commitments.map((m) => commitmentLine(m, tz)).join("\n"),
    emptyText: "(none)",
    thirdParty: true,
  }]);
  const travelSection = travelContextBlock(travel, tz);
  const factsSection = standingFactsBlock(facts);
  // — "" on a day the radar found nothing, which drops the block entirely. Rendered
  // right under the calendar because that is what it is about: a clash is a property of the
  // rows above it, not a separate subject.
  const conflictsSection = conflictsBlock(content.conflicts ?? [], lang);
  const signalsSection = signalsBlock(content.signals ?? []);
  // A source that could not be read (typically Google on a fresh installation), named
  // right under the calendar it is about. "" when every source was read.
  const unavailableSection = unavailableSourcesBlock(content.unavailable);
  // "" on a morning with nothing due and nothing to offer, which drops the block
  // entirely. Rendered under the calendar and travel and ABOVE the owed-a-reply heading, because
  // a statutory due date is a fixed point of the owner's day and not a person waiting on the owner — the same
  // distinction enforced on the other side of the pipeline.
  const deadlinesSection = deadlinesBlock(content.deadlines ?? [], content.deadlineCandidates ?? [], lang);

  // The counterparty's name and the mail's subject are outside text: flagged block, as above.
  const obligationLines = labeledContext([{
    label: "Owed a reply",
    note: "new or changed since last night's evening pass",
    content: content.obligations
        .map((o: Obligation) =>
          `- ${o.counterpartyName} <${o.counterpartyAddress}> — waiting ${o.ageHours}h` +
          `${o.isRePing ? ", they've written again since" : ""} — re: ${o.subject || "(no subject)"}` +
          // WHY this line is here, from the pipeline that put it here.
          // `?? "on the radar"` rather than an omitted clause: a line whose reason is missing is
          // still a line the owner has to judge, and "on the radar" is the honest floor — it claims the
          // fact (it is owed) without claiming the reading (that it still needs the owner).
          ` — why: ${o.reason ?? "on the radar"}`,
        )
        .join("\n"),
    // An EMPTY obligations list means two different things, and a bare
    // "(none)" only honestly renders one of them. `ContextBlock`'s own docblock
    // (@lares/compose-contract) draws the line: "none" is a factual claim, and a read that threw
    // has not earned it. With Slack unread, "none" is true of Gmail and unknown of Slack, so the
    // line says exactly that much and no more.
    emptyText: content.slackUnavailable ? "(none from Gmail)" : "(none)",
    thirdParty: true,
  }]);

  // The dropped source, rendered as a LABELED BLOCK rather than loose prose.
  // `@lares/compose-contract` already owns this distinction: `absentBlockClause` spells out
  // that an empty block is a fact obtained ("nothing to report") while a missing one is no
  // information at all, and `labeledContext` is the renderer that keeps the two apart. The
  // obligations list above prints "(none)" when it is genuinely empty; without this block a
  // Slack outage would print the very same "(none)" and mean something entirely different.
  // Nothing is added to the contract itself — the invariant clauses stay byte-stable; this is
  // the brief's own block, using the contract's own mechanism.
  //
  // The SAME block now carries a second kind of gap: a cross-channel
  // resolution lookup that could not be read. One heading, two possible lines, because they are
  // one fact from the owner's side ("something behind this list did not answer") and two headings would
  // read as two unrelated problems.
  const sourceGaps = [
    ...(content.slackUnavailable ? [SLACK_DROPPED_SOURCE_LINE] : []),
    ...(unreadableSources.length > 0
      ? [`cross-channel check could not read: ${unreadableSources.join(", ")}`]
      : []),
  ];
  const obligationsSection = sourceGaps.length > 0
    ? `${obligationLines}\n\n${labeledContext([
        {
          label: "Sources behind that list",
          note: "one source could not be read — the list above is NOT the whole picture",
          content: sourceGaps.join("\n"),
        },
      ])}`
    : obligationLines;

  // A saved page's title is the page author's text: flagged block, as above.
  const pickLines = labeledContext([{
    label: "Recently entered the Brain",
    note: "reading, not events or meetings",
    content: content.picks.map((p: IngestedPick) => `- ${p.title}${p.url ? ` — ${p.url}` : ""}`).join("\n"),
    emptyText: "(none)",
    thirdParty: true,
  }]);

  return [
    "[scheduled turn — the morning brief. This is not a message from a person; it is your cue",
    "to show him what's on his plate today.]",
    "",
    meetingLines,
    "",
    ...(unavailableSection ? [unavailableSection, ""] : []),
    ...(conflictsSection ? [conflictsSection, ""] : []),
    ...(travelSection ? [travelSection, ""] : []),
    ...(deadlinesSection ? [deadlinesSection, ""] : []),
    obligationsSection,
    "",
    // — what the gate held back since yesterday's brief. Right here, under the
    // obligations, because that is what it is about: things that tried to reach the owner and did not.
    // Absent on any day nothing was held, so a normal day's prompt is byte-identical.
    ...(heldBack ? [heldBack, ""] : []),
    ...(signalsSection ? [signalsSection, ""] : []),
    pickLines,
    "",
    // — what the owner has told the agent, as a labeled block. Empty drops out entirely
    // (`labeledContext`), so an agent with no memory yet reads exactly as before.
    ...(factsSection ? [factsSection, ""] : []),
    "For anyone in the obligations list you have not already looked up recently, call",
    "person_lookup (pass their email) before writing about them. An entry with no participants",
    "needs no lookup — name it as what his day holds and move on; never guess who might be there.",
    "",
    // — the ONE sentence about what an UNKNOWN lookup that still carries an ORGANISATION
    // section means. From lib/brief-content.ts so the two briefs cannot disagree; unconditional,
    // because whether a lookup comes back that way is only knowable at turn time.
    ...organisationLookupClause(),
    "Write him one short message: what's on his plate today, as a PRIORITISED list, most",
    "pressing first. Order it by what actually constrains him — a fixed point he has to be at",
    "or prepare for outranks a reply he owes, which outranks anything from the reading. Where an",
    "obligation is owed to someone he is seeing today, say so on that line; that pairing is the",
    "most useful thing this message can carry. Give times for the fixed points so the shape of",
    "the day is legible at a glance.",
    "",
    "The obligations block is a DELTA — it holds only what is new or changed since last night,",
    "so treat it as such and never imply it is everything outstanding. The calendar block is",
    "not a delta: list today's commitments even if last night's prep already mentioned them.",
    "",
    // — one sentence per block, and only when that block is there. See
    // `eventKindClauses` for why each exists; both are lessons from a real morning.
    ...eventKindClauses(commitments, travel),
    // — ONE sentence, and only on a day the radar found something. The block above
    // states the clash; this says the agent must PASS IT ON and stop there. Detection ships without
    // resolution on purpose, so the clause's second half is the whole guard rail: the agent does not
    // get to decide which of two hotels stands, and the agent certainly does not get to cancel one.
    ...conflictsClause(content.conflicts ?? []),
    ...signalsClause(content.signals ?? []),
    // — ONE sentence, and only on a morning the block is actually there. The block above
    // states the frister; this stops the agent folding them into the owed-a-reply list, which is the
    // one way the block can make the brief worse than it was without it.
    ...deadlinesClause(content.deadlines ?? [], content.deadlineCandidates ?? [], lang),
    // — ALWAYS emitted, every day, candidates or none. Only the LOOKUP INSTRUCTION is
    // gated on the day holding somewhere the owner has to get to (`transitCandidates`); the anti-estimate
    // ban inside `transitClause` is unconditional, and deleting this call on a quiet day would
    // delete the ban with it — the exact regression seen before. A READ, so the REPORT-ONLY block
    // below does not forbid it; named explicitly all the same, for the reason that block's own
    // note gives — a tool the agent MAY use in a brief is named, not left to inference.
    ...transitClause(commitments, travel, "today", tz, render.transit ?? true),
    // — ONE sentence, and only when the owner has actually told the agent something. The block
    // above is the facts; this is the instruction to act on them without being reminded,
    // which is the whole point of storing them.
    ...standingFactsClause(facts),
    // — ONE sentence, and only when a source actually dropped: the block above states
    // the fact, this tells the agent it must pass it on. Without it the agent reasonably summarises the
    // obligations and leaves the meta-note out, which is precisely the silent Gmail-only brief
    // this guards against.
    // The same sentence now covers an unreadable cross-channel lookup
    // too, gated on the same `sourceGaps` the block above renders. Gating the note and the
    // instruction on one value is what stops them drifting apart.
    ...(sourceGaps.length > 0
      ? [
          "One of the sources behind the obligations list could not be read this morning. Say so",
          "plainly, in one clause, and never present that list as everything outstanding.",
          "",
        ]
      : []),
    "TONE: Write to inform, not to prove checking happened. Never state that nothing is",
    "outstanding. Under 200 words. Plain prose — a short list is prose enough; no tables.",
    "",
    // `remember` and `forget` are named, not just implied by "no notes".
    // Both tools refuse this turn outright (it is the app's, not the owner's), but a prohibition the
    // model can read is worth more than a refusal it has to discover: nothing in a brief is
    // something the owner said, so there is never anything here to remember or to retire.
    //
    // `deadline_add` joins them, and for a sharper reason: the Frister block
    // ABOVE prints `legg til (deadline_add fromThreadId …)` on every candidate line, so this very
    // prompt hands the model the exact call to make. Those are choices for the OWNER, not instructions
    // to the brief; the tool refuses this turn too, and now says so here as well.
    "REPORT ONLY this turn: no emails, no drafts, no calendar changes, no reminders, no notes,",
    "no 👍 confirmation cards. Do not call `remember`, `forget` or `deadline_add` — he has said",
    "nothing on this turn; the add/ignore choices printed on a deadline line are HIS to make, not",
    "yours, and a standing fact is only ever his own words.",
  ].join("\n");
}

/**
 * The candidate lines ONE brief may carry: the oldest `CANDIDATE_LINES_MAX`, and
 * the rest left for later mornings.
 *
 * ORDER COMES FROM THE STORE. `unsurfacedCandidates` ends in `ORDER BY seen_at ASC`
 * (lib/deadlines-store.ts), so the slice takes the oldest sightings; this function deliberately
 * does not re-sort. If that `ORDER BY` is ever removed, this comment is the thing that breaks —
 * fix it here, not by hoping.
 *
 * Exported because it decides two things at once that a test has to be able to see together: what
 * is RENDERED, and — since the caller stamps exactly what this returns — what is STAMPED. The
 * sixth candidate must be neither.
 */
export function briefCandidateLines(candidates: readonly CandidateRow[]): CandidateLine[] {
  return candidates.slice(0, CANDIDATE_LINES_MAX).map((c) => ({
    threadId: c.threadId,
    subject: c.subject,
    sender: c.sender,
  }));
}

/**
 * The candidate thread ids this tick may stamp `surfaced_at` — `sent` ONLY, never `handled`.
 *
 * THIS IS THE ONE PLACE THIS FILE DEPARTS FROM ADR 0014's `handled` RULE, and the departure is
 * the whole point of the function existing rather than an inline `if`. `handled` (`sent ||
 * alreadySeen`) is right for bookkeeping about an ITEM THE LEDGER KNOWS: the ledger's `sent` row
 * IS the proof the owner was told, so a lane re-detecting that item must finish its marks or loop
 * forever. That rule stays for every other write here.
 *
 * A surfaced candidate is not that. The ledger's item key is the SLOT (`morning-brief/<slot>`),
 * not the candidate — and the candidate list is recomputed from `unsurfacedCandidates` on EVERY
 * tick. So a due notice arriving between the tick that sent and a later suppressed tick in the
 * same slot gets rendered into a prompt NOBODY RECEIVES, and an `alreadySeen` stamp would then
 * mark it offered. It would never be offered again — a silent, permanent loss, and the exact
 * failure this block exists to prevent.
 *
 * On `sent` only, the two failure directions are: the sending tick's stamp write fails, and the
 * same candidates re-surface tomorrow (visible, harmless, self-correcting); or a later tick in
 * the slot renders an unreceived prompt and stamps nothing (no loss at all). Neither can lose the owner
 * an offer.
 */
export function candidatesToStamp(
  outcome: Pick<InitiationOutcome, "sent">,
  rendered: readonly CandidateLine[],
): string[] {
  return outcome.sent ? rendered.map((c) => c.threadId) : [];
}

let lastSlot: string | null = null;
let running = false;

/** — the row input-freshness.sh reads; pinned to this filename by the conformance test. */
export const HEARTBEAT_KEY = "chief-of-staff/morning-brief";

export default defineSchedule({
  cron: "* * * * *",
  async run({ to, waitUntil, appAuth }) {
    const { loaded } = await thisAgent(undefined);
    if (!scheduleEnabled(loaded.definition, "morning-brief")) return;
    await recordScheduleTick(getPool(), HEARTBEAT_KEY);
    const now = new Date();
    // The owner clock, resolved once per tick and cached for five minutes (lib/owner-clock.ts).
    // At home this is the home zone and the slot is the configured one.
    const tz = await ownerTz();
    // The hour is a setting (packages/agent-kit/src/schedule-settings.ts),
    // cached in-process for a few minutes (lib/schedule-hours.ts) so this per-minute tick does
    // not query Postgres for an answer that changes only a handful of times a year.
    const [hour] = await scheduleHours("morning-brief");
    const slot = slotIn(now, tz, hour);
    if (!slot || slot === lastSlot) return;
    if (running) return;

    lastSlot = slot;
    running = true;
    try {
      const pool = getPool();
      const ownerToday = dateIn(now, tz);

      // The hour can change MID-DAY now, and the ledger's dedupe is keyed on the
      // SLOT (`morning-brief/<owner date>T<hour>`), not the day: a hour moved after today's
      // brief already sent would give the new hour's tick a BRAND NEW key nobody has seen, and
      // the gate would happily send a second brief. This guard holds "at most one per owner-day"
      // across every hour, checked before any of the (expensive) gathering below — see
      // `alreadySentToday`'s own doc-comment for why this is not the ledger's own dedupe key.
      if (await alreadySentToday(pool, ownerId(), agentName(), "morning-brief", ownerToday)) {
        console.log(
          `morning-brief: already sent today (${ownerToday}) — skipping slot ${slot} ` +
          "(the hour setting changed after today's brief went out)",
        );
        await recordSchedulePass(pool, HEARTBEAT_KEY);
        return;
      }

      // Where this goes is the owner's choice (the definition's `delivery` map); without one, the
      // Telegram chat it always went to. Null = no door can carry it.
      const routed = routeDelivery("morning-brief", loaded);
      if (!routed) {
        if (!warnedNoPrincipal) {
          warnedNoPrincipal = true;
          console.warn("morning-brief: no door to deliver through (Telegram is not connected); skipping");
        }
        return;
      }

      await ensureObligationsTableOnce(pool);
      const myAddresses = () => listAliases(pool, configuredOwnerId(), "email");

      // A source that cannot be read no longer silences the brief: a fresh installation
      // without Google would otherwise never receive one. The brief goes out with what could be
      // read and NAMES what could not, in `unavailable`, so a missing source is never mistaken for
      // an empty one (absent is not empty, the same rule `slackUnavailable` carries).
      const unavailable: string[] = [];
      let today: DayCalendar;
      try {
        today = await withTimeout(
          (async () => {
            const listEvents = (o: { timeMin: string; timeMax: string; max: number }) =>
              listEventsEverywhere(
                {
                  accounts: () => listEnrolledMailboxes(),
                  clientFor: (account) => googleClients().calendar(account),
                },
                o,
              );
            // — the SAME read that builds today's rows also feeds the conflict pass;
            // `listTodayCalendar` fetches once and returns both. The rows are byte-for-byte
            // what `listTodayMeetings` returned here before.
            return listTodayCalendar({ listEvents, myAddresses }, now, { tz });
          })(),
          OBLIGATION_TIMEOUT_MS,
          "morning-brief: today's calendar",
        );
      } catch (e) {
        console.error(`morning-brief: could not read today's calendar (slot ${slot}) — the brief goes out without it`, e);
        unavailable.push(sourceGapLine("Calendar", e));
        today = { meetings: [], conflicts: [] };
      }
      const meetings: NightBeforeMeeting[] = today.meetings;

      // Check today's overlapping-stay clashes against mail, best-effort. Bounded
      // by `lib/conflict-resolution.ts`'s own caps: at most MAX_CLASHES_PER_PASS (3) clashes
      // searched, CLASH_TIMEOUT_MS (10s) each, so at most ~30s added to this tick in the worst
      // case — real, but a fixed ceiling, never an open-ended wait. `resolveConflicts` already
      // documents itself as never throwing (a per-clash failure costs that clash its plain flag
      // only, with one console.warn); the `.catch` here is belt-and-braces on top of that
      // promise, not a load-bearing guard — either way, a search that cannot finish costs the owner
      // the evidence for one morning, never the brief itself.
      const resolvedConflicts = await resolveConflicts(today.conflicts, {
        gmailFor: (account) => googleClients().gmail(account),
      }).catch((e) => {
        console.error(
          "morning-brief: could not check today's clashes against mail — the brief goes out with the plain flags",
          e,
        );
        return today.conflicts;
      });

      // — written by the Slack source on its way past gatherOpenObligations's
      // best-effort catch; the only way "a whole source dropped out" survives that catch and
      // reaches the prose below.
      const slackScan = newSlackScanStatus();
      // Filled once, by the pass, when a cross-channel lookup could not be
      // read. It reaches the prompt below so a silent lookup failure never looks like a clean
      // list; the same reasoning as 's `slackScan.failed`, one layer in.
      let unreadableSources: string[] = [];
      let obligations: Obligation[];
      try {
        obligations = await withTimeout(
          (async () => {
            const gmail = await googleClients().gmail();
            // Built ONCE per tick, then reused for every candidate: the
            // Gmail leg memoises the owner's address list, and both are shared verbatim with the
            // evening pass (lib/obligation-lookups.ts) so the two briefs cannot drift.
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
                // ─── Resolve elsewhere, read the last message, say why ──
                // Every one of these is optional in `GatherObligationsDeps`, and every failure
                // path inside the stage keeps the obligation. Nothing wired here can make the
                // radar quieter than it would have been without it.
                resolved: () => resolvedThreads(pool),
                resolve: (o) =>
                  resolveElsewhere(
                    o,
                    {
                      gmailSentAfter,
                      calendarEndedWith,
                      // In memory already — the scan above harvested it. `undefined` (a
                      // Gmail-sourced obligation, or a Slack pass that failed) reads as "no
                      // evidence", never as a resolution.
                      slackOwnMessageAfter: (uid, since) => {
                        const at = uid ? slackScan.ownLastMessageByUser.get(uid) : undefined;
                        return at && at.getTime() > since.getTime() ? at : null;
                      },
                    },
                    now,
                  ),
                markResolved: (o, r) => markResolved(pool, o.threadId, { via: r.via, evidence: r.evidence, at: r.at }),
                // Two deps, not one, because `INTENT_MAX_PER_PASS` bounds MODEL CALLS and a
                // cache hit is not one. Served together, a hit spent a cap slot and the ninth-
                // oldest obligation could never be read on any pass. `recordIntent` is UPDATE-only
                // and lands on the row `upsertSeen` wrote earlier in the same pass.
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
                // The due notices the scan flagged, recorded before
                // selection drops them. `ownerId`: this is the same key the deadline
                // reads below use, and the two must never come apart — a candidate written under
                // one key and read under the other is a sighting nobody is ever offered.
                // (`upsertSeen` above belongs to the OBLIGATIONS store, which has its own key;
                // this line is not it.) The store's own `ON CONFLICT DO NOTHING` makes a
                // re-sighting a no-op, so this runs on every tick without ever re-offering a mail
                // the owner already answered.
                recordCandidate: (c) => upsertCandidate(pool, { ...c, owner: ownerId() }),
                // Slack obligations reach the morning brief ONLY — this is the
                // one and only call site across the three obligation schedules that supplies
                // `slack`. gatherOpenObligations treats a Slack failure as best-effort (caught,
                // logged, Gmail-only continues), so this can never take out the brief — and
                // makes that degradation visible in the brief instead of silent.
                slack: buildSlackObligationSource(pool, now, slackScan),
              },
              now,
            );
          })(),
          OBLIGATION_TIMEOUT_MS,
          "morning-brief: obligations",
        );
      } catch (e) {
        console.error(`morning-brief: could not gather obligations (slot ${slot}) — the brief goes out without them`, e);
        unavailable.push(sourceGapLine("Email", e));
        obligations = [];
      }

      let deliveredLastNight: ReadonlySet<string>;
      try {
        // TODAY's date on the owner clock is exactly the day last night's 20:00 pass stamped: it
        // computed "tomorrow" from ITS clock, which is "today" from this one — see
        // lib/brief-content.ts's nightBeforeCoveredDay for why the two never drift (both
        // on the owner clock now; one of them left at home would match nothing abroad).
        deliveredLastNight = await nightBeforeDelivered(pool, ownerToday);
      } catch (e) {
        // Fail toward reporting: with no record of what last night covered, everything open is
        // reported again, which can repeat a line but never hides one.
        console.error(`morning-brief: could not read last night's delivery record (slot ${slot}) — reporting everything open`, e);
        deliveredLastNight = new Set<string>();
      }

      const picks = readIngestedPicks(process.env["BRIEF_PICKS_DIR"], now);

      // — the deadlines due today (or on a mention day) and the due-notice mails nobody
      // has been offered yet, read under ONE budget of their OWN.
      //
      // DELIBERATELY OUTSIDE `OBLIGATION_TIMEOUT_MS`. That constant is already spent twice per
      // tick (see its note), and adding a third leg to either race would make a slow deadline
      // read able to blank the calendar or the obligations — the exact additive-budget bug
      // was filed for. 5s is its own, and generous for two indexed reads against the
      // local Postgres.
      //
      // AND IT CAN NEVER COST THE OWNER THE BRIEF. Deadlines are CONTEXT: a brief that goes out
      // without them is a worse brief, a brief that does not go out is a missing morning. So the
      // `.catch` logs and yields empty lists, which renders exactly the pre-prompt.
      const { deadlines, deadlineCandidates } = await withTimeout(
        (async () => {
          const [rows, candidates] = await Promise.all([
            listDeadlines(pool, ownerId(), { status: "open", dueWithinDays: 30, now, tz }),
            unsurfacedCandidates(pool, ownerId()),
          ]);
          return {
            // `mentionsToday` (the kit) is the rule for WHICH of the open rows the brief names
            // today — a named list of mention days plus everything overdue, not a window. The
            // 30-day read above is only the cheap pre-filter that keeps the query small; the
            // rule is what decides.
            deadlines: rows
              .filter((r) => mentionsToday(
                { id: r.id, title: r.title, source: r.source, dueDate: r.dueDate, rung: r.rung, status: r.status },
                now,
                tz,
              ))
              .map((r): DeadlineLine => ({
                id: r.id,
                entity: r.entity,
                title: r.title,
                dueDate: r.dueDate,
                daysToDue: daysToDue(r.dueDate, now, tz),
                consequence: r.consequence,
                source: r.source,
                vendor: r.vendor,
                amount: r.amount,
                currency: r.currency,
              })),
            // fix 1 — the cap is applied HERE, where the list is built, so the ids
            // stamped below are exactly the ids rendered. The rest stay unstamped and drain on
            // later mornings.
            deadlineCandidates: briefCandidateLines(candidates),
          };
        })(),
        5_000,
        "morning-brief: deadlines",
      ).catch((e) => {
        console.error("morning-brief: could not read deadlines — the brief goes out without them", e);
        return { deadlines: [] as DeadlineLine[], deadlineCandidates: [] as CandidateLine[] };
      });

      // — the persisted spine is read directly (plain sealed egress, no Telegram proxy).
      // This is best-effort context: a spine outage is logged and must not cost the owner the rest of
      // the brief. Only errors and warnings belong in this exception block; info events do not.
      const signalClient = makeSignalsClient(() => ({
        tokenFile: process.env["SIGNAL_READ_TOKEN_FILE"] ?? "/run/secrets/signal-read-token",
        baseUrl: process.env["SIGNAL_SPINE_URL"],
        fetch,
      }));
      const signals: SignalRow[] = await withTimeout(
        signalClient.signalsRecent({ since: new Date(now.getTime() - 24 * 3600_000).toISOString(), limit: 100 }),
        5_000,
        "morning-brief: signals",
      ).then((rows) => rows.filter((row) => row.severity === "error" || row.severity === "warn"))
        .catch((error) => {
          if (error instanceof SignalsNotConfiguredError) {
            console.log("morning-brief: no signal source configured — the brief goes out without signals");
            return [] as SignalRow[];
          }
          console.error("morning-brief: could not read signal spine — the brief goes out without signals", error);
          return [] as SignalRow[];
        });

      const content = buildMorningBrief({
        meetings,
        obligations,
        deliveredLastNight,
        picks,
        slackUnavailable: slackScan.failed,
        unavailable,
        conflicts: resolvedConflicts,
        deadlines,
        deadlineCandidates,
        signals,
      });
      if (!content) {
        console.log(`morning-brief: nothing new (slot ${slot}) — skipping send`);
        await recordSchedulePass(pool, HEARTBEAT_KEY); // a quiet day IS a completed pass
        return;
      }

      // Best-effort, and the `.catch` is the whole point: the standing facts are
      // context, not content. A Postgres hiccup here must cost the agent the facts, never the brief.
      // BOUNDED, because `.catch` only fires on a rejection: an unresponsive `db`
      // container makes `pool.query` hang forever, and this brief's whole tick would hang with
      // it. `withTimeout` is what turns that stall into the rejection this catch handles.
      const facts = await withTimeout(
        // CANONICAL_USER_ID, not a resolved principal — see standing-facts.ts's tool call sites;
        // this schedule runs as the app principal, with no session user to resolve.
        listActiveFacts(pool, configuredOwnerId()),
        STANDING_FACTS_TIMEOUT_MS,
        "morning-brief: standing facts",
      ).catch((e) => {
        console.error("morning-brief: could not read standing facts — the brief goes out without them", e);
        return [];
      });

      // Read once per pass and handed to both `heldBackLine` and `buildMorningPrompt`
      // below, so the one line about held-back messages and the rest of the prompt never disagree
      // on language within the same brief. Never throws (see `readBriefLanguage`'s own contract),
      // so a settings-table outage costs the owner nothing beyond an English brief.
      const lang = await readBriefLanguage(pool, ownerId());

      // — what the gate held back since the PREVIOUS morning slot: one owner-day back
      // from this one. A DST boundary makes that an hour out at most, which cannot matter for a
      // count of waiting items, and `deferredSince` also counts every hold still OPEN whatever
      // its age — the 22:30 deferral released at 07:00 this morning is exactly the case this line
      // exists for. Never throws (it logs and reports none), so the brief still goes out.
      const heldBack = heldBackLine(
        await deferredSince(pool, ownerId(), new Date(now.getTime() - 24 * 3600_000)),
        lang,
      );

      const prompt = buildMorningPrompt(content, facts, unreadableSources, heldBack, { lang, tz, transit: isGranted(loaded.definition, "transit") });
      let initiation: InitiationOutcome;
      try {
        initiation = await routed.gate(
          { cls: "scheduled", itemKey: `morning-brief/${slot}`, now, tz },
          () => sendTurn(routed, { to, waitUntil, appAuth, telegram, slack }, prompt, {
            lane: "morning-brief", itemKey: `morning-brief/${slot}`, title: "Morning brief",
          }),
        );
      } catch (err) {
        console.error(`morning-brief: send FAILED (slot ${slot})`, err);
        return;
      }
      // — a candidate is offered ONCE, and "once" means once a prompt carrying it was
      // actually SENT. `candidatesToStamp` owns that rule and its docblock owns the argument for
      // why this one write departs from ADR 0014's `handled`; an `alreadySeen` tick stamps
      // nothing. Empty ids make `markCandidatesSurfaced` a no-op, so this is one guarded call
      // rather than a branch.
      //
      // Best-effort, like every other bookkeeping write here: a failed stamp costs a repeated
      // offer tomorrow, never the pass.
      await markCandidatesSurfaced(
        pool,
        ownerId(),
        candidatesToStamp(initiation, content.deadlineCandidates ?? []),
        now,
      ).catch((e) => {
        console.error("morning-brief: could not stamp deadline candidates as surfaced — they will be offered again", e);
      });

      if (!initiation.sent) {
        // Held back, or already sent for this slot — see evening-brief.ts's own note. The one
        // per-item stamp this brief has is skipped on both of
        // those outcomes by `candidatesToStamp`, so an offer nobody received is never marked
        // offered. A completed pass either way.
        await recordSchedulePass(pool, HEARTBEAT_KEY);
        return;
      }

      console.log(
        `morning-brief: delivered (slot ${slot}) — ${content.obligations.length} obligation(s), ` +
        `${content.picks.length} pick(s), ${content.conflicts?.length ?? 0} clash(es), ` +
        `${content.deadlines?.length ?? 0} deadline(s), ${content.deadlineCandidates?.length ?? 0} candidate(s)`,
      );
      await emitSignal("brief-sent", "Morning brief sent", undefined, {
        kind: "event", severity: "info", key: "morning-brief",
      });
      await recordSchedulePass(pool, HEARTBEAT_KEY);
    } catch (e) {
      console.error("morning-brief: tick failed", e);
      await emitSignal("schedule-tick-failed", "morning-brief: tick failed", errorDetail(e));
    } finally {
      running = false;
    }
  },
});
