/**
 * Telegram private-chat session rotation (ORB-74).
 *
 * eve's own continuation-token formula (`telegramContinuationToken`,
 * `dist/src/public/channels/telegram/api.js`) collapses to `<chatId>::` for a private chat
 * whose `onMessage` never sets a `conversationId` — one session per chat, bounded only by
 * the framework's 30-day default session timeout, which releases with no summary (verified
 * live 2026-08-16, see `docs/runbooks/eve-saga.md`). This ports the old runtime's
 * day-boundary rotation (`services/agent-runtime/lib/adapters/brain-ai-sdk.ts`
 * `ROTATE_MIN_MESSAGES`/`ROTATE_HARD_CAP`) onto eve's public channel-event seams:
 *
 *   - `onMessage` (`agent/channels/telegram.ts`) logs the inbound turn and, if a PRIOR
 *     turn's rotation left a carry-forward summary waiting, consumes it into this turn's
 *     `context` (verified against the compiled dispatch: `context: [contextBlock,
 *     ...(onMessage-returned context)]`, `telegramChannel.js` `dispatchMessage`).
 *   - the `message.completed` event (terminal replies only — gated on
 *     `finishReason === "stop"`) logs the assistant's reply, writes down WHICH durable session
 *     answered and on which Oslo day, then checks whether the day has rolled over since the
 *     live session was last anchored. If so, it summarizes the day's exchanges and leaves that
 *     summary waiting as the carry-forward context for the next inbound message.
 *   - the webhook front door (`agent/channels/telegram-webhook.ts`) reads that recorded session
 *     on the way IN, and on the first update of a new day retires it — `attachSession(id)
 *     .reset({reason})` — before forwarding, so the update lands in a brand-new session.
 *
 * WHY THE FRONT DOOR AND NOT THE EVENT HANDLER. eve 0.57 replaced the channel's
 * `continuation.rekey()` with `continuation.alias()`, and alias is ADDITIVE: every address a
 * session has ever claimed keeps resolving to it. Renaming the live session would therefore
 * leave yesterday's conversation answering today's messages while this table claimed it had
 * rotated — the exact silent failure the rotation exists to prevent. The only public way to
 * retire a session is `Session.reset()`, reachable through `attachSession`, which eve hands to
 * ROUTE handlers only (`RouteHandlerArgs`) and never to a channel event context. So the id is
 * written down inside the turn and acted on at the door.
 *
 * THE LAG, AND WHAT CLOSES IT. Producing the summary on the first completed turn of the next day
 * means the first message of a new day is answered by a fresh session that has not been handed
 * it; the FOLLOWING message is the one that carries it. (Before eve 0.57 that first message was
 * answered by yesterday's session instead, which still held the whole day.) `runDayHandover`
 * below writes the summary for a day that has ENDED, ahead of the next message, so message one
 * has it. The on-completion path stays exactly as it was and is the fallback for a night the job
 * did not run — see `handoverWrittenFor`/`storeDayHandover` for the one rule that keeps the two
 * from ever writing two different summaries of the same chat and day. The rotation is
 * at-least-once in the same direction it always was: a failed retirement keeps the live session
 * for one more day and retries at the next day boundary.
 */
import type { Pool } from "pg";
import { getPool } from "@lares/agent-kit/db";
import { gatewayComplete } from "./llm-complete.js";
import { configuredOwnerId } from "./identity-client.js";
import { osloDate, TZ } from "./recurrence.js";

/** Oslo calendar date as `YYYY-MM-DD` — the rotation boundary. ORB-95: was its own
 *  Intl.DateTimeFormat call, duplicating recurrence.ts's osloDate (which additionally
 *  handles the midnight-renders-as-24 ICU quirk on its hour field — a date-string caller
 *  like this one was never exposed to that quirk, but there's no reason to compute the same
 *  value two different ways). */
export function osloDay(now: Date = new Date()): string {
  return osloDate(now);
}

/** The calendar day before `day` (both `YYYY-MM-DD`). Calendar arithmetic, deliberately not
 *  clock arithmetic: midday UTC is never within a day of a DST shift in any zone, so stepping
 *  back one UTC date can never land on the wrong calendar date. */
export function osloDayBefore(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export interface RotationState {
  osloDay: string;
  pendingContext: string | null;
  /** The day whose hand-over summary has already been written (migration 081), or null when
   *  no day has been handed over for this chat yet. */
  handoverDay: string | null;
}

/** Reads the tracked anchor day for a chat, creating a fresh row anchored to `today` on
 *  first contact (nothing to rotate yet). Existing rows are returned untouched — this must
 *  NOT itself advance the day; only `completeRotation` does that, after a summary lands. */
export async function getRotationState(db: Pool, chatId: string, today: string): Promise<RotationState> {
  const { rows } = await db.query<{
    oslo_day: string; pending_context: string | null; handover_day: string | null;
  }>(
    `INSERT INTO telegram_session_rotation (chat_id, oslo_day, principal)
     VALUES ($1, $2, $3)
     ON CONFLICT (chat_id) DO UPDATE SET chat_id = telegram_session_rotation.chat_id
     RETURNING oslo_day, pending_context, handover_day`,
    [chatId, today, configuredOwnerId()],
  );
  return {
    osloDay: rows[0]!.oslo_day,
    pendingContext: rows[0]!.pending_context,
    handoverDay: rows[0]!.handover_day,
  };
}

/** True once the tracked anchor day is behind `today` — the rotation trigger. */
export function dayHasRolledOver(state: RotationState, today: string): boolean {
  return state.osloDay !== today;
}

/** Reads + clears the carry-forward summary left by a prior rotation, if any. Safe to call
 *  before any rotation row exists (matches zero rows, returns null). */
export async function consumePendingContext(db: Pool, chatId: string): Promise<string | null> {
  // A plain `UPDATE ... RETURNING` returns the NEW row, not the old one — it would hand
  // back the NULL we just wrote, not the value being consumed. The CTE reads `prior` off
  // the statement's start-of-transaction snapshot, before this same statement's UPDATE
  // takes effect, so it captures the value being cleared.
  const { rows } = await db.query<{ pending_context: string | null }>(
    `WITH prior AS (SELECT pending_context FROM telegram_session_rotation WHERE chat_id = $1)
     UPDATE telegram_session_rotation SET pending_context = NULL
     WHERE chat_id = $1 AND pending_context IS NOT NULL
     RETURNING (SELECT pending_context FROM prior) AS pending_context`,
    [chatId],
  );
  return rows[0]?.pending_context ?? null;
}

/** Appends one exchange to the day's log. A no-op on blank text (defensive — callers
 *  already filter, but a rotation must never choke on an edge-case empty body). */
export async function recordExchange(
  db: Pool, chatId: string, role: "user" | "assistant", body: string,
): Promise<void> {
  if (!body.trim()) return;
  await db.query(
    `INSERT INTO telegram_daily_log (chat_id, role, body, principal) VALUES ($1,$2,$3,$4)`,
    [chatId, role, body, configuredOwnerId()],
  );
}

const SUMMARY_WINDOW = 40; // matches brain-ai-sdk.ts's ROTATE_SUMMARY_WINDOW precedent
const SUMMARY_PROMPT = [
  "Summarize this Telegram conversation for your own continuity in ~200 words or less.",
  "Capture: decisions made, open threads, and standing preferences the user mentioned.",
  "Write it as notes to yourself, not prose for the user. Never invent details not present below.",
].join(" ");

/** Builds a continuity summary from the chat's most recent logged exchanges. Returns null
 *  on an empty log OR a failed model call — rotation must never crash a live turn over a
 *  summarization hiccup; the caller still rotates, just without a carry-forward note. */
export async function summarizeRecentExchanges(db: Pool, chatId: string): Promise<string | null> {
  const { rows } = await db.query<{ role: string; body: string }>(
    `SELECT role, body FROM telegram_daily_log WHERE chat_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [chatId, SUMMARY_WINDOW],
  );
  return summarizeExchanges(rows);
}

/** The one model call both summary paths make — same prompt, same purpose (the gateway's
 *  `utility` default, as this summary has always used), same 400-token cap, so moving the work
 *  to the night before does not change what is asked or what it costs. Returns null on an empty
 *  window OR a failed call: a summary is a nicety, and neither path may take a turn or a
 *  nightly pass down with it. */
async function summarizeExchanges(rows: { role: string; body: string }[]): Promise<string | null> {
  if (rows.length === 0) return null;
  const transcript = rows.reverse().map((r) => `${r.role}: ${r.body}`).join("\n");
  try {
    const summary = await gatewayComplete(`${SUMMARY_PROMPT}\n\n${transcript}`, { maxOutputTokens: 400 });
    const trimmed = summary.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (err) {
    console.error("telegram-rotation: summary call failed — rotating without one", err);
    return null;
  }
}

/** The day's own exchanges, newest `SUMMARY_WINDOW` first, summarized. Unlike
 *  `summarizeRecentExchanges` — which takes the last N rows whatever day they fall on, because
 *  it runs inside a turn that has just closed a day — this is bounded to ONE Oslo day, the one
 *  being handed over, and never bleeds an older day into it. */
export async function summarizeDay(db: Pool, chatId: string, day: string): Promise<string | null> {
  const { rows } = await db.query<{ role: string; body: string }>(
    `SELECT role, body FROM telegram_daily_log
      WHERE chat_id = $1 AND (created_at AT TIME ZONE $3::text)::date = $2::date
      ORDER BY created_at DESC LIMIT $4`,
    [chatId, day, TZ, SUMMARY_WINDOW],
  );
  return summarizeExchanges(rows);
}

/** The chats with at least one logged exchange on that Oslo day — the job's whole worklist, and
 *  the reason a chat that said nothing yesterday costs no model call at all: it is never in it. */
export async function chatsThatTalkedOn(db: Pool, day: string): Promise<string[]> {
  const { rows } = await db.query<{ chat_id: string }>(
    `SELECT DISTINCT chat_id FROM telegram_daily_log
      WHERE (created_at AT TIME ZONE $2::text)::date = $1::date
      ORDER BY chat_id`,
    [day, TZ],
  );
  return rows.map((r) => r.chat_id);
}

/** Marks rotation complete: advances the tracked anchor day to `today` and stores the
 *  carry-forward summary (or clears it, if summarization produced nothing) — so the same
 *  day-boundary is not detected again on the next turn.
 *
 *  `closingDay` is the day this summary is OF. Given, and with a summary to show for it, the
 *  day is stamped as handed over, so a later `runDayHandover` for the same day finds the work
 *  already done instead of writing a second, differently-worded summary of it. */
export async function completeRotation(
  db: Pool, chatId: string, today: string, summary: string | null, closingDay?: string,
): Promise<void> {
  await db.query(
    `UPDATE telegram_session_rotation
        SET oslo_day = $2, pending_context = $3,
            handover_day = CASE WHEN $4::text IS NOT NULL AND $3::text IS NOT NULL
                                THEN $4::text ELSE handover_day END,
            updated_at = now()
      WHERE chat_id = $1`,
    [chatId, today, summary, closingDay ?? null],
  );
}

/** Advances the anchor day and NOTHING else — the on-completion path's move when the day being
 *  closed was already handed over overnight. The summary the job wrote (and the first message of
 *  the day consumed) is left exactly as it is: rotating is not re-summarizing. */
export async function advanceRotationDay(db: Pool, chatId: string, today: string): Promise<void> {
  await db.query(
    `UPDATE telegram_session_rotation SET oslo_day = $2, updated_at = now() WHERE chat_id = $1`,
    [chatId, today],
  );
}

const RETENTION = "14 days";

/** Drops logged exchanges older than the retention window — this table exists to fix
 *  unbounded growth and must not become a second instance of the same problem. */
export async function pruneOldExchanges(db: Pool): Promise<void> {
  await db.query(`DELETE FROM telegram_daily_log WHERE created_at < now() - interval '${RETENTION}'`);
}

// ── The overnight hand-over: yesterday, summarized before the new day's first message ────

/** True once this chat's hand-over for `day` has been written — by the overnight job or, when
 *  it did not run, by the on-completion path that closed the day. Read BEFORE the model call, so
 *  a second pass over the same night costs nothing. A box that has not applied 081 yet throws
 *  here, which `runDayHandover` turns into a skipped chat and one log line. */
export async function handoverWrittenFor(db: Pool, chatId: string, day: string): Promise<boolean> {
  const { rows } = await db.query<{ handover_day: string | null }>(
    `SELECT handover_day FROM telegram_session_rotation WHERE chat_id = $1`,
    [chatId],
  );
  return rows[0]?.handover_day === day;
}

/**
 * Stores a day's hand-over summary where the next inbound message already looks for it
 * (`pending_context`, consumed by `consumePendingContext`), and stamps the day as handed over.
 *
 * Returns false when this day was already stamped — the claim IS the UPDATE, the same shape as
 * `claimRolledOverSession`, so two passes running together write one summary rather than
 * overwriting each other's. The row is created if the chat has somehow logged exchanges without
 * one (a turn that never completed): the summary must have somewhere to wait.
 */
export async function storeDayHandover(
  db: Pool, chatId: string, day: string, summary: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO telegram_session_rotation (chat_id, oslo_day, principal, pending_context, handover_day)
     VALUES ($1, $2, $4, $3, $2)
     ON CONFLICT (chat_id) DO UPDATE
        SET pending_context = EXCLUDED.pending_context,
            handover_day = EXCLUDED.handover_day,
            updated_at = now()
      WHERE telegram_session_rotation.handover_day IS DISTINCT FROM EXCLUDED.handover_day`,
    [chatId, day, summary, configuredOwnerId()],
  );
  return (rowCount ?? 0) > 0;
}

/** What one pass did, for the caller's log line and for a test to read. */
export interface DayHandoverRun {
  day: string;
  /** Chats that had exchanges on that day — the only ones the model is ever asked about. */
  chats: number;
  written: number;
  /** Already handed over (a second pass over the same night), so nothing was asked or written. */
  skipped: number;
  /** The summary could not be produced or stored; the day stays the on-completion path's. */
  failed: number;
}

/**
 * One pass over a day that has ENDED: summarize each chat that talked and leave the summary
 * waiting, so the first message of the following day is answered with it in hand rather than by
 * a session that knows nothing.
 *
 * COST IS BOUNDED BY SHAPE, not by a price table. At most one call per chat that spoke that day
 * (in practice one), over at most `SUMMARY_WINDOW` exchanges, capped at 400 output tokens — the
 * same single call the on-completion path was already making for the same day, moved earlier.
 * It is deliberately NOT guarded by `lib/dream/spend.ts`'s `assertStepAffordable`: that table
 * prices the `brain` alias only, and this summary has always gone through the gateway's
 * `utility` purpose, which it would refuse outright as unpriced.
 *
 * NEVER THROWS FOR ONE CHAT. A failure — the gateway, or a box that has not applied 081 — costs
 * one log line, leaves the day unstamped, and hands it back to the on-completion path, which
 * then behaves exactly as it does today.
 */
export async function runDayHandover(db: Pool, closingDay: string): Promise<DayHandoverRun> {
  const chats = await chatsThatTalkedOn(db, closingDay);
  let written = 0;
  let skipped = 0;
  let failed = 0;

  for (const chatId of chats) {
    try {
      if (await handoverWrittenFor(db, chatId, closingDay)) {
        skipped += 1;
        continue;
      }
      const summary = await summarizeDay(db, chatId, closingDay);
      if (summary === null) {
        failed += 1;
        continue;
      }
      if (await storeDayHandover(db, chatId, closingDay, summary)) written += 1;
      else skipped += 1;
    } catch (err) {
      failed += 1;
      console.error(`telegram-handover: chat ${chatId} could not be handed over for ${closingDay}`, err);
    }
  }

  console.log(
    `telegram-handover: day=${closingDay} chats=${chats.length} written=${written} ` +
      `skipped=${skipped} failed=${failed}`,
  );
  return { day: closingDay, chats: chats.length, written, skipped, failed };
}

// ── The day boundary: record the live session, retire it at the door ─────────────────────

/** Writes down the durable session that just answered in this chat, and the Oslo day it
 *  answered on (migration 078). The row is created by `getRotationState`, which the caller
 *  runs first on the same turn — this only ever updates it. */
export async function recordServingSession(
  db: Pool, chatId: string, today: string, sessionId: string,
): Promise<void> {
  await db.query(
    `UPDATE telegram_session_rotation SET session_id = $2, session_day = $3, updated_at = now()
     WHERE chat_id = $1`,
    [chatId, sessionId, today],
  );
}

/**
 * Claims the recorded session for retirement when its day is behind `today`, returning it
 * exactly once. Returns null when there is nothing to retire — no row, same day, or another
 * update already claimed it.
 *
 * The claim IS the UPDATE. A read followed by a write would let two updates arriving together
 * at the day boundary both decide to retire, and the second reset would land on the fresh
 * session the first one's message had just opened. Under `READ COMMITTED` the second statement
 * blocks on the row lock, re-checks its `WHERE` against the committed row, finds `session_id`
 * already NULL, and matches nothing.
 *
 * Same `RETURNING (SELECT … FROM prior)` shape as `consumePendingContext`, for the same
 * reason: a plain `RETURNING session_id` hands back the NULL just written, not the value
 * being claimed.
 */
export async function claimRolledOverSession(
  db: Pool, chatId: string, today: string,
): Promise<string | null> {
  const { rows } = await db.query<{ session_id: string | null }>(
    `WITH prior AS (SELECT session_id FROM telegram_session_rotation WHERE chat_id = $1)
     UPDATE telegram_session_rotation SET session_id = NULL, updated_at = now()
     WHERE chat_id = $1 AND session_id IS NOT NULL AND session_day IS DISTINCT FROM $2
     RETURNING (SELECT session_id FROM prior) AS session_id`,
    [chatId, today],
  );
  return rows[0]?.session_id ?? null;
}

/** The subset of eve's `Session` the retirement needs — `attachSession(id)` returns one. */
export interface RetireHandle {
  reset(options: { reason: string }): Promise<unknown>;
}

/** Shape of an inbound update this door treats as a day boundary. Only a `message` counts:
 *  a button tap (`callback_query`) answers the LIVE conversation and must never retire it,
 *  and an edit is not a new turn. */
interface MaybeChatUpdate {
  message?: { chat?: { id?: unknown } };
}

/** The chat an inbound update belongs to, or null when the body is unreadable or carries no
 *  message. Never throws: the front door forwards whatever it cannot understand. */
export function telegramChatIdOfUpdate(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const id = (parsed as MaybeChatUpdate)?.message?.chat?.id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  if (typeof id === "string" && id.trim().length > 0) return id.trim();
  return null;
}

/** Recorded on the reset so a day-boundary retirement is distinguishable, in the runtime's own
 *  logs, from the one the owner asks for from the console. */
const DAY_BOUNDARY_REASON = "The Oslo calendar day rolled over; the previous day's conversation is retired";

/** How long the whole day-boundary check may take before the update is forwarded regardless.
 *  Short on purpose: the door's standing contract is that the agent going deaf is worse than a
 *  missed rotation, and a database that is slow enough to matter here is already a bad day. */
const RETIREMENT_BUDGET_MS = 1_500;

async function withBudget<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The front door's half of the rotation: on the first update of a new Oslo day for this chat,
 * retire the conversation that served the previous one, so the update opens a fresh session.
 *
 * NEVER THROWS, NEVER STALLS. Every fault — an unreadable body, an unreachable database, a
 * column a box has not migrated yet, a reset the runtime refuses, a read that simply takes too
 * long — costs exactly one log line, and the caller forwards the update as if nothing had
 * happened. A retirement missed today is retried at the next day boundary.
 */
export async function retirePriorDaySession(
  raw: string,
  attachSession: (sessionId: string) => RetireHandle,
  deps: { db?: Pool; now?: Date; budgetMs?: number } = {},
): Promise<void> {
  const chatId = telegramChatIdOfUpdate(raw);
  if (chatId === null) return;
  try {
    const db = deps.db ?? getPool();
    const budget = deps.budgetMs ?? RETIREMENT_BUDGET_MS;
    const sessionId = await withBudget(
      claimRolledOverSession(db, chatId, osloDay(deps.now)), budget, "the day-boundary read",
    );
    if (sessionId === null) return;
    await withBudget(
      attachSession(sessionId).reset({ reason: DAY_BOUNDARY_REASON }), budget, "the session reset",
    );
    console.log("[telegram-rotation] the day rolled over — the previous day's conversation is retired; this update starts a new one");
  } catch (err) {
    console.error("[telegram-rotation] day-boundary retirement failed — forwarding the update anyway", err);
  }
}
