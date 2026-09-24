/**
 * A Slack `ThreadSnapshot` source for the obligation radar — alongside `GmailSourceDeps` /
 * `scanThreads` in `./brief-content.ts`, feeding the SAME `selectObligations` / `assignSurfaces`
 * pipeline. Per ORB-149's design note
 * (docs/superpowers/specs/2026-08-24-orb-149-saga-reads-slack-design.md), D2: this reads Slack
 * LIVE on the box each tick (no daily-replica staleness — a "missed message" feature cannot run
 * on a ~21h-old snapshot), windowed to the last `windowDays` (default `DEFAULT_SLACK_WINDOW_DAYS`
 * = 60, matching Gmail's own default) so a years-old dead conversation can never rank above this
 * morning's real mail — `selectObligations` sorts most-overdue-first (`brief-content.ts:174`),
 * so an unbounded scan would put the OLDEST dead thread at the very top.
 *
 * D4 — delivery is the morning brief ONLY, Bendik's explicit ruling (proactive paused
 * fleet-wide after Tyche's spam). CORRECTED CLAIM (ORB-149 T3 review round 1, Important 4): an
 * earlier version of this comment claimed the pipeline "has no ping surface to accidentally
 * reopen." That was FALSE, verified against the source: `agent/schedules/reping.ts` reads
 * `assignSurfaces(...).interrupt` and sends a Telegram push for any `isRePing` obligation — a
 * real proactive surface. Neither `selectObligations` nor `assignSurfaces` may be edited (a
 * binding constraint on this file), and `isRePing = theirUnansweredCount >= 2`
 * (`brief-content.ts:159`) is entirely determined by the `theirUnansweredCount` THIS file emits
 * — so D4 is enforced STRUCTURALLY here **for the `interrupt`/re-ping surface specifically**,
 * not left to a future caller to remember: every Slack snapshot's `theirUnansweredCount` is
 * capped at `MAX_EMITTED_UNANSWERED` (1), which makes `isRePing` mathematically always `false`
 * for a Slack-sourced Obligation, no matter how a future caller wires this in. See that cap's
 * own doc comment for the accepted trade-off.
 *
 * CORRECTION (final review, item 6): the STRUCTURAL guarantee above is real but narrower than
 * "morning brief only" read literally — it covers `interrupt` only, not `nightBefore`.
 * `assignSurfaces` (`brief-content.ts:218`) routes any obligation whose `counterpartyAddress`
 * is among tomorrow's meeting participants into `nightBefore` instead of `brief`, and
 * `evening-brief.ts:204` pushes `nightBefore` content to Telegram the same as `reping.ts` does
 * for `interrupt` — a second live proactive surface this file's cap does nothing about. D4
 * currently holds only because NOTHING calls this source yet (see "TOKEN / CLIENT" and the
 * runbook's "What is NOT yet done"), not because a Slack-sourced obligation is structurally
 * barred from `nightBefore`. See the WIRING-TASK NOTE below.
 *
 * WIRING-TASK NOTE — `nightBefore` must be suppressed too, or D4 is met by luck again: whoever
 * wires `scanSlackThreads`'s output into `gatherOpenObligations`/`selectObligations` needs to
 * either keep Slack-sourced obligations out of `assignSurfaces` entirely and run them through a
 * morning-only path of their own, or otherwise ensure a Slack obligation can never carry a
 * `counterpartyAddress` that matches `tomorrowsParticipants` — a Slack user id will not
 * naturally collide with the email addresses `assignSurfaces` compares against today, but that
 * is an accident of the two address spaces not overlapping, not a guarantee anyone decided on.
 *
 * SIBLING MODULE, not added into brief-content.ts directly: that file is already ~790 lines
 * covering the full pipeline (types, selectObligations, assignSurfaces, the re-ping budget, the
 * Gmail source, the calendar source, ingested picks, and both brief builders). A second full
 * source with its own conversation/message vocabulary would push it well past a skimmable size
 * for no benefit — nothing here needs to see selectObligations'/assignSurfaces' internals, only
 * the `ThreadSnapshot` shape they already export.
 *
 * SCOPE — matched to the network importer's ruling (services/network/lib/importers/slack.ts,
 * "CONTROLLER RULING (2026-08-24, ORB-149 T2 review)") so the two halves of this ticket agree
 * on what counts as an interaction with him:
 *   - im (DM): both directions always — a DM has exactly one fixed counterparty.
 *   - mpim (group DM): no single fixed counterparty exists. Credited to whoever spoke last —
 *     the obligation-radar analogue of the importer's "restore reciprocity" choice for group
 *     DMs, rather than excluding them from coverage entirely.
 *   - channel: a message counts ONLY when it mentions him or sits in a thread he has already
 *     posted in. An ordinary broadcast in a channel he happens to belong to never becomes a
 *     candidate at all — never mind "unanswered".
 *
 * NOT A REAL MESSAGE (this source's analogue of Gmail's isAutomatedSender / calendar-notice
 * drop) — three separate cases, all dropped before any counting:
 *   - a message with no stable human author: `isBot: true`, or no `userId` at all (a reader
 *     that failed to filter a system event upstream).
 *   - a message whose Slack `subtype` is NOT on `REAL_MESSAGE_SUBTYPES` — an ALLOWLIST, not a
 *     denylist (ORB-149 T3 review round 3): an earlier draft denylisted specific system subtypes
 *     (channel_join, channel_topic, …), which fails OPEN — any subtype Slack adds later
 *     (tombstone, channel_archive, bot_add, reminder_add, …) would have silently counted as a
 *     real message. The allowlist fails CLOSED instead: an unrecognized subtype is dropped,
 *     never fabricates an obligation. That same round 2 denylist also wrongly included
 *     `me_message` — a real message a person typed (`/me does a thing`), not a system event; see
 *     `REAL_MESSAGE_SUBTYPES`'s own comment for the false-positive this caused.
 *   - Slack's own built-in `USLACKBOT` user id — uniquely among bots it carries a real `userId`
 *     with no `botId`/`isBot` either, so a Slackbot DM where Slackbot "spoke last" would
 *     otherwise become a permanent, unsatisfiable morning-brief obligation. Filtered here as
 *     defense-in-depth; the real reader (Task 4) should also map it to `isBot: true` itself.
 * Slack has no separate "mailing list" concept once these are out, so unlike Gmail there is no
 * further `isAutomated` signal to compute — every snapshot this file emits carries
 * `isAutomated: false`.
 *
 * TOKEN / CLIENT: not built here — Task 4 supplies the real reader, blocked on Bendik's own
 * OAuth install (D1/the consent step). `SlackSourceDeps` is the injection seam; every method is
 * fully fakeable, so this file and its tests need no token, no network, and no Slack SDK. Once
 * the real client lands, `installSlackProxyDispatcher()` (already installed from
 * `agent/channels/slack.ts`) means a plain `fetch` to `*.slack.com` needs no extra plumbing here.
 *
 * WIRING-TASK NOTE — `source` column: `lib/obligations-store.ts`'s `upsertSeen` writes every row
 * with `source` hardcoded `'gmail'` (`obligations-store.ts:33,75-85`). A caller that reuses that
 * function unchanged for Slack-sourced obligations will stamp them `'gmail'` too — not fixed
 * here (out of this file's scope; fixing it means widening a store CHECK constraint or threading
 * a `source` parameter through `GatherObligationsDeps`), but recorded here, in the code, so the
 * wiring task starts from this note rather than rediscovering it.
 */
import { LAST_MESSAGE_MAX_CHARS, type ThreadSnapshot } from "./brief-content.js";
import { SlackRateLimitError } from "@lares/network/lib/importers/slack.js";

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Deps — the read surface this source needs, and nothing else. Mirrors GmailSourceDeps'
// shape/spirit (brief-content.ts:282): a small number of methods, each already doing the
// Slack-shape parsing so the scan logic below stays a plain walk over structured facts.
// ═══════════════════════════════════════════════════════════════════════════════════════════

export type SlackConversationKind = "im" | "mpim" | "channel";

export interface SlackConversationRef {
  id: string;
  kind: SlackConversationKind;
  /** im only — the DM's one fixed counterparty (Slack user id). Required for a real reader;
   *  falls back to the last speaker if omitted so a malformed conversation ref degrades rather
   *  than throwing (the importer instead THROWS on this — see its "Defense-in-depth" comment —
   *  because a wrong contact there corrupts the graph; here a wrong display name for one
   *  obligation is a cosmetic miss, not silent data loss, so the softer fallback is deliberate). */
  counterpartyUserId?: string;
}

/**
 * One message as this source needs it — reader-computed relevance flags, not raw Slack JSON.
 * Mirrors the importer's `SlackMessage`: the reader (a later task) does the Slack-shape parsing
 * (walking `thread_ts`, extracting @-mentions of Bendik's own user id from the message text) and
 * hands back opaque booleans.
 *
 * `text` (ORB-45 Task 10, B1) is the ONE exception to "signals-only per D5" — it is carried IN
 * FLIGHT ONLY, for the last message a `ThreadSnapshot` reports (Task B3's bounded model read,
 * Task B5's reason line). It is never written to `obligation_threads` — `lib/obligations-store.ts`
 * only ever reads pointer fields off an `Obligation` — and never survives past the single tick
 * that builds the snapshot, same discipline as the rest of this file's message content.
 */
export interface SlackThreadMessage {
  /** Slack's own per-message clock, "<unix_seconds>.<fraction>" — string-sortable within one
   *  conversation, parsed via a numeric compare here (see `parseSlackTs`). */
  ts: string;
  /** Author's Slack user id. */
  userId?: string;
  /** Present on bot-authored messages instead of a real `userId` — dropped before counting, same
   *  as the importer's `m.botId` skip (no stable person to resolve, and a bot cannot be "waited
   *  on"). */
  isBot?: boolean;
  /**
   * Slack's `subtype` for non-message system events (channel_join, channel_topic, …). These
   * carry a REAL `userId`, so `isBot` alone cannot catch them — see the module header's "NOT A
   * REAL MESSAGE" note (Important 6). `undefined`/omitted means "an ordinary message".
   */
  subtype?: string;
  /**
   * Which Slack thread this message belongs to — REQUIRED for every message, channel or
   * im/mpim alike (an earlier draft left this optional; ORB-149 T3 review round 1, Important 2:
   * a Task-4 reader that forgets it would make every channel message its own one-message
   * "thread", compiling clean while silently killing participation detection with no error and
   * no log — exactly the coverage gap this ticket exists to close). A message that started no
   * thread of its own carries its OWN `ts` here (the reader's job). For im/mpim its value is
   * never read by this file; set it to the message's own `ts` for consistency.
   */
  threadTs: string;
  /**
   * channel only — Bendik was @-mentioned in this message's text. REQUIRED for the same reason
   * as `threadTs` (Important 2): an optional flag a reader forgets to set compiles clean and
   * silently produces ZERO channel obligations forever. Always `false` for im/mpim — mentions
   * are meaningless there (`addressedToHim` is unconditionally `true` for a DM/group DM anyway).
   */
  mentionsOwner: boolean;
  /** IN FLIGHT ONLY — see this interface's own doc comment. `undefined` when the reader has no
   *  text for this message (never fabricated as `""`, so "no text" stays distinguishable from
   *  "an empty message"). */
  text?: string;
}

export interface SlackUserIdentity {
  id: string;
  displayName: string | null;
  /** D3: `users:read.email` — the join key onto the graph. Absent when Slack has none on file
   *  (a guest account, a not-yet-synced workspace member) or the reader couldn't resolve it. */
  email: string | null;
}

export interface SlackSourceDeps {
  /** Every conversation the token can see — channels, DMs, group DMs. */
  listConversations(): Promise<SlackConversationRef[]>;
  /**
   * Every message in the conversation at or after `oldest` (a Slack ts — the scan window's
   * start, computed by the caller from `windowDays`; `undefined` only if a caller ever omits a
   * window entirely, which `scanSlackThreads` itself never does), up to `ceiling` messages, in
   * any order (this source sorts). The real reader owns paging beneath that, same division of
   * responsibility as `GmailSourceDeps.readThread`. `scanSlackThreads` ALSO filters by `oldest`
   * client-side (defense-in-depth — see Important 1 in the module header) rather than trusting
   * the reader alone to honour it.
   */
  readConversation(conversationId: string, oldest: string | undefined, ceiling: number): Promise<SlackThreadMessage[]>;
  /** Resolve a Slack user id to a name/email, or null when Slack has nothing to give back. */
  getUserInfo(userId: string): Promise<SlackUserIdentity | null>;
}

export interface SlackScanOptions {
  /** Bendik's own Slack user id — messages authored by this id are his replies, never a
   *  counterparty waiting on him. REQUIRED to be non-empty: an empty value would mean no message
   *  ever matches him, so every conversation reads as unanswered (see the throw in
   *  `scanSlackThreads`, mirroring `gatherOpenObligations`'s identity-registry guard,
   *  `brief-content.ts:424-430`). */
  ownUserId: string;
  /** Injected clock. eve injects no ambient date — every computed date is a guess without one,
   *  which has already cost this fleet two wrong reminders (see MEMORY). Required, not
   *  defaulted to `Date.now`, so a caller can never forget to supply it. */
  now: () => Date;
  /** How far back the scan reaches, in days. Defaults to `DEFAULT_SLACK_WINDOW_DAYS` (60,
   *  matching Gmail's own default) — see the module header's opening paragraph for why an
   *  unbounded scan is actively dangerous, not just wasteful. */
  windowDays?: number;
  /** Worker-pool width for reading conversations. Defaults to
   *  `DEFAULT_SLACK_SCAN_CONCURRENCY` (4). ORB-170: 40 serial round-trips measured ~8.8s; the
   *  cap could not afford channels at all. Bounded concurrency is what buys a cap that covers
   *  BOTH partitions inside the same 20s budget. */
  concurrency?: number;
  /** ORB-170 — lets the rate-limit backoff sleep be CANCELLED by the same budget that cancels
   *  the requests themselves (`scanSlackWithBudget` passes its controller's signal here as well
   *  as into the reader). Without it, a scan aborted mid-backoff would finish its sleep and
   *  fire one more request into a race nobody is reading. */
  signal?: AbortSignal;
  /** Conversations attempted this scan, at most. Bounds this source's total Slack calls — see
   *  the rate-limit note below. */
  maxConversations?: number;
  /** Messages read per conversation, at most — bounds one pathological conversation (a busy
   *  #general) from eating the whole tick. */
  maxMessagesPerConversation?: number;
}

/**
 * Bound assumptions (say-what-you-assumed, per the task brief): Slack's
 * `conversations.history`/`.replies` sit at Tier 3 — roughly 50 requests/minute per workspace,
 * shared across every caller on the token (the network importer's own comment,
 * `services/network/lib/importers/slack.ts:108-120`, derives the same ceiling for its daily
 * run). This source runs once per morning-brief tick, not continuously.
 *
 * CORRECTED (final review, item 6 — the arithmetic below was wrong; fixed only in the runbook
 * until now, docs/runbooks/slack-user-token.md's "What is NOT yet done"): this does NOT cost
 * "200 conversations × 1 `readConversation` call each." The real reader
 * (`services/chief-of-staff/lib/slack-source.ts`) makes one `conversations.history` call per PAGE
 * (100 messages/page) plus one `conversations.replies` call per thread parent it meets in a
 * channel conversation — so a busy, heavily-threaded workspace can turn one morning-brief tick
 * into hundreds of real Slack requests, not 200. `maxConversations` and
 * `maxMessagesPerConversation` bound what THIS file asks for, not what the reader beneath it
 * actually costs; re-derive the real per-tick budget from the reader's call pattern (and
 * cross-check `slack-reader.ts`'s equivalent note for the network importer, which documents the
 * same `conversations.members`/`.replies` metering gap) before trusting a number here. Neither
 * bound is unbounded, though: `listConversations()` is sliced and `readConversation`'s
 * `ceiling` argument is respected by the caller, not re-fetched in a loop — there is no
 * unbounded `conversations.history` paging inside THIS file.
 */
export const DEFAULT_MAX_SLACK_CONVERSATIONS = 200;
export const DEFAULT_MAX_MESSAGES_PER_CONVERSATION = 200;

/** Matches Gmail's own `DEFAULT_WINDOW_DAYS` (`brief-content.ts:306`) — no principled reason for
 *  the two sources to disagree on "how far back is still relevant". */
export const DEFAULT_SLACK_WINDOW_DAYS = 60;

const DAY_MS = 86_400_000;

function parseSlackTs(ts: string): Date {
  return new Date(Math.round(parseFloat(ts) * 1000));
}

/** Inverse of `parseSlackTs` — a Date to Slack's own "<unix_seconds>.<fraction>" ts format. */
function slackTsFor(date: Date): string {
  return `${Math.floor(date.getTime() / 1000)}.000000`;
}

/** Slack's own built-in bot user id — see the module header's "NOT A REAL MESSAGE" note. */
const SLACKBOT_USER_ID = "USLACKBOT";

/**
 * Slack `subtype`s that are STILL a real message a real person typed or sent — an ALLOWLIST
 * (ORB-149 T3 review round 3), checked alongside `subtype === undefined` (an ordinary message
 * carries no subtype at all). Everything NOT on this list is treated as a system event and
 * dropped — including any subtype Slack adds later that this file doesn't yet know about
 * (`tombstone`, `channel_archive`, `bot_add`, `reminder_add`, …). Deliberately fails CLOSED: an
 * unrecognized subtype is dropped, at worst hiding a rare new real-message type until this list
 * is updated — never fabricating an obligation out of a system event Slack invents next.
 *
 *   - "thread_broadcast" — a thread reply ALSO echoed into the channel ("also sent to
 *     #channel") — the same real message, just Slack's dual-visibility flag on it.
 *   - "file_share" — a message that's a file upload, still authored by a real person.
 *   - "me_message" — a real message a person typed (`/me does a thing`). MUST stay on the
 *     allowlist: an earlier round-2 draft denylisted it by mistake, treating it as a system
 *     event. If Bendik's own last message in a DM were a `/me`, dropping it would make the
 *     COUNTERPARTY's earlier message "last" instead, flip `lastSpeakerIsThem` to `true`, and
 *     surface a conversation he had actually already answered — a false positive on the exact
 *     surface this ticket exists to make trustworthy (ADR-0012: false positives are what train
 *     someone to stop reading a channel).
 */
const REAL_MESSAGE_SUBTYPES = new Set(["thread_broadcast", "file_share", "me_message"]);

/**
 * D4 compliance mechanism (see the module header's second paragraph): the ONLY lever this file
 * has over `selectObligations`'s `isRePing = theirUnansweredCount >= 2` computation is the
 * `theirUnansweredCount` it emits. Capping every Slack snapshot's count at this value makes
 * `isRePing` mathematically always `false` for a Slack-sourced Obligation — Bendik's "no ping,
 * ever" ruling for Slack coverage, enforced structurally rather than hoped for.
 *
 * Accepted trade-off: a genuine same-person double-bump on Slack (or worse) is reported as
 * `theirUnansweredCount: 1`, so it surfaces via the standard 48h `OWED_AFTER_HOURS` gate rather
 * than the faster 24h `REPING_AFTER_HOURS` one. A one-day delay on an already-slow surface, in
 * exchange for a structural guarantee against ever reopening a paused proactive surface — judged
 * the right side of that trade given D4 is Bendik's explicit instruction, not a default.
 */
const MAX_EMITTED_UNANSWERED = 1;

type Identity = { name: string; address: string };

/** `identity.address` is a real email when `resolveIdentity` found one on Slack, or the
 *  `slack:<id>` sentinel when it didn't (see `resolveIdentity`) — never a bare Slack id posing
 *  as an email. `counterpartyEmails` (ORB-45 Task 10, B1) must carry only the former. */
function emailsFor(identity: Identity): string[] {
  return identity.address.startsWith("slack:") ? [] : [identity.address];
}

/**
 * The reason a bounded scan's `AbortController` is fired with (ORB-164 fix round 1).
 *
 * A NAMED reason, not a bare `controller.abort()`, because cancellation has to be
 * DISTINGUISHABLE downstream from an ordinary failure. `resolveIdentity` below swallows every
 * `getUserInfo` error by design — losing an obligation over an identity hiccup would be worse
 * than a wrong display name — and that catch was happily swallowing the abort too, printing
 * "getUserInfo failed … degrading to a Slack-id-only identity" into the very log window this
 * ticket names as its acceptance evidence. Cancellation is not a degradation and must not read
 * like one.
 *
 * The original failure (usually the timeout) is kept as `cause`, so nothing is lost by wrapping.
 */
export class SlackScanAbortedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SlackScanAbortedError";
  }
}

/** True for the two shapes a cancelled Slack call can arrive in: our own abort reason, and the
 *  platform's `AbortError` (what `fetch` rejects with when no reason was supplied). */
export function isScanAborted(err: unknown): boolean {
  return err instanceof SlackScanAbortedError || (err instanceof Error && err.name === "AbortError");
}

/**
 * Resolves a Slack user id to the `{ name, address }` pair a `ThreadSnapshot` needs.
 * `address` is the email when Slack has one (the join key `assignSurfaces` compares against
 * tomorrow's meeting attendees) — never a bare Slack id posing as an email, which could
 * accidentally collide with a real address. Never throws: a `getUserInfo` failure degrades to
 * the raw Slack id rather than losing the obligation entirely (an obligation whose person's name
 * is wrong is still surfaced; one silently dropped because a lookup hiccuped is not).
 *
 * ONE EXCEPTION (ORB-164 fix round 1): a CANCELLED lookup is rethrown. The degrade-don't-lose
 * rule answers "this lookup failed, is the obligation still worth surfacing?" — a question that
 * no longer applies once the caller has abandoned the scan. Swallowing the abort would both
 * mislabel cancellation as a Slack failure in the log and let the scan keep walking
 * conversations after its budget was spent, which is the waste the abort exists to stop.
 */
async function resolveIdentity(deps: SlackSourceDeps, cache: Map<string, Identity>, userId: string): Promise<Identity> {
  const cached = cache.get(userId);
  if (cached) return cached;
  let info: SlackUserIdentity | null = null;
  try {
    info = await deps.getUserInfo(userId);
  } catch (err) {
    if (isScanAborted(err)) throw err;
    // CONTROLLER RULING (ORB-149 review round 3) — the only change this narrow ruling permits
    // in this file: a real SlackReader's getUserInfo (post Critical-2 fix, ./slack-source.ts)
    // only THROWS for an actual Slack failure (an API error such as missing_scope/invalid_auth,
    // or a rate limit) — a genuine "no such user" already returns null without throwing. So
    // anything reaching this catch is a real failure, not an ordinary lookup miss, and must not
    // vanish silently behind the exact same fallback a genuine miss gets. The fallback itself is
    // UNCHANGED (still `info = null` → the `slack:<id>` address below) — an obligation must
    // never be lost over an identity-lookup hiccup — but the failure is now named loudly.
    const name = err instanceof Error ? err.name : "UnknownError";
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`brief-content-slack: getUserInfo(${userId}) failed (${name}: ${detail}) — degrading to a Slack-id-only identity`);
    info = null;
  }
  const resolved: Identity = {
    name: info?.displayName ?? userId,
    // "slack:<id>" (not a bare id) so it can never be mistaken for — or accidentally equal —
    // a real email address elsewhere in the graph.
    address: info?.email ? info.email.toLowerCase() : `slack:${userId}`,
  };
  cache.set(userId, resolved);
  return resolved;
}

/**
 * Trailing run of consecutive messages authored by the SAME person as the last message — not
 * "any non-owner author" (ORB-149 T3 review round 1, Important 4). For `im` this is equivalent
 * to the simpler count (a DM has exactly one fixed counterparty, so there IS only one other
 * possible author); for `mpim`/`channel` it is the fix: two different colleagues each posting
 * once is one unanswered message from each of them, not a doubled "re-ping" against a person who
 * only spoke once. Capped by the caller via `MAX_EMITTED_UNANSWERED` regardless — see that
 * constant's own comment for why this correct count is still computed even though the emitted
 * value is capped at 1 either way: it is the right algorithm for THIS source to own, independent
 * of D4's separate, current policy choice to cap what it emits.
 */
function trailingUnansweredFromLastSpeaker(messages: SlackThreadMessage[], own: string): number {
  const last = messages[messages.length - 1]!;
  if (last.userId === own) return 0;
  const speaker = last.userId;
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.userId !== speaker) break;
    count++;
  }
  return count;
}

function cappedUnanswered(messages: SlackThreadMessage[], own: string): number {
  return Math.min(trailingUnansweredFromLastSpeaker(messages, own), MAX_EMITTED_UNANSWERED);
}

async function buildDirectSnapshot(
  deps: SlackSourceDeps,
  cache: Map<string, Identity>,
  convo: SlackConversationRef,
  messages: SlackThreadMessage[],
  own: string,
): Promise<ThreadSnapshot> {
  const last = messages[messages.length - 1]!;
  const lastFromThem = last.userId !== own;
  const unanswered = lastFromThem ? cappedUnanswered(messages, own) : 0;

  // im: the fixed counterparty from the conversation ref. mpim: no single fixed counterparty
  // exists — credit whoever spoke last (see the module header's SCOPE note).
  const counterpartyUserId = convo.kind === "im" ? (convo.counterpartyUserId ?? last.userId ?? own) : (last.userId ?? own);
  const identity = await resolveIdentity(deps, cache, counterpartyUserId);

  return {
    // Important 3 (ORB-149 T3 review round 1): an im/mpim thread id is scoped to the LAST
    // MESSAGE's ts, not just the conversation id. A DM is the whole relationship, unbounded —
    // unlike a Gmail thread, it never "closes". Without this, dismissing one bump would
    // permanently blind the radar to every future message from that person: dismissal has no
    // reopen path anywhere in the store (`obligations-store.ts` / `019_obligations.sql` only
    // ever SET `dismissed_at`, never clear it). Scoping to the last message's ts means a
    // genuinely new event (a reply from him, or a fresh message from them) always produces a NEW
    // thread id that a stale dismissal can't match — "reopen on new activity", achieved here
    // without needing a store-level reopen rule (the alternative the review offered; this one
    // needs no change outside this file). Channel THREAD ids are not scoped this way — a Slack
    // thread is already bounded to one conversation instance, the same granularity as a Gmail
    // thread, not an unbounded relationship.
    threadId: `slack:${convo.kind}:${convo.id}:${last.ts}`,
    subject: convo.kind === "im" ? "Slack DM" : "Slack group DM",
    counterpartyName: identity.name,
    counterpartyAddress: identity.address,
    lastMessageAt: parseSlackTs(last.ts),
    lastSpeakerIsThem: lastFromThem,
    // A DM/group DM is inherently directed at every member — there is no "Cc" in Slack DMs.
    addressedToHim: true,
    isAutomated: false,
    // ORB-180 Workstream B — a Slack DM is a PERSON. The due-notice rule is a mail rule (a
    // sender domain and a subject line), and Slack has neither; set explicitly rather than left
    // undefined so nobody later reads the absence as "not yet decided".
    isDeadlineCandidate: false,
    theirUnansweredCount: unanswered,
    source: "slack",
    lastMessageText: last.text?.slice(0, LAST_MESSAGE_MAX_CHARS),
    counterpartyEmails: emailsFor(identity),
    counterpartySlackUserId: counterpartyUserId,
  };
}

/** Group by Slack thread — `threadTs` is required on every message (see its own doc comment),
 *  so every message has a group key with no fallback needed here. Shared by `buildChannelSnapshots`
 *  and `collectOwnActivity`'s per-thread scope for a channel conversation, so the two can never
 *  disagree on where a thread's boundary is. */
function groupByThreadTs(messages: readonly SlackThreadMessage[]): Map<string, SlackThreadMessage[]> {
  const groups = new Map<string, SlackThreadMessage[]>();
  for (const m of messages) {
    const group = groups.get(m.threadTs);
    if (group) group.push(m);
    else groups.set(m.threadTs, [m]);
  }
  return groups;
}

/**
 * Takes pre-grouped threads (`groupByThreadTs`) rather than raw messages so `scanOneConversation`
 * can reuse the SAME groups for `collectOwnActivity` (ORB-45 Task 10, B1) — grouping once, not
 * twice, and guaranteeing the two can never disagree on where a thread's boundary is.
 */
async function buildChannelSnapshots(
  deps: SlackSourceDeps,
  cache: Map<string, Identity>,
  convo: SlackConversationRef,
  groups: Map<string, SlackThreadMessage[]>,
  own: string,
): Promise<ThreadSnapshot[]> {
  const out: ThreadSnapshot[] = [];
  for (const [key, group] of groups) {
    const ownerParticipated = group.some((m) => m.userId === own);
    const mentioned = group.some((m) => m.userId !== own && m.mentionsOwner);
    // The line the importer's own CONTROLLER RULING draws for channel messages: a broadcast he
    // was never mentioned in and never joined is not an interaction with him there either. Never
    // becomes a candidate at all — not "answered", not "unanswered", just not in scope.
    if (!ownerParticipated && !mentioned) continue;

    // NOTE — truncation risk: `ownerParticipated` above is computed only over the messages THIS
    // scan actually fetched (bounded by `maxMessagesPerConversation`). If Bendik's own reply
    // sits earlier in the thread than this scan's window reaches, a sufficiently busy thread
    // could be truncated to a point where his real participation is invisible to this pass — it
    // would then only surface via the `mentioned` branch, or not at all until a wider/later scan
    // reaches it. A known, accepted limitation of a bounded live scan (mirrors Gmail's own
    // bounded `CANDIDATE_SCAN_CEILING`), not silently wrong: nothing here claims full history,
    // and a miss self-heals once the conversation re-enters the scan window on a later tick, or
    // once `maxMessagesPerConversation` is tuned up.

    // `group` is a stable subset of `messages`, which the caller (scanSlackThreads) already
    // sorted chronologically before grouping; Map iteration preserves insertion order, so `group`
    // is already sorted — no re-sort needed here.
    const last = group[group.length - 1]!;
    const lastFromThem = last.userId !== own;
    const unanswered = lastFromThem ? cappedUnanswered(group, own) : 0;

    // Counterparty = whoever last spoke, when it's them. When Bendik spoke last instead
    // (lastFromThem is false), selectObligations drops this candidate regardless ("he spoke
    // last — the ball is not his") — but a snapshot still needs SOME identity to resolve, so
    // fall back to the most recent other author, or his own id as a last resort for the
    // (never-expected) case of a thread with no other author at all.
    const counterpartyUserId = lastFromThem ? last.userId! : ([...group].reverse().find((m) => m.userId !== own)?.userId ?? own);
    const identity = await resolveIdentity(deps, cache, counterpartyUserId);

    out.push({
      threadId: `slack:channel:${convo.id}:${key}`,
      subject: "Slack thread",
      counterpartyName: identity.name,
      counterpartyAddress: identity.address,
      lastMessageAt: parseSlackTs(last.ts),
      lastSpeakerIsThem: lastFromThem,
      // Only reached when mentioned or already a participant — never a plain broadcast.
      addressedToHim: true,
      isAutomated: false,
      // ORB-180 Workstream B — see the DM builder above: never a due notice.
      isDeadlineCandidate: false,
      theirUnansweredCount: unanswered,
      source: "slack",
      lastMessageText: last.text?.slice(0, LAST_MESSAGE_MAX_CHARS),
      counterpartyEmails: emailsFor(identity),
      counterpartySlackUserId: counterpartyUserId,
    });
  }
  return out;
}

/** `scanSlackThreadsWithOwnActivity`'s return shape — the snapshots `scanSlackThreads` has
 *  always returned, plus the Slack half of "did he answer them somewhere else" (Task B2). */
export interface SlackScanResult {
  snapshots: ThreadSnapshot[];
  /** Slack user id → the latest own-message ts sent TO that person (DM) or IN a scope they were
   *  also active in (mpim / channel thread) — see `collectOwnActivity`'s own doc comment. */
  ownLastMessageByUser: Map<string, Date>;
}

/**
 * Slack conversations → `ThreadSnapshot[]` + `ownLastMessageByUser`, ready for `selectObligations`
 * alongside (or merged with) whatever `scanThreads` (Gmail) produced. Bounded, live, no persisted
 * cursor of its own (D2 — this reads fresh every tick rather than riding any daily replica).
 *
 * THROWS when `opts.ownUserId` is empty (Important 5, ORB-149 T3 review round 1) — mirroring
 * `gatherOpenObligations`'s identity-registry guard (`brief-content.ts:424-430`): an empty value
 * would mean no message ever matches him, so EVERY conversation would read as unanswered and
 * every DM would become an obligation. `[]` or silently proceeding would both be worse than
 * loud — this never degrades to either.
 */
export async function scanSlackThreadsWithOwnActivity(deps: SlackSourceDeps, opts: SlackScanOptions): Promise<SlackScanResult> {
  if (!opts.ownUserId) {
    throw new Error(
      "cannot tell which Slack messages are his: ownUserId is empty — every conversation would " +
        "read as unanswered, and every DM would become an obligation",
    );
  }

  const maxConversations = opts.maxConversations ?? DEFAULT_MAX_SLACK_CONVERSATIONS;
  const maxMessages = opts.maxMessagesPerConversation ?? DEFAULT_MAX_MESSAGES_PER_CONVERSATION;
  const windowDays = opts.windowDays ?? DEFAULT_SLACK_WINDOW_DAYS;
  const own = opts.ownUserId;

  // Important 1 (ORB-149 T3 review round 1): the scan window. `oldest` is passed to the reader
  // so a real implementation can use Slack's own `oldest` history param efficiently; the
  // client-side filter below is defense-in-depth against a reader that doesn't honour it.
  const oldestTs = slackTsFor(new Date(opts.now().getTime() - windowDays * DAY_MS));
  const oldestNum = parseFloat(oldestTs);

  const allConversations = await deps.listConversations();
  // Bounded scan — see the module-header rate-limit note. No persisted "least-recently-swept"
  // ordering (unlike the importer's cursor table): this is a per-tick live read with no cursor
  // state of its own — anything `selectScanSet` leaves out is NEVER scanned, not merely
  // deferred (ORB-149 review round 3 established there is no cursor on this path at all).
  //
  // ORB-170: the slice used to be `slice(0, maxConversations)` over the reader's DM-first
  // list. On the real workspace — exactly 40 DMs and 44 channels at a cap of 40 — that slice
  // was the 40 DMs, and no channel was EVER scanned. `selectScanSet` guarantees each partition
  // a share of the cap instead of trusting the input order to be survivable.
  const conversations = selectScanSet(allConversations, maxConversations);
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_SLACK_SCAN_CONCURRENCY, conversations.length || 1));

  const identityCache = new Map<string, Identity>();
  const scanCtx = { oldestTs, oldestNum, maxMessages, own, signal: opts.signal };

  // ORB-170 — a worker pool, reassembled BY SELECTION INDEX. Completion order is whatever the
  // network makes it; output order must not be, or every downstream snapshot assertion (and
  // the dedupe semantics of gatherOpenObligations) becomes timing-dependent.
  const results: ConversationScanResult[] = new Array(conversations.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = nextIndex++;
      if (i >= conversations.length) return;
      results[i] = await scanOneConversation(deps, identityCache, conversations[i]!, scanCtx);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const ownLastMessageByUser = new Map<string, Date>();
  for (const r of results) mergeLatest(ownLastMessageByUser, r.ownActivity);
  return { snapshots: results.flatMap((r) => r.snapshots), ownLastMessageByUser };
}

/** Unchanged signature/return type (existing callers — `agent/schedules/morning-brief.ts` — and
 *  tests keep reading just the snapshots) — delegates to `scanSlackThreadsWithOwnActivity`. */
export async function scanSlackThreads(deps: SlackSourceDeps, opts: SlackScanOptions): Promise<ThreadSnapshot[]> {
  return (await scanSlackThreadsWithOwnActivity(deps, opts)).snapshots;
}

/** Pool width for the conversation scan (ORB-170). Four keeps 80 conversations comfortably
 *  inside the measured 20s budget (~180ms each serial → ~4.5s pooled) without hammering
 *  Slack's Tier-3 per-minute ceiling the way an unbounded fan-out would. */
export const DEFAULT_SLACK_SCAN_CONCURRENCY = 4;

/** Longest a rate-limit backoff will actually wait. Slack's Retry-After can say 30s+; inside a
 *  20s scan budget honouring that in full is indistinguishable from skipping the conversation,
 *  so the wait is capped and a second 429 skips (see `scanOneConversation`). */
const RATE_LIMIT_MAX_WAIT_MS = 10_000;

/**
 * Partition-aware cap (ORB-170). Under the cap, everything scans. Over it, channels are
 * GUARANTEED `floor(cap/2)` of the budget and DMs keep both their priority position (first)
 * and any remainder a small channel partition hands back. Relative order within each
 * partition is preserved; anything with an unknown kind counts as a channel, mirroring the
 * reader's own default.
 */
export function selectScanSet(all: readonly SlackConversationRef[], cap: number): SlackConversationRef[] {
  if (all.length <= cap) return [...all];
  const dms = all.filter((c) => c.kind !== "channel");
  const channels = all.filter((c) => c.kind === "channel");
  let channelBudget = Math.min(channels.length, Math.floor(cap / 2));
  const dmBudget = Math.min(dms.length, cap - channelBudget);
  channelBudget = Math.min(channels.length, cap - dmBudget);
  return [...dms.slice(0, dmBudget), ...channels.slice(0, channelBudget)];
}

/** Abort-aware sleep for the backoff below — the budget's signal must be able to cancel a
 *  wait, or an aborted scan would finish sleeping and fire one more request. */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new Error("slack scan aborted during rate-limit backoff"));
    }
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface ScanConversationCtx {
  readonly oldestTs: string;
  readonly oldestNum: number;
  readonly maxMessages: number;
  readonly own: string;
  readonly signal?: AbortSignal;
}

/**
 * For one scope of messages — a whole im/mpim conversation, or one channel thread group (see
 * `groupByThreadTs`) — the latest own-authored message's ts per OTHER author who spoke in that
 * scope. This is the Slack half of "did he answer them somewhere else" (Task B2):
 * `ownLastMessageByUser` on `SlackScanResult` below.
 *
 * "Other participant" here means "an author this scan actually saw", not a conversation roster
 * this file has no way to fetch — the same bounded-live-scan trade-off `buildChannelSnapshots`'s
 * own truncation-risk note already accepts for `ownerParticipated`.
 */
function collectOwnActivity(messages: readonly SlackThreadMessage[], own: string): Map<string, Date> {
  const others = new Set<string>();
  for (const m of messages) if (m.userId && m.userId !== own) others.add(m.userId);

  const out = new Map<string, Date>();
  for (const m of messages) {
    if (m.userId !== own) continue;
    const ts = parseSlackTs(m.ts);
    for (const other of others) {
      const existing = out.get(other);
      if (!existing || ts > existing) out.set(other, ts);
    }
  }
  return out;
}

/** Merges `source` into `target` in place, keeping the LATER date on a key collision — how
 *  `scanSlackThreadsWithOwnActivity` combines per-conversation activity into one map. */
function mergeLatest(target: Map<string, Date>, source: ReadonlyMap<string, Date>): void {
  for (const [userId, date] of source) {
    const existing = target.get(userId);
    if (!existing || date > existing) target.set(userId, date);
  }
}

interface ConversationScanResult {
  snapshots: ThreadSnapshot[];
  ownActivity: Map<string, Date>;
}

/** One conversation's read + snapshot build, with the ORB-170 backoff: a 429 waits
 *  (capped, abortable) and retries ONCE; a second 429 skips THIS conversation and the scan
 *  survives. Any other error propagates — backoff never becomes a general swallow. */
async function scanOneConversation(
  deps: SlackSourceDeps,
  identityCache: Map<string, Identity>,
  convo: SlackConversationRef,
  ctx: ScanConversationCtx,
): Promise<ConversationScanResult> {
  let rawMessages: SlackThreadMessage[];
  try {
    rawMessages = await readWithBackoff(deps, convo.id, ctx);
  } catch (err) {
    if (err instanceof SlackRateLimitError) {
      console.warn(
        `slack scan: conversation ${convo.id} rate-limited twice — skipped this pass ` +
          `(retry-after ${err.retryAfterSeconds}s); it will be attempted again next tick`,
      );
      return { snapshots: [], ownActivity: new Map() };
    }
    throw err;
  }
  const messages = rawMessages.filter(
    (m): m is SlackThreadMessage & { userId: string } =>
      !!m.userId &&
      !m.isBot &&
      m.userId !== SLACKBOT_USER_ID &&
      (m.subtype === undefined || REAL_MESSAGE_SUBTYPES.has(m.subtype)) &&
      parseFloat(m.ts) >= ctx.oldestNum,
  );
  if (messages.length === 0) return { snapshots: [], ownActivity: new Map() };
  messages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

  if (convo.kind === "channel") {
    const groups = groupByThreadTs(messages);
    const snapshots = await buildChannelSnapshots(deps, identityCache, convo, groups, ctx.own);
    const ownActivity = new Map<string, Date>();
    for (const group of groups.values()) mergeLatest(ownActivity, collectOwnActivity(group, ctx.own));
    return { snapshots, ownActivity };
  }
  const snapshot = await buildDirectSnapshot(deps, identityCache, convo, messages, ctx.own);
  return { snapshots: [snapshot], ownActivity: collectOwnActivity(messages, ctx.own) };
}

async function readWithBackoff(
  deps: SlackSourceDeps,
  conversationId: string,
  ctx: ScanConversationCtx,
): Promise<SlackThreadMessage[]> {
  try {
    return await deps.readConversation(conversationId, ctx.oldestTs, ctx.maxMessages);
  } catch (err) {
    if (!(err instanceof SlackRateLimitError)) throw err;
    await sleepAbortable(Math.min(Math.max(err.retryAfterSeconds, 0) * 1000, RATE_LIMIT_MAX_WAIT_MS), ctx.signal);
    return await deps.readConversation(conversationId, ctx.oldestTs, ctx.maxMessages);
  }
}
