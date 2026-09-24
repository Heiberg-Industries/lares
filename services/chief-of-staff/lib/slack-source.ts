/**
 * The real `SlackSourceDeps` (ORB-149 Task 4) — implements the interface
 * `./brief-content-slack.ts` documents. Read that file's header before editing this one; its
 * interface and `scanSlackThreads` logic have passed review and are not touched here.
 *
 * EGRESS: eve-saga is sealed. `installSlackProxyDispatcher()` is already installed process-wide
 * at module load by `agent/channels/slack.ts` (via `@lares/agent-kit/slack-dispatcher`), so any
 * `fetch` to `*.slack.com` from anywhere in this process is already routed through the squid
 * proxy. This file adds NO proxy plumbing of its own — that is the ORB-149 task's explicit
 * binding constraint, and re-adding it here would be redundant at best.
 *
 * TOKEN: read from the SAME `oauth_tokens` table the Google refresh tokens use —
 * `provider='slack'` instead of `'google'` — via `@lares/agent-kit/google-auth`'s
 * `getMostRecentRefreshToken`, which is already parameterized by provider. No second
 * encryption path is written here (ORB-149 binding constraint: reuse the existing decrypt
 * path rather than duplicate it). Missing token → `SlackUnenrolledError`, loud, never a
 * silent no-op — the OAuth install is a human step (docs/runbooks/slack-user-token.md).
 *
 * MESSAGE TEXT (ORB-45 Task 10, B1): `push()` now carries `text` onto the returned
 * `SlackThreadMessage` — IN FLIGHT ONLY, for the last-message-in-flight feature
 * (`brief-content-slack.ts`'s `buildDirectSnapshot`/`buildChannelSnapshots` trim it onto
 * `ThreadSnapshot.lastMessageText`, feeding Task B3's bounded model read and Task B5's reason
 * line). It is never persisted anywhere by this file, and `lib/obligations-store.ts`'s
 * `upsertSeen` never writes it to `obligation_threads` — only pointer columns reach that table.
 */
import { getMostRecentRefreshToken } from "@lares/agent-kit/google-auth";
import { SlackRateLimitError } from "@lares/network/lib/importers/slack.js";
import type { SlackConversationRef, SlackSourceDeps, SlackThreadMessage, SlackUserIdentity } from "./brief-content-slack.js";

/** Thrown by `resolveSlackToken` when nothing is enrolled. Never silently no-ops: every caller
 *  either handles this or lets it propagate loudly — there is no default/fallback token. */
export class SlackUnenrolledError extends Error {
  constructor(principal: string) {
    super(
      `No Slack user token enrolled for principal "${principal}" (oauth_tokens, provider='slack'). ` +
        `The owner's OAuth install is a human step nothing here can perform — see ` +
        `docs/runbooks/slack-user-token.md.`,
    );
    this.name = "SlackUnenrolledError";
  }
}

/**
 * Resolves the configured Slack user token from `oauth_tokens`. Throws `SlackUnenrolledError` — never
 * returns an empty/placeholder string — when nothing is enrolled yet.
 */
export async function resolveSlackToken(
  principal: string = process.env["SLACK_TOKEN_PRINCIPAL_ID"] ?? "",
): Promise<string> {
  principal = principal.trim();
  if (!principal) throw new Error("Set SLACK_TOKEN_PRINCIPAL_ID to the enrolled Slack token principal");
  const row = await getMostRecentRefreshToken(principal, "slack");
  if (!row) throw new SlackUnenrolledError(principal);
  return row.token;
}

// -----------------------------------------------------------------------------------------
// fetch wrapper
// -----------------------------------------------------------------------------------------

const SLACK_API_BASE = "https://slack.com/api";
const HISTORY_PAGE_LIMIT = 100;

type ConversationsListResponse = {
  ok: boolean;
  error?: string;
  channels?: Array<{
    id: string;
    is_channel?: boolean;
    is_im?: boolean;
    is_mpim?: boolean;
    is_archived?: boolean;
    user?: string; // im only
  }>;
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
};

type UsersInfoResponse = {
  ok: boolean;
  error?: string;
  user?: {
    id: string;
    deleted?: boolean;
    real_name?: string;
    /** ORB-193 — the owner clock's second source. An IANA zone name ("Europe/Oslo"), which Slack
     *  sets from the device and updates on its own, which is exactly why it catches the trip
     *  nobody filed with Marcel. Slack also returns `tz_label` and `tz_offset`; neither is read
     *  here, because an offset cannot survive a DST boundary and a label is not a zone id.
     *
     *  INFERRED CONTRACT (per the root CLAUDE.md's third-party rule): Slack documents `tz` on the
     *  user object, but nothing promises it is always an IANA id or always present — an account
     *  that never set one, or a legacy zone name, is possible. So the reader below returns null
     *  rather than a guess, and `@lares/agent-kit/owner-clock` validates any candidate against
     *  `Intl` before believing it. The sweep is `tests/live/slack-user-tz.live.mts`. */
    tz?: string;
    profile?: { email?: string; display_name?: string; real_name?: string };
  };
};

/**
 * Thrown by `callSlack` when Slack answers `ok:false` with anything other than a 429 (which
 * throws `SlackRateLimitError` instead). Carries Slack's own `error` code — same shape as the
 * network importer's twin (`@lares/network/lib/importers/slack-reader.ts`'s `SlackApiError`),
 * duplicated locally rather than imported so this file stays self-contained the same way its
 * response-shape types already are. Lets `getUserInfo` distinguish a genuine "no such user"
 * (`user_not_found`/`users_not_found`) from a real failure (`missing_scope`, `invalid_auth`, a
 * malformed response) that must never be swallowed into `null` — review round 2, Critical 2.
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

/** Slack's own built-in bot user id — uniquely among bots it carries a real `userId` with no
 *  `bot_id` either. `./brief-content-slack.ts` already filters it defensively, but this reader
 *  is the one this ticket names as responsible for mapping it to `isBot` at the source
 *  (review round 2, Important 5 — a stated requirement of this task, left undone until now). */
const SLACKBOT_USER_ID = "USLACKBOT";

async function callSlack<T extends { ok: boolean; error?: string }>(
  fetchImpl: typeof fetch,
  token: string,
  method: string,
  params: Record<string, string | number | undefined>,
  signal?: AbortSignal,
): Promise<T> {
  // A budget already spent must not buy another Slack request. `scanSlackThreads` walks
  // conversations in a serial loop; without this, an abort that lands between two iterations
  // would still issue the next call and only reject once it was in flight.
  signal?.throwIfAborted();
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  const res = await fetchImpl(`${SLACK_API_BASE}/${method}?${qs.toString()}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    // Deliberately spread rather than always set: a `signal: undefined` key is harmless to
    // Node's fetch but not to every stub a test might hand in, and "the caller passed no
    // signal" should look exactly like the pre-ORB-164 call it is.
    ...(signal ? { signal } : {}),
  });
  if (res.status === 429) {
    const retryAfterHeader = res.headers.get("Retry-After");
    const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 30;
    throw new SlackRateLimitError(Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 30);
  }
  const data = (await res.json()) as T;
  if (!data.ok) throw new SlackApiError(data.error ?? "unknown", method);
  return data;
}

/**
 * The owner's own timezone, as Slack reports it (ORB-193) — the owner clock's second source, read
 * every 30 minutes by `agent/schedules/owner-clock.ts`.
 *
 * Standalone rather than a method on `createSlackSourceReader`: that reader is built per brief scan
 * with a scan budget and an abort signal, while this is one call on a cron with no scan at all.
 * Egress needs no plumbing here — `installSlackProxyDispatcher()` is already installed
 * process-wide by `agent/channels/slack.ts`, so this `fetch` is proxied like every other.
 *
 * Returns null when Slack has no timezone for the account (or the user is gone); THROWS on any real
 * failure (`invalid_auth`, `missing_scope`, a 429), the same asymmetry `getUserInfo` draws — the
 * caller logs it and leaves the previous signal to age out, which is a better answer than a
 * confidently wrong clock.
 */
export async function fetchSlackUserTimezone(
  userId: string,
  opts: { token: string; fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<string | null> {
  const data = await callSlack<UsersInfoResponse>(
    opts.fetchImpl ?? fetch, opts.token, "users.info", { user: userId }, opts.signal,
  );
  if (!data.user || data.user.deleted) return null;
  const tz = data.user.tz?.trim();
  return tz === undefined || tz === "" ? null : tz;
}

type ConversationKind = "im" | "mpim" | "channel";

export interface SlackSourceReaderOptions {
  /** The Slack USER token (xoxp-…) — resolved by `resolveSlackToken`, never hardcoded or
   *  defaulted here. */
  token: string;
  /** Bendik's own Slack user id — needed to compute `mentionsOwner`. */
  ownUserId: string;
  fetchImpl?: typeof fetch;
  /**
   * ORB-164 — cancellation, carried to every Slack request this reader makes.
   *
   * The morning brief bounds the scan with a sub-timeout, and `withTimeout` RACES: before this
   * option existed, a scan that outran its budget kept paging Slack in the background after the
   * caller had already given up on it (morning-brief.ts's own note admitted as much). On the
   * one morning that actually happened the wasted work was real — 40 serial
   * `conversations.history` calls with nobody left to read the answer. A signal is the only
   * thing that reaches an in-flight `fetch`; a flag checked between calls would still leave the
   * current request running and cannot stop a hung one at all.
   *
   * Optional and additive: no signal means exactly the request shape this reader sent before.
   */
  signal?: AbortSignal;
}

/**
 * Real `SlackSourceDeps` implementation. `listConversations` enumerates every channel/im/mpim
 * the token can see and remembers each one's kind (needed by `readConversation`, whose own
 * signature — matching `./brief-content-slack.ts`'s interface, not editable here — takes only a
 * conversation id). `readConversation` paginates `conversations.history`; for a CHANNEL
 * conversation it additionally walks `conversations.replies` on every thread parent it meets, so
 * a reply buried in a thread (not just a broadcast) is visible to `buildChannelSnapshots`'
 * participation check — the same real cost `./slack-reader.ts` (the network importer's reader)
 * documents for `threadHasOwnReply`. im/mpim conversations skip that walk entirely: per
 * `SlackThreadMessage.threadTs`'s own doc comment, its value is never read for those kinds, and
 * `mentionsOwner` is unconditionally `false` there too, so there is nothing to gain from it.
 *
 * A conversation id `readConversation` is asked about that this reader never saw via
 * `listConversations` (kind unknown — e.g. a test calling it directly) defaults to "channel"
 * behaviour: the conservative direction, since a channel treatment only ever adds information
 * (extra replies fetched) rather than silently dropping any.
 */
export function createSlackSourceDeps(opts: SlackSourceReaderOptions): SlackSourceDeps {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { token, ownUserId, signal } = opts;
  const kindById = new Map<string, ConversationKind>();

  function mentionsOwnerIn(text: string | undefined): boolean {
    if (!text) return false;
    return new RegExp(`<@${ownUserId}(?:\\|[^>]*)?>`).test(text);
  }

  return {
    async listConversations(): Promise<SlackConversationRef[]> {
      const out: SlackConversationRef[] = [];
      let cursor: string | undefined;
      do {
        const data = await callSlack<ConversationsListResponse>(fetchImpl, token, "conversations.list", {
          types: "public_channel,private_channel,mpim,im",
          exclude_archived: "true",
          limit: 200,
          cursor,
        }, signal);
        for (const c of data.channels ?? []) {
          if (c.is_archived) continue;
          if (c.is_im) {
            kindById.set(c.id, "im");
            out.push({ id: c.id, kind: "im", counterpartyUserId: c.user });
          } else if (c.is_mpim) {
            kindById.set(c.id, "mpim");
            out.push({ id: c.id, kind: "mpim" });
          } else {
            kindById.set(c.id, "channel");
            out.push({ id: c.id, kind: "channel" });
          }
        }
        cursor = data.response_metadata?.next_cursor || undefined;
      } while (cursor);

      // ORB-149 review round 3, CRITICAL: DMs/group-DMs are partitioned AHEAD of channels
      // here, before this list is ever sliced. `scanSlackThreads`
      // (brief-content-slack.ts) truncates this list to `maxConversations` with NO ordering
      // preference of its own — it trusts this reader's order. Slack's own
      // `conversations.list` return order is not DM-first (or any documented order at all),
      // so an un-partitioned list handed to a small slice can lose every DM to channels that
      // happened to sort earlier.
      //
      // This is not hypothetical on Bendik's real workspace: 35 public + 6 private + 38 im =
      // 79 conversations. At the morning-brief's `SLACK_MAX_CONVERSATIONS` cap (40,
      // deliberately tightened from the library default of 200 — see morning-brief.ts), an
      // un-partitioned list whose channels sort first would hand `scanSlackThreads` 35
      // public + 5 private and ZERO im/mpim — every morning, forever, silently
      // indistinguishable from "nothing owed". The importer hit this exact defect already
      // (a first-run budget spent on the lowest-value conversations) and fixed it the same
      // way: prioritise DMs.
      //
      // STABLE partition (not a sort) — relative order within each group is preserved exactly
      // as `conversations.list` returned it, so this stays predictable and doesn't reshuffle
      // on every call for reasons unrelated to kind.
      const dms = out.filter((c) => c.kind === "im" || c.kind === "mpim");
      const channels = out.filter((c) => c.kind === "channel");
      return [...dms, ...channels];
    },

    async readConversation(conversationId: string, oldest: string | undefined, ceiling: number): Promise<SlackThreadMessage[]> {
      const kind = kindById.get(conversationId) ?? "channel";
      const out: SlackThreadMessage[] = [];
      const seenTs = new Set<string>();

      function push(m: SlackApiMessage, threadTsOverride?: string): void {
        if (seenTs.has(m.ts) || out.length >= ceiling) return;
        seenTs.add(m.ts);
        out.push({
          ts: m.ts,
          userId: m.user,
          isBot: !!m.bot_id || m.user === SLACKBOT_USER_ID,
          subtype: m.subtype,
          threadTs: threadTsOverride ?? m.thread_ts ?? m.ts,
          mentionsOwner: kind === "channel" ? mentionsOwnerIn(m.text) : false,
          text: m.text,
        });
      }

      let cursor: string | undefined;
      while (out.length < ceiling) {
        const data = await callSlack<ConversationsHistoryResponse>(fetchImpl, token, "conversations.history", {
          channel: conversationId,
          oldest,
          cursor,
          limit: HISTORY_PAGE_LIMIT,
        }, signal);
        const page = data.messages ?? [];
        if (page.length === 0) break;

        for (const m of page) {
          if (out.length >= ceiling) break;
          push(m);
          if (kind === "channel" && m.thread_ts && m.thread_ts === m.ts && (m.reply_count ?? 0) > 0) {
            const repliesData = await callSlack<ConversationsRepliesResponse>(fetchImpl, token, "conversations.replies", {
              channel: conversationId,
              ts: m.thread_ts,
              limit: 200,
            }, signal);
            for (const r of (repliesData.messages ?? []).slice(1)) {
              if (out.length >= ceiling) break;
              push(r, m.thread_ts);
            }
          }
        }

        cursor = data.has_more ? (data.response_metadata?.next_cursor || undefined) : undefined;
        if (!cursor) break;
      }
      return out;
    },

    async getUserInfo(userId: string): Promise<SlackUserIdentity | null> {
      let data: UsersInfoResponse;
      try {
        data = await callSlack<UsersInfoResponse>(fetchImpl, token, "users.info", { user: userId }, signal);
      } catch (err) {
        if (err instanceof SlackRateLimitError) throw err;
        // review round 2, Critical 2: ONLY a genuine "no such user" degrades to null. Every
        // other failure (missing_scope, invalid_auth, a malformed response) MUST propagate —
        // resolveIdentity (./brief-content-slack.ts) would otherwise silently fall back to a
        // raw Slack id forever on a real, ongoing failure (e.g. an under-scoped token) rather
        // than surfacing it. Harmless-degrade-cosmetically here (unlike the importer, where the
        // same swallow corrupts the graph), but the asymmetry between the two readers is itself
        // a trap, so this mirrors the importer's fix exactly.
        if (err instanceof SlackApiError && (err.code === "user_not_found" || err.code === "users_not_found")) {
          return null;
        }
        throw err;
      }
      if (!data.user || data.user.deleted) return null;
      // D3: users:read.email is load-bearing — absence degrades to a name-only identity
      // (email: null), matching resolveIdentity's own no-throw contract in brief-content-slack.ts.
      const email = data.user.profile?.email ?? null;
      const displayName = data.user.profile?.display_name || data.user.profile?.real_name || data.user.real_name || null;
      return { id: data.user.id, email, displayName };
    },
  };
}
