import type { Db } from "../db.js";
import { upsertContact, findContactByIdentity } from "../resolve.js";
import { normalizeEmail } from "../normalize.js";
import { recomputePulse } from "../import-all.js";

export type SlackConversationType = "public_channel" | "private_channel" | "im" | "mpim";

/**
 * A group DM's own hard member cap (Slack enforces this); used to bound the
 * mpim fan-out below defensively even though Slack should never hand us more.
 */
const MAX_MPIM_FANOUT = 8;

/**
 * Discriminated by `type` so the fields each conversation type actually needs
 * are required at the TYPE level, not just documented:
 *  - `im` needs its one fixed counterparty (Slack's own `conversations.list`
 *    gives this directly on an im object, as `user`). A reader that forgets to
 *    map it is a compile error here, not a silently-wrong runtime import.
 *  - `mpim` needs its member list, to fan a single message into one row per
 *    other member (see the CONTROLLER RULING below).
 *  - channels need neither.
 */
export type SlackConversation =
  | { id: string; type: "public_channel" | "private_channel" }
  | { id: string; type: "im"; counterpartyUserId: string }
  | { id: string; type: "mpim"; members: string[] };

/**
 * A single Slack message as returned by conversations.history/.replies.
 *
 * `mentions` and `threadHasOwnReply` are NON-OPTIONAL (review round 3,
 * CONTROLLER RULING): the same Important-2 shape — a reader that forgets to
 * populate a field silently drops a whole category of signal — applies here
 * one field over. A reader that ships without computing them is a compile
 * error, not a channel that silently produces zero rows forever. The reader
 * has to compute `threadHasOwnReply` anyway for the channel rule to mean
 * anything, so requiring it costs nothing.
 */
/**
 * One reply inside a channel thread, as `conversations.replies` returns it — the replies the
 * reader ALREADY fetched to compute `threadHasOwnReply` below, handed to the importer instead of
 * being read off the wire and thrown away (ORB-149 defect 2).
 *
 * Deliberately smaller than `SlackMessage`: a reply carries no `threadHasOwnReply` (it is not a
 * thread parent) and no `mentions` (the channel rule decides relevance on the PARENT — see the
 * rule block at the channel branch below — so nothing would ever read a reply's mentions, and
 * this module does not carry signals it does not use).
 */
export interface SlackThreadReply {
  /** Slack's own per-message clock, unique within the conversation — the ts half of the dedupe key. */
  ts: string;
  /** Author's Slack user id. Absent for some system/bot messages. */
  user?: string;
  /** Present on bot-authored messages instead of `user` — skipped, exactly like a top-level message. */
  botId?: string;
}

export interface SlackMessage {
  /** Slack's own per-message clock: "<unix_seconds>.<microseconds>", string-sortable within a channel. */
  ts: string;
  /** Author's Slack user id. Absent for some system/bot messages. */
  user?: string;
  /** Present on bot-authored messages instead of `user` — skipped (no stable person to resolve). */
  botId?: string;
  /**
   * Slack user ids @-mentioned in this message's TEXT, parsed by the reader —
   * the importer never receives message text itself (the privacy boundary
   * holds one layer further back than just "we don't write it to the db").
   * Used only to decide whether a channel message is relevant (see the
   * CONTROLLER RULING below); never persisted. `[]` when there are none.
   */
  mentions: string[];
  /**
   * True when this message sits in a thread (has a Slack `thread_ts`) AND
   * Bendik has posted at least one reply in that same thread. Reader-computed
   * (it already has the thread's full participant list when it fetches a
   * page); the importer treats it as an opaque relevance signal.
   */
  threadHasOwnReply: boolean;
  /**
   * The thread's replies, as the reader already fetched them via `conversations.replies` while
   * computing `threadHasOwnReply` (ORB-149 defect 2 — these used to be discarded). `[]` when the
   * message is not a thread parent, has no replies, or belongs to an `im`/`mpim` (the reader
   * never walks `.replies` there, because those kinds write unconditionally and the rule that
   * consumes this field is the CHANNEL rule).
   *
   * NON-OPTIONAL for the same reason `mentions`/`threadHasOwnReply` are: a reader that forgets to
   * populate it drops a whole category of signal silently. `[]` is the honest empty value.
   */
  threadReplies: SlackThreadReply[];
}

export interface SlackHistoryPage {
  messages: SlackMessage[];
  /** Slack's own pagination cursor; null/undefined once the requested window is exhausted. */
  nextCursor?: string | null;
  /**
   * How many `conversations.replies` requests the reader made while assembling THIS page
   * (ORB-149 defect 2). The importer charges them to `maxRequestsPerRun` the way it charges the
   * `conversations.history` call itself — closing the accounting gap both this file and
   * `slack-reader.ts` used to document as known-and-unfixed. Optional only because a reader that
   * makes no `.replies` calls at all (any `im`/`mpim` page, and the test fakes) honestly made
   * zero; omitted is read as 0.
   */
  repliesRequests?: number;
}

export interface SlackUserInfo {
  id: string;
  email: string | null;
  displayName: string | null;
}

/**
 * A reader implementation throws this when Slack answers with HTTP 429. Lets
 * the importer distinguish "back off, workspace-wide, stop making requests
 * this run" from an ordinary per-conversation failure it can just skip past.
 */
export class SlackRateLimitError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, message = `Slack rate limit hit; retry after ${retryAfterSeconds}s`) {
    super(message);
    this.name = "SlackRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * A reader implementation throws this when Slack rejects a pagination cursor as `invalid_cursor`
 * — a `resume_cursor` this importer persisted on an earlier run that Slack has since forgotten
 * (they age out). Typed rather than string-matched for the same reason `SlackRateLimitError` is:
 * the importer has to react to it STRUCTURALLY (clear the dead cursor so the conversation
 * restarts from its committed high-water mark on the next run — see the catch block at the
 * bottom of the conversation loop), and a run that merely recorded the message would re-pin the
 * same dead cursor and stall that conversation forever (ORB-149 defect 3).
 */
export class SlackInvalidCursorError extends Error {
  constructor(message = "Slack rejected the pagination cursor as invalid_cursor (it has aged out)") {
    super(message);
    this.name = "SlackInvalidCursorError";
  }
}

/**
 * Everything the importer needs from Slack, and nothing else. The real
 * implementation (a later task) is a thin `fetch` wrapper over
 * `conversations.list` / `conversations.history` / `users.info`; tests supply
 * a fake so the importer runs without a token or a network. Any method may
 * throw `SlackRateLimitError` on a 429; anything else it throws is treated as
 * a per-conversation (or, from `listConversations`, whole-run) failure that
 * gets recorded and skipped rather than aborting the run.
 *
 * CLOSED 2026-09-03 (ORB-149 defect 2), previously a KNOWN GAP: `conversations.replies` calls
 * used to be invisible to `maxRequestsPerRun`. A page now reports how many it cost
 * (`SlackHistoryPage.repliesRequests`) and the importer charges every one of them, so a
 * heavily-threaded workspace can no longer burn far more real Slack requests than the budget
 * says. Still NOT metered (unchanged, and still documented as such below):
 * `conversations.members` (once per mpim, inside `listConversations`) and the reader's own
 * internal empty-page walk inside `history()`.
 */
export interface SlackReader {
  listConversations(): Promise<SlackConversation[]>;
  /**
   * `oldest`, when given, is a Slack `ts` — only messages strictly after it
   * come back (Slack's own default: `inclusive=false`). `cursor`, when
   * given, resumes a paged walk through the same [oldest, now) window.
   */
  history(conversationId: string, oldest: string | undefined, cursor: string | undefined): Promise<SlackHistoryPage>;
  getUserInfo(userId: string): Promise<SlackUserInfo | null>;
}

export type SlackImportOptions = {
  /** Bendik's own Slack user id — messages authored by this id are 'outbound'. */
  ownUserId: string;
  /** Injected clock — no bare `new Date()`/`Date.now()` in the logic path. */
  now?: () => Date;
  /**
   * Total messages scanned across this whole run (all conversations combined).
   * Slack's `conversations.history`/`.replies` sit at Tier 3 (~50 requests/minute
   * per workspace, tokens shared across the whole app). At the default page size
   * (100 msgs/page) that's a ceiling of ~5000 messages/minute if nothing else on
   * the token is calling Slack concurrently — which is not a safe assumption for
   * a daily-cron-shaped import. This default assumes a single page (100 msgs) per
   * conversation as the steady-state (import runs daily; most conversations don't
   * produce 100+ messages/day) with headroom for a handful of busier channels,
   * while keeping one run comfortably inside a small slice of the per-minute
   * budget rather than assuming the whole budget is ours.
   *
   * NOTE: this bounds messages SCANNED, a proxy for API cost but not the cost
   * itself — see `maxRequestsPerRun` for the actual request ceiling (Tier 3
   * meters requests, and a caught-up conversation costs a full request for
   * zero messages).
   */
  maxMessagesPerRun?: number;
  /** Defensive bound on pages walked per conversation per run, independent of maxMessagesPerRun. */
  maxPagesPerConversation?: number;
  /**
   * Total `conversations.history` + `users.info` requests across this whole
   * run. Unlike maxMessagesPerRun, it's charged even when a conversation is
   * fully caught up and returns zero messages — otherwise a workspace with
   * hundreds of conversations makes hundreds of requests every single run
   * forever, no matter how small the message traffic is.
   *
   * CORRECTED (final review, Important 3): this is NOT the real Tier-3-adjacent ceiling —
   * an earlier version of this comment claimed it was. It does not meter
   * `conversations.members` (once per mpim, inside `listConversations`) or the reader's own
   * internal empty-page walk inside `history()` (up to `MAX_CONSECUTIVE_EMPTY_HISTORY_PAGES`
   * real Slack requests charged here as a single budget unit) — see `slack-reader.ts`'s own doc
   * comments for each. `conversations.replies` USED to be on that list too and no longer is
   * (ORB-149 defect 2, 2026-09-03): every `.replies` call a page cost is reported by the reader
   * as `SlackHistoryPage.repliesRequests` and charged here. Consequence worth knowing before a
   * catch-up run: on a threaded workspace this budget now empties much faster than it used to,
   * so `stoppedEarly: "requests"` becomes common where it was rare — that is the budget
   * becoming honest, not a regression. Raise `--max-requests` rather than reading it as one.
   * A busy, heavily-threaded workspace makes real Slack API calls well beyond what this number
   * suggests. The reader now retries a 429 with a bounded sleep honouring Slack's own
   * `Retry-After` instead of aborting the run on the very first one, which absorbs most of the
   * practical risk — but this field is still a lower bound on real request volume, not an
   * accurate ceiling, and should not be read as one.
   */
  maxRequestsPerRun?: number;
  /**
   * Cap on how many conversations one run will attempt at all, applied AFTER
   * sorting least-recently-swept first (see the ordering note below) — bounds
   * `listConversations()`'s result at the importer's boundary even though the
   * reader itself is responsible for paginating the underlying
   * `conversations.list` calls.
   */
  maxConversationsPerRun?: number;
};

export type SlackStopReason = "messages" | "requests" | "pages" | "conversations" | "rate_limited";

export type SlackSummary = {
  /** Conversations actually attempted this run (after ordering + maxConversationsPerRun). */
  conversations: number;
  /**
   * Everything `listConversations()` returned this run, broken down by type — BEFORE the
   * `maxConversationsPerRun` cap (final review, Important 5). `conversations.list` returns only
   * the conversation TYPES the token's scopes cover: a token missing `im:read` succeeds, returns
   * channels only, records no error, and advances cursors for what it did see — a clean-looking
   * `exitCode 0` run indistinguishable from "Bendik genuinely has no DMs". This breakdown is
   * what makes the two distinguishable; see `scopeWarnings` below for the loud version.
   */
  conversationsByType: Record<SlackConversationType, number>;
  /**
   * Populated when `listConversations()` succeeded but came back with zero of an expected
   * conversation type (final review, Important 5) — the signal that a scope may be missing
   * rather than that type genuinely being empty. Advisory only: it does not fail the run or set
   * a non-zero exit code, because e.g. zero `mpim` conversations is a perfectly ordinary
   * workspace shape, not a defect. Empty when `listConversations()` itself failed (that failure
   * is already recorded in `errors` below and would make every count spuriously zero).
   */
  scopeWarnings: string[];
  /**
   * Every message the run's message BUDGET was charged for — i.e. every message this run
   * read off a `conversations.history` page, regardless of what happened to it next (ORB-149
   * T-firstrun). This is the number that answers "how much of the run's message budget did
   * this run actually burn through, on top of the request budget in `errors`/request
   * counters" — most usefully, WHY `messagesProcessed` can legitimately be 0 while
   * `stoppedEarly.reason` is `"messages"`: a run that spends its entire budget on bot/system
   * traffic in a noisy channel examines every one of those messages (charging budget for
   * each) but processes none of them, because none has a resolvable person to attach to.
   * Without this field that combination reads as a contradiction; with it, it reads as "the
   * budget went to messages that turned out to be skippable."
   */
  messagesExamined: number;
  /**
   * Of `messagesExamined`, how many were skipped at the very first gate — no `user` field, or
   * a `botId` present (i.e. bot/system authored) — before any interaction-relevance logic
   * (mentions, thread participation, im/mpim fan-out) ever ran (ORB-149 T-firstrun). This is
   * the number that turns "budget spent, nothing processed" from a mystery into a stated
   * fact: a busy alert channel with hundreds of bot posts a day will show up here, not as a
   * silent zero.
   */
  messagesSkippedNotAPerson: number;
  /**
   * Of `messagesExamined`, how many were channel THREAD REPLIES rather than top-level messages
   * (ORB-149 defect 2). Zero before 2026-09-03, because replies were fetched and discarded; a
   * catch-up run that leaves this at zero on a workspace with threaded channels means the
   * relevant-thread gate never fired, not that the fix is quietly working.
   */
  threadRepliesExamined: number;
  /**
   * `conversations.replies` requests charged to `maxRequestsPerRun` this run (ORB-149 defect 2)
   * — the number that used to be invisible. Read it beside `stoppedEarly` to tell "the run ran
   * out of requests because threads are expensive" from any other reason.
   */
  repliesRequestsCharged: number;
  /**
   * Distinct Slack messages fully handled this run — written (new or
   * duplicate), determined unresolvable, or ruled not-an-interaction.
   * Does NOT count a message abandoned mid-resolution by request-budget
   * exhaustion (that message is left for a future run, not "processed"), and
   * does NOT count a message skipped as not-a-person (see
   * `messagesSkippedNotAPerson` above — those are examined but never reach
   * this count). One message, regardless of mpim fan-out — use
   * `interactionRowsWritten` for row counts (review round 3, Minor: these
   * used to be conflated).
   */
  messagesProcessed: number;
  /** Interaction ROWS written to `interactions` (net-new, via INSERT OR IGNORE's changes count). An mpim message can produce up to MAX_MPIM_FANOUT rows from one message. */
  interactionRowsWritten: number;
  newContacts: number;
  linkedExisting: number;
  /** Present only when this run stopped before every conversation was fully swept; first reason wins, except rate_limited which always wins (it aborts the run outright). */
  stoppedEarly?: { reason: SlackStopReason };
  /**
   * Per-conversation (or "*" for a listConversations-level, "pulse" for the
   * end-of-run recompute below) failures that did NOT abort the run.
   */
  errors: { conversationId: string; error: string }[];
  /**
   * `network import` is the only command that used to call `recomputePulse` (ORB-149
   * gap-closing) — so a `slack-import` run wrote `interactions` rows but left `pulse` stale
   * until whenever `network import` next ran, however that happened to be ordered in the
   * daily chain. This makes `slack-import` self-contained: it always recomputes at the end of
   * its own run (even when `interactionRowsWritten` is 0 — a quiet run still leaves scores
   * correct, and skipping it would make correctness depend on whether new messages happened
   * to arrive), so nothing else needs to run first or after for Pulse to be current. Absent
   * only when the recompute itself threw — see the `"pulse"` entry in `errors` above; the
   * already-committed interaction rows are never rolled back for that.
   */
  pulse?: { scored: number; dormantWarm: number; cadenceBreaks: number };
};

const DEFAULT_MAX_MESSAGES_PER_RUN = 1000;
const DEFAULT_MAX_PAGES_PER_CONVERSATION = 20;
const DEFAULT_MAX_REQUESTS_PER_RUN = 200;
const DEFAULT_MAX_CONVERSATIONS_PER_RUN = 500;

type CursorRow = { oldest: string | null; resume_cursor: string | null; pending_high_water: string | null };

/** Internal-only sentinel: distinguishes "resolveContact ran out of REQUEST budget mid-page" from a real "no such user" (null). Never crosses the module boundary. */
const REQUEST_BUDGET_EXHAUSTED = Symbol("slack-import-request-budget-exhausted");
type ResolveContactResult = number | null | typeof REQUEST_BUDGET_EXHAUSTED;

export async function importSlack(db: Db, reader: SlackReader, opts: SlackImportOptions): Promise<SlackSummary> {
  const now = opts.now ?? (() => new Date());
  const maxMessages = opts.maxMessagesPerRun ?? DEFAULT_MAX_MESSAGES_PER_RUN;
  const maxPages = opts.maxPagesPerConversation ?? DEFAULT_MAX_PAGES_PER_CONVERSATION;
  const maxRequests = opts.maxRequestsPerRun ?? DEFAULT_MAX_REQUESTS_PER_RUN;
  const maxConversations = opts.maxConversationsPerRun ?? DEFAULT_MAX_CONVERSATIONS_PER_RUN;

  const summary: SlackSummary = {
    conversations: 0,
    conversationsByType: { public_channel: 0, private_channel: 0, im: 0, mpim: 0 },
    scopeWarnings: [],
    messagesExamined: 0,
    messagesSkippedNotAPerson: 0,
    threadRepliesExamined: 0,
    repliesRequestsCharged: 0,
    messagesProcessed: 0,
    interactionRowsWritten: 0,
    newContacts: 0,
    linkedExisting: 0,
    errors: [],
  };
  let stopReason: SlackStopReason | undefined;

  // content is ALWAYS NULL — this is the GDPR privacy boundary (replica.ts's
  // RAW_CONTENT_COLUMNS), not something a caller can opt into. Slack is
  // signals-only: who, when, which conversation, direction. Message TEXT
  // never even reaches this function — see SlackMessage.mentions/threadHasOwnReply,
  // which carry pre-parsed relevance flags instead of raw text.
  const ins = db.prepare(
    "INSERT OR IGNORE INTO interactions (contact_id, channel, direction, at, content, external_id) VALUES (?, 'slack', ?, ?, NULL, ?)",
  );
  const getCursor = db.prepare("SELECT oldest, resume_cursor, pending_high_water FROM slack_cursors WHERE conversation_id = ?");
  const setCursor = db.prepare(
    `INSERT INTO slack_cursors (conversation_id, oldest, resume_cursor, pending_high_water, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET oldest=excluded.oldest, resume_cursor=excluded.resume_cursor,
       pending_high_water=excluded.pending_high_water, updated_at=excluded.updated_at`,
  );

  const contactCache = new Map<string, number | null>();
  let requestBudget = maxRequests;

  /**
   * Resolves a Slack user id to a contact id. Three distinct outcomes, kept
   * distinguishable end to end (review round 3, BLOCKING fix): a real
   * contact id; `null` for a genuine "no such user" (deactivated/invisible —
   * safe to treat as permanently unresolvable, never creates a junk
   * contact); or the `REQUEST_BUDGET_EXHAUSTED` sentinel when we simply
   * haven't been ABLE to ask Slack yet. The two null-ish outcomes used to be
   * conflated as plain `null`, which silently dropped messages AND let the
   * cursor advance past them — this sentinel is what lets the caller treat
   * budget exhaustion as "retry later", not "nothing to see here".
   */
  async function resolveContact(userId: string): Promise<ResolveContactResult> {
    if (contactCache.has(userId)) return contactCache.get(userId)!;

    let contactId = findContactByIdentity(db, "slack_user", userId);
    if (contactId === null) {
      if (requestBudget <= 0) return REQUEST_BUDGET_EXHAUSTED; // do not cache — this is budget exhaustion, not "no such user"
      requestBudget--;
      const info = await reader.getUserInfo(userId);
      if (info === null) {
        contactCache.set(userId, null);
        return null;
      }
      const email = info.email ? normalizeEmail(info.email) : null;
      const displayName = info.displayName ?? userId;

      if (email) contactId = findContactByIdentity(db, "email", email);
      if (contactId !== null) {
        summary.linkedExisting++;
      } else {
        contactId = upsertContact(db, {
          displayName,
          source: "slack",
          identities: email ? [{ kind: "email", value: email }] : [],
          resolved: !!email,
        });
        summary.newContacts++;
      }
      db.prepare("INSERT OR IGNORE INTO identities (contact_id, kind, value, source) VALUES (?, 'slack_user', ?, 'slack')").run(
        contactId,
        userId,
      );
    }
    contactCache.set(userId, contactId);
    return contactId;
  }

  /** Resolves + writes one interaction row; reports whether resolution was exhausted (budget) so the caller can treat the whole message as unfinished. */
  async function attemptWrite(
    userId: string,
    direction: "inbound" | "outbound",
    externalId: string,
    at: string,
  ): Promise<"written" | "unresolvable" | "exhausted"> {
    const contactId = await resolveContact(userId);
    if (contactId === REQUEST_BUDGET_EXHAUSTED) return "exhausted";
    if (contactId === null) return "unresolvable";
    summary.interactionRowsWritten += ins.run(contactId, direction, at, externalId).changes;
    return "written";
  }

  let allConversations: SlackConversation[] = [];
  try {
    allConversations = await reader.listConversations();
    // final review, Important 5: count BEFORE the maxConversationsPerRun cap, and warn (not
    // error — an empty type can be perfectly ordinary) when an expected type comes back at
    // zero. Only runs on a successful listConversations() — a failure is already recorded
    // above/below and would make every count spuriously zero, which is a different problem.
    for (const c of allConversations) summary.conversationsByType[c.type]++;
    for (const t of ["public_channel", "private_channel", "im", "mpim"] as const) {
      if (summary.conversationsByType[t] === 0) {
        summary.scopeWarnings.push(
          `0 "${t}" conversations returned by conversations.list this run. If that's genuinely ` +
            `true, ignore this. If not, the token is likely missing the "${t}"-matching *:read ` +
            `scope (D3, docs/runbooks/slack-user-token.md) — conversations.list silently returns ` +
            `only the types your scopes cover, with no error.`,
        );
      }
    }
  } catch (err) {
    if (err instanceof SlackRateLimitError) {
      stopReason = "rate_limited";
      summary.errors.push({ conversationId: "*", error: err.message });
    } else {
      summary.errors.push({ conversationId: "*", error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Least-recently-swept first, so a chronically exhausted budget still
  // eventually reaches every conversation rather than starving the tail of
  // whatever order listConversations() happens to return.
  const sweptAt = new Map<string, string>();
  for (const r of db.prepare("SELECT conversation_id, updated_at FROM slack_cursors").all() as {
    conversation_id: string;
    updated_at: string;
  }[]) {
    sweptAt.set(r.conversation_id, r.updated_at);
  }
  // First-run ordering (ORB-149 T-firstrun): plain least-recently-swept degenerates to
  // arbitrary order when EVERYTHING is unswept (a first backfill) — `?? ""` ties every
  // never-swept conversation at "". On Bendik's real workspace that arbitrary order let a
  // single noisy bot/alert channel (hundreds of messages/day, all skipped as `botId`
  // traffic — see the skip at the message loop below) burn the entire run's message
  // budget before a single DM was ever read.
  //
  // The fix is scoped to first-run only, and only among never-swept conversations: an `im`
  // writes an interaction row unconditionally in both directions (the CONTROLLER RULING
  // below), while a channel message writes a row only on a mention or a thread Bendik is
  // already in — so on a virgin backfill, channel-sweeping is mostly budget spent to write
  // nothing. Prioritising im/mpim there reaches the high-value data before the budget runs
  // out. Once a conversation has a cursor row (has been swept at least once), this priority
  // does NOT apply — the sort falls straight back to least-recently-swept, exactly as
  // before. This is deliberate: unconditionally sweeping DMs first, forever, would let a
  // busy DM set permanently starve channels, which is a worse and more silent failure than
  // the one this fix addresses.
  const neverSwept = (id: string) => !sweptAt.has(id);
  const isDm = (c: SlackConversation) => c.type === "im" || c.type === "mpim";
  const ordered = [...allConversations].sort((a, b) => {
    const aFirstRun = neverSwept(a.id);
    const bFirstRun = neverSwept(b.id);
    if (aFirstRun && bFirstRun) {
      const aDm = isDm(a);
      const bDm = isDm(b);
      if (aDm !== bDm) return aDm ? -1 : 1;
      return 0; // both never-swept, same DM-ness: order among them is unspecified
    }
    return (sweptAt.get(a.id) ?? "").localeCompare(sweptAt.get(b.id) ?? "");
  });
  const conversationsToProcess = ordered.length > maxConversations ? ordered.slice(0, maxConversations) : ordered;
  if (ordered.length > maxConversations) stopReason ??= "conversations";
  summary.conversations = conversationsToProcess.length;

  let budget = maxMessages;

  for (const convo of conversationsToProcess) {
    if (stopReason === "rate_limited") break;
    if (budget <= 0) {
      stopReason ??= "messages";
      break;
    }
    if (requestBudget <= 0) {
      stopReason ??= "requests";
      break;
    }

    try {
      // Defense-in-depth beyond the type-level requirement above: the TYPE
      // promises `im`/`mpim` carry their required fields, but a real reader
      // parsing untyped JSON off the wire can still hand back an object that
      // violates that promise at runtime. Fail loudly and skip just this
      // conversation rather than silently dropping Bendik's outbound side of
      // a DM (Important 2) or being unable to fan out an mpim at all.
      if (convo.type === "im" && !convo.counterpartyUserId) {
        throw new Error(
          `Slack import: conversation ${convo.id} is type "im" but has no counterpartyUserId — cannot resolve ` +
            `its one fixed counterparty (the reader should map Slack's own \`user\` field off the im object).`,
        );
      }
      if (convo.type === "mpim" && (!convo.members || convo.members.length === 0)) {
        throw new Error(`Slack import: conversation ${convo.id} is type "mpim" but has no members — cannot fan out interactions.`);
      }

      const row = getCursor.get(convo.id) as CursorRow | undefined;
      const oldest = row?.oldest ?? undefined;
      let pageCursor = row?.resume_cursor ?? undefined;
      let pendingHighWater = row?.pending_high_water ?? null;
      let exhausted = false;
      let pages = 0;

      while (budget > 0 && requestBudget > 0 && pages < maxPages) {
        pages++;
        const usedCursor = pageCursor; // the cursor this page was fetched with
        requestBudget--;
        const page = await reader.history(convo.id, oldest, usedCursor ?? undefined);
        // ORB-149 defect 2: charge the `conversations.replies` calls the reader already made
        // while assembling this page. They happened, so they are charged after the fact rather
        // than reserved up front — the page-loop condition above then stops the walk. The
        // overshoot is bounded by one page's thread parents, and the guard below turns the one
        // case that could never recover (a single page costing more than the WHOLE run's request
        // budget) into a loud, actionable error instead of a conversation that silently
        // re-fetches the same page forever, resolving nothing.
        const repliesRequests = page.repliesRequests ?? 0;
        if (repliesRequests > 0) {
          requestBudget -= repliesRequests;
          summary.repliesRequestsCharged += repliesRequests;
        }
        if (1 + repliesRequests > maxRequests) {
          throw new Error(
            `Slack import stalled on conversation ${convo.id}: one conversations.history page cost ` +
              `${1 + repliesRequests} Slack requests (1 history + ${repliesRequests} conversations.replies), ` +
              `more than maxRequestsPerRun (${maxRequests}) allows for the ENTIRE run — so no run can ever ` +
              `reach this page with request budget left to resolve anyone on it. Raise maxRequestsPerRun ` +
              `(--max-requests) and re-run.`,
          );
        }
        if (page.messages.length === 0) {
          exhausted = true;
          break;
        }
        // Slack returns conversations.history pages newest-first (most recent
        // message first in the array); pagination walks toward the oldest end
        // of the [oldest, now) window. So the FIRST message of the FIRST page
        // of a fresh (non-resumed) walk is the newest ts in the window.
        if (pendingHighWater === null) pendingHighWater = page.messages[0]!.ts;

        let partial = false;
        let budgetExhaustedMidPage = false;
        // ORB-149 defect 2: a page's cost is no longer just `page.messages.length` — the replies
        // of every relevant thread on it are charged to the same message budget. These two track
        // what this page actually charged, so the stall guard below can still tell "this page can
        // NEVER complete" (a permanent, silent no-progress loop) from "this run ran short".
        let chargedThisPage = 0;
        let topLevelCharged = 0;
        for (const m of page.messages) {
          if (budget <= 0) {
            partial = true;
            break;
          }
          budget--;
          chargedThisPage++;
          topLevelCharged++;
          summary.messagesExamined++; // every message the budget above was just charged for, no matter what happens next

          if (!m.user || m.botId) {
            summary.messagesSkippedNotAPerson++; // no stable person to resolve
            continue;
          }
          const isOwnAuthor = m.user === opts.ownUserId;
          const at = new Date(parseFloat(m.ts) * 1000).toISOString();

          // --- CONTROLLER RULING (2026-08-24, ORB-149 T2 review) ---
          // Pulse measures relationship warmth between Bendik and a person. A
          // broadcast to a channel is not an interaction with him, and every
          // public-channel post by anyone becoming a weighted inbound
          // interaction (heavier than an Instagram DM, at slackInbound: 1.2)
          // was graph pollution: a prolific #general poster he's never spoken
          // to would accrue real Pulse score. Symmetrically, silently dropping
          // Bendik's own mpim replies (no single counterparty) made a group-DM
          // colleague fail isReciprocal (pulse.ts) and get filed next to
          // newsletter senders. This graph is hard to unwind once polluted, so
          // the rule below goes conservative-first:
          //   - im (DM): both directions, always — a DM has exactly one fixed
          //     counterparty for the whole conversation.
          //   - mpim (group DM): a message fans out to one row per OTHER
          //     member (bounded — group DMs are ≤8 members), restoring
          //     reciprocity instead of dropping Bendik's side of it.
          //   - public/private channel: a row is written ONLY when the
          //     message mentions Bendik, or sits in a thread he has already
          //     participated in. Everything else is not an interaction — and
          //     (kept from the pre-ruling design) a channel message AUTHORED
          //     by Bendik still creates no row even when relevant: a
          //     mention/thread can involve more than one other person, so
          //     there is still no single counterparty to credit his own reply
          //     to without guessing.
          let messageExhausted = false;
          // ORB-149 defect 2: set when the MESSAGE budget ran out partway through a relevant
          // thread's replies. Distinct from `messageExhausted`, which means the REQUEST budget.
          let threadUnfinished = false;
          if (convo.type === "im") {
            const outcome = await attemptWrite(convo.counterpartyUserId, isOwnAuthor ? "outbound" : "inbound", `${convo.id}:${m.ts}`, at);
            if (outcome === "exhausted") messageExhausted = true;
          } else if (convo.type === "mpim") {
            if (isOwnAuthor) {
              const others = convo.members.filter((id) => id !== opts.ownUserId).slice(0, MAX_MPIM_FANOUT);
              for (const other of others) {
                const outcome = await attemptWrite(other, "outbound", `${convo.id}:${m.ts}:${other}`, at);
                if (outcome === "exhausted") {
                  messageExhausted = true;
                  break;
                }
              }
            } else {
              const outcome = await attemptWrite(m.user, "inbound", `${convo.id}:${m.ts}`, at);
              if (outcome === "exhausted") messageExhausted = true;
            }
          } else {
            // ================= THE CHANNEL RULE, INCLUDING THREAD REPLIES ==================
            // (public_channel / private_channel. ORB-149 defect 2, closed 2026-09-03.)
            //
            // A channel message is RELEVANT when it mentions Bendik or sits in a thread he has
            // already replied in (`threadHasOwnReply`) — unchanged, and still the CONTROLLER
            // RULING above. What changed is what happens to the thread hanging off it:
            //
            //   RELEVANT thread parent  → every reply in that thread becomes its own inbound
            //     interaction, exactly like a top-level channel message: same signals-only row
            //     (content NULL, the privacy boundary in `replica.ts`), same participant
            //     resolution, same `<conversation>:<ts>` dedupe key, same first gate (no `user`,
            //     or a `botId` → skipped as not-a-person), same message budget, and — the point
            //     of the fix — the `conversations.replies` request that fetched them is now
            //     charged to `maxRequestsPerRun`. Bendik's OWN replies still write nothing: a
            //     thread can involve more than one other person, so there is no single
            //     counterparty to credit his side to. That is the same reason his own top-level
            //     channel messages write nothing, applied one level down.
            //   IRRELEVANT thread parent → its replies are never examined. Nothing changes.
            //
            // ALL replies in a relevant thread count — not only the ones after Bendik's own.
            // "Sits in a thread he has participated in" is a property of the THREAD, not of
            // message ordering: the rule already credits the PARENT, which is by definition
            // older than any reply of his, so crediting only later replies would contradict the
            // half of the rule that already shipped. It is also the only stable choice — an
            // "after his reply" rule would make a reply's relevance depend on when he happened
            // to answer, and this importer never re-reads a thread once its parent has scrolled
            // below the high-water mark, so a thread he joined late could never be repaired.
            //
            // TWO GAPS LEFT OPEN DELIBERATELY (stated, not glossed over):
            //   - A thread whose parent Bendik AUTHORED is not relevant unless he also replied
            //     in it: the reader computes `threadHasOwnReply` from the thread's REPLIES only.
            //     People answering his own channel post in a thread are therefore still not
            //     imported. It is a one-line widening (`|| isOwnAuthor` here), not taken
            //     unilaterally, because the CONTROLLER RULING above exists precisely because
            //     this graph is hard to unwind once polluted.
            //   - A reply that @-mentions him inside a thread he never joined, under a parent
            //     that does not mention him, stays invisible: relevance is decided on the
            //     parent, and an irrelevant parent's replies are never examined.
            // ==============================================================================
            const threadRelevant = m.mentions.includes(opts.ownUserId) || m.threadHasOwnReply;
            if (!isOwnAuthor && threadRelevant) {
              const outcome = await attemptWrite(m.user, "inbound", `${convo.id}:${m.ts}`, at);
              if (outcome === "exhausted") messageExhausted = true;
            }
            if (!messageExhausted && threadRelevant) {
              for (const reply of m.threadReplies) {
                if (budget <= 0) {
                  threadUnfinished = true;
                  break;
                }
                budget--;
                chargedThisPage++;
                summary.messagesExamined++;
                summary.threadRepliesExamined++;
                if (!reply.user || reply.botId) {
                  summary.messagesSkippedNotAPerson++; // no stable person to resolve
                  continue;
                }
                if (reply.user === opts.ownUserId) {
                  summary.messagesProcessed++; // handled, and ruled not-an-interaction (no single counterparty)
                  continue;
                }
                // A `thread_broadcast` reply also comes back as a top-level message on the
                // history page, so it can be examined twice in one run — the external_id is the
                // same both times, and `INSERT OR IGNORE` on interactions(channel, external_id)
                // makes the second one a no-op. Same mechanism that makes the whole page safe to
                // re-walk after a partial run.
                const replyAt = new Date(parseFloat(reply.ts) * 1000).toISOString();
                const outcome = await attemptWrite(reply.user, "inbound", `${convo.id}:${reply.ts}`, replyAt);
                if (outcome === "exhausted") {
                  messageExhausted = true;
                  break;
                }
                summary.messagesProcessed++;
              }
            }
          }

          if (messageExhausted) {
            // Out of REQUEST budget partway through resolving THIS message
            // (review round 3, BLOCKING): this message is NOT finished — do
            // not count it as processed, and treat the whole page exactly
            // like a message-budget partial (below): stop here, pin the
            // cursor to where this page started, and do NOT let `exhausted`
            // get set for this page. The old bug was letting this message
            // silently count as "handled" (via a plain `null`), so the page
            // could reach `exhausted = true` and promote the high-water mark
            // PAST a message that was never actually written — permanent,
            // silent loss. Now it can't: this counts as an incomplete page.
            partial = true;
            budgetExhaustedMidPage = true;
            break;
          }
          if (threadUnfinished) {
            // ORB-149 defect 2: the MESSAGE budget ran out partway through this thread's
            // replies. Treated exactly like a page-level message-budget shortfall: the parent
            // itself WAS fully handled (so it counts as processed), the page stops here, the
            // cursor is pinned to where this page started, and the next run re-walks the page —
            // every reply already written re-inserts as a no-op via INSERT OR IGNORE. It is
            // deliberately NOT `budgetExhaustedMidPage`: that flag means the REQUEST budget ran
            // out, which is what switches the stall guard below off, and a message-budget
            // shortfall must keep the guard armed.
            summary.messagesProcessed++;
            partial = true;
            break;
          }
          summary.messagesProcessed++;
        }

        if (partial) {
          // A page bigger than the run's ENTIRE configured message budget can
          // never complete no matter how many runs are attempted (each run
          // starts with at most `maxMessages` total) — a genuine
          // misconfiguration, not a transient shortfall, so fail loudly
          // rather than silently re-fetching the same page forever (Important
          // 1). This check is specifically about the MESSAGE-count budget; a
          // request-budget exhaustion (above) is a different resource with a
          // different fix (raise maxRequestsPerRun / let other conversations
          // run first) and is never a permanent-stall signal on its own, so
          // it skips this check entirely.
          // ORB-149 defect 2 generalises the count: a page costs one budget unit per top-level
          // message PLUS one per reply in every relevant thread on it, so `page.messages.length`
          // is no longer the page's cost. `chargedThisPage` is what this page actually charged,
          // and every top-level message it never reached costs at least one more — their sum is a
          // LOWER BOUND on the page's true cost. Throwing only when even that lower bound exceeds
          // the whole run's budget keeps this what it has always been: a "this can never
          // complete, no matter how many runs" signal, never a "this run ran short" false alarm.
          const pageCostLowerBound = chargedThisPage + (page.messages.length - topLevelCharged);
          if (!budgetExhaustedMidPage && pageCostLowerBound > maxMessages) {
            throw new Error(
              `Slack import stalled on conversation ${convo.id}: maxMessagesPerRun (${maxMessages}) is smaller ` +
                `than a single conversations.history page (${page.messages.length} messages, plus the replies of ` +
                `every relevant thread on it — at least ${pageCostLowerBound} budget units), so the same page ` +
                `would be re-fetched forever with zero net progress. Raise maxMessagesPerRun (or reduce the ` +
                `reader's page size) and re-run.`,
            );
          }
          // Do NOT advance past this page; pin the resume cursor to the
          // cursor THIS page was fetched with, so the next run re-fetches
          // (and, via INSERT OR IGNORE, safely re-skips) the already-written
          // prefix and picks up the rest — whether the shortfall was message
          // budget or request budget.
          pageCursor = usedCursor;
          break;
        }

        if (!page.nextCursor) {
          exhausted = true;
          break;
        }
        pageCursor = page.nextCursor;
      }

      if (exhausted) {
        // Fully caught up to the top of the [oldest, now) window: promote the
        // high-water mark so the next run's `oldest` skips everything we just saw.
        setCursor.run(convo.id, pendingHighWater ?? oldest ?? null, null, null, now().toISOString());
      } else {
        // Ran out of some budget mid-backlog: persist exactly where we stopped
        // so the next run resumes this same page walk instead of restarting it.
        setCursor.run(convo.id, oldest ?? null, pageCursor ?? null, pendingHighWater, now().toISOString());
        if (budget <= 0) stopReason ??= "messages";
        else if (requestBudget <= 0) stopReason ??= "requests";
        else if (pages >= maxPages) stopReason ??= "pages";
      }
    } catch (err) {
      // Touch updated_at even on failure (review round 3, Moderate fix): a
      // conversation that fails EVERY run (most notably the stall guard
      // above under a too-small maxMessagesPerRun) would otherwise never get
      // a cursor row written at all, so it stays permanently at the front of
      // the least-recently-swept ordering and starves every other
      // conversation forever, on every future run, not just this one. This
      // converts that into "this run's budget went to a conversation that
      // needs a human to fix its config" — every OTHER conversation gets
      // priority on the next run instead of the same one winning forever.
      const existing = getCursor.get(convo.id) as CursorRow | undefined;

      if (err instanceof SlackInvalidCursorError) {
        // ===================== ORB-149 defect 3, closed 2026-09-03 =====================
        // Slack has forgotten the `resume_cursor` this importer persisted on an earlier run
        // (resume cursors age out). The old code fell through to the re-persist below and wrote
        // that same dead cursor back verbatim, so the identical error recurred on every future
        // run of this conversation, forever, until a human edited the row by hand. It was loud
        // (recorded in `errors`; the CLI exits 1 on a non-empty `errors`) but it never healed.
        //
        // THE HEAL: drop `resume_cursor` AND `pending_high_water`; keep `oldest`. `oldest` is the
        // last COMMITTED high-water mark — db.ts's own doc comment on `slack_cursors` says
        // everything at or before it has been fully imported — so it is the re-fetch floor. The
        // next run starts a fresh page walk of [oldest, now) from its newest end, re-reading
        // whatever the abandoned walk had already covered. That re-read cannot duplicate
        // anything: every row's external_id is `<conversation>:<ts>` (plus `:<member>` for an
        // mpim fan-out) and `interactions` is UNIQUE(channel, external_id), so INSERT OR IGNORE
        // turns each re-seen message into a no-op.
        //
        // `pending_high_water` has to go too. It is the newest ts of the ABANDONED walk; a fresh
        // walk re-derives it from its own first page. Keeping it (what the runbook's old by-hand
        // recovery said to do) would promote `oldest` to a stale, older ts when this walk
        // completes, leaving every future run to re-scan the same range — safe, but permanently
        // wasteful. The event still lands in `errors`, so the run stays loud; it is just no
        // longer permanent.
        // ==============================================================================
        setCursor.run(convo.id, existing?.oldest ?? null, null, null, now().toISOString());
        summary.errors.push({
          conversationId: convo.id,
          error:
            `${err.message} — cleared this conversation's resume_cursor and pending_high_water; the next run ` +
            `restarts its page walk from the last committed high-water mark (oldest=${existing?.oldest ?? "none"}). ` +
            `Already-imported messages re-insert as no-ops (INSERT OR IGNORE on interactions(channel, external_id)).`,
        });
        continue;
      }

      setCursor.run(
        convo.id,
        existing?.oldest ?? null,
        existing?.resume_cursor ?? null,
        existing?.pending_high_water ?? null,
        now().toISOString(),
      );

      if (err instanceof SlackRateLimitError) {
        summary.errors.push({ conversationId: convo.id, error: err.message });
        stopReason = "rate_limited"; // workspace-wide; always wins over an earlier, less urgent reason
        break;
      }
      // Any other per-conversation failure (including the stall guard above):
      // record it and move on — one bad conversation doesn't abort the run.
      summary.errors.push({ conversationId: convo.id, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
  }

  if (stopReason) summary.stoppedEarly = { reason: stopReason };

  // ORB-149 gap-closing: recompute unconditionally, even on a zero-rows run (see the doc
  // comment on `pulse` above) — same `now()` clock this whole function already uses, not a
  // fresh `new Date()` at this call site. The rows above are committed already; a throw here
  // must not lose them, so it's caught and recorded like any other per-step failure instead of
  // propagating out of `importSlack` (the CLI already turns a non-empty `errors` into a
  // non-zero exit code).
  try {
    summary.pulse = recomputePulse(db, now());
  } catch (err) {
    summary.errors.push({ conversationId: "pulse", error: err instanceof Error ? err.message : String(err) });
  }

  db.prepare("INSERT INTO import_runs (source, ran_at, summary) VALUES (?, ?, ?)").run("slack", now().toISOString(), JSON.stringify(summary));
  return summary;
}
