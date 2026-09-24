import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { closePool } from "@lares/agent-kit/db";

import {
  osloDay,
  osloDayBefore,
  dayHasRolledOver,
  getRotationState,
  consumePendingContext,
  recordExchange,
  summarizeRecentExchanges,
  completeRotation,
  pruneOldExchanges,
  recordServingSession,
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

/** Real, disposable Postgres — the house pattern (tests/db.test.ts, ORB-45 lesson): a fake
 *  Pool that never executes real SQL is exactly the defect class that has bitten this
 *  project before. */
describe("telegram-rotation", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const migration = readFileSync(
      join(import.meta.dirname, "../../box/sql/020_telegram_session_rotation.sql"), "utf8",
    );
    await pool.query(migration);
    // 023_schema_principal_scoping.sql retrofits `principal` onto these tables (the schema
    // guard, tests/schema-principal.test.ts, caught them missing it) — the two ALTERs that
    // apply to THIS migration's tables, applied inline since 023 also touches
    // outreach_threads, which doesn't exist in this test's schema.
    await pool.query(`
      ALTER TABLE telegram_daily_log ADD COLUMN principal text NOT NULL DEFAULT 'bendik';
      ALTER TABLE telegram_session_rotation ADD COLUMN principal text NOT NULL DEFAULT 'bendik';
    `);
    // 078 adds the two columns the day boundary needs: which durable session served this chat,
    // and the Oslo day it served on.
    await pool.query(
      readFileSync(join(import.meta.dirname, "../../box/sql/078_telegram_day_handover.sql"), "utf8"),
    );
    // 081 adds the column that says which day's hand-over summary has already been written, so
    // the overnight job and the on-completion fallback can never write two for the same day.
    await pool.query(
      readFileSync(join(import.meta.dirname, "../../box/sql/081_telegram_handover_written.sql"), "utf8"),
    );
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

  describe("osloDay", () => {
    it("formats a UTC instant as its Europe/Oslo calendar date", () => {
      // 2026-08-16 23:30 UTC is already 2026-08-17 01:30 in Oslo (summer, UTC+2).
      expect(osloDay(new Date("2026-08-16T23:30:00Z"))).toBe("2026-08-17");
    });

    it("stays on the same day for a morning UTC instant", () => {
      expect(osloDay(new Date("2026-08-16T06:00:00Z"))).toBe("2026-08-16");
    });
  });

  describe("dayHasRolledOver", () => {
    it("is false when the tracked day matches today", () => {
      expect(dayHasRolledOver({ osloDay: "2026-08-16", pendingContext: null }, "2026-08-16")).toBe(false);
    });

    it("is true once today has moved past the tracked day", () => {
      expect(dayHasRolledOver({ osloDay: "2026-08-16", pendingContext: null }, "2026-08-17")).toBe(true);
    });
  });

  describe("getRotationState", () => {
    it("anchors a brand-new chat to today, with no pending context", async () => {
      const state = await getRotationState(pool, "chat1", "2026-08-16");
      expect(state).toEqual({ osloDay: "2026-08-16", pendingContext: null, handoverDay: null });
    });

    it("returns the EXISTING anchor day untouched on a later call the same day", async () => {
      await getRotationState(pool, "chat1", "2026-08-16");
      const state = await getRotationState(pool, "chat1", "2026-08-16");
      expect(state.osloDay).toBe("2026-08-16");
    });

    it("does not itself advance the day even when called after a rollover", async () => {
      await getRotationState(pool, "chat1", "2026-08-16");
      // A later call with a NEW `today` must not silently fast-forward the anchor —
      // only completeRotation may do that, after a summary actually lands.
      const state = await getRotationState(pool, "chat1", "2026-08-17");
      expect(state.osloDay).toBe("2026-08-16");
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
      await recordExchange(pool, "chat1", "user", "hei Saga");
      const { rows } = await pool.query("SELECT role, body FROM telegram_daily_log WHERE chat_id = 'chat1'");
      expect(rows).toEqual([{ role: "user", body: "hei Saga" }]);
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
      expect(state.osloDay).toBe("2026-08-17");
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
  // durable session id and reset it — from a route handler, which is the only place handed
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
      // second reset landing on the fresh conversation the first update had just opened. The
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

    it("a box that has not applied 078 yet forwards the message anyway, and retires nothing", async () => {
      // The real failure, not a fixture of it: the columns genuinely are not there. A box
      // pulls a new image before the owner applies the migration, and every message that
      // arrives in that window must still reach the agent.
      await pool.query("ALTER TABLE telegram_session_rotation DROP COLUMN session_id, DROP COLUMN session_day");
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const resets: string[] = [];
      try {
        const update = JSON.stringify({ message: { chat: { id: 5550001 } } });
        await expect(
          retirePriorDaySession(update, (id) => ({
            reset: async () => { resets.push(id); return {}; },
          }), { db: pool }),
        ).resolves.toBeUndefined();

        expect(resets).toEqual([]);
        expect(logged).toHaveBeenCalledTimes(1);
      } finally {
        logged.mockRestore();
        await pool.query(
          readFileSync(join(import.meta.dirname, "../../box/sql/078_telegram_day_handover.sql"), "utf8"),
        );
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

  // The other half of the day boundary, through the real terminal-reply handler: the session id
  // is only knowable from inside the turn, so the turn is what writes it down. Driven against
  // the same disposable Postgres, through the channel's own exported handler.
  describe("the terminal reply writes down which conversation served", () => {
    const FIXTURE_CHAT = "5550001";

    beforeEach(() => {
      process.env["DATABASE_URL"] = container.getConnectionUri();
      process.env["TELEGRAM_PRINCIPAL_ID"] = FIXTURE_CHAT;
    });

    it("records the session id and the Oslo day on a terminal reply", async () => {
      const { onMessageCompleted } = await import("../agent/channels/telegram.js");
      const posted: unknown[] = [];

      await onMessageCompleted(
        { finishReason: "stop", message: "klart" },
        {
          state: { chatId: FIXTURE_CHAT, chatType: "private" },
          telegram: { post: async (m: unknown) => { posted.push(m); } },
        },
        { session: { id: "wrun_fixture_today" } },
      );

      expect(posted).toHaveLength(1);
      const { rows } = await pool.query(
        "SELECT session_id, session_day FROM telegram_session_rotation WHERE chat_id = $1",
        [FIXTURE_CHAT],
      );
      expect(rows).toEqual([{ session_id: "wrun_fixture_today", session_day: osloDay() }]);
    });

    it("records nothing for a chat outside rotation tracking, and still delivers the reply", async () => {
      const { onMessageCompleted } = await import("../agent/channels/telegram.js");
      const posted: unknown[] = [];

      await onMessageCompleted(
        { finishReason: "stop", message: "group reply" },
        {
          state: { chatId: "5559999", chatType: "group" },
          telegram: { post: async (m: unknown) => { posted.push(m); } },
        },
        { session: { id: "wrun_fixture_group" } },
      );

      expect(posted).toHaveLength(1);
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM telegram_session_rotation");
      expect(rows[0].n).toBe(0);
    });
  });

  // ── The overnight hand-over ──────────────────────────────────────────────────────────────
  //
  // W2-s3c left the summary of a day being produced only once a turn of the NEXT day had
  // completed, so the first message of a new day was answered by a fresh session that had not
  // been handed anything. These cover the job that writes it the night before, and the two
  // rules that keep it from colliding with the on-completion path it falls back to.
  describe("osloDayBefore", () => {
    it("steps back one calendar day", () => {
      expect(osloDayBefore("2026-08-17")).toBe("2026-08-16");
    });

    it("crosses a month boundary", () => {
      expect(osloDayBefore("2026-09-01")).toBe("2026-08-31");
    });
  });

  describe("chatsThatTalkedOn", () => {
    it("lists only the chats with exchanges on that Oslo day", async () => {
      await pool.query(
        `INSERT INTO telegram_daily_log (chat_id, role, body, created_at) VALUES
           ('5550001','user','yesterday',      TIMESTAMPTZ '2026-08-16T10:00:00Z'),
           ('5550002','user','the day before', TIMESTAMPTZ '2026-08-15T10:00:00Z')`,
      );
      await expect(chatsThatTalkedOn(pool, "2026-08-16")).resolves.toEqual(["5550001"]);
    });

    it("reads the day in Oslo time, not UTC", async () => {
      // 23:30 UTC on the 16th is already 01:30 on the 17th in Oslo — the same boundary the
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
      const { onMessageCompleted } = await import("../agent/channels/telegram.js");
      await onMessageCompleted(
        { finishReason: "stop", message },
        {
          state: { chatId: FIXTURE_CHAT, chatType: "private" },
          telegram: { post: async () => {} },
        },
        { session: { id: "wrun_fixture_today" } },
      );
    }

    it("when the job never ran, behaviour is exactly today's — the turn writes the summary", async () => {
      const yesterday = osloDayBefore(osloDay());
      await getRotationState(pool, FIXTURE_CHAT, yesterday);
      await recordExchange(pool, FIXTURE_CHAT, "user", "yesterday's question");

      await completeATurn("i dag er det roligere");

      const { gatewayComplete } = await import("../lib/llm-complete.js");
      expect(vi.mocked(gatewayComplete)).toHaveBeenCalledTimes(1);
      // Waiting for the NEXT message — the day-2 behaviour W2-s3c left behind, unchanged.
      await expect(consumePendingContext(pool, FIXTURE_CHAT)).resolves.toBe("mock continuity summary");
    });

    it("does not overwrite the summary the job already wrote for that day", async () => {
      const yesterday = osloDayBefore(osloDay());
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
        "SELECT oslo_day, pending_context, handover_day FROM telegram_session_rotation WHERE chat_id = $1",
        [FIXTURE_CHAT],
      );
      expect(rows[0]).toEqual({ oslo_day: osloDay(), pending_context: null, handover_day: yesterday });
    });
  });
});
