import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

import { getPool, closePool } from "@lares/agent-kit/db";
import { configuredOwnerId } from "../lib/identity-client.js";
import {
  createReminder,
  dueReminders,
  markDelivered,
  listPending,
  cancelReminder,
} from "../lib/reminders-store.js";
import { nextOccurrence } from "../lib/recurrence.js";
import {
  makeReminderTick,
  type ReminderDoor,
  type ReminderTickStore,
} from "../agent/schedules/reminders.js";
import type { DueReminder } from "../lib/reminders-store.js";

/**
 * Task 10 — reminders: store, gated set/cancel, delivery schedule.
 *
 * Three layers, per the brief's Step 1 (schedule-gate.ts's own coverage now lives with the
 * module in @lares/agent-kit, ORB-142):
 *   1. lib/reminders-store.ts round-trips against a REAL Postgres (testcontainer, ORB-45
 *      pattern) — the table it reads/writes already exists on the box's shared `lares_state`
 *      database (services/box/sql/001_init.sql), replicated here for the disposable
 *      test instance.
 *   2. lib/recurrence.ts's nextOccurrence, spot-checked against the ported reference cases.
 *   3. agent/schedules/reminders.ts's makeReminderTick — the delivery algorithm itself,
 *      entirely offline via fake store/doors, proving: due-only delivery, pinned-door
 *      routing, the GENERIC (not email-specific) fallback re-route, re-arm-before-
 *      markDelivered call ORDER, and one failure not aborting the tick.
 */

// ─── 1. lib/reminders-store.ts — real Postgres round-trip ─────────────────────────────────

describe("reminders-store", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const pool = getPool({ DATABASE_URL: container.getConnectionUri() } as NodeJS.ProcessEnv);
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await pool.query(`
      CREATE TABLE reminders (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        agent        text        NOT NULL,
        owner        text        NOT NULL DEFAULT 'bendik',
        due_at       timestamptz NOT NULL,
        recurrence   text,
        payload      jsonb       NOT NULL,
        status       text        NOT NULL DEFAULT 'pending',
        delivered_at timestamptz,
        created_at   timestamptz NOT NULL DEFAULT now(),
        created_by   text        NOT NULL,
        CONSTRAINT reminders_status_ck
          CHECK (status IN ('pending','delivered','cancelled','failed'))
      )
    `);
  }, 120_000);

  afterAll(async () => {
    await closePool();
    await container.stop();
  });

  afterEach(async () => {
    await getPool().query(`DELETE FROM reminders`);
  });

  it("creates a reminder defaulting owner to the canonical user id", async () => {
    const pool = getPool();
    const r = await createReminder(pool, {
      agent: "saga",
      dueAt: new Date("2026-09-01T09:00:00Z"),
      payload: { text: "Call the accountant", door: "telegram", threadRef: "tg-1" },
      createdBy: "user",
    });
    expect(r.owner).toBe(configuredOwnerId());
    expect(r.owner).toBe("bendik");
    expect(r.status).toBe("pending");

    const { rows } = await pool.query("SELECT owner, agent, payload FROM reminders WHERE id = $1", [r.id]);
    expect(rows[0].owner).toBe("bendik");
    expect(rows[0].agent).toBe("saga");
    expect(rows[0].payload).toEqual({ text: "Call the accountant", door: "telegram", threadRef: "tg-1" });
  });

  it("dueReminders returns only pending rows with due_at <= now, ordered soonest first", async () => {
    const pool = getPool();
    const now = new Date("2026-09-01T12:00:00Z");
    const past = await createReminder(pool, {
      agent: "saga",
      dueAt: new Date("2026-09-01T11:00:00Z"),
      payload: { text: "past", door: "slack", threadRef: "s-1" },
      createdBy: "user",
    });
    const earlier = await createReminder(pool, {
      agent: "saga",
      dueAt: new Date("2026-09-01T10:00:00Z"),
      payload: { text: "earlier", door: "slack", threadRef: "s-1" },
      createdBy: "user",
    });
    const future = await createReminder(pool, {
      agent: "saga",
      dueAt: new Date("2026-09-01T13:00:00Z"),
      payload: { text: "future", door: "slack", threadRef: "s-1" },
      createdBy: "user",
    });

    const due = await dueReminders(pool, now);
    expect(due.map((r) => r.id)).toEqual([earlier.id, past.id]);
    expect(due.map((r) => r.id)).not.toContain(future.id);
  });

  it("markDelivered removes a reminder from the due set", async () => {
    const pool = getPool();
    const r = await createReminder(pool, {
      agent: "saga",
      dueAt: new Date("2026-09-01T09:00:00Z"),
      payload: { text: "x", door: "slack", threadRef: "s-1" },
      createdBy: "user",
    });
    await markDelivered(pool, r.id);

    const due = await dueReminders(pool, new Date("2026-09-02T00:00:00Z"));
    expect(due.map((d) => d.id)).not.toContain(r.id);

    const { rows } = await pool.query("SELECT status, delivered_at FROM reminders WHERE id = $1", [r.id]);
    expect(rows[0].status).toBe("delivered");
    expect(rows[0].delivered_at).not.toBeNull();
  });

  it("listPending returns only the given owner's pending reminders, soonest first", async () => {
    const pool = getPool();
    await createReminder(pool, {
      agent: "saga",
      owner: "someone-else",
      dueAt: new Date("2026-09-01T09:00:00Z"),
      payload: { text: "not bendik's", door: "slack", threadRef: "s-1" },
      createdBy: "user",
    });
    const mine1 = await createReminder(pool, {
      agent: "saga",
      dueAt: new Date("2026-09-02T09:00:00Z"),
      payload: { text: "mine, later", door: "slack", threadRef: "s-1" },
      createdBy: "user",
    });
    const mine2 = await createReminder(pool, {
      agent: "saga",
      dueAt: new Date("2026-09-01T09:00:00Z"),
      payload: { text: "mine, sooner", door: "slack", threadRef: "s-1" },
      createdBy: "user",
    });

    const pending = await listPending(pool);
    expect(pending.map((p) => p.id)).toEqual([mine2.id, mine1.id]);
  });

  it("cancelReminder marks cancelled only for the matching owner, and cancelled rows drop out of listPending/dueReminders", async () => {
    const pool = getPool();
    const r = await createReminder(pool, {
      agent: "saga",
      dueAt: new Date("2026-09-01T09:00:00Z"),
      payload: { text: "cancel me", door: "slack", threadRef: "s-1" },
      createdBy: "user",
    });

    // Wrong owner: no-op.
    await cancelReminder(pool, r.id, "someone-else");
    expect((await listPending(pool)).map((p) => p.id)).toContain(r.id);

    // Right owner: cancels.
    await cancelReminder(pool, r.id);
    expect((await listPending(pool)).map((p) => p.id)).not.toContain(r.id);
    const due = await dueReminders(pool, new Date("2026-09-02T00:00:00Z"));
    expect(due.map((d) => d.id)).not.toContain(r.id);
  });
});

// ─── 2. lib/recurrence.ts — nextOccurrence ─────────────────────────────────────────────────

describe("nextOccurrence", () => {
  it("daily: advances exactly one Oslo calendar day", () => {
    // 2026-06-17 08:00 Oslo (CEST, UTC+2) fired → next is 2026-06-18 08:00 Oslo.
    const fired = new Date("2026-06-17T06:00:00Z");
    const next = nextOccurrence("daily:08:00", fired);
    expect(next.toISOString()).toBe("2026-06-18T06:00:00.000Z");
  });

  it("weekdays: Friday's firing rolls over the weekend to Monday", () => {
    // 2026-06-19 is a Friday.
    const fired = new Date("2026-06-19T07:00:00Z"); // 09:00 Oslo CEST
    const next = nextOccurrence("weekdays:09:00", fired);
    // Next weekday after Friday is Monday 2026-06-22.
    expect(next.toISOString()).toBe("2026-06-22T07:00:00.000Z");
  });

  it("weekly: advances exactly 7 days to the same weekday/time", () => {
    // Monday 2026-06-22 11:30 Oslo CEST (09:30 UTC).
    const fired = new Date("2026-06-22T09:30:00Z");
    const next = nextOccurrence("weekly:mon:11:30", fired);
    expect(next.toISOString()).toBe("2026-06-29T09:30:00.000Z");
  });

  it("throws on an unsupported recurrence format", () => {
    expect(() => nextOccurrence("monthly:1:08:00", new Date())).toThrow(/Unsupported recurrence format/);
  });

  it("throws on an unknown day-of-week abbreviation", () => {
    expect(() => nextOccurrence("weekly:xyz:08:00", new Date())).toThrow(/Unknown day-of-week/);
  });
});

// ─── 3. agent/schedules/reminders.ts — makeReminderTick ────────────────────────────────────

function fakeDoor() {
  const sent: Array<{ threadRef: string; text: string }> = [];
  let throwOnSend = false;
  const door: ReminderDoor = {
    async send({ threadRef, text }) {
      if (throwOnSend) throw new Error("door send failed");
      sent.push({ threadRef, text });
    },
  };
  return { door, sent, setThrows: (v: boolean) => (throwOnSend = v) };
}

function fakeStore(initial: DueReminder[] = []) {
  const rows = [...initial];
  const calls: string[] = []; // records call ORDER: "create:<id-ish>" / "markDelivered:<id>"
  const created: Array<Parameters<ReminderTickStore["create"]>[0]> = [];
  const delivered: string[] = [];

  const store: ReminderTickStore = {
    async due(now) {
      return rows.filter((r) => r.due_at <= now);
    },
    async markDelivered(id) {
      calls.push(`markDelivered:${id}`);
      delivered.push(id);
    },
    async create(r) {
      calls.push(`create:${r.payload.text}`);
      created.push(r);
    },
  };
  return { store, calls, created, delivered };
}

function reminder(overrides: Partial<DueReminder> = {}): DueReminder {
  return {
    id: "r-1",
    agent: "saga",
    owner: "bendik",
    due_at: new Date("2026-06-17T11:00:00Z"),
    recurrence: null,
    payload: { text: "Call X", door: "telegram", threadRef: "tg-123" },
    ...overrides,
  };
}

const NOW = new Date("2026-06-17T12:00:00Z");

describe("makeReminderTick", () => {
  it("delivers a due reminder to its pinned Slack door with the right threadRef+text, and marks it delivered", async () => {
    const slack = fakeDoor();
    const telegram = fakeDoor();
    const { store, delivered } = fakeStore([
      reminder({ payload: { text: "Slack one", door: "slack", threadRef: "C0SLACK" } }),
    ]);

    const tick = makeReminderTick({ store, doors: { slack: slack.door, telegram: telegram.door }, clock: () => NOW });
    await tick.tick();

    expect(slack.sent).toEqual([{ threadRef: "C0SLACK", text: "Slack one" }]);
    expect(telegram.sent).toEqual([]);
    expect(delivered).toContain("r-1");
  });

  it("delivers a due reminder to its pinned Telegram door", async () => {
    const slack = fakeDoor();
    const telegram = fakeDoor();
    const { store } = fakeStore([reminder({ payload: { text: "Telegram one", door: "telegram", threadRef: "tg-123" } })]);

    const tick = makeReminderTick({ store, doors: { slack: slack.door, telegram: telegram.door }, clock: () => NOW });
    await tick.tick();

    expect(telegram.sent).toEqual([{ threadRef: "tg-123", text: "Telegram one" }]);
    expect(slack.sent).toEqual([]);
  });

  it("skips a reminder that is not yet due", async () => {
    const telegram = fakeDoor();
    const { store, delivered } = fakeStore([
      reminder({ due_at: new Date("2026-06-17T13:00:00Z") }), // 1h in the future
    ]);

    const tick = makeReminderTick({ store, doors: { telegram: telegram.door }, clock: () => NOW });
    await tick.tick();

    expect(telegram.sent).toEqual([]);
    expect(delivered).toEqual([]);
  });

  it("re-routes an email-pinned reminder to the fallback door — the GENERIC unregistered-door path, not an email special case", async () => {
    const telegram = fakeDoor();
    const { store } = fakeStore([
      reminder({ payload: { text: "email reminder", door: "email", threadRef: "owner@owner.example" } }),
    ]);

    // "email" is never registered in `doors` at all — no slack entry either, only telegram +
    // the fallback wiring. This proves the re-route comes from the loop's generic
    // "pinned door not registered" branch, not any door==="email" special case.
    const tick = makeReminderTick({
      store,
      doors: { telegram: telegram.door },
      fallbackDoor: "telegram",
      resolveTarget: (door) => (door === "telegram" ? "tg-bendik" : undefined),
      clock: () => NOW,
    });
    await tick.tick();

    expect(telegram.sent).toEqual([{ threadRef: "tg-bendik", text: "email reminder" }]);
  });

  it("re-routes a nonsense door name to the fallback too — proving the mechanism is generic, not email-specific", async () => {
    const telegram = fakeDoor();
    const { store } = fakeStore([
      reminder({ payload: { text: "smoke signal reminder", door: "smoke-signal", threadRef: "n/a" } }),
    ]);

    const tick = makeReminderTick({
      store,
      doors: { telegram: telegram.door },
      fallbackDoor: "telegram",
      resolveTarget: (door) => (door === "telegram" ? "tg-bendik" : undefined),
      clock: () => NOW,
    });
    await tick.tick();

    expect(telegram.sent).toEqual([{ threadRef: "tg-bendik", text: "smoke signal reminder" }]);
  });

  it("re-routes to the fallback when the pinned door IS registered but its send throws", async () => {
    const slack = fakeDoor();
    slack.setThrows(true);
    const telegram = fakeDoor();
    const { store } = fakeStore([
      reminder({ payload: { text: "slack is down", door: "slack", threadRef: "C0SLACK" } }),
    ]);

    const tick = makeReminderTick({
      store,
      doors: { slack: slack.door, telegram: telegram.door },
      fallbackDoor: "telegram",
      resolveTarget: (door) => (door === "telegram" ? "tg-bendik" : undefined),
      clock: () => NOW,
    });
    await tick.tick();

    expect(telegram.sent).toEqual([{ threadRef: "tg-bendik", text: "slack is down" }]);
  });

  it("re-arms a recurring reminder by creating the next occurrence BEFORE marking delivered (call order)", async () => {
    const telegram = fakeDoor();
    const firedAt = new Date("2026-06-22T09:30:00Z"); // Monday 11:30 Oslo CEST
    const { store, calls, created } = fakeStore([
      reminder({
        id: "r-recur",
        due_at: firedAt,
        recurrence: "weekly:mon:11:30",
        payload: { text: "Weekly check", door: "telegram", threadRef: "tg-123" },
      }),
    ]);

    const tick = makeReminderTick({ store, doors: { telegram: telegram.door }, clock: () => new Date("2026-06-22T10:00:00Z") });
    await tick.tick();

    // Order matters: create (re-arm) must precede markDelivered.
    expect(calls).toEqual(["create:Weekly check", "markDelivered:r-recur"]);
    expect(created).toHaveLength(1);
    expect(created[0].recurrence).toBe("weekly:mon:11:30");
    expect(created[0].dueAt.toISOString()).toBe("2026-06-29T09:30:00.000Z");
    expect(created[0].createdBy).toBe("schedule:re-arm");
  });

  it("does NOT re-arm a one-off (no recurrence) reminder", async () => {
    const telegram = fakeDoor();
    const { store, calls } = fakeStore([reminder()]);

    const tick = makeReminderTick({ store, doors: { telegram: telegram.door }, clock: () => NOW });
    await tick.tick();

    expect(calls).toEqual(["markDelivered:r-1"]);
  });

  it("one delivery failure does not abort the tick — other due reminders still deliver, the failed one stays pending", async () => {
    const telegram = fakeDoor();
    const { store, delivered } = fakeStore([
      // No fallback configured and no door registered for "carrier-pigeon" → send() throws,
      // deliverOne() throws, tick() catches it and moves on.
      reminder({ id: "r-fail", payload: { text: "will fail", door: "carrier-pigeon", threadRef: "x" } }),
      reminder({ id: "r-ok", payload: { text: "will succeed", door: "telegram", threadRef: "tg-123" } }),
    ]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const tick = makeReminderTick({ store, doors: { telegram: telegram.door }, clock: () => NOW });
    await tick.tick();

    expect(telegram.sent).toEqual([{ threadRef: "tg-123", text: "will succeed" }]);
    expect(delivered).toEqual(["r-ok"]);
    expect(delivered).not.toContain("r-fail");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

// ─── The schedule's own gate ─────────────────────────────────────────────────────────────

describe("agent/schedules/reminders.ts default export", () => {
  const ENV_KEYS = ["EVE_SCHEDULES_LIVE", "DATABASE_URL", "TELEGRAM_PRINCIPAL_ID"];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("carries the documented ~1 minute cron cadence", async () => {
    const mod = await import("../agent/schedules/reminders.js");
    expect(mod.default.cron).toBe("* * * * *");
  });

  it("is a complete no-op when the gate is off — no DATABASE_URL, no secrets, nothing configured, and it still resolves cleanly", async () => {
    // Gate off (EVE_SCHEDULES_LIVE deleted above). If `run` touched the store or a door at
    // all, this would throw: getPool() throws without DATABASE_URL, and the door builders
    // read secret files that don't exist here. A clean resolve is the proof of zero calls.
    const mod = await import("../agent/schedules/reminders.js");
    await expect(
      mod.default.run!({ to: (() => {}) as never, waitUntil: () => {}, appAuth: {} as never }),
    ).resolves.toBeUndefined();
  });
});
