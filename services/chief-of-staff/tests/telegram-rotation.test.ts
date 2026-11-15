import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { quiet } from "./helpers/quiet-pool.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { closePool } from "@lares/agent-kit/db";
import { MODEL_CALLS_REFUSED_UNSCOPED, MODEL_COMPACTION_REFUSED } from "@lares/agent-kit/conversation-too-long";

import {
  homeDay,
  homeDayBefore,
  dayHasRolledOver,
  getRotationState,
  consumePendingContext,
  recordExchange,
  summarizeRecentExchanges,
  completeRotation,
  pruneOldExchanges,
  recordServingSession,
  markTooLongForRetirement,
  claimRolledOverSession,
  retirePriorDaySession,
  chatsThatTalkedOn,
  summarizeDay,
  storeDayHandover,
  handoverWrittenFor,
  runDayHandover,
} from "../lib/telegram-rotation.js";

vi.mock("../lib/llm-complete.js", () => ({
  gatewayComplete: vi.fn(async () => "mock continuity summary"),
}));

/** Real, disposable Postgres — the house pattern (tests/reminders.test.ts): a fake
 *  Pool that never executes real SQL is exactly the defect class that has bitten this
 *  project before. */
describe("telegram-rotation", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    pool = quiet(new Pool({ connectionString: container.getConnectionUri() }));
    await pool.query(readFileSync(join(import.meta.dirname, "../../box/sql/001_baseline.sql"), "utf8"));
    // The schema has no default owner on purpose; these fixtures write rows without naming one.
    await pool.query(`
      ALTER TABLE telegram_daily_log ALTER COLUMN principal SET DEFAULT 'fixture-owner';
      ALTER TABLE telegram_session_rotation ALTER COLUMN principal SET DEFAULT 'fixture-owner';
    `);
  }, 120_000);

  afterAll(async () => {
    delete process.env["DATABASE_URL"];
    delete process.env["TELEGRAM_PRINCIPAL_ID"];
    await closePool();
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE telegram_daily_log, telegram_session_rotation");
    vi.clearAllMocks();
  });

  describe("homeDay", () => {
    it("formats a UTC instant as its Europe/Berlin calendar date", () => {
      // 2026-08-16 23:30 UTC is already 2026-08-17 01:30 in Berlin (summer, UTC+2).
      expect(homeDay(new Date("2026-08-16T23:30:00Z"))).toBe("2026-08-17");
    });

    it("stays on the same day for a morning UTC instant", () => {
      expect(homeDay(new Date("2026-08-16T06:00:00Z"))).toBe("2026-08-16");
    });
  });

  describe("dayHasRolledOver", () => {
    it("is false when the tracked day matches today", () => {
      expect(dayHasRolledOver({ homeDay: "2026-08-16", pendingContext: null, handoverDay: null }, "2026-08-16")).toBe(false);
    });

    it("is true once today has moved past the tracked day", () => {
      expect(dayHasRolledOver({ homeDay: "2026-08-16", pendingContext: null, handoverDay: null }, "2026-08-17")).toBe(true);
    });
  });

  describe("getRotationState", () => {
    it("anchors a brand-new chat to today, with no pending context", async () => {
      const state = await getRotationState(pool, "chat1", "2026-08-16");
      expect(state).toEqual({ homeDay: "2026-08-16", pendingContext: null, handoverDay: null });
    });

    it("returns the EXISTING anchor day untouched on a later call the same day", async () => {
      await getRotationState(pool, "chat1", "2026-08-16");
      const state = await getRotationState(pool, "chat1", "2026-08-16");
      expect(state.homeDay).toBe("2026-08-16");
    });

    it("does not itself advance the day even when called after a rollover", async () => {
      await getRotationState(pool, "chat1", "2026-08-16");
      // A later call with a NEW `today` must not silently fast-forward the anchor —
      // only completeRotation may do that, after a summary actually lands.
      const state = await getRotationState(pool, "chat1", "2026-08-17");
      expect(state.homeDay).toBe("2026-08-16");
    });
  });

  describe("consumePendingContext", () => {
    it("returns null when no rotation row exists yet", async () => {
      await expect(consumePendingContext(pool, "chat1")).resolves.toBeNull();
    });

    it("returns null when a row exists but nothing is pending", async () => {
      await getRotationState(pool, "chat1", "2026-08-16");
      await expect(consumePendingContext(pool, "chat1")).resolves.toBeNull();
    });

    it("reads and clears a pending summary — a second call returns null", async () => {
      await getRotationState(pool, "chat1", "2026-08-16");
      await completeRotation(pool, "chat1", "2026-08-17", "carry-forward note");

      await expect(consumePendingContext(pool, "chat1")).resolves.toBe("carry-forward note");
      await expect(consumePendingContext(pool, "chat1")).resolves.toBeNull();
    });
  });

  describe("recordExchange", () => {
    it("logs a non-empty exchange", async () => {
      await recordExchange(pool, "chat1", "user", "hei Assistant");
      const { rows } = await pool.query("SELECT role, body FROM telegram_daily_log WHERE chat_id = 'chat1'");
      expect(rows).toEqual([{ role: "user", body: "hei Assistant" }]);
    });

    it("is a no-op on blank text", async () => {
      await recordExchange(pool, "chat1", "user", "   ");
      const { rows } = await pool.query("SELECT count(*) FROM telegram_daily_log WHERE chat_id = 'chat1'");
      expect(rows[0].count).toBe("0");
    });
  });

  describe("summarizeRecentExchanges", () => {
    it("returns null when the log is empty", async () => {
      await expect(summarizeRecentExchanges(pool, "chat1")).resolves.toBeNull();
    });

    it("summarizes logged exchanges via gatewayComplete", async () => {
      await recordExchange(pool, "chat1", "user", "what's on my calendar today?");
      await recordExchange(pool, "chat1", "assistant", "Nothing until 14:00.");
      await expect(summarizeRecentExchanges(pool, "chat1")).resolves.toBe("mock continuity summary");
    });

    it("returns null (never throws) when the model call fails", async () => {
      const { gatewayComplete } = await import("../lib/llm-complete.js");
      vi.mocked(gatewayComplete).mockRejectedValueOnce(new Error("gateway down"));
      await recordExchange(pool, "chat1", "user", "hei");
      await expect(summarizeRecentExchanges(pool, "chat1")).resolves.toBeNull();
    });
  });

  describe("completeRotation", () => {
    it("advances the anchor day and stores the summary", async () => {
      await getRotationState(pool, "chat1", "2026-08-16");
      await completeRotation(pool, "chat1", "2026-08-17", "note");
      const state = await getRotationState(pool, "chat1", "2026-08-17");
      expect(state.homeDay).toBe("2026-08-17");
    });

    it("clears any prior pending context when the new summary is null", async () => {
      await getRotationState(pool, "chat1", "2026-08-16");
      await completeRotation(pool, "chat1", "2026-08-17", "will be overwritten");
      await completeRotation(pool, "chat1", "2026-08-18", null);
      await expect(consumePendingContext(pool, "chat1")).resolves.toBeNull();
    });
  });

  // ── The day boundary: which conversation served, and retiring it exactly once ───────────
  //
  // The framework's session rename is additive (every address a session ever claimed keeps
  // resolving to it), so the only way to retire the day's conversation is to name its exact
  // durable session id and end it — from a route handler, which is the only place handed
  // `attachSession`. That splits the rotation in two: the turn writes down WHICH session
  // answered, and the front door claims it on the first update of the next day.
  describe("recordServingSession", () => {
    it("writes the session that answered and the day it answered on", async () => {
      await getRotationState(pool, "chat1", "2026-08-16");
      await recordServingSession(pool, "chat1", "2026-08-16", "wrun_fixture_one");

      const { rows } = await pool.query(
        "SELECT session_id, session_day FROM telegram_session_rotation WHERE chat_id = 'chat1'",
      );
      expect(rows).toEqual([{ session_id: "wrun_fixture_one", session_day: "2026-08-16" }]);
    });

    it("replaces the previous session on a later turn — only the live one is ever recorded", async () => {
      await getRotationState(pool, "chat1", "2026-08-16");
      await recordServingSession(pool, "chat1", "2026-08-16", "wrun_fixture_one");
      await recordServingSession(pool, "chat1", "2026-08-16", "wrun_fixture_two");

      const { rows } = await pool.query(
        "SELECT session_id FROM telegram_session_rotation WHERE chat_id = 'chat1'",
      );
      expect(rows[0].session_id).toBe("wrun_fixture_two");
    });
  });

  describe("claimRolledOverSession", () => {
    it("returns nothing when the chat has no rotation row at all", async () => {
      await expect(claimRolledOverSession(pool, "chat1", "2026-08-17")).resolves.toBeNull();
    });

    it("returns nothing on a SAME-day update — the live conversation is not disturbed", async () => {
      await getRotationState(pool, "chat1", "2026-08-16");
      await recordServingSession(pool, "chat1", "2026-08-16", "wrun_fixture_one");

      await expect(claimRolledOverSession(pool, "chat1", "2026-08-16")).resolves.toBeNull();
    });

    it("hands back yesterday's session on the first update of a new day, and only once", async () => {
      await getRotationState(pool, "chat1", "2026-08-16");
      await recordServingSession(pool, "chat1", "2026-08-16", "wrun_fixture_one");

      await expect(claimRolledOverSession(pool, "chat1", "2026-08-17")).resolves.toBe("wrun_fixture_one");
      await expect(claimRolledOverSession(pool, "chat1", "2026-08-17")).resolves.toBeNull();
    });

    it("two updates arriving TOGETHER retire one conversation, not two", async () => {
      await getRotationState(pool, "chat1", "2026-08-16");
      await recordServingSession(pool, "chat1", "2026-08-16", "wrun_fixture_one");

      // The race, made deterministic rather than hoped for. Two real connections: the first
      // claims inside an open transaction and holds the row lock; the second runs while it is
      // held. A read-followed-by-a-write would sail past — a reader is not blocked, and the
      // second connection's snapshot still shows the session — and BOTH would retire, the
      // second retirement landing on the fresh conversation the first update had just opened. The
      // claim being the UPDATE itself is what makes the second one block, re-check the
      // committed row, and find nothing left to claim.
      const first = await pool.connect();
      const second = await pool.connect();
      try {
        await first.query("BEGIN");
        const claimed = await claimRolledOverSession(first as unknown as Pool, "chat1", "2026-08-17");
        const racing = claimRolledOverSession(second as unknown as Pool, "chat1", "2026-08-17");
        await new Promise((resolve) => setTimeout(resolve, 100));
        await first.query("COMMIT");

        expect(claimed).toBe("wrun_fixture_one");
        await expect(racing).resolves.toBeNull();
      } finally {
        first.release();
        second.release();
      }
    });

    it("a box whose telegram_session_rotation lacks the session columns forwards the message anyway, and retires nothing", async () => {
      // The real failure, not a fixture of it: the columns genuinely are not there. A box
      // pulls a new image before the owner applies the migration, and every message that
      // arrives in that window must still reach the agent.
      await pool.query("ALTER TABLE telegram_session_rotation DROP COLUMN session_id, DROP COLUMN session_day");
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const ended: string[] = [];
      try {
        const update = JSON.stringify({ message: { chat: { id: 5550001 } } });
        await expect(
          retirePriorDaySession(update, (id) => ({
            end: async () => { ended.push(id); return {}; },
          }), { db: pool }),
        ).resolves.toBeUndefined();

        expect(ended).toEqual([]);
        expect(logged).toHaveBeenCalledTimes(1);
      } finally {
        logged.mockRestore();
        await pool.query("ALTER TABLE telegram_session_rotation ADD COLUMN session_id text, ADD COLUMN session_day text");
      }
    });

    it("leaves the carry-forward summary alone — retiring is not consuming", async () => {
      await getRotationState(pool, "chat1", "2026-08-16");
      await completeRotation(pool, "chat1", "2026-08-16", "yesterday's notes");
      await recordServingSession(pool, "chat1", "2026-08-16", "wrun_fixture_one");

      await claimRolledOverSession(pool, "chat1", "2026-08-17");

      await expect(consumePendingContext(pool, "chat1")).resolves.toBe("yesterday's notes");
    });
  });

  describe("pruneOldExchanges", () => {
    it("drops rows older than the retention window, keeps recent ones", async () => {
      await pool.query(
        `INSERT INTO telegram_daily_log (chat_id, role, body, created_at)
         VALUES ('chat1','user','ancient', now() - interval '30 days'),
                ('chat1','user','recent', now())`,
      );
      await pruneOldExchanges(pool);
      const { rows } = await pool.query("SELECT body FROM telegram_daily_log WHERE chat_id = 'chat1'");
      expect(rows.map((r) => r.body)).toEqual(["recent"]);
    });
  });

  // The other half of the day boundary, through the real reply handler: the session id
  // is only knowable from inside the turn, so the turn is what writes it down. Driven against
  // the same disposable Postgres, through the channel's own exported handler.
  describe("the reply writes down which conversation served", () => {
    const FIXTURE_CHAT = "5550001";

    beforeEach(() => {
      process.env["DATABASE_URL"] = container.getConnectionUri();
      process.env["TELEGRAM_PRINCIPAL_ID"] = FIXTURE_CHAT;
    });

    it("records the session id and the Berlin day on a reply", async () => {
      const { onContentCompleted } = await import("../agent/channels/telegram.js");
      const posted: unknown[] = [];

      await onContentCompleted(
        { data: { kind: "text", phase: "reply", value: "klart" } },
        {
          channel: {
            state: { chatId: FIXTURE_CHAT, chatType: "private" },
            telegram: { post: async (m: unknown) => { posted.push(m); return {}; } },
          },
          session: { id: "wrun_fixture_today" },
        },
      );

      expect(posted).toHaveLength(1);
      const { rows } = await pool.query(
        "SELECT session_id, session_day FROM telegram_session_rotation WHERE chat_id = $1",
        [FIXTURE_CHAT],
      );
      expect(rows).toEqual([{ session_id: "wrun_fixture_today", session_day: homeDay() }]);
    });

    it("records nothing for a chat outside rotation tracking, and still delivers the reply", async () => {
      const { onContentCompleted } = await import("../agent/channels/telegram.js");
      const posted: unknown[] = [];

      await onContentCompleted(
        { data: { kind: "text", phase: "reply", value: "group reply" } },
        {
          channel: {
            state: { chatId: "5559999", chatType: "group" },
            telegram: { post: async (m: unknown) => { posted.push(m); return {}; } },
          },
          session: { id: "wrun_fixture_group" },
        },
      );

      expect(posted).toHaveLength(1);
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM telegram_session_rotation");
      expect(rows[0].n).toBe(0);
    });
  });

  // ── The overnight hand-over ──────────────────────────────────────────────────────────────
  //
  // Without this job the summary of a day is produced only once a turn of the NEXT day has
  // completed, so the first message of a new day is answered by a fresh session that has not
  // been handed anything. These cover the job that writes it the night before, and the two
  // rules that keep it from colliding with the on-completion path it falls back to.
  describe("homeDayBefore", () => {
    it("steps back one calendar day", () => {
      expect(homeDayBefore("2026-08-17")).toBe("2026-08-16");
    });

    it("crosses a month boundary", () => {
      expect(homeDayBefore("2026-09-01")).toBe("2026-08-31");
    });
  });

  describe("chatsThatTalkedOn", () => {
    it("lists only the chats with exchanges on that Berlin day", async () => {
      await pool.query(
        `INSERT INTO telegram_daily_log (chat_id, role, body, created_at) VALUES
           ('5550001','user','yesterday',      TIMESTAMPTZ '2026-08-16T10:00:00Z'),
           ('5550002','user','the day before', TIMESTAMPTZ '2026-08-15T10:00:00Z')`,
      );
      await expect(chatsThatTalkedOn(pool, "2026-08-16")).resolves.toEqual(["5550001"]);
    });

    it("reads the day in Berlin time, not UTC", async () => {
      // 23:30 UTC on the 16th is already 01:30 on the 17th in Berlin — the same boundary the
      // rotation itself rotates on, so the job must not disagree with it by two hours.
      await pool.query(
        `INSERT INTO telegram_daily_log (chat_id, role, body, created_at) VALUES
           ('5550003','user','late night', TIMESTAMPTZ '2026-08-16T23:30:00Z')`,
      );
      await expect(chatsThatTalkedOn(pool, "2026-08-16")).resolves.toEqual([]);
      await expect(chatsThatTalkedOn(pool, "2026-08-17")).resolves.toEqual(["5550003"]);
    });
  });

  describe("summarizeDay", () => {
    it("shows the model that day's exchanges and no others", async () => {
      await pool.query(
        `INSERT INTO telegram_daily_log (chat_id, role, body, created_at) VALUES
           ('5550001','user','an older thread', TIMESTAMPTZ '2026-08-15T10:00:00Z'),
           ('5550001','user','the day being closed', TIMESTAMPTZ '2026-08-16T10:00:00Z')`,
      );
      const { gatewayComplete } = await import("../lib/llm-complete.js");

      await expect(summarizeDay(pool, "5550001", "2026-08-16")).resolves.toBe("mock continuity summary");

      const prompt = vi.mocked(gatewayComplete).mock.calls[0]![0] as string;
      expect(prompt).toContain("the day being closed");
      expect(prompt).not.toContain("an older thread");
    });
  });

  describe("runDayHandover — the overnight job", () => {
    const TALKED = "5550001";
    const SILENT = "5550002";
    const YESTERDAY = "2026-08-16";

    async function talkedYesterday(chatId: string): Promise<void> {
      await pool.query(
        `INSERT INTO telegram_daily_log (chat_id, role, body, created_at) VALUES
           ($1,'user','what is still open?',    TIMESTAMPTZ '2026-08-16T09:00:00Z'),
           ($1,'assistant','two things, both waiting on you.', TIMESTAMPTZ '2026-08-16T09:01:00Z')`,
        [chatId],
      );
      await getRotationState(pool, chatId, YESTERDAY);
    }

    it("writes yesterday's summary for a chat that talked, and nothing for one that did not", async () => {
      await talkedYesterday(TALKED);
      await getRotationState(pool, SILENT, YESTERDAY);

      const run = await runDayHandover(pool, YESTERDAY);

      expect(run).toEqual({ day: YESTERDAY, chats: 1, written: 1, skipped: 0, failed: 0 });
      const { rows } = await pool.query(
        "SELECT chat_id, pending_context, handover_day FROM telegram_session_rotation ORDER BY chat_id",
      );
      expect(rows).toEqual([
        { chat_id: TALKED, pending_context: "mock continuity summary", handover_day: YESTERDAY },
        { chat_id: SILENT, pending_context: null, handover_day: null },
      ]);
    });

    it("makes NO model call for a chat with an empty day", async () => {
      const { gatewayComplete } = await import("../lib/llm-complete.js");
      await getRotationState(pool, SILENT, YESTERDAY);

      const run = await runDayHandover(pool, YESTERDAY);

      expect(run.chats).toBe(0);
      expect(vi.mocked(gatewayComplete)).not.toHaveBeenCalled();
    });

    it("run twice, written once — and the model is asked once", async () => {
      const { gatewayComplete } = await import("../lib/llm-complete.js");
      await talkedYesterday(TALKED);

      await runDayHandover(pool, YESTERDAY);
      const second = await runDayHandover(pool, YESTERDAY);

      expect(second).toEqual({ day: YESTERDAY, chats: 1, written: 0, skipped: 1, failed: 0 });
      expect(vi.mocked(gatewayComplete)).toHaveBeenCalledTimes(1);
    });

    it("a gateway failure costs one log line and leaves the fallback intact", async () => {
      const { gatewayComplete } = await import("../lib/llm-complete.js");
      vi.mocked(gatewayComplete).mockRejectedValueOnce(new Error("gateway down"));
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      await talkedYesterday(TALKED);
      try {
        const run = await runDayHandover(pool, YESTERDAY);
        expect(run).toEqual({ day: YESTERDAY, chats: 1, written: 0, skipped: 0, failed: 1 });
        expect(logged).toHaveBeenCalledTimes(1);
      } finally {
        logged.mockRestore();
      }

      // Nothing was stamped, so the day is still the on-completion path's to close.
      await expect(handoverWrittenFor(pool, TALKED, YESTERDAY)).resolves.toBe(false);
      await expect(consumePendingContext(pool, TALKED)).resolves.toBeNull();
    });

    it("the first message of the new day is served WITH yesterday's summary", async () => {
      process.env["DATABASE_URL"] = container.getConnectionUri();
      const { buildRotationContext } = await import("../agent/channels/telegram.js");
      await talkedYesterday(TALKED);
      await runDayHandover(pool, YESTERDAY);

      // The pick-up path, exactly as onMessage runs it on the first inbound of the new day.
      const context = buildRotationContext(await consumePendingContext(pool, TALKED));

      expect(context?.[0]).toContain("mock continuity summary");
      // Consumed once: the message after it is in the same fresh session and needs no repeat.
      await expect(consumePendingContext(pool, TALKED)).resolves.toBeNull();
    });
  });

  describe("the job and the on-completion path never write two summaries for one day", () => {
    const FIXTURE_CHAT = "5550001";

    beforeEach(() => {
      process.env["DATABASE_URL"] = container.getConnectionUri();
      process.env["TELEGRAM_PRINCIPAL_ID"] = FIXTURE_CHAT;
    });

    async function completeATurn(message: string): Promise<void> {
      const { onContentCompleted } = await import("../agent/channels/telegram.js");
      await onContentCompleted(
        { data: { kind: "text", phase: "reply", value: message } },
        {
          channel: {
            state: { chatId: FIXTURE_CHAT, chatType: "private" },
            telegram: { post: async () => ({}) },
          },
          session: { id: "wrun_fixture_today" },
        },
      );
    }

    it("when the job never ran, behaviour is exactly today's — the turn writes the summary", async () => {
      const yesterday = homeDayBefore(homeDay());
      await getRotationState(pool, FIXTURE_CHAT, yesterday);
      await recordExchange(pool, FIXTURE_CHAT, "user", "yesterday's question");

      await completeATurn("i dag er det roligere");

      const { gatewayComplete } = await import("../lib/llm-complete.js");
      expect(vi.mocked(gatewayComplete)).toHaveBeenCalledTimes(1);
      // Waiting for the NEXT message — the day-2 behaviour, unchanged.
      await expect(consumePendingContext(pool, FIXTURE_CHAT)).resolves.toBe("mock continuity summary");
    });

    it("does not overwrite the summary the job already wrote for that day", async () => {
      const yesterday = homeDayBefore(homeDay());
      await getRotationState(pool, FIXTURE_CHAT, yesterday);
      await recordExchange(pool, FIXTURE_CHAT, "user", "yesterday's question");
      await storeDayHandover(pool, FIXTURE_CHAT, yesterday, "the overnight hand-over");
      // The first message of the new day consumed it; the turn that answers it must not
      // produce a second summary of the same day for the message after that.
      await consumePendingContext(pool, FIXTURE_CHAT);

      await completeATurn("svar");

      const { gatewayComplete } = await import("../lib/llm-complete.js");
      expect(vi.mocked(gatewayComplete)).not.toHaveBeenCalled();
      const { rows } = await pool.query(
        "SELECT local_day, pending_context, handover_day FROM telegram_session_rotation WHERE chat_id = $1",
        [FIXTURE_CHAT],
      );
      expect(rows[0]).toEqual({ local_day: homeDay(), pending_context: null, handover_day: yesterday });
    });
  });

  // ── A conversation that has grown too long ───────────────────────────────────────────────
  //
  // eve's summary of a long conversation is refused on purpose, so the turn fails and every later
  // turn in that conversation would too. A Telegram private chat cannot be started over by hand,
  // so the failed conversation is marked and the person's NEXT message retires it at the front
  // door, the day boundary's own path. Nothing is summarised, so no model call is made anywhere.
  describe("a conversation that has grown too long starts over at the next message", () => {
    const FIXTURE_CHAT = "5550001";
    const TOO_LONG = "This conversation has grown too long for me to continue, so your next message will start a new one. Please send your last message again.";
    const message = JSON.stringify({ update_id: 1, message: { message_id: 7, chat: { id: Number(FIXTURE_CHAT), type: "private" }, text: "hei" } });
    const tap = JSON.stringify({ update_id: 2, callback_query: { id: "q1", message: { chat: { id: Number(FIXTURE_CHAT) } }, data: "eve:0" } });
    const tooLongTurn = (text = MODEL_COMPACTION_REFUSED) => ({ data: { outcome: "failed", error: { code: "MODEL_CALL_FAILED", message: text, id: "err_fixture" } } });

    const TOO_LONG_SCHEDULED = "This conversation has grown too long for me to continue, so your next message will start a new one. A scheduled update was not delivered.";
    const PARTLY_DONE = "Part of what you asked may already have been done, so check before asking again.";
    /** eve's own schedule identity (`dist/src/channel/schedule-auth.js`), as a brief's turn carries it. */
    const SCHEDULE_AUTH = { attributes: { lane: "morning-brief" }, authenticator: "app", principalId: "eve:app", principalType: "runtime" };
    const PERSON_AUTH = { attributes: { user_id: Number(FIXTURE_CHAT) }, authenticator: "telegram-webhook", principalId: FIXTURE_CHAT, principalType: "user" };

    function fakeChat(sessionId: string, chatType = "private", extra: { scheduled?: boolean; view?: unknown } = {}) {
      const posted: unknown[] = [];
      return {
        posted,
        ctx: {
          channel: {
            state: { chatId: FIXTURE_CHAT, chatType },
            telegram: { post: async (m: unknown) => { posted.push(m); return {}; } },
          },
          session: { id: sessionId, auth: { current: extra.scheduled ? SCHEDULE_AUTH : PERSON_AUTH } },
          ...(extra.view === undefined ? {} : { view: extra.view as never }),
        },
      };
    }
    function fakeAttach() {
      const ended: string[] = [];
      const reasons: (string | undefined)[] = [];
      return { ended, reasons, attach: (id: string) => ({ end: async (options?: { reason?: string }) => { ended.push(id); reasons.push(options?.reason); return {}; } }) };
    }
    /** A turn that completed one tool call, folded by eve's own fold with a channel observer's retention. */
    async function viewWithCall(turnId: string) {
      const projection = (file: string) => new URL(`../node_modules/eve/dist/src/protocol/session-projection/${file}`, import.meta.url).href;
      const { emptySessionView, foldEvents } = await import(projection("fold.js")) as { emptySessionView(): object; foldEvents(v: object, e: unknown[], o: object): unknown };
      const { snapshotOf } = await import(projection("session-view.js")) as { snapshotOf(v: object): unknown };
      const at = "2026-11-12T10:00:00.000Z";
      let line = 0;
      const fact = (type: string, data: Record<string, unknown>) => ({ type, scope: { turnId }, data, meta: { position: { line: line++, index: 0 }, at, endOfLine: true } });
      const tables = emptySessionView();
      foldEvents(tables, [
        fact("turn.started", { turnId, cause: { deliveryId: "d1" }, follows: null }),
        fact("call.requested", { callId: "call-1", owner: { turnId }, capability: { kind: "tool", name: "gmail_send" }, input: {} }),
        fact("call.started", { callId: "call-1" }),
        fact("call.settled", { callId: "call-1", outcome: "completed" }),
      ], { retention: "operational" });
      return snapshotOf(tables);
    }
    const row = async () => (await pool.query(
      "SELECT session_id, session_day, local_day, pending_context FROM telegram_session_rotation WHERE chat_id = $1",
      [FIXTURE_CHAT],
    )).rows[0];

    beforeEach(() => {
      process.env["DATABASE_URL"] = container.getConnectionUri();
      process.env["TELEGRAM_PRINCIPAL_ID"] = FIXTURE_CHAT;
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    it("a marked conversation is claimed on the SAME day, exactly once, and the anchor day and hand-over are left alone", async () => {
      await getRotationState(pool, FIXTURE_CHAT, homeDay());
      await completeRotation(pool, FIXTURE_CHAT, homeDay(), "waiting notes");
      await markTooLongForRetirement(pool, FIXTURE_CHAT, homeDay(), "wrun_long");

      await expect(claimRolledOverSession(pool, FIXTURE_CHAT, homeDay())).resolves.toBe("wrun_long");
      await expect(claimRolledOverSession(pool, FIXTURE_CHAT, homeDay())).resolves.toBeNull();
      expect(await row()).toEqual({ session_id: null, session_day: null, local_day: homeDay(), pending_context: "waiting notes" });
    });

    it("marking says whether THIS call marked the conversation, so a repeat can stay quiet", async () => {
      // No row yet, then a row for another conversation, then the same conversation again.
      await expect(markTooLongForRetirement(pool, FIXTURE_CHAT, homeDay(), "wrun_long")).resolves.toBe(true);
      await expect(markTooLongForRetirement(pool, FIXTURE_CHAT, homeDay(), "wrun_long")).resolves.toBe(false);
      await recordServingSession(pool, FIXTURE_CHAT, homeDay(), "wrun_other");
      await claimRolledOverSession(pool, FIXTURE_CHAT, homeDay());
      await recordServingSession(pool, FIXTURE_CHAT, homeDay(), "wrun_next");
      await expect(markTooLongForRetirement(pool, FIXTURE_CHAT, homeDay(), "wrun_next")).resolves.toBe(true);
      await expect(markTooLongForRetirement(pool, FIXTURE_CHAT, homeDay(), "wrun_next")).resolves.toBe(false);
    });

    it("a scheduled turn says a scheduled update was not delivered, never 'send your last message again', and only once per marked conversation", async () => {
      const { onTurnSettled } = await import("../agent/channels/telegram.js");
      const { gatewayComplete } = await import("../lib/llm-complete.js");
      await getRotationState(pool, FIXTURE_CHAT, homeDay());
      const logged = vi.mocked(console.warn);

      const brief = fakeChat("wrun_long", "private", { scheduled: true });
      await onTurnSettled(tooLongTurn(), brief.ctx);
      expect(brief.posted).toEqual([TOO_LONG_SCHEDULED]);
      expect(await row()).toMatchObject({ session_id: "wrun_long", session_day: null });

      // The next pushes that morning fail in the same marked conversation: nothing more is posted.
      logged.mockClear();
      for (let i = 0; i < 3; i++) {
        const push = fakeChat("wrun_long", "private", { scheduled: true });
        await onTurnSettled(tooLongTurn(), push.ctx);
        expect(push.posted).toEqual([]);
      }
      expect(logged.mock.calls.some((c) => String(c[0]).includes("already marked too long"))).toBe(true);

      // Only the person's message retires it, as before, and the retirement says why.
      const { ended, reasons, attach } = fakeAttach();
      await retirePriorDaySession(tap, attach, { db: pool });
      expect(ended).toEqual([]);
      await retirePriorDaySession(message, attach, { db: pool });
      expect(ended).toEqual(["wrun_long"]);
      expect(reasons[0]).toMatch(/grew too long/);
      expect(vi.mocked(gatewayComplete)).not.toHaveBeenCalled();
    });

    it("a scheduled turn in a conversation the person was already told about posts nothing", async () => {
      const { onTurnSettled } = await import("../agent/channels/telegram.js");
      await getRotationState(pool, FIXTURE_CHAT, homeDay());
      const person = fakeChat("wrun_long");
      await onTurnSettled(tooLongTurn(), person.ctx);
      const push = fakeChat("wrun_long", "private", { scheduled: true });
      await onTurnSettled(tooLongTurn(), push.ctx);

      expect(person.posted).toEqual([TOO_LONG]);
      expect(push.posted).toEqual([]);
    });

    it("after a turn that already completed a call, the person is told that part may be done; a scheduled turn is not", async () => {
      const { onTurnSettled } = await import("../agent/channels/telegram.js");
      await getRotationState(pool, FIXTURE_CHAT, homeDay());
      const failed = { data: { turnId: "turn_4", outcome: "failed", error: { code: "MODEL_CALL_FAILED", message: MODEL_COMPACTION_REFUSED } } };

      const person = fakeChat("wrun_long", "private", { view: await viewWithCall("turn_4") });
      await onTurnSettled(failed, person.ctx);
      expect(person.posted).toEqual([`${TOO_LONG} ${PARTLY_DONE}`]);

      await claimRolledOverSession(pool, FIXTURE_CHAT, homeDay());
      const brief = fakeChat("wrun_brief", "private", { scheduled: true, view: await viewWithCall("turn_4") });
      await onTurnSettled(failed, brief.ctx);
      expect(brief.posted).toEqual([TOO_LONG_SCHEDULED]);
    });

    it("the guard's degraded refusal is not 'too long': today's text on every turn, and nothing is marked", async () => {
      const { onTurnSettled } = await import("../agent/channels/telegram.js");
      await getRotationState(pool, FIXTURE_CHAT, homeDay());
      await recordServingSession(pool, FIXTURE_CHAT, homeDay(), "wrun_live");
      for (const [text, scheduled] of [[MODEL_CALLS_REFUSED_UNSCOPED, false], [`Hook "context.started" failed: ${MODEL_CALLS_REFUSED_UNSCOPED}`, true]] as const) {
        const chat = fakeChat("wrun_live", "private", { scheduled });
        await onTurnSettled(tooLongTurn(text), chat.ctx);
        expect(chat.posted).toHaveLength(1);
        expect(chat.posted[0]).toMatch(/^I hit an error while handling your request/);
      }
      expect(await row()).toMatchObject({ session_id: "wrun_live", session_day: homeDay() });
      const { ended, attach } = fakeAttach();
      await retirePriorDaySession(message, attach, { db: pool });
      expect(ended).toEqual([]);
    });

    it("says the one sentence, once, and the next MESSAGE retires exactly that conversation, once", async () => {
      const { onTurnSettled } = await import("../agent/channels/telegram.js");
      await getRotationState(pool, FIXTURE_CHAT, homeDay());
      await recordServingSession(pool, FIXTURE_CHAT, homeDay(), "wrun_long");
      const chat = fakeChat("wrun_long");

      await onTurnSettled(tooLongTurn(), chat.ctx);

      expect(chat.posted).toEqual([TOO_LONG]);
      expect(await row()).toMatchObject({ session_id: "wrun_long", session_day: null });

      // A tap answers the live conversation and never retires it.
      const { ended, attach } = fakeAttach();
      await retirePriorDaySession(tap, attach, { db: pool });
      expect(ended).toEqual([]);

      // The next message, the same day, retires it before it is forwarded, so it opens a new one.
      await retirePriorDaySession(message, attach, { db: pool });
      expect(ended).toEqual(["wrun_long"]);
      // And only once: the message after that lands in the new conversation, untouched.
      await retirePriorDaySession(message, attach, { db: pool });
      expect(ended).toEqual(["wrun_long"]);
    });

    it("the new conversation is not handed anything from the old one, and no model call is made", async () => {
      const { onTurnSettled, onContentCompleted } = await import("../agent/channels/telegram.js");
      const { gatewayComplete } = await import("../lib/llm-complete.js");
      await getRotationState(pool, FIXTURE_CHAT, homeDay());
      await recordExchange(pool, FIXTURE_CHAT, "user", "a long day of work");
      await recordServingSession(pool, FIXTURE_CHAT, homeDay(), "wrun_long");

      await onTurnSettled(tooLongTurn(), fakeChat("wrun_long").ctx);
      await retirePriorDaySession(message, fakeAttach().attach, { db: pool });
      // The new conversation's first reply: the rotation sees no day boundary, so it summarises
      // nothing and leaves nothing waiting.
      await onContentCompleted({ data: { kind: "text", phase: "reply", value: "ny samtale" } }, fakeChat("wrun_fresh").ctx);

      expect(vi.mocked(gatewayComplete)).not.toHaveBeenCalled();
      expect(await row()).toEqual({ session_id: "wrun_fresh", session_day: homeDay(), local_day: homeDay(), pending_context: null });
    });

    it("cannot loop: a new conversation whose first turn is also too long is told once and retired at most once per message", async () => {
      const { onTurnSettled } = await import("../agent/channels/telegram.js");
      const { gatewayComplete } = await import("../lib/llm-complete.js");
      const { ended, attach } = fakeAttach();
      await getRotationState(pool, FIXTURE_CHAT, homeDay());

      const first = fakeChat("wrun_first");
      await onTurnSettled(tooLongTurn(), first.ctx);
      await retirePriorDaySession(message, attach, { db: pool });
      // The new conversation's very first turn grows too long as well.
      const second = fakeChat("wrun_second");
      await onTurnSettled(tooLongTurn(`context.started failed: ${MODEL_COMPACTION_REFUSED}`), second.ctx);

      expect(first.posted).toEqual([TOO_LONG]);
      expect(second.posted).toEqual([TOO_LONG]);
      // Nothing retires until the person sends another message, however often the door is asked.
      for (let i = 0; i < 3; i++) await retirePriorDaySession(tap, attach, { db: pool });
      expect(ended).toEqual(["wrun_first"]);
      await retirePriorDaySession(message, attach, { db: pool });
      await retirePriorDaySession(message, attach, { db: pool });
      expect(ended).toEqual(["wrun_first", "wrun_second"]);
      expect(vi.mocked(gatewayComplete)).not.toHaveBeenCalled();
    });

    it("a reply from another conversation in the chat meanwhile does not cancel the retirement", async () => {
      const { onTurnSettled, onContentCompleted } = await import("../agent/channels/telegram.js");
      const { ended, attach } = fakeAttach();
      await getRotationState(pool, FIXTURE_CHAT, homeDay());
      await onTurnSettled(tooLongTurn(), fakeChat("wrun_long").ctx);

      await onContentCompleted({ data: { kind: "text", phase: "reply", value: "a scheduled note" } }, fakeChat("wrun_scheduled").ctx);
      expect(await row()).toMatchObject({ session_id: "wrun_long", session_day: null });

      await retirePriorDaySession(message, attach, { db: pool });
      expect(ended).toEqual(["wrun_long"]);
      // Once claimed, the next reply is recorded exactly as before.
      await recordServingSession(pool, FIXTURE_CHAT, homeDay(), "wrun_fresh");
      expect(await row()).toMatchObject({ session_id: "wrun_fresh", session_day: homeDay() });
    });

    it("a chat that has no rotation row yet (a first turn that failed before any reply) is marked too", async () => {
      const { onTurnSettled } = await import("../agent/channels/telegram.js");
      const chat = fakeChat("wrun_first_ever");
      await onTurnSettled(tooLongTurn(), chat.ctx);

      expect(chat.posted).toEqual([TOO_LONG]);
      expect(await row()).toEqual({ session_id: "wrun_first_ever", session_day: null, local_day: homeDay(), pending_context: null });
    });

    it("only this cause: any other failure keeps today's text and marks nothing", async () => {
      const { onTurnSettled } = await import("../agent/channels/telegram.js");
      await getRotationState(pool, FIXTURE_CHAT, homeDay());
      await recordServingSession(pool, FIXTURE_CHAT, homeDay(), "wrun_live");
      for (const text of ["Model provider API request failed (HTTP 400).", `${MODEL_COMPACTION_REFUSED}, and more`]) {
        const chat = fakeChat("wrun_live");
        await onTurnSettled(tooLongTurn(text), chat.ctx);
        expect(chat.posted).toHaveLength(1);
        expect(chat.posted[0]).toMatch(/^I hit an error while handling your request/);
      }
      expect(await row()).toMatchObject({ session_id: "wrun_live", session_day: homeDay() });
    });

    it("outside the allowed private chat the sentence would not be true, so the ordinary text is posted and nothing is marked", async () => {
      const { onTurnSettled } = await import("../agent/channels/telegram.js");
      const chat = fakeChat("wrun_group", "group");
      await onTurnSettled(tooLongTurn(), chat.ctx);

      expect(chat.posted).toHaveLength(1);
      expect(chat.posted[0]).toMatch(/^I hit an error while handling your request/);
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM telegram_session_rotation");
      expect(rows[0].n).toBe(0);
    });
  });
});
