/**
 * The real `SlackReader` (ORB-149 Task 4) — a thin `fetch` wrapper over Slack's Web API,
 * implementing the interface `./slack.ts` documents. See that file's docblock before editing
 * this one; its interface has passed review and is not touched here.
 *
 * Scopes required (D1/D3, docs/superpowers/specs/2026-08-24-orb-149-saga-reads-slack-design.md):
 * `channels:read`, `groups:read`, `im:read`, `mpim:read` (enumeration — `conversations.list`),
 * `channels:history`, `groups:history`, `im:history`, `mpim:history` (`conversations.history`/
 * `.replies`), `users:read`, `users:read.email` (the join key onto the graph's contacts —
 * load-bearing, see `getUserInfo` below). This module never checks which scopes the token
 * actually has; a missing scope surfaces as `SlackApiError("missing_scope")`, thrown loudly
 * rather than swallowed (review round 2, Critical 2 — see `getUserInfo` below).
 *
 * Runs on the Mac only (D1) — not sealed, no proxy plumbing needed; a plain `fetch` reaches
 * slack.com directly.
 *
 * SIGNALS ONLY: this file never reads or returns Slack message TEXT into any field this module
 * hands back except transiently, inside this file, to compute `mentions` (regex over `<@ID>`)
 * and `threadHasOwnReply` (participant check) — the parsed TEXT itself is discarded before
 * returning; `SlackMessage` carries no text field (see ./slack.ts) and none is added here.
 */
import {
  SlackInvalidCursorError,
  SlackRateLimitError,
  type SlackConversation,
  type SlackHistoryPage,
  type SlackMessage,
  type SlackReader,
  type SlackThreadReply,
  type SlackUserInfo,
} from "./slack.js";

const SLACK_API_BASE = "https://slack.com/api";
const HISTORY_PAGE_LIMIT = 100;
/** Slack enforces ≤8 members on an mpim; matches ./slack.ts's own MAX_MPIM_FANOUT context. */
const MAX_MPIM_MEMBERS_PAGES = 2;
/**
 * Defensive bound on how many CONSECUTIVE `conversations.history` pages `history()` will walk
 * internally when every page filters down to zero real messages (review round 3, BLOCKING —
 * see `history()`'s own comment). Not expected to be hit in practice; exists so a pathological
 * conversation (thousands of system/bot messages with no real message between them) fails
 * loudly instead of looping unboundedly.
 */
const MAX_CONSECUTIVE_EMPTY_HISTORY_PAGES = 50;

/**
 * Slack `subtype`s that are still a real message a real person typed or sent — an ALLOWLIST,
 * not a denylist, mirroring the eve-saga twin's `REAL_MESSAGE_SUBTYPES`
 * (`services/chief-of-staff/lib/brief-content-slack.ts`) so the two halves of this ticket agree on
 * what a "real message" is. Fails CLOSED: an unrecognized subtype (`channel_join`,
 * `channel_topic`, `bot_add`, `reminder_add`, …) is dropped before it ever reaches the
 * importer — review round 2, Important 4. Without this, a `group_join` event (a real `user`,
 * no `bot_id`) would silently create an inbound interaction row and a new contact for every im
 * DM's system event, polluting a graph this codebase's own comments describe as hard to unwind
 * once polluted.
 */
const REAL_MESSAGE_SUBTYPES = new Set(["thread_broadcast", "file_share", "me_message"]);

/**
 * Slack system/notification user ids — real `user` fields with no `bot_id`, so neither the
 * importer's `if (!m.user || m.botId) continue` (slack.ts) nor an im's normal counterparty
 * check catches them on their own, and (for `USLACK`, discovered below) Slack's own
 * `users.info` doesn't even set `is_bot` on them. Used in two places below (final review,
 * Important 1): to skip a DM with one of these ids entirely in `listConversations`, and to
 * synthesize a `botId` for a message authored by one of them anywhere else (mpim/channel) so
 * the importer's existing bot-skip catches it without the importer needing to know these ids
 * itself.
 *
 * THIS IS A SET, NOT A SINGLE ID, BECAUSE THIS FAILURE CLASS HAS ALREADY RECURRED THREE TIMES —
 * a future reader should read this as a pattern, not paranoia:
 *   1. `USLACKBOT` (Slack's built-in reminders/notifications bot) — final review, Important 1.
 *      Caught by hardcoding the one id known at the time.
 *   2. Any *app*-DM counterparty (Google Drive, GitHub, …) — ORB-149 closing fix 1. A hardcoded
 *      id can't cover this; caught instead by widening `getUserInfo`'s guard to Slack's own
 *      `is_bot` flag, a general defence rather than another id.
 *   3. `USLACK` (Slack's own system/notification user, distinct from `USLACKBOT`) — found live
 *      in production (ORB-149 gap-closing): `users.info` reports it with `is_bot` FALSY, so
 *      neither guard above fired, and it resolved to a junk display-name contact ("Slack", no
 *      email). Slack does not consistently flag every one of its own non-human accounts, so
 *      flags alone are not sufficient either.
 * Conclusion: flags (`is_bot`, `is_app_user`) are the general defence — they catch anything
 * Slack itself marks as non-human, present or future, without this file needing to know its id.
 * This id set is the backstop for the ids Slack does NOT flag, added one confirmed id at a
 * time as they're found live — never a speculative enumeration of "every possible" system id
 * (there is no such list). Add to this set only when a real backfill produces another one.
 */
const SLACK_SYSTEM_USER_IDS = new Set(["USLACKBOT", "USLACK"]);

type ConversationsListResponse = {
  ok: boolean;
  error?: string;
  channels?: Array<{
    id: string;
    is_channel?: boolean;
    is_group?: boolean;
    is_im?: boolean;
    is_mpim?: boolean;
    is_private?: boolean;
    is_archived?: boolean;
    user?: string; // im only: the counterparty
  }>;
  response_metadata?: { next_cursor?: string };
};

type ConversationsMembersResponse = {
  ok: boolean;
  error?: string;
  members?: string[];
  response_metadata?: { next_cursor?: string };
};

type SlackApiMessage = {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  subtype?: string;
};

type ConversationsHistoryResponse = {
  ok: boolean;
  error?: string;
  messages?: SlackApiMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
};

type ConversationsRepliesResponse = {
  ok: boolean;
  error?: string;
  messages?: SlackApiMessage[]; // [0] is the parent
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
};

type UsersInfoResponse = {
  ok: boolean;
  error?: string;
  user?: {
    id: string;
    deleted?: boolean;
    is_bot?: boolean;
    is_app_user?: boolean;
    real_name?: string;
    profile?: { email?: string; display_name?: string; real_name?: string };
  };
};

/**
 * Thrown by `callSlack` when Slack answers `ok:false` with anything other than a 429 (which
 * throws `SlackRateLimitError` instead, before this is ever constructed). Carries Slack's own
 * `error` code so a caller can distinguish a genuine "no such user" (`user_not_found`/
 * `users_not_found`) from a real failure (`missing_scope`, `invalid_auth`, a malformed
 * response) — review round 2, Critical 2: the old code caught EVERY `ok:false` into `null`,
 * which meant an under-scoped token (missing `users:read.email`, the exact scope D3 calls out
 * as easily missed) would silently resolve nobody, write zero rows, and still advance every
 * cursor past the messages it never resolved — a clean-looking `exitCode 0` run that is, in
 * fact, a total silent failure on a graph with no upstream source of truth.
 */
export class SlackApiError extends Error {
  constructor(
    readonly code: string,
    method: string,
  ) {
    super(`Slack ${method} failed: ${code}`);
    this.name = "SlackApiError";
  }
}

/** Slack user ids mentioned via `<@U…>` or `<@U…|display>` in message text. `[]` for none/no text. */
export function parseMentions(text: string | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  const re = /<@([UW][A-Z0-9_]+)(?:\|[^>]*)?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]!);
  return out;
}

export type SlackFetch = typeof fetch;
export type SlackSleep = (ms: number) => Promise<void>;

const defaultSleep: SlackSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bounded retry-after handling for Slack 429s (final review, Important 3): the old code threw
 * `SlackRateLimitError` on the FIRST 429 no matter what, aborting the whole run even though
 * Slack itself told us exactly how long to wait. A busy threaded channel firing ~1 `history` +
 * ~30 sequential `.replies` calls in seconds against a Tier-3 (~50 req/min) ceiling would 429
 * within the first minute — safe (cursors survive verbatim) but the first import largely does
 * not progress and looks broken every day it repeats. Retries are BOUNDED on both axes so this
 * can never become the unbounded sleep the review explicitly forbids: at most
 * `MAX_RATE_LIMIT_RETRIES` retries, each capped at `MAX_RATE_LIMIT_WAIT_SECONDS` regardless of
 * what Slack's own `Retry-After` asks for. Once retries are exhausted this still throws
 * `SlackRateLimitError` exactly as before — the importer's existing "rate_limited" stop-and-
 * persist-cursor handling (`slack.ts`) is untouched by this change.
 */
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RATE_LIMIT_WAIT_SECONDS = 60;

export type SlackNow = () => Date;

export interface SlackReaderOptions {
  /** The Slack USER token (xoxp-…) — see docs/runbooks/slack-user-token.md. Never hardcoded or
   *  defaulted here: the caller resolves it (config override → Keychain → loud error) and
   *  passes the resulting string in. This module has no fallback that runs without one. */
  token: string;
  /** Bendik's own Slack user id — needed here (not just by the importer) to compute
   *  `threadHasOwnReply`, which requires knowing whose replies count. */
  ownUserId: string;
  fetchImpl?: SlackFetch;
  /** Injected sleep for the bounded 429 retry above — tests supply a fast/no-op stub so retry
   *  behaviour can be asserted without real wall-clock delay. Defaults to a real timer. */
  sleepImpl?: SlackSleep;
  /** Injected clock for the `deadlineAt` check below — mirrors `./slack.ts`'s own injected
   *  `now`, so nothing in the retry-wait logic calls a bare `new Date()`/`Date.now()`. Tests
   *  supply a fixed clock; the CLI leaves this at the real one. */
  now?: SlackNow;
  /**
   * Wall-clock deadline for THIS WHOLE RUN, checked before every 429 sleep — not a per-request
   * timeout. Each `callSlack` retry is already bounded (`MAX_RATE_LIMIT_RETRIES` ×
   * `MAX_RATE_LIMIT_WAIT_SECONDS`), but nothing previously bounded the RUN: under sustained
   * Tier-3 pressure (every request 429ing once before succeeding), 200 budgeted requests plus
   * the unmetered `.replies`/`.members`/empty-page calls this file's own doc comments describe
   * add up to 100+ minutes of silent sleeping. The runbook's own next instruction is to add
   * `slack-import` to the 09:30 launchd chain ahead of `backup`, `digest`, `brain-notes`, and
   * `push-network-replica.sh` — an hour-long stall there delays all four behind it, which makes
   * a nightly job that can stall its own outage. When a sleep would cross this deadline,
   * `callSlack` throws `SlackRateLimitError` immediately instead of sleeping — `slack.ts`
   * already treats that as `stopReason: "rate_limited"` and persists every cursor safely, so
   * this reuses that existing stop path rather than inventing a new one. `undefined` = no
   * deadline (the default in tests that don't care about this).
   */
  deadlineAt?: Date;
}

async function callSlack<T extends { ok: boolean; error?: string }>(
  fetchImpl: SlackFetch,
  sleepImpl: SlackSleep,
  nowImpl: SlackNow,
  deadlineAt: Date | undefined,
  token: string,
  method: string,
  params: Record<string, string | number | undefined>,
  attempt = 0,
): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  const res = await fetchImpl(`${SLACK_API_BASE}/${method}?${qs.toString()}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 429) {
    // Drain the body before retrying/throwing — under undici an unconsumed response body holds
    // its connection open until GC, and this path is hit on every single 429 (items 2/5 of the
    // ORB-149 closing fixes).
    await res.text().catch(() => {});
    const retryAfterHeader = res.headers.get("Retry-After");
    const retryAfterSecondsRaw = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 30;
    const retryAfterSeconds = Number.isFinite(retryAfterSecondsRaw) ? retryAfterSecondsRaw : 30;
    if (attempt < MAX_RATE_LIMIT_RETRIES) {
      // Clamped at zero too: a `Retry-After: 0` or a negative value must never produce a
      // negative sleep (which resolves immediately, defeating the backoff this exists for).
      const waitSeconds = Math.max(0, Math.min(retryAfterSeconds, MAX_RATE_LIMIT_WAIT_SECONDS));
      if (deadlineAt && nowImpl().getTime() + waitSeconds * 1000 > deadlineAt.getTime()) {
        throw new SlackRateLimitError(
          retryAfterSeconds,
          `Slack import: run deadline (${deadlineAt.toISOString()}) would be crossed by the next ` +
            `rate-limit sleep (${waitSeconds}s) — stopping now so the rest of the launchd chain ` +
            `(backup/digest/brain-notes/replica push) isn't delayed behind it; retry after ${retryAfterSeconds}s.`,
        );
      }
      console.warn(
        `Slack import: rate-limited on ${method}, sleeping ${waitSeconds}s before retry ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}…`,
      );
      await sleepImpl(waitSeconds * 1000);
      return callSlack(fetchImpl, sleepImpl, nowImpl, deadlineAt, token, method, params, attempt + 1);
    }
    throw new SlackRateLimitError(retryAfterSeconds);
  }
  const data = (await res.json()) as T;
  if (!data.ok) {
    // ORB-149 defect 3: `invalid_cursor` is the one Slack error the importer reacts to
    // STRUCTURALLY rather than just recording — a resume cursor it persisted has aged out, and
    // the conversation has to restart from its committed high-water mark instead of re-pinning
    // the dead cursor forever. Typed here (like SlackRateLimitError) rather than string-matched
    // in the importer; every other Slack error keeps its existing SlackApiError shape.
    if (data.error === "invalid_cursor") {
      throw new SlackInvalidCursorError(
        `Slack ${method} rejected the pagination cursor as invalid_cursor (resume cursors age out).`,
      );
    }
    throw new SlackApiError(data.error ?? "unknown", method);
  }
  return data;
}

type ConversationKind = "im" | "mpim" | "public_channel" | "private_channel";

/**
 * Real `SlackReader` implementation. `listConversations` enumerates every channel/group/im/mpim
 * the token can see (paginating `conversations.list`), fetching each mpim's member list via
 * `conversations.members` (required — `SlackConversation`'s `mpim` variant needs `members` to
 * fan out; Slack's own `conversations.list` does not include it) — and remembers every
 * conversation's KIND in an internal map, because `history`'s own signature (matching
 * `./slack.ts`'s interface) takes only a conversation id, not its kind.
 *
 * `history` paginates `conversations.history` and, for a `public_channel`/`private_channel`
 * thread-parent message, calls `conversations.replies` once — SEQUENTIALLY, one message at a
 * time, never concurrently (review round 2, Important 1: the old `Promise.all` could fire up to
 * a whole page's worth of `.replies` calls at once, bursting well past Slack's ~50 req/min Tier
 * 3 ceiling and 429ing out the entire run) — to compute `threadHasOwnReply`. `im`/`mpim`
 * messages skip that walk entirely: the importer's own CONTROLLER RULING
 * (`./slack.ts:382-433`) never reads `mentions`/`threadHasOwnReply` for those kinds (they write
 * unconditionally), so the extra `.replies` cost would buy nothing. A conversation id `history`
 * is asked about that this reader never saw via `listConversations` (kind unknown) defaults to
 * "channel" treatment — the conservative direction, since it only ever adds information rather
 * than silently dropping any (this default is only actually safe because `importSlack` always
 * calls `listConversations()` before any `history()`; nothing enforces that ordering — noted,
 * not fixed, review round 3).
 *
 * ORB-149 defect 2 (2026-09-03) changed what happens to those replies afterwards. They used to
 * be read off the wire and dropped once `threadHasOwnReply` had been computed from them; they
 * are now returned on the parent as `SlackMessage.threadReplies`, and the number of `.replies`
 * requests the page cost is returned as `SlackHistoryPage.repliesRequests` so the importer's
 * `maxRequestsPerRun` can charge for them. That closes the metering gap `./slack.ts` used to
 * document for `.replies`; `conversations.members` and the internal empty-page walk below are
 * still unmetered.
 *
 * `history` NEVER returns `{ messages: [], nextCursor: <non-null> }` (review round 3,
 * BLOCKING). The importer's own page loop (`./slack.ts:359-362`) treats an empty `messages`
 * array as "this conversation is exhausted" and promotes the high-water mark BEFORE it ever
 * looks at `nextCursor` — so if a whole 100-message page happens to filter down to zero real
 * messages (a `channel_join`/`group_join` burst, a bot/alert-heavy stretch), the OLD behaviour
 * here would silently promote past every human message still sitting behind that page,
 * permanently and silently, on a clean `exitCode 0` run. So when a page filters to nothing and
 * Slack says there is more (`has_more`), this function keeps fetching internally — its own
 * cursor, not the caller's — until either a real message survives or Slack's own pagination
 * genuinely ends (`has_more: false`, at which point `{ messages: [], nextCursor: null }` is the
 * correct and honest answer). Each internal page is a real Slack request the importer's
 * `maxRequestsPerRun` does not see (the same accounting gap as `.replies`, above) —
 * `MAX_CONSECUTIVE_EMPTY_HISTORY_PAGES` bounds it defensively rather than leaving it unbounded.
 */
export function createSlackReader(opts: SlackReaderOptions): SlackReader {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleepImpl = opts.sleepImpl ?? defaultSleep;
  const nowImpl = opts.now ?? (() => new Date());
  const { token, ownUserId, deadlineAt } = opts;
  const kindById = new Map<string, ConversationKind>();

  async function listMpimMembers(conversationId: string): Promise<string[]> {
    const members: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const data = await callSlack<ConversationsMembersResponse>(fetchImpl, sleepImpl, nowImpl, deadlineAt, token, "conversations.members", {
        channel: conversationId,
        limit: 200,
        cursor,
      });
      members.push(...(data.members ?? []));
      cursor = data.response_metadata?.next_cursor || undefined;
      pages++;
    } while (cursor && pages < MAX_MPIM_MEMBERS_PAGES);
    return members;
  }

  return {
    async listConversations(): Promise<SlackConversation[]> {
      const out: SlackConversation[] = [];
      let cursor: string | undefined;
      do {
        const data = await callSlack<ConversationsListResponse>(fetchImpl, sleepImpl, nowImpl, deadlineAt, token, "conversations.list", {
          types: "public_channel,private_channel,mpim,im",
          exclude_archived: "true",
          limit: 200,
          cursor,
        });
        for (const c of data.channels ?? []) {
          if (c.is_archived) continue;
          if (c.is_im) {
            if (!c.user) continue; // no stable counterparty — cannot form a valid `im`
            // final review, Important 1: every workspace has a self-DM (is_im with
            // user === ownUserId — every note Bendik ever left himself) and a DM from one of
            // Slack's own system users (SLACK_SYSTEM_USER_IDS, see its doc comment above).
            // Neither is a relationship with another person; the importer writes `im`
            // interactions unconditionally, so both must be excluded here before they ever
            // reach it, not filtered downstream.
            if (c.user === ownUserId || SLACK_SYSTEM_USER_IDS.has(c.user)) continue;
            kindById.set(c.id, "im");
            out.push({ id: c.id, type: "im", counterpartyUserId: c.user });
          } else if (c.is_mpim) {
            kindById.set(c.id, "mpim");
            // review round 2, Important 3: do NOT drop an mpim with an empty/failed member
            // fetch here — that silently bypasses the importer's own loud guard
            // (./slack.ts:343-345, "type mpim but has no members"), which exists specifically
            // to record and skip this case visibly rather than make the whole conversation
            // vanish with no error. Always return it; the importer decides what to do.
            const members = await listMpimMembers(c.id);
            out.push({ id: c.id, type: "mpim", members });
          } else if (c.is_private || c.is_group) {
            kindById.set(c.id, "private_channel");
            out.push({ id: c.id, type: "private_channel" });
          } else if (c.is_channel) {
            kindById.set(c.id, "public_channel");
            out.push({ id: c.id, type: "public_channel" });
          }
        }
        cursor = data.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return out;
    },

    async history(conversationId: string, oldest: string | undefined, cursor: string | undefined): Promise<SlackHistoryPage> {
      const kind = kindById.get(conversationId) ?? "public_channel"; // unknown → conservative: expand threads
      const isDm = kind === "im" || kind === "mpim";

      let pageCursor = cursor;
      let emptyPages = 0;

      // review round 3, BLOCKING: loop internally past any page that filters down to zero real
      // messages while Slack still has more (`has_more`) — see this function's own doc comment
      // above for why returning `{ messages: [], nextCursor: <non-null> }` is unsafe.
      for (;;) {
        const data = await callSlack<ConversationsHistoryResponse>(fetchImpl, sleepImpl, nowImpl, deadlineAt, token, "conversations.history", {
          channel: conversationId,
          oldest,
          cursor: pageCursor,
          limit: HISTORY_PAGE_LIMIT,
        });
        // review round 2, Important 4: drop non-real subtypes (channel_join, bot_add, …) before
        // they ever become a SlackMessage — see REAL_MESSAGE_SUBTYPES above.
        const raw = (data.messages ?? []).filter((m) => m.subtype === undefined || REAL_MESSAGE_SUBTYPES.has(m.subtype));
        const nextCursor = data.has_more ? (data.response_metadata?.next_cursor || null) : null;

        if (raw.length === 0) {
          if (!nextCursor) {
            // Genuinely exhausted — Slack has nothing more, so an empty page here is honest,
            // not the bug this fix closes.
            return { messages: [], nextCursor: null };
          }
          emptyPages++;
          if (emptyPages >= MAX_CONSECUTIVE_EMPTY_HISTORY_PAGES) {
            throw new Error(
              `Slack import: conversation ${conversationId} returned ${emptyPages} consecutive ` +
                `conversations.history pages with no real messages (all filtered as system/bot ` +
                `subtypes) without reaching the end of its history. Aborting this conversation's ` +
                `read rather than loop unboundedly; it is recorded as a per-conversation error ` +
                `and retried on the next run, same cursor.`,
            );
          }
          pageCursor = nextCursor;
          continue; // fetch the next page with THIS reader's own internal cursor
        }

        // review round 2, Important 1: SEQUENTIAL, not Promise.all — see this function's own
        // doc comment above.
        const messages: SlackMessage[] = [];
        // ORB-149 defect 2: every `conversations.replies` request this page cost, reported back
        // to the importer so `maxRequestsPerRun` can charge for it (it used to be invisible).
        let repliesRequests = 0;
        for (const m of raw) {
          const mentions = parseMentions(m.text);
          let threadHasOwnReply = false;
          let threadReplies: SlackThreadReply[] = [];
          // A thread PARENT in conversations.history carries thread_ts === ts and (usually)
          // reply_count > 0. Only fetch .replies when there is actually a thread to check, and
          // never for im/mpim (the importer never reads this field for those kinds).
          if (!isDm && m.thread_ts && m.thread_ts === m.ts && (m.reply_count ?? 0) > 0) {
            const repliesData = await callSlack<ConversationsRepliesResponse>(fetchImpl, sleepImpl, nowImpl, deadlineAt, token, "conversations.replies", {
              channel: conversationId,
              ts: m.thread_ts,
              limit: 200,
            });
            repliesRequests++;
            const replies = (repliesData.messages ?? []).slice(1); // [0] is the parent itself
            threadHasOwnReply = replies.some((r) => r.user === ownUserId);
            // ORB-149 defect 2: hand the replies to the importer instead of throwing them away
            // once `threadHasOwnReply` has been read off them. Same two filters a top-level
            // message gets, for the same reasons: REAL_MESSAGE_SUBTYPES (a `channel_join` inside
            // a thread is not a message a person sent) and the synthetic botId for Slack's own
            // system users, so the importer's existing `!user || botId` gate catches them
            // without knowing those ids. Message TEXT is not read here at all — a reply's
            // mentions are never consulted by the channel rule (see `SlackThreadReply`), so this
            // path stays strictly signals-only.
            //
            // BOUND, stated rather than fixed: this is the FIRST `conversations.replies` page
            // only (limit 200, no pagination — unchanged from when it existed solely to compute
            // `threadHasOwnReply`). A thread with more replies than that is truncated here, and
            // was already truncated for the `threadHasOwnReply` check before this change.
            threadReplies = replies
              .filter((r) => r.subtype === undefined || REAL_MESSAGE_SUBTYPES.has(r.subtype))
              .map((r) => ({
                ts: r.ts,
                user: r.user,
                botId: r.bot_id ?? (r.user && SLACK_SYSTEM_USER_IDS.has(r.user) ? r.user : undefined),
              }));
          }
          // final review, Important 1: a Slack system user (SLACK_SYSTEM_USER_IDS) carries a
          // real `user` and no `bot_id`, so it survives unfiltered outside of
          // `listConversations`'s im-skip above too (e.g. a Slackbot post in a channel/mpim).
          // Map it to a synthetic botId here so the importer's existing
          // `if (!m.user || m.botId) continue` catches it without the importer needing to know
          // about these ids.
          const botId = m.bot_id ?? (m.user && SLACK_SYSTEM_USER_IDS.has(m.user) ? m.user : undefined);
          messages.push({ ts: m.ts, user: m.user, botId, mentions, threadHasOwnReply, threadReplies });
        }

        return { messages, nextCursor, repliesRequests };
      }
    },

    async getUserInfo(userId: string): Promise<SlackUserInfo | null> {
      let data: UsersInfoResponse;
      try {
        data = await callSlack<UsersInfoResponse>(fetchImpl, sleepImpl, nowImpl, deadlineAt, token, "users.info", { user: userId });
      } catch (err) {
        if (err instanceof SlackRateLimitError) throw err;
        // review round 2, Critical 2: ONLY a genuine "no such user" degrades to null. Every
        // other failure (missing_scope, invalid_auth, a malformed 5xx body, a socket reset)
        // MUST propagate — resolveContact (./slack.ts) caches a null forever and the message
        // still counts as processed, so swallowing a real failure here silently and
        // permanently loses every message it touches.
        if (err instanceof SlackApiError && (err.code === "user_not_found" || err.code === "users_not_found")) {
          return null;
        }
        throw err;
      }
      // final review item 1 (ORB-149 closing fixes): an app/bot DM counterparty (Google Drive,
      // GitHub, …) arrives as `is_im: true, user: <bot user id>` and passes both the self-DM
      // and system-user-id exclusions above — Bendik's own message in that DM has a real
      // `user` and no `bot_id`, so without this it writes an `outbound` interaction against the
      // bot user id and mints a contact named after the app. Slack's `users.info` already
      // answers `is_bot` on this same call (no extra request); resolveContact/attemptWrite
      // already handle a `null` here exactly like any other unresolvable user — cached, no row
      // written, cursor still advances correctly.
      //
      // `is_app_user` alongside `is_bot`: variant 3 in SLACK_SYSTEM_USER_IDS's doc comment
      // above (USLACK, Slack's own system/notification user) resolves via `users.info` with
      // `is_bot` FALSY — `is_bot` alone is not a complete "is this a person?" test. Widening to
      // `is_app_user` too catches integration/app identities that Slack flags that way instead
      // of (or in addition to) `is_bot`, without this file needing to enumerate their ids.
      if (!data.user || data.user.deleted || data.user.is_bot || data.user.is_app_user) return null;
      // D3: users:read.email is load-bearing — absence degrades to a name-only contact
      // (email: null) rather than throwing; a guest account or an unsynced member can
      // legitimately have none on file.
      const email = data.user.profile?.email ?? null;
      const displayName = data.user.profile?.display_name || data.user.profile?.real_name || data.user.real_name || null;
      return { id: data.user.id, email, displayName };
    },
  };
}
