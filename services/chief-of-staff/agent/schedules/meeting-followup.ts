/**
 * Meeting follow-ups — the eve schedule (ORB-156 Task 8). Every five minutes: poll the Notion
 * Meetings database, compose one recap-plus-action-items email per newly-summarised meeting,
 * and send it through the gated `meeting_followup_send` tool.
 *
 * THE TRIGGER NEEDS NO PROPERTY-DIFFING (design spec, "The trigger needs no property-diffing"):
 * fire when the structured summary block is non-empty AND `Attendees` is non-empty AND no
 * send-log row exists for the page yet. That is edge-free — it survives a missed tick, a
 * restart, a backfill, and a meeting summarised while this service was down — because
 * `meeting_followup_sent` (Task 5) already IS the trigger's memory; nothing here has to
 * remember what a row looked like last tick. Do NOT gate on Notion's `Status` property — all
 * 54 live rows read "Recorded", including every row with a complete summary (spec correction
 * 6); a `Status` gate would fire zero times, forever, silently.
 *
 * COST SAFETY (the Aug 14/15 lesson, docs/solutions/2026-08-15-api-cost-leak-proposal-retry-loop.md):
 * TWO SEPARATE ceilings, deliberately (ORB-156 fix round 3, Important — they bound different
 * costs and conflating them starves the queue):
 *
 *  - `FOLLOWUP_CEILING_PER_TICK` (5) bounds how many meetings one tick will act on — and,
 *    honestly, each one costs TWO billed calls, not one: the compose call (`gatewayComplete`)
 *    plus the model turn that invokes the gated `meeting_followup_send` tool
 *    (`to(...).send(...)` below). eve's HITL model requires an actual model turn to call a
 *    gated tool, so that second call is structural, not an oversight — collapsing the two is a
 *    recorded follow-up, not this round. Checked BEFORE `claim` in the engine, matching
 *    `email-triage.ts`'s own reasoning: a tick that has already spent its budget must not
 *    claim (and thereby spend an attempt on) rows it isn't going to process — leaving them
 *    unclaimed means the next tick's re-scan picks them up fresh instead of burning through
 *    `MAX_ATTEMPTS` on a starvation loop.
 *
 *    LAR-35-s3: BOTH of those billed calls used to run before anything asked whether Bendik
 *    could even be told about the result — a meeting summarised at 21:30 under the default
 *    quiet hours was composed and carded again on EVERY 5-minute tick until 07:00 (`releaseClaim`
 *    deliberately leaves a held row claimable on the very next tick, not after `RETRY_ELIGIBLE_AFTER`
 *    — see its own docblock), two billed calls each time. `FollowupDeps.precheck` (optional;
 *    `makeLivePrecheck` below) now asks the SAME question `wouldSend`/`wouldInitiate` answer for
 *    the real send-turn gate — cheaply, with no model call — BEFORE `compose` runs at all. A
 *    `held` precheck releases the claim (the attempt just spent nets back to zero, exactly like
 *    the send-turn's own held branch below) and the tick moves on having spent nothing but that
 *    one cheap gate read. The real gate still lives inside `makeLiveSend`, keyed by the identical
 *    `meetingFollowupItemKey(pageId, attempt)` expression, so a "send" precheck and the send-turn's
 *    own decision are asking about the exact same row — see "WHY `#<attempt>`" below for why the
 *    attempt number has to be part of that key at all.
 *  - `MARKDOWN_READ_CEILING` (15) bounds how many Notion PAGE READS `liveListMeetings` will
 *    make in one tick — a cheaper, non-billed cost, but still real load against Notion's
 *    ~3 req/s limit. It must be a SEPARATE, larger number than the compose ceiling: fix round
 *    2 originally applied one ceiling of 5 before readiness was even known, and fix round 3
 *    caught the resulting bug — a handful of rows whose `Summary` property is filled but whose
 *    `<summary>` block can never be extracted (the contradiction logged below) would occupy
 *    every one of those 5 slots, every tick, forever, and every genuinely-ready meeting behind
 *    them in the queue would never even get its markdown read, let alone composed. Reading
 *    more candidates than the compose ceiling allows means a few permanently-unready rows can
 *    no longer crowd out every ready one behind them.
 *
 * "SENT" IS NOT THE SCHEDULE'S TO SAY (ORB-156 fix round 2, CRITICAL). `to(...).send()`
 * resolves once the model's TURN ends — for a gated call that is the moment the approval card
 * *renders*, not the moment (if ever) mail leaves. Only `meeting_followup_send`'s own
 * `execute()` runs at the moment a send is genuinely authorised, so only it may write the
 * `"sent"` outcome (`agent/tools/meeting_followup_send.ts`). This schedule records the
 * strictly weaker `"queued"` after a successful turn dispatch — never re-COMPOSED and re-CARDED
 * on an unchanged page, which would re-bill and re-card the same meeting every five minutes
 * forever. `liveListMeetings` NO LONGER treats `queued` as fully done the way `sent`/`skipped`
 * are (LAR-28 changed this — see that function's own docblock): it is read again every tick so
 * `claimMeeting`'s hash-diff rule can tell "still nothing has changed" from "Bendik corrected the
 * page", but a genuinely unchanged `queued` or `denied` row is never reclaimed, so one lapsed or
 * declined follow-up still does not repeat on its own — Bendik can ask for it directly, or
 * correct the page and let the next tick pick it up.
 *
 * ORB-146: `meeting_followup_send` is gated, so every session this schedule opens must declare
 * its approver — `appAuth` is threaded onto every `to(...).send(...)` call below, exactly as
 * `crm-routing.ts`/`morning-brief.ts` already do; without it the gate breaks silently the first
 * time this fires.
 *
 * The "what I did" Slack line is a RAW `callSlackApi` postMessage (copying
 * `email-triage.ts:281-286`, not a session/model turn) and fires ONLY for a send that went out
 * with no card — an autonomous send never otherwise tells Bendik anything happened.
 *
 * PROACTIVITY (ORB-193 + LAR-35-s3): TWO gate calls now share ONE key per attempt,
 * `meeting-followup/<pageId>#<attempt>` (LAR-28 — see below for why the bare page id is no
 * longer enough) — `meetingFollowupItemKey(pageId, attempt)`, never restated:
 *
 *   1. The PRECHECK (`FollowupDeps.precheck`, `makeLivePrecheck` below), asked right after
 *      `claim`/the recipients check and BEFORE `compose` — the kit's `wouldSend` (via Saga's
 *      `wouldInitiate`), which records a hold exactly like the real gate but never a `sent` row.
 *      A `held` answer means the tick has spent NOTHING billed: no compose, no send-turn. The
 *      claim is released by the precheck itself, `held` is counted, and no outcome is recorded.
 *   2. The real gate, still inside `makeLiveSend`, asked around the send-turn — unchanged by
 *      this ticket. A held-back turn here HAS already paid for a compose call (the precheck said
 *      "send" a moment earlier, or no precheck was configured); the row stays non-terminal and
 *      its claim is RELEASED (`releaseClaim`) — a hold is not an attempt, because nothing was
 *      sent; counting it as one dropped a 21:30 follow-up before 22:30 under the default quiet
 *      hours (fix round 1).
 *
 * Both calls ask about the SAME row when the precheck says "send": the precheck's own read
 * writes nothing for a `send` verdict (`wouldSend`'s contract), so the real gate moments later
 * makes the actual decision and the only write. An ALREADY-SEEN outcome from EITHER call is the
 * opposite of a hold: the turn already ran, so the tick does its normal post-send bookkeeping.
 * (The "what I did" line is NOT separately gated — it is the receipt for a send Bendik already
 * authorised, in the same lane, moments earlier.)
 *
 * WHY `#<attempt>` (LAR-28, measured live 2026-09-14): a bare `meeting-followup/<pageId>` key made
 * a genuine RE-DRAFT indistinguishable from the ORIGINAL send-turn to the proactivity gate's own
 * memory. The Folkepuls incident: a denied card's send-turn had already run once (posted at
 * 09:00:27, ledger row `status = 'sent'` — meaning the INITIATION was sent, not the mail), so once
 * the page was corrected and the row reclaimed, the gate's already-seen check suppressed the
 * second send-turn outright — "already-seen is terminal by design" (ADR-0014) — and the schedule's
 * own bookkeeping then wrote the store row back to `queued`, `queued`ing a turn that never actually
 * ran a second time. `claimResult.attempt` (lib/meeting-followup-store.ts) is exactly the counter
 * that changes on every genuine reclaim and never on a retry of the SAME attempt, which is why it
 * — not the summary hash itself — is what the key carries: `deadlines.ts`'s `deadline/<id>#<rung>`
 * and `reping.ts`'s `reping/<threadId>#<unansweredCount>` are the same shape already proven
 * elsewhere in this file's own fleet.
 *
 * DENIED, AND WHY THE SCHEDULE DOES NOT WRITE IT (LAR-28): a human declining the approval card is
 * NOT something this schedule's own tick can observe — by the time a human taps, the send-turn's
 * `to(...).send()` already resolved and this tick has moved on (see "SENT IS NOT THE SCHEDULE'S TO
 * SAY" above; the same reasoning applies to "DENIED" being the schedule's to say, too). The only
 * code that IS running at the moment a decline is known is the resumed MODEL turn eve hands the
 * rejection back to — so `buildSendTurnPrompt` below tells the model, in the same turn it is asked
 * to call `meeting_followup_send`, to call the ungated `meeting_followup_record_denial`
 * (catalogue/) with the same `notionPageId` if that call comes back declined. The alternative this
 * ticket also considered — the schedule polling eve's own approval state for a verdict — has
 * nothing to poll: `meeting_followup_send`'s `followupApproval` (catalogue/meeting_followup_send.ts)
 * is a bespoke ratchet-backed policy, not the newer board's `approval_events` audit table
 * (packages/agent-kit/src/board-approval.ts), so no row anywhere records a human's tap. Once a page
 * is `denied`, `claimMeeting`'s hash-diff rule (lib/meeting-followup-store.ts) is what lets a LATER
 * correction re-open it — never a second, unprompted re-send of the identical card.
 *
 * ⚠️ NOTION CLIENT IS A TWIN, NOT A RE-HOME. eve-saga depends on `@lares/agent-kit` but not on
 * `services/notion-sync`, which is a separate service with its own Dockerfile/package.json and
 * its own full-featured Notion HTTP client (`services/notion-sync/lib/adapters/notion-client.ts`).
 * Reaching that client from eve-saga would need a workspace dependency + Dockerfile edit that
 * rebuilds a service this feature has nothing to do with — the exact class of cost the ORB-156
 * plan already paid once for the ratchet (`packages/agent-kit/src/ratchet.ts`'s own header) and
 * decided was not worth it for ~20 lines of accessor. The properties/data-source id/markdown
 * endpoint this schedule reads are a small, DOCUMENTED subset of notion-sync's own client,
 * mirrored below rather than imported. THE NOTION API IS THE SOURCE OF TRUTH; only this reader
 * is duplicated. This is new production surface for eve-saga (a Notion API token it did not
 * need before) that Task 9's "ship gated OFF" deploy step is the intended checkpoint for.
 */
import { readFileSync } from "node:fs";
import type { Pool } from "pg";

import { defineSchedule } from "eve/schedules";
import { callSlackApi } from "eve/channels/slack";

import slack from "../channels/slack.js";
import { slackCredentials } from "../channels/slack.js";
import { getPool } from "@lares/agent-kit/db";
import { scheduleEnabled } from "@lares/agent-kit/schedule-switch";
import { thisAgent } from "../../lib/definition.js";
import { recordSchedulePass } from "@lares/agent-kit/schedule-heartbeat";
import { KitRatchet } from "@lares/agent-kit/ratchet";
import { allowedSlackUserIds } from "../../lib/slack-allowlist.js";
import { listAliases, configuredOwnerId, getDisplayName } from "../../lib/identity-client.js";
import { makeDbVoiceAccess } from "../../lib/voice-store.js";
import { googleClients } from "../../lib/google.js";
import { buildVoiceBlock } from "../../lib/voice.js";
import { detectCounterpartLanguage, type Lang } from "@lares/compose-contract";
import { gatewayComplete } from "../../lib/llm-complete.js";
import {
  parseAttendees,
  filterActionItemsForExternals,
  parseActionItems,
  buildFollowupPrompt,
  priorCorrespondenceText,
  derivedSeriesKey,
  hashSummaryBlock,
  type FollowupInput,
  type FollowupDraft,
} from "../../lib/meeting-followup.js";
import {
  claimMeeting,
  releaseClaim,
  recordOutcome as storeRecordOutcome,
  recordSeriesKey as storeRecordSeriesKey,
  getOutcome as storeGetOutcome,
  pruneOldFollowups,
  lastRecipientsFingerprint,
  fingerprintRecipients,
  MAX_ATTEMPTS,
  type ClaimResult,
  type FollowupOutcome,
} from "../../lib/meeting-followup-store.js";
import { FOLLOWUP_AGENT, FOLLOWUP_CAPABILITY, isGroupAlias, type FollowupApprovalDeps } from "../../catalogue/meeting_followup_send.js";
import { emitSignal } from "../../lib/signal-emit.js";
import { doorId } from "../../lib/principals.js";
import { initiate, wouldInitiate } from "../../lib/initiation.js";

export const FOLLOWUP_CEILING_PER_TICK = 5;

/** Bounds `liveListMeetings`'s Notion PAGE READS per tick — deliberately WIDER than
 *  `FOLLOWUP_CEILING_PER_TICK`. See the module header's "COST SAFETY" section for why one
 *  ceiling applied before readiness is known can starve the queue forever. */
export const MARKDOWN_READ_CEILING = 15;

/**
 * THE INCIDENT THIS BOUNDS (2026-08-24, live, an hour after deploy): the trigger is "Summary
 * non-empty AND Attendees non-empty AND no send-log row for the page" — edge-free by design
 * (see the module header, "THE TRIGGER NEEDS NO PROPERTY-DIFFING"), but that also makes it
 * true of EVERY meeting the database has ever held on the very first tick after deploy. With
 * no recency bound, `liveListMeetings` worked backwards through 2025 oldest-first and would
 * have composed and carded roughly 49 meetings — up to a year old — within the hour: five
 * billed model calls and five approval cards landed before it was caught and contained BY
 * HAND, inserting `skipped` rows for every pre-existing meeting on the one live database. That
 * containment is a data guard, not a fix — a restored backup, a fresh database, or a newly-
 * shared Notion page reproduces the exact same failure. This constant is the CODE fix for
 * that failure mode — but it is a bound, not a solution: on a restored backup or a fresh
 * database, every meeting from the last two days is STILL eligible on the first tick, up to
 * `FOLLOWUP_CEILING_PER_TICK` (5) of them per tick, each a billed compose call. That is a
 * known, ACCEPTED limit (there is still no first-tick high-water mark), not an oversight — a
 * future reader debugging a surprise burst of follow-ups right after a restore should read
 * this paragraph, not assume the bound failed.
 *
 * Two days, specifically: the trigger normally fires within minutes of Notion finishing a
 * meeting's structured summary (ORB-155's own pipeline), so two days is generous headroom for
 * a weekend outage or a restart backlog catching up — while never being wide enough to reach
 * back into meeting history. If you are widening this number, re-read the paragraph above
 * first: that is what a wider number costs.
 */
export const FOLLOWUP_MAX_AGE_DAYS = 2;

/**
 * The OTHER end of the same bound (Important, post-fix review): `withinFollowupAge` originally
 * checked only "not too old", which is the identical fail-OPEN shape the incident above is
 * about, just facing the other direction — a meeting with a future or fat-fingered `Date`
 * (year 3025, a typo'd year) would have been permanently eligible and composed every tick
 * forever, since it never ages INTO the window from the future side. A small forward slack is
 * still allowed on purpose: a meeting can legitimately be summarised and marked ready a few
 * minutes before its own `Date.start` (early wrap-up, clock skew between Notion and this box),
 * and that must not be rejected as "not yet happened".
 */
export const FOLLOWUP_MAX_FUTURE_SLACK_MINUTES = 30;

/**
 * Pure recency gate — the honest seam for testing `FOLLOWUP_MAX_AGE_DAYS` and
 * `FOLLOWUP_MAX_FUTURE_SLACK_MINUTES` without Notion, a database, or the live clock. Keeps
 * only rows whose OWN meeting start time (`startsAt` — the Notion `Date` property; never a
 * page's creation time, never `processed_at`) falls within `FOLLOWUP_MAX_AGE_DAYS` in the past
 * AND within `FOLLOWUP_MAX_FUTURE_SLACK_MINUTES` in the future of `now`. A row with a missing
 * or unparseable `startsAt` is EXCLUDED, never included — failing OPEN on an unusable start
 * time is exactly the shape of the incident documented on `FOLLOWUP_MAX_AGE_DAYS` above, so
 * this narrows to `startsAt: string` on the way out: every survivor is proven to carry a real,
 * usable start time.
 *
 * Called from BOTH `liveListMeetings` (before any Notion page read) and `makeFollowupTick`
 * (before claiming/composing) — never re-implemented at either call site. `makeFollowupTick`'s
 * own header already says it must not silently trust `listMeetings`'s cap; an age check that
 * existed in only one of the two call sites is the exact "one place checked, and the
 * requirement was wrong there" shape that caused the original incident.
 */
export function withinFollowupAge<T extends { startsAt: string | undefined }>(
  rows: readonly T[],
  now: Date,
): (T & { startsAt: string })[] {
  const cutoffMs = now.getTime() - FOLLOWUP_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const futureCeilingMs = now.getTime() + FOLLOWUP_MAX_FUTURE_SLACK_MINUTES * 60 * 1000;
  return rows.filter((row): row is T & { startsAt: string } => {
    if (row.startsAt === undefined) return false;
    const t = Date.parse(row.startsAt);
    return Number.isFinite(t) && t >= cutoffMs && t <= futureCeilingMs;
  });
}

// ─── Testable tick ──────────────────────────────────────────────────────────────────────────

export interface MeetingRow {
  pageId: string;
  title: string;
  /** ISO datetime — governs oldest-first ordering. */
  startsAt: string;
  /** The calendar recurring-event id, or "" for a one-off meeting (never auto-approvable). */
  series: string;
  /** False only for a separately-booked series' first occurrence. */
  isStandingSeries?: boolean;
  /** The raw `Name <email>, …` string ORB-155 writes. */
  attendees: string;
  /** The page's structured `<meeting-notes><summary>` markdown — NOT the `Summary` property. */
  summaryBlock: string;
  /** The raw `Action Items` property, `<br>`-joined, footnote-anchored. */
  actionItems: string;
}

/** Mirrors `meeting_followup_send`'s input schema exactly — see that tool's header for why
 *  there is deliberately no `recipientsChanged` field here: the tool derives the
 *  recipient-change fact itself from the stored fingerprint. */
export interface FollowupSendPayload {
  notionPageId: string;
  seriesKey: string;
  to: string[];
  subject: string;
  bodyText: string;
  meetingTitle: string;
  meetingWhen: string;
  from: string;
  account?: string;
  forceApproval?: boolean;
}

export interface FollowupDeps {
  listMeetings(): Promise<MeetingRow[]>;
  /** `summaryHash` (LAR-28) — the LIVE `<meeting-notes><summary>` block's hash
   *  (`lib/meeting-followup.ts`'s `hashSummaryBlock`), so the store can tell "nothing has
   *  changed since the last attempt" apart from "Bendik corrected the page" for a `denied`/
   *  `queued` row. See `lib/meeting-followup-store.ts`'s `claimMeeting` for the reclaim rule. */
  claim(pageId: string, summaryHash: string): Promise<ClaimResult>;
  /** LAR-35-s3 — optional. Asked AFTER the recipients check and BEFORE `compose`, with the SAME
   *  `attempt` this claim just returned: "would the proactivity gate let a send-turn for THIS
   *  exact attempt through right now?" (`makeLivePrecheck` below, over the kit's `wouldSend` via
   *  `wouldInitiate`). `{ held: true }` means the tick must not compose at all — the precheck's
   *  own implementation has already released the claim (mirroring `send()`'s own held branch),
   *  so a later tick reclaims this page with its attempt budget unspent. With no `precheck`
   *  supplied, the tick behaves exactly as it always has: `compose` runs unconditionally for a
   *  claimed, ready row (every existing test in `tests/meeting-followup-schedule.test.ts` takes
   *  this path). Never called for a row `claim` did not actually claim this pass. */
  precheck?(pageId: string, attempt: number): Promise<{ held: boolean }>;
  /** Persists the derived key on a first occurrence before its approval card is resolved. */
  recordSeriesKey?(pageId: string, seriesKey: string): Promise<void>;
  compose(row: MeetingRow, recipients: string[]): Promise<FollowupDraft>;
  /** `{ autonomous: true }` when the send went out with no approval card (drives the "what I
   *  did" Slack line); anything else (including `void`) is treated as "a card may be pending"
   *  and stays silent. Throws on a failed dispatch. NOTE: resolving does not mean mail left —
   *  only `meeting_followup_send`'s own `execute()` knows that, and only it may record
   *  `"sent"` (see the module header, "SENT IS NOT THE SCHEDULE'S TO SAY"). */
  /** ORB-193 — `held: true` means the proactivity gate kept this send-turn back (quiet hours,
   *  DND, a ceiling). The turn never started, so nothing was composed into Gmail and nothing was
   *  said to Bendik; the tick leaves the row non-terminal so a later tick re-claims it.
   *
   *  `attempt` (LAR-28, second parameter, not part of the payload): `claimResult.attempt` —
   *  used ONLY to key the proactivity initiation (`meeting-followup/<pageId>#<attempt>`, see the
   *  module header's "WHY `#<attempt>`"), never sent to `meeting_followup_send` itself. Kept out
   *  of `FollowupSendPayload` on purpose: that type mirrors the tool's own input schema exactly
   *  (its own doc comment says so), and the tool has no use for it. */
  send(payload: FollowupSendPayload, attempt: number): Promise<{ autonomous: boolean; held?: boolean } | void>;
  /** Reads the send-log row's outcome back (finding 1) — called ONLY when `send()`'s
   *  pre-check said `autonomous: true`, because that pre-check is informational (see
   *  `makeLiveSend`'s own comment): `send()` resolving proves the model's turn ended, not
   *  that mail left, since eve hands a thrown tool error back to the MODEL rather than
   *  rejecting this promise. Only `outcome === "sent"` proves the send genuinely happened.
   *  Returns null if no row exists (should not happen once claimed, but defensive). */
  getOutcome(pageId: string): Promise<string | null>;
  recordOutcome(pageId: string, outcome: FollowupOutcome): Promise<void>;
  notify(text: string): Promise<void>;
  /** An autonomous send's pre-check said no card would render, but the row never reached
   *  "sent" once the turn resolved — the tool's `execute()` failed (Gmail 5xx, an expired
   *  token, a blocked egress call) and eve handed that error back to the model rather than
   *  rejecting this schedule's own promise (finding 1). Fires on EVERY such failure, not only
   *  the final attempt — see `reportDropped` below for that separate, final-attempt signal. */
  reportAutonomousSendFailed(pageId: string, title: string, outcome: string | null): Promise<void>;
  /** The final allowed attempt (see `MAX_ATTEMPTS`, meeting-followup-store.ts) for this row
   *  also failed — report it loudly instead of letting the standing `'error'` outcome be the
   *  only trace (finding 3, following `email-triage.ts`'s own `reportDropped` precedent —
   *  see its handling around lines 137, 158, 288). Without this, a meeting that fails three
   *  times is abandoned silently, stays `error` forever, and is re-read from Notion every
   *  tick with no way to progress. */
  reportDropped(pageId: string, title: string, err: unknown): Promise<void>;
  /** Bendik's own email addresses — excluded from recipients; `selfEmails[0]` doubles as the
   *  `from` address the live wiring sends as. */
  selfEmails: readonly string[];
}

export interface FollowupTickResult {
  scanned: number;
  composed: number;
  /** A turn was successfully dispatched to call `meeting_followup_send` — NOT proof mail
   *  left. See the module header; the tool alone knows "sent". */
  queued: number;
  skipped: number;
  errored: number;
  /** ORB-193 + LAR-35-s3 — the proactivity gate held this row back, at EITHER of the two points
   *  it is now asked: the precheck BEFORE `compose` (the common case — nothing was billed at
   *  all), or the send-turn's own gate inside `makeLiveSend` AFTER `compose` (the precheck said
   *  "send" a moment earlier, or none was configured, and only the send-turn was held). NOT an
   *  error and NOT a drop either way: the claim was released, so a later tick sends it with its
   *  attempt budget intact. Counted so an operator reading `composed=3 queued=0` is told which of
   *  the two silences this is — `composed` stays at whatever it was before a precheck hold, since
   *  a precheck hold means `compose` itself never ran for that row. */
  held: number;
  /** Rows `withinFollowupAge` excluded THIS tick (too old, or too far in the future — see
   *  `FOLLOWUP_MAX_AGE_DAYS`/`FOLLOWUP_MAX_FUTURE_SLACK_MINUTES`), counted separately from
   *  `skipped` (which means "claimed, then recorded skipped" — an age exclusion is never
   *  claimed at all). Post-fix review (Minor, but deliberately not deferred): the entire
   *  incident this bound exists for was a schedule doing the wrong thing QUIETLY —
   *  `scanned=N, composed=0` with no reason given is exactly that shape again. A row dropped
   *  for age must be counted AND logged, never merely absent. */
  agedOut: number;
}

// The trigger. No Status, no property-diffing — see the module header.
const isReady = (row: MeetingRow): boolean =>
  row.summaryBlock.trim() !== "" && row.attendees.trim() !== "";

// Recipients: everyone ORB-155 verified, minus Bendik's own addresses. Optional and
// declined attendees are KEPT in v1 (spec Q4) — responseStatus does not survive the
// calendar adapter for rows written before Phase 1, and the invite list is what we have.
const recipientsFor = (row: MeetingRow, selfEmails: readonly string[]): string[] => {
  const mine = new Set(selfEmails.map((e) => e.toLowerCase()));
  return parseAttendees(row.attendees)
    .map((a) => a.email)
    .filter((email) => !mine.has(email.toLowerCase()));
};

/** Safe sort key — a row with an unparseable `startsAt` sorts last rather than first, so one
 *  bad date can't starve every genuinely-oldest row behind it. Shared by the engine's own
 *  ordering (over `MeetingRow`) and `liveListMeetings`'s pre-markdown-fetch ordering (over the
 *  lighter `MeetingCandidate`) — both carry a plain `startsAt: string`. */
function startsAtMillis(row: { startsAt: string }): number {
  const t = Date.parse(row.startsAt);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

export interface FollowupTick {
  tick(now: Date): Promise<FollowupTickResult>;
}

/**
 * Builds the tick function. Pure factory over injected deps — fully testable without Notion,
 * Gmail, a model or a database; only the live wiring in `run()` below is impure. `now` drives
 * `withinFollowupAge` below — the engine's OWN recency check, not merely a clock accepted for
 * a future rule: `makeFollowupTick`'s whole reason to re-derive readiness/ordering/ceiling
 * defensively (rather than trust `listMeetings`'s cap) is that any injected `listMeetings` —
 * a test double, a future second call site — must not be able to reintroduce the 2026-08-24
 * incident by skipping `liveListMeetings`'s own age gate.
 */
export function makeFollowupTick(deps: FollowupDeps): FollowupTick {
  return {
    async tick(now: Date) {
      const result: FollowupTickResult = {
        scanned: 0, composed: 0, queued: 0, skipped: 0, errored: 0, agedOut: 0, held: 0,
      };

      const rows = await deps.listMeetings();
      result.scanned = rows.length;

      // The SAME recency gate `liveListMeetings` applies before ever reading a page — applied
      // again here, defensively, so the engine never trusts an injected `listMeetings` to have
      // done it. This is the identical helper, not a second copy of the rule (see
      // `withinFollowupAge`'s own comment on why one shared call was the point of this fix).
      const recent = withinFollowupAge(rows, now);
      result.agedOut = rows.length - recent.length;
      if (result.agedOut > 0) {
        // Named and counted, not merely absent (post-fix review, Minor-but-not-deferred): the
        // whole point of this bound is that a schedule silently doing the wrong thing is the
        // failure mode, so an operator staring at scanned=N/composed=0 must see a reason.
        console.warn(
          `meeting-followup: excluded ${result.agedOut} row(s) this tick as outside ` +
          `FOLLOWUP_MAX_AGE_DAYS/FOLLOWUP_MAX_FUTURE_SLACK_MINUTES (too old, too far in the ` +
          "future, or an unusable start time)",
        );
      }

      // Ready rows only — filtered BEFORE claim, deliberately: a not-yet-summarised row must
      // never spend one of its three claim attempts on being not-ready, or the meeting could
      // exhaust MAX_ATTEMPTS before Notion ever finishes the summary and never get a follow-up
      // at all. Oldest-first so a backfill drains in the order the meetings actually happened,
      // rather than starving the oldest behind a wall of newer ones.
      const ordered = recent.filter(isReady).sort((a, b) => startsAtMillis(a) - startsAtMillis(b));

      for (const row of ordered) {
        // Cap first — a tick that has already spent its billed-call budget must not claim
        // (and thereby spend an attempt on) rows it isn't going to process; leaving them
        // unclaimed means the next tick's re-scan picks them up fresh (email-triage.ts's
        // identical reasoning).
        if (result.composed >= FOLLOWUP_CEILING_PER_TICK) break;

        let claimResult: ClaimResult;
        try {
          claimResult = await deps.claim(row.pageId, hashSummaryBlock(row.summaryBlock));
        } catch (err) {
          console.error(`meeting-followup: claim failed for ${row.pageId}`, err);
          continue;
        }
        if (!claimResult.claimed) continue; // already handled, or retries exhausted

        if (claimResult.reclaimedAfterChange) {
          // LAR-28, one line (spec's own requirement): this row already had a card — the tick
          // log must say WHY a second one is being composed (the live summary changed since the
          // last attempt), so it reads as the intended re-draft rather than a duplicate-send bug.
          console.log(
            `meeting-followup: re-claimed ${row.pageId} — the summary changed since the last ` +
            "attempt (denied or still-queued card, page corrected) — composing a fresh card",
          );
        }

        if (row.isStandingSeries === false) {
          try {
            await deps.recordSeriesKey?.(row.pageId, row.series);
          } catch (err) {
            // Do not make a send less safe because a best-effort series-memory write failed:
            // this occurrence remains explicitly gated, and the next one will be too.
            console.error(`meeting-followup: could not record derived series key for ${row.pageId}`, err);
          }
        }

        const recipients = recipientsFor(row, deps.selfEmails);
        if (recipients.length === 0) {
          // Internal-only meeting: Bendik and a recording, nobody to follow up with.
          result.skipped += 1;
          try {
            await deps.recordOutcome(row.pageId, "skipped");
          } catch (err) {
            console.error(`meeting-followup: could not record skip for ${row.pageId}`, err);
          }
          continue;
        }

        // LAR-35-s3 — ask BEFORE paying for `compose`, not merely before the send-turn: the
        // whole point is that a row held all night costs nothing more than this one cheap gate
        // read. Optional, so a caller with no precheck configured falls straight through to
        // `compose` exactly as before this ticket.
        if (deps.precheck) {
          let pre: { held: boolean };
          try {
            pre = await deps.precheck(row.pageId, claimResult.attempt);
          } catch (err) {
            // Fail OPEN, the same posture ADR-0014 gives the real gate (rule 10): a broken
            // precheck must cost at most a stale duplicate risk, never a silently dropped
            // follow-up — so a precheck that cannot even answer is treated as "send".
            console.error(`meeting-followup: precheck failed for ${row.pageId} — composing ungated`, err);
            pre = { held: false };
          }
          if (pre.held) {
            // Nothing has been billed yet for this row: no compose, no send-turn. The claim was
            // already released by the precheck itself (mirroring the send-turn's own held branch
            // below), so `composed` never moves and no outcome is recorded — a later tick
            // reclaims this page with its attempt budget unspent.
            console.log(`meeting-followup: held back before composing for ${row.pageId} — the claim is released for a later tick`);
            result.held += 1;
            continue;
          }
        }

        // Billed attempt counted BEFORE the call resolves — the ceiling bounds attempts, not
        // successes, so a run of failing-but-billed compose calls still can't exceed it.
        result.composed += 1;
        let draft: FollowupDraft;
        try {
          draft = await deps.compose(row, recipients);
        } catch (err) {
          console.error(`meeting-followup: compose failed for ${row.pageId}`, err);
          try {
            await deps.recordOutcome(row.pageId, "error");
          } catch (err2) {
            console.error(`meeting-followup: could not record compose error for ${row.pageId}`, err2);
          }
          result.errored += 1;
          if (claimResult.isFinalAttempt) {
            try {
              await deps.reportDropped(row.pageId, row.title, err);
            } catch (err3) {
              console.error(`meeting-followup: reportDropped failed for ${row.pageId}`, err3);
            }
          }
          continue;
        }

        try {
          const sendResult = await deps.send({
            notionPageId: row.pageId,
            seriesKey: row.series,
            to: recipients,
            subject: draft.subject,
            bodyText: draft.bodyText,
            meetingTitle: row.title,
            meetingWhen: row.startsAt,
            from: deps.selfEmails[0] ?? "",
            forceApproval: row.isStandingSeries === false,
          }, claimResult.attempt);
          if (sendResult && (sendResult as { held?: boolean }).held) {
            // ORB-193 fix round 1 — held back by the gate, which has already logged why. NO outcome
            // is recorded and NO attempt is consumed: `makeLiveSend` released the claim
            // (`releaseClaim`, lib/meeting-followup-store.ts), so the row is back exactly as
            // `claimMeeting` found it and a later tick picks it up with its full budget. Counting a
            // hold as an attempt is what dropped a 21:30 follow-up before 22:30 under the DEFAULT
            // quiet hours — a silent loss caused by the gate rather than prevented by it.
            //
            // No `reportDropped` here for the same reason: nothing has failed, and the alert would
            // fire on the ordinary case of an evening meeting.
            console.log(`meeting-followup: held back for ${row.pageId} — the claim is released for a later tick`);
            result.held += 1;
            continue;
          }
          const preCheckAutonomous = !!(sendResult && (sendResult as { autonomous?: boolean }).autonomous);

          if (preCheckAutonomous) {
            // finding 1 (CRITICAL): the pre-check above is INFORMATIONAL only (see
            // `makeLiveSend`'s own comment) — `send()` resolving proves the model's TURN
            // ended, never that mail left, because eve hands a thrown tool error (Gmail 5xx,
            // an expired token, a blocked egress call) back to the MODEL rather than
            // rejecting this promise. READ THE ROW BACK: only `outcome === "sent"` proves
            // `meeting_followup_send`'s own `execute()` genuinely ran `gmail.send()` and
            // recorded it. Trusting the pre-check alone here is exactly the "logged success
            // while doing nothing" failure this ticket exists to end, sitting on the
            // autonomy path — a failed autonomous send was being reported as sent, with
            // `queued` written as a TERMINAL outcome (never retried), `errored` never
            // incremented, no signal, and a false "Sent the meeting follow-up" line to Bendik.
            let outcome: string | null = null;
            try {
              outcome = await deps.getOutcome(row.pageId);
            } catch (err) {
              console.error(`meeting-followup: outcome read-back failed for ${row.pageId}`, err);
            }

            if (outcome === "sent") {
              // Confirmed: the tool's execute() genuinely sent and recorded it.
              result.queued += 1;
              try {
                await deps.notify(
                  `Sent the meeting follow-up for "${row.title}" (${row.startsAt}) to ${recipients.join(", ")}.`,
                );
              } catch (err) {
                console.error(`meeting-followup: "what I did" notify failed for ${row.pageId}`, err);
              }
            } else {
              // The turn ended, but nothing was ever recorded as sent — the tool's execute()
              // failed after the pre-check promised no card would render. No success line,
              // count it as a genuine failure (never "queued", which claimMeeting would never
              // reclaim on an unchanged page — see lib/meeting-followup-store.ts), and raise it.
              result.errored += 1;
              try {
                await deps.recordOutcome(row.pageId, "error");
              } catch (err) {
                console.error(`meeting-followup: could not record autonomous-send failure for ${row.pageId}`, err);
              }
              try {
                await deps.reportAutonomousSendFailed(row.pageId, row.title, outcome);
              } catch (err) {
                console.error(`meeting-followup: reportAutonomousSendFailed failed for ${row.pageId}`, err);
              }
              if (claimResult.isFinalAttempt) {
                try {
                  await deps.reportDropped(
                    row.pageId, row.title,
                    new Error(`autonomous send did not complete (outcome=${String(outcome)})`),
                  );
                } catch (err) {
                  console.error(`meeting-followup: reportDropped failed for ${row.pageId}`, err);
                }
              }
            }
          } else {
            // Gated path: a card is pending Bendik's 👍/👎. Nothing has failed and nobody has
            // decided yet — "queued" is exactly right here, unlike in the autonomous branch
            // above, where it would have been a guess.
            result.queued += 1;
            try {
              await deps.recordOutcome(row.pageId, "queued");
            } catch (err) {
              console.error(`meeting-followup: could not record queued for ${row.pageId}`, err);
            }
          }
        } catch (err) {
          // send() itself threw — the turn never dispatched at all (e.g. a Slack error
          // opening it), a different failure mode from the tool's own execute() failing
          // (handled above). recordOutcome error, count it, and continue to the next row.
          // On the final allowed attempt (finding 3), report it loudly via reportDropped
          // rather than leaving the standing 'error' outcome as the only trace — a meeting
          // that silently exhausts MAX_ATTEMPTS is otherwise abandoned forever with no signal.
          console.error(`meeting-followup: send failed for ${row.pageId}`, err);
          try {
            await deps.recordOutcome(row.pageId, "error");
          } catch (err2) {
            console.error(`meeting-followup: could not record send error for ${row.pageId}`, err2);
          }
          result.errored += 1;
          if (claimResult.isFinalAttempt) {
            try {
              await deps.reportDropped(row.pageId, row.title, err);
            } catch (err3) {
              console.error(`meeting-followup: reportDropped failed for ${row.pageId}`, err3);
            }
          }
        }
      }

      return result;
    },
  };
}

// ─── Live wiring — Notion (twin; see module header) ────────────────────────────────────────

const NOTION_API = "https://api.notion.com";
// Verified against developers.notion.com 2026-08-04 (same date notion-sync's own client
// pinned it) — do not adjust from memory.
const NOTION_VERSION = "2026-03-11";
// The Meetings data source — read from an env var with this as its documented default
// (verified live across every notion-sync test fixture and the ORB-156 spec's own MCP
// queries, `docs/superpowers/plans/2026-08-24-orb-156-meeting-follow-ups.md`). Overridable
// only for the day the database is recreated.
const MEETINGS_DATA_SOURCE_ID =
  process.env["NOTION_MEETINGS_DATA_SOURCE_ID"] ?? "27fcc987-b457-8092-830c-000b13ab5b0b";

/** `<NAME>_FILE` (Docker secret) preferred over `<NAME>` — same convention as
 *  `lib/twenty-client.ts`'s `readApiKey` and notion-sync's own `readSecret`. Read fresh on
 *  every call, never at module scope: `eve build` has no secrets. */
function readNotionToken(): string {
  const file = process.env["NOTION_TOKEN_FILE"];
  if (file) return readFileSync(file, "utf8").trim();
  const value = process.env["NOTION_TOKEN"];
  if (!value) throw new Error("meeting-followup: NOTION_TOKEN (or NOTION_TOKEN_FILE) is not set");
  return value;
}

/**
 * eve-saga is a SEALED container (`packages/agent-kit/src/slack-dispatcher.ts`'s own header):
 * its only egress is the gateway, the db, DNS and the `slack-proxy` squid container — anything
 * else is DROPPED. A bare `fetch("https://api.notion.com/...")` goes DIRECT (undici's global
 * dispatcher only special-cases `*.slack.com`, per `slack-dispatcher.ts`), and direct is
 * exactly what the seal blocks.
 *
 * THE FAILURE SIGNATURE TO KNOW: a blocked call does not surface as a network/connection
 * error — it comes back shaped like a 404, so a seal problem reads as "that Notion page does
 * not exist" instead of "this request never left the container." Anyone chasing a mysterious
 * missing-page report on this schedule should suspect the seal before the data.
 *
 * `api.notion.com` IS already permitted: `/opt/agent-box/proxy/squid.conf`'s `atlas_sources`
 * acl (`dstdomain api.github.com api.notion.com`) allow-lists it by domain — the same shared
 * `slack-proxy` squid instance eve-saga already reaches for Slack and (per its own compose
 * block, `EGRESS_PROXY_URL`) for Google. No box change is needed; this only has to tunnel
 * through the proxy that is already reachable, the way `services/atlas/bin/atlas-sync.ts:96-110`
 * does for the identical `api.notion.com`/`api.github.com` case.
 *
 * Deliberately NOT `setGlobalDispatcher` (`slack-dispatcher.ts`'s own warning): that would
 * route model/gateway traffic through squid too, and squid denies everything not on its
 * allow-list — the dispatcher below is constructed once, lazily, and passed ONLY to this
 * module's own Notion `fetch` calls.
 */
let notionFetchPromise: Promise<typeof fetch> | undefined;

/** Built once, lazily (never at module scope — `eve build` has no secrets and no network),
 *  then reused for every Notion call this schedule ever makes. */
function notionFetch(): Promise<typeof fetch> {
  notionFetchPromise ??= (async () => {
    const proxyUrl = process.env["EGRESS_PROXY_URL"];
    if (proxyUrl === undefined || proxyUrl.trim() === "") return fetch; // e.g. local/dev, unsealed
    const { fetch: undiciFetch, ProxyAgent } = await import("undici");
    const dispatcher = new ProxyAgent(proxyUrl);
    return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      undiciFetch(input as never, { ...(init as object), dispatcher } as never)) as unknown as typeof fetch;
  })();
  return notionFetchPromise;
}

async function notionRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const doFetch = await notionFetch();
  const res = await doFetch(`${NOTION_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${readNotionToken()}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    throw new Error(`meeting-followup: Notion ${method} ${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

function plainText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const text = (part as { plain_text?: unknown }).plain_text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

/** True for the one rich-text item type this is about: an inline `@date` mention. Mirrors
 *  services/notion-sync/lib/adapters/notion-client.ts's own `isDateMention` — same structural
 *  check (the item's own `type`/`mention.type`, never a regex over flattened text), kept as a
 *  small duplicate here for the same "twin, not a re-home" reason the module header gives for
 *  not depending on notion-sync's client at all. */
function isDateMention(item: Record<string, unknown>): boolean {
  const mention = item["mention"] as { type?: unknown } | undefined;
  return item["type"] === "mention" && mention?.type === "date";
}

/**
 * The `Meeting Title` rich-text array with Notion's date MENTIONS stripped — the human-facing
 * title shown on the approval card (`meetingTitle`), in the composed email's context, and in
 * every log/signal line naming the meeting.
 *
 * A date mention's `plain_text` is the raw ISO string, so naively flattening every item (what
 * `plainText` above does) produces "Lyll.io 2025-10-03T09:00:00.000+02:00" — a trailing raw
 * timestamp on the ONE line a human reads on the approval card to check the agent matched the
 * right meeting before sending mail on his behalf. Stripped STRUCTURALLY, same as
 * notion-sync's `titleWithoutDateMentions`: a NON-date mention (a person or page) is kept,
 * because it is part of the meeting's actual name, not date noise.
 *
 * This is display-only. Nothing in this schedule matches or stores on the title — `pageId` is
 * the identity key throughout, and `series` is the ratchet's key — so unlike notion-sync's
 * `title`/`matchTitle` split (which exists because that service's title also feeds an
 * event-matcher and a transcript filename), there is nothing here that needs the raw,
 * mention-laden form preserved anywhere.
 */
function humanTitle(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter((item) => !isDateMention(item as Record<string, unknown>))
    .map((item) => {
      const text = (item as { plain_text?: unknown }).plain_text;
      return typeof text === "string" ? text : "";
    })
    .join("")
    // Removing an item leaves the space that separated it behind.
    .replace(/\s+/g, " ")
    .trim();
}

// Anchored INSIDE `<meeting-notes>` deliberately (ORB-156 fix round 2, Important): a bare
// `/<summary>…<\/summary>/` also matches ordinary markdown disclosure markup —
// `<details><summary>Notes</summary>…</details>` — anywhere earlier on the page, and would
// compose that decoy label into a customer's email instead of the real recap. `[^>]*` after
// each tag name tolerates attributes (`<summary lang="no">`), matching how a real renderer
// would emit them. Only the FIRST `<meeting-notes>` block is read if a page ever carries more
// than one — deterministic, and matches `.exec()`'s own un-flagged (first-match) behaviour.
const MEETING_NOTES = /<meeting-notes\b[^>]*>([\s\S]*?)<\/meeting-notes>/i;
const SUMMARY_TAG = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i;

/** The `<summary>` markdown block inside the page's own `<meeting-notes>` wrapper (spec
 *  correction 3) — the structured recap material, never the dense `Summary` PROPERTY and
 *  never the `<transcript>` block (which `getPageMarkdown` omits by default — keep it that
 *  way; see the design note). Absent or unparseable markdown yields "", which correctly
 *  fails `isReady` rather than composing from nothing — but see `liveListMeetings` below for
 *  why an EMPTY result alongside a filled `Summary` property is treated as loud, not silent. */
export function extractSummaryBlock(markdown: string): string {
  const notes = MEETING_NOTES.exec(markdown);
  if (!notes) return "";
  const summary = SUMMARY_TAG.exec(notes[1]!);
  return summary ? summary[1]!.trim() : "";
}

interface NotionQueryResponse {
  results: Array<Record<string, unknown>>;
  has_more: boolean;
  next_cursor: string | null;
}

interface MeetingCandidate {
  pageId: string;
  title: string;
  /** The meeting's OWN start time — the Notion `Date` property's `start`, verbatim, `undefined`
   *  if the property is unset. Deliberately NOT defaulted to the page's `created_time`: a
   *  created-time fallback would let `withinFollowupAge` treat "no Date property" as "usable
   *  start time", which is precisely the fail-open shape `FOLLOWUP_MAX_AGE_DAYS` exists to
   *  close. `withinFollowupAge` narrows this to `string` for every row it lets through. */
  startsAt: string | undefined;
  series: string;
  isDerivedSeries: boolean;
  attendees: string;
  actionItems: string;
  /** Whether the `Summary` PROPERTY (not the markdown block) is non-empty — the cheap,
   *  properties-only pre-filter the design spec asks for ("no page reads, no billed calls"
   *  for the common case of a not-yet-summarised meeting). */
  summaryPropertyFilled: boolean;
}

function toCandidate(page: Record<string, unknown>): MeetingCandidate {
  const props = (page["properties"] ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const date = props["Date"]?.["date"] as { start?: string } | null | undefined;
  const title = humanTitle(props["Meeting Title"]?.["title"]);
  const startsAt = date?.start;
  const calendarSeries = plainText(props["Series"]?.["rich_text"]);
  const derived = calendarSeries === "" ? derivedSeriesKey(title, startsAt) : "";
  return {
    pageId: String(page["id"] ?? ""),
    title,
    startsAt,
    series: calendarSeries || derived,
    isDerivedSeries: derived !== "",
    attendees: plainText(props["Attendees"]?.["rich_text"]),
    actionItems: plainText(props["Action Items"]?.["rich_text"]),
    summaryPropertyFilled: plainText(props["Summary"]?.["rich_text"]).trim() !== "",
  };
}

async function queryMeetingCandidates(): Promise<MeetingCandidate[]> {
  const rows: MeetingCandidate[] = [];
  let cursor: string | undefined;
  do {
    const res = await notionRequest<NotionQueryResponse>(
      "POST",
      `/v1/data_sources/${MEETINGS_DATA_SOURCE_ID}/query`,
      { page_size: 100, ...(cursor === undefined ? {} : { start_cursor: cursor }) },
    );
    for (const page of res.results) rows.push(toCandidate(page));
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
  } while (cursor !== undefined);
  return rows;
}

async function getPageMarkdown(pageId: string): Promise<string> {
  const res = await notionRequest<{ markdown?: unknown }>("GET", `/v1/pages/${pageId}/markdown`);
  return typeof res.markdown === "string" ? res.markdown : "";
}

/** finding 5: per-process dedupe for the summary-mismatch signal — see `liveListMeetings`'s
 *  own comment at the point it's read. Module-scope, not persisted: a redeploy/restart clears
 *  it and re-reports once, which is the intended behaviour, not a gap. */
const signaledMismatchPages = new Set<string>();

/**
 * Live `listMeetings`. FIVE stages (ORB-156 fix round 3: TWO separate ceilings, plus the
 * FOLLOWUP_MAX_AGE_DAYS recency bound added after the 2026-08-24 incident — see the module
 * header's "COST SAFETY" section for why one shared ceiling, applied before readiness was
 * known, could starve the queue forever, and `FOLLOWUP_MAX_AGE_DAYS`'s own comment for why a
 * ceiling alone was not enough to stop a backlog reaching into last year):
 *
 *  1. A cheap properties-only query (`queryMeetingCandidates`, no page reads), filtered to
 *     rows whose `Summary`/`Attendees` properties are already non-empty AND that carry no
 *     TERMINAL (`sent`/`skipped`) send-log row yet. A row still `error`, `denied` or `queued` in
 *     the send log is deliberately NOT excluded here — `claimMeeting`'s own attempts/backoff and
 *     (LAR-28) hash-diff logic, not this function, decides whether it may actually be reclaimed.
 *
 *     LAR-28 CHANGED WHICH OUTCOMES COUNT AS TERMINAL: `queued` USED TO be treated the same as
 *     `sent`/`skipped` (ORB-156 fix round 2's own reasoning — "a declined or expired card is not
 *     retried") — but that reasoning predates `denied` existing at all, and once a card CAN be
 *     recorded `denied`, the schedule needs to keep reading a still-`queued` page's live markdown
 *     too: `claimMeeting`'s hash-diff reclaim (lib/meeting-followup-store.ts) can only compare
 *     against a CURRENT hash, and the acceptance criterion this ticket ships is explicitly "a
 *     `denied` OR `queued` row … is re-claimed" once the page changes. The cost: a still-pending
 *     or declined page is now read from Notion every tick, indefinitely, until it is `sent`,
 *     `skipped`, or exhausts `MAX_ATTEMPTS` — bounded the same way an `error` row already was,
 *     by `MARKDOWN_READ_CEILING` below, never unbounded.
 *  2. `withinFollowupAge` (`FOLLOWUP_MAX_AGE_DAYS`) — excludes any row whose meeting did not
 *     start within the bound, and excludes (never includes) a row with no usable start time.
 *     Ahead of stage 3 deliberately: an ancient or dateless row must never cost a Notion page
 *     read, let alone occupy one of the MARKDOWN_READ_CEILING slots ahead of a recent one.
 *  3. Oldest-first ordering, THEN a slice to `MARKDOWN_READ_CEILING` (15) — BEFORE any markdown
 *     fetch. This bounds Notion PAGE READS, not billed spend, so it is deliberately wider than
 *     the compose ceiling: a handful of rows whose `Summary` property is filled but whose
 *     `<summary>` block can never be extracted must not be able to occupy every read slot
 *     every tick forever and starve every genuinely-ready row behind them.
 *  4. A markdown fetch + `<summary>` extraction for each of those, with a loud
 *     log+signal (not a silent drop) on the property-filled/block-empty contradiction.
 *  5. ONLY NOW — once readiness is actually known — a filter to ready rows, then a second
 *     slice to `FOLLOWUP_CEILING_PER_TICK` (5), the BILLED-compose ceiling. The engine
 *     (`makeFollowupTick`) re-derives its own ordering/readiness/ceiling over whatever this
 *     returns regardless (defensively — it must not silently trust this function's cap), so
 *     this is a genuine cost cut on the Notion-read side, not a correctness dependency.
 *
 * Exported for `tests/meeting-followup-live-list.test.ts` (finding 5's dedupe test) — every
 * other test drives the engine through the injected `FollowupDeps.listMeetings` instead.
 *
 * `now` defaults to the live clock; the parameter exists so `FOLLOWUP_MAX_AGE_DAYS` (the
 * recency bound below, stage 2) can be driven by a fixed clock in tests instead of racing
 * `Date.now()`.
 */
export async function liveListMeetings(pool: Pool, now: Date = new Date()): Promise<MeetingRow[]> {
  const [candidates, doneRows, seriesRows] = await Promise.all([
    queryMeetingCandidates(),
    pool.query<{ notion_page_id: string }>(
      `SELECT notion_page_id FROM meeting_followup_sent WHERE outcome IN ('sent', 'skipped')`,
    ),
    pool.query<{ series_key: string }>("SELECT DISTINCT series_key FROM meeting_followup_sent WHERE series_key <> ''"),
  ]);
  const done = new Set(doneRows.rows.map((r) => r.notion_page_id));
  const seenSeries = new Set(seriesRows.rows.map((r) => r.series_key));
  const eligible = candidates.filter(
    (c) => c.summaryPropertyFilled && c.attendees.trim() !== "" && !done.has(c.pageId),
  );
  // Recency bound BEFORE the markdown-read ceiling (deliberately — see FOLLOWUP_MAX_AGE_DAYS):
  // an ancient row must never cost a Notion page read, let alone occupy one of the
  // MARKDOWN_READ_CEILING slots ahead of a genuinely recent one.
  const recent = withinFollowupAge(eligible, now);
  const toRead = recent
    .sort((a, b) => startsAtMillis(a) - startsAtMillis(b))
    .slice(0, MARKDOWN_READ_CEILING);

  const ready: MeetingRow[] = [];
  for (const c of toRead) {
    let summaryBlock = "";
    try {
      summaryBlock = extractSummaryBlock(await getPageMarkdown(c.pageId));
    } catch (err) {
      console.error(`meeting-followup: page markdown read failed for ${c.pageId}`, err);
    }

    // The `Summary` PROPERTY said this page was ready, but the markdown extractor found no
    // `<summary>` block — a contradiction, not a normal "not ready yet" (ORB-156 fix round 2,
    // Important). Silence here means the row is re-scanned every five minutes forever: never
    // claimed (isReady fails on the empty block), never errored, never counted — the exact
    // "verify the input, not just the log" failure this codebase has been burned by before.
    // It is EXCLUDED below (never pushed to `ready`) — the whole point of fix round 3 is that
    // a row like this must not occupy one of the 5 compose slots either.
    if (summaryBlock === "") {
      console.error(
        `meeting-followup: page ${c.pageId} has a filled Summary property but no <summary> ` +
        "block was found in its markdown — the page will silently never trigger until this is fixed",
      );
      // finding 5: dedupe per page for the process lifetime. `liveListMeetings` runs every
      // 5 minutes, so without this a single persistently-broken page would signal roughly
      // 288 times a day, forever — an agent in this fleet was already paused for exactly
      // that kind of spam. A restart clears `signaledMismatchPages` and re-reports once,
      // which — combined with the signal spine's own 24-hour fingerprint collapse
      // (lib/signal-emit.ts) — means a persistently-broken page produces roughly ONE alert
      // a day: enough to know it is still broken, never a flood.
      if (!signaledMismatchPages.has(c.pageId)) {
        signaledMismatchPages.add(c.pageId);
        await emitSignal(
          "meeting-followup-summary-mismatch",
          `meeting-followup: Summary property filled but no <summary> block for page ${c.pageId}`,
          `title=${JSON.stringify(c.title)}`,
        );
      }
      continue;
    }

    ready.push({
      pageId: c.pageId,
      title: c.title,
      startsAt: c.startsAt,
      series: c.series,
      isStandingSeries: !c.isDerivedSeries || seenSeries.has(c.series),
      attendees: c.attendees,
      summaryBlock,
      actionItems: c.actionItems,
    });
  }
  return ready.slice(0, FOLLOWUP_CEILING_PER_TICK);
}

// ─── Live wiring — compose ──────────────────────────────────────────────────────────────────

/** `buildFollowupPrompt` asks the model to "Return the email as JSON: {"subject": …,
 *  "bodyText": …}. No other text." — tolerant of a stray code fence around it, matching how
 *  models occasionally wrap JSON answers regardless of the instruction. */
function extractJsonDraft(text: string): FollowupDraft {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const parsed = JSON.parse(cleaned) as { subject?: unknown; bodyText?: unknown };
  if (typeof parsed.subject !== "string" || typeof parsed.bodyText !== "string") {
    throw new Error("meeting-followup: composed draft is missing subject/bodyText");
  }
  return { subject: parsed.subject, bodyText: parsed.bodyText };
}

/** Keep the author disclosure deterministic: it must appear on the approval card and CRM
 * note, but never be left for the writer model to omit or paraphrase. */
export function appendSagaSignoff(draft: FollowupDraft, lang: Lang, displayName: string): FollowupDraft {
  const firstName = displayName.trim().split(/\s+/)[0] || "Bendik";
  const signoff = lang === "no"
    ? `Fra Saga, på vegne av ${firstName}`
    : `From Saga, on behalf of ${firstName}`;
  return { ...draft, bodyText: `${draft.bodyText.trimEnd()}\n\n${signoff}` };
}

/** `fromMailbox` scopes both the voice corpus (owner@owner.example and owner@project.example write to
 *  different people — voice-store.ts's own header) and the language of the ONE email sent.
 *
 *  LANGUAGE, corrected by ORB-176: spec Q1's original ruling — detect over the meeting-note
 *  text itself — shipped a Norwegian follow-up to an English-speaking counterpart, because
 *  Notion had translated the transcript. Real prior correspondence (Bendik's own mail to these
 *  recipients, via `priorCorrespondenceText`) now outranks the note; the note remains the
 *  fallback when no correspondence exists, so a first-ever counterpart behaves as before. */
function makeLiveCompose(pool: Pool, fromMailbox: string): FollowupDeps["compose"] {
  const voice = makeDbVoiceAccess({ db: pool, mailbox: fromMailbox });
  return async (row, recipients) => {
    // Resolve once for both the one-off action-item filter and the transparent Saga footer.
    // Registry trouble must not hold a follow-up back; Bendik is the established fallback.
    const displayName = (await getDisplayName(pool, configuredOwnerId()).catch(() => null)) ?? "Bendik";
    // 2026-09-08: a one-off meeting (no series) with externals shares only the action items that
    // involve them; the member's own items stay his. Recurring series keep the full list — it is
    // the team's shared record. Names come from the registry and the Attendees line, never literals.
    let actionItems = parseActionItems(row.actionItems);
    if (row.isStandingSeries === false || row.series === "") {
      const displayName = await getDisplayName(pool, configuredOwnerId()).catch(() => null);
      const self = displayName ? [displayName, displayName.split(/\s+/)[0]!] : [];
      const recipientNames = parseAttendees(row.attendees).map((a) => a.name);
      const before = actionItems.length;
      actionItems = filterActionItemsForExternals(actionItems, { self, recipients: recipientNames });
      if (actionItems.length !== before) console.info(`meeting-followup: one-off "${row.title}" — kept ${actionItems.length}/${before} action items for externals`);
    }
    let correspondence = "";
    try {
      const gmail = await googleClients().gmail(fromMailbox);
      correspondence = await priorCorrespondenceText(gmail, recipients);
    } catch (err) {
      console.warn("meeting-followup: gmail unavailable for language evidence — falling back to the meeting note", err);
    }
    const lang: Lang = detectCounterpartLanguage({ correspondence, text: row.summaryBlock });
    const profile = await voice.getProfile().catch((err: unknown) => {
      console.error("meeting-followup: voice profile unavailable — composing without it", err);
      return null;
    });
    const input: FollowupInput = {
      title: row.title,
      whenIso: row.startsAt,
      summaryBlock: row.summaryBlock,
      actionItems,
      recipients,
      lang,
      voiceBlock: buildVoiceBlock(profile, lang),
    };
    // No output cap named here: `gatewayComplete` owns the writer budget, because the writer
    // alias sits on a thinking model and thinking shares `max_tokens` (see
    // THINKING_MODEL_MIN_OUTPUT_TOKENS). A 1024 cap here cut the Folkepuls draft off three
    // times on 2026-09-07.
    const raw = await gatewayComplete(buildFollowupPrompt(input), { purpose: "writer" });
    return appendSagaSignoff(extractJsonDraft(raw), lang, displayName);
  };
}

// ─── Live wiring — send ─────────────────────────────────────────────────────────────────────

/**
 * The one turn this schedule ever opens for a follow-up. NOT a request for the model to write
 * anything — the draft is already final (`makeLiveCompose` above) — its only job is to call
 * `meeting_followup_send` with the arguments below, verbatim. Embedded as a JSON block rather
 * than interpolated inline like `crm-routing.ts`'s short string args: a multi-paragraph email
 * body with quotes, line breaks and Norwegian characters is exactly the content a model might
 * "helpfully" paraphrase on the way into a tool call if given the chance, and `JSON.stringify`
 * escapes everything a plain inline interpolation would not.
 *
 * LAR-28 — the DENIAL instruction below is the whole reason this schedule can ever learn that a
 * card was declined at all (see the module header, "DENIED, AND WHY THE SCHEDULE DOES NOT WRITE
 * IT"): the moment a human taps 👎, eve resumes THIS turn with the rejection, and this turn — not
 * the schedule's own tick, which has long since finished waiting — is the only code running at
 * that moment. It is deliberately narrow: only a genuine human decline, never a series switched
 * off by policy (`level: "never"`, which resolves inside the SAME turn with no card ever
 * rendered, and is a policy fact, not a decision to correct-and-retry).
 */
function buildSendTurnPrompt(payload: FollowupSendPayload): string {
  return [
    "[scheduled check — meeting follow-up. This is not a message from a person; it is your",
    "cue to send one already-drafted follow-up email.]",
    "",
    `A follow-up for "${payload.meetingTitle}" (${payload.meetingWhen}) is ready to send.`,
    "",
    "Call meeting_followup_send with EXACTLY this JSON object as its input — do not alter,",
    "shorten, translate, or re-word any field, especially `subject` and `bodyText`:",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
    "",
    "That tool is gated per meeting series: it renders Bendik's 👍/👎 card unless this series",
    "has been switched to auto-send, in which case it sends immediately with no card. Either",
    "way, calling it now — in THIS turn — is the entire task; say nothing else.",
    "",
    "Your turn may resume later, once Bendik has answered the card. If — and only if — that",
    `answer is a human decline (not an autonomous series simply switched off), call`,
    `meeting_followup_record_denial with { "notionPageId": ${JSON.stringify(payload.notionPageId)} }`,
    "so this can be corrected and picked up again, then say nothing else. Do not call it now,",
    "and do not call it for any other outcome.",
  ].join("\n");
}

/** `ScheduleHandlerArgs["to"]`/`["appAuth"]` — typed loosely here (matching the surrounding
 *  files' own `Parameters<...>`-free style) since `defineSchedule`'s own types already
 *  constrain the real call site below; this helper only needs `to`/`waitUntil`/`appAuth` to be
 *  whatever `run()` was actually handed. */
type ScheduleArgs = Parameters<NonNullable<Parameters<typeof defineSchedule>[0]["run"]>>[0];

/**
 * NO LONGER MERELY INFORMATIONAL (finding-1-regression fix). Finding 1 made this pre-check
 * load-bearing: `makeLiveSend` reporting `autonomous: true` routes the tick's read-back branch
 * into play, and a row that never reaches `"sent"` is recorded `'error'` (non-terminal —
 * `claimMeeting` re-claims it in 20 minutes) and gets a `reportAutonomousSendFailed`/
 * `reportDropped` signal. That means this pre-check and `followupApproval`'s policy
 * (agent/tools/meeting_followup_send.ts) MUST reach the same autonomous/gated conclusion for
 * the same inputs — a disagreement is no longer "at most one wrong/missing FYI line", it is a
 * spurious retry, a false "gave up after 3 attempts" signal, and — if Bendik taps 👍 on more
 * than one of the resulting duplicate approval cards — a genuine double-send to the externals.
 *
 * Exported and parameterised over `FollowupApprovalDeps` (the SAME injected-deps shape
 * `followupApproval` takes) for two reasons: `makeLiveSend` can wire it to the live ratchet/
 * fingerprint reads, and `tests/meeting-followup-live-send.test.ts` can call it directly with
 * fixed deps and compare its answer against `followupApproval`'s, so the two are proven to
 * agree rather than merely asserted to. `isGroupAlias` is imported from the tool file rather
 * than re-implemented here for the same reason: one predicate, two call sites, so they cannot
 * diverge on the alias rule. ANY future change to the policy's decision
 * (agent/tools/meeting_followup_send.ts's `followupApproval`) must be mirrored here, or this
 * comment's claim stops being true again.
 */
export async function computeAutonomousPreCheck(
  payload: { seriesKey: string; to: readonly string[]; forceApproval?: boolean },
  deps: FollowupApprovalDeps,
): Promise<boolean> {
  if (payload.forceApproval || payload.seriesKey === "" || payload.to.some(isGroupAlias)) return false;
  try {
    const level = await deps.level(payload.seriesKey);
    if (level !== "autonomous") return false;
    const previous = await deps.lastFingerprint(payload.seriesKey);
    return previous === null || previous === fingerprintRecipients(payload.to);
  } catch (err) {
    console.error(`meeting-followup: autonomy pre-check failed for series ${payload.seriesKey}`, err);
    return false;
  }
}

/**
 * The ONE expression for this schedule's proactivity item key — shared by `makeLiveSend` (the
 * real send-turn gate) and `makeLivePrecheck` (LAR-35-s3's precheck), so the two are provably
 * asking about the exact same row rather than two independently-typed copies that could drift.
 * See the module header's "WHY `#<attempt>`" (LAR-28) for why the bare page id is not enough.
 */
export function meetingFollowupItemKey(pageId: string, attempt: number): string {
  return `meeting-followup/${pageId}#${attempt}`;
}

/**
 * LAR-35-s3 — the precheck's own logic, parameterised over injected deps the same way
 * `computeAutonomousPreCheck` is: `makeLivePrecheck` below wires it to the real
 * `wouldInitiate`/`releaseClaim`, and `tests/meeting-followup-live-send.test.ts` drives it with
 * fixed deps to prove it releases the claim on a hold and shares `meetingFollowupItemKey` with
 * the real gate.
 */
export interface FollowupPrecheckDeps {
  wouldInitiate(
    schedule: string,
    init: { cls: "event"; door: string; itemKey: string },
  ): Promise<{ handled: boolean }>;
  releaseClaim(pageId: string): Promise<void>;
}

export function makeLivePrecheckWith(channelId: string, deps: FollowupPrecheckDeps): NonNullable<FollowupDeps["precheck"]> {
  return async (pageId, attempt) => {
    const outcome = await deps.wouldInitiate("meeting-followup", {
      cls: "event",
      door: doorId("slack", channelId),
      itemKey: meetingFollowupItemKey(pageId, attempt),
    });
    // `handled` (send-already-decided OR already-seen) is NOT a hold — see `makeLiveSend`'s own
    // comment on the identical `handled`-vs-`sent` distinction. Falling through to `compose` is
    // exactly right for BOTH: a `send` verdict here costs the ledger nothing (`wouldSend` writes
    // no row for it), so the real gate moments later makes the actual decision; an already-seen
    // verdict means the send-turn already ran, so one more compose plus the real gate's own
    // already-seen branch is what reaches today's terminal bookkeeping (spec's own choice, not
    // an oversight — see the module header's PROACTIVITY paragraph).
    if (outcome.handled) return { held: false };

    // A genuine hold, asked BEFORE compose. Release the claim the same way `makeLiveSend`'s own
    // held branch does, so the row is claimable again on the next tick with its budget unspent.
    await deps.releaseClaim(pageId).catch((err) =>
      console.error(
        `meeting-followup: could not release the claim for ${pageId} after a held-back precheck — ` +
        "this page has now spent one of its three attempts on nothing composed",
        err,
      ),
    );
    return { held: true };
  };
}

/** The live wiring's own binding of `makeLivePrecheckWith` to a real pool — separate from the
 *  testable factory above so a test never has to construct a `Pool`. */
function makeLivePrecheck(pool: Pool, channelId: string): NonNullable<FollowupDeps["precheck"]> {
  return makeLivePrecheckWith(channelId, {
    wouldInitiate: (schedule, init) => wouldInitiate(schedule, init),
    releaseClaim: (pageId) => releaseClaim(pool, pageId),
  });
}

function makeLiveSend(
  pool: Pool,
  to: ScheduleArgs["to"],
  waitUntil: ScheduleArgs["waitUntil"],
  appAuth: ScheduleArgs["appAuth"],
  channelId: string,
): FollowupDeps["send"] {
  const ratchet = new KitRatchet(pool);
  return async (payload, attempt) => {
    const autonomous = await computeAutonomousPreCheck(payload, {
      level: (seriesKey) => ratchet.level(FOLLOWUP_AGENT, FOLLOWUP_CAPABILITY, seriesKey),
      lastFingerprint: (seriesKey) => lastRecipientsFingerprint(pool, seriesKey),
    });

    // ORB-193 — an `event` initiation keyed on the Notion page AND the attempt (LAR-28 — see the
    // module header's "WHY `#<attempt>`"): without the suffix, a genuine re-draft after a denied
    // card is corrected reads to the gate as the SAME initiation as the original send-turn, and
    // an already-seen suppression silently skips the second turn entirely. `meetingFollowupItemKey`
    // is the SAME expression `makeLivePrecheck` above asks under — never restated.
    const initiation = await initiate(
      "meeting-followup",
      { cls: "event", door: doorId("slack", channelId), itemKey: meetingFollowupItemKey(payload.notionPageId, attempt) },
      async () => {
        const task = to(slack, { channelId }).send(buildSendTurnPrompt(payload), {
          auth: { ...appAuth, attributes: { lane: "meeting-followup" } },
        });
        waitUntil(task);
        await task;
      },
    );
    // `handled`, not `sent` (fix round 1, CRITICAL): an ALREADY-SEEN suppression means the send-turn
    // for this page already ran, so the tick must do its normal post-send bookkeeping (read the
    // outcome back, record `queued`) rather than treat the page as untouched.
    if (initiation.handled) return { autonomous };

    // A genuine hold. Hand the claim attempt back before reporting it, so the row is claimable again
    // on the next tick with its budget unspent — see `releaseClaim`'s own docblock for the 21:30
    // follow-up this prevents losing.
    await releaseClaim(pool, payload.notionPageId).catch((err) =>
      console.error(
        `meeting-followup: could not release the claim for ${payload.notionPageId} after a held-back ` +
        "send — this page has now spent one of its three attempts on a message nobody was sent",
        err,
      ),
    );
    return { autonomous, held: true };
  };
}

// ─── Live wiring — schedule ─────────────────────────────────────────────────────────────────

function liveSlackChannelId(): string | undefined {
  return allowedSlackUserIds()[0];
}

/** Prevents an overlapping tick if one run ever takes longer than the 5-minute cron period —
 *  matches `email-triage.ts`/`crm-routing.ts`'s own `state.running` guard. */
let running = false;

/** ORB-175 — the row input-freshness.sh reads; pinned to this filename by the conformance test. */
export const HEARTBEAT_KEY = "saga/meeting-followup";

export default defineSchedule({
  cron: "*/5 * * * *",
  async run({ to, waitUntil, appAuth }) {
    const { loaded } = await thisAgent(undefined);
    if (!scheduleEnabled(loaded.definition, "meeting-followup")) return;
    if (running) return;

    const channelId = liveSlackChannelId();
    if (!channelId) {
      console.warn("meeting-followup: no Slack principal configured (SLACK_ALLOWED_USER_IDS); skipping");
      return;
    }

    running = true;
    try {
      const pool = getPool();

      // The primary account — same env pin `email-triage.ts` documents (`CALENDAR_PRIMARY_EMAIL`,
      // services/box/compose.yaml) — is both the mailbox this schedule sends AS and the
      // voice corpus it composes from. Falls back to the identity registry's own alias list
      // only if that pin is ever unset.
      const selfEmails = await listAliases(pool, configuredOwnerId(), "email");
      const fromMailbox = process.env["CALENDAR_PRIMARY_EMAIL"] ?? selfEmails[0] ?? "";

      const deps: FollowupDeps = {
        listMeetings: () => liveListMeetings(pool),
        claim: (pageId, summaryHash) => claimMeeting(pool, pageId, summaryHash),
        precheck: makeLivePrecheck(pool, channelId),
        recordSeriesKey: (pageId, seriesKey) => storeRecordSeriesKey(pool, pageId, seriesKey),
        compose: makeLiveCompose(pool, fromMailbox),
        send: makeLiveSend(pool, to, waitUntil, appAuth, channelId),
        getOutcome: (pageId) => storeGetOutcome(pool, pageId),
        recordOutcome: (pageId, outcome) => storeRecordOutcome(pool, pageId, outcome),
        reportAutonomousSendFailed: (pageId, title, outcome) => emitSignal(
          "meeting-followup-autonomous-send-failed",
          `meeting-followup: autonomous send for "${title}" did not complete`,
          `pageId=${pageId} outcome=${String(outcome)}`,
        ),
        reportDropped: (pageId, title, err) => emitSignal(
          "meeting-followup-dropped",
          `meeting-followup: gave up on "${title}" (${pageId}) after ${MAX_ATTEMPTS} attempts`,
          String(err),
        ),
        notify: async (text) => {
          const res = await callSlackApi({
            botToken: slackCredentials.botToken,
            operation: "chat.postMessage",
            body: { channel: channelId, text },
          });
          if (!res.ok) throw new Error(`meeting-followup: slack notify failed: ${String((res as { error?: unknown }).error)}`);
        },
        selfEmails: [fromMailbox, ...selfEmails].filter((e, i, arr) => e !== "" && arr.indexOf(e) === i),
      };

      await makeFollowupTick(deps).tick(new Date());
      // Once per tick, after the loop.
      await pruneOldFollowups(pool);
      await recordSchedulePass(pool, HEARTBEAT_KEY);
    } catch (err) {
      console.error("meeting-followup: tick failed", err);
      await emitSignal("schedule-tick-failed", "meeting-followup: tick failed", String(err));
    } finally {
      running = false;
    }
  },
});
