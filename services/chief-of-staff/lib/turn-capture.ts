/**
 * Capture one completed turn into ADR-0020's conversation record — the one place this service
 * writes a finished exchange.
 *
 * ORB-138: eve-saga shipped without a capture path once already. The retired `bin/saga.ts:118`
 * wired the (since-retired) markdown writer, and when that container stopped, capture stopped
 * with it — six days before anyone noticed. Two things broke at once: the vault stopped holding
 * a conversation history at all, and the dream cycle (whose ONLY input was those files at the
 * time) produced all-zeros every night since. Nothing here may repeat that.
 *
 * ADR-0020 (docs/decisions/0020-conversations.md) names `conversation_entries`
 * (`services/box/sql/060_conversation_entries.sql`) THE record: one row per exchange, an
 * `Origin` stamped at write time, never edited after. `originForTurn` below computes that
 * stamp; `captureTurn` is the write.
 *
 * THE MARKDOWN LOG IS GONE (W3B-s8). `_meta/conversations/` was the dream cycle's only input
 * until W3B-s3 pointed it at this table instead; W3B-s8 imports the existing corpus once, by
 * hand (`bin/import-conversation-logs.ts` — not yet run on any installation) and this file stops
 * writing that format. The legacy PARSER (`lib/dream/log-reader.ts`) is kept — the importer and
 * the dream cycle's own gap-fill, for an installation that has not yet run the importer, both
 * still need it — but nothing writes that format any more.
 *
 * FAIL SOFT. This hook runs on every turn of a live agent — a problem writing the conversation
 * record must never cost the owner their reply. The write is bounded by
 * `CONVERSATION_RECORD_TIMEOUT_MS` the way `agent/instructions/standing-facts.ts` bounds its own
 * read with `withTimeout` (see that file's header: a stall is a failure too, and eve applies no
 * timeout of its own here). An installation that has not yet applied migration 060 hits a
 * missing-table error on every single turn until it does — logging that every time would be
 * exactly the noise that hides a real problem, so it is logged loudly once per process and then
 * at most once every ten minutes. Every OTHER kind of write failure logs every time.
 */
import { makeConversationRecord, type NewConversationEntry } from "@lares/agent-kit/conversation-record";
import { getPool } from "@lares/agent-kit/db";
import { stampFor, type TurnKey } from "@lares/agent-kit/origin-taint";
import type { Origin } from "@lares/agent-kit/origin";
import { withTimeout } from "./timeout.js";

export interface TurnLogEntry {
  at: string; // ISO timestamp
  door: string;
  principal: string;
  input: string; // the turn's input — a person's message on a door turn, a machine nudge on a scheduled one
  reply: string; // the agent's reply text
  proposals: string[]; // proposed action names, e.g. "brain.write"
  /** Set only for a scheduled lane ("morning-brief", "weekly-summary"). Absent ⇒ a person
   *  spoke. It decides ATTRIBUTION: a machine nudge recorded as if a person said it would let
   *  a later turn quote them saying something they never said. */
  lane?: string;
  /** The turn that opened this exchange (ADR-0020, docs/decisions/0020-conversations.md) —
   *  what `captureTurn` below keys the conversation-record row on. Absent on an entry
   *  `lib/dream/log-reader.ts` has parsed back out of a legacy markdown file, which never
   *  carried one. */
  turnId?: string;
  /** The session this exchange ran in (ADR-0020) — same reason, same caveat. */
  sessionId?: string;
  /** Where this entry's content came from (ADR-0020 rule 2 / the origin spec), computed once
   *  by `originForTurn` below at write time — never inferred here or later. Absent for the
   *  same legacy-markdown reason as `turnId`; `captureTurn` fails closed to `third_party` if it
   *  ever sees this unset. */
  origin?: Origin;
}

/** The conversation-record write's budget. It runs inline in the hook the owner's reply waits
 *  on, so it gets a bound the same way `standing-facts.ts`'s per-turn read does. */
export const CONVERSATION_RECORD_TIMEOUT_MS = 2000;

/**
 * Which class a door turn's entry carries — ADR-0020 rule 2 and the origin spec's
 * narrowest-origin rule, in one function. A scheduled lane is `system`: nobody wrote it (origin
 * spec class 5, not `agent` — the schedule authored the prompt, not the agent). Anything else
 * starts as `owner`, UNLESS the turn read outside content during the exchange, in which case
 * `stampFor` narrows it — a summary of a fetched email does not launder the read into an
 * owner-said entry. A turn key this process cannot use (no session, no turn id) fails closed to
 * `third_party`, the least trusted class, exactly like `stampFor` itself does for every other
 * write path in this wave — but the entry is still written; an unattributable turn is not a
 * lost one.
 *
 * Exported so the test can drive this without a database.
 */
export function originForTurn(lane: string | undefined, key: TurnKey | undefined): Origin {
  return key ? stampFor(lane ? "system" : "owner", key) : "third_party";
}

/** The conversation-record half of `captureTurn`'s sink, narrowed to the one method this module
 *  calls — so a test can inject a fake without importing `pg` or standing up a database. */
export interface ConversationRecordSink {
  append(e: NewConversationEntry): Promise<unknown>;
}

let lazyRecord: ConversationRecordSink | undefined;

/** Lazily built, for the same reason `google-auth.ts` and `gateway-provider.ts` are: `eve
 *  build` evaluates every module with no secrets present, and `getPool()` throws without
 *  `DATABASE_URL`. Resolving it only when a turn is actually captured keeps the build green and
 *  the container bootable. */
function defaultRecord(): ConversationRecordSink {
  if (!lazyRecord) lazyRecord = makeConversationRecord(getPool());
  return lazyRecord;
}

/** Postgres' "relation does not exist" (42P01) — the shape an unapplied 060 migration
 *  produces, and the one failure this module throttles specially (see the module header). */
function isMissingTableError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "42P01";
}

const MISSING_TABLE_WARN_INTERVAL_MS = 10 * 60 * 1000;
let lastMissingTableWarnAt: number | undefined;

/** Logs loudly the first time this process sees a missing `conversation_entries` table, then at
 *  most once every ten minutes after — never once per turn forever. */
function warnMissingTable(err: unknown): void {
  const now = Date.now();
  if (lastMissingTableWarnAt !== undefined && now - lastMissingTableWarnAt < MISSING_TABLE_WARN_INTERVAL_MS) return;
  lastMissingTableWarnAt = now;
  console.warn(
    "turn-capture: conversation_entries does not exist yet — apply services/box/sql/060_conversation_entries.sql. " +
      "This turn (and any others since the last warning) was not recorded to the conversation record; " +
      "the reply itself is unaffected. (warns at most once per 10 minutes)",
    err,
  );
}

/** Test-only escape hatch: the "already warned" clock is module state so production behaves
 *  identically across every call, which is exactly what a test needs to reset between cases.
 *  Never called in production. */
export function resetMissingTableWarnForTests(): void {
  lastMissingTableWarnAt = undefined;
}

/**
 * BEST-EFFORT BY CONSTRUCTION. Every failure path warns and returns — a problem writing the
 * conversation record must never cost the owner their reply.
 *
 * `record` is optional so the test can inject a fake without a database; production always
 * calls this with one argument and gets the lazily-built real one.
 */
export async function captureTurn(e: TurnLogEntry, record?: ConversationRecordSink): Promise<void> {
  try {
    // The door hook always supplies sessionId/turnId (agent/hooks/turn-capture.ts's `flush`);
    // an entry `lib/dream/log-reader.ts` parsed back out of a legacy markdown file never had
    // them, and there is no session/turn to correlate a row to — so that entry is not the
    // conversation record's to write (it either already exists there via the one-time importer,
    // or it never will).
    if (!e.sessionId || !e.turnId) {
      console.warn("turn-capture: entry has no sessionId/turnId — not recorded to the conversation record (turn unaffected)");
      return;
    }

    const sink = record ?? defaultRecord();
    const entry: NewConversationEntry = {
      agent: process.env["LARES_AGENT_NAME"] ?? "unknown",
      sessionId: e.sessionId,
      turnId: e.turnId,
      door: e.door,
      personKey: e.principal,
      lane: e.lane ?? null,
      // Fails closed the same way stampFor itself does: an entry with no computed origin is
      // never given the benefit of the doubt.
      origin: e.origin ?? "third_party",
      input: e.input,
      reply: e.reply,
      proposals: e.proposals,
      at: new Date(e.at),
    };
    await withTimeout(sink.append(entry), CONVERSATION_RECORD_TIMEOUT_MS, "turn-capture: conversation record write");
  } catch (err) {
    if (isMissingTableError(err)) warnMissingTable(err);
    else console.warn("turn-capture: failed to write the conversation record (turn unaffected):", err);
  }
}
